/**
 * Money value type — BigInt minor units, never floats.
 *
 * Invariants:
 *  - Amounts are stored as bigint in the currency's minor unit (e.g. halalas
 *    for SAR = 2 decimal places, fils for BHD/KWD/OMR = 3 decimal places).
 *  - No `number` enters or leaves this module for an amount; DB boundary uses strings.
 *  - Every operation between two Money values requires same currency.
 *  - Single rounding rule: round-half-to-even (banker's rounding), implemented once.
 *  - `amountMinor` is bounded by `DEFAULT_MAX_MINOR_UNITS` (see `money`).
 *
 * Known gap (backlog): there is intentionally NO FX conversion function in
 * this module yet — converting one currency into another requires mid-market
 * rates + spread + date attribution and is tracked in docs/backlog.md.
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

/**
 * Base ISO 4217 currency → minor-unit scale (number of decimal digits).
 *
 * This is the single source of truth for currency validity AND rounding scale.
 * Only *active* codes are listed; historical/retired codes (AFA, BYR, CUC,
 * SLL, …) are deliberately absent so a retired currency cannot be minted by
 * accident. Extend here (and add a test) when a new currency is supported —
 * never loosen the regex alone.
 *
 * Values follow ISO 4217 (2024-08 list): 0 (no minor unit), 2 (most), 3
 * (BHD/IQD/JOD/KWD/LYD/OMR/TND), 4 (CLF/UYW) and funds (XAU etc. = 0).
 */
export const ISO_4217_MINOR_UNITS: Readonly<Record<string, number>> = Object.freeze({
  AED: 2,
  AFN: 2,
  ALL: 2,
  AMD: 2,
  ANG: 2,
  AOA: 2,
  ARS: 2,
  AUD: 2,
  AWG: 2,
  AZN: 2,
  BAM: 2,
  BBD: 2,
  BDT: 2,
  BGN: 2,
  BHD: 3,
  BIF: 0,
  BMD: 2,
  BND: 2,
  BOB: 2,
  BOV: 2,
  BRL: 2,
  BSD: 2,
  BTN: 2,
  BWP: 2,
  BYN: 2,
  BZD: 2,
  CAD: 2,
  CDF: 2,
  CHE: 2,
  CHF: 2,
  CHW: 2,
  CLF: 4,
  CLP: 0,
  CNY: 2,
  COP: 2,
  COU: 2,
  CRC: 2,
  CUP: 2,
  CVE: 2,
  CZK: 2,
  DJF: 0,
  DKK: 2,
  DOP: 2,
  DZD: 2,
  EGP: 2,
  ERN: 2,
  ETB: 2,
  EUR: 2,
  FJD: 2,
  FKP: 2,
  GBP: 2,
  GEL: 2,
  GHS: 2,
  GIP: 2,
  GMD: 2,
  GNF: 0,
  GTQ: 2,
  GYD: 2,
  HKD: 2,
  HNL: 2,
  HTG: 2,
  HUF: 2,
  IDR: 2,
  ILS: 2,
  INR: 2,
  IQD: 3,
  IRR: 2,
  ISK: 0,
  JMD: 2,
  JOD: 3,
  JPY: 0,
  KES: 2,
  KGS: 2,
  KHR: 2,
  KMF: 0,
  KPW: 2,
  KRW: 0,
  KWD: 3,
  KYD: 2,
  KZT: 2,
  LAK: 2,
  LBP: 2,
  LKR: 2,
  LRD: 2,
  LSL: 2,
  LYD: 3,
  MAD: 2,
  MDL: 2,
  MGA: 2,
  MKD: 2,
  MMK: 2,
  MNT: 2,
  MOP: 2,
  MRU: 2,
  MUR: 2,
  MVR: 2,
  MWK: 2,
  MXN: 2,
  MXV: 2,
  MYR: 2,
  MZN: 2,
  NAD: 2,
  NGN: 2,
  NIO: 2,
  NOK: 2,
  NPR: 2,
  NZD: 2,
  OMR: 3,
  PAB: 2,
  PEN: 2,
  PGK: 2,
  PHP: 2,
  PKR: 2,
  PLN: 2,
  PYG: 0,
  QAR: 2,
  RON: 2,
  RSD: 2,
  RUB: 2,
  RWF: 0,
  SAR: 2,
  SBD: 2,
  SCR: 2,
  SDG: 2,
  SEK: 2,
  SGD: 2,
  SHP: 2,
  SLE: 2,
  SOS: 2,
  SRD: 2,
  SSP: 2,
  STN: 2,
  SVC: 2,
  SYP: 2,
  SZL: 2,
  THB: 2,
  TJS: 2,
  TMT: 2,
  TND: 3,
  TOP: 2,
  TRY: 2,
  TTD: 2,
  TWD: 2,
  TZS: 2,
  UAH: 2,
  UGX: 0,
  USD: 2,
  USN: 2,
  UYI: 0,
  UYU: 2,
  UYW: 4,
  UZS: 2,
  VED: 2,
  VES: 2,
  VND: 0,
  VUV: 0,
  WST: 2,
  XAF: 0,
  XAG: 0,
  XAU: 0,
  XBA: 0,
  XBB: 0,
  XBC: 0,
  XBD: 0,
  XCD: 2,
  XDR: 0,
  XOF: 0,
  XPD: 0,
  XPF: 0,
  XPT: 0,
  XSU: 0,
  XTS: 0,
  XUA: 0,
  XXX: 0,
  YER: 2,
  ZAR: 2,
  ZMW: 2,
  ZWL: 2,
});

