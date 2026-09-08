/**
 * Unit tests for the BINDING Phase-8 discount pseudocode
 * (src/application/engines/payments/discount-math.ts) — no I/O.
 *
 * Mandated invariants covered:
 *   * capping NEVER produces a negative remainder (applied = MIN(requested,
 *     subtotal) ⇒ discounted_subtotal ≥ 0 by construction);
 *   * zeroing out the subtotal ALWAYS requires a manager override (even when
 *     the requested value is inside the cap);
 *   * requested > the actor's cap requires a manager override;
 *   * stacking: coupon → manual → points, each stage re-running steps 2–4
 *     against the CURRENT remaining subtotal.
 */
import { describe, expect, it } from 'vitest';
import {
  applyDiscountStages,
  computeDiscountStage,
  discountOverrideRequirement,
  parseDiscountCaps,
  parseDiscountRequest,
  type ParsedDiscountCaps,
  type StackedDiscountStage,
} from '../../../../src/application/engines/payments/discount-math.ts';
import { ValidationError } from '../../../../src/shared/errors.ts';

const SAR = 2; // minor-unit digits of the base currency in these tests

function percentage(valueText: string) {
  return parseDiscountRequest('percentage', valueText, SAR);
}
function fixed(valueText: string) {
  return parseDiscountRequest('fixed_amount', valueText, SAR);
}
function caps(pct: string | null, fixedAmount: string | null): ParsedDiscountCaps {
  return parseDiscountCaps(pct, fixedAmount, SAR);
}

describe('computeDiscountStage — steps 2, 3 and 5', () => {
  it('computes a percentage request exactly, once, half-even', () => {
    // 10% of 87.53 SAR = 8.753 → banker's → 8.75
    const stage = computeDiscountStage(8753n, percentage('10.0000'));
    expect(stage.requestedMinor).toBe(875n);
    expect(stage.appliedMinor).toBe(875n);
    expect(stage.remainingSubtotalMinor).toBe(7878n);
  });

  it('capping never produces a negative remainder (fixed amount above the subtotal)', () => {
    const stage = computeDiscountStage(2500n, fixed('40.00'));
    expect(stage.requestedMinor).toBe(4000n);
    expect(stage.appliedMinor).toBe(2500n); // MIN(requested, subtotal)
    expect(stage.remainingSubtotalMinor).toBe(0n);
    expect(stage.zeroesOutSubtotal).toBe(true);
  });

  it('capping never produces a negative remainder (percentage of the full remainder zeroes out)', () => {
    const stage = computeDiscountStage(1000n, percentage('100.00'));
    expect(stage.appliedMinor).toBe(1000n);
    expect(stage.remainingSubtotalMinor).toBe(0n);
  });

  it('a 0-major-minor remainder is handled without going negative', () => {
    const results = applyDiscountStages(0n, [
      { mechanism: 'manual', request: fixed('5.00'), caps: caps('50.00', '20.00') },
    ]);
    expect(results[0]?.computation.appliedMinor).toBe(0n);
    expect(results[0]?.computation.remainingSubtotalMinor).toBe(0n);
  });

  it('rejects non-positive or over-100% requests (fail-closed)', () => {
    expect(() => percentage('0')).toThrow(ValidationError);
    expect(() => percentage('100.0001')).toThrow(ValidationError);
    expect(() => fixed('0.00')).toThrow(ValidationError);
  });
});

