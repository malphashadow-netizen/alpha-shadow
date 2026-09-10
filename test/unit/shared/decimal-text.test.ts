/**
 * Unit tests for the canonical decimal-text ↔ minor-unit bridge
 * (src/shared/decimal-text.ts) — the ONE place PostgreSQL NUMERIC text
 * crosses into the BigInt world.
 */
import { describe, expect, it } from 'vitest';
import {
  STORAGE_MAX_FRACTION_DIGITS,
  dbpsToPercentText,
  decimalTextToMinor,
  minorToDecimalText,
  nonNegativeDecimalTextToMinor,
  percentTextToDbps,
  storageMinorUnitDigits,
} from '../../../src/shared/decimal-text.ts';
import { ValidationError } from '../../../src/shared/errors.ts';
import { currencyCode, type CurrencyCode } from '../../../src/shared/money.ts';

describe('nonNegativeDecimalTextToMinor', () => {
  it('converts canonical 2-digit amounts exactly', () => {
    expect(nonNegativeDecimalTextToMinor('123.45', 2)).toBe(12345n);
    expect(nonNegativeDecimalTextToMinor('0.05', 2)).toBe(5n);
    expect(nonNegativeDecimalTextToMinor('100.00', 2)).toBe(10000n);
    expect(nonNegativeDecimalTextToMinor('0', 2)).toBe(0n);
  });

  it('re-scales a 2-decimal column value into a 3-digit currency', () => {
    // KWD base with a NUMERIC(18,2) stored value: 100.00 → 100.000 fils.
    expect(nonNegativeDecimalTextToMinor('100.00', 3)).toBe(100000n);
    expect(nonNegativeDecimalTextToMinor('0.05', 3)).toBe(50n);
  });

  it('rounds ONCE, half-to-even, when the fraction exceeds the target scale', () => {
    expect(nonNegativeDecimalTextToMinor('10.5555', 2)).toBe(1056n); // 1055.55 → 1056
    expect(nonNegativeDecimalTextToMinor('10.4455', 2)).toBe(1045n); // 1044.55 → 1045 (half-even toward even 1044? 1044.55 nearer 1045)
    expect(nonNegativeDecimalTextToMinor('0.005', 2)).toBe(0n); // banker's: 0.5 → 0 (even)
    expect(nonNegativeDecimalTextToMinor('0.015', 2)).toBe(2n); // banker's: 1.5 → 2 (even)
  });

  it('rejects negatives, exponents, NaN and garbage (fail-closed)', () => {
    expect(() => nonNegativeDecimalTextToMinor('-5.00', 2)).toThrow(ValidationError);
    expect(() => nonNegativeDecimalTextToMinor('1e2', 2)).toThrow(ValidationError);
    expect(() => nonNegativeDecimalTextToMinor('NaN', 2)).toThrow(ValidationError);
    expect(() => nonNegativeDecimalTextToMinor('1.2.3', 2)).toThrow(ValidationError);
    expect(() => nonNegativeDecimalTextToMinor('', 2)).toThrow(ValidationError);
    expect(() => nonNegativeDecimalTextToMinor('01.00', 2)).toThrow(ValidationError);
    expect(() => nonNegativeDecimalTextToMinor('1.00', 9)).toThrow(ValidationError);
  });
});

describe('decimalTextToMinor / minorToDecimalText', () => {
  it('handles negative values symmetrically', () => {
    expect(decimalTextToMinor('-12.34', 2)).toBe(-1234n);
    expect(minorToDecimalText(-1234n, 2)).toBe('-12.34');
  });

  it('round-trips exactly', () => {
    for (const [text, digits] of [['87.50', 2], ['0.01', 2], ['999999999.99', 2], ['12.3456', 4]] as const) {
      expect(minorToDecimalText(nonNegativeDecimalTextToMinor(text, digits), digits)).toBe(text);
    }
  });

  it('formats with exactly the requested fraction digits', () => {
    expect(minorToDecimalText(5n, 2)).toBe('0.05');
    expect(minorToDecimalText(12345n, 3)).toBe('12.345');
    expect(minorToDecimalText(7n, 0)).toBe('7');
  });
});

describe('percentTextToDbps / dbpsToPercentText', () => {
  it('converts percentages to discount basis points exactly (≤ 4 decimals)', () => {
    expect(percentTextToDbps('15.00')).toBe(150000n);
    expect(percentTextToDbps('12.3456')).toBe(123456n);
    expect(percentTextToDbps('100')).toBe(1000000n);
    expect(percentTextToDbps('0.0001')).toBe(1n);
  });

  it('rejects more than 4 decimals — a percentage is never silently rounded', () => {
    expect(() => percentTextToDbps('12.34567')).toThrow(ValidationError);
    expect(() => percentTextToDbps('-1.00')).toThrow(ValidationError);
  });

  it('round-trips to canonical NUMERIC(18,4) text', () => {
    expect(dbpsToPercentText(123456n)).toBe('12.3456');
    expect(dbpsToPercentText(150000n)).toBe('15.0000');
    expect(dbpsToPercentText(1n)).toBe('0.0001');
  });
});

describe('storageMinorUnitDigits (B1: ISO scale is the only storage scale)', () => {
  it('returns the ISO 4217 minor-unit digits — the historic storage scale 2 is gone', () => {
    expect(STORAGE_MAX_FRACTION_DIGITS).toBe(4);
    expect(storageMinorUnitDigits(currencyCode('SAR'))).toBe(2);
    expect(storageMinorUnitDigits(currencyCode('USD'))).toBe(2);
    expect(storageMinorUnitDigits(currencyCode('KWD'))).toBe(3);
    expect(storageMinorUnitDigits(currencyCode('BHD'))).toBe(3);
    expect(storageMinorUnitDigits(currencyCode('JPY'))).toBe(0);
    expect(storageMinorUnitDigits(currencyCode('KRW'))).toBe(0);
  });

  it('accepts the widest ISO scales exactly (CLF/UYW at 4 fit NUMERIC(18,4) edge-to-edge)', () => {
    expect(storageMinorUnitDigits(currencyCode('CLF'))).toBe(4);
    expect(storageMinorUnitDigits(currencyCode('UYW'))).toBe(4);
  });

  it('fails closed on unknown codes — never a silent default scale', () => {
    expect(() => storageMinorUnitDigits('ZZZ' as CurrencyCode)).toThrow(ValidationError);
  });
});
