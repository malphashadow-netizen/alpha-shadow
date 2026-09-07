import type {
  CurrencyConversionService,
  CurrencyRepository,
  ExchangeRateRepository,
} from '../../../domain/contracts/multi-currency.ts';
import { MissingExchangeRateError, NotFoundError, ValidationError } from '../../../shared/errors.ts';
import { convertMoneyAtRate, type CurrencyCode, type Money } from '../../../shared/money.ts';

export interface CurrencyConversionEngineDependencies {
  readonly exchangeRates: ExchangeRateRepository;
  readonly currencies: CurrencyRepository;
}

/**
 * Reporting-time currency conversion.
 *
 * The method intentionally receives transactionTime, not "now". The exchange
 * rate repository must resolve the latest row whose effective_at is <= that
 * timestamp. There is no inverse-rate fallback and no current-rate lookup.
 */
export class CurrencyConversionEngine implements CurrencyConversionService {
  private readonly exchangeRates: ExchangeRateRepository;
  private readonly currencies: CurrencyRepository;

  constructor(dependencies: CurrencyConversionEngineDependencies) {
    this.exchangeRates = dependencies.exchangeRates;
    this.currencies = dependencies.currencies;
  }

  async convert(
    tenantId: string,
    amount: Money,
    targetCurrency: CurrencyCode,
    transactionTime: Date,
  ): Promise<Money> {
    // This branch is deliberately before every repository call, including the
    // currencies lookup. Same-currency reporting is an exact identity operation.
    if (amount.currency === targetCurrency) return amount;

    if (Number.isNaN(transactionTime.getTime())) {
      throw new ValidationError('transactionTime must be a valid Date', 'transactionTime');
    }

    const rate = await this.exchangeRates.findAtOrBefore(
      tenantId,
      amount.currency,
      targetCurrency,
      transactionTime,
    );
    if (rate === null) {
      throw new MissingExchangeRateError(amount.currency, targetCurrency, transactionTime);
    }

    const sourceDigits = await this.currencies.findMinorUnitDigits(tenantId, amount.currency);
    const targetDigits = await this.currencies.findMinorUnitDigits(tenantId, targetCurrency);
    if (sourceDigits === null) {
      throw new NotFoundError(`Currency ${amount.currency} is not present in the currencies registry`);
    }
    if (targetDigits === null) {
      throw new NotFoundError(`Currency ${targetCurrency} is not present in the currencies registry`);
    }

    // All Money × rate multiplication and all rounding happen in this one
    // shared function. The engine never parses, divides, floats, or rounds.
    return convertMoneyAtRate(amount, rate.rate, targetCurrency, targetDigits, sourceDigits);
  }
}

export const ReportingCurrencyConversionEngine = CurrencyConversionEngine;
