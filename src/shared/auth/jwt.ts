/**
 * JWT sign/verify — RS256 (RSASSA-PKCS1-v1_5 + SHA-256) and ES256
 * (ECDSA P-256 + SHA-256) ONLY, implemented with node:crypto (no third-party
 * dependency, same philosophy as password/pin — shared/ may use node:crypto).
 *
 * Algorithm-confusion defence (the classic RS256→HS256 attack):
 *   - Signing ALWAYS uses an asymmetric key; HS256/HMAC is never emitted.
 *   - The verifier takes an EXPLICIT allow-list of accepted algorithms and
 *     rejects any token whose header alg is not in that list BEFORE touching
 *     any key. There is no "accept whatever alg the header declares" path.
 *   - Verification keys are KeyObjects of a fixed type (public key); an HMAC
 *     secret can never be passed where a verifying key is expected.
 *
 * Payload contract: the token claims are security context (sub, jti, tid,
 * sec_v, typ, iat, exp, …) and NEVER include a password hash, PIN hash or
 * pepper. A static test asserts the issued claim set contains none of those
 * fields.
 */
import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';

export const JWT_ALGORITHMS = ['RS256', 'ES256'] as const;
export type JwtAlgorithm = (typeof JWT_ALGORITHMS)[number];

/** The verifier's PINNED allow-list. A token advertising anything else is rejected. */
export const ALLOWED_VERIFICATION_ALGORITHMS: readonly JwtAlgorithm[] = JWT_ALGORITHMS;

export class JwtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwtError';
  }
}

export interface AccessTokenClaims {
  /** Subject — the user id. */
  readonly sub: string;
  /** Tenant id the user authenticated against. */
  readonly tid: string;
  /** Security version (Phase 2) — derived fresh at issue AND at refresh. */
  readonly sec_v: string;
  /** Token type discriminator. */
  readonly typ: 'access';
  /** Issued-at epoch seconds. */
  readonly iat: number;
  /** Expiry epoch seconds. */
  readonly exp: number;
}

export interface RefreshTokenClaims {
  readonly sub: string;
  readonly tid: string;
  /** sec_v carried inside the refresh token; re-derived at refresh. */
  readonly sec_v: string;
  readonly typ: 'refresh';
  /** Unique token id — its SHA-256 hash is stored in auth_refresh_tokens. */
  readonly jti: string;
  /** Rotation family — replay of a revoked jti revokes the whole family. */
  readonly fam: string;
  readonly iat: number;
  readonly exp: number;
}

export type JwtClaims = AccessTokenClaims | RefreshTokenClaims;

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** Signs a claim set with the private key and the GIVEN algorithm. */
export function signJwt(
  claims: Record<string, unknown>,
  privateKey: KeyObject,
  algorithm: JwtAlgorithm,
): string {
  if (privateKey.type !== 'private') {
    throw new JwtError('signing requires a private key');
  }
  const header = { alg: algorithm, typ: 'JWT' } as const;
  const headerSegment = base64Url(JSON.stringify(header));
  const payloadSegment = base64Url(JSON.stringify(claims));
  const signingInput = `${headerSegment}.${payloadSegment}`;
  // node:crypto uses OpenSSL digest naming, NOT the JWT/JOSE alg names:
  //   RS256 → 'RSA-SHA256',  ES256 → 'sha256'.
  // Passing the JOSE name ('RS256'/'ES256') to crypto.sign throws
  // `TypeError: Invalid digest`, which would break every token.
  const nodeAlgorithm = algorithm === 'RS256' ? 'RSA-SHA256' : 'sha256';
  // ES256 (JWS/JWA) mandates the fixed-size raw R‖S signature (64 bytes for
  // P-256); node emits DER by default. Pin ieee-p1363 for ES256 so the token is
  // interoperable with any standards-compliant JWT library, not just this
  // verifier. RS256 (PKCS#1 v1.5) signature encoding is unaffected.
  const signKey =
    algorithm === 'ES256' ? ({ key: privateKey, dsaEncoding: 'ieee-p1363' } as const) : privateKey;
  const signature = cryptoSign(nodeAlgorithm, Buffer.from(signingInput), signKey);
  return `${signingInput}.${signature.toString('base64url')}`;
}

interface DecodedHeader {
  readonly alg?: unknown;
  readonly typ?: unknown;
}

interface DecodedToken {
  readonly headerSegment: string;
  readonly payloadSegment: string;
  readonly signatureSegment: string;
  readonly header: DecodedHeader;
  readonly payload: Record<string, unknown>;
  readonly signingInput: string;
}

