import { describe, expect, it, vi } from 'vitest';

import { CurrencyConversionEngine } from '../../../../src/application/engines/reporting/currency-conversion-engine.ts';
import type {
  CurrencyRepository,
  ExchangeRateRecord,
  ExchangeRateRepository,
} from '../../../../src/domain/contracts/multi-currency.ts';
import { MissingExchangeRateError } from '../../../../src/shared/errors.ts';
import { currencyCode, money, type CurrencyCode } from '../../../../src/shared/money.ts';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USD = currencyCode('USD');
const EUR = currencyCode('EUR');
const JPY = currencyCode('JPY');

class FakeRates implements ExchangeRateRepository {
  readonly rows: ExchangeRateRecord[] = [];
  readonly findSpy = vi.fn();

  async findAtOrBefore(tenantId: string, fromCurrency: CurrencyCode, toCurrency: CurrencyCode, transactionTime: Date): Promise<ExchangeRateRecord | null> {
    this.findSpy(tenantId, fromCurrency, toCurrency, transactionTime);
    return (
      this.rows
        .filter(
          (row) =>
            row.tenantId === tenantId &&
            row.fromCurrency === fromCurrency &&
            row.toCurrency === toCurrency &&
            row.effectiveAt.getTime() <= transactionTime.getTime(),
        )
        .sort((left, right) => right.effectiveAt.getTime() - left.effectiveAt.getTime())[0] ?? null
    );
  }

  async append(
    tenantId: string,
    fromCurrency: CurrencyCode,
    toCurrency: CurrencyCode,
    rate: string,
    effectiveAt: Date,
  ): Promise<void> {
    this.rows.push({ tenantId, fromCurrency, toCurrency, rate, effectiveAt });
  }
}

class FakeCurrencies implements CurrencyRepository {
  readonly findSpy = vi.fn();
  async findMinorUnitDigits(_tenantId: string, currency: CurrencyCode): Promise<number | null> {
    this.findSpy(currency);
    return currency === JPY ? 0 : 2;
  }
}

function makeEngine(rates: FakeRates, currencies = new FakeCurrencies()): CurrencyConversionEngine {
  return new CurrencyConversionEngine({ exchangeRates: rates, currencies });
}

describe('CurrencyConversionEngine', () => {
  it('uses the rate effective at transaction time, not the current rate', async () => {
    const rates = new FakeRates();
    const engine = makeEngine(rates);
    const transactionTime = new Date('2025-01-10T00:00:00.000Z');
    await rates.append(TENANT, USD, EUR, '0.90000000', new Date('2025-01-01T00:00:00.000Z'));
    const beforeCurrentRate = await engine.convert(TENANT, money(1000n, USD), EUR, transactionTime);

    await rates.append(TENANT, USD, EUR, '1.20000000', new Date('2025-02-01T00:00:00.000Z'));
    const afterCurrentRate = await engine.convert(TENANT, money(1000n, USD), EUR, transactionTime);

    expect(beforeCurrentRate.amountMinor).toBe(900n);
    expect(afterCurrentRate.amountMinor).toBe(900n);
  });

  it('returns the exact same Money object without touching either repository', async () => {
    const rates = new FakeRates();
    const currencies = new FakeCurrencies();
    const amount = money(123n, USD);
    const result = await makeEngine(rates, currencies).convert(TENANT, amount, USD, new Date('invalid'));

    expect(result).toBe(amount);
    expect(rates.findSpy).not.toHaveBeenCalled();
    expect(currencies.findSpy).not.toHaveBeenCalled();
  });

  it('throws explicitly when no historical rate exists', async () => {
    const rates = new FakeRates();
    await expect(makeEngine(rates).convert(TENANT, money(100n, USD), EUR, new Date('2025-01-01T00:00:00.000Z'))).rejects.toBeInstanceOf(
      MissingExchangeRateError,
    );
  });

  it('does not infer an inverse rate', async () => {
    const rates = new FakeRates();
    await rates.append(TENANT, EUR, USD, '1.10000000', new Date('2025-01-01T00:00:00.000Z'));
    await expect(makeEngine(rates).convert(TENANT, money(100n, USD), EUR, new Date('2025-01-02T00:00:00.000Z'))).rejects.toBeInstanceOf(
      MissingExchangeRateError,
    );
  });

  it('rounds deterministically into a zero-decimal target', async () => {
    const rates = new FakeRates();
    await rates.append(TENANT, USD, JPY, '100.50000000', new Date('2025-01-01T00:00:00.000Z'));
    const result = await makeEngine(rates).convert(TENANT, money(100n, USD), JPY, new Date('2025-01-02T00:00:00.000Z'));
    // 100 cents × 1.005 JPY/USD = 100.5 JPY → 100, the even neighbour.
    expect(result.amountMinor).toBe(100n);
  });
});
