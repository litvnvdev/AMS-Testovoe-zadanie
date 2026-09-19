import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createRuntime } from '../src/runtime.js';

/** Каждый тест поднимает чистый in-memory runtime: SQLite в памяти, детерминированный MockPlanner. */
function setup() {
  const config = { ...loadConfig({ CONFIG_PATH: 'config/default.json' } as NodeJS.ProcessEnv), dbPath: ':memory:', webDir: 'none' };
  const rt = createRuntime(config);
  const post = async (payload: Record<string, unknown>) => rt.app.inject({ method: 'POST', url: '/tasks', payload });
  const get = async (id: string) => (await rt.app.inject({ method: 'GET', url: `/tasks/${id}` })).json();
  const events = async (id: string) => (await rt.app.inject({ method: 'GET', url: `/tasks/${id}/events` })).json().events as any[];
  const confirm = async (id: string, confirmation_id: string) =>
    rt.app.inject({ method: 'POST', url: `/tasks/${id}/confirm`, payload: { confirmation_id } });
  const followups = () => (rt.db.prepare('SELECT COUNT(*) AS n FROM followups').get() as { n: number }).n;
  const base = { workspace_id: 'demo-a', user_id: 'user-7', role: 'operator', goal: 'Create a follow-up for the renewal' };
  return { rt, post, get, events, confirm, followups, base };
}

describe('managed actions', () => {
  it('основной сценарий: задача проходит ожидаемые состояния и формирует результат', async () => {
    const { rt, post, get, events, confirm, followups, base } = setup();

    const created = await post({ ...base, mode: 'confirm', context: { query: 'Northwind', record_id: 'rec-1', note: 'Call about pricing' } });
    expect(created.statusCode).toBe(201);
    const id = created.json().task_id as string;

    await rt.service.drain();
    const waiting = await get(id);
    expect(waiting.state).toBe('WAITING_CONFIRMATION');
    // пользователь видит точный инструмент и аргументы; запись ещё не произошла
    expect(waiting.pending_action).toMatchObject({ tool: 'create_followup', args: { record_id: 'rec-1', note: 'Call about pricing' } });
    expect(followups()).toBe(0);

    const ok = await confirm(id, waiting.pending_action.confirmation_id);
    expect(ok.statusCode).toBe(200);
    await rt.service.drain();

    const done = await get(id);
    expect(done.state).toBe('COMPLETED');
    expect(done.result.summary).toContain('created follow-up');
    expect(done.limits_used).toMatchObject({ steps: 3, tool_calls: 3 });
    expect(followups()).toBe(1);

    const evs = await events(id);
    const path = evs.filter((e) => e.event_type === 'state_changed').map((e) => e.details.to);
    expect(path).toEqual(['PLANNING', 'RUNNING', 'WAITING_CONFIRMATION', 'RUNNING', 'COMPLETED']);
    // журнал упорядочен и содержит обязательные поля аудита
    expect(evs.map((e) => e.seq)).toEqual(evs.map((_, i) => i + 1));
    for (const e of evs) {
      for (const f of ['event_type', 'timestamp', 'actor', 'input_hash', 'decision', 'trace_id']) expect(e[f]).toBeTruthy();
      expect(e.trace_id).toBe(done.trace_id);
    }
  });

  it('безопасный отказ: нет разрешения, неизвестный инструмент, чужой workspace, инъекция в tool output', async () => {
    const { rt, post, get, followups, base } = setup();
    const run = async (payload: Record<string, unknown>) => {
      const id = (await post({ ...base, ...payload })).json().task_id as string;
      await rt.service.drain();
      return get(id);
    };
    const ctx = { record_id: 'rec-1', note: 'x' };

    // запись в read_only блокируется до вызова инструмента
    const ro = await run({ mode: 'read_only', context: ctx });
    expect(ro.state).toBe('FAILED');
    expect(ro.error.code).toBe('READ_ONLY_MODE');
    expect(ro.result.blocked.draft).toMatchObject({ tool: 'create_followup' });
    expect(followups()).toBe(0);

    // роль viewer не может писать даже в confirm
    expect((await run({ mode: 'confirm', role: 'viewer', context: ctx })).error.code).toBe('ROLE_FORBIDDEN');

    // недоверенный план: неизвестный инструмент, лишние аргументы, мусор вместо плана
    expect((await run({ mode: 'confirm', context: { simulate: 'unknown_tool' } })).error.code).toBe('UNKNOWN_TOOL');
    expect((await run({ mode: 'confirm', context: { simulate: 'extra_args' } })).error.code).toBe('INVALID_ARGS');
    expect((await run({ mode: 'confirm', context: { simulate: 'malformed' } })).error.code).toBe('PLAN_INVALID');

    // запись из demo-a в запись demo-b: workspace берётся из задачи, а не из аргументов
    const cross = await run({ mode: 'read_only', goal: 'read', context: { record_id: 'rec-b1' } });
    expect(cross.state).toBe('FAILED');
    expect(cross.error.code).toBe('RECORD_NOT_FOUND');
    expect(JSON.stringify(cross)).not.toContain('Private note');

    // лимит tool calls реально останавливает выполнение
    const many = await run({ mode: 'read_only', context: { simulate: 'many_steps' } });
    expect(many.error.code).toBe('LIMIT_MAX_TOOL_CALLS');
    expect(many.limits_used.tool_calls).toBe(5);

    // текст "switch policy" внутри данных не меняет правила: запись всё равно ждёт подтверждения
    const inj = await run({ mode: 'confirm', context: { record_id: 'rec-3', note: 'x' } });
    expect(inj.state).toBe('WAITING_CONFIRMATION');
    expect(inj.mode).toBe('confirm');
    expect(followups()).toBe(0);
  });

  it('защита от дубля: повтор task_id и повторное подтверждение не создают второе действие', async () => {
    const { rt, post, get, events, confirm, followups, base } = setup();
    const payload = { ...base, mode: 'confirm', context: { record_id: 'rec-2', note: 'Ping customer' } };

    const first = await post(payload);
    const id = first.json().task_id as string;
    await rt.service.drain();
    const eventsBefore = (await events(id)).length;

    // тот же task_id и то же содержимое: вторая задача и события не создаются
    const again = await post({ ...payload, task_id: id });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ task_id: id, duplicate: true });
    await rt.service.drain();
    expect((await events(id)).length).toBe(eventsBefore);
    expect((rt.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n).toBe(1);

    // тот же task_id, но другое содержимое: конфликт, задача не перезаписывается
    const conflict = await post({ ...payload, task_id: id, goal: 'Something else' });
    expect(conflict.statusCode).toBe(409);

    // подтверждение: первое проходит, второе безопасно отклоняется
    const cid = (await get(id)).pending_action.confirmation_id as string;
    expect((await confirm(id, cid)).statusCode).toBe(200);
    const second = await confirm(id, cid);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('CONFIRMATION_ALREADY_USED');
    await rt.service.drain();

    expect(followups()).toBe(1);
    expect((await get(id)).state).toBe('COMPLETED');
  });
});
