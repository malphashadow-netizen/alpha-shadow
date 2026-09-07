import type { CurrencyCode, Money } from '../../shared/money.ts';

export interface ExchangeRateRecord {
  readonly tenantId: string;
  readonly fromCurrency: CurrencyCode;
  readonly toCurrency: CurrencyCode;
  /** PostgreSQL NUMERIC(18,8) text — never a number. */
  readonly rate: string;
  readonly effectiveAt: Date;
}

export interface ExchangeRateRepository {
  findAtOrBefore(
    tenantId: string,
    fromCurrency: CurrencyCode,
    toCurrency: CurrencyCode,
    transactionTime: Date,
  ): Promise<ExchangeRateRecord | null>;
  append(
    tenantId: string,
    fromCurrency: CurrencyCode,
    toCurrency: CurrencyCode,
    rate: string,
    effectiveAt: Date,
  ): Promise<void>;
}

export interface CurrencyRepository {
  findMinorUnitDigits(tenantId: string, currency: CurrencyCode): Promise<number | null>;
}

export interface ReportingCurrencyRepository {
  findReportingCurrency(tenantId: string): Promise<CurrencyCode | null>;
}

export interface CurrencyConversionService {
  convert(
    tenantId: string,
    amount: Money,
    targetCurrency: CurrencyCode,
    transactionTime: Date,
  ): Promise<Money>;
}
