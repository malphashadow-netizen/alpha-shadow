/**
 * Production ITokenService — asymmetric JWT (RS256/ES256) over the jwt
 * primitives in this folder.
 *
 * - Access and refresh tokens are SIGNED only with the private key; the
 *   verifier pins the algorithm allow-list {RS256, ES256} (no HMAC path,
 *   algorithm-confusion safe — see jwt.ts).
 * - Refresh tokens carry `sec_v`; the auth engine RE-DERIVES sec_v from the
 *   store on every refresh and compares it (never trusts the token value).
 * - Claims contain security context only — never a password hash, pin hash or
 *   pepper (asserted in jwt.verifyJwt and by a static payload test).
 */
import { randomUUID, type KeyObject } from 'node:crypto';

import type { ITokenService, RefreshTokenClaimsShape } from './ports.ts';
import { signJwt, verifyJwt, type JwtAlgorithm } from './jwt.ts';

export const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes
export const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export interface TokenServiceOptions {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly algorithm: JwtAlgorithm;
  readonly accessTokenTtlSeconds?: number;
  readonly refreshTokenTtlSeconds?: number;
}

export class JwtTokenService implements ITokenService {
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private readonly algorithm: JwtAlgorithm;
  private readonly accessTtl: number;
  private readonly refreshTtl: number;

  constructor(options: TokenServiceOptions) {
    this.privateKey = options.privateKey;
    this.publicKey = options.publicKey;
    this.algorithm = options.algorithm;
    this.accessTtl = options.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
    this.refreshTtl = options.refreshTokenTtlSeconds ?? DEFAULT_REFRESH_TOKEN_TTL_SECONDS;
  }

  issueAccessToken(params: { tenantId: string; userId: string; secV: string; now: Date }): string {
    const iat = Math.floor(params.now.getTime() / 1000);
    return signJwt(
      {
        typ: 'access',
        sub: params.userId,
        tid: params.tenantId,
        sec_v: params.secV,
        iat,
        exp: iat + this.accessTtl,
      },
      this.privateKey,
      this.algorithm,
    );
  }

  issueRefreshToken(params: {
    tenantId: string;
    userId: string;
    secV: string;
    jti: string;
    familyId: string;
    now: Date;
  }): string {
    const iat = Math.floor(params.now.getTime() / 1000);
    return signJwt(
      {
        typ: 'refresh',
        sub: params.userId,
        tid: params.tenantId,
        sec_v: params.secV,
        jti: params.jti,
        fam: params.familyId,
        iat,
        exp: iat + this.refreshTtl,
      },
      this.privateKey,
      this.algorithm,
    );
  }

  verifyRefreshToken(token: string, now: Date): RefreshTokenClaimsShape {
    const claims = verifyJwt(token, this.publicKey, undefined, { now: Math.floor(now.getTime() / 1000) });
    if (claims.typ !== 'refresh') {
      throw new Error('token is not a refresh token');
    }
    return {
      typ: 'refresh',
      sub: claims.sub,
      tid: claims.tid,
      sec_v: claims.sec_v,
      jti: claims.jti,
      fam: claims.fam,
      exp: claims.exp,
    };
  }

  /** Exposed for tests: verify with an explicit (pinned) algorithm set. */
  verifyWithAlgorithms(token: string, algorithms: readonly JwtAlgorithm[], now: Date): RefreshTokenClaimsShape {
    const claims = verifyJwt(token, this.publicKey, algorithms, { now: Math.floor(now.getTime() / 1000) });
    if (claims.typ !== 'refresh') {
      throw new Error('token is not a refresh token');
    }
    return {
      typ: 'refresh',
      sub: claims.sub,
      tid: claims.tid,
      sec_v: claims.sec_v,
      jti: claims.jti,
      fam: claims.fam,
      exp: claims.exp,
    };
  }

  refreshTtlSeconds(): number {
    return this.refreshTtl;
  }
}

/** Generates a fresh token id / family id (UUID v4). */
export function newTokenId(): string {
  return randomUUID();
}
