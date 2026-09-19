import { readFileSync } from 'node:fs';
import { z } from 'zod';

const ConfigSchema = z.object({
  port: z.number().int(),
  dbPath: z.string(),
  webDir: z.string(),
  planner: z.enum(['mock', 'llm']),
  limits: z.object({
    defaults: z.object({
      max_steps: z.number().int(),
      max_tool_calls: z.number().int(),
      max_runtime_seconds: z.number().int(),
    }),
    caps: z.object({
      max_steps: z.number().int(),
      max_tool_calls: z.number().int(),
      max_runtime_seconds: z.number().int(),
    }),
  }),
  policy: z.object({
    automatedAllowlist: z.array(z.string()),
    automatedMaxWrites: z.number().int(),
  }),
  llm: z
    .object({ baseUrl: z.string(), apiKey: z.string(), model: z.string() })
    .optional(),
});
export type AppConfig = z.infer<typeof ConfigSchema>;

/** Конфигурация: файл config/default.json + переопределение через env. Секреты - только из env. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const path = env.CONFIG_PATH ?? 'config/default.json';
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  if (env.PORT) raw.port = Number(env.PORT);
  if (env.DB_PATH) raw.dbPath = env.DB_PATH;
  if (env.WEB_DIR) raw.webDir = env.WEB_DIR;
  if (env.PLANNER) raw.planner = env.PLANNER;
  if (env.LLM_BASE_URL && env.LLM_API_KEY && env.LLM_MODEL) {
    raw.llm = { baseUrl: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY, model: env.LLM_MODEL };
  }
  return ConfigSchema.parse(raw);
}
