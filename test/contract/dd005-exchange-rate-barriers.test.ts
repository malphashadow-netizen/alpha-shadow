import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

import { connectTestClient, testDatabaseUrl } from '../support/database.ts';

const ROLE_NAME = `app_login_dd005_${Math.floor(Math.random() * 1e9)}`;
const TENANT = '22222222-2222-4222-8222-222222222222';

interface RateRow {
  readonly id: string;
  readonly rate: string;
}

function sqlState(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = error.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

describe('DD-005 exchange-rate live barriers', () => {
  let appClient: pg.Client | undefined;
  let owner: pg.Client;

  beforeAll(async () => {
    const creator = await connectTestClient();
    try {
      await creator.query<RateRow>(
        `CREATE ROLE ${ROLE_NAME} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD 'ephemeral-test-only'`,
      );
      await creator.query<RateRow>(`GRANT USAGE ON SCHEMA public TO ${ROLE_NAME}`);
      await creator.query<RateRow>(`REVOKE ALL ON currencies, exchange_rates, audit_log FROM ${ROLE_NAME}`);
      await creator.query<RateRow>(`GRANT SELECT ON currencies TO ${ROLE_NAME}`);
      await creator.query<RateRow>(`GRANT SELECT, INSERT ON exchange_rates TO ${ROLE_NAME}`);
      await creator.query<RateRow>(`REVOKE UPDATE, DELETE ON exchange_rates FROM ${ROLE_NAME}`);
    } finally {
      await creator.end();
    }
    const url = new URL(testDatabaseUrl());
    url.username = ROLE_NAME;
    url.password = 'ephemeral-test-only';
    appClient = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 10_000 });
    await appClient.connect();
    owner = await connectTestClient();
  });

  afterAll(async () => {
    await appClient?.end().catch(() => undefined);
    await owner?.end();
    const dropper = await connectTestClient();
    try {
      await dropper.query<RateRow>(`DROP OWNED BY ${ROLE_NAME}`);
      await dropper.query<RateRow>(`DROP ROLE IF EXISTS ${ROLE_NAME}`);
    } finally {
      await dropper.end();
    }
  });

  it('denies UPDATE by privilege before append-only trigger execution', async () => {
    await appClient?.query<RateRow>('SELECT set_config($1, $2, false)', [
      'app.current_tenant_id',
      TENANT,
    ]);
    await expect(
      appClient?.query<RateRow>('UPDATE exchange_rates SET rate = rate'),
    ).rejects.toSatisfy((error: unknown) => sqlState(error) === '42501');
  });

  it('rejects owner mutation through the append-only trigger and preserves the rate', async () => {
    await owner.query<RateRow>('SELECT set_config($1, $2, false)', [
      'app.current_tenant_id',
      TENANT,
    ]);
    const inserted = await owner.query<RateRow>(
      `INSERT INTO exchange_rates (tenant_id, from_currency, to_currency, rate, effective_at)
       VALUES ($1, $2, $3, $4, now())
       RETURNING id, rate::text AS rate`,
      [TENANT, 'USD', 'SAR', '1.23450000'],
    );
    const row = inserted.rows[0];
    if (row === undefined) {
      throw new Error('exchange_rates INSERT returned no row');
    }
    const before = await owner.query<RateRow>(
      'SELECT id, rate::text AS rate FROM exchange_rates WHERE id = $1',
      [row.id],
    );
    if (before.rows[0] === undefined) {
      throw new Error('inserted exchange rate disappeared; phase4b TRUNCATE may have raced this test');
    }
    await expect(
      owner.query<RateRow>('UPDATE exchange_rates SET rate = $1 WHERE id = $2', [
        '9.99990000',
        row.id,
      ]),
    ).rejects.toSatisfy((error: unknown) => sqlState(error) === '55006');
    const after = await owner.query<RateRow>(
      'SELECT id, rate::text AS rate FROM exchange_rates WHERE id = $1',
      [row.id],
    );
    if (after.rows[0] === undefined) {
      throw new Error('inserted exchange rate disappeared; phase4b TRUNCATE may have raced this test');
    }
    expect(after.rows[0]?.rate).toBe(before.rows[0]?.rate);
  });
});
