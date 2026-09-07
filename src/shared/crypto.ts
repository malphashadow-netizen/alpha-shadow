/**
 * Crypto primitives for the security layer.
 *
 * SHA-256 is the hashing primitive for the `sec_v` token derivation
 * (src/domain/contracts/sec-v.ts). The domain layer stays a pure core by
 * RECEIVING the hash function; this module is the production implementation
 * (node:crypto is allowed in shared — only src/domain forbids node built-ins).
 */
import { createHash } from 'node:crypto';

/** Lowercase hex digest of SHA-256 over UTF-8 `text`. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
