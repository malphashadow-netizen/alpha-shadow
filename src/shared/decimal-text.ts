/**
 * Canonical decimal-text ↔ BigInt minor-unit conversion (Phase 8).
 *
 * The Phase-8 payments schema stores money in PostgreSQL NUMERIC columns
 * (NUMERIC(18,2)/(18,4)/(18,8) per the closed spec). PostgreSQL returns NUMERIC
 * as exact decimal TEXT; this module is the ONE place that text crosses into
 * the engine's BigInt minor-unit world — no JavaScript number ever touches an
 * amount.
 *
 * Rules:
 *  - Input text must be a canonical plain decimal (optional '-', digits,
 *    optional '.' + digits). Exponents, 'NaN', 'Infinity' and whitespace are
 *    rejected — a numeric that somehow took that shape can never silently
 *    convert.
 *  - `digits` is the target minor-unit scale (0–8), stated EXPLICITLY at
 *    every call site (ISO currency scale for base-currency math; 2 for the
 *    spec's NUMERIC(18,2) payment columns).
 *  - When the fraction has more digits than the target scale, the value is
 *    rounded ONCE with round-half-to-even (banker's) — the same single
 *    rounding rule as shared/money.ts.
 */

import { ValidationError } from './errors.ts';
import { divideRoundHalfToEven } from './money.ts';

const CANONICAL_DECIMAL = /^(0|[1-9]\d*)(?:\.(\d+))?$/;
const MAX_SCALE = 8;

function mustMatch(text: string, field: string): RegExpExecArray {
  const match = CANONICAL_DECIMAL.exec(text);
  if (match === null) {
    throw new ValidationError(`Invalid canonical decimal amount: "${text}"`, field);
  }
  return match;
}

/**
 * Parses a canonical, NON-NEGATIVE decimal text into minor units at `digits`
 * scale. Negative amounts are rejected: every Phase-8 column this feeds
 * (amounts, change, floats, discounts, denominations) is non-negative by
 * CHECK; a minus sign reaching here is a bug, not a value.
 */
export function nonNegativeDecimalTextToMinor(text: string, digits: number, field = 'amount'): bigint {
  if (!Number.isInteger(digits) || digits < 0 || digits > MAX_SCALE) {
    throw new ValidationError(`digits must be an integer from 0 through ${String(MAX_SCALE)}`, 'digits');
  }
  const match = mustMatch(text, field);
  const integerPart = match[1] ?? '';
  const fractionPart = match[2] ?? '';
  const coefficient = BigInt(`${integerPart}${fractionPart}`);
  return divideRoundHalfToEven(coefficient * 10n ** BigInt(digits), 10n ** BigInt(fractionPart.length));
}

/** Parses a possibly-negative canonical decimal text into minor units at `digits` scale. */
export function decimalTextToMinor(text: string, digits: number, field = 'amount'): bigint {
  if (text.startsWith('-')) {
    return -nonNegativeDecimalTextToMinor(text.slice(1), digits, field);
  }
  return nonNegativeDecimalTextToMinor(text, digits, field);
}

/** Formats minor units as a canonical decimal text with exactly `digits` fraction digits. */
export function minorToDecimalText(minor: bigint, digits: number, _field = 'amount'): string {
  if (!Number.isInteger(digits) || digits < 0 || digits > MAX_SCALE) {
    throw new ValidationError(`digits must be an integer from 0 through ${String(MAX_SCALE)}`, 'digits');
  }
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  const scale = 10n ** BigInt(digits);
  const integerPart = absolute / scale;
  const fractionPart = absolute % scale;
  const fractionText = fractionPart.toString().padStart(digits, '0');
  const body = digits === 0 ? integerPart.toString() : `${integerPart.toString()}.${fractionText}`;
  return negative ? `-${body}` : body;
}

/**
 * Parses a discount percentage (NUMERIC(18,4) text, e.g. '12.3456') into an
 * integer count of discount basis points: 1 dbps = 1/10,000 of one percent.
 * '12.3456' → 123456n. The input scale is capped at 4 fraction digits — no
 * rounding is ever applied to a percentage.
 */
export function percentTextToDbps(text: string, field = 'discountValue'): bigint {
  const match = mustMatch(text, field);
  const integerPart = match[1] ?? '';
  const fractionPart = match[2] ?? '';
  if (fractionPart.length > 4) {
    throw new ValidationError(`Discount percentage has more than 4 decimal places: "${text}"`, field);
  }
  return BigInt(`${integerPart}${fractionPart.padEnd(4, '0')}`);
}

/** Formats discount basis points back to canonical NUMERIC(18,4) text. */
export function dbpsToPercentText(dbps: bigint): string {
  if (dbps < 0n) {
    throw new ValidationError('Discount basis points must be non-negative', 'discountValue');
  }
  const integerPart = dbps / 10_000n;
  const fractionPart = (dbps % 10_000n).toString().padStart(4, '0');
  return `${integerPart.toString()}.${fractionPart}`;
}
