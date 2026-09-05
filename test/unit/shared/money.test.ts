import { describe, expect, it } from 'vitest';

import { ValidationError } from '../../../src/shared/errors.ts';
import {
  add,
  allocate,
  compare,
  currencyCode,
  divideRoundHalfToEven,
  equals,
  isNegative,
  isZero,
  minorUnitsFromDb,
  minorUnitsToDb,
  money,
  moneyFromMinorString,
  negate,
  scale,
  subtract,
  sum,
  zero,
} from '../../../src/shared/money.ts';

const SAR = currencyCode('SAR');
const USD = currencyCode('USD');

describe('shared/money — minorUnitsFromDb / minorUnitsToDb', () => {
  it('parses canonical integers', () => {
    expect(minorUnitsFromDb('0')).toBe(0n);
    expect(minorUnitsFromDb('123')).toBe(123n);
    expect(minorUnitsFromDb('-123')).toBe(-123n);
    expect(minorUnitsFromDb('999999999999999999999')).toBe(999999999999999999999n);
  });

  it('rejects "-0" explicitly before regex', () => {
    expect(() => minorUnitsFromDb('-0')).toThrow(ValidationError);
    try {
      minorUnitsFromDb('-0');
    } catch (e) {
      expect((e as ValidationError).field).toBe('amountMinor');
      expect((e as Error).message).toContain('-0');
    }
  });

  it('rejects leading zeros', () => {
    expect(() => minorUnitsFromDb('00')).toThrow(ValidationError);
    expect(() => minorUnitsFromDb('01')).toThrow(ValidationError);
    expect(() => minorUnitsFromDb('-01')).toThrow(ValidationError);
    expect(() => minorUnitsFromDb('007')).toThrow(ValidationError);
  });

  it('rejects spaces, decimal, exponent, plus sign, empty', () => {
    expect(() => minorUnitsFromDb('')).toThrow(ValidationError);
    expect(() => minorUnitsFromDb(' 123')).toThrow(ValidationError);
    expect(() => minorUnitsFromDb('123 ')).toThrow(ValidationError);
    expect(() => minorUnitsFromDb('12.3')).toThrow(ValidationError);
    expect(() => minorUnitsFromDb('1e5')).toThrow(ValidationError);
    expect(() => minorUnitsFromDb('+123')).toThrow(ValidationError);
    expect(() => minorUnitsFromDb('12,345')).toThrow(ValidationError);
  });

  it('rejects non-numeric', () => {
    expect(() => minorUnitsFromDb('abc')).toThrow(ValidationError);
    expect(() => minorUnitsFromDb('12a')).toThrow(ValidationError);
  });

  it('round-trip is consistent', () => {
    const values = [0n, 1n, -1n, 12345678901234567890n, -987654321n];
    for (const v of values) {
      const s = minorUnitsToDb(v);
      expect(minorUnitsFromDb(s)).toBe(v);
      expect(s).toBe(v.toString());
    }
    const strings = ['0', '1', '-1', '999', '-999'];
    for (const s of strings) {
      expect(minorUnitsToDb(minorUnitsFromDb(s))).toBe(s);
    }
  });

  it('moneyFromMinorString creates Money', () => {
    const m = moneyFromMinorString('100', SAR);
    expect(m.amountMinor).toBe(100n);
    expect(m.currency).toBe(SAR);
  });

  it('moneyFromMinorString rejects -0', () => {
    expect(() => moneyFromMinorString('-0', SAR)).toThrow(ValidationError);
  });
});

describe('shared/money — bankers rounding', () => {
  it('divideRoundHalfToEven halves to even', () => {
    // 2.5 -> 2 (even), 3.5 -> 4 (even)
    expect(divideRoundHalfToEven(5n, 2n)).toBe(2n);
    expect(divideRoundHalfToEven(7n, 2n)).toBe(4n);
    expect(divideRoundHalfToEven(1n, 2n)).toBe(0n); // 0.5 -> 0
    expect(divideRoundHalfToEven(3n, 2n)).toBe(2n); // 1.5 -> 2
  });

  it('negative halves to even', () => {
    expect(divideRoundHalfToEven(-5n, 2n)).toBe(-2n);
    expect(divideRoundHalfToEven(-7n, 2n)).toBe(-4n);
    expect(divideRoundHalfToEven(-1n, 2n)).toBe(0n);
    expect(divideRoundHalfToEven(-3n, 2n)).toBe(-2n);
  });

  it('exact halves with even quotient stay', () => {
    expect(divideRoundHalfToEven(4n, 2n)).toBe(2n);
    expect(divideRoundHalfToEven(6n, 2n)).toBe(3n);
  });

  it('non-half rounding', () => {
    expect(divideRoundHalfToEven(10n, 3n)).toBe(3n); // 3.333 -> 3
    expect(divideRoundHalfToEven(11n, 3n)).toBe(4n); // 3.666 -> 4
    expect(divideRoundHalfToEven(10n, 6n)).toBe(2n); // 1.666 ->2
  });

  it('division by zero throws', () => {
    expect(() => divideRoundHalfToEven(5n, 0n)).toThrow(ValidationError);
  });

  it('handles negative denominator', () => {
    expect(divideRoundHalfToEven(5n, -2n)).toBe(-2n);
    expect(divideRoundHalfToEven(-5n, -2n)).toBe(2n);
  });

  it('scale uses banker rounding', () => {
    const m = money(100n, SAR);
    expect(scale(m, 1n, 2n).amountMinor).toBe(50n);
    expect(scale(m, 3n, 2n).amountMinor).toBe(150n);
    // 100 * 1 / 3 = 33.333 -> 33
    expect(scale(m, 1n, 3n).amountMinor).toBe(33n);
    // 100 * 2 / 3 = 66.666 -> 67
    expect(scale(m, 2n, 3n).amountMinor).toBe(67n);
  });
});

