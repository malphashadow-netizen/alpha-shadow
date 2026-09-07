/**
 * Authentication request schema — a STRICT discriminated union.
 *
 * The email+password mode carries an EXPLICIT tenant identifier (tenantId or
 * tenantSlug — here tenantId UUID; a slug resolver is the composition root's
 * concern) because the Phase-1 RLS design makes the unique email index
 * `(tenant_id, lower(email))`, NOT global. There is no RLS-safe way to find a
 * user by email without first knowing the tenant, and a cross-tenant scan is
 * forbidden (same logic as the PIN path's no-scan rule). The PIN mode carries
 * an explicit tenant id AND an explicit user identifier (user id or staff
 * code) — no discovery.
 *
 * The parser rejects, at SCHEMA level (before any application logic or DB
 * query — acceptance criterion #2):
 *   - an unknown `mode`;
 *   - fields of BOTH modes present together;
 *   - missing/empty/typed-wrong required fields;
 *   - any unexpected extra fields (strict object shape).
 *
 * Failure is a ValidationError → mapped to a uniform 400 by toErrorResponse.
 * This module is deliberately dependency-free (hand-rolled "Zod-equivalent"
 * discriminated union) to honour the no-new-runtime-dependency posture.
 */
import { ValidationError } from '../../../shared/errors.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface PasswordLoginRequest {
  readonly mode: 'password';
  readonly tenantId: string;
  readonly email: string;
  readonly password: string;
}

export interface PinLoginRequest {
  readonly mode: 'pin';
  readonly tenantId: string;
  readonly userIdOrStaffCode: string;
  readonly pin: string;
}

export interface RefreshRequest {
  readonly refreshToken: string;
}

/** The union the HTTP layer must accept. Anything else is a 400. */
export type LoginRequest = PasswordLoginRequest | PinLoginRequest;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

const PASSWORD_MODE_KEYS = ['mode', 'tenantId', 'email', 'password'] as const;
const PIN_MODE_KEYS = ['mode', 'tenantId', 'userIdOrStaffCode', 'pin'] as const;
const REFRESH_KEYS = ['refreshToken'] as const;

function reject(message: string, field?: string): never {
  throw new ValidationError(message, field);
}

function assertExactKeys(obj: Record<string, unknown>, allowed: readonly string[], mode: string): void {
  const provided = Object.keys(obj).sort();
  const expected = [...allowed].sort();
  if (provided.length !== expected.length || provided.some((key, index) => key !== expected[index])) {
    reject(`malformed ${mode} request: exactly [${expected.join(', ')}] are accepted`, 'request');
  }
}

function assertTenantId(value: unknown): string {
  if (!nonEmptyString(value) || !UUID_RE.test(value.trim())) {
    reject('tenantId must be a UUID', 'tenantId');
  }
  return value.trim();
}

/**
 * Parses/validates an untrusted login body into the discriminated union.
 * Throws ValidationError (→400) on ANY shape problem. Performs NO I/O.
 */
export function parseLoginRequest(body: unknown): LoginRequest {
  if (!isPlainObject(body)) {
    reject('request body must be a JSON object', 'request');
  }
  const mode = body['mode'];
  if (mode !== 'password' && mode !== 'pin') {
    reject('mode must be exactly one of "password" or "pin"', 'mode');
  }

  if (mode === 'password') {
    assertExactKeys(body, PASSWORD_MODE_KEYS, 'password');
    const tenantId = assertTenantId(body['tenantId']);
    const email = body['email'];
    if (!nonEmptyString(email) || !email.includes('@')) {
      reject('email must be a non-empty email address', 'email');
    }
    const password = body['password'];
    if (!nonEmptyString(password)) {
      reject('password is required', 'password');
    }
    return { mode: 'password', tenantId, email: email.trim(), password };
  }

  // mode === 'pin'
  assertExactKeys(body, PIN_MODE_KEYS, 'pin');
  const tenantId = assertTenantId(body['tenantId']);
  const userIdOrStaffCode = body['userIdOrStaffCode'];
  if (!nonEmptyString(userIdOrStaffCode)) {
    reject('userIdOrStaffCode is required (explicit identifier; no cross-tenant scan)', 'userIdOrStaffCode');
  }
  const pin = body['pin'];
  if (!nonEmptyString(pin)) {
    reject('pin is required', 'pin');
  }
  return { mode: 'pin', tenantId, userIdOrStaffCode: userIdOrStaffCode.trim(), pin };
}

/**
 * Parses/validates the refresh body. Strict single-field shape. Throws
 * ValidationError (→400) on any malformation, BEFORE any DB/JWT work.
 */
export function parseRefreshRequest(body: unknown): RefreshRequest {
  if (!isPlainObject(body)) {
    reject('request body must be a JSON object', 'request');
  }
  assertExactKeys(body, REFRESH_KEYS, 'refresh');
  const refreshToken = body['refreshToken'];
  if (!nonEmptyString(refreshToken)) {
    reject('refreshToken is required', 'refreshToken');
  }
  // A JWT has exactly three dot-separated, non-empty segments.
  const segments = refreshToken.split('.');
  if (segments.length !== 3 || segments.some((segment) => segment === '')) {
    reject('refreshToken must be a compact JWT', 'refreshToken');
  }
  return { refreshToken: refreshToken.trim() };
}

/**
 * Normalises a claimed email for storage-independent comparison: lower-cased
 * and trimmed (matches the `lower(email)` unique index).
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}
