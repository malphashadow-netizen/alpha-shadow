import { describe, expect, it } from 'vitest';

import { ValidationError } from '../../../src/shared/errors.ts';
import { convertMoneyAtRate, currencyCode, money } from '../../../src/shared/money.ts';

const USD = currencyCode('USD');
const JPY = currencyCode('JPY');
const BHD = currencyCode('BHD');

// These are executable acceptance tests for the one central Money × rate path.
describe('central FX arithmetic', () => {
  it('uses round-half-even for an exact half', () => {
    expect(convertMoneyAtRate(money(5n, USD), '1.25', USD, 2).amountMinor).toBe(6n);
    expect(convertMoneyAtRate(money(6n, USD), '1.25', USD, 2).amountMinor).toBe(8n);
    expect(convertMoneyAtRate(money(-5n, USD), '1.25', USD, 2).amountMinor).toBe(-6n);
  });

  it('converts source and target minor-unit scales using integer arithmetic', () => {
    expect(convertMoneyAtRate(money(100n, USD), '110', JPY, 0).amountMinor).toBe(110n);
    expect(convertMoneyAtRate(money(1000n, BHD), '100', JPY, 0, 3).amountMinor).toBe(100n);
    expect(convertMoneyAtRate(money(100n, JPY), '0.0091', USD, 2, 0).amountMinor).toBe(91n);
  });

  it('is deterministic for repeated identical inputs', () => {
    const outputs = Array.from({ length: 25 }, () => convertMoneyAtRate(money(12345n, USD), '0.87654321', BHD, 3).amountMinor);
    expect(new Set(outputs)).toEqual(new Set([108209n]));
  });

  it('rejects non-NUMERIC or over-precision rates before calculation', () => {
    expect(() => convertMoneyAtRate(money(1n, USD), '1e0', USD, 2)).toThrow(ValidationError);
    expect(() => convertMoneyAtRate(money(1n, USD), '1.000000001', USD, 2)).toThrow(ValidationError);
    expect(() => convertMoneyAtRate(money(1n, USD), '0', USD, 2)).toThrow(ValidationError);
    expect(() => convertMoneyAtRate(money(1n, USD), '1.2', USD, 2, 5)).toThrow(ValidationError);
  });
});
