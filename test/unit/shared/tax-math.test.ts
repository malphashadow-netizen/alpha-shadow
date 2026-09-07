import { describe, expect, it } from 'vitest';
import { allocateInvoiceTax, calculateTaxAmount, MAX_TAX_MINOR_UNITS, roundTaxHalfUp } from '../../../src/shared/tax-math.ts';
import { divideRoundHalfToEven } from '../../../src/shared/money.ts';

describe('statutory tax half-up, isolated from FX half-even', () => {
  it.each([
    [1000n, 1500, false, 1000n, 150n],
    [1150n, 1500, true, 1000n, 150n],
    [1000n, 1400, false, 1000n, 140n],
    [1050n, 500, true, 1000n, 50n],
    [10n, 500, false, 10n, 1n],
    [3n, 10000, true, 1n, 2n],
    [0n, 10000, false, 0n, 0n],
    [100000n, 0, true, 100000n, 0n],
    [9_007_199_254_740_993n, 1500, false, 9_007_199_254_740_993n, 1_351_079_888_211_149n],
  ])('amount=%s bps=%s inclusive=%s has manually precomputed base=%s tax=%s', (amount, bps, inclusive, taxable, tax) => {
    expect(calculateTaxAmount(amount, bps, inclusive)).toEqual({ taxableAmountMinor: taxable, taxAmountMinor: tax });
  });
  it('rounds UP at .5 but leaves all pre-existing FX behaviour unchanged', () => {
    expect(roundTaxHalfUp(5n, 2n)).toBe(3n);
    expect(divideRoundHalfToEven(5n, 2n)).toBe(2n);
    expect(roundTaxHalfUp(2499n, 1000n)).toBe(2n);
    expect(roundTaxHalfUp(2500n, 1000n)).toBe(3n);
  });
  it('never uses floating point even at the PostgreSQL BIGINT boundary', () => {
    expect(calculateTaxAmount(MAX_TAX_MINOR_UNITS, 10000, false).taxAmountMinor).toBe(MAX_TAX_MINOR_UNITS);
    expect(() => calculateTaxAmount(MAX_TAX_MINOR_UNITS + 1n, 0, false)).toThrow();
  });
  it.each([-1, 10001, 0.5, NaN, Infinity])('rejects invalid bps %s', (bps) => {
    expect(() => calculateTaxAmount(100n, bps, false)).toThrow();
  });
  it('refuses negative sales and invalid division', () => {
    expect(() => calculateTaxAmount(-1n, 1500, false)).toThrow();
    expect(() => roundTaxHalfUp(-1n, 2n)).toThrow();
    expect(() => roundTaxHalfUp(1n, 0n)).toThrow();
  });
  it('invoice_total rounds the sum ONCE and allocates deterministic residual units', () => {
    const shares = [{ id: 'b', amountMinor: 10n }, { id: 'a', amountMinor: 10n }];
    const result = allocateInvoiceTax(shares, 500, false);
    expect(result.get('a')).toBe(1n);
    expect(result.get('b')).toBe(0n);
    expect(allocateInvoiceTax([...shares].reverse(), 500, false)).toEqual(result);
  });
  it('allocates inclusive rounding without making any line net negative', () => {
    const result = allocateInvoiceTax([{ id: 'a', amountMinor: 1n }, { id: 'b', amountMinor: 1n }], 10000, true);
    expect([...result.values()]).toEqual([1n, 0n]);
  });
});
