/**
 * Phase-8 discount math — the BINDING order of calculation, as pure functions.
 *
 * The mandated pseudocode (spec 2, "ترتيب الحسابات — Pseudocode ملزم"):
 *
 *   1. subtotal           = SUM(order_items.price × qty)                 [active items]
 *   2. requested          = kind=='percentage' ? subtotal×value/100 : value
 *   3. applied            = MIN(requested, subtotal)
 *   4. IF applied >= subtotal            → manager override REQUIRED (always)
 *      ELSE IF requested > user's cap    → manager override REQUIRED
 *      (execution then needs a SUCCESSFUL Phase-7b manager_override_attempt)
 *   5. discounted_subtotal = subtotal − applied            (≥ 0 by construction)
 *   6. tax                 = the Phase-6 engine on discounted_subtotal
 *   7. total               = discounted_subtotal + tax (+ fees — none exist
 *      on `orders` today; see order-totals.ts)
 *   8. remaining_balance   = total − SUM(payments.amount_in_base_currency
 *      WHERE status='completed')
 *
 * Stacking (allow_discount_stacking = true): coupon → manual → points, with
 * steps 2–4 RE-RUN against the CURRENT remaining subtotal at every stage
 * (applyDiscountStages below). When stacking is disabled, the database
 * stacking trigger (migration 0034) rejects a second row outright.
 *
 * All arithmetic is BigInt minor units at the branch base currency's ISO
 * scale. The single percentage rounding is round-half-to-even (banker's) —
 * the same rule as every non-tax money operation in shared/money.ts; tax
 * keeps its own statutory half-up inside the Phase-6 engine, untouched.
 */

import { ValidationError } from '../../../shared/errors.ts';
import { divideRoundHalfToEven } from '../../../shared/money.ts';
import { nonNegativeDecimalTextToMinor, percentTextToDbps } from '../../../shared/decimal-text.ts';
import type { DiscountKind } from '../../../domain/contracts/payments.ts';

/** 1 percent expressed in discount basis points (1 dbps = 1/10,000 %). */
const DBPS_PER_PERCENT = 1_000_000n; // percent × dbps-to-minor factor: value% = dbps/10^6

/** A parsed discount request: integral, unit-safe. */
export interface ParsedDiscountRequest {
  readonly kind: DiscountKind;
  /** kind='percentage': the requested percentage in dbps (1/10,000 %). */
  readonly percentDbps: bigint | null;
  /** kind='fixed_amount': the requested amount in base-currency minor units. */
  readonly fixedAmountMinor: bigint | null;
}

/** The actor's effective per-user caps (NULL dimension = NOT granted). */
export interface ParsedDiscountCaps {
  readonly maxPercentDbps: bigint | null;
  readonly maxFixedAmountMinor: bigint | null;
}

export function parseDiscountRequest(kind: DiscountKind, valueText: string, baseMinorDigits: number): ParsedDiscountRequest {
  if (kind === 'percentage') {
    const dbps = percentTextToDbps(valueText);
    if (dbps <= 0n) throw new ValidationError('Discount percentage must be greater than zero', 'discountValue');
    if (dbps > 100n * 10_000n) throw new ValidationError('Discount percentage cannot exceed 100', 'discountValue');
    return { kind, percentDbps: dbps, fixedAmountMinor: null };
  }
  const minor = nonNegativeDecimalTextToMinor(valueText, baseMinorDigits, 'discountValue');
  if (minor <= 0n) throw new ValidationError('Discount amount must be greater than zero', 'discountValue');
  return { kind, percentDbps: null, fixedAmountMinor: minor };
}

export function parseDiscountCaps(
  maxPercentageText: string | null,
  maxFixedAmountText: string | null,
  baseMinorDigits: number,
): ParsedDiscountCaps {
  return {
    maxPercentDbps: maxPercentageText === null ? null : percentTextToDbps(maxPercentageText),
    maxFixedAmountMinor: maxFixedAmountText === null ? null : nonNegativeDecimalTextToMinor(maxFixedAmountText, baseMinorDigits, 'maxDiscountFixedAmount'),
  };
}

