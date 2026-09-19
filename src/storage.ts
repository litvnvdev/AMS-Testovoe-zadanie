import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Mode, Role, TaskState } from './types.js';

export type Db = Database.Database;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db); // схема создаётся автоматически при запуске (миграции не нужны для прототипа)
  return db;
}

function initSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      goal TEXT NOT NULL,
      context TEXT NOT NULL,
      mode TEXT NOT NULL,
      limits TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      state TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      plan TEXT,
      next_step INTEGER NOT NULL DEFAULT 0,
      tool_calls_used INTEGER NOT NULL DEFAULT 0,
      writes_done INTEGER NOT NULL DEFAULT 0,
      runtime_ms_used INTEGER NOT NULL DEFAULT 0,
      run_started_at INTEGER,
      results TEXT NOT NULL DEFAULT '[]',
      result TEXT,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      seq INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      ts TEXT NOT NULL,
      actor TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      decision TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      details TEXT NOT NULL,
      UNIQUE (task_id, seq)
    );
    CREATE TABLE IF NOT EXISTS pending_actions (
      confirmation_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      step_index INTEGER NOT NULL,
      tool TEXT NOT NULL,
      args TEXT NOT NULL,
      args_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT,
      UNIQUE (task_id, step_index)
    );
  `);
}

export interface TaskRow {
  task_id: string;
  workspace_id: string;
  user_id: string;
  role: Role;
  goal: string;
  context: string;
  mode: Mode;
  limits: string;
  request_hash: string;
  state: TaskState;
  trace_id: string;
  plan: string | null;
  next_step: number;
  tool_calls_used: number;
  writes_done: number;
  runtime_ms_used: number;
  run_started_at: number | null;
  results: string;
  result: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface EventRow {
  id: number;
  task_id: string;
  seq: number;
  event_type: string;
  ts: string;
  actor: string;
  input_hash: string;
  decision: string;
  trace_id: string;
  details: string;
}

export interface PendingRow {
  confirmation_id: string;
  task_id: string;
  step_index: number;
  tool: string;
  args: string;
  args_hash: string;
  status: 'pending' | 'consumed' | 'rejected';
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

const UPDATABLE = new Set([
  'state', 'plan', 'next_step', 'tool_calls_used', 'writes_done', 'runtime_ms_used',
  'run_started_at', 'results', 'result', 'error_code', 'error_message',
]);

export class Storage {
  constructor(readonly db: Db) {}

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  insertTask(t: Omit<TaskRow, 'updated_at'>): void {
    const now = t.created_at;
    this.db
      .prepare(
        `INSERT INTO tasks (task_id, workspace_id, user_id, role, goal, context, mode, limits, request_hash,
           state, trace_id, plan, next_step, tool_calls_used, writes_done, runtime_ms_used, run_started_at,
           results, result, error_code, error_message, created_at, updated_at)
         VALUES (@task_id, @workspace_id, @user_id, @role, @goal, @context, @mode, @limits, @request_hash,
           @state, @trace_id, @plan, @next_step, @tool_calls_used, @writes_done, @runtime_ms_used, @run_started_at,
           @results, @result, @error_code, @error_message, @created_at, @updated_at)`,
      )
      .run({ ...t, updated_at: now });
  }

  getTask(id: string): TaskRow | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(id) as TaskRow | undefined;
  }

  listTasksInStates(states: TaskState[]): TaskRow[] {
    const marks = states.map(() => '?').join(',');
    return this.db.prepare(`SELECT * FROM tasks WHERE state IN (${marks})`).all(...states) as TaskRow[];
  }

  updateTask(id: string, patch: Partial<TaskRow>): void {
    const keys = Object.keys(patch).filter((k) => UPDATABLE.has(k)); // имена колонок - только из белого списка
    if (keys.length === 0) return;
    const params: Record<string, unknown> = { task_id: id, updated_at: new Date().toISOString() };
    for (const k of keys) params[k] = (patch as Record<string, unknown>)[k] ?? null;
    const set = keys.map((k) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE tasks SET ${set}, updated_at = @updated_at WHERE task_id = @task_id`).run(params);
  }

  /** Атомарная смена состояния: сработает, только если состояние всё ещё `from`. */
  casState(id: string, from: TaskState, to: TaskState): boolean {
    const r = this.db
      .prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE task_id = ? AND state = ?')
      .run(to, new Date().toISOString(), id, from);
    return r.changes === 1;
  }

  addEvent(e: Omit<EventRow, 'id' | 'seq'>): number {
    return this.tx(() => {
      const row = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM events WHERE task_id = ?')
        .get(e.task_id) as { n: number };
      this.db
        .prepare(
          `INSERT INTO events (task_id, seq, event_type, ts, actor, input_hash, decision, trace_id, details)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(e.task_id, row.n, e.event_type, e.ts, e.actor, e.input_hash, e.decision, e.trace_id, e.details);
      return row.n;
    });
  }

  listEvents(taskId: string): EventRow[] {
    return this.db.prepare('SELECT * FROM events WHERE task_id = ? ORDER BY seq ASC').all(taskId) as EventRow[];
  }

  insertPending(p: Omit<PendingRow, 'resolved_at' | 'resolved_by'>): void {
    this.db
      .prepare(
        `INSERT INTO pending_actions (confirmation_id, task_id, step_index, tool, args, args_hash, status, created_at)
         VALUES (@confirmation_id, @task_id, @step_index, @tool, @args, @args_hash, @status, @created_at)`,
      )
      .run(p);
  }

  getPending(confirmationId: string): PendingRow | undefined {
    return this.db.prepare('SELECT * FROM pending_actions WHERE confirmation_id = ?').get(confirmationId) as
      | PendingRow
      | undefined;
  }

  getPendingForStep(taskId: string, step: number): PendingRow | undefined {
    return this.db
      .prepare('SELECT * FROM pending_actions WHERE task_id = ? AND step_index = ?')
      .get(taskId, step) as PendingRow | undefined;
  }

  getOpenPending(taskId: string): PendingRow | undefined {
    return this.db
      .prepare(`SELECT * FROM pending_actions WHERE task_id = ? AND status = 'pending'`)
      .get(taskId) as PendingRow | undefined;
  }

  /**
   * Одноразовость подтверждения. UPDATE ... WHERE status='pending' атомарен:
   * из двух одновременных запросов changes === 1 получит ровно один.
   */
  resolvePending(confirmationId: string, taskId: string, status: 'consumed' | 'rejected', by: string): boolean {
    const r = this.db
      .prepare(
        `UPDATE pending_actions SET status = ?, resolved_at = ?, resolved_by = ?
         WHERE confirmation_id = ? AND task_id = ? AND status = 'pending'`,
      )
      .run(status, new Date().toISOString(), by, confirmationId, taskId);
    return r.changes === 1;
  }
}
