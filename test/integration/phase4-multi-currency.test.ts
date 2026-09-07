/**
 * Phase 4 live acceptance tests against PostgreSQL 18.
 *
 * These tests deliberately use a NOBYPASSRLS app_login role for application
 * operations. The owner connection is used only for disposable fixture setup,
 * catalog/privilege assertions, and teardown.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CurrencyConversionEngine } from '../../src/application/engines/reporting/currency-conversion-engine.ts';
import {
  PostgresAuditLogRepository,
  PostgresCurrencyRepository,
  PostgresExchangeRateRepository,
  PostgresReportingCurrencyRepository,
} from '../../src/infrastructure/db/repositories/index.ts';
import { createWithTenantContext, type WithTenantContext } from '../../src/infrastructure/db/tenant-context.ts';
import { MissingExchangeRateError } from '../../src/shared/errors.ts';
import { currencyCode, money } from '../../src/shared/money.ts';
import { testDatabaseUrl } from '../support/database.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const APP_LOGIN_PASSWORD = 'phase4-app-login-test';
const USD = currencyCode('USD');
const EUR = currencyCode('EUR');

async function configureTenant(client: pg.PoolClient, tenantId: string): Promise<void> {
  await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', tenantId]);
}

describe('Phase 4 live acceptance: FX history, audit snapshots, and RLS', () => {
  let ownerPool: pg.Pool;
  let appPool: pg.Pool;
  let withAppContext: WithTenantContext;
  let rates: PostgresExchangeRateRepository;
  let currencies: PostgresCurrencyRepository;
  let audit: PostgresAuditLogRepository;
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
      await owner.query('GRANT SELECT, INSERT ON audit_log TO app_login');
      await owner.query('REVOKE UPDATE, DELETE ON exchange_rates, audit_log FROM app_login');
      await owner.query(
        `INSERT INTO currencies (code, minor_unit_digits) VALUES ('USD', 2), ('EUR', 2), ('JPY', 0), ('SAR', 2)
         ON CONFLICT (code) DO UPDATE SET minor_unit_digits = EXCLUDED.minor_unit_digits`,
      );
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
    rates = new PostgresExchangeRateRepository({ withTenantContext: withAppContext });
    currencies = new PostgresCurrencyRepository({ withTenantContext: withAppContext });
    audit = new PostgresAuditLogRepository({ withTenantContext: withAppContext });
    const reportingCurrencies = new PostgresReportingCurrencyRepository({ withTenantContext: withAppContext });
    engine = new CurrencyConversionEngine({ exchangeRates: rates, currencies, reportingCurrencies });
  });

  beforeEach(async () => {
    const owner = await ownerPool.connect();
    try {
      await owner.query('TRUNCATE exchange_rates, audit_log');
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    await appPool?.end();
    await ownerPool?.end();
  });

  it('keeps an old report identical after a newer current rate is inserted', async () => {
    const transactionTime = new Date('2025-01-15T12:00:00.000Z');
    await rates.append(TENANT_A, USD, EUR, '0.90000000', new Date('2025-01-01T00:00:00.000Z'));
    const beforeCurrentRate = await engine.convert(TENANT_A, money(1000n, USD), EUR, transactionTime);

    await rates.append(TENANT_A, USD, EUR, '1.20000000', new Date('2025-02-01T00:00:00.000Z'));
    const afterCurrentRate = await engine.convert(TENANT_A, money(1000n, USD), EUR, transactionTime);

    expect(beforeCurrentRate.amountMinor).toBe(900n);
    expect(afterCurrentRate.amountMinor).toBe(900n);
  });

  it('converts only at report time to tenants.reporting_currency', async () => {
    await rates.append(TENANT_A, USD, currencyCode('SAR'), '3.75000000', new Date('2025-01-01T00:00:00.000Z'));
    const result = await engine.convertToReportingCurrency(
      TENANT_A,
      money(100n, USD),
      new Date('2025-01-15T00:00:00.000Z'),
    );
    expect(result.currency).toBe('SAR');
    expect(result.amountMinor).toBe(375n);
  });

  it('returns the same currency without any database query', async () => {
    // The engine branch is unit-proven; this live assertion also ensures the
    // exact Money identity is retained when wired beside real repositories.
    const amount = money(12345n, USD);
    await expect(engine.convert(TENANT_A, amount, USD, new Date('invalid'))).resolves.toBe(amount);
  });

  it('throws a clear error when no rate is effective by transaction time', async () => {
    await rates.append(TENANT_A, USD, EUR, '0.90000000', new Date('2025-02-01T00:00:00.000Z'));
    await expect(
      engine.convert(TENANT_A, money(1000n, USD), EUR, new Date('2025-01-15T00:00:00.000Z')),
    ).rejects.toBeInstanceOf(MissingExchangeRateError);
  });

  it('uses the centralized snapshot for users secrets and writes commercial audit_log only', async () => {
    await audit.append({
      tenantId: TENANT_A,
      userId: null,
      action: 'user.updated',
      resource: 'users:user-1',
      before: {
        id: 'user-1',
        email: 'cashier@example.test',
        password_hash: 'must-not-be-stored',
        pin_hash: 'must-not-be-stored-either',
      },
      after: { email: 'cashier-new@example.test', api_secret: 'also-hidden' },
    });

    const owner = await ownerPool.connect();
    try {
      const result = await owner.query<{ before: Record<string, unknown>; after: Record<string, unknown> }>(
        `SELECT "before", "after" FROM audit_log WHERE tenant_id = $1`,
        [TENANT_A],
      );
      expect(result.rowCount).toBe(1);
      expect(result.rows[0]?.before).toEqual({ id: 'user-1', email: 'cashier@example.test' });
      expect(result.rows[0]?.after).toEqual({ email: 'cashier-new@example.test' });
      expect(result.rows[0]?.before).not.toHaveProperty('password_hash');
      expect(result.rows[0]?.before).not.toHaveProperty('pin_hash');
    } finally {
      owner.release();
    }
  });

  it('RLS hides tenant A exchange_rates and audit_log rows from tenant B and rejects foreign writes', async () => {
    await rates.append(TENANT_A, USD, EUR, '0.90000000', new Date('2025-01-01T00:00:00.000Z'));
    await audit.append({
      tenantId: TENANT_A,
      userId: null,
      action: 'probe.created',
      resource: 'probe:1',
      before: null,
      after: { ok: true },
    });

    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await configureTenant(client, TENANT_B);
      expect((await client.query('SELECT * FROM exchange_rates')).rowCount).toBe(0);
      expect((await client.query('SELECT * FROM audit_log')).rowCount).toBe(0);
      await expect(
        client.query(
          `INSERT INTO exchange_rates (tenant_id, from_currency, to_currency, rate, effective_at)
           VALUES ($1, 'USD', 'EUR', '0.91', $2)`,
          [TENANT_A, new Date('2025-01-02T00:00:00.000Z')],
        ),
      ).rejects.toThrow(/row-level security/);
      await client.query('ROLLBACK');
      await client.query('DISCARD ALL');
    } finally {
      client.release();
    }

    const auditClient = await appPool.connect();
    try {
      await auditClient.query('BEGIN');
      await configureTenant(auditClient, TENANT_B);
      await expect(
        auditClient.query(
          `INSERT INTO audit_log (tenant_id, action, resource, "before", "after")
           VALUES ($1, 'probe', 'probe:1', '{}'::jsonb, '{}'::jsonb)`,
          [TENANT_A],
        ),
      ).rejects.toThrow(/row-level security/);
      await auditClient.query('ROLLBACK');
      await auditClient.query('DISCARD ALL');
    } finally {
      auditClient.release();
    }
  });

  it('append-only exchange_rates rejects UPDATE and DELETE at the database trigger boundary', async () => {
    await rates.append(TENANT_A, USD, EUR, '0.90000000', new Date('2025-01-01T00:00:00.000Z'));
    const owner = await ownerPool.connect();
    try {
      await expect(owner.query(`UPDATE exchange_rates SET rate = '1.10' WHERE tenant_id = $1`, [TENANT_A])).rejects.toThrow(/append-only/);
      await expect(owner.query('DELETE FROM exchange_rates WHERE tenant_id = $1', [TENANT_A])).rejects.toThrow(/append-only/);
    } finally {
      owner.release();
    }
  });

  it('database privileges reject UPDATE and DELETE on immutable audit_log for app_login', async () => {
    await audit.append({
      tenantId: TENANT_A,
      userId: null,
      action: 'probe.created',
      resource: 'probe:1',
      before: null,
      after: { ok: true },
    });

    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await configureTenant(client, TENANT_A);
      await expect(client.query('UPDATE audit_log SET action = $1', ['tampered'])).rejects.toThrow(/permission denied/);
      await client.query('ROLLBACK');
      await client.query('DISCARD ALL');
      await client.query('BEGIN');
      await configureTenant(client, TENANT_A);
      await expect(client.query('DELETE FROM audit_log')).rejects.toThrow(/permission denied/);
      await client.query('ROLLBACK');
      await client.query('DISCARD ALL');
    } finally {
      client.release();
    }
  });

  it('has the required NUMERIC(18,8), RLS, append-only trigger, and audit index', async () => {
    const owner = await ownerPool.connect();
    try {
      const numeric = await owner.query<{ data_type: string; numeric_precision: number; numeric_scale: number }>(
        `SELECT data_type, numeric_precision, numeric_scale
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'exchange_rates' AND column_name = 'rate'`,
      );
      expect(numeric.rows[0]).toMatchObject({ data_type: 'numeric', numeric_precision: 18, numeric_scale: 8 });

      const rls = await owner.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean; relname: string }>(
        `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
        [['exchange_rates', 'audit_log']],
      );
      expect(rls.rows).toHaveLength(2);
      expect(rls.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);

      const index = await owner.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_audit_log_tenant_timestamp'`,
      );
      expect(index.rows[0]?.indexdef).toContain('tenant_id, "timestamp" DESC');

      const trigger = await owner.query<{ tgname: string }>(
        `SELECT tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          WHERE c.relname = 'exchange_rates' AND NOT t.tgisinternal AND t.tgname = 'exchange_rates_append_only'`,
      );
      expect(trigger.rowCount).toBe(1);
    } finally {
      owner.release();
    }
  });
});
