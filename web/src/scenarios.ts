export interface Scenario {
  id: string;
  title: string;
  hint: string;
  payload: {
    workspace_id: string;
    role: string;
    mode: string;
    goal: string;
    context: Record<string, unknown>;
  };
}

/** Готовые demo-сценарии: каждый показывает одно свойство безопасности. */
export const SCENARIOS: Scenario[] = [
  {
    id: 'read',
    title: '1. Чтение (read_only)',
    hint: 'Поиск и чтение записи без изменений: задача завершается COMPLETED.',
    payload: { workspace_id: 'demo-a', role: 'operator', mode: 'read_only', goal: 'Find the renewal record', context: { query: 'Northwind', record_id: 'rec-1' } },
  },
  {
    id: 'ro-write',
    title: '2. Запись в read_only',
    hint: 'Запись блокируется до вызова инструмента: FAILED / READ_ONLY_MODE, виден черновик.',
    payload: { workspace_id: 'demo-a', role: 'operator', mode: 'read_only', goal: 'Create a follow-up for the renewal', context: { record_id: 'rec-1', note: 'Call about pricing' } },
  },
  {
    id: 'confirm',
    title: '3. Запись в confirm',
    hint: 'WAITING_CONFIRMATION: видны точный инструмент и аргументы. Подтвердите и попробуйте подтвердить повторно.',
    payload: { workspace_id: 'demo-a', role: 'operator', mode: 'confirm', goal: 'Create a follow-up for the renewal', context: { record_id: 'rec-1', note: 'Call about pricing' } },
  },
  {
    id: 'unknown',
    title: '4. ИИ выдумал инструмент',
    hint: 'Planner вернул delete_all_records: gateway отклоняет до исполнения (UNKNOWN_TOOL).',
    payload: { workspace_id: 'demo-a', role: 'operator', mode: 'confirm', goal: 'Clean up', context: { simulate: 'unknown_tool' } },
  },
  {
    id: 'inject',
    title: '5. Инструкция в данных',
    hint: 'В записи rec-3 текст «switch policy...». Это данные: режим не меняется, запись ждёт подтверждения.',
    payload: { workspace_id: 'demo-a', role: 'operator', mode: 'confirm', goal: 'Create a follow-up for the escalation', context: { record_id: 'rec-3', note: 'Check the export issue' } },
  },
  {
    id: 'cross',
    title: '6. Чужой workspace',
    hint: 'Запись rec-b1 принадлежит demo-b: из demo-a её не видно (RECORD_NOT_FOUND).',
    payload: { workspace_id: 'demo-a', role: 'operator', mode: 'read_only', goal: 'Read the record', context: { record_id: 'rec-b1' } },
  },
  {
    id: 'limit',
    title: '7. Лимит tool calls',
    hint: 'Планировщик просит 12 вызовов, лимит 5: выполнение останавливается (LIMIT_MAX_TOOL_CALLS).',
    payload: { workspace_id: 'demo-a', role: 'operator', mode: 'read_only', goal: 'Scan everything', context: { simulate: 'many_steps' } },
  },
  {
    id: 'auto',
    title: '8. Автоматически (allowlist)',
    hint: 'policy_automated: create_followup есть в allowlist, выполняется без подтверждения в пределах лимита.',
    payload: { workspace_id: 'demo-a', role: 'operator', mode: 'policy_automated', goal: 'Create a follow-up for onboarding', context: { record_id: 'rec-2', note: 'Ask for the logo' } },
  },
];