/** One stage of the binding pseudocode (steps 2, 3 and 5), against the CURRENT subtotal. */
export interface DiscountStageComputation {
  /** Step 2 — the raw requested discount (before capping). */
  readonly requestedMinor: bigint;
  /** Step 3 — applied = MIN(requested, subtotal): capping can NEVER go negative. */
  readonly appliedMinor: bigint;
  /** True when applied ≥ subtotal (this stage zeroes out the remaining subtotal). */
  readonly zeroesOutSubtotal: boolean;
  /** Step 5 — subtotal − applied (≥ 0 by construction). */
  readonly remainingSubtotalMinor: bigint;
}

/** Steps 2, 3 and 5 of the binding pseudocode against `remainingSubtotalMinor`. */
export function computeDiscountStage(remainingSubtotalMinor: bigint, request: ParsedDiscountRequest): DiscountStageComputation {
  if (remainingSubtotalMinor < 0n) {
    throw new ValidationError('Discount stage requires a non-negative remaining subtotal', 'subtotal');
  }
  const requestedMinor =
    request.kind === 'percentage'
      ? divideRoundHalfToEven(remainingSubtotalMinor * (request.percentDbps ?? 0n), DBPS_PER_PERCENT)
      : (request.fixedAmountMinor ?? 0n);
  if (requestedMinor <= 0n) {
    throw new ValidationError('The requested discount must be greater than zero minor units', 'discountValue');
  }
  const appliedMinor = requestedMinor < remainingSubtotalMinor ? requestedMinor : remainingSubtotalMinor;
  return {
    requestedMinor,
    appliedMinor,
    zeroesOutSubtotal: appliedMinor >= remainingSubtotalMinor,
    remainingSubtotalMinor: remainingSubtotalMinor - appliedMinor,
  };
}

export type DiscountOverrideReason =
  | 'zeroes_out_subtotal'
  | 'exceeds_matching_cap'
  | 'exceeds_cross_equivalent_cap'
  | 'both';

/**
 * Step 4 of the binding pseudocode — the DUAL-cap gate:
 *   IF applied ≥ subtotal → override REQUIRED, ALWAYS (zeroing out escalates
 *   unconditionally, even when the requested amount is inside the cap);
 *   ELSE IF requested > the actor's cap for the kind (the MATCHING dimension)
 *   → override REQUIRED;
 *   ELSE IF the request's equivalent in the OTHER cap dimension exceeds that
 *   cap → override REQUIRED (a 45%-equivalent fixed discount is not a 15%
 *   discount, whatever shape it was typed in).
 *
 * The conversion basis is the SAME current remaining subtotal the stage ran
 * against (the engine's remainingSubtotal = applied + the post-application
 * remainder), so stacking stays consistent: every stage converts against the
 * remainder it actually discounts. Conversions use the same
 * divideRoundHalfToEven rounding as the rest of the engine.
 *
 * A NULL cap dimension is NOT "unlimited": the caller must have rejected the
 * request earlier with DiscountAuthorityMissingError when the MATCHING
 * dimension is NULL (the first gate, discount-engine — no conversion, no
 * equivalent). Inside this function a NULL cap dimension simply does not
 * escalate on its own; the cross-dimension check only ever runs when the
 * OTHER dimension is actually granted (non-NULL).
 *
 * The gate applies without exception to the mechanism (manual or coupon):
 * both flow through the same discountKind/discountValueText.
 */
