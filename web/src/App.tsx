import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, TERMINAL, type EventView, type TaskView } from './api';
import { SCENARIOS, type Scenario } from './scenarios';
import { useTaskPolling } from './usePolling';

const newId = (): string | undefined => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : undefined);

interface Notice {
  kind: 'ok' | 'warn' | 'error';
  text: string;
}

export function App() {
  const [scenarioId, setScenarioId] = useState(SCENARIOS[0]!.id);
  const scenario = SCENARIOS.find((s) => s.id === scenarioId)!;

  const [form, setForm] = useState(() => toForm(SCENARIOS[0]!));
  const [taskId, setTaskId] = useState<string | null>(null);
  const [lastPayload, setLastPayload] = useState<Record<string, unknown> | null>(null);
  const [lastConfirmId, setLastConfirmId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const { task, events, error, refresh } = useTaskPolling(taskId);

  // запоминаем последний confirmation_id, чтобы можно было показать защиту от повторного подтверждения
  useEffect(() => {
    if (task?.pending_action) setLastConfirmId(task.pending_action.confirmation_id);
  }, [task?.pending_action]);

  const pick = (s: Scenario) => {
    setScenarioId(s.id);
    setForm(toForm(s));
    setNotice(null);
  };

  const guard = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      const text = e instanceof ApiError ? `${e.status} ${e.code}: ${e.message}` : 'Не удалось связаться с сервером';
      setNotice({ kind: e instanceof ApiError && e.status === 409 ? 'warn' : 'error', text });
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void guard(async () => {
      let context: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(form.context || '{}');
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
        context = parsed as Record<string, unknown>;
      } catch {
        setNotice({ kind: 'error', text: 'Контекст должен быть JSON-объектом' });
        return;
      }
      const payload = {
        task_id: newId(),
        workspace_id: form.workspace_id,
        user_id: 'user-7',
        role: form.role,
        goal: form.goal,
        context,
        mode: form.mode,
      };
      const { data } = await api.createTask(payload);
      setLastPayload({ ...payload, task_id: data.task_id });
      setLastConfirmId(null);
      setTaskId(data.task_id);
      setNotice({ kind: 'ok', text: `Задача создана: ${data.task_id}` });
    });
  };

  const resend = () =>
    guard(async () => {
      if (!lastPayload) return;
      const { status, data } = await api.createTask(lastPayload);
      setNotice({
        kind: 'warn',
        text: `Повторная отправка того же task_id: HTTP ${status}, duplicate=${String(data.duplicate)}. Вторая задача и новые события не создаются.`,
      });
      refresh();
    });

  const confirm = (approve: boolean) =>
    guard(async () => {
      if (!task?.pending_action) return;
      await api.confirm(task.task_id, task.pending_action.confirmation_id, approve);
      setNotice({ kind: 'ok', text: approve ? 'Подтверждено: действие выполняется один раз.' : 'Отклонено: задача отменена.' });
      refresh();
    });

  const confirmAgain = () =>
    guard(async () => {
      if (!task || !lastConfirmId) return;
      await api.confirm(task.task_id, lastConfirmId);
      refresh();
    }).finally(refresh);

  const cancel = () =>
    guard(async () => {
      if (!task) return;
      await api.cancel(task.task_id);
      refresh();
    });

  return (
    <main className="layout">
      <header className="header">
        <h1>Управляемые действия</h1>
        <p>Агент строит план, но все вызовы идут через policy и gateway. Каждый шаг пишется в аудит.</p>
      </header>

      <section className="card" aria-labelledby="scen">
        <h2 id="scen">Сценарии</h2>
        <div className="scenarios" role="list">
          {SCENARIOS.map((s) => (
            <button key={s.id} type="button" role="listitem" className={s.id === scenarioId ? 'chip active' : 'chip'} onClick={() => pick(s)}>
              {s.title}
            </button>
          ))}
        </div>
        <p className="hint">{scenario.hint}</p>

        <form onSubmit={submit} className="form">
          <label>
            Workspace
            <select value={form.workspace_id} onChange={(e) => setForm({ ...form, workspace_id: e.target.value })}>
              <option>demo-a</option>
              <option>demo-b</option>
            </select>
          </label>
          <label>
            Роль
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option>viewer</option>
              <option>operator</option>
              <option>admin</option>
            </select>
          </label>
          <label>
            Режим
            <select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
              <option>read_only</option>
              <option>confirm</option>
              <option>policy_automated</option>
            </select>
          </label>
          <label className="wide">
            Цель
            <input value={form.goal} onChange={(e) => setForm({ ...form, goal: e.target.value })} required maxLength={2000} />
          </label>
          <label className="wide">
            Контекст (JSON)
            <textarea rows={4} value={form.context} onChange={(e) => setForm({ ...form, context: e.target.value })} spellCheck={false} />
          </label>
          <div className="wide row">
            <button type="submit" className="primary">Создать задачу</button>
            <button type="button" onClick={resend} disabled={!lastPayload}>Отправить повторно (тот же task_id)</button>
          </div>
        </form>
      </section>

      {notice && (
        <p className={`notice ${notice.kind}`} role="status">
          {notice.text}
        </p>
      )}
      {error && <p className="notice error" role="alert">{error}</p>}

      {task && (
        <section className="card" aria-labelledby="task">
          <h2 id="task">Задача</h2>
          <TaskSummary task={task} />

          {task.pending_action && (
            <div className="pending" role="alert">
              <strong>Требуется подтверждение</strong>
              <p>Инструмент: <code>{task.pending_action.tool}</code></p>
              <pre>{JSON.stringify(task.pending_action.args, null, 2)}</pre>
              <div className="row">
                <button className="primary" onClick={() => void confirm(true)}>Подтвердить</button>
                <button onClick={() => void confirm(false)}>Отклонить</button>
              </div>
            </div>
          )}

          <div className="row">
            {lastConfirmId && !task.pending_action && (
              <button onClick={() => void confirmAgain()}>Подтвердить повторно (то же подтверждение)</button>
            )}
            {!TERMINAL.includes(task.state) && <button onClick={() => void cancel()}>Отменить задачу</button>}
          </div>

          {task.error && (
            <p className="notice error">
              {task.error.code}: {task.error.message}
            </p>
          )}
          {task.result != null && (
            <details open>
              <summary>Результат</summary>
              <pre>{JSON.stringify(task.result, null, 2)}</pre>
            </details>
          )}
        </section>
      )}

      {task && (
        <section className="card" aria-labelledby="audit">
          <h2 id="audit">Журнал аудита</h2>
          <p className="hint">trace_id: <code>{task.trace_id}</code></p>
          <EventTable events={events} />
        </section>
      )}
    </main>
  );
}