describe('shared/money — arithmetic', () => {
  it('add/subtract with same currency', () => {
    const a = money(100n, SAR);
    const b = money(50n, SAR);
    expect(add(a, b).amountMinor).toBe(150n);
    expect(subtract(a, b).amountMinor).toBe(50n);
  });

  it('throws on currency mismatch', () => {
    const a = money(100n, SAR);
    const b = money(50n, USD);
    expect(() => add(a, b)).toThrow();
    expect(() => subtract(a, b)).toThrow();
    expect(() => compare(a, b)).toThrow();
  });

  it('negate, sum, equals, compare, isZero, isNegative', () => {
    const a = money(10n, SAR);
    expect(negate(a).amountMinor).toBe(-10n);
    expect(isZero(zero(SAR))).toBe(true);
    expect(isNegative(negate(a))).toBe(true);
    expect(equals(a, money(10n, SAR))).toBe(true);
    expect(equals(a, money(10n, USD))).toBe(false);
    expect(compare(a, money(20n, SAR))).toBe(-1);
    expect(compare(a, money(10n, SAR))).toBe(0);
    expect(compare(money(20n, SAR), a)).toBe(1);
  });

  it('zero creates frozen zero', () => {
    const z = zero(SAR);
    expect(z.amountMinor).toBe(0n);
    expect(Object.isFrozen(z)).toBe(true);
  });

  it('sum aggregates', () => {
    const vals = [money(10n, SAR), money(20n, SAR), money(30n, SAR)];
    expect(sum(SAR, vals).amountMinor).toBe(60n);
    expect(sum(SAR, []).amountMinor).toBe(0n);
  });

  it('allocate distributes', () => {
    const m = money(10n, SAR);
    const parts = allocate(m, 3);
    expect(parts).toHaveLength(3);
    const total = parts.reduce((acc, p) => acc + p.amountMinor, 0n);
    expect(total).toBe(10n);
  });

  it('allocate rejects invalid parts', () => {
    expect(() => allocate(money(10n, SAR), 0)).toThrow(ValidationError);
    expect(() => allocate(money(10n, SAR), -1)).toThrow(ValidationError);
    expect(() => allocate(money(10n, SAR), 1.5)).toThrow(ValidationError);
  });

  it('currencyCode validates ISO4217', () => {
    expect(currencyCode('SAR')).toBe('SAR');
    expect(() => currencyCode('sar')).toThrow(ValidationError);
    expect(() => currencyCode('SARR')).toThrow(ValidationError);
    expect(() => currencyCode('SA')).toThrow(ValidationError);
  });

  it('money is frozen', () => {
    const m = money(5n, SAR);
    expect(Object.isFrozen(m)).toBe(true);
  });

  it('large BigInt round-trip', () => {
    const big = 123456789012345678901234567890n;
    const s = minorUnitsToDb(big);
    expect(minorUnitsFromDb(s)).toBe(big);
  });

  it('negative large', () => {
    expect(minorUnitsFromDb('-12345678901234567890')).toBe(-12345678901234567890n);
  });

  it('rejects whitespace only', () => {
    expect(() => minorUnitsFromDb(' ')).toThrow(ValidationError);
    expect(() => minorUnitsFromDb('\n')).toThrow(ValidationError);
  });

  it('rejects leading plus', () => {
    expect(() => minorUnitsFromDb('+0')).toThrow(ValidationError);
  });

  it('scale with negative', () => {
    const m = money(-100n, SAR);
    expect(scale(m, 1n, 2n).amountMinor).toBe(-50n);
  });

  it('divide with large numbers', () => {
    expect(divideRoundHalfToEven(1000000000000000000n, 3n)).toBe(333333333333333333n);
  });
});
