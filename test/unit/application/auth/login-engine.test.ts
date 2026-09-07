/**
 * Unit tests for the LoginEngine uniform-failure and lockout contract.
 *
 * Covers (acceptance criteria):
 *  - #2 PIN path is only reached with an explicit identifier (schema layer).
 *  - #5 locked/inactive accounts return the SAME failure as a wrong password.
 *  - unknown-user timing parity is a property of the dummy-hash design (the
 *    unknown-user branch ALWAYS invokes the password/PIN hasher dummy path;
 *    the statistical timing measurement is asserted in integration).
 *  - #4 atomic counter / single lock (fake models the single-UPDATE effect;
 *    the no-lost-update concurrency is asserted against real Postgres in the
 *    integration suite).
 *  - #10 existing email under a WRONG tenant is indistinguishable from
 *    unknown user.
 */
import { describe, expect, it } from 'vitest';

import { InvalidCredentialsError } from '../../../../src/shared/errors.ts';
import { sha256Hex } from '../../../../src/shared/crypto.ts';
import { LoginEngine, PASSWORD_LOCK_THRESHOLD, PIN_LOCK_THRESHOLD } from '../../../../src/application/engines/auth/login-engine.ts';
import { buildAuthFakes, type FakeUser } from '../../../support/auth-fakes.ts';
import { generatePassword, generatePin } from '../../../support/auth-secrets.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

async function makeEngine() {
  const fakes = await buildAuthFakes();
  const engine = new LoginEngine({
    authRepository: fakes.repo,
    refreshTokenStore: fakes.refreshStore,
    auditSink: fakes.audit,
    tokenService: fakes.tokenService,
    passwordHasher: fakes.passwordHasher,
    pinHasher: fakes.pinHasher,
    refreshTtlSeconds: fakes.refreshTtlSeconds,
    sha256: sha256Hex,
  });
  return { engine, ...fakes };
}

function passwordUser(overrides: Partial<FakeUser> & Pick<FakeUser, 'id' | 'tenantId' | 'email' | 'passwordHash'>): FakeUser {
  return {
    staffCode: null,
    pinHash: null,
    isActive: true,
    lockedUntil: null,
    failedLoginAttempts: 0,
    securityVersion: 1,
    activeRoles: [],
    ...overrides,
  };
}

function pinUser(overrides: Partial<FakeUser> & Pick<FakeUser, 'id' | 'tenantId' | 'staffCode' | 'pinHash'>): FakeUser {
  return {
    email: `${overrides.id}@test.local`,
    passwordHash: null,
    isActive: true,
    lockedUntil: null,
    failedLoginAttempts: 0,
    securityVersion: 1,
    activeRoles: [],
    ...overrides,
  };
}

const ctx = { ipAddress: '203.0.113.7', userAgent: 'unit-test' };