export function discountOverrideRequirement(
  stage: DiscountStageComputation,
  request: ParsedDiscountRequest,
  caps: ParsedDiscountCaps,
): { required: boolean; reason: DiscountOverrideReason | null } {
  // The stage's INPUT subtotal (the current remaining subtotal this discount
  // was computed against): applied + the post-application remainder.
  const basisSubtotalMinor = stage.appliedMinor + stage.remainingSubtotalMinor;

  // The MATCHING-dimension check: the request vs the cap of its own kind (a
  // pure comparison — no basis arithmetic involved).
  const matchingCap =
    request.kind === 'percentage' ? caps.maxPercentDbps : caps.maxFixedAmountMinor;
  const requestedRaw =
    request.kind === 'percentage' ? (request.percentDbps ?? 0n) : (request.fixedAmountMinor ?? 0n);
  const matchingExceeded = matchingCap !== null && requestedRaw > matchingCap;

  if (stage.zeroesOutSubtotal) {
    // Zeroing out the remainder ALWAYS escalates, even inside the cap.
    return { required: true, reason: matchingExceeded ? 'both' : 'zeroes_out_subtotal' };
  }
  if (basisSubtotalMinor <= 0n) {
    // A non-positive basis is a zero-out by definition — escalate
    // immediately, BEFORE any conversion arithmetic (never divide by zero).
    return { required: true, reason: 'zeroes_out_subtotal' };
  }

  // The CROSS-dimension check: only when the OTHER dimension is granted
  // (non-NULL) — the request is converted to that dimension's equivalent at
  // the same basis subtotal, with the engine's divideRoundHalfToEven.
  let crossExceeded = false;
  if (request.kind === 'percentage') {
    const otherCap = caps.maxFixedAmountMinor;
    if (otherCap !== null) {
      // The percentage's amount equivalent is exactly the stage's requested
      // value: divideRoundHalfToEven(basis × dbps, DBPS_PER_PERCENT).
      crossExceeded = stage.requestedMinor > otherCap;
    }
  } else {
    const otherCap = caps.maxPercentDbps;
    if (otherCap !== null) {
      const equivalentDbps = divideRoundHalfToEven(
        (request.fixedAmountMinor ?? 0n) * DBPS_PER_PERCENT,
        basisSubtotalMinor,
      );
      crossExceeded = equivalentDbps > otherCap;
    }
  }

  if (matchingExceeded && crossExceeded) return { required: true, reason: 'both' };
  if (matchingExceeded) return { required: true, reason: 'exceeds_matching_cap' };
  if (crossExceeded) return { required: true, reason: 'exceeds_cross_equivalent_cap' };
  return { required: false, reason: null };
}

/** One stage of the stacking chain: the request plus the actor's caps. */
export interface StackedDiscountStage {
  readonly mechanism: 'coupon' | 'manual' | 'points';
  readonly request: ParsedDiscountRequest;
  readonly caps: ParsedDiscountCaps;
}

export interface StackedDiscountStageResult {
  readonly stage: StackedDiscountStage;
  readonly computation: DiscountStageComputation;
  readonly overrideRequired: boolean;
  readonly overrideReason: DiscountOverrideReason | null;
}

/**
 * The stacking sequence (spec 2, tail): coupon → manual → points — each stage
 * RE-RUNS steps 2–4 against the CURRENT remaining subtotal. The caller
 * supplies the stages already in the mandated mechanism order (the engine
 * builds them that way; this function processes the array in order).
 */
export function applyDiscountStages(
  subtotalMinor: bigint,
  stages: readonly StackedDiscountStage[],
): readonly StackedDiscountStageResult[] {
  let remaining = subtotalMinor;
  const results: StackedDiscountStageResult[] = [];
  for (const stage of stages) {
    if (remaining === 0n) {
      // Nothing left to discount — the stage applies zero (it cannot go
      // negative by construction); recorded for completeness.
      results.push({
        stage,
        computation: { requestedMinor: 0n, appliedMinor: 0n, zeroesOutSubtotal: false, remainingSubtotalMinor: 0n },
        overrideRequired: false,
        overrideReason: null,
      });
      continue;
    }
    const computation = computeDiscountStage(remaining, stage.request);
    const requirement = discountOverrideRequirement(computation, stage.request, stage.caps);
    results.push({ stage, computation, overrideRequired: requirement.required, overrideReason: requirement.reason });
    remaining = computation.remainingSubtotalMinor;
  }
  return results;
}
