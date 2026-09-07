import type { ResolvedTaxLine, TaxCategory, TaxRate, TaxRoundingStrategy } from '../../../domain/contracts/tax.ts';
import { sortTaxCategories } from '../../../domain/contracts/tax-rules.ts';
import { TaxConfigurationError } from '../../../shared/errors.ts';
import { allocateInvoiceTax, assertTaxAmount, calculateTaxAmount } from '../../../shared/tax-math.ts';

export interface ApplicableTax {
  readonly category: TaxCategory;
  readonly rate: TaxRate;
}
export interface TaxComputationPlan {
  readonly orderLineId: string;
  readonly amountMinor: bigint;
  readonly currencyCode: string;
  readonly taxes: readonly ApplicableTax[];
}
interface Work {
  readonly lineId: string;
  readonly currencyCode: string;
  readonly base: bigint;
  readonly sequence: number;
  readonly tax: ApplicableTax;
}

/**
 * Mandatory order: priority ASC, category UUID ASC. Equal priorities do NOT
 * compound one another; only tax from STRICTLY lower priorities is added.
 * Inclusive/exclusive applies to EACH category's working base independently,
 * exactly as in the Phase-6 contract (not a reverse unstack of a bundle).
 */
export function calculateCascadingTaxes(
  plans: readonly TaxComputationPlan[],
  strategy: TaxRoundingStrategy,
): ReadonlyMap<string, readonly ResolvedTaxLine[]> {
  if (!['per_line', 'invoice_total'].includes(strategy)) throw new TaxConfigurationError('Invalid tax rounding strategy');
  const taxesByLine = new Map<string, ApplicableTax[]>();
  const result = new Map<string, ResolvedTaxLine[]>();
  const lowerPriorityTotals = new Map<string, bigint>();
  const priorities = new Set<number>();
  for (const plan of plans) {
    assertTaxAmount(plan.amountMinor);
    if (result.has(plan.orderLineId)) throw new TaxConfigurationError('Duplicate order line in tax computation');
    if (plan.taxes.length === 0 || plan.taxes.length > 32_767) throw new TaxConfigurationError('Invalid tax category count');
    const sorted = sortTaxCategories(plan.taxes.map((tax) => tax.category));
    const ordered = sorted.map((category) => {
      const tax = plan.taxes.find((t) => t.category.id === category.id);
      if (tax?.rate.taxCategoryId !== category.id) throw new TaxConfigurationError('Rate category mismatch');
      priorities.add(category.cascadePriority);
      return tax;
    });
    taxesByLine.set(plan.orderLineId, ordered);
    result.set(plan.orderLineId, []);
    lowerPriorityTotals.set(plan.orderLineId, 0n);
  }

  for (const priority of [...priorities].sort((a, b) => a - b)) {
    const groups = new Map<string, Work[]>();
    for (const plan of plans) {
      const taxes = taxesByLine.get(plan.orderLineId) ?? [];
      const base = plan.amountMinor + (lowerPriorityTotals.get(plan.orderLineId) ?? 0n);
      assertTaxAmount(base);
      taxes.forEach((tax, index) => {
        if (tax.category.cascadePriority !== priority) return;
        const groupId = JSON.stringify([tax.rate.id, tax.rate.rateBps, tax.rate.isPriceInclusiveDefault, plan.currencyCode]);
        const group = groups.get(groupId) ?? [];
        group.push({ lineId: plan.orderLineId, currencyCode: plan.currencyCode, base, sequence: index + 1, tax });
        groups.set(groupId, group);
      });
    }
    // Totals are only advanced AFTER the whole priority group has finished.
    const atThisPriority = new Map<string, bigint>();
    for (const group of groups.values()) {
      const first = group[0];
      if (first === undefined) continue;
      const rate = first.tax.rate;
      const allocations = strategy === 'invoice_total'
        ? allocateInvoiceTax(group.map((w) => ({ id: w.lineId, amountMinor: w.base })), rate.rateBps, rate.isPriceInclusiveDefault)
        : null;
      for (const work of group) {
        const taxAmount = allocations === null
          ? calculateTaxAmount(work.base, rate.rateBps, rate.isPriceInclusiveDefault).taxAmountMinor
          : allocations.get(work.lineId);
        if (taxAmount === undefined) throw new TaxConfigurationError('Missing invoice allocation');
        const row: ResolvedTaxLine = Object.freeze({
          taxRateId: rate.id,
          taxFamily: work.tax.category.taxFamily,
          computationSequence: work.sequence,
          liableParty: 'restaurant',
          rateBps: rate.rateBps,
          isPriceInclusive: rate.isPriceInclusiveDefault,
          taxableAmountMinor: rate.isPriceInclusiveDefault ? work.base - taxAmount : work.base,
          taxAmountMinor: taxAmount,
        });
        result.get(work.lineId)?.push(row);
        atThisPriority.set(work.lineId, (atThisPriority.get(work.lineId) ?? 0n) + taxAmount);
      }
    }
    for (const [lineId, subtotal] of atThisPriority) {
      lowerPriorityTotals.set(lineId, (lowerPriorityTotals.get(lineId) ?? 0n) + subtotal);
    }
  }
  return new Map([...result].map(([id, rows]) => [id, Object.freeze(rows.sort((a, b) => a.computationSequence - b.computationSequence))]));
}