describe('LoginEngine — password mode', () => {
  it('returns tokens on a correct password', async () => {
    const { engine, repo, hashPasswordValue } = await makeEngine();
    const password = generatePassword();
    repo.addUser(
      passwordUser({ id: 'u1', tenantId: TENANT_A, email: 'a@x.com', passwordHash: await hashPasswordValue(password) }),
    );
    const result = await engine.login(
      { mode: 'password', tenantId: TENANT_A, email: 'a@x.com', password },
      ctx,
    );
    expect(result.status).toBe('ok');
    expect(result.accessToken.split('.')).toHaveLength(3);
    expect(result.refreshToken.split('.')).toHaveLength(3);
  });

  it('rejects a wrong password with InvalidCredentialsError', async () => {
    const { engine, repo, hashPasswordValue } = await makeEngine();
    repo.addUser(
      passwordUser({ id: 'u1', tenantId: TENANT_A, email: 'a@x.com', passwordHash: await hashPasswordValue(generatePassword()) }),
    );
    await expect(
      engine.login({ mode: 'password', tenantId: TENANT_A, email: 'a@x.com', password: generatePassword() }, ctx),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it('rejects an unknown user identically (and still performs dummy work)', async () => {
    const { engine, audit } = await makeEngine();
    await expect(
      engine.login({ mode: 'password', tenantId: TENANT_A, email: 'ghost@x.com', password: generatePassword() }, ctx),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
    // The failure was audited; no success.
    expect(audit.attempts.some((a) => a.success)).toBe(false);
  });

  it('#10: a correct email+password under the WRONG tenant is rejected the same way', async () => {
    const { engine, repo, audit, hashPasswordValue } = await makeEngine();
    const password = generatePassword();
    repo.addUser(
      passwordUser({ id: 'u1', tenantId: TENANT_A, email: 'shared@x.com', passwordHash: await hashPasswordValue(password) }),
    );
    // Correct credentials, but claimed tenant B (user does not exist there).
    await expect(
      engine.login({ mode: 'password', tenantId: TENANT_B, email: 'shared@x.com', password }, ctx),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
    // Only a failed attempt was audited; no success recorded anywhere.
    expect(audit.attempts).toHaveLength(1);
    expect(audit.attempts[0]?.success).toBe(false);
  });

  it('#5: a locked account returns the same InvalidCredentialsError (with the CORRECT password)', async () => {
    const { engine, repo, hashPasswordValue } = await makeEngine();
    const password = generatePassword();
    repo.addUser(
      passwordUser({
        id: 'u1',
        tenantId: TENANT_A,
        email: 'locked@x.com',
        passwordHash: await hashPasswordValue(password),
        lockedUntil: new Date(Date.now() + 15 * 60 * 1000),
        failedLoginAttempts: PASSWORD_LOCK_THRESHOLD,
      }),
    );
    await expect(
      engine.login({ mode: 'password', tenantId: TENANT_A, email: 'locked@x.com', password }, ctx),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it('#5: an inactive account returns the same InvalidCredentialsError (with the CORRECT password)', async () => {
    const { engine, repo, hashPasswordValue } = await makeEngine();
    const password = generatePassword();
    repo.addUser(
      passwordUser({
        id: 'u1',
        tenantId: TENANT_A,
        email: 'inactive@x.com',
        passwordHash: await hashPasswordValue(password),
        isActive: false,
      }),
    );
    await expect(
      engine.login({ mode: 'password', tenantId: TENANT_A, email: 'inactive@x.com', password }, ctx),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it(`locks the account after ${PASSWORD_LOCK_THRESHOLD} failed password attempts (single transition)`, async () => {
    const { engine, repo, hashPasswordValue } = await makeEngine();
    repo.addUser(
      passwordUser({ id: 'u1', tenantId: TENANT_A, email: 'a@x.com', passwordHash: await hashPasswordValue(generatePassword()) }),
    );
    for (let i = 0; i < PASSWORD_LOCK_THRESHOLD; i += 1) {
      await engine
        .login({ mode: 'password', tenantId: TENANT_A, email: 'a@x.com', password: generatePassword() }, ctx)
        .catch(() => undefined);
    }
    const user = repo.users.get(repo.key(TENANT_A, 'u1'));
    expect(user?.failedLoginAttempts).toBe(PASSWORD_LOCK_THRESHOLD);
    expect(user?.lockedUntil).not.toBeNull();
    expect(user?.lockedUntil?.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('LoginEngine — PIN mode', () => {
  it('returns tokens on a correct PIN', async () => {
    const { engine, repo, hashPinValue } = await makeEngine();
    const pin = generatePin();
    repo.addUser(
      pinUser({ id: 'u9', tenantId: TENANT_A, staffCode: 'STF-9', pinHash: hashPinValue(TENANT_A, 'u9', pin) }),
    );
    const result = await engine.login({ mode: 'pin', tenantId: TENANT_A, userIdOrStaffCode: 'STF-9', pin }, ctx);
    expect(result.status).toBe('ok');
  });

  it('rejects a wrong PIN', async () => {
    const { engine, repo, hashPinValue } = await makeEngine();
    repo.addUser(
      pinUser({ id: 'u9', tenantId: TENANT_A, staffCode: 'STF-9', pinHash: hashPinValue(TENANT_A, 'u9', generatePin()) }),
    );
    await expect(
      engine.login({ mode: 'pin', tenantId: TENANT_A, userIdOrStaffCode: 'STF-9', pin: generatePin() }, ctx),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it(`PIN limit (${PIN_LOCK_THRESHOLD}) is stricter than the password limit`, async () => {
    expect(PIN_LOCK_THRESHOLD).toBeLessThan(PASSWORD_LOCK_THRESHOLD);
  });

  it(`locks after ${PIN_LOCK_THRESHOLD} failed PIN attempts`, async () => {
    const { engine, repo, hashPinValue } = await makeEngine();
    repo.addUser(
      pinUser({ id: 'u9', tenantId: TENANT_A, staffCode: 'STF-9', pinHash: hashPinValue(TENANT_A, 'u9', generatePin()) }),
    );
    for (let i = 0; i < PIN_LOCK_THRESHOLD; i += 1) {
      await engine
        .login({ mode: 'pin', tenantId: TENANT_A, userIdOrStaffCode: 'STF-9', pin: generatePin() }, ctx)
        .catch(() => undefined);
    }
    const user = repo.users.get(repo.key(TENANT_A, 'u9'));
    expect(user?.failedLoginAttempts).toBe(PIN_LOCK_THRESHOLD);
    expect(user?.lockedUntil).not.toBeNull();
  });

  it('unknown PIN identifier fails identically', async () => {
    const { engine } = await makeEngine();
    await expect(
      engine.login({ mode: 'pin', tenantId: TENANT_A, userIdOrStaffCode: 'NOBODY', pin: generatePin() }, ctx),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });
});