function toForm(s: Scenario) {
  return {
    workspace_id: s.payload.workspace_id,
    role: s.payload.role,
    mode: s.payload.mode,
    goal: s.payload.goal,
    context: JSON.stringify(s.payload.context, null, 2),
  };
}

function TaskSummary({ task }: { task: TaskView }) {
  const { limits, limits_used: used } = task;
  return (
    <dl className="summary">
      <dt>Состояние</dt>
      <dd><span className={`badge ${task.state}`}>{task.state}</span></dd>
      <dt>Режим / роль</dt>
      <dd>{task.mode} / {task.role}</dd>
      <dt>Шаги</dt>
      <dd>{used.steps} из {limits.max_steps}</dd>
      <dt>Tool calls</dt>
      <dd>{used.tool_calls} из {limits.max_tool_calls}</dd>
      <dt>Время</dt>
      <dd>{used.runtime_seconds} с из {limits.max_runtime_seconds}</dd>
    </dl>
  );
}

function EventTable({ events }: { events: EventView[] }) {
  return (
    <div className="tablewrap">
      <table>
        <thead>
          <tr><th>#</th><th>Событие</th><th>Актор</th><th>Решение</th><th>input_hash</th><th>Детали</th></tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.seq}>
              <td>{e.seq}</td>
              <td title={e.timestamp}>{e.event_type}</td>
              <td>{e.actor}</td>
              <td><span className={`dec ${e.decision}`}>{e.decision}</span></td>
              <td><code>{e.input_hash.slice(0, 10)}…</code></td>
              <td><code>{JSON.stringify(e.details)}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