function decodeToken(token: string): DecodedToken {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((segment) => segment === '')) {
    throw new JwtError('malformed token');
  }
  const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];
  let headerJson: unknown;
  let payloadJson: unknown;
  try {
    headerJson = JSON.parse(Buffer.from(headerSegment, 'base64url').toString('utf8')) as unknown;
    payloadJson = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new JwtError('malformed token encoding');
  }
  if (!isRecord(payloadJson)) {
    throw new JwtError('malformed token claims');
  }
  if (!isRecord(headerJson)) {
    throw new JwtError('malformed token header');
  }
  return {
    headerSegment,
    payloadSegment,
    signatureSegment,
    header: headerJson,
    payload: payloadJson,
    signingInput: `${headerSegment}.${payloadSegment}`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Verifies a JWT against the public key, accepting ONLY algorithms in
 * `allowedAlgorithms` (pinned by the caller to {RS256, ES256}). The algorithm
 * from the token header is validated BEFORE any signature operation, so an
 * HS256 token (the algorithm-confusion attack that signs with the public key
 * as an HMAC secret) is rejected outright — the public key is never usable as
 * an HMAC secret on this path.
 */
export function verifyJwt(
  token: string,
  publicKey: KeyObject,
  allowedAlgorithms: readonly JwtAlgorithm[] = ALLOWED_VERIFICATION_ALGORITHMS,
  options: { readonly now?: number } = {},
): JwtClaims {
  if (publicKey.type !== 'public') {
    throw new JwtError('verification requires a public key');
  }
  const decoded = decodeToken(token);

  // 1) Algorithm PINNING: reject anything not explicitly accepted. This is
  //    the core algorithm-confusion defence — never infer the alg from the
  //    header into a crypto call without this membership test.
  const algRaw = decoded.header.alg;
  if (typeof algRaw !== 'string' || !JWT_ALGORITHMS.includes(algRaw as JwtAlgorithm)) {
    throw new JwtError('unsupported or missing token algorithm');
  }
  const alg = algRaw as JwtAlgorithm;
  if (!allowedAlgorithms.includes(alg)) {
    throw new JwtError(`algorithm ${algRaw} is not in the verification allow-list`);
  }

  // 2) Signature verification with the asymmetric public key. cryptoVerify
  //    for RS256/ES256 cannot consume a symmetric secret; an HMAC-signed token
  //    fails both the alg check above and this verification. The digest naming
  //    and ES256 ieee-p1363 encoding must match signing (RSA uses the digest
  //    name 'RSA-SHA256', ECDSA 'sha256').
  const signature = Buffer.from(decoded.signatureSegment, 'base64url');
  const nodeAlgorithm = alg === 'RS256' ? 'RSA-SHA256' : 'sha256';
  const verifyKey = alg === 'ES256' ? ({ key: publicKey, dsaEncoding: 'ieee-p1363' } as const) : publicKey;
  let valid: boolean;
  try {
    valid = cryptoVerify(nodeAlgorithm, Buffer.from(decoded.signingInput), verifyKey, signature);
  } catch {
    throw new JwtError('signature verification failed');
  }
  if (!valid) {
    throw new JwtError('signature verification failed');
  }

  // 3) Claim shape + expiry (bracket access keeps index-signature safety).
  const claims = decoded.payload;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const exp = claims['exp'];
  const sub = claims['sub'];
  const tid = claims['tid'];
  const secV = claims['sec_v'];
  const typ = claims['typ'];
  const iat = claims['iat'];
  if (typeof exp !== 'number' || exp <= now) {
    throw new JwtError('token expired or missing exp');
  }
  if (typeof sub !== 'string' || typeof tid !== 'string' || typeof secV !== 'string') {
    throw new JwtError('token missing required claims');
  }
  if (typ !== 'access' && typ !== 'refresh') {
    throw new JwtError('token has unknown typ');
  }

  // 4) Secret-leak invariant: a signed token must never carry hash/pepper
  //    material. Enforced at issue time by construction and re-checked here so
  //    a malformed/minted token is never accepted as valid auth context.
  for (const forbidden of ['password_hash', 'passwordHash', 'pin_hash', 'pinHash', 'pepper', 'password', 'pin']) {
    if (Object.prototype.hasOwnProperty.call(claims, forbidden)) {
      throw new JwtError(`token must not carry secret material (${forbidden})`);
    }
  }

  const iatNumber = typeof iat === 'number' ? iat : now;

  if (typ === 'refresh') {
    const jti = claims['jti'];
    const fam = claims['fam'];
    if (typeof jti !== 'string' || typeof fam !== 'string') {
      throw new JwtError('refresh token missing jti/family');
    }
    return { typ: 'refresh', sub, tid, sec_v: secV, jti, fam, iat: iatNumber, exp };
  }
  return { typ: 'access', sub, tid, sec_v: secV, iat: iatNumber, exp };
}

/** Loads a PEM private key, validating it is an asymmetric signing key. */
export function loadPrivateKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch (error) {
    throw new JwtError(`invalid private key PEM: ${error instanceof Error ? error.name : 'parse error'}`);
  }
  if (key.asymmetricKeyType !== 'rsa' && key.asymmetricKeyType !== 'ec') {
    throw new JwtError(`private key must be RSA or EC (got ${key.asymmetricKeyType ?? 'unknown'})`);
  }
  return key;
}

/** Loads a PEM public key, validating it is an asymmetric verifying key. */
export function loadPublicKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch (error) {
    throw new JwtError(`invalid public key PEM: ${error instanceof Error ? error.name : 'parse error'}`);
  }
  if (key.asymmetricKeyType !== 'rsa' && key.asymmetricKeyType !== 'ec') {
    throw new JwtError(`public key must be RSA or EC (got ${key.asymmetricKeyType ?? 'unknown'})`);
  }
  return key;
}

/** Derives the JWT alg name from a key pair type; throws on mismatch. */
export function algorithmForKey(privateKey: KeyObject, publicKey: KeyObject): JwtAlgorithm {
  if (privateKey.asymmetricKeyType !== publicKey.asymmetricKeyType) {
    throw new JwtError('private/public key type mismatch');
  }
  if (privateKey.asymmetricKeyType === 'rsa') return 'RS256';
  if (privateKey.asymmetricKeyType === 'ec') {
    // ES256 is P-256 (prime256v1/secp256r1). node exposes the curve name.
    const curve = (privateKey.asymmetricKeyDetails as { namedCurve?: string } | undefined)?.namedCurve;
    if (curve !== undefined && curve !== 'prime256v1' && curve !== 'secp256r1' && curve !== 'P-256') {
      throw new JwtError(`EC key must be P-256 for ES256 (got ${curve})`);
    }
    return 'ES256';
  }
  throw new JwtError('unsupported key type for JWT signing');
}
