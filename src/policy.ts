import type { Mode, Role } from './types.js';

export type ToolKind = 'read' | 'write';

export interface PolicyDecision {
  decision: 'allow' | 'deny' | 'require_confirmation';
  code: string;
  reason: string;
}

export interface PolicyConfig {
  automatedAllowlist: string[];
  automatedMaxWrites: number;
}

export interface PolicyInput {
  tool: string;
  kind: ToolKind;
  mode: Mode;
  role: Role;
  writesDone: number;
  /** true только если одноразовое подтверждение уже потреблено сервисом. */
  approved: boolean;
}

/**
 * Единственное место, где принимается решение "можно ли выполнять".
 * Чистая функция от входа: без побочных эффектов и без доступа к данным инструментов,
 * поэтому текст из tool output повлиять на неё не может.
 */
export class PolicyEngine {
  constructor(private readonly cfg: PolicyConfig) {}

  decide(i: PolicyInput): PolicyDecision {
    if (i.kind === 'read') return { decision: 'allow', code: 'READ_ALLOWED', reason: 'Read tools are allowed' };

    // Дальше только запись.
    if (i.role === 'viewer') return deny('ROLE_FORBIDDEN', 'Role viewer cannot perform write actions');
    if (i.mode === 'read_only') return deny('READ_ONLY_MODE', 'Write actions are blocked in read_only mode');

    if (i.mode === 'confirm') {
      return i.approved
        ? { decision: 'allow', code: 'CONFIRMED', reason: 'One-time confirmation was consumed' }
        : { decision: 'require_confirmation', code: 'CONFIRMATION_REQUIRED', reason: 'Write action needs explicit confirmation' };
    }

    // policy_automated: только allowlist и лимит записей.
    if (!this.cfg.automatedAllowlist.includes(i.tool)) return deny('NOT_ALLOWLISTED', 'Tool is not in the automation allowlist');
    if (i.writesDone >= this.cfg.automatedMaxWrites) return deny('WRITE_LIMIT', 'Automated write limit reached');
    return { decision: 'allow', code: 'POLICY_ALLOWLIST', reason: 'Allowed by allowlist policy within limits' };
  }
}

const deny = (code: string, reason: string): PolicyDecision => ({ decision: 'deny', code, reason });
