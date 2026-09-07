/**
 * Login engine — orchestrates password & PIN authentication with a uniform
 * failure contract.
 *
 * Uniform failure (anti-enumeration / timing-oracle defence):
 *   EVERY failure — unknown user, wrong password/PIN, locked account,
 *   inactive account, an existing email under a DIFFERENT tenant — returns
 *   the SAME `InvalidCredentialsError` (→ 401 INVALID_CREDENTIALS), same body
 *   and headers. The unknown-user path performs a REAL dummy password/PIN
 *   verification (genuine scrypt/HMAC cost) so its latency is statistically
 *   indistinguishable from a wrong-password attempt on an existing user.
 *
 * Lockout (atomic, per-mode limits): PIN is stricter (3) than password (5).
 * The failed-attempt counter and `locked_until` are advanced by ONE atomic
 * UPDATE (no lost updates; the account locks exactly once at the threshold).
 */
import { randomUUID } from 'node:crypto';

import { InvalidCredentialsError, RateLimitError } from '../../../shared/errors.ts';
import { sha256Hex } from '../../../shared/crypto.ts';
import type { IAuthAuditSink, IAuthRepository, IRefreshTokenStore } from '../../../domain/contracts/auth.ts';
import type { IPasswordHasher, IPinHasher, ITokenService, Sha256Hex } from '../../../shared/auth/ports.ts';
import { deriveSecV } from '../../../domain/contracts/sec-v.ts';
import type { LoginRequest } from './request-schema.ts';
import { normaliseEmail } from './request-schema.ts';

export const PASSWORD_LOCK_THRESHOLD = 5;
export const PIN_LOCK_THRESHOLD = 3;
export const LOCK_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const IP_RATE_LIMIT = 20; // failed attempts per window per IP
export const ACCOUNT_RATE_LIMIT = 10; // failed attempts per window per target identifier

export interface LoginContext {
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export interface LoginSuccess {
  readonly status: 'ok';
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly userId: string;
  readonly tenantId: string;
}

export type LoginOutcome = LoginSuccess;

export interface LoginEngineDeps {
  readonly authRepository: IAuthRepository;
  readonly refreshTokenStore: IRefreshTokenStore;
  readonly auditSink: IAuthAuditSink;
  readonly tokenService: ITokenService;
  readonly passwordHasher: IPasswordHasher;
  readonly pinHasher: IPinHasher;
  readonly sha256?: Sha256Hex;
  readonly passwordThreshold?: number;
  readonly pinThreshold?: number;
  readonly lockWindowMs?: number;
  readonly rateLimitWindowMs?: number;
  readonly ipRateLimit?: number;
  readonly accountRateLimit?: number;
  readonly refreshTtlSeconds: number;
}

/** Uniform 401 — never carries distinguishing detail. */
function invalidCredentials(): never {
  throw new InvalidCredentialsError('Invalid credentials');
}

export class LoginEngine {
  private readonly authRepository: IAuthRepository;
  private readonly refreshTokenStore: IRefreshTokenStore;
  private readonly auditSink: IAuthAuditSink;
  private readonly tokenService: ITokenService;
  private readonly passwordHasher: IPasswordHasher;
  private readonly pinHasher: IPinHasher;
  private readonly sha256: Sha256Hex;
  private readonly passwordThreshold: number;
  private readonly pinThreshold: number;
  private readonly lockWindowMs: number;
  private readonly rateLimitWindowMs: number;
  private readonly ipRateLimit: number;
  private readonly accountRateLimit: number;
  private readonly refreshTtlSeconds: number;

  constructor(deps: LoginEngineDeps) {
    this.authRepository = deps.authRepository;
    this.refreshTokenStore = deps.refreshTokenStore;
    this.auditSink = deps.auditSink;
    this.tokenService = deps.tokenService;
    this.passwordHasher = deps.passwordHasher;
    this.pinHasher = deps.pinHasher;
    this.sha256 = deps.sha256 ?? sha256Hex;
    this.refreshTtlSeconds = deps.refreshTtlSeconds;
    this.passwordThreshold = deps.passwordThreshold ?? PASSWORD_LOCK_THRESHOLD;
    this.pinThreshold = deps.pinThreshold ?? PIN_LOCK_THRESHOLD;
    this.lockWindowMs = deps.lockWindowMs ?? LOCK_WINDOW_MS;
    this.rateLimitWindowMs = deps.rateLimitWindowMs ?? RATE_LIMIT_WINDOW_MS;
    this.ipRateLimit = deps.ipRateLimit ?? IP_RATE_LIMIT;
    this.accountRateLimit = deps.accountRateLimit ?? ACCOUNT_RATE_LIMIT;
  }

