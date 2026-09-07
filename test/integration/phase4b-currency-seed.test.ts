/**
 * Phase 4b live acceptance: the seeded global `currencies` registry.
 *
 * Runs against the REAL PostgreSQL provisioned by the harness, with
 * migration 0007_seed_currencies.sql already applied. Every application read
 * and write goes through `withTenantContext()` — including the reads of the
 * global `currencies` table — and uses the NOBYPASSRLS `app_login` role. The
 * owner connection is used only for role/grant fixture setup and for clearing
 * the disposable `exchange_rates` fixtures.
 *
 * `currencies` is NEVER truncated or deleted here: it is reference data owned
 * by a migration, not test data. The suite only reads it.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CurrencyConversionEngine } from '../../src/application/engines/reporting/currency-conversion-engine.ts';
import {
  PostgresCurrencyRepository,
  PostgresExchangeRateRepository,
} from '../../src/infrastructure/db/repositories/index.ts';
import { createWithTenantContext, type WithTenantContext } from '../../src/infrastructure/db/tenant-context.ts';
import { currencyCode, ISO_4217_MINOR_UNITS, money, type Money } from '../../src/shared/money.ts';
import { testDatabaseUrl } from '../support/database.ts';

/** Probe tenant from test/support/seed.test.sql — dedicated to this file. */
const TENANT = '33333333-3333-4333-8333-333333333333';
const APP_LOGIN_PASSWORD = 'phase4-app-login-test';

/** The six base currencies migration 0007 is contracted to seed. */
const SEEDED_CURRENCIES = ['SAR', 'EGP', 'KWD', 'USD', 'AED', 'EUR'] as const;

const USD = currencyCode('USD');
const KWD = currencyCode('KWD');

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SEED_MIGRATION = join(REPO_ROOT, 'migrations', '0007_seed_currencies.sql');

interface CurrencyRow {
  readonly code: string;
  readonly minor_unit_digits: number;
}

