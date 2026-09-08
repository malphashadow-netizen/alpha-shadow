/**
 * Refresh engine — rotating refresh tokens with fresh security-version
 * enforcement.
 *
 * Rules (spec):
 *   - The refresh token CARRIES `sec_v`, but on every refresh `sec_v` is
 *     RE-DERIVED FROM THE STORE (never an L1 cache — same philosophy as the
 *     Phase-2 is_sensitive bypass) and compared. Any difference (a role
 *     change, a scope change, or users.security_version bump from the Phase-2
 *     engine) rejects the refresh immediately, forcing a fresh login — even
 *     though the token itself has not expired.
 *   - Every use ROTATES: a brand-new refresh token is issued and the old one
 *     is invalidated atomically (one transaction). Replaying an already-used
 *     (revoked) token is detected; the whole token family is revoked and the
 *     request gets the uniform 401.
 *   - All failures — invalid signature/expiry, unknown token, replay,
 *     blocked/inactive account, a SUSPENDED tenant (the tenant-level
 *     analogue of a blocked account), stale sec_v — collapse to the same
 *     InvalidCredentialsError (401 INVALID_CREDENTIALS). A suspension
 *     landing MID-refresh (past the sec_v lookup) is caught at rotation
 *     and collapses to the same 401.
 */
import { randomUUID } from 'node:crypto';

import { InvalidCredentialsError, RateLimitError, TenantSuspendedError } from '../../../shared/errors.ts';
import { sha256Hex, timingSafeEqualHex } from '../../../shared/crypto.ts';
import type { IAuthAuditSink, IAuthRepository, IRefreshTokenStore, SecVInputs } from '../../../domain/contracts/auth.ts';
import type { ITokenService, Sha256Hex } from '../../../shared/auth/ports.ts';
import { deriveSecV } from '../../../domain/contracts/sec-v.ts';
import type { LoginContext } from './login-engine.ts';
import { RATE_LIMIT_WINDOW_MS, IP_RATE_LIMIT, ACCOUNT_RATE_LIMIT } from './login-engine.ts';
import type { RefreshRequest } from './request-schema.ts';

export interface RefreshSuccess {
  readonly status: 'ok';
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly userId: string;
  readonly tenantId: string;
}

export interface RefreshEngineDeps {
  readonly authRepository: IAuthRepository;
  readonly refreshTokenStore: IRefreshTokenStore;
  readonly auditSink: IAuthAuditSink;
  readonly tokenService: ITokenService;
  readonly sha256?: Sha256Hex;
  readonly refreshTtlSeconds: number;
  readonly rateLimitWindowMs?: number;
  readonly ipRateLimit?: number;
  readonly accountRateLimit?: number;
}

function invalidCredentials(): never {
  throw new InvalidCredentialsError('Invalid credentials');
}

export class RefreshEngine {
  private readonly authRepository: IAuthRepository;
  private readonly refreshTokenStore: IRefreshTokenStore;
  private readonly auditSink: IAuthAuditSink;
  private readonly tokenService: ITokenService;
  private readonly sha256: Sha256Hex;
  private readonly refreshTtlSeconds: number;
  private readonly rateLimitWindowMs: number;
  private readonly ipRateLimit: number;
  private readonly accountRateLimit: number;

  constructor(deps: RefreshEngineDeps) {
    this.authRepository = deps.authRepository;
    this.refreshTokenStore = deps.refreshTokenStore;
    this.auditSink = deps.auditSink;
    this.tokenService = deps.tokenService;
    this.sha256 = deps.sha256 ?? sha256Hex;
    this.refreshTtlSeconds = deps.refreshTtlSeconds;
    this.rateLimitWindowMs = deps.rateLimitWindowMs ?? RATE_LIMIT_WINDOW_MS;
    this.ipRateLimit = deps.ipRateLimit ?? IP_RATE_LIMIT;
    this.accountRateLimit = deps.accountRateLimit ?? ACCOUNT_RATE_LIMIT;
  }

