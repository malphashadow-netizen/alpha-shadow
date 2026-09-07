/**
 * Production IPasswordHasher / IPinHasher adapters over the scrypt and
 * HMAC-SHA256 primitives. They hold the secret material (password cost params,
 * the validated pepper) and expose the narrow port the auth engine consumes.
 *
 * The dummy paths spend REAL hashing cost (scrypt/HMAC) so the absent-user
 * login branch is timing-comparable to the real one; their results are always
 * failures by construction.
 */
import type { IPasswordHasher, IPinHasher } from './ports.ts';
import {
  DEFAULT_SCRYPT_PARAMS,
  generateDummyPasswordRecord,
  hashPassword,
  verifyPassword,
  type ScryptParams,
} from './password.ts';
import { dummyPinHash, hashPin, verifyPin } from './pin.ts';

export class ScryptPasswordHasher implements IPasswordHasher {
  private readonly params: ScryptParams;
  private dummyRecordPromise: Promise<string> | undefined;

  constructor(params: ScryptParams = DEFAULT_SCRYPT_PARAMS) {
    this.params = params;
  }

  verify(password: string, record: string): Promise<boolean> {
    return verifyPassword(password, record);
  }

  async dummyRecord(): Promise<string> {
    // Generate once and reuse (a stable well-formed record keeps the dummy
    // path cost identical to a real verification on every call).
    this.dummyRecordPromise ??= generateDummyPasswordRecord(this.params);
    return this.dummyRecordPromise;
  }

  /** Helper used by seeding/provisioning (not the login path). */
  hash(password: string): Promise<string> {
    return hashPassword(password, this.params);
  }
}

export class HmacPinHasher implements IPinHasher {
  private readonly pepper: Buffer;

  constructor(pepper: Buffer) {
    this.pepper = pepper;
  }

  verify(tenantId: string, userId: string, pin: string, record: string): boolean {
    return verifyPin(this.pepper, tenantId, userId, pin, record);
  }

  /**
   * Computes a dummy HMAC (fixed cost) and compares it against a random
   * target so the result is always false while performing the same work as a
   * real verification.
   */
  dummyVerify(pin: string): boolean {
    const dummyStored = dummyPinHash(this.pepper);
    // Always run the full verify against the real candidate bound to the
    // dummy context; it can never match a different-context hash.
    return verifyPin(this.pepper, 'unknown-tenant', 'unknown-user', pin, dummyStored);
  }

  /** Helper used by seeding/provisioning (not the login path). */
  hash(tenantId: string, userId: string, pin: string): string {
    return hashPin(this.pepper, tenantId, userId, pin);
  }
}
