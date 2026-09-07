/**
 * Security configuration — fail-closed boot secret loading.
 *
 * Every secret the authentication layer needs is REQUIRED at boot; a missing,
 * empty or malformed value is a `ServiceUnavailableError` → 503 (never a
 * silent fallback, never a default secret). Error messages name the offending
 * ENVIRONMENT VARIABLE ONLY — a secret VALUE is never echoed into an error,
 * log, or response.
 *
 * Loaded here (consumed by the composition root):
 *   - PIN_HASH_PEPPER   base64 random material decoding to ≥ 32 bytes.
 *   - JWT_PRIVATE_KEY_PEM / JWT_PUBLIC_KEY_PEM  PEM keypair, RSA (RS256) or
 *                       EC P-256 (ES256); must parse and match each other.
 *   - AUDIT_DATABASE_URL  dedicated app_audit role DSN (resolved in the
 *                       auth-audit DB module; required when wiring the sink).
 */
import { createSign, createVerify, type KeyObject } from 'node:crypto';

import { ServiceUnavailableError } from '../../shared/errors.ts';
import { decodePinPepper, PIN_HASH_PEPPER_KEY } from '../../shared/auth/pin.ts';
import { algorithmForKey, loadPrivateKey, loadPublicKey } from '../../shared/auth/jwt.ts';

export const JWT_PRIVATE_KEY_KEY = 'JWT_PRIVATE_KEY_PEM' as const;
export const JWT_PUBLIC_KEY_KEY = 'JWT_PUBLIC_KEY_PEM' as const;
export const JWT_ALGORITHM_KEY = 'JWT_ALGORITHM' as const;

export interface AuthSecrets {
  /** Raw pepper bytes (validated ≥32 bytes of entropy). */
  readonly pinPepper: Buffer;
  readonly jwtPrivateKey: KeyObject;
  readonly jwtPublicKey: KeyObject;
  /** RS256 or ES256, derived from the keypair (or pinned by JWT_ALGORITHM). */
  readonly jwtAlgorithm: 'RS256' | 'ES256';
}

export interface AuthSecretEnvironment {
  readonly [PIN_HASH_PEPPER_KEY]?: string | undefined;
  readonly [JWT_PRIVATE_KEY_KEY]?: string | undefined;
  readonly [JWT_PUBLIC_KEY_KEY]?: string | undefined;
  readonly [JWT_ALGORITHM_KEY]?: string | undefined;
}

function requirePem(env: AuthSecretEnvironment, key: typeof JWT_PRIVATE_KEY_KEY | typeof JWT_PUBLIC_KEY_KEY): string {
  const raw = env[key];
  // PEM may be supplied single-line with literal \n escapes from a .env-style
  // secret; normalise those into real newlines.
  const pem = typeof raw === 'string' ? raw.trim().replace(/\\n/g, '\n') : '';
  if (pem === '') {
    throw new ServiceUnavailableError(`${key} is not set; refusing to start without JWT signing keys.`);
  }
  return pem;
}

/**
 * Loads and validates ALL auth secrets atomically: returns a fully-validated
 * bundle or throws ServiceUnavailableError (→503). The two JWT failure cases
 * (missing vs malformed) and the pepper failure are distinct and are each
 * exercised by the boot tests.
 */
export function loadAuthSecrets(env: AuthSecretEnvironment): AuthSecrets {
  // 1) PIN pepper (decodePinPepper throws its own typed error; normalise to
  //    ServiceUnavailableError so the boot mapping is uniform).
  let pinPepper: Buffer;
  try {
    pinPepper = decodePinPepper(env[PIN_HASH_PEPPER_KEY as 'PIN_HASH_PEPPER']);
  } catch (error) {
    throw new ServiceUnavailableError(
      error instanceof Error ? error.message : `${PIN_HASH_PEPPER_KEY} is invalid.`,
    );
  }

  // 2) JWT keypair — BOTH required, both valid PEM, and matching.
  const privatePem = requirePem(env, JWT_PRIVATE_KEY_KEY);
  const publicPem = requirePem(env, JWT_PUBLIC_KEY_KEY);

  let privateKey: KeyObject;
  let publicKey: KeyObject;
  try {
    privateKey = loadPrivateKey(privatePem);
  } catch {
    throw new ServiceUnavailableError(`${JWT_PRIVATE_KEY_KEY} is not a valid PEM private key; refusing to start.`);
  }
  try {
    publicKey = loadPublicKey(publicPem);
  } catch {
    throw new ServiceUnavailableError(`${JWT_PUBLIC_KEY_KEY} is not a valid PEM public key; refusing to start.`);
  }

  // 3) The pair must agree on key type AND actually be a matching keypair:
  //    a public key from a different pair must be rejected at boot.
  let algorithm: 'RS256' | 'ES256';
  try {
    algorithm = algorithmForKey(privateKey, publicKey);
  } catch (error) {
    throw new ServiceUnavailableError(
      `JWT keypair is invalid or mismatched: ${error instanceof Error ? error.message : 'key agreement failure'}`,
    );
  }

  const digest = algorithm === 'RS256' ? 'RSA-SHA256' : 'sha256';
  const probe = Buffer.from('alpha-shadow boot key-agreement probe');
  const sign = createSign(digest);
  sign.update(probe);
  sign.end();
  const signature = sign.sign(privateKey);
  const verify = createVerify(digest);
  verify.update(probe);
  verify.end();
  if (!verify.verify(publicKey, signature)) {
    throw new ServiceUnavailableError(
      `${JWT_PRIVATE_KEY_KEY} and ${JWT_PUBLIC_KEY_KEY} are not a matching keypair; refusing to start.`,
    );
  }

  const requested = env.JWT_ALGORITHM?.trim();
  if (requested !== undefined && requested !== '' && requested !== algorithm) {
    throw new ServiceUnavailableError(
      `${JWT_ALGORITHM_KEY}=${requested} does not match the provided keypair (which yields ${algorithm}).`,
    );
  }

  return Object.freeze({ pinPepper, jwtPrivateKey: privateKey, jwtPublicKey: publicKey, jwtAlgorithm: algorithm });
}