describe('discountOverrideRequirement — step 4', () => {
  it('zeroing out the subtotal ALWAYS escalates, even inside the cap', () => {
    const stage = computeDiscountStage(2500n, fixed('40.00'));
    const requirement = discountOverrideRequirement(stage, fixed('40.00'), caps(null, '20.00'));
    expect(requirement.required).toBe(true);
    expect(requirement.reason).toBe('both'); // zeroes out AND exceeds the 20.00 cap

    const insideCap = computeDiscountStage(2500n, fixed('20.00'));
    expect(insideCap.appliedMinor).toBe(2000n);
    const requirementInside = discountOverrideRequirement(insideCap, fixed('20.00'), caps(null, '20.00'));
    expect(requirementInside.required).toBe(false); // partial discount within the cap
  });

  it('a percentage that zeroes out escalates even when the percentage itself is capped', () => {
    const stage = computeDiscountStage(1000n, percentage('100.00'));
    const requirement = discountOverrideRequirement(stage, percentage('100.00'), caps('100.00', null));
    expect(requirement.required).toBe(true);
    expect(requirement.reason).toBe('zeroes_out_subtotal');
  });

  it('requested above the cap (but not zeroing out) escalates', () => {
    const stage = computeDiscountStage(10000n, percentage('30.00')); // requested 3000 of 10000
    const requirement = discountOverrideRequirement(stage, percentage('30.00'), caps('15.00', null));
    expect(requirement.required).toBe(true);
    expect(requirement.reason).toBe('exceeds_user_cap');
  });

  it('exactly at the cap does NOT escalate (the cap is inclusive)', () => {
    const stage = computeDiscountStage(10000n, percentage('15.00'));
    const requirement = discountOverrideRequirement(stage, percentage('15.00'), caps('15.00', null));
    expect(requirement.required).toBe(false);
  });
});

describe('applyDiscountStages — the mandated stacking order', () => {
  it('coupon → manual → points, each stage against the CURRENT remaining subtotal', () => {
    const stages: readonly StackedDiscountStage[] = [
      { mechanism: 'coupon', request: percentage('10.00'), caps: caps('10.00', '50.00') },
      { mechanism: 'manual', request: fixed('5.00'), caps: caps('10.00', '50.00') },
      { mechanism: 'points', request: percentage('5.00'), caps: caps('10.00', '50.00') },
    ];
    // subtotal 100.00 SAR
    const results = applyDiscountStages(10000n, stages);

    // Stage 1 (coupon 10%): requested 1000, applied 1000, remaining 9000.
    expect(results[0]?.computation).toMatchObject({ requestedMinor: 1000n, appliedMinor: 1000n, remainingSubtotalMinor: 9000n });
    expect(results[0]?.overrideRequired).toBe(false);

    // Stage 2 (manual 5.00): against the REMAINING 90.00, applied 500, remaining 8500.
    expect(results[1]?.computation).toMatchObject({ requestedMinor: 500n, appliedMinor: 500n, remainingSubtotalMinor: 8500n });

    // Stage 3 (points 5%): against the remaining 85.00 → 425, remaining 8075.
    expect(results[2]?.computation).toMatchObject({ requestedMinor: 425n, appliedMinor: 425n, remainingSubtotalMinor: 8075n });

    // The stacked total never exceeds the original subtotal.
    const appliedTotal = results.reduce((sum, r) => sum + r.computation.appliedMinor, 0n);
    expect(appliedTotal).toBe(1925n);
    expect(appliedTotal <= 10000n).toBe(true);
  });

  it('a later stage is capped at whatever remains — never negative', () => {
    const stages: readonly StackedDiscountStage[] = [
      { mechanism: 'coupon', request: fixed('80.00'), caps: caps('50.00', '100.00') },
      { mechanism: 'manual', request: fixed('50.00'), caps: caps('50.00', '100.00') },
    ];
    const results = applyDiscountStages(10000n, stages);
    expect(results[0]?.computation.appliedMinor).toBe(8000n);
    expect(results[1]?.computation.appliedMinor).toBe(2000n); // capped at the remainder
    expect(results[1]?.computation.remainingSubtotalMinor).toBe(0n);
    expect(results[1]?.overrideRequired).toBe(true); // zeroing out ALWAYS escalates
  });

  it('the mandated order is preserved as given — the engine supplies coupon→manual→points', () => {
    const results = applyDiscountStages(10000n, [
      { mechanism: 'coupon', request: percentage('5.00'), caps: caps('10.00', null) },
      { mechanism: 'manual', request: percentage('5.00'), caps: caps('10.00', null) },
    ]);
    expect(results.map((r) => r.stage.mechanism)).toEqual(['coupon', 'manual']);
  });
});
