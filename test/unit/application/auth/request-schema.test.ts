/**
 * Unit tests for the strict discriminated-union login/refresh schema.
 *
 * Acceptance #2 (PIN path rejects with no DB query) and the schema-level 400
 * rule: unknown mode, BOTH modes' fields together, missing fields, and extra
 * fields are all rejected before any application logic runs.
 */
import { describe, expect, it } from 'vitest';

import { ValidationError } from '../../../../src/shared/errors.ts';
import {
  normaliseEmail,
  parseLoginRequest,
  parseRefreshRequest,
} from '../../../../src/application/engines/auth/request-schema.ts';

const TENANT = '11111111-1111-4111-8111-111111111111';
const EMAIL = 'person@example.com';
// Valid PIN shapes are GENERATED at runtime (zero-plaintext rule); a 4-char
// placeholder that is all-letters can never be a real PIN, so it is safe here.
const PIN_SHAPE = 'ab12';

describe('parseLoginRequest', () => {
  it('accepts a well-formed password request', () => {
    const parsed = parseLoginRequest({ mode: 'password', tenantId: TENANT, email: EMAIL, password: 'pw-value' });
    expect(parsed).toEqual({ mode: 'password', tenantId: TENANT, email: EMAIL, password: 'pw-value' });
  });

  it('accepts a well-formed PIN request', () => {
    const parsed = parseLoginRequest({ mode: 'pin', tenantId: TENANT, userIdOrStaffCode: 'STF-001', pin: PIN_SHAPE });
    expect(parsed.mode).toBe('pin');
    if (parsed.mode === 'pin') {
      expect(parsed.userIdOrStaffCode).toBe('STF-001');
    }
  });

  it.each([
    ['unknown mode', { mode: 'magic-link', tenantId: TENANT, email: EMAIL, password: 'x' }],
    ['missing mode', { tenantId: TENANT, email: EMAIL, password: 'x' }],
    ['both modes fields together (pin + email)', { mode: 'password', tenantId: TENANT, email: EMAIL, password: 'x', pin: PIN_SHAPE }],
    ['both modes fields together (pin mode + email)', { mode: 'pin', tenantId: TENANT, userIdOrStaffCode: 's', pin: '1', email: EMAIL }],
    ['password mode missing password', { mode: 'password', tenantId: TENANT, email: EMAIL }],
    ['password mode missing email', { mode: 'password', tenantId: TENANT, password: 'x' }],
    ['pin mode missing identifier', { mode: 'pin', tenantId: TENANT, pin: PIN_SHAPE }],
    ['pin mode missing pin', { mode: 'pin', tenantId: TENANT, userIdOrStaffCode: 's' }],
    ['missing tenantId (password)', { mode: 'password', email: EMAIL, password: 'x' }],
    ['missing tenantId (pin)', { mode: 'pin', userIdOrStaffCode: 's', pin: PIN_SHAPE }],
    ['non-object body (array)', [1, 2, 3]],
    ['non-object body (string)', 'nope'],
    ['null body', null],
    ['empty object', {}],
    ['unknown extra field', { mode: 'password', tenantId: TENANT, email: EMAIL, password: 'x', admin: true }],
    ['empty password string', { mode: 'password', tenantId: TENANT, email: EMAIL, password: '   ' }],
    ['non-string password', { mode: 'password', tenantId: TENANT, email: EMAIL, password: 12345 }],
  ])('rejects %s with a ValidationError (no DB work)', (_name, body) => {
    expect(() => parseLoginRequest(body)).toThrow(ValidationError);
  });

  it('rejects a malformed tenantId (not a UUID)', () => {
    expect(() => parseLoginRequest({ mode: 'password', tenantId: 'not-a-uuid', email: EMAIL, password: 'x' })).toThrow(
      ValidationError,
    );
  });

  it('rejects a non-email value', () => {
    expect(() => parseLoginRequest({ mode: 'password', tenantId: TENANT, email: 'no-at-sign', password: 'x' })).toThrow(
      ValidationError,
    );
  });

  it('trims and normalises inputs', () => {
    const parsed = parseLoginRequest({
      mode: 'password',
      tenantId: `  ${TENANT}  `,
      email: `  ${EMAIL.toUpperCase()}  `,
      password: 'pw',
    });
    expect(parsed).toEqual({ mode: 'password', tenantId: TENANT, email: EMAIL.toUpperCase(), password: 'pw' });
    expect(normaliseEmail(`  ${EMAIL.toUpperCase()} `)).toBe(EMAIL);
  });
});

describe('parseRefreshRequest', () => {
  it('accepts a well-formed refresh body', () => {
    expect(parseRefreshRequest({ refreshToken: 'aaa.bbb.ccc' })).toEqual({ refreshToken: 'aaa.bbb.ccc' });
  });

  it.each([
    ['empty', {}],
    ['non-object', 'x'],
    ['null', null],
    ['extra field', { refreshToken: 'a.b.c', foo: 1 }],
    ['not a jwt (two segments)', { refreshToken: 'aaa.bbb' }],
    ['empty segment', { refreshToken: 'aaa..ccc' }],
    ['empty string', { refreshToken: '' }],
  ])('rejects %s with ValidationError', (_name, body) => {
    expect(() => parseRefreshRequest(body)).toThrow(ValidationError);
  });
});
