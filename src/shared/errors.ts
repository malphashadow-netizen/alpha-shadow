/**
 * Error hierarchy for the domain and shared layers.
 *
 * Every error carries a stable `code` for machine-readable branching.
 * DomainError is the abstract base; concrete errors extend it.
 *
 * ValidationError has a special implementation detail for the `field`
 * property to satisfy `useDefineForClassFields` semantics:
 *   - declared as `declare readonly field?: string`
 *   - assigned only when `field !== undefined`
 * so that `hasOwnProperty(instance, 'field')` is false when no field is given.
 *
 * Error handling policy: `toErrorResponse()` is the SINGLE central place that
 * consumes `isDomainError()` and maps a domain error to a transport-level
 * response. New error types must be registered only here (plus their code in
 * the switch below) so the mapping never drifts from the hierarchy.
 */

export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

export class ValidationError extends DomainError {
  readonly code = 'validation.failed' as const;
  declare readonly field?: string;

  constructor(message: string, field?: string) {
    super(message);
    if (field !== undefined) {
      this.field = field;
    }
  }
}

export class NotFoundError extends DomainError {
  readonly code = 'not_found' as const;
}

export class MissingExchangeRateError extends NotFoundError {
  readonly fromCurrency: string;
  readonly toCurrency: string;
  readonly transactionTime: Date;

  constructor(fromCurrency: string, toCurrency: string, transactionTime: Date) {
    super(
      `No exchange rate for ${fromCurrency} to ${toCurrency} effective at or before ${transactionTime.toISOString()}`,
    );
    this.fromCurrency = fromCurrency;
    this.toCurrency = toCurrency;
    this.transactionTime = transactionTime;
  }
}

export class ConflictError extends DomainError {
  readonly code = 'conflict' as const;
}

export class ConfigurationError extends DomainError {
  readonly code = 'config.invalid' as const;
  declare readonly key?: string;

  constructor(message: string, key?: string) {
    super(message);
    if (key !== undefined) {
      this.key = key;
    }
  }
}

/**
 * The caller failed to satisfy an authorization precondition (missing token,
 * wrong principal, …). Distinct from `ForbiddenError`: this one means the
 * request may be retried after the caller authenticates/authorizes correctly.
 */
export class AuthorizationError extends DomainError {
  readonly code = 'authorization.failed' as const;
}

/**
 * The caller IS authenticated but is not allowed to perform the operation.
 * Never leak internals into the message; the code is the machine-readable part.
 */
export class ForbiddenError extends DomainError {
  readonly code = 'forbidden' as const;
}

/**
 * A tenant-isolation invariant was violated or a cross-tenant access attempt
 * was detected (e.g. tenant_id ≠ current_setting('app.current_tenant_id')).
 * Raised by the tenant-context layer and RLS-boundary guards; treated as a
 * security event, never as a retryable client error.
 */
export class TenantIsolationViolationError extends DomainError {
  readonly code = 'tenant_isolation.violation' as const;
}

/**
 * A rate limit was exceeded. The transport layer is expected to attach
 * retry-after information; `code` stays stable for machine-readable branching.
 *
 * NOTE (known gap): alpha-shadow does not yet execute enforcement middleware
 * for this error — see docs/backlog.md ("Rate limiting / kill switch"). The
 * type exists so application engines can signal limits without inventing
 * ad-hoc error shapes.
 */
export class RateLimitError extends DomainError {
  readonly code = 'rate_limit.exceeded' as const;
}

/**
 * Authentication failed for ANY reason (unknown user, wrong password/PIN,
 * locked account, inactive account, wrong tenant for an existing email,
 * invalid/expired/replayed refresh token). The security layer maps EVERY one
 * of these to the SAME response shape, status and headers — a constant
 * 401 `INVALID_CREDENTIALS` with no distinguishing detail — so neither the
 * body nor the headers become an existence/state oracle.
 */
export class InvalidCredentialsError extends DomainError {
  readonly code = 'INVALID_CREDENTIALS' as const;
}

/**
 * The service is not in a safe state to serve the request — used exclusively
 * by the fail-closed boot posture: a missing/invalid security secret
 * (PIN_HASH_PEPPER, JWT signing/verifying key) or a missing audit connection
 * maps to a 503 so the process never runs a partially-configured security
 * layer. The message carries the offending VARIABLE NAME only, never the
 * secret value.
 */
export class ServiceUnavailableError extends DomainError {
  readonly code = 'service.unavailable' as const;
}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}

export interface ErrorResponse {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

/** Server-side sink for the detailed error (never sent to the client). */
export type ErrorLogSink = (error: unknown) => void;

/**
 * Default sink: logs the real error server-side. `console.error` is the only
 * allowed console channel in this project's ESLint config (`no-console` allows
 * error/warn); production composition roots may replace this with a structured
 * logger — the function signature is the contract.
 */
export const defaultErrorLogSink: ErrorLogSink = (error: unknown): void => {
  console.error('[alpha-shadow] internal error details:', error);
};

const INTERNAL_ERROR_MESSAGE = 'Internal server error' as const;

/**
 * Central error mapper — the ONLY production place that calls `isDomainError`.
 *
 * Security contract:
 *   - 4xx domain errors keep their (client-safe) message.
 *   - ANY 500-class response — `config.invalid`, unknown domain codes,
 *     non-domain errors — returns the constant `INTERNAL_ERROR_MESSAGE`.
 *     The real, detailed message is delivered ONLY to `logSink` (default:
 *     `defaultErrorLogSink`, i.e. the server-side log). ConfigurationError
 *     messages may embed connection-string/credential fragments and must
 *     never cross the HTTP boundary.
 */
export function toErrorResponse(error: unknown, logSink: ErrorLogSink = defaultErrorLogSink): ErrorResponse {
  if (!isDomainError(error)) {
    logSink(error);
    return { status: 500, code: 'internal.error', message: INTERNAL_ERROR_MESSAGE };
  }

  switch (error.code) {
    case 'validation.failed':
      return { status: 400, code: error.code, message: error.message };
    case 'authorization.failed':
      return { status: 401, code: error.code, message: error.message };
    // Security layer: EVERY authentication failure is the identical constant
    // 401 INVALID_CREDENTIALS (see InvalidCredentialsError).
    case 'INVALID_CREDENTIALS':
      return { status: 401, code: error.code, message: 'Invalid credentials' };
    case 'forbidden':
    case 'tenant_isolation.violation':
      return { status: 403, code: error.code, message: error.message };
    case 'not_found':
      return { status: 404, code: error.code, message: error.message };
    case 'conflict':
      return { status: 409, code: error.code, message: error.message };
    case 'rate_limit.exceeded':
      return { status: 429, code: error.code, message: error.message };
    // Fail-closed boot: missing/invalid security secret or audit connection.
    // 503 (never 500) — the dependency is unavailable, and the generic message
    // leaks no configuration detail; the real cause goes to the log sink only.
    case 'service.unavailable':
      logSink(error);
      return { status: 503, code: error.code, message: 'Service temporarily unavailable' };
    case 'config.invalid':
      // 500-class: never echo the detailed message; log it server-side only.
      logSink(error);
      return { status: 500, code: error.code, message: INTERNAL_ERROR_MESSAGE };
    default:
      // Exhaustive over the current hierarchy: new codes must be added here,
      // and every unknown code is treated as 500-class (no detail leakage).
      logSink(error);
      return { status: 500, code: error.code, message: INTERNAL_ERROR_MESSAGE };
  }
}
