/**
 * Password hashing — scrypt with a per-user random salt, stored in a
 * SELF-DESCRIBING text format so cost parameters can be raised later without
 * invalidating existing hashes (a future rehash-on-login can upgrade on
 * successful login). The stored string carries the algorithm, parameters,
 * salt and digest together — N/r/p are NEVER stored in a separate column or
 * hard-coded as a single global constant at verification time:
 *
 *   scrypt$N=16384$r=8$p=1$<salt-base64>$<hash-base64>
 *
 * Verification ALWAYS uses `crypto.timingSafeEqual` (never `===`), and the
 * length check happens BEFORE the comparison: timingSafeEqual throws on
 * length mismatch, and that throw would itself be an observable failure
 * channel — a mismatch is instead a normal `false`, normalised to the same
 * failure shape/timing as a content mismatch.
 *
 * The module is deliberately in shared/ (node:crypto is allowed here —
 * domain/ is the only layer that forbids built-ins).
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Promisified scrypt — genuinely async (the libuv thread pool does the
 * CPU-bound KDF work), so the login path never blocks the event loop for the
 * full derivation. keylen is derived from the stored record (constant per
 * scheme), keeping the derived-buffer length equal to the stored hash length
 * for the timing-safe compare.
 */
const scryptAsync = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

export const PASSWORD_ALGORITHM = 'scrypt' as const;

/** Default scrypt cost parameters (N is CPU/memory cost; r,p the mixing params). */
export const DEFAULT_SCRYPT_PARAMS = Object.freeze({
  N: 16384,
  r: 8,
  p: 1,
  /** Derived key length in bytes (fixed → constant-time compare length). */
  keylen: 64,
  /** Per-user salt length in bytes. */
  saltBytes: 16,
});

export interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64url');
}

function base64UrlDecode(text: string): Buffer | null {
  try {
    const buf = Buffer.from(text, 'base64url');
    // Reject anything that did not round-trip cleanly (malformed input).
    if (base64UrlEncode(buf) !== text) return null;
    return buf;
  } catch {
    return null;
  }
}

function validPowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value > 1 && (value & (value - 1)) === 0;
}

/** Parses a self-describing scrypt record; returns null on ANY malformation. */
export function parsePasswordHash(record: string): { params: ScryptParams; salt: Buffer; hash: Buffer } | null {
  if (typeof record !== 'string') return null;
  const parts = record.split('$');
  // ["scrypt", "N=..", "r=..", "p=..", "<salt>", "<hash>"]
  if (parts.length !== 6) return null;
  if (parts[0] !== PASSWORD_ALGORITHM) return null;

  const nPart = parts[1]?.match(/^N=(\d+)$/);
  const rPart = parts[2]?.match(/^r=(\d+)$/);
  const pPart = parts[3]?.match(/^p=(\d+)$/);
  if (nPart === null || nPart === undefined) return null;
  if (rPart === null || rPart === undefined) return null;
  if (pPart === null || pPart === undefined) return null;

  const N = Number(nPart[1]);
  const r = Number(rPart[1]);
  const p = Number(pPart[1]);
  // N must be a power of two within scrypt's supported range; r,p positive.
  if (!validPowerOfTwo(N) || N < 2 || N > 2 ** 31) return null;
  if (!Number.isInteger(r) || r < 1 || r > 256) return null;
  if (!Number.isInteger(p) || p < 1 || p > 256) return null;

  const salt = base64UrlDecode(parts[4] ?? '');
  const hash = base64UrlDecode(parts[5] ?? '');
  if (salt === null || hash === null || salt.length === 0 || hash.length === 0) return null;

  return { params: { N, r, p }, salt, hash };
}

/** Produces the self-describing scrypt record for a NEW password. */
export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
  keylen: number = DEFAULT_SCRYPT_PARAMS.keylen,
  saltBytes: number = DEFAULT_SCRYPT_PARAMS.saltBytes,
): Promise<string> {
  const salt = randomBytes(saltBytes);
  const derived = await scryptAsync(password, salt, keylen, { N: params.N, r: params.r, p: params.p });
  return [
    PASSWORD_ALGORITHM,
    `N=${params.N}`,
    `r=${params.r}`,
    `p=${params.p}`,
    base64UrlEncode(salt),
    base64UrlEncode(derived),
  ].join('$');
}

/**
 * Verifies a candidate password against a stored record.
 *
 * Returns false for ANY failure (malformed record, wrong password) — never
 * throws on a mismatch, so the caller sees one uniform failure. Always runs
 * the scrypt KDF when the record is well-formed, including for the wrong
 * password, so timing reflects the cost of the KDF.
 */
export async function verifyPassword(password: string, record: string): Promise<boolean> {
  const parsed = parsePasswordHash(record);
  if (parsed === null) {
    // Malformed stored record: still spend a KDF derivation against a fixed
    // dummy salt so this branch is not a free, timing-distinguishable skip.
    await scryptAsync(password, Buffer.alloc(DEFAULT_SCRYPT_PARAMS.saltBytes, 0xa5), DEFAULT_SCRYPT_PARAMS.keylen, {
      N: DEFAULT_SCRYPT_PARAMS.N,
      r: DEFAULT_SCRYPT_PARAMS.r,
      p: DEFAULT_SCRYPT_PARAMS.p,
    });
    return false;
  }
  const derived = await scryptAsync(password, parsed.salt, parsed.hash.length, {
    N: parsed.params.N,
    r: parsed.params.r,
    p: parsed.params.p,
  });
  return constantTimeEquals(derived, parsed.hash);
}

/**
 * Constant-time buffer equality with an EXPLICIT length check FIRST.
 *
 * `crypto.timingSafeEqual` throws when the buffers differ in length; that
 * throw must never escape as a distinct error/timing channel, so any length
 * mismatch returns false immediately (and the caller always performs a
 * dummy derivation for the absent-user case before invoking this, keeping
 * the overall login path timing uniform — see the auth engine).
 */
export function constantTimeEquals(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * A shared dummy record for the "user not found" path. It is generated ONCE
 * at module load with real random salt so the non-existent-user login pays
 * the same scrypt cost as a real user (the engine verifies the supplied
 * password against it and discards the always-false result).
 */
export async function generateDummyPasswordRecord(params: ScryptParams = DEFAULT_SCRYPT_PARAMS): Promise<string> {
  // The plaintext here is random and never used as a credential; the point is
  // the KDF cost structure of the record, not the value.
  return hashPassword(randomBytes(32).toString('base64url'), params);
}
