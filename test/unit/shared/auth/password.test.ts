/**
 * Unit tests for the self-describing scrypt password hashing:
 *  - round-trip verify;
 *  - wrong password fails; tampered record fails;
 *  - the stored record is self-describing (carries N/r/p + salt + hash);
 *  - comparison is length-safe FIRST (a truncated hash fails, never throws);
 *  - every distinct hash uses a fresh random salt (records differ).
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SCRYPT_PARAMS,
  constantTimeEquals,
  generateDummyPasswordRecord,
  hashPassword,
  parsePasswordHash,
  verifyPassword,
} from '../../../../src/shared/auth/password.ts';
import { generatePassword } from '../../../support/auth-secrets.ts';

// Fast cost parameters for tests (production defaults stay at N=16384).
const TEST_PARAMS = { N: 16, r: 8, p: 1 } as const;

describe('scrypt password hashing', () => {
  it('produces a self-describing record carrying algorithm, params, salt and hash', async () => {
    const password = generatePassword();
    const record = await hashPassword(password, TEST_PARAMS);
    const parts = record.split('$');
    expect(parts[0]).toBe('scrypt');
    expect(parts[1]).toBe(`N=${TEST_PARAMS.N}`);
    expect(parts[2]).toBe(`r=${TEST_PARAMS.r}`);
    expect(parts[3]).toBe(`p=${TEST_PARAMS.p}`);
    expect(parts[4]).toBeTruthy(); // salt base64url
    expect(parts[5]).toBeTruthy(); // hash base64url

    const parsed = parsePasswordHash(record);
    expect(parsed).not.toBeNull();
    expect(parsed?.params).toEqual({ N: TEST_PARAMS.N, r: TEST_PARAMS.r, p: TEST_PARAMS.p });
    expect(parsed?.hash.length).toBe(DEFAULT_SCRYPT_PARAMS.keylen);
  });

  it('verifies the correct password and rejects a wrong one', async () => {
    const password = generatePassword();
    const record = await hashPassword(password, TEST_PARAMS);
    expect(await verifyPassword(password, record)).toBe(true);
    expect(await verifyPassword(generatePassword(), record)).toBe(false);
  });

  it('uses a fresh per-user salt (two hashes of the same password differ)', async () => {
    const password = generatePassword();
    const a = await hashPassword(password, TEST_PARAMS);
    const b = await hashPassword(password, TEST_PARAMS);
    expect(a).not.toBe(b);
    expect(await verifyPassword(password, a)).toBe(true);
    expect(await verifyPassword(password, b)).toBe(true);
  });

  it('never throws on a malformed/truncated record — returns false (length check before timingSafeEqual)', async () => {
    const password = generatePassword();
    const record = await hashPassword(password, TEST_PARAMS);
    const truncated = record.slice(0, -4);
    await expect(verifyPassword(password, truncated)).resolves.toBe(false);
    await expect(verifyPassword(password, 'not-a-valid-record')).resolves.toBe(false);
    await expect(verifyPassword(password, 'scrypt$N=x$r=8$p=1$aa$bb')).resolves.toBe(false);
  });

  it('constantTimeEquals returns false on length mismatch and never throws', () => {
    expect(constantTimeEquals(Buffer.from('short'), Buffer.from('a-longer-buffer'))).toBe(false);
    expect(constantTimeEquals(Buffer.from('abcdef'), Buffer.from('abcdef'))).toBe(true);
  });

  it('generates a valid dummy record for the unknown-user path', async () => {
    const dummy = await generateDummyPasswordRecord(TEST_PARAMS);
    expect(parsePasswordHash(dummy)).not.toBeNull();
    // The dummy verifies its own (random) content only; an arbitrary password fails.
    expect(await verifyPassword(generatePassword(), dummy)).toBe(false);
  });
});
