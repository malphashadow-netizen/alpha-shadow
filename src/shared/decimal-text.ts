/**
 * Canonical decimal-text ↔ BigInt minor-unit conversion (Phase 8).
 *
 * The Phase-8 payments schema stores money in PostgreSQL NUMERIC columns
 * (NUMERIC(18,4)/(18,8) since B1 widened the (18,2) money columns to hold
 * every ISO 4217 scale natively). PostgreSQL returns NUMERIC
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
 *    every call site. For Phase-8 money-major storage the scale is ALWAYS
 *    storageMinorUnitDigits(currency) (the row currency's own ISO scale) —
 *    never a hardcoded 2 (B1: hardcoded 2 inflated KWD 10x, shrank JPY 100x).
 *  - When the fraction has more digits than the target scale, the value is
 *    rounded ONCE with round-half-to-even (banker's) — the same single
 *    rounding rule as shared/money.ts.
 */

import { ValidationError } from './errors.ts';
import { divideRoundHalfToEven, minorUnitScale, type CurrencyCode } from './money.ts';

const CANONICAL_DECIMAL = /^(0|[1-9]\d*)(?:\.(\d+))?$/;
const MAX_SCALE = 8;

/**
 * Maximum fraction digits the Phase-8 money-major storage columns hold
 * (NUMERIC(18,4) since migration 0044 — 4 is the largest ISO 4217 minor
 * scale of any active currency: CLF/UYW; every other active code is 0–3).
 */
export const STORAGE_MAX_FRACTION_DIGITS = 4;

/**
 * The storage scale for money-major values denominated in `currency`: the
 * currency's own ISO 4217 minor-unit digits (KWD → 3, SAR/USD → 2, JPY → 0).
 * The B1 boundary — every Phase-8 format/parse site states this explicitly
 * instead of a hardcoded 2, so non-2-decimal currencies round-trip exactly.
 * The STORAGE_MAX_FRACTION_DIGITS pin fails closed if the ISO table ever
 * gains a code the NUMERIC(18,4) columns cannot represent.
 */
export function storageMinorUnitDigits(currency: CurrencyCode): number {
  const digits = minorUnitScale(currency);
  if (digits > STORAGE_MAX_FRACTION_DIGITS) {
    throw new ValidationError(
      `Currency "${currency}" needs ${String(digits)} fraction digits; storage holds ${String(STORAGE_MAX_FRACTION_DIGITS)}`,
      'currency',
    );
  }
  return digits;
}

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
