/**
 * Crypto primitives for the security layer.
 *
 * SHA-256 is the hashing primitive for the `sec_v` token derivation
 * (src/domain/contracts/sec-v.ts). The domain layer stays a pure core by
 * RECEIVING the hash function; this module is the production implementation
 * (node:crypto is allowed in shared — only src/domain forbids node built-ins).
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/** Lowercase hex digest of SHA-256 over UTF-8 `text`. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Constant-time equality for two SHA-256 hex digests (used to compare
 * security-version/sec_v values without leaking a comparison channel). A
 * length mismatch returns false BEFORE timingSafeEqual — that call throws on
 * unequal length, and the throw must never surface as a distinct, observable
 * failure. Equal-length digests are compared with timingSafeEqual.
 */
export function timingSafeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
