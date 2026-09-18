import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';

import { connectTestClient } from '../support/database.ts';

const SEEDED_TENANT = '11111111-1111-4111-8111-111111111111';
const PURPOSES = [
  'inventory_asset',
  'cost_of_goods_in_process',
  'cost_of_goods_sold',
  'waste_expense',
  'purchase_price_variance',
  'inventory_variance',
] as const;

interface CountRow {
  readonly count: string;
}

interface TenantRow {
  readonly id: string;
}

interface BranchRow {
  readonly id: string;
}

interface RateRow {
  readonly rate_source: string | null;
}

interface SystemUserRow {
  readonly is_active: boolean;
  readonly is_system_accounting_user: boolean;
}

function sqlState(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = error.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

describe('DD-005 phase 0 accounting foundation', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = await connectTestClient();
  });

  afterAll(async () => {
    await client?.end();
  });

  async function createTenant(name: string): Promise<string> {
    const result = await client.query<TenantRow>(
      'INSERT INTO tenants (name) VALUES ($1) RETURNING id',
      [name],
    );
    const tenantId = result.rows[0]?.id;
    if (tenantId === undefined) {
      throw new Error('tenant insert did not return an id');
    }
    return tenantId;
  }

  async function setTenant(tenantId: string): Promise<void> {
    await client.query<CountRow>('SELECT set_config($1, $2, false)', [
      'app.current_tenant_id',
      tenantId,
    ]);
  }

  async function createBranch(tenantId: string): Promise<string> {
    await setTenant(tenantId);
    const result = await client.query<BranchRow>(
      `INSERT INTO branches (tenant_id, name, base_currency, timezone, country_code)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [tenantId, 'DD-005 test branch', 'SAR', 'UTC', 'SA'],
    );
    const branchId = result.rows[0]?.id;
    if (branchId === undefined) {
      throw new Error('branch insert did not return an id');
    }
    return branchId;
  }

  it('seeds each DD-005 account purpose exactly once for every existing tenant', async () => {
    await setTenant(SEEDED_TENANT);
    for (const purpose of PURPOSES) {
      const result = await client.query<CountRow>(
        `SELECT count(*)::text AS count
         FROM accounts
         WHERE tenant_id = $1 AND system_purpose = $2`,
        [SEEDED_TENANT, purpose],
      );
      expect(result.rows[0]?.count).toBe('1');
    }
  });

  it('records foreign-currency cash fixed rates as till_manual', async () => {
    const tenantId = await createTenant('dd005-rate-source');
    const branchId = await createBranch(tenantId);
    const result = await client.query<RateRow>(
      `INSERT INTO payment_methods
         (tenant_id, branch_id, name, type, currency_code, fixed_exchange_rate)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING fixed_exchange_rate`,
      [tenantId, branchId, 'USD cash', 'foreign_currency_cash', 'USD', '3.75000000'],
    );
    expect(result.rows).toHaveLength(1);
    const rate = await client.query<RateRow>(
      `SELECT rate_source
       FROM exchange_rates
       WHERE tenant_id = $1 AND from_currency = $2 AND to_currency = $3`,
      [tenantId, 'USD', 'SAR'],
    );
    expect(rate.rows).toHaveLength(1);
    expect(rate.rows[0]?.rate_source).toBe('till_manual');
  });

  it('automatically seeds payment, DD-005, and disabled system-user records for a new tenant', async () => {
    const tenantId = await createTenant('dd005-dynamic-seed');
    await setTenant(tenantId);
    const paymentAccounts = await client.query<CountRow>(
      `SELECT count(*)::text AS count
       FROM accounts
       WHERE tenant_id = $1 AND code IN ('1000', '1100', '4000')`,
      [tenantId],
    );
    expect(paymentAccounts.rows[0]?.count).toBe('3');
    for (const purpose of PURPOSES) {
      const accounts = await client.query<CountRow>(
        `SELECT count(*)::text AS count
         FROM accounts
         WHERE tenant_id = $1 AND system_purpose = $2`,
        [tenantId, purpose],
      );
      expect(accounts.rows[0]?.count).toBe('1');
    }
    const systemUsers = await client.query<SystemUserRow>(
      `SELECT is_active, is_system_accounting_user
       FROM users
       WHERE tenant_id = $1 AND is_system_accounting_user`,
      [tenantId],
    );
    expect(systemUsers.rows).toEqual([
      { is_active: false, is_system_accounting_user: true },
    ]);
  });

  it('enforces branch currency and rate-source constraints while accepting NULL provenance', async () => {
    const tenantId = await createTenant('dd005-constraints');
    await setTenant(tenantId);
    await expect(
      client.query<BranchRow>(
        `INSERT INTO branches (tenant_id, name, base_currency, timezone, country_code)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [tenantId, 'Invalid currency', 'ZZZ', 'UTC', 'SA'],
      ),
    ).rejects.toSatisfy((error: unknown) => sqlState(error) === '23503');
    await expect(
      client.query<RateRow>(
        `INSERT INTO exchange_rates
           (tenant_id, from_currency, to_currency, rate, effective_at, rate_source)
         VALUES ($1, $2, $3, $4, now(), $5)
         RETURNING rate_source`,
        [tenantId, 'USD', 'SAR', '1.00000000', 'bogus'],
      ),
    ).rejects.toSatisfy((error: unknown) => sqlState(error) === '23514');
    const accepted = await client.query<RateRow>(
      `INSERT INTO exchange_rates
         (tenant_id, from_currency, to_currency, rate, effective_at, rate_source)
       VALUES ($1, $2, $3, $4, now(), NULL)
       RETURNING rate_source`,
      [tenantId, 'USD', 'SAR', '1.00000000'],
    );
    expect(accepted.rows[0]?.rate_source).toBeNull();
  });

  it('fails closed when a coded DD-005 account loses its required purpose', async () => {
    const tenantId = await createTenant('dd005-closed-seed');
    await setTenant(tenantId);
    await client.query<CountRow>(
      `UPDATE accounts
       SET system_purpose = NULL
       WHERE tenant_id = $1 AND code = '5000'`,
      [tenantId],
    );
    await expect(
      client.query<CountRow>('SELECT seed_tenant_dd005_accounts($1)', [tenantId]),
    ).rejects.toSatisfy((error: unknown) => sqlState(error) === 'P0001');
  });
});
