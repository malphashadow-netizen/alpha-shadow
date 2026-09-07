/**
 * PIN hashing — HMAC-SHA256 keyed by a server-side pepper from the
 * PIN_HASH_PEPPER environment variable.
 *
 * Boot-time validation (fail closed): the pepper is base64/standard-encoded
 * random material that MUST decode to at least 32 bytes (256 bits). An empty
 * or too-short value is treated as MISSING and makes the security composition
 * root refuse to boot with a 503 — a weak/absent pepper is never silently
 * substituted with a default. The pepper VALUE must never appear in an error
 * message or log; validation reports the variable name only.
 *
 * HMAC-SHA256 output is a fixed 32 bytes, so a stored pin_hash is always
 * exactly 32 bytes and `timingSafeEqual` always sees equal lengths; a
 * malformed/short stored value is rejected BEFORE the comparison (same rule
 * as password verification — length mismatch is a normal `false`, never a
 * thrown, distinguishable error).
 *
 * The MAC binds the context (tenant, user) so a hash from one tenant/user
 * cannot be replayed against another even if a row leaked.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const PIN_HASH_PEPPER_KEY = 'PIN_HASH_PEPPER' as const;
/** Minimum pepper entropy after base64 decoding (bytes). */
export const MIN_PEPPER_BYTES = 32;
export const PIN_HASH_BYTES = 32; // HMAC-SHA256 output length.

export class InvalidPinPepperError extends Error {
  constructor(
    message: string,
    readonly envKey: string = PIN_HASH_PEPPER_KEY,
  ) {
    super(message);
    this.name = 'InvalidPinPepperError';
  }
}

/**
 * Decodes and validates the pepper from its env-encoded form. Accepts standard
 * base64 or base64url. Returns the raw key bytes. Throws InvalidPinPepperError
 * (message names the variable only, never the value) when absent or < 32 bytes.
 */
export function decodePinPepper(raw: string | undefined): Buffer {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new InvalidPinPepperError(`${PIN_HASH_PEPPER_KEY} is not set; refusing to start without a PIN pepper.`);
  }
  const decoded = Buffer.from(raw.trim(), 'base64url');
  if (decoded.length < MIN_PEPPER_BYTES) {
    throw new InvalidPinPepperError(
      `${PIN_HASH_PEPPER_KEY} decodes to fewer than ${MIN_PEPPER_BYTES} bytes of entropy; refusing to start with a weak pepper.`,
    );
  }
  return decoded;
}

/**
 * Computes the HMAC-SHA256 of a PIN under the pepper, bound to (tenantId,
 * userId). Returned as standard base64 (fixed 44-char string for 32 bytes).
 */
export function hashPin(pepper: Buffer, tenantId: string, userId: string, pin: string): string {
  const mac = createHmac('sha256', pepper);
  mac.update(`pin:${tenantId}:${userId}:`);
  mac.update(pin, 'utf8');
  return mac.digest('base64');
}

/**
 * Verifies a candidate PIN against a stored base64 HMAC. Never throws on
 * mismatch: a malformed/wrong-length stored value is an immediate `false`
 * (length check BEFORE timingSafeEqual), and the comparison itself is
 * constant time.
 */
export function verifyPin(pepper: Buffer, tenantId: string, userId: string, pin: string, stored: string): boolean {
  let storedBytes: Buffer;
  try {
    storedBytes = Buffer.from(stored, 'base64');
  } catch {
    return false;
  }
  // Fixed-length output contract: anything else is a malformed record.
  if (storedBytes.length !== PIN_HASH_BYTES) {
    return false;
  }
  const candidate = Buffer.from(hashPin(pepper, tenantId, userId, pin), 'base64');
  if (candidate.length !== storedBytes.length) {
    return false;
  }
  return timingSafeEqual(candidate, storedBytes);
}

/**
 * Computes a dummy HMAC for the absent/unknown-user PIN path so that branch
 * performs the same cheap fixed-cost work as a real verification (the result
 * is discarded; it is always compared as a failure by the engine).
 */
export function dummyPinHash(pepper: Buffer): string {
  return hashPin(pepper, 'unknown-tenant', 'unknown-user', randomBytes(8).toString('hex'));
}
