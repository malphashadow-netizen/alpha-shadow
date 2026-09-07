/**
 * Unit tests for the RefreshEngine:
 *  - a valid rotation returns new tokens and invalidates the old token;
 *  - #9 a role change / security_version bump makes a still-valid token's
 *    sec_v stale → refresh is rejected (fresh sec_v re-derivation);
 *  - reuse of an already-rotated token is detected as replay (family
 *    revocation) and rejected;
 *  - an inactive/locked account is rejected;
 *  - a structurally invalid token is rejected without leaking detail.
 */
import { describe, expect, it } from 'vitest';

import { InvalidCredentialsError } from '../../../../src/shared/errors.ts';
import { sha256Hex } from '../../../../src/shared/crypto.ts';
import { LoginEngine } from '../../../../src/application/engines/auth/login-engine.ts';
import { RefreshEngine } from '../../../../src/application/engines/auth/refresh-engine.ts';
import { buildAuthFakes, type FakeUser } from '../../../support/auth-fakes.ts';
import { generatePassword } from '../../../support/auth-secrets.ts';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ctx = { ipAddress: '203.0.113.9', userAgent: 'unit' };

async function boot() {
  const fakes = await buildAuthFakes();
  const login = new LoginEngine({
    authRepository: fakes.repo,
    refreshTokenStore: fakes.refreshStore,
    auditSink: fakes.audit,
    tokenService: fakes.tokenService,
    passwordHasher: fakes.passwordHasher,
    pinHasher: fakes.pinHasher,
    refreshTtlSeconds: fakes.refreshTtlSeconds,
    sha256: sha256Hex,
  });
  const refresh = new RefreshEngine({
    authRepository: fakes.repo,
    refreshTokenStore: fakes.refreshStore,
    auditSink: fakes.audit,
    tokenService: fakes.tokenService,
    refreshTtlSeconds: fakes.refreshTtlSeconds,
    sha256: sha256Hex,
  });
  return { login, refresh, ...fakes };
}

function baseUser(id: string, passwordHash: string): FakeUser {
  return {
    id,
    tenantId: TENANT,
    email: `${id}@x.com`,
    staffCode: null,
    passwordHash,
    pinHash: null,
    isActive: true,
    lockedUntil: null,
    failedLoginAttempts: 0,
    securityVersion: 1,
    activeRoles: [],
  };
}

describe('RefreshEngine', () => {
  it('rotates a valid refresh token and invalidates the old one', async () => {
    const { login, refresh, repo, hashPasswordValue } = await boot();
    const password = generatePassword();
    repo.addUser(baseUser('u1', await hashPasswordValue(password)));
    const first = await login.login({ mode: 'password', tenantId: TENANT, email: 'u1@x.com', password }, ctx);

    const rotated = await refresh.refresh({ refreshToken: first.refreshToken }, ctx);
    expect(rotated.status).toBe('ok');
    expect(rotated.refreshToken).not.toBe(first.refreshToken);

    // Reusing the OLD token again → replay detection → rejected.
    await expect(refresh.refresh({ refreshToken: first.refreshToken }, ctx)).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it('each rotation issues a fresh usable token (rotation chain continues)', async () => {
    const { login, refresh, repo, hashPasswordValue } = await boot();
    const password = generatePassword();
    repo.addUser(baseUser('u1', await hashPasswordValue(password)));
    const first = await login.login({ mode: 'password', tenantId: TENANT, email: 'u1@x.com', password }, ctx);
    const second = await refresh.refresh({ refreshToken: first.refreshToken }, ctx);
    const third = await refresh.refresh({ refreshToken: second.refreshToken }, ctx);
    expect(third.status).toBe('ok');
    expect(third.refreshToken).not.toBe(second.refreshToken);
  });

  it('#9: a security_version bump after issuance invalidates a still-unexpired token', async () => {
    const { login, refresh, repo, hashPasswordValue } = await boot();
    const password = generatePassword();
    const user = baseUser('u1', await hashPasswordValue(password));
    repo.addUser(user);
    const issued = await login.login({ mode: 'password', tenantId: TENANT, email: 'u1@x.com', password }, ctx);

    // Simulate the Phase-2 engine bumping security_version.
    user.securityVersion += 1;

    await expect(refresh.refresh({ refreshToken: issued.refreshToken }, ctx)).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it('#9: a role change (activeRoles change) invalidates a still-unexpired token', async () => {
    const { login, refresh, repo, hashPasswordValue } = await boot();
    const password = generatePassword();
    const user = baseUser('u1', await hashPasswordValue(password));
    repo.addUser(user);
    const issued = await login.login({ mode: 'password', tenantId: TENANT, email: 'u1@x.com', password }, ctx);

    // Simulate a role assignment change.
    user.activeRoles = [
      { roleId: 'role-new', roleVersion: 1, scopeType: 'tenant' as const, scopeId: null },
    ];

    await expect(refresh.refresh({ refreshToken: issued.refreshToken }, ctx)).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it('rejects refresh for an inactive account', async () => {
    const { login, refresh, repo, hashPasswordValue } = await boot();
    const password = generatePassword();
    const user = baseUser('u1', await hashPasswordValue(password));
    repo.addUser(user);
    const issued = await login.login({ mode: 'password', tenantId: TENANT, email: 'u1@x.com', password }, ctx);
    user.isActive = false;
    await expect(refresh.refresh({ refreshToken: issued.refreshToken }, ctx)).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it('rejects a malformed / non-JWT refresh token', async () => {
    const { refresh } = await boot();
    await expect(refresh.refresh({ refreshToken: 'not-a-jwt' }, ctx)).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
    await expect(refresh.refresh({ refreshToken: 'aaa.bbb.ccc' }, ctx)).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it('rejects a token for an unknown user (no stored row)', async () => {
    const { refresh, tokenService } = await boot();
    const now = new Date();
    const token = tokenService.issueRefreshToken({
      tenantId: TENANT,
      userId: 'ghost-user',
      secV: 'x',
      jti: crypto.randomUUID(),
      familyId: crypto.randomUUID(),
      now,
    });
    await expect(refresh.refresh({ refreshToken: token }, ctx)).rejects.toBeInstanceOf(InvalidCredentialsError);
  });
});