/**
 * Upper bound for `amountMinor` (1e18 minor units ≈ USD 10^10 with 2 decimals,
 * SAR 10^10 …) — a sanity cap against absurd/overflow-prone amounts. Keep it
 * configurable at construction time through the optional `maxMinorUnits`
 * argument of `money()`, and raise the default only via a reviewed change in
 * a future ADR.
 */
export const DEFAULT_MAX_MINOR_UNITS: bigint = 10n ** 18n;

export function isCurrencyCode(value: string): value is CurrencyCode {
  return CURRENCY_CODE_PATTERN.test(value) && Object.prototype.hasOwnProperty.call(ISO_4217_MINOR_UNITS, value);
}

export function currencyCode(value: string): CurrencyCode {
  if (!isCurrencyCode(value)) {
    throw new ValidationError(`Invalid ISO 4217 currency code: "${value}"`, 'currency');
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return value as CurrencyCode;
}

/** Decimal digits of the currency's minor unit (2 = two decimals, 0 = no decimals). */
export function minorUnitScale(currency: CurrencyCode): number {
  const scale = ISO_4217_MINOR_UNITS[currency];
  if (scale === undefined) {
    throw new ValidationError(`Currency "${currency}" is not an active ISO 4217 code`, 'currency');
  }
  return scale;
}

/**
 * Validates and freezes a Money value. Throws `ValidationError` when the
 * amount exceeds `maxMinorUnits` (default `DEFAULT_MAX_MINOR_UNITS`).
 */
export function money(amountMinor: bigint, currency: CurrencyCode, maxMinorUnits: bigint = DEFAULT_MAX_MINOR_UNITS): Money {
  if (amountMinor > maxMinorUnits || amountMinor < -maxMinorUnits) {
    throw new ValidationError(
      `amountMinor out of range: ${amountMinor.toString()} exceeds ±${maxMinorUnits.toString()} minor units`,
      'amountMinor',
    );
  }
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

/**
 * Sums values in `currency`.
 *
 * BEHAVIOUR: this function verifies that EVERY element's currency equals the
 * requested `currency` and throws `CurrencyMismatchError` when any element
 * differs. It NEVER silently skips, converts or coerces a row — cross-currency
 * aggregation is a bug, and FX conversion is explicitly not available yet
 * (see docs/backlog.md). The seed `zero(currency)` is included so `sum` of an
 * empty array returns a zero Money of the requested currency.
 */
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
 * Allocates an amount into `parts` buckets using an exact, fair (Fowler-style)
 * distribution:
 *
 *   1. `base = trunc(total / parts)` (BigInt division towards zero).
 *   2. `remainder = total - base * parts` (same sign as total, |r| < parts).
 *   3. Each bucket gets `base`, and the first `|remainder|` buckets get ±1
 *      extra unit. Sum is always exactly `total`.
 *
 * Unlike a naive "round each share then fix the last bucket", the ±1 units are
 * spread over the leading buckets instead of concentrated into one, and the
 * order is deterministic — useful for per-row allocations (split a bill into
 * N items, N payers). Rounding itself remains banker's-half-even for the base
 * share; the remainder is handled by unit distribution, never by re-rounding.
 */
export function allocate(value: Money, parts: number): Money[] {
  if (!Number.isInteger(parts) || parts <= 0) {
    throw new ValidationError('parts must be a positive integer', 'parts');
  }
  const total = value.amountMinor;
  const n = BigInt(parts);
  const base = total / n; // BigInt division truncates toward zero
  const remainder = total - base * n;
  const sign = remainder < 0n ? -1n : 1n;
  const spread = remainder < 0n ? -remainder : remainder;

  const result: Money[] = [];
  for (let i = 0; i < parts; i++) {
    const extra = BigInt(i) < spread ? sign : 0n;
    result.push(money(base + extra, value.currency));
  }
  return result;
}
