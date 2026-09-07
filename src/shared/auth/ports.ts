/**
 * Ports for the security primitives the auth engine consumes.
 *
 * These live in shared/ (not domain/) because their implementations
 * (password.ts, pin.ts, jwt/token-service.ts) use node:crypto, which shared/
 * is allowed to import while the pure domain core is not. The application
 * engine depends only on these interfaces.
 */

/** Secret verification for passwords (scrypt). */
export interface IPasswordHasher {
  verify(password: string, record: string): Promise<boolean>;
  /** A well-formed record of the current scheme for the unknown-user dummy path. */
  dummyRecord(): Promise<string>;
}

/** Secret verification for PINs (HMAC-SHA256 under the pepper). */
export interface IPinHasher {
  verify(tenantId: string, userId: string, pin: string, record: string): boolean;
  /** Fixed-cost placeholder comparison for the unknown-user path (always false). */
  dummyVerify(pin: string): boolean;
}

export interface RefreshTokenClaimsShape {
  readonly typ: 'refresh';
  readonly sub: string;
  readonly tid: string;
  readonly sec_v: string;
  readonly jti: string;
  readonly fam: string;
  readonly exp: number;
}

/** Token service port (asymmetric JWT only; algorithms pinned at verify). */
export interface ITokenService {
  issueAccessToken(params: { tenantId: string; userId: string; secV: string; now: Date }): string;
  issueRefreshToken(params: {
    tenantId: string;
    userId: string;
    secV: string;
    jti: string;
    familyId: string;
    now: Date;
  }): string;
  /** Verifies signature/alg-pinning/expiry and returns the typed claims. Throws on ANY failure. */
  verifyRefreshToken(token: string, now: Date): RefreshTokenClaimsShape;
}

/** SHA-256 hex over text (used to hash refresh-token jtis for storage). */
export type Sha256Hex = (text: string) => string;
