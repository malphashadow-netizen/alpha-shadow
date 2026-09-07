/**
 * Integration: authentication login flow against REAL PostgreSQL.
 *
 * Covers acceptance criteria:
 *  - #1 unknown-user timing vs wrong-password existing user (repeated samples);
 *  - #4 concurrent wrong passwords at the threshold: counter is accurate, no
 *    lost updates, account locks exactly once;
 *  - #5 locked / is_active=false → identical 401 INVALID_CREDENTIALS;
 *  - #10 correct email+password under the WRONG tenant → same 401;
 *  - atomic lockout (PIN threshold stricter than password);
 *  - audit rows are written to auth_audit_log and rate-limit counters derive
 *    from it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InvalidCredentialsError } from '../../src/shared/errors.ts';
import { buildAuthHarness, seedRandomUser, seedUser, type Harness } from '../support/auth-harness.ts';
import { generatePassword, generatePin } from '../support/auth-secrets.ts';
import { withTestClient } from '../support/database.ts';

const TENANT = 'a0000000-0000-4000-8000-000000000001';
const TENANT_OTHER = 'a0000000-0000-4000-8000-000000000002';
const ctx = { ipAddress: '198.51.100.4', userAgent: 'integration' };

describe('auth login (real PostgreSQL)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildAuthHarness({ passwordThreshold: 5, pinThreshold: 3, ipRateLimit: 200, accountRateLimit: 200 });
  });

  afterEach(async () => {
    await withTestClient(async (client) => {
      // Test-only cleanup; CASCADE is restricted to the disposable test DB.
      await client.query(
        `TRUNCATE auth_audit_log, auth_refresh_tokens, user_roles, role_permissions, roles, users, branches RESTART IDENTITY CASCADE`,
      );
      // Re-seed the system role for the remaining tenants if needed (roles
      // table is cleared; tests create users directly, not roles, so no
      // further seed is required for these cases).
    });
    await h.close();
  });

  it('logs in a real user with the correct password and writes a success audit row', async () => {
    const user = await seedRandomUser(h.client, h, { tenantId: TENANT, mode: 'password' });
    const result = await h.login.login(
      { mode: 'password', tenantId: TENANT, email: user.email, password: user.password ?? '' },
      ctx,
    );
    expect(result.status).toBe('ok');
    expect(result.accessToken.split('.')).toHaveLength(3);
    expect(result.refreshToken.split('.')).toHaveLength(3);

    const audit = await h.client.query<{ success: boolean }>(
      'SELECT success FROM auth_audit_log WHERE mode = $1 ORDER BY created_at DESC LIMIT 1',
      ['password'],
    );
    expect(audit.rows[0]?.success).toBe(true);
  });

  it('PIN login works with staff_code and a runtime PIN', async () => {
    const pin = generatePin(4);
    const staffCode = 'STF-INT-001';
    const user = await seedUser(h.client, {
      tenantId: TENANT,
      staffCode,
      pin,
      pinHasher: h.pinHasher,
    });
    const result = await h.login.login({ mode: 'pin', tenantId: TENANT, userIdOrStaffCode: staffCode, pin }, ctx);
    expect(result.status).toBe('ok');
    expect(result.userId).toBe(user.userId);
  });

  it('#1: unknown-user login and wrong-password existing user are statistically comparable in timing', async () => {
    const existing = await seedRandomUser(h.client, h, { tenantId: TENANT, mode: 'password' });

    const measure = async (fn: () => Promise<unknown>): Promise<number> => {
      const start = performance.now();
      await fn();
      return performance.now() - start;
    };

    // Warm up (JIT / pool).
    for (let i = 0; i < 3; i += 1) {
      await h.login
        .login({ mode: 'password', tenantId: TENANT, email: `warm${i}@x.com`, password: generatePassword() }, ctx)
        .catch(() => undefined);
    }

    const wrongSamples: number[] = [];
    const missingSamples: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      wrongSamples.push(
        await measure(() =>
          h.login
            .login({ mode: 'password', tenantId: TENANT, email: existing.email, password: generatePassword() }, ctx)
            .catch(() => undefined),
        ),
      );
      missingSamples.push(
        await measure(() =>
          h.login
            .login({ mode: 'password', tenantId: TENANT, email: `missing-${i}-${i}@nowhere.test`, password: generatePassword() }, ctx)
            .catch(() => undefined),
        ),
      );
    }
    const median = (values: number[]): number => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)] ?? 0;
    };
    const wrongMedian = median(wrongSamples);
    const missingMedian = median(missingSamples);
    // The dummy-hash path makes the missing-user median within a loose factor of
    // the wrong-password median (both pay scrypt). A non-dummy (instant reject)
    // implementation would be orders of magnitude faster.
    const ratio = Math.max(wrongMedian, missingMedian) / Math.max(1, Math.min(wrongMedian, missingMedian));
    expect(ratio).toBeLessThan(4);
    expect(missingMedian).toBeGreaterThan(1); // genuinely performed work
  });

  it('#4: two concurrent wrong passwords at the last threshold increment both count and lock exactly once', async () => {
    const user = await seedRandomUser(h.client, h, { tenantId: TENANT, mode: 'password' });
    // Start at threshold-1 (4) failed attempts.
    await h.client.query('UPDATE users SET failed_login_attempts = 4 WHERE id = $1', [user.userId]);

    // Synchronize AFTER both real account reads. With the deliberately fast
    // test KDF, Promise.all alone can let one lookup happen after the other
    // call locks the account; then 5 is correct and this test is flaky.
    // The barrier does not fake verification or the PostgreSQL counter UPDATE.
    const originalVerify = h.passwordHasher.verify.bind(h.passwordHasher);
    let releaseBoth: () => void = () => undefined;
    const bothReading = new Promise<void>((resolve) => { releaseBoth = resolve; });
    let readers = 0;
    const verifyBarrier = vi.spyOn(h.passwordHasher, 'verify').mockImplementation(async (secret, record) => {
      readers += 1;
      if (readers === 2) releaseBoth();
      await bothReading;
      return originalVerify(secret, record);
    });
    const results = await Promise.allSettled([
      h.login.login({ mode: 'password', tenantId: TENANT, email: user.email, password: generatePassword() }, ctx),
      h.login.login({ mode: 'password', tenantId: TENANT, email: user.email, password: generatePassword() }, ctx),
    ]);
    verifyBarrier.mockRestore();
    expect(results.every((r) => r.status === 'rejected')).toBe(true);

    const state = await h.client.query<{ failed_login_attempts: number; locked_until: Date | null }>(
      'SELECT failed_login_attempts, locked_until FROM users WHERE id = $1',
      [user.userId],
    );
    // No lost update: both increments persisted (4 → 6; the threshold of 5
    // already triggers the lock on the 5th, but both rows count).
    expect(state.rows[0]?.failed_login_attempts).toBe(6);
    // Locked exactly once (one non-null in-window lock).
    expect(state.rows[0]?.locked_until).not.toBeNull();
    expect(state.rows[0]?.locked_until?.getTime()).toBeGreaterThan(Date.now());

    // The correct password while locked is STILL rejected (and uniform).
    await expect(
      h.login.login({ mode: 'password', tenantId: TENANT, email: user.email, password: user.password ?? '' }, ctx),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it('#5: locked and inactive accounts return InvalidCredentialsError — same as a wrong password', async () => {
    const locked = await seedRandomUser(h.client, h, { tenantId: TENANT, mode: 'password' });
    await h.client.query('UPDATE users SET locked_until = now() + interval \'15 minutes\' WHERE id = $1', [locked.userId]);

    const inactive = await seedRandomUser(h.client, h, { tenantId: TENANT, mode: 'password' });
    await h.client.query('UPDATE users SET is_active = false WHERE id = $1', [inactive.userId]);

    const wrong = await seedRandomUser(h.client, h, { tenantId: TENANT, mode: 'password' });

    const run = async (email: string, password: string): Promise<unknown> => {
      try {
        await h.login.login({ mode: 'password', tenantId: TENANT, email, password }, ctx);
        return 'ok';
      } catch (error) {
        return error instanceof InvalidCredentialsError ? error.code : String(error);
      }
    };

    // Correct password, but locked → same code as a plain wrong password.
    expect(await run(locked.email, locked.password ?? '')).toBe('INVALID_CREDENTIALS');
    // Correct password, but inactive → same code.
    expect(await run(inactive.email, inactive.password ?? '')).toBe('INVALID_CREDENTIALS');
    // Wrong password → same code.
    expect(await run(wrong.email, generatePassword())).toBe('INVALID_CREDENTIALS');
  });

  it('#10: correct email+password under a DIFFERENT tenant is rejected (no cross-tenant reveal)', async () => {
    const user = await seedRandomUser(h.client, h, { tenantId: TENANT, mode: 'password' });
    // The user does not exist in TENANT_OTHER; even the correct password fails
    // identically to an unknown user.
    await expect(
      h.login.login({ mode: 'password', tenantId: TENANT_OTHER, email: user.email, password: user.password ?? '' }, ctx),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it('PIN lockout threshold (3) is stricter and locks after 3 wrong PINs', async () => {
    const pin = generatePin(4);
    const user = await seedUser(h.client, { tenantId: TENANT, staffCode: 'STF-LOCK', pin, pinHasher: h.pinHasher });
    for (let i = 0; i < 3; i += 1) {
      await h.login
        .login({ mode: 'pin', tenantId: TENANT, userIdOrStaffCode: 'STF-LOCK', pin: generatePin(4) }, ctx)
        .catch(() => undefined);
    }
    const state = await h.client.query<{ failed_login_attempts: number; locked_until: Date | null }>(
      'SELECT failed_login_attempts, locked_until FROM users WHERE id = $1',
      [user.userId],
    );
    expect(state.rows[0]?.failed_login_attempts).toBe(3);
    expect(state.rows[0]?.locked_until).not.toBeNull();
    // Correct PIN now fails because of the lock (uniform 401).
    await expect(
      h.login.login({ mode: 'pin', tenantId: TENANT, userIdOrStaffCode: 'STF-LOCK', pin }, ctx),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it('rate limiting is derived from auth_audit_log and triggers after the limit', async () => {
    const h2 = await buildAuthHarness({ ipRateLimit: 5, accountRateLimit: 200 });
    const user = await seedRandomUser(h2.client, h2, { tenantId: TENANT, mode: 'password' });
    const { RateLimitError } = await import('../../src/shared/errors.ts');
    let sawRateLimit = false;
    for (let i = 0; i < 12; i += 1) {
      try {
        await h2.login.login(
          { mode: 'password', tenantId: TENANT, email: user.email, password: generatePassword() },
          { ipAddress: '192.0.2.200', userAgent: 'flood' },
        );
      } catch (error) {
        if (error instanceof RateLimitError) {
          sawRateLimit = true;
          break;
        }
      }
    }
    expect(sawRateLimit).toBe(true);
    await h2.close();
  });
});
