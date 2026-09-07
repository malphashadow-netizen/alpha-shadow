/**
 * The single canonical snapshot/redaction boundary for the commercial audit
 * log. Every before/after value written to `audit_log` must pass through this
 * function; callers never hand-redact fields.
 *
 * Redaction is name-based and intentionally future-proof:
 *   - any key ending in `_hash`, `_pepper`, or `_secret` (case-insensitive)
 *   - exact keys `password`, `pin`, or `secret` (case-insensitive)
 *
 * Sensitive keys are omitted rather than copied with a placeholder, so a JSONB
 * audit row cannot accidentally contain the original value under a visible key.
 */
import { ValidationError } from './errors.ts';

export type AuditJsonValue = null | boolean | string | number | AuditJsonValue[] | { readonly [key: string]: AuditJsonValue };

const SENSITIVE_SUFFIXES = ['_hash', '_pepper', '_secret'] as const;
const SENSITIVE_EXACT_NAMES = new Set(['password', 'pin', 'secret']);

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return SENSITIVE_EXACT_NAMES.has(normalized) || SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function snapshotValue(value: unknown, ancestors: WeakSet<object>, path: string): AuditJsonValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ValidationError(`Audit snapshot contains a non-finite number at ${path}`, 'audit');
    }
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new ValidationError(`Audit snapshot contains an invalid Date at ${path}`, 'audit');
    }
    return value.toISOString();
  }
  if (typeof value !== 'object') {
    throw new ValidationError(`Audit snapshot contains an unsupported value at ${path}`, 'audit');
  }

  if (ancestors.has(value)) {
    throw new ValidationError(`Audit snapshot contains a cyclic value at ${path}`, 'audit');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => snapshotValue(item, ancestors, `${path}[${String(index)}]`));
    }

    const result: Record<string, AuditJsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      if (isSensitiveKey(key)) continue;
      if (child === undefined) continue;
      result[key] = snapshotValue(child, ancestors, `${path}.${key}`);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

/** Returns a JSONB-safe, recursively redacted, detached audit snapshot. */
export function snapshotForAudit(value: unknown): AuditJsonValue {
  return snapshotValue(value, new WeakSet<object>(), '$');
}

/** Exposed only for focused unit tests; production callers use snapshotForAudit. */
export const __testing = { isSensitiveKey };
