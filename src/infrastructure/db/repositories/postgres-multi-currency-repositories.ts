/**
 * Tenant-safe repositories for Phase 4 currency data.
 *
 * No repository imports pg or receives a pool. Every statement is executed via
 * the injected withTenantContext transaction, so RLS remains the final
 * cross-tenant boundary even when a caller supplies a hostile tenant id.
 */
import type {
  CurrencyRepository,
  ExchangeRateRecord,
  ExchangeRateRepository,
} from '../../../domain/contracts/multi-currency.ts';
import type { CurrencyCode } from '../../../shared/money.ts';
import type { WithTenantContext } from '../tenant-context.ts';

interface ExchangeRateRow {
  readonly tenant_id: string;
  readonly from_currency: string;
  readonly to_currency: string;
  readonly rate: string;
  readonly effective_at: Date;
}

interface CurrencyRow {
  readonly code: string;
  readonly minor_unit_digits: number;
}

export interface PostgresMultiCurrencyRepositoryDependencies {
  readonly withTenantContext: WithTenantContext;
}

function mapExchangeRate(row: ExchangeRateRow): ExchangeRateRecord {
  return {
    tenantId: row.tenant_id,
    fromCurrency: row.from_currency as CurrencyCode,
    toCurrency: row.to_currency as CurrencyCode,
    rate: row.rate,
    effectiveAt: row.effective_at,
  };
}

export class PostgresExchangeRateRepository implements ExchangeRateRepository {
  private readonly withTenantContext: WithTenantContext;

  constructor(dependencies: PostgresMultiCurrencyRepositoryDependencies) {
    this.withTenantContext = dependencies.withTenantContext;
  }

  async findAtOrBefore(
    tenantId: string,
    fromCurrency: CurrencyCode,
    toCurrency: CurrencyCode,
    transactionTime: Date,
  ): Promise<ExchangeRateRecord | null> {
    return this.withTenantContext(tenantId, async (q) => {
      // The temporal predicate is part of the lookup contract, not an optional
      // caller filter. A future/current rate can never rewrite an old report.
      const result = await q.query<ExchangeRateRow>(
        `SELECT tenant_id, from_currency, to_currency, rate, effective_at
           FROM exchange_rates
          WHERE tenant_id = $1
            AND from_currency = $2
            AND to_currency = $3
            AND effective_at <= $4
          ORDER BY effective_at DESC
          LIMIT 1`,
        [tenantId, fromCurrency, toCurrency, transactionTime],
      );
      const row = result.rows[0];
      return row === undefined ? null : mapExchangeRate(row);
    });
  }

  async append(
    tenantId: string,
    fromCurrency: CurrencyCode,
    toCurrency: CurrencyCode,
    rate: string,
    effectiveAt: Date,
  ): Promise<void> {
    await this.withTenantContext(tenantId, async (q) => {
      await q.query(
        `INSERT INTO exchange_rates (tenant_id, from_currency, to_currency, rate, effective_at)
         VALUES ($1, $2, $3, $4::numeric, $5)`,
        [tenantId, fromCurrency, toCurrency, rate, effectiveAt],
      );
    });
  }
}

export class PostgresCurrencyRepository implements CurrencyRepository {
  private readonly withTenantContext: WithTenantContext;

  constructor(dependencies: PostgresMultiCurrencyRepositoryDependencies) {
    this.withTenantContext = dependencies.withTenantContext;
  }

  async findMinorUnitDigits(tenantId: string, currency: CurrencyCode): Promise<number | null> {
    // currencies is global reference data, but the query still runs inside the
    // tenant context so the repository has no alternate direct-DB path.
    return this.withTenantContext(tenantId, async (q) => {
      const result = await q.query<CurrencyRow>(
        'SELECT code, minor_unit_digits FROM currencies WHERE code = $1',
        [currency],
      );
      return result.rows[0]?.minor_unit_digits ?? null;
    });
  }
}