  async login(request: LoginRequest, context: LoginContext): Promise<LoginOutcome> {
    const mode = request.mode;
    const identifierKey = this.identifierForAudit(request);
    const tenantIdAttempted = request.tenantId;
    const userIdAttempted = mode === 'pin' ? request.userIdOrStaffCode : null;

    // 1) Rate limiting — two independent counters derived from auth_audit_log
    //    sliding windows (IP + targeted identifier). Enforced BEFORE any user
    //    lookup so a flooding client never reaches the credential path.
    const failures = await this.auditSink.countRecentFailures({
      mode,
      ipAddress: context.ipAddress,
      identifierAttempted: identifierKey,
      windowMs: this.rateLimitWindowMs,
    });
    if (failures >= this.ipRateLimit || failures >= this.accountRateLimit) {
      await this.auditSink.recordAttempt({
        tenantIdAttempted,
        userIdAttempted,
        identifierAttempted: identifierKey,
        mode,
        success: false,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      });
      throw new RateLimitError('rate limit exceeded');
    }

    // 2) Load the candidate account within the claimed tenant. null ==
    //    unknown user OR the email belongs to a different tenant — identical.
    const user =
      mode === 'password'
        ? await this.authRepository.findByEmail(request.tenantId, normaliseEmail(request.email))
        : await this.authRepository.findByPinIdentifier(request.tenantId, request.userIdOrStaffCode);

    // 3) Verify the SECRET first (constant-time, real KDF/HMAC cost) BEFORE
    //    any state check, so locked/inactive/unknown accounts do not
    //    short-circuit the timing. Every branch performs the comparable work.
    let secretValid: boolean;
    if (user === null) {
      // Absent-account path: genuine dummy KDF/HMAC cost, result discarded.
      secretValid =
        mode === 'password'
          ? await this.passwordHasher.verify(request.password, await this.passwordHasher.dummyRecord())
          : this.pinHasher.dummyVerify(request.pin);
    } else if (mode === 'password') {
      // No password credential on this account → verify against a dummy
      // record anyway (same cost), guaranteeing failure.
      const record = user.passwordHash ?? (await this.passwordHasher.dummyRecord());
      secretValid = user.passwordHash !== null && (await this.passwordHasher.verify(request.password, record));
    } else {
      secretValid = user.pinHash !== null && this.pinHasher.verify(user.tenantId, user.id, request.pin, user.pinHash);
    }

    // 4) Uniform failure: unknown user, bad secret, inactive, or locked all
    //    collapse to the identical 401.
    const accountBlocked = user !== null && (!user.isActive || this.isLocked(user.lockedUntil));
    if (user === null || !secretValid || accountBlocked) {
      // A wrong-SECRET attempt on a REAL, not-yet-blocked account advances the
      // atomic counter (the lock transition happens inside that one UPDATE).
      // Blocked accounts are not counted again (already over threshold).
      if (user !== null && !secretValid && !accountBlocked) {
        const limit = mode === 'password' ? this.passwordThreshold : this.pinThreshold;
        await this.authRepository.registerFailedAttempt({
          tenantId: request.tenantId,
          userId: user.id,
          limit,
          lockWindowMs: this.lockWindowMs,
        });
      }
      await this.auditSink.recordAttempt({
        tenantIdAttempted,
        userIdAttempted: user?.id ?? userIdAttempted,
        identifierAttempted: identifierKey,
        mode,
        success: false,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      });
      invalidCredentials();
    }

    // After the uniform-failure check, `user` is non-null, secret valid,
    // active and unlocked.
    const account = user;

    // 5) Success — atomic reset + FRESH sec_v, issue tokens, audit.
    const secVInputs = await this.authRepository.registerSuccessfulLogin(request.tenantId, account.id);
    const secV = deriveSecV(secVInputs.activeRoles, secVInputs.securityVersion, this.sha256);
    const now = new Date();
    const accessToken = this.tokenService.issueAccessToken({
      tenantId: request.tenantId,
      userId: account.id,
      secV,
      now,
    });
    const jti = randomUUID();
    const familyId = randomUUID();
    const refreshToken = this.tokenService.issueRefreshToken({
      tenantId: request.tenantId,
      userId: account.id,
      secV,
      jti,
      familyId,
      now,
    });
    // Persist the rotation ledger row (hash of jti only — never the token).
    await this.refreshTokenStore.store({
      tenantId: request.tenantId,
      userId: account.id,
      tokenHash: this.sha256(jti),
      familyId,
      expiresAt: new Date(now.getTime() + this.refreshTtlSeconds * 1000),
    });
    await this.auditSink.recordAttempt({
      tenantIdAttempted,
      userIdAttempted: account.id,
      identifierAttempted: identifierKey,
      mode,
      success: true,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });

    return { status: 'ok', accessToken, refreshToken, userId: account.id, tenantId: request.tenantId };
  }

  private isLocked(lockedUntil: Date | null): boolean {
    if (lockedUntil === null) return false;
    return new Date(lockedUntil).getTime() > Date.now();
  }

  private identifierForAudit(request: LoginRequest): string {
    if (request.mode === 'password') return `email:${normaliseEmail(request.email)}`;
    return `pin:${request.userIdOrStaffCode.trim().toLowerCase()}`;
  }
}
