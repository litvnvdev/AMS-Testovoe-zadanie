export type TaskState =
  | 'QUEUED' | 'PLANNING' | 'RUNNING' | 'WAITING_CONFIRMATION' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface TaskView {
  task_id: string;
  workspace_id: string;
  role: string;
  goal: string;
  mode: string;
  state: TaskState;
  trace_id: string;
  limits: { max_steps: number; max_tool_calls: number; max_runtime_seconds: number };
  limits_used: { steps: number; tool_calls: number; runtime_seconds: number };
  result: unknown;
  error: { code: string; message: string } | null;
  pending_action: { confirmation_id: string; step: number; tool: string; args: unknown } | null;
  duplicate?: boolean;
}

export interface EventView {
  seq: number;
  event_type: string;
  timestamp: string;
  actor: string;
  input_hash: string;
  decision: string;
  trace_id: string;
  details: unknown;
}

export const TERMINAL: TaskState[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: { code: string; message: string } };
  if (!res.ok) throw new ApiError(data.error?.code ?? 'ERROR', data.error?.message ?? res.statusText, res.status);
  return { status: res.status, data };
}

export const api = {
  createTask: (payload: unknown) => request<TaskView>('POST', '/tasks', payload),
  getTask: (id: string) => request<TaskView>('GET', `/tasks/${id}`).then((r) => r.data),
  getEvents: (id: string) => request<{ events: EventView[] }>('GET', `/tasks/${id}/events`).then((r) => r.data.events),
  confirm: (id: string, confirmation_id: string, approve = true) =>
    request<TaskView>('POST', `/tasks/${id}/confirm`, { confirmation_id, approve }),
  cancel: (id: string) => request<TaskView>('POST', `/tasks/${id}/cancel`, {}),
};
