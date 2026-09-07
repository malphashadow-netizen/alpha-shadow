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

/** Fail closed: missing tax configuration is NEVER an implicit zero rate. */
export class NoApplicableTaxRateError extends NotFoundError {
  constructor(readonly taxCategoryId: string, readonly on: string) {
    super(`No applicable tax rate for category ${taxCategoryId} on ${on}`);
  }
}
export class NoApplicableTaxLiabilityRuleError extends NotFoundError {
  constructor(readonly countryCode: string, readonly salesChannel: string, readonly on: string) {
    super(`No applicable tax liability rule for ${countryCode}/${salesChannel} on ${on}`);
  }
}
export class TaxConfigurationError extends ValidationError {}
export class InvoiceTaxBatchRequiredError extends ValidationError {
  constructor() { super('invoice_total rounding requires the complete invoice batch, not isolated line resolution'); }
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

/** Explicit procedural opt-in is required, independently of VAT registration. */
export class ExciseConfirmationRequiredError extends ForbiddenError {
  constructor() { super('Excise requires the dedicated, explicitly confirmed manufacturer/importer administrative path'); }
}

/**
 * Phase 7 (orders) — a void was attempted on an order whose payment_status is
 * not 'open'. FAIL-CLOSED: the real Void Payment → Reopen → Void Item →
 * re-collection sequence needs the payments engine, which is a deliberately
 * deferred future phase (same placeholder discipline as ZATCA). Until that
 * phase exists the answer is NEVER an implicit zero or an unconditional
 * allow — it is this explicit error, raised by the void engine and enforced
 * again by the order_voids validation trigger at the database level.
 */
export class PaymentReversalRequiredError extends DomainError {
  readonly code = 'order.payment_reversal_required' as const;
  constructor(readonly paymentStatus: string) {
    super(
      `Void on an order with payment_status='${paymentStatus}' requires a payment reversal; the payments engine is not built yet (fail closed)`,
    );
  }
}

/** No station routing rule matched the item — routing is never defaulted. */
export class NoMatchingRoutingRuleError extends NotFoundError {
  constructor(readonly branchId: string, readonly menuItemId: string) {
    super(`No enabled station routing rule matches menu item ${menuItemId} in branch ${branchId}; refusing the order item (fail closed)`);
  }
}

/** The tenant has no usable workflow (or initial state) — orders are refused. */
export class OrderWorkflowNotConfiguredError extends NotFoundError {
  constructor(readonly tenantId: string) {
    super(`Tenant ${tenantId} has no enabled order workflow with an initial top-level state`);
  }
}

/** Transition outside the tenant's enabled workflow sequence (fail-closed). */
export class WorkflowTransitionError extends ValidationError {}

/**
 * Hard-deleting a tenant_order_workflow_state that is referenced by ANY row
 * (active or archived) in orders / order_items / order_item_status_events.
 * Fail-closed: the audit trail is permanent — disable instead of delete.
 */
export class WorkflowStateInUseError extends ConflictError {
  constructor(readonly stateId: string) {
    super(`Workflow state ${stateId} is referenced by order evidence and cannot be deleted; disable it (is_enabled = false) instead`);
  }
}

/** The selected void reason is disabled or its platform kind is disabled. */
export class VoidReasonUnavailableError extends ValidationError {
  constructor(readonly voidReasonId: string) {
    super(`Void reason ${voidReasonId} is not enabled for this tenant`);
  }
}

/** The optional tenant void time limit (from order_items.created_at) passed. */
export class VoidTimeLimitExceededError extends ForbiddenError {
  constructor(readonly itemCreatedAt: Date, readonly limitMinutes: number) {
    super(`Void time limit of ${limitMinutes} minutes (counted from the item creation) has been exceeded`);
  }
}

/** A manager override is required (actor tier < reason tier) and was not provided. */
export class ManagerOverrideRequiredError extends ForbiddenError {
  constructor(readonly requiredTier: string) {
    super(`This void requires a manager override (reason requires tier '${requiredTier}'); no override was provided`);
  }
}

/**
 * The live manager-override PIN challenge failed (unknown/inactive/PIN-less
 * manager, or wrong PIN). A manager override is NEVER a name picked from a
 * list: the approving manager's own separate PIN must be verified at the
 * exact moment of the void.
 */
export class ManagerOverrideAuthenticationError extends AuthorizationError {}

/**
 * Manager-override live PIN challenge rate limit (security patch): too many
 * failed challenges — either the TARGET MANAGER is hard-locked (5 consecutive
 * failures) or the INITIATING ACTOR is hard-locked across all managers (10
 * failures in the window).
 *
 * Anti-oracle contract: the client sees ONE fixed generic message for BOTH
 * lock shapes — no signal about which limit tripped, no PIN feedback, no
 * manager-existence information. `retryAfterSeconds` (locked_until − now) is
 * safe to expose: it helps a legitimate, patient user and gives a PIN guesser
 * nothing (they already know they must wait).
 */
export class ManagerOverrideRateLimitedError extends DomainError {
  readonly code = 'order.override_rate_limited' as const;
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(MANAGER_OVERRIDE_RATE_LIMITED_MESSAGE);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The ONE client-facing message for both manager-lock and actor-lock cases. */
export const MANAGER_OVERRIDE_RATE_LIMITED_MESSAGE = 'لقد تجاوزت الحد المسموح من المحاولات. حاول لاحقًا.' as const;

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
  /**
   * Optional machine-readable Retry-After hint (seconds). Currently only the
   * manager-override rate limit sets it; absence means "no defined retry
   * moment" — transport layers must treat it as optional.
   */
  readonly retryAfterSeconds?: number;
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
    // Phase 7: fail-closed payments placeholder — a paid-order void needs the
    // future payments engine; the client gets an explicit, retryable-later 409.
    case 'order.payment_reversal_required':
      return { status: 409, code: error.code, message: error.message };
    case 'rate_limit.exceeded':
      return { status: 429, code: error.code, message: error.message };
    // Manager-override challenge lock (manager lock or actor lock): ONE fixed
    // generic message — the error text itself is the anti-oracle boundary.
    // retryAfterSeconds is safe to expose (see the class doc).
    case 'order.override_rate_limited': {
      const retryAfterSeconds = error instanceof ManagerOverrideRateLimitedError ? error.retryAfterSeconds : undefined;
      return retryAfterSeconds === undefined
        ? { status: 429, code: error.code, message: error.message }
        : { status: 429, code: error.code, message: error.message, retryAfterSeconds };
    }
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
