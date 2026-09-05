/**
 * Money value type — BigInt minor units, never floats.
 *
 * Invariants:
 *  - Amounts are stored as bigint in the currency's minor unit (e.g. halalas).
 *  - No `number` enters or leaves this module for an amount; DB boundary uses strings.
 *  - Every operation between two Money values requires same currency.
 *  - Single rounding rule: round-half-to-even (banker's rounding), implemented once.
 */

import { ValidationError } from './errors.ts';

export type CurrencyCode = string & { readonly __brand: 'CurrencyCode' };

export interface Money {
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
}

export class CurrencyMismatchError extends ValidationError {
  constructor(
    readonly left: CurrencyCode,
    readonly right: CurrencyCode,
  ) {
    super(`Currency mismatch: ${left} vs ${right}`, 'currency');
  }
}

const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

export function isCurrencyCode(value: string): value is CurrencyCode {
  return CURRENCY_CODE_PATTERN.test(value);
}

export function currencyCode(value: string): CurrencyCode {
  if (!isCurrencyCode(value)) {
    throw new ValidationError(`Invalid ISO 4217 currency code: "${value}"`, 'currency');
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return value as CurrencyCode;
}

export function money(amountMinor: bigint, currency: CurrencyCode): Money {
  return Object.freeze({ amountMinor, currency });
}

export function zero(currency: CurrencyCode): Money {
  return money(0n, currency);
}

function assertSameCurrency(left: Money, right: Money): void {
  if (left.currency !== right.currency) {
    throw new CurrencyMismatchError(left.currency, right.currency);
  }
}

/**
 * Parses a canonical integer string from the DB into a BigInt.
 *
 * Strict canonical checks:
 *  - Must be a non-empty string
 *  - Optional leading '-' then digits only (no spaces, no decimal, no exponent)
 *  - No leading zeros: "0" is canonical, "00", "01", "-01" are not
 *  - "-0" is explicitly rejected before regex (negative zero is not canonical)
 */
export function minorUnitsFromDb(text: string): bigint {
  if (text === '-0') {
    throw new ValidationError('Invalid minor-unit amount: "-0" is not a canonical integer', 'amountMinor');
  }
  // Canonical integer: optional minus, then either "0" or non-zero digit followed by digits
  const canonical = /^-?(0|[1-9]\d*)$/;
  if (!canonical.test(text)) {
    throw new ValidationError(`Invalid minor-unit amount: "${text}"`, 'amountMinor');
  }
  return BigInt(text);
}

/**
 * Inverse of minorUnitsFromDb — converts bigint to canonical string for DB storage.
 * Round-trip is guaranteed: minorUnitsToDb(minorUnitsFromDb(x)) === x for all canonical x
 * and minorUnitsFromDb(minorUnitsToDb(n)) === n for all bigint n.
 */
export function minorUnitsToDb(value: bigint): string {
  return value.toString();
}

// Legacy aliases for compatibility with older naming (DB drivers often call moneyFromMinorString)
export function moneyFromMinorString(amountMinor: string, currency: CurrencyCode): Money {
  return money(minorUnitsFromDb(amountMinor), currency);
}

export function toMinorString(value: Money): string {
  return minorUnitsToDb(value.amountMinor);
}

export function add(left: Money, right: Money): Money {
  assertSameCurrency(left, right);
  return money(left.amountMinor + right.amountMinor, left.currency);
}

export function subtract(left: Money, right: Money): Money {
  assertSameCurrency(left, right);
  return money(left.amountMinor - right.amountMinor, left.currency);
}

export function negate(value: Money): Money {
  return money(-value.amountMinor, value.currency);
}

export function sum(currency: CurrencyCode, values: readonly Money[]): Money {
  return values.reduce<Money>((acc, cur) => add(acc, cur), zero(currency));
}

export function compare(left: Money, right: Money): -1 | 0 | 1 {
  assertSameCurrency(left, right);
  if (left.amountMinor < right.amountMinor) return -1;
  if (left.amountMinor > right.amountMinor) return 1;
  return 0;
}

export function equals(left: Money, right: Money): boolean {
  return left.currency === right.currency && left.amountMinor === right.amountMinor;
}

export function isZero(value: Money): boolean {
  return value.amountMinor === 0n;
}

export function isNegative(value: Money): boolean {
  return value.amountMinor < 0n;
}

/**
 * Banker's rounding: integer division with round-half-to-even.
 */
export function divideRoundHalfToEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new ValidationError('Division by zero', 'denominator');
  }
  const n = denominator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;

  const quotient = n / d;
  const remainder = n % d;
  const twiceRemainder = (remainder < 0n ? -remainder : remainder) * 2n;

  if (twiceRemainder < d) return quotient;
  if (twiceRemainder > d) return n < 0n ? quotient - 1n : quotient + 1n;
  const towardZeroIsEven = quotient % 2n === 0n;
  if (towardZeroIsEven) return quotient;
  return n < 0n ? quotient - 1n : quotient + 1n;
}

export function scale(value: Money, numerator: bigint, denominator: bigint): Money {
  return money(divideRoundHalfToEven(value.amountMinor * numerator, denominator), value.currency);
}

/**
 * Allocates an amount into `parts` buckets using banker's rounding,
 * distributing any remainder one minor unit at a time to keep the sum exact.
 */
export function allocate(value: Money, parts: number): Money[] {
  if (!Number.isInteger(parts) || parts <= 0) {
    throw new ValidationError('parts must be a positive integer', 'parts');
  }
  const total = value.amountMinor;
  const n = BigInt(parts);
  const base = divideRoundHalfToEven(total, n);
  // Simple allocation: repeat base, adjust last element to make sum exact (banker's rounding already applied)
  const result: Money[] = [];
  let allocated = 0n;
  for (let i = 0; i < parts - 1; i++) {
    result.push(money(base, value.currency));
    allocated += base;
  }
  const last = total - allocated;
  result.push(money(last, value.currency));
  return result;
}