/** Renders minor units as a decimal string at the given scale (assertion aid only). */
function formatMinor(amountMinor: bigint, digits: number): string {
  const negative = amountMinor < 0n;
  const absolute = (negative ? -amountMinor : amountMinor).toString().padStart(digits + 1, '0');
  const whole = absolute.slice(0, absolute.length - digits);
  const fraction = digits === 0 ? '' : `.${absolute.slice(absolute.length - digits)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

describe('Phase 4b live acceptance: seeded currencies registry and KWD 3-decimal conversion', () => {
  let ownerPool: pg.Pool;
  let appPool: pg.Pool;
  let withAppContext: WithTenantContext;
  let currencies: PostgresCurrencyRepository;
  let rates: PostgresExchangeRateRepository;
  let engine: CurrencyConversionEngine;

  beforeAll(async () => {
    ownerPool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 4 });
    const owner = await ownerPool.connect();
    try {
      await owner.query(
        `DO $$ BEGIN
           IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_login') THEN
             CREATE ROLE app_login LOGIN PASSWORD '${APP_LOGIN_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
           END IF;
         END $$;`,
      );
      await owner.query(
        `ALTER ROLE app_login WITH LOGIN PASSWORD '${APP_LOGIN_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      await owner.query('GRANT USAGE ON SCHEMA public TO app_login');
      await owner.query('GRANT SELECT ON tenants, currencies TO app_login');
      await owner.query('GRANT SELECT, INSERT ON exchange_rates TO app_login');
      // exchange_rates rows are disposable fixtures; `currencies` is migration
      // reference data and is deliberately never truncated or deleted here.
      await owner.query('TRUNCATE exchange_rates');
    } finally {
      owner.release();
    }

    const appUrl = new URL(testDatabaseUrl());
    appUrl.username = 'app_login';
    appUrl.password = APP_LOGIN_PASSWORD;
    appPool = new pg.Pool({ connectionString: appUrl.toString(), max: 5 });
    withAppContext = createWithTenantContext(
      { connect: async () => appPool.connect() },
      { verifyTenantExists: true },
    );
    currencies = new PostgresCurrencyRepository({ withTenantContext: withAppContext });
    rates = new PostgresExchangeRateRepository({ withTenantContext: withAppContext });
    engine = new CurrencyConversionEngine({ exchangeRates: rates, currencies });
  });

  afterAll(async () => {
    await appPool?.end();
    await ownerPool?.end();
  });

  /** Reads the whole global registry through withTenantContext (app role, SELECT only). */
  async function readRegistry(): Promise<CurrencyRow[]> {
    return withAppContext(TENANT, async (q) => {
      const result = await q.query<CurrencyRow>('SELECT code, minor_unit_digits FROM currencies ORDER BY code');
      return result.rows;
    });
  }

  it.each(SEEDED_CURRENCIES)(
    '%s exists in currencies with minor_unit_digits equal to ISO_4217_MINOR_UNITS',
    async (code) => {
      const stored = await currencies.findMinorUnitDigits(TENANT, currencyCode(code));
      expect(stored, `${code} is missing from the currencies registry after migration 0007`).not.toBeNull();
      expect(stored).toBe(ISO_4217_MINOR_UNITS[code]);
    },
  );

  it('stores KWD with three decimal digits (fils), not two', async () => {
    expect(await currencies.findMinorUnitDigits(TENANT, KWD)).toBe(3);
  });

  it('has no row anywhere in the registry that disagrees with ISO_4217_MINOR_UNITS', async () => {
    const rows = await readRegistry();

    expect(rows.length).toBeGreaterThanOrEqual(SEEDED_CURRENCIES.length);
    const mismatches = rows.filter((row) => row.minor_unit_digits !== ISO_4217_MINOR_UNITS[row.code]);
    expect(mismatches, `rows disagreeing with src/shared/money.ts: ${JSON.stringify(mismatches)}`).toEqual([]);
  });

  it('is idempotent: re-applying migration 0007 leaves every existing row untouched', async () => {
    const before = await readRegistry();

    // ON CONFLICT (code) DO NOTHING — a second application must be a no-op and
    // must never rewrite a stored minor_unit_digits.
    const owner = await ownerPool.connect();
    try {
      await owner.query(readFileSync(SEED_MIGRATION, 'utf8'));
    } finally {
      owner.release();
    }

    expect(await readRegistry()).toEqual(before);
  });

  describe('real USD → KWD conversion through the append-only rate ledger', () => {
    // 1 USD = 0.3065 KWD, effective before every transaction time used below.
    const RATE = '0.30650000';
    const EFFECTIVE_AT = new Date('2025-01-01T00:00:00.000Z');
    const TRANSACTION_TIME = new Date('2025-06-01T12:00:00.000Z');

    beforeAll(async () => {
      await rates.append(TENANT, USD, KWD, RATE, EFFECTIVE_AT);
    });

    it('seeds the rate through ExchangeRateRepository.append and resolves it historically', async () => {
      const stored = await rates.findAtOrBefore(TENANT, USD, KWD, TRANSACTION_TIME);
      expect(stored).not.toBeNull();
      expect(stored?.rate).toBe(RATE);
      expect(stored?.fromCurrency).toBe('USD');
      expect(stored?.toCurrency).toBe('KWD');
    });

    it('converts USD 1,000.00 to exactly KWD 306.500 (3 decimal digits)', async () => {
      // 100000 cents = USD 1000.00; 1000.00 × 0.3065 = KWD 306.500 = 306500 fils.
      const result: Money = await engine.convert(TENANT, money(100_000n, USD), KWD, TRANSACTION_TIME);

      expect(result.currency).toBe('KWD');
      expect(result.amountMinor).toBe(306_500n);
      expect(formatMinor(result.amountMinor, 3)).toBe('306.500');
      // Proof the 3-digit scale from the registry was actually applied: a
      // 2-digit (cents) scale would have produced 30650 minor units.
      expect(result.amountMinor).not.toBe(30_650n);
    });

    it('applies round-half-to-even at the third decimal, in both directions', async () => {
      // USD 1.00 × 0.3065 = KWD 0.30650 → 306.5 fils → 306 (even neighbour).
      const halfDown = await engine.convert(TENANT, money(100n, USD), KWD, TRANSACTION_TIME);
      expect(halfDown.amountMinor).toBe(306n);
      expect(formatMinor(halfDown.amountMinor, 3)).toBe('0.306');

      // USD 3.00 × 0.3065 = KWD 0.91950 → 919.5 fils → 920 (even neighbour).
      const halfUp = await engine.convert(TENANT, money(300n, USD), KWD, TRANSACTION_TIME);
      expect(halfUp.amountMinor).toBe(920n);
      expect(formatMinor(halfUp.amountMinor, 3)).toBe('0.920');

      // USD 0.05 × 0.3065 = KWD 0.015325 → 15.325 fils → 15 (below the half).
      const belowHalf = await engine.convert(TENANT, money(5n, USD), KWD, TRANSACTION_TIME);
      expect(belowHalf.amountMinor).toBe(15n);
      expect(formatMinor(belowHalf.amountMinor, 3)).toBe('0.015');
    });

    it('is exact for an amount with no rounding at all', async () => {
      // USD 2.00 × 0.3065 = KWD 0.613 exactly → 613 fils, no remainder.
      const exact = await engine.convert(TENANT, money(200n, USD), KWD, TRANSACTION_TIME);
      expect(exact.amountMinor).toBe(613n);
      expect(formatMinor(exact.amountMinor, 3)).toBe('0.613');
    });

    it('converts a negative (refund) amount with the same symmetric rounding', async () => {
      // USD -1.00 × 0.3065 → -306.5 fils → -306 (even neighbour, symmetric).
      const refund = await engine.convert(TENANT, money(-100n, USD), KWD, TRANSACTION_TIME);
      expect(refund.amountMinor).toBe(-306n);
      expect(formatMinor(refund.amountMinor, 3)).toBe('-0.306');
    });
  });
});
