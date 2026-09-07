/**
 * TAX ONLY: non-negative BigInt minor units, statutory round-half-UP.
 * Deliberately NOT money.ts's half-even FX rounding. Changing this rule
 * requires a legal review; it is not a configurable rounding preference.
 */
import { ValidationError } from './errors.ts';

export const MAX_TAX_MINOR_UNITS = 9_223_372_036_854_775_807n;
export const BASIS_POINT_DENOMINATOR = 10_000n;

export function assertTaxAmount(amount: bigint): void {
  if (typeof amount !== 'bigint' || amount < 0n || amount > MAX_TAX_MINOR_UNITS) {
    throw new ValidationError('Tax amounts must be non-negative BIGINT minor units within PostgreSQL int8 range', 'amountMinor');
  }
}
export function assertTaxRateBps(rateBps: number): void {
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10_000) {
    throw new ValidationError('rateBps must be an integer between 0 and 10000', 'rateBps');
  }
}
export function roundTaxHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) {
    throw new ValidationError('Tax half-up requires a non-negative numerator and positive denominator');
  }
  return numerator / denominator + ((numerator % denominator) * 2n >= denominator ? 1n : 0n);
}
export interface ComputedTaxAmount {
  readonly taxableAmountMinor: bigint;
  readonly taxAmountMinor: bigint;
}
export function calculateTaxAmount(amount: bigint, rateBps: number, inclusive: boolean): ComputedTaxAmount {
  assertTaxAmount(amount);
  assertTaxRateBps(rateBps);
  const bps = BigInt(rateBps);
  const tax = roundTaxHalfUp(amount * bps, BASIS_POINT_DENOMINATOR + (inclusive ? bps : 0n));
  return Object.freeze({ taxableAmountMinor: inclusive ? amount - tax : amount, taxAmountMinor: tax });
}

export interface InvoiceTaxShare {
  readonly id: string;
  readonly amountMinor: bigint;
}
/**
 * Round the group's exact sum ONCE, then allocate minor units by largest
 * remainder (ties: stable order-line UUID). Never sum individually rounded
 * tax lines for invoice_total. Caller groups by rate/inclusivity/currency.
 */
export function allocateInvoiceTax(shares: readonly InvoiceTaxShare[], rateBps: number, inclusive: boolean): ReadonlyMap<string, bigint> {
  assertTaxRateBps(rateBps);
  const bps = BigInt(rateBps);
  const denominator = BASIS_POINT_DENOMINATOR + (inclusive ? bps : 0n);
  let totalNumerator = 0n;
  let floors = 0n;
  const amounts = new Map<string, bigint>();
  const ranked = shares.map((share) => {
    assertTaxAmount(share.amountMinor);
    if (amounts.has(share.id)) throw new ValidationError('Duplicate invoice tax allocation key');
    const numerator = share.amountMinor * bps;
    const floor = numerator / denominator;
    amounts.set(share.id, floor);
    floors += floor;
    totalNumerator += numerator;
    return { id: share.id, remainder: numerator % denominator };
  }).sort((a, b) => a.remainder === b.remainder
    ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    : (a.remainder > b.remainder ? -1 : 1));
  let remaining = roundTaxHalfUp(totalNumerator, denominator) - floors;
  for (const share of ranked) {
    if (remaining === 0n) break;
    amounts.set(share.id, (amounts.get(share.id) ?? 0n) + 1n);
    remaining -= 1n;
  }
  return amounts;
}
