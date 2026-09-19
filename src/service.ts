import type { Limits, Plan, TaskInput, TaskState, ConfirmInput } from './types.js';
import { DomainError, PlanSchema, TERMINAL_STATES } from './types.js';
import type { PendingRow, Storage, TaskRow } from './storage.js';
import type { ToolGateway } from './gateway.js';
import type { Planner } from './planner.js';
import { redact, redactText, sha256, uuid } from './util.js';

/** Разрешённые переходы. Всё остальное отклоняется (INVALID_TRANSITION). */
const TRANSITIONS: Record<TaskState, TaskState[]> = {
  QUEUED: ['PLANNING', 'FAILED', 'CANCELLED'],
  PLANNING: ['RUNNING', 'FAILED', 'CANCELLED'],
  RUNNING: ['COMPLETED', 'WAITING_CONFIRMATION', 'FAILED', 'CANCELLED'],
  WAITING_CONFIRMATION: ['RUNNING', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export interface LimitsConfig {
  defaults: Limits;
  caps: Limits;
}

interface StepResult {
  step: number;
  tool: string;
  kind: string;
  status: 'executed';
  output: unknown;
}

const isActive = (s: TaskState): boolean => !TERMINAL_STATES.includes(s);

export class TaskService {
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    private readonly storage: Storage,
    private readonly planner: Planner,
    private readonly gateway: ToolGateway,
    private readonly limits: LimitsConfig,
  ) {}

  // ---------- публичный API ----------

  createTask(input: TaskInput): { task: TaskRow; created: boolean } {
    const taskId = input.task_id ?? uuid();
    const requestHash = sha256({
      workspace_id: input.workspace_id,
      user_id: input.user_id,
      role: input.role,
      goal: input.goal,
      context: input.context,
      mode: input.mode,
      limits: input.limits ?? null,
    });

    const result = this.storage.tx(() => {
      const existing = this.storage.getTask(taskId);
      if (existing) {
        // Повтор того же task_id: ничего не создаём. Другое содержимое под тем же id - конфликт.
        if (existing.request_hash !== requestHash) {
          throw new DomainError('TASK_ID_CONFLICT', 409, 'task_id already exists with a different payload');
        }
        return { task: existing, created: false };
      }
      const now = new Date().toISOString();
      const row: Omit<TaskRow, 'updated_at'> = {
        task_id: taskId,
        workspace_id: input.workspace_id,
        user_id: input.user_id,
        role: input.role,
        goal: input.goal,
        context: JSON.stringify(redact(input.context)),
        mode: input.mode,
        limits: JSON.stringify(this.effectiveLimits(input.limits)),
        request_hash: requestHash,
        state: 'QUEUED',
        trace_id: uuid(),
        plan: null,
        next_step: 0,
        tool_calls_used: 0,
        writes_done: 0,
        runtime_ms_used: 0,
        run_started_at: null,
        results: '[]',
        result: null,
        error_code: null,
        error_message: null,
        created_at: now,
      };
      this.storage.insertTask(row);
      const task = this.storage.getTask(taskId)!;
      this.event(task, 'task_created', input.user_id, 'accepted', sha256({ goal: input.goal, context: input.context }), {
        mode: input.mode,
        role: input.role,
      });
      return { task, created: true };
    });

    if (result.created) this.schedule(() => this.run(taskId));
    return result;
  }

  getTask(taskId: string): TaskRow {
    const t = this.storage.getTask(taskId);
    if (!t) throw new DomainError('NOT_FOUND', 404, 'Task not found');
    return t;
  }

  getEvents(taskId: string) {
    this.getTask(taskId);
    return this.storage.listEvents(taskId).map((e) => ({
      seq: e.seq,
      event_type: e.event_type,
      timestamp: e.ts,
      actor: e.actor,
      input_hash: e.input_hash,
      decision: e.decision,
      trace_id: e.trace_id,
      details: JSON.parse(e.details) as unknown,
    }));
  }

  view(task: TaskRow) {
    const pending = this.storage.getOpenPending(task.task_id);
    return {
      task_id: task.task_id,
      workspace_id: task.workspace_id,
      user_id: task.user_id,
      role: task.role,
      goal: task.goal,
      context: JSON.parse(task.context) as unknown,
      mode: task.mode,
      state: task.state,
      trace_id: task.trace_id,
      limits: JSON.parse(task.limits) as Limits,
      limits_used: {
        steps: task.next_step,
        tool_calls: task.tool_calls_used,
        runtime_seconds: Math.round(this.elapsedMs(task) / 10) / 100,
      },
      result: task.result ? (JSON.parse(task.result) as unknown) : null,
      error: task.error_code ? { code: task.error_code, message: task.error_message } : null,
      pending_action: pending
        ? {
            confirmation_id: pending.confirmation_id,
            step: pending.step_index,
            tool: pending.tool,
            args: JSON.parse(pending.args) as unknown, // пользователь видит точный инструмент и аргументы
          }
        : null,
      created_at: task.created_at,
      updated_at: task.updated_at,
    };
  }

  confirm(taskId: string, input: ConfirmInput) {
    const task = this.getTask(taskId);
    const pending = this.storage.getPending(input.confirmation_id);
    if (!pending || pending.task_id !== taskId) {
      throw new DomainError('UNKNOWN_CONFIRMATION', 404, 'Unknown confirmation_id for this task');
    }
    const actor = input.user_id ?? task.user_id;

    // Атомарное потребление: только один из повторных запросов пройдёт этот UPDATE.
    const won = this.storage.resolvePending(pending.confirmation_id, taskId, input.approve ? 'consumed' : 'rejected', actor);
    if (!won) {
      this.event(task, 'confirmation_rejected', actor, 'deny', pending.args_hash, { code: 'CONFIRMATION_ALREADY_USED' });
      throw new DomainError('CONFIRMATION_ALREADY_USED', 409, 'This confirmation was already used or cancelled');
    }

    if (!input.approve) {
      this.storage.tx(() => {
        this.event(task, 'confirmation_declined', actor, 'deny', pending.args_hash, { step: pending.step_index });
        this.transition(taskId, 'CANCELLED', actor, { error_code: 'DECLINED', error_message: 'Action declined by user' });
      });
      return this.view(this.getTask(taskId));
    }

    this.storage.tx(() => {
      this.event(task, 'confirmation_accepted', actor, 'allow', pending.args_hash, { step: pending.step_index, tool: pending.tool });
      this.transition(taskId, 'RUNNING', actor);
    });
    this.schedule(() => this.loop(taskId));
    return this.view(this.getTask(taskId));
  }

  cancel(taskId: string, actor?: string) {
    const task = this.getTask(taskId);
    if (task.state === 'CANCELLED') return this.view(task); // идемпотентно
    if (!isActive(task.state)) throw new DomainError('ALREADY_FINISHED', 409, `Task is already ${task.state}`);
    const by = actor ?? task.user_id;
    this.storage.tx(() => {
      const open = this.storage.getOpenPending(taskId);
      if (open) this.storage.resolvePending(open.confirmation_id, taskId, 'rejected', by);
      this.transition(taskId, 'CANCELLED', by, { error_code: 'CANCELLED', error_message: 'Cancelled by user' });
    });
    return this.view(this.getTask(taskId));
  }

  /** После рестарта: QUEUED запускаем, прерванные PLANNING/RUNNING честно помечаем FAILED, WAITING остаётся ждать. */
  recover(): void {
    for (const t of this.storage.listTasksInStates(['QUEUED'])) this.schedule(() => this.run(t.task_id));
    for (const t of this.storage.listTasksInStates(['PLANNING', 'RUNNING'])) {
      this.fail(t.task_id, 'INTERRUPTED', 'Service was restarted while the task was running');
    }
  }

  /** Для тестов и graceful shutdown: дождаться фоновых задач. */
  async drain(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  // ---------- выполнение ----------

  private schedule(fn: () => Promise<void>): void {
    const p: Promise<void> = Promise.resolve()
      .then(fn)
      .catch((e: unknown) => console.error('[task-runner]', redactText(e instanceof Error ? e.message : String(e))))
      .finally(() => this.inflight.delete(p));
    this.inflight.add(p);
  }

  private async run(taskId: string): Promise<void> {
    try {
      const task = this.storage.getTask(taskId);
      if (!task || task.state !== 'QUEUED') return;
      this.transition(taskId, 'PLANNING', 'system');

      let raw: unknown;
      try {
        raw = await this.planner.plan({
          goal: task.goal,
          context: JSON.parse(task.context) as Record<string, unknown>,
          mode: task.mode,
          tools: this.gateway.describe(),
        });
      } catch (e) {
        this.fail(taskId, 'PLANNER_ERROR', 'Planner failed: ' + redactText(e instanceof Error ? e.message : 'unknown'));
        return;
      }
      if (this.getTask(taskId).state !== 'PLANNING') return; // например, отменили во время планирования

      const parsed = PlanSchema.safeParse(raw);
      const fresh = this.getTask(taskId);
      if (!parsed.success) {
        this.event(fresh, 'plan_rejected', 'planner', 'deny', sha256(raw), {
          code: 'PLAN_INVALID',
          issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`),
        });
        this.fail(taskId, 'PLAN_INVALID', 'Planner output did not match the plan schema');
        return;
      }
      this.storage.tx(() => {
        this.storage.updateTask(taskId, { plan: JSON.stringify(parsed.data) });
        this.event(fresh, 'plan_accepted', 'planner', 'accepted', sha256(parsed.data), {
          steps: parsed.data.steps.length,
          tools: parsed.data.steps.map((s) => s.tool.slice(0, 64)),
        });
        this.transition(taskId, 'RUNNING', 'system');
      });
      await this.loop(taskId);
    } catch (e) {
      this.internalFailure(taskId, e);
    }
  }

  private async loop(taskId: string): Promise<void> {
    try {
      for (;;) {
        const task = this.storage.getTask(taskId);
        if (!task || task.state !== 'RUNNING') return;
        const plan = JSON.parse(task.plan ?? '{"steps":[]}') as Plan;
        const limits = JSON.parse(task.limits) as Limits;
        const i = task.next_step;

        if (this.elapsedMs(task) > limits.max_runtime_seconds * 1000) {
          return this.limitStop(task, 'LIMIT_MAX_RUNTIME', 'max_runtime_seconds exceeded');
        }
        if (i >= plan.steps.length) return this.complete(task);
        if (i >= limits.max_steps) return this.limitStop(task, 'LIMIT_MAX_STEPS', 'max_steps reached');
        if (task.tool_calls_used >= limits.max_tool_calls) {
          return this.limitStop(task, 'LIMIT_MAX_TOOL_CALLS', 'max_tool_calls reached');
        }

        const step = plan.steps[i]!;
        const stepHash = sha256({ tool: step.tool, args: step.args });
        const pending = this.storage.getPendingForStep(taskId, i);
        const approved = pending?.status === 'consumed';

        const outcome = await this.gateway.call(
          { tool: step.tool, args: step.args },
          { workspaceId: task.workspace_id, taskId, stepIndex: i, mode: task.mode, role: task.role, writesDone: task.writes_done },
          { approved },
        );

        const after = this.storage.getTask(taskId);
        if (!after || after.state !== 'RUNNING') return; // отменили, пока шёл вызов

        switch (outcome.outcome) {
          case 'executed': {
            const results = JSON.parse(after.results) as StepResult[];
            results.push({ step: i, tool: outcome.tool, kind: outcome.kind, status: 'executed', output: outcome.output });
            this.storage.tx(() => {
              this.storage.updateTask(taskId, {
                results: JSON.stringify(results),
                next_step: i + 1,
                tool_calls_used: after.tool_calls_used + 1,
                writes_done: after.writes_done + (outcome.kind === 'write' ? 1 : 0),
              });
              this.event(after, 'tool_executed', 'gateway', 'allow', stepHash, {
                step: i,
                tool: outcome.tool,
                kind: outcome.kind,
                confirmed: approved,
                suspicious_output: looksLikeInjection(outcome.output),
              });
            });
            continue;
          }
          case 'needs_confirmation': {
            const argsJson = JSON.stringify(outcome.args);
            this.storage.tx(() => {
              if (!pending) {
                this.storage.insertPending({
                  confirmation_id: uuid(),
                  task_id: taskId,
                  step_index: i,
                  tool: outcome.tool,
                  args: argsJson,
                  args_hash: sha256(outcome.args),
                  status: 'pending',
                  created_at: new Date().toISOString(),
                });
              }
              this.event(after, 'confirmation_requested', 'policy', 'require_confirmation', stepHash, { step: i, tool: outcome.tool });
              this.transition(taskId, 'WAITING_CONFIRMATION', 'policy');
            });
            return;
          }
          case 'denied': {
            this.event(after, 'tool_denied', 'gateway', 'deny', stepHash, { step: i, tool: outcome.tool, code: outcome.code });
            this.fail(taskId, outcome.code, outcome.reason, {
              status: 'stopped',
              completed_steps: JSON.parse(after.results) as unknown,
              blocked: { step: i, tool: outcome.tool, code: outcome.code, draft: outcome.draft ?? null },
            });
            return;
          }
          case 'failed': {
            this.event(after, 'tool_failed', 'gateway', 'error', stepHash, { step: i, tool: outcome.tool, code: outcome.code });
            this.fail(taskId, outcome.code, outcome.reason);
            return;
          }
        }
      }
    } catch (e) {
      this.internalFailure(taskId, e);
    }
  }

  private complete(task: TaskRow): void {
    const results = JSON.parse(task.results) as StepResult[];
    const created = results
      .filter((r) => r.tool === 'create_followup')
      .map((r) => (r.output as { followup_id?: string }).followup_id)
      .filter(Boolean);
    const summary =
      `Executed ${results.length} step(s)` + (created.length ? `; created follow-up: ${created.join(', ')}` : '; no changes were made');
    this.storage.tx(() => {
      this.storage.updateTask(task.task_id, { result: JSON.stringify({ status: 'completed', summary, steps: results }) });
      this.transition(task.task_id, 'COMPLETED', 'system');
    });
  }

  private limitStop(task: TaskRow, code: string, message: string): void {
    this.event(task, 'limit_reached', 'system', 'deny', sha256(code), { code, next_step: task.next_step });
    this.fail(task.task_id, code, message, {
      status: 'stopped',
      completed_steps: JSON.parse(task.results) as unknown,
    });
  }

  // ---------- состояния и аудит ----------

  private fail(taskId: string, code: string, message: string, result?: unknown): void {
    const t = this.storage.getTask(taskId);
    if (!t || !isActive(t.state)) return;
    const partial = result ?? { status: 'failed', completed_steps: JSON.parse(t.results) as unknown };
    this.storage.tx(() =>
      this.transition(taskId, 'FAILED', 'system', {
        error_code: code,
        error_message: redactText(message),
        result: JSON.stringify(redact(partial)),
      }),
    );
  }

  private internalFailure(taskId: string, e: unknown): void {
    console.error('[task-runner] internal error', redactText(e instanceof Error ? e.message : String(e)));
    try {
      this.fail(taskId, 'INTERNAL_ERROR', 'Internal error'); // детали наружу не отдаём
    } catch {
      /* уже логировали */
    }
  }

  private transition(taskId: string, to: TaskState, actor: string, patch: Partial<TaskRow> = {}): void {
    this.storage.tx(() => {
      const task = this.storage.getTask(taskId);
      if (!task) throw new DomainError('NOT_FOUND', 404, 'Task not found');
      if (!TRANSITIONS[task.state].includes(to)) {
        throw new DomainError('INVALID_TRANSITION', 409, `Transition ${task.state} -> ${to} is not allowed`);
      }
      const now = Date.now();
      const update: Partial<TaskRow> = { ...patch };
      // учёт времени выполнения: ожидание подтверждения человеком в лимит не входит
      if ((task.state === 'PLANNING' || task.state === 'RUNNING') && task.run_started_at != null) {
        update.runtime_ms_used = task.runtime_ms_used + (now - task.run_started_at);
        update.run_started_at = null;
      }
      if (to === 'PLANNING' || to === 'RUNNING') update.run_started_at = now;
      if (!this.storage.casState(taskId, task.state, to)) {
        throw new DomainError('INVALID_TRANSITION', 409, 'Concurrent state change');
      }
      this.storage.updateTask(taskId, update);
      this.event(task, 'state_changed', actor, 'allow', sha256({ from: task.state, to }), {
        from: task.state,
        to,
        ...(patch.error_code ? { code: patch.error_code } : {}),
      });
    });
  }

  private event(task: TaskRow, type: string, actor: string, decision: string, inputHash: string, details: Record<string, unknown>): void {
    this.storage.addEvent({
      task_id: task.task_id,
      event_type: type,
      ts: new Date().toISOString(),
      actor,
      input_hash: inputHash,
      decision,
      trace_id: task.trace_id,
      details: JSON.stringify(redact(details)),
    });
  }

  private elapsedMs(task: TaskRow): number {
    return task.runtime_ms_used + (task.run_started_at != null ? Date.now() - task.run_started_at : 0);
  }

  private effectiveLimits(req: Partial<Limits> | undefined): Limits {
    const { defaults, caps } = this.limits;
    return {
      max_steps: Math.min(req?.max_steps ?? defaults.max_steps, caps.max_steps),
      max_tool_calls: Math.min(req?.max_tool_calls ?? defaults.max_tool_calls, caps.max_tool_calls),
      max_runtime_seconds: Math.min(req?.max_runtime_seconds ?? defaults.max_runtime_seconds, caps.max_runtime_seconds),
    };
  }
}

/** Эвристика только для метки в аудите: текст из tool output НИКОГДА не влияет на policy. */
function looksLikeInjection(output: unknown): boolean {
  return /ignore (all )?(previous|prior) (rules|instructions)|switch policy|system:/i.test(JSON.stringify(output) ?? '');
}

export type { PendingRow };
