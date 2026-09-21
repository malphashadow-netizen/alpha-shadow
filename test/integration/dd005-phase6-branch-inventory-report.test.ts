import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresExchangeRateRepository } from '../../src/infrastructure/db/repositories/postgres-multi-currency-repositories.ts';
import { createWithTenantContext, type WithTenantContext } from '../../src/infrastructure/db/tenant-context.ts';
import { currencyCode } from '../../src/shared/money.ts';
import { testDatabaseUrl } from '../support/database.ts';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_CURRENCY = currencyCode('USD');
const REPORTING_CURRENCY = currencyCode('SAR');
const CLOSING_TIME = new Date('2090-06-30T23:59:59.000Z');

describe('DD-005 phase 6 branch inventory reporting', () => {
  let pool: pg.Pool;
  let withTenantContext: WithTenantContext;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 2 });
    withTenantContext = createWithTenantContext(
      { connect: async () => pool.connect() },
      { verifyTenantExists: true },
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('uses only the direct market closing rate and exposes its effective date', async () => {
    const marketEffectiveAt = new Date('2090-06-30T18:00:00.000Z');

    await withTenantContext(TENANT_ID, async (q) => {
      await q.query(
        `INSERT INTO exchange_rates
           (tenant_id, from_currency, to_currency, rate, effective_at, rate_source)
         VALUES
           ($1, $2, $3, $4::numeric, $5, 'market'),
           ($1, $2, $3, $6::numeric, $7, 'till_manual')`,
        [
          TENANT_ID,
          BRANCH_CURRENCY,
          REPORTING_CURRENCY,
          '2.00000000',
          marketEffectiveAt,
          '9.00000000',
          new Date('2090-06-30T20:00:00.000Z'),
        ],
      );
    });

    const rates = new PostgresExchangeRateRepository({ withTenantContext });
    const closingRate = await rates.findAtOrBefore(
      TENANT_ID,
      BRANCH_CURRENCY,
      REPORTING_CURRENCY,
      CLOSING_TIME,
    );

    expect(closingRate).toMatchObject({
      fromCurrency: BRANCH_CURRENCY,
      toCurrency: REPORTING_CURRENCY,
      rate: '2.00000000',
      effectiveAt: marketEffectiveAt,
    });
  });
});
