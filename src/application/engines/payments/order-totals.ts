/**
 * Order totals (Phase 8) — steps 1, 5, 6, 7 and 8 of the binding pseudocode.
 *
 *   subtotal  = Σ unit_price_minor × quantity over ACTIVE (non-voided) items
 *   discounts = Σ order_discounts.discount_amount_applied (clamped to the
 *               subtotal defensively — the engine + DB trigger already cap
 *               every row, this clamp guarantees ≥ 0 whatever any future
 *               path does)
 *   tax       = the ACTUAL Phase-6 cascading engine (calculateCascadingTaxes)
 *               re-run on the DISCOUNTED line bases: the applied discount is
 *               allocated across the active lines proportionally to their
 *               amounts (largest remainder, stable by line id), and each
 *               line's stored immutable rate/inclusivity/cascade-priority
 *               snapshot (order_line_tax_snapshots) is replayed against the
 *               reduced base. INCLUSIVE taxes are extracted inside the line
 *               price and are NOT added on top (same amountPayable semantics
 *               as the Phase-6 order-tax coordinator); only EXCLUSIVE taxes
 *               enter the total.
 *   total     = discounted_subtotal + exclusive tax. `orders` has NO
 *               delivery_fee / service_charge columns today — when such
 *               columns arrive they must be added HERE by name, never by a
 *               hidden surcharge.
 *   remaining = total − Σ completed payments (amount_in_base_currency).
 */

import type { OrderFinancialSnapshot, OrderLineTaxPlanLine } from '../../../domain/contracts/payments.ts';
import type { TaxCategory, TaxRate } from '../../../domain/contracts/tax.ts';
import type { TaxComputationPlan } from '../tax/cascading.ts';
import { calculateCascadingTaxes } from '../tax/cascading.ts';
import { TaxConfigurationError } from '../../../shared/errors.ts';
import { decimalTextToMinor, storageMinorUnitDigits } from '../../../shared/decimal-text.ts';
import { currencyCode } from '../../../shared/money.ts';

export interface OrderTotalsComputation {
  readonly subtotalMinor: bigint;
  readonly discountTotalMinor: bigint;
  readonly discountedSubtotalMinor: bigint;
  /** Σ exclusive tax amounts on the discounted bases (inclusive taxes stay inside the price). */
  readonly taxMinor: bigint;
  readonly totalMinor: bigint;
  readonly remainingBalanceMinor: bigint;
  readonly baseMinorDigits: number;
}

/** Largest-remainder proportional allocation of `totalMinor` over `weights` (Σ result === totalMinor). */
export function allocateProportionally(
  totalMinor: bigint,
  weights: readonly { readonly id: string; readonly weight: bigint }[],
): ReadonlyMap<string, bigint> {
  const allocation = new Map<string, bigint>(weights.map((w) => [w.id, 0n]));
  const totalWeight = weights.reduce((sum, w) => sum + w.weight, 0n);
  if (totalMinor === 0n || totalWeight === 0n || weights.length === 0) return allocation;
  let distributed = 0n;
  const remainders = weights
    .map((w) => {
      const exactNumerator = totalMinor * w.weight;
      const base = exactNumerator / totalWeight;
      allocation.set(w.id, base);
      distributed += base;
      return { id: w.id, remainder: exactNumerator % totalWeight };
    })
    .sort((a, b) => (a.remainder === b.remainder ? (a.id < b.id ? -1 : 1) : a.remainder > b.remainder ? -1 : 1));
  let left = totalMinor - distributed;
  for (const r of remainders) {
    if (left === 0n) break;
    allocation.set(r.id, (allocation.get(r.id) ?? 0n) + 1n);
    left -= 1n;
  }
  return allocation;
}

/**
 * Rebuilds the Phase-6 computation plan for one line from its immutable
 * snapshots. The synthesized category id is `rate:<rateId>` — unique per rate
 * (snapshots are UNIQUE per (line, rate)), which preserves the engine's
 * deterministic (cascadePriority, id) sort exactly.
 */
function toApplicableTax(line: OrderLineTaxPlanLine): { category: TaxCategory; rate: TaxRate } {
  const syntheticCategoryId = `rate:${line.taxRateId}`;
  const category = Object.freeze({
    id: syntheticCategoryId,
    countryCode: '',
    code: syntheticCategoryId,
    kind: 'standard' as const,
    taxFamily: line.taxFamily,
    cascadePriority: line.cascadePriority,
    name: {},
    isActive: true,
  });
  const rate = Object.freeze({
    id: line.taxRateId,
    taxCategoryId: syntheticCategoryId,
    rateBps: line.rateBps,
    isPriceInclusiveDefault: line.isPriceInclusive,
    effectiveFrom: '1970-01-01',
    effectiveTo: null,
    supersededBy: null,
  });
  return { category, rate };
}

export function computeOrderTotals(snapshot: OrderFinancialSnapshot): OrderTotalsComputation {
  const baseMinorDigits = storageMinorUnitDigits(currencyCode(snapshot.baseCurrencyCode));

  // Step 1 — subtotal over active items.
  const subtotalMinor = snapshot.lines.reduce((sum, line) => sum + line.lineAmountMinor, 0n);

  // Σ applied discounts (each row was capped at its remaining subtotal by the
  // engine; the clamp is a defensive guarantee of ≥ 0).
  const rawDiscountTotal = snapshot.discounts.reduce(
    (sum, discount) => sum + decimalTextToMinor(discount.discountAmountApplied, baseMinorDigits, 'discountAmountApplied'),
    0n,
  );
  const discountTotalMinor = rawDiscountTotal > subtotalMinor ? subtotalMinor : rawDiscountTotal;
  const discountedSubtotalMinor = subtotalMinor - discountTotalMinor;

  // Step 6 — the Phase-6 engine on the discounted bases.
  let taxMinor = 0n;
  const hasTaxPlans = snapshot.lines.some((line) => line.taxPlan.length > 0);
  if (hasTaxPlans) {
    const strategy = snapshot.roundingStrategy;
    if (strategy === null) {
      throw new TaxConfigurationError('Tax snapshots exist without a stored rounding strategy — inconsistent evidence');
    }
    const discountByLine =
      discountTotalMinor === 0n
        ? new Map<string, bigint>()
        : allocateProportionally(
            discountTotalMinor,
            snapshot.lines.map((line) => ({ id: line.orderItemId, weight: line.lineAmountMinor })),
          );
    const plans: TaxComputationPlan[] = snapshot.lines
      .filter((line) => line.taxPlan.length > 0)
      .map((line) => ({
        orderLineId: line.orderItemId,
        amountMinor: line.lineAmountMinor - (discountByLine.get(line.orderItemId) ?? 0n),
        currencyCode: snapshot.baseCurrencyCode,
        taxes: line.taxPlan.map(toApplicableTax),
      }));
    const resolved = calculateCascadingTaxes(plans, strategy);
    for (const lines of resolved.values()) {
      for (const taxLine of lines) {
        if (!taxLine.isPriceInclusive) taxMinor += taxLine.taxAmountMinor;
      }
    }
  }

  // Step 7 — total (no fee columns exist on `orders`; see module header).
  const totalMinor = discountedSubtotalMinor + taxMinor;

  // Step 8 — remaining balance.
  const remainingBalanceMinor = totalMinor - snapshot.completedPaymentsMinor;

  return {
    subtotalMinor,
    discountTotalMinor,
    discountedSubtotalMinor,
    taxMinor,
    totalMinor,
    remainingBalanceMinor,
    baseMinorDigits,
  };
}

