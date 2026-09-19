import { createHash, randomUUID } from 'node:crypto';

export const uuid = (): string => randomUUID();

/** Детерминированная сериализация: одинаковые данные -> одинаковый хэш независимо от порядка ключей. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return (
      '{' +
      Object.keys(o)
        .sort()
        .filter((k) => o[k] !== undefined)
        .map((k) => JSON.stringify(k) + ':' + canonical(o[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(v) ?? 'null';
}

/** В аудит пишем хэш ввода, а не сам ввод. */
export const sha256 = (v: unknown): string =>
  createHash('sha256')
    .update(typeof v === 'string' ? v : canonical(v))
    .digest('hex');

const SECRET_KEY = /(token|secret|password|passwd|authorization|api[_-]?key|cookie|credential)/i;
const SECRET_VALUE =
  /(Bearer\s+[A-Za-z0-9._~+/-]+=*|sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g;

export const redactText = (s: string): string => s.replace(SECRET_VALUE, '[REDACTED]');

/** Рекурсивно вычищает секреты: по имени ключа и по виду значения (Bearer, sk-..., JWT). */
export function redact(v: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]';
  if (typeof v === 'string') return redactText(v);
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[REDACTED]' : redact(val, depth + 1);
    }
    return out;
  }
  return v;
}
