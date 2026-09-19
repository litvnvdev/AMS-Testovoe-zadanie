import { z } from 'zod';
import { ToolError, type RecordsSystem } from './mock-system.js';
import type { PolicyEngine, ToolKind } from './policy.js';
import type { Mode, Role } from './types.js';

export interface ToolContext {
  workspaceId: string;
  taskId: string;
  stepIndex: number;
}

export interface ToolDef {
  name: string;
  kind: ToolKind;
  description: string;
  /** Строгая схема аргументов: лишние поля (например, чужой workspace_id) отклоняются. */
  args: z.ZodTypeAny;
  run(ctx: ToolContext, args: any): Promise<unknown>;
}

export interface ToolDescription {
  name: string;
  kind: ToolKind;
  description: string;
}

export interface CallContext extends ToolContext {
  mode: Mode;
  role: Role;
  writesDone: number;
}

export type GatewayOutcome =
  | { outcome: 'executed'; kind: ToolKind; output: unknown; tool: string }
  | { outcome: 'needs_confirmation'; kind: 'write'; tool: string; args: Record<string, unknown> }
  | { outcome: 'denied'; code: string; reason: string; tool: string; draft?: { tool: string; args: Record<string, unknown> } }
  | { outcome: 'failed'; code: string; reason: string; tool: string };

const recordId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);

export function buildTools(system: RecordsSystem): ToolDef[] {
  return [
    {
      name: 'list_records',
      kind: 'read',
      description: 'List records of the current workspace, optionally filtered by title.',
      args: z.object({ query: z.string().max(100).default('') }).strict(),
      run: (ctx, a: { query: string }) => system.listRecords(ctx.workspaceId, a),
    },
    {
      name: 'get_record',
      kind: 'read',
      description: 'Get one record (allowed fields only) of the current workspace.',
      args: z.object({ record_id: recordId }).strict(),
      run: async (ctx, a: { record_id: string }) => {
        const rec = await system.getRecord(ctx.workspaceId, a.record_id);
        if (!rec) throw new ToolError('RECORD_NOT_FOUND', 'Record not found in this workspace');
        return rec;
      },
    },
    {
      name: 'create_followup',
      kind: 'write',
      description: 'Create a follow-up for a record. Write action: needs confirmation or allowlist policy.',
      args: z
        .object({
          record_id: recordId,
          note: z.string().min(1).max(500),
          due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        })
        .strict(),
      // idempotency key = задача + шаг: повторный вызов не создаст вторую запись
      run: (ctx, a) => system.createFollowup(ctx.workspaceId, a, `${ctx.taskId}:${ctx.stepIndex}`),
    },
  ];
}

/**
 * Единственная точка вызова инструментов. Порядок проверок фиксирован:
 * известен ли инструмент -> валидны ли аргументы -> policy -> исполнение.
 * Ничего из этого не делает planner/LLM: он лишь предлагает данные.
 */
export class ToolGateway {
  private readonly tools = new Map<string, ToolDef>();

  constructor(
    tools: ToolDef[],
    private readonly policy: PolicyEngine,
  ) {
    for (const t of tools) this.tools.set(t.name, t);
  }

  describe(): ToolDescription[] {
    return [...this.tools.values()].map(({ name, kind, description }) => ({ name, kind, description }));
  }

  async call(
    req: { tool: string; args: unknown },
    ctx: CallContext,
    opts: { approved: boolean },
  ): Promise<GatewayOutcome> {
    const tool = req.tool.slice(0, 64);
    const def = this.tools.get(req.tool);
    if (!def) return { outcome: 'denied', code: 'UNKNOWN_TOOL', reason: 'Unknown tool rejected before execution', tool };

    const parsed = def.args.safeParse(req.args);
    if (!parsed.success) {
      // в причину попадают только пути и типы ошибок, не значения аргументов
      const reason = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`).join('; ');
      return { outcome: 'denied', code: 'INVALID_ARGS', reason: `Invalid arguments: ${reason}`, tool };
    }
    const args = parsed.data as Record<string, unknown>;

    const verdict = this.policy.decide({
      tool: def.name,
      kind: def.kind,
      mode: ctx.mode,
      role: ctx.role,
      writesDone: ctx.writesDone,
      approved: opts.approved,
    });
    if (verdict.decision === 'deny') {
      // для заблокированной записи возвращаем "черновик": что именно было бы выполнено
      const draft = def.kind === 'write' ? { draft: { tool: def.name, args } } : {};
      return { outcome: 'denied', code: verdict.code, reason: verdict.reason, tool, ...draft };
    }
    if (verdict.decision === 'require_confirmation') {
      return { outcome: 'needs_confirmation', kind: 'write', tool: def.name, args };
    }

    try {
      const output = await def.run({ workspaceId: ctx.workspaceId, taskId: ctx.taskId, stepIndex: ctx.stepIndex }, args);
      return { outcome: 'executed', kind: def.kind, output, tool: def.name };
    } catch (e) {
      if (e instanceof ToolError) return { outcome: 'failed', code: e.code, reason: e.message, tool: def.name };
      return { outcome: 'failed', code: 'TOOL_ERROR', reason: 'Tool execution failed', tool: def.name };
    }
  }
}
