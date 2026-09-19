import type { AppConfig } from './config.js';
import { ToolGateway, buildTools } from './gateway.js';
import { SqliteRecordsSystem } from './mock-system.js';
import { LlmPlanner, MockPlanner, type Planner } from './planner.js';
import { PolicyEngine } from './policy.js';
import { buildApp } from './server.js';
import { TaskService } from './service.js';
import { Storage, openDb } from './storage.js';

/**
 * Единственное место, где склеиваются компоненты (composition root).
 * Замена mock на реальные зависимости делается здесь, доменная логика не меняется:
 *   RecordsSystem -> реальная CRM,   Planner -> LlmPlanner,   Storage -> другая БД.
 */
export function createRuntime(config: AppConfig, overrides: { planner?: Planner } = {}) {
  const db = openDb(config.dbPath);
  const storage = new Storage(db);
  const system = new SqliteRecordsSystem(db);
  const policy = new PolicyEngine(config.policy);
  const gateway = new ToolGateway(buildTools(system), policy);

  let planner: Planner = new MockPlanner();
  if (config.planner === 'llm') {
    if (!config.llm) throw new Error('PLANNER=llm requires LLM_BASE_URL, LLM_API_KEY and LLM_MODEL');
    planner = new LlmPlanner(config.llm);
  }
  const service = new TaskService(storage, overrides.planner ?? planner, gateway, config.limits);
  const app = buildApp(service, { webDir: config.webDir });
  return { db, storage, service, app };
}
