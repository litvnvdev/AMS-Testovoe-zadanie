import { useCallback, useEffect, useState } from 'react';
import { api, TERMINAL, type EventView, type TaskView } from './api';

/**
 * Опрашивает задачу и журнал событий. Выполнение задачи от страницы не зависит:
 * состояние живёт в БД на сервере, страница только показывает его.
 * Пока задача в WAITING_CONFIRMATION, опрос замедляется (ждём человека).
 */
export function useTaskPolling(taskId: string | null) {
  const [task, setTask] = useState<TaskView | null>(null);
  const [events, setEvents] = useState<EventView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!taskId) {
      setTask(null);
      setEvents([]);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      try {
        const [t, ev] = await Promise.all([api.getTask(taskId), api.getEvents(taskId)]);
        if (cancelled) return;
        setTask(t);
        setEvents(ev);
        setError(null);
        if (!TERMINAL.includes(t.state)) timer = setTimeout(load, t.state === 'WAITING_CONFIRMATION' ? 2000 : 500);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Ошибка загрузки');
        timer = setTimeout(load, 3000);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [taskId, tick]);

  return { task, events, error, refresh };
}