  async refresh(request: RefreshRequest, context: LoginContext): Promise<RefreshSuccess> {
    const now = new Date();
    const auditIdentifier = 'refresh:token';

    // 1) Verify the JWT (signature, pinned alg allow-list, expiry, shape).
    //    Any failure → uniform 401. No account state is distinguishable here.
    let claims: { sub: string; tid: string; sec_v: string; jti: string; fam: string };
    try {
      const verified = this.tokenService.verifyRefreshToken(request.refreshToken, now);
      claims = { sub: verified.sub, tid: verified.tid, sec_v: verified.sec_v, jti: verified.jti, fam: verified.fam };
    } catch {
      await this.recordFailure(context, auditIdentifier, null, null);
      invalidCredentials();
    }

    const tenantId = claims.tid;
    const userId = claims.sub;

    // 2) Rate limiting on the refresh path too (IP window), before store work.
    const failures = await this.auditSink.countRecentFailures({
      mode: 'refresh',
      ipAddress: context.ipAddress,
      identifierAttempted: `refresh:${userId}`,
      windowMs: this.rateLimitWindowMs,
    });
    if (failures >= this.ipRateLimit || failures >= this.accountRateLimit) {
      await this.recordFailure(context, `refresh:${userId}`, tenantId, userId);
      throw new RateLimitError('rate limit exceeded');
    }

    // 3) RE-DERIVE sec_v FRESH from the store — never the token's value,
    //    never cached. A role/scope/security_version change makes the token's
    //    sec_v stale → force a new login.
    //    B5: a suspended tenant throws from the in-tx status probe — the
    //    tenant-level analogue of a blocked account → uniform 401.
    let fresh: (SecVInputs & { readonly isActive: boolean }) | null;
    try {
      fresh = await this.authRepository.getActiveSecVInputs(tenantId, userId);
    } catch (error: unknown) {
      if (!(error instanceof TenantSuspendedError)) throw error;
      await this.recordFailure(context, `refresh:${userId}`, tenantId, userId);
      invalidCredentials();
    }
    if (fresh?.isActive !== true) {
      await this.recordFailure(context, `refresh:${userId}`, tenantId, userId);
      invalidCredentials();
    }
    const freshSecV = deriveSecV(fresh.activeRoles, fresh.securityVersion, this.sha256);
    if (!timingSafeEqualHex(freshSecV, claims.sec_v)) {
      await this.recordFailure(context, `refresh:${userId}`, tenantId, userId);
      invalidCredentials();
    }

    // 4) Rotate atomically: revoke the presented token; replay → family
    //    revocation + 401; blocked account → 401; success → insert new row.
    const newJti = randomUUID();
    const newExpiresAt = new Date(now.getTime() + this.refreshTtlSeconds * 1000);
    const oldTokenHash = this.sha256(claims.jti);
    const newTokenHash = this.sha256(newJti);

    // B5 race backstop: a suspension landing between the sec_v lookup and
    // rotation collapses to the uniform 401.
    let rotation: Awaited<ReturnType<IRefreshTokenStore['rotate']>>;
    try {
      rotation = await this.refreshTokenStore.rotate({
        tenantId,
        oldTokenHash,
        newTokenHash,
        familyId: claims.fam,
        newExpiresAt,
        now,
      });
    } catch (error: unknown) {
      if (!(error instanceof TenantSuspendedError)) throw error;
      await this.recordFailure(context, `refresh:${userId}`, tenantId, userId);
      invalidCredentials();
    }

    if (rotation.status !== 'rotated') {
      // 'replayed' (stolen-token reuse) and 'invalid'/'account_blocked' all
      // collapse to the same uniform 401.
      await this.recordFailure(context, `refresh:${userId}`, tenantId, userId);
      invalidCredentials();
    }

    // 5) Issue the replacement tokens. The NEW refresh token keeps the same
    //    family (rotation chain) but has a fresh jti; sec_v is the fresh value.
    const accessToken = this.tokenService.issueAccessToken({ tenantId, userId, secV: freshSecV, now });
    const refreshToken = this.tokenService.issueRefreshToken({
      tenantId,
      userId,
      secV: freshSecV,
      jti: newJti,
      familyId: claims.fam,
      now,
    });

    await this.auditSink.recordAttempt({
      tenantIdAttempted: tenantId,
      userIdAttempted: userId,
      identifierAttempted: `refresh:${userId}`,
      mode: 'refresh',
      success: true,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });

    return { status: 'ok', accessToken, refreshToken, userId, tenantId };
  }

  private async recordFailure(context: LoginContext, identifier: string, tenantId: string | null, userId: string | null): Promise<void> {
    await this.auditSink.recordAttempt({
      tenantIdAttempted: tenantId,
      userIdAttempted: userId,
      identifierAttempted: identifier,
      mode: 'refresh',
      success: false,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
  }
}
