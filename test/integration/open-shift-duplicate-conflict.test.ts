import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ShiftEngine } from '../../src/application/engines/shifts/shift-engine.ts';
import { createWithTenantContext, type WithTenantContext } from '../../src/infrastructure/db/tenant-context.ts';
import { PostgresShiftsStore } from '../../src/infrastructure/db/repositories/postgres-shifts-store.ts';
import { ConflictError } from '../../src/shared/errors.ts';
import { testDatabaseUrl } from '../support/database.ts';

describe('openShift duplicate-open-shift concurrency mapping', () => {
  let owner: pg.Pool;
  let withTenantContext: WithTenantContext;
  let shifts: ShiftEngine;
  let tenantId: string;
  let branchId: string;
  let cashierUserId: string;
  let openerUserId: string;
  let verifierUserId: string;

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: testDatabaseUrl(), max: 5 });
    withTenantContext = createWithTenantContext(owner, { verifyTenantExists: true });
    shifts = new ShiftEngine({
      store: new PostgresShiftsStore({ withTenantContext }),
      authorization: { check: async () => ({ allowed: true, effectiveMaxAmountMinorUnits: null }) },
    });
    tenantId = randomUUID();
    branchId = randomUUID();
    cashierUserId = randomUUID();
    openerUserId = randomUUID();
    verifierUserId = randomUUID();
    await owner.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [tenantId, 'open-shift-duplicate-conflict']);
    await owner.query(
      "INSERT INTO branches (id, tenant_id, name, base_currency, timezone, country_code) VALUES ($1, $2, 'concurrency branch', 'SAR', 'Asia/Riyadh', 'SA')",
      [branchId, tenantId],
    );
    await owner.query(
      `INSERT INTO users (id, tenant_id, email, password_hash) VALUES
        ($1, $4, $5, 'test-password-hash'),
        ($2, $4, $6, 'test-password-hash'),
        ($3, $4, $7, 'test-password-hash')`,
      [
        cashierUserId,
        openerUserId,
        verifierUserId,
        tenantId,
        `${cashierUserId}@example.test`,
        `${openerUserId}@example.test`,
        `${verifierUserId}@example.test`,
      ],
    );
  });

  afterAll(async () => {
    await owner?.end();
  });

  it('allows exactly one concurrent open and maps the partial-index violation to ConflictError', async () => {
    const input = {
      branchId,
      cashierUserId,
      openedByUserId: openerUserId,
      openVerifiedByUserId: verifierUserId,
      openedAt: new Date(),
      openCounts: [{ denominationValue: '100.00', quantity: 1 }],
    };

    const results = await Promise.allSettled([shifts.openShift(tenantId, input), shifts.openShift(tenantId, input)]);
    const fulfilled = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<ShiftEngine['openShift']>>> => result.status === 'fulfilled');
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(ConflictError);
    expect(rejected[0]?.reason).toMatchObject({ message: 'The cashier already holds an open shift (parallel shifts are forbidden)' });
  });
});
