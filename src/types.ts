import { z } from 'zod';

export const ROLES = ['viewer', 'operator', 'admin'] as const;
export const MODES = ['read_only', 'confirm', 'policy_automated'] as const;
export const TASK_STATES = [
  'QUEUED',
  'PLANNING',
  'RUNNING',
  'WAITING_CONFIRMATION',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;

export type Role = (typeof ROLES)[number];
export type Mode = (typeof MODES)[number];
export type TaskState = (typeof TASK_STATES)[number];

export const TERMINAL_STATES: readonly TaskState[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

const ident = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_.-]+$/, 'only letters, digits, _ . -');

export const LimitsSchema = z
  .object({
    max_steps: z.number().int().min(1),
    max_tool_calls: z.number().int().min(0),
    max_runtime_seconds: z.number().int().min(1),
  })
  .partial()
  .strict();

export interface Limits {
  max_steps: number;
  max_tool_calls: number;
  max_runtime_seconds: number;
}

/** Входной объект задачи из задания. Лишние поля запрещены (.strict). */
export const TaskInputSchema = z
  .object({
    task_id: z.string().uuid().optional(),
    workspace_id: ident,
    user_id: ident,
    role: z.enum(ROLES),
    goal: z.string().min(1).max(2000),
    context: z.record(z.string(), z.unknown()).default({}),
    mode: z.enum(MODES),
    limits: LimitsSchema.optional(),
  })
  .strict();
export type TaskInput = z.infer<typeof TaskInputSchema>;

/**
 * Схема плана от planner/LLM. Выход планировщика НЕДОВЕРЕННЫЙ.
 * tool здесь намеренно просто строка: неизвестный инструмент должен дойти до gateway
 * и быть отклонён там (с записью в аудит), а не молча потеряться на этапе парсинга.
 */
export const PlanSchema = z
  .object({
    steps: z
      .array(
        z
          .object({
            tool: z.string().min(1).max(64),
            args: z.record(z.string(), z.unknown()),
            reason: z.string().max(300).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
export type Plan = z.infer<typeof PlanSchema>;

export const ConfirmInputSchema = z
  .object({
    confirmation_id: z.string().uuid(),
    user_id: ident.optional(),
    approve: z.boolean().default(true),
  })
  .strict();
export type ConfirmInput = z.infer<typeof ConfirmInputSchema>;

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
