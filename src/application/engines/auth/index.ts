/**
 * Authentication engine — Phase 3.
 *
 *   LoginEngine    password (scrypt) & PIN (HMAC-SHA256) login with uniform
 *                  401 failures, atomic lockout, dummy-hash timing parity and
 *                  audit/rate-limit enforcement.
 *   RefreshEngine  rotating refresh tokens with fresh sec_v re-derivation
 *                  (never cached) and replay/family revocation.
 *   request-schema strict discriminated-union request validation (400 before
 *                  any DB call).
 */

export {
  LoginEngine,
  PASSWORD_LOCK_THRESHOLD,
  PIN_LOCK_THRESHOLD,
  LOCK_WINDOW_MS,
  RATE_LIMIT_WINDOW_MS,
  IP_RATE_LIMIT,
  ACCOUNT_RATE_LIMIT,
  type LoginEngineDeps,
  type LoginContext,
  type LoginOutcome,
  type LoginSuccess,
} from './login-engine.ts';
export {
  RefreshEngine,
  type RefreshEngineDeps,
  type RefreshSuccess,
} from './refresh-engine.ts';
export {
  parseLoginRequest,
  parseRefreshRequest,
  normaliseEmail,
  type LoginRequest,
  type PasswordLoginRequest,
  type PinLoginRequest,
  type RefreshRequest,
} from './request-schema.ts';
