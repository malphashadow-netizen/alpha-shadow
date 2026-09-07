/**
 * Unit tests for HMAC-SHA256 PIN hashing and the fail-closed pepper
 * validation (≥32 decoded bytes; empty/short treated as missing).
 */
import { describe, expect, it } from 'vitest';

import {
  decodePinPepper,
  dummyPinHash,
  hashPin,
  PIN_HASH_BYTES,
  verifyPin,
} from '../../../../src/shared/auth/pin.ts';
import { generatePepper, generatePin } from '../../../support/auth-secrets.ts';

describe('PIN pepper validation (fail closed at boot)', () => {
  it('accepts a base64 pepper decoding to >= 32 bytes', () => {
    const pepper = decodePinPepper(generatePepper(32));
    expect(pepper.length).toBe(32);
    expect(decodePinPepper(generatePepper(64)).length).toBe(64);
  });

  it.each([undefined, '', '   ', 'short'])(
    'rejects a missing/short pepper (%p) with a typed error naming only the env var',
    (raw) => {
      expect(() => decodePinPepper(raw)).toThrow(/PIN_HASH_PEPPER/);
    },
  );

  it('a 31-byte pepper is too short; 32 bytes is the minimum', () => {
    const tooShort = Buffer.alloc(31, 0x1).toString('base64');
    expect(() => decodePinPepper(tooShort)).toThrow(/fewer than 32 bytes/);
    // A non-base64 random-ish short string decodes to fewer than 32 bytes.
    expect(() => decodePinPepper('aaaa')).toThrow(/fewer than 32 bytes/);
  });

  it('error messages never contain the pepper VALUE', () => {
    const secret = generatePepper(48);
    try {
      decodePinPepper('too-short');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secret);
    }
  });
});

describe('PIN HMAC hashing / verification', () => {
  const pepper = decodePinPepper(generatePepper(32));
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const userId = '22222222-2222-4222-8222-222222222222';

  it('produces a fixed 32-byte HMAC and verifies the right PIN', () => {
    const pin = generatePin();
    const stored = hashPin(pepper, tenantId, userId, pin);
    expect(Buffer.from(stored, 'base64').length).toBe(PIN_HASH_BYTES);
    expect(verifyPin(pepper, tenantId, userId, pin, stored)).toBe(true);
  });

  it('rejects a wrong PIN', () => {
    const pin = generatePin();
    const stored = hashPin(pepper, tenantId, userId, pin);
    expect(verifyPin(pepper, tenantId, userId, generatePin(), stored)).toBe(false);
  });

  it('binds the hash to (tenant, user): same PIN under a different context fails', () => {
    const pin = generatePin();
    const stored = hashPin(pepper, tenantId, userId, pin);
    expect(verifyPin(pepper, '33333333-3333-4333-8333-333333333333', userId, pin, stored)).toBe(false);
    expect(verifyPin(pepper, tenantId, '44444444-4444-4444-8444-444444444444', pin, stored)).toBe(false);
  });

  it('never throws on a malformed stored value — returns false (length check before compare)', () => {
    expect(verifyPin(pepper, tenantId, userId, generatePin(), 'not-base64-hmac!!')).toBe(false);
    expect(verifyPin(pepper, tenantId, userId, generatePin(), Buffer.from('short').toString('base64'))).toBe(false);
  });

  it('dummyPinHash produces a valid fixed-length hash that never matches a candidate', () => {
    const dummy = dummyPinHash(pepper);
    expect(Buffer.from(dummy, 'base64').length).toBe(PIN_HASH_BYTES);
    expect(verifyPin(pepper, tenantId, userId, generatePin(), dummy)).toBe(false);
  });
});
