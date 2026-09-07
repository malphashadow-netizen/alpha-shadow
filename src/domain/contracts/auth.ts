/**
 * Authentication domain contracts (ports) — Phase 3.
 *
 * The domain stays a pure core: it declares the ports the auth engine needs
 * and the value types that cross the boundary. Hashing primitives, JWT and
 * SQL all live behind these ports (implementations in shared/auth and
 * infrastructure/security). The engine (application/engines/auth) composes
 * them; the Postgres adapter (infrastructure/security) implements the
 * repository/refresh-store over withTenantContext().
 */

/** Result of loading the candidate account for a login attempt. */
export interface AuthUserRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly email: string;
  readonly staffCode: string | null;
  readonly passwordHash: string | null;
  readonly pinHash: string | null;
  readonly isActive: boolean;
  readonly lockedUntil: Date | null;
}

/**
 * Inputs required to derive `sec_v` fresh (never cached — same philosophy as
 * the Phase-2 is_sensitive bypass) at successful login and at every refresh.
 */
export interface SecVInputs {
  readonly securityVersion: number;
  readonly activeRoles: readonly {
    readonly roleId: string;
    readonly roleVersion: number;
    readonly scopeType: 'tenant' | 'branch';
    readonly scopeId: string | null;
  }[];
}

export interface RegisterSuccessResult extends SecVInputs {
  readonly userId: string;
}

/**
 * Auth repository port. All methods run INSIDE one withTenantContext
 * transaction per engine call (tenant-scoped). The unknown-user /
 * wrong-tenant case is represented by `null` (record not visible under the
 * RLS context) so callers cannot distinguish "no such user" from
 * "user exists in another tenant".
 */
export interface IAuthRepository {
  /**
   * Looks up a user by (tenant, lower-cased email) — password mode. Returns
   * null when no row is visible for the tenant (unknown user OR the email
   * belongs to a different tenant — identical outcome).
   */
  findByEmail(tenantId: string, email: string): Promise<AuthUserRecord | null>;

  /**
   * Looks up a user by (tenant, explicit identifier) for PIN mode. The
   * identifier is EITHER a user UUID OR a staff_code; a cross-tenant scan is
   * never performed. The caller validates the tenant id first and always
   * supplies the explicit identifier (no implicit discovery).
   */
  findByPinIdentifier(tenantId: string, userIdOrStaffCode: string): Promise<AuthUserRecord | null>;

  /**
   * ATOMIC failed-attempt increment, ONE UPDATE statement only. Increments
   * failed_login_attempts and, in the SAME statement, sets locked_until when
   * the new count crosses `limit` (and the account is not already locked).
   * Returns the post-update state so the caller never issues a second query.
   */
  registerFailedAttempt(params: {
    tenantId: string;
    userId: string;
    limit: number;
    lockWindowMs: number;
  }): Promise<{ readonly failedLoginAttempts: number; readonly lockedUntil: Date | null; readonly nowLocked: boolean }>;

  /**
   * ATOMIC success reset, ONE UPDATE statement only: failed_login_attempts=0,
   * locked_until=NULL. Also returns the fresh sec_v derivation inputs.
   */
  registerSuccessfulLogin(tenantId: string, userId: string): Promise<RegisterSuccessResult>;

  /**
   * Reads the CURRENT account state and sec_v derivation inputs FRESH from the
   * store — never an L1 cache (same philosophy as the Phase-2 is_sensitive
   * bypass). Used on every refresh so a role change or security_version bump
   * immediately invalidates a still-unexpired token. Returns null when the
   * account is not visible (unknown/wrong tenant) or is not active.
   */
  getActiveSecVInputs(tenantId: string, userId: string): Promise<(SecVInputs & { readonly isActive: boolean }) | null>;
}

/** Result of rotating a refresh token, all decided inside ONE transaction. */
export type RefreshRotation =
  | { readonly status: 'rotated'; readonly userId: string; readonly tenantId: string }
  /** Token was already revoked once — replay attack; whole family revoked. */
  | { readonly status: 'replayed' }
  /** Token unknown in this tenant context (or wrong tenant). */
  | { readonly status: 'invalid' }
  /** Account row exists but is currently locked (in-window) or inactive. */
  | { readonly status: 'account_blocked' };

export interface RotateRefreshTokenParams {
  readonly tenantId: string;
  /** SHA-256 hash of the PRESENTED token jti (never the raw token). */
  readonly oldTokenHash: string;
  /** SHA-256 hash of the NEW token jti issued after a successful rotation. */
  readonly newTokenHash: string;
  /** Family id copied from the presented token's claims. */
  readonly familyId: string;
  /** New token expiry. */
  readonly newExpiresAt: Date;
  readonly now: Date;
}

/**
 * Refresh-token ledger port (tenant-scoped, RLS-backed in production). Rotation
 * is ONE atomic transaction (acceptance: rotation + replay detection must not
 * race): lock the presented token, revoke the whole family on replay, or —
 * for a fresh token — verify the account is active and not locked, revoke the
 * old row and insert the new row.
 */
export interface IRefreshTokenStore {
  /** Inserts a refresh-token row at successful login (new family). */
  store(params: {
    tenantId: string;
    userId: string;
    tokenHash: string;
    familyId: string;
    expiresAt: Date;
  }): Promise<void>;

  rotate(params: RotateRefreshTokenParams): Promise<RefreshRotation>;
}

/** Audit sink port — the auth_audit_log exception lives behind this. */
export interface IAuthAuditSink {
  recordAttempt(params: {
    readonly tenantIdAttempted: string | null;
    readonly userIdAttempted: string | null;
    readonly identifierAttempted: string;
    readonly mode: 'password' | 'pin' | 'refresh';
    readonly success: boolean;
    readonly ipAddress: string | null;
    readonly userAgent: string | null;
  }): Promise<void>;

  countRecentFailures(params: {
    readonly mode: 'password' | 'pin' | 'refresh';
    readonly ipAddress: string | null;
    readonly identifierAttempted: string;
    readonly windowMs: number;
  }): Promise<number>;
}

// The crypto/hasher/token ports (IPasswordHasher, IPinHasher, ITokenService,
// Sha256Hex, RefreshTokenClaimsShape) live in shared/auth/ports.ts: their
// implementations use node:crypto, which shared/ may import while the pure
// domain core may not. The engine imports them from there.
