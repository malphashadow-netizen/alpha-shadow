import type {
  ExternalTaxLiabilityMarker, OrderLineTaxContext, TaxLiabilityRule, TaxLineRequest,
  TaxResolution, TaxResolutionTransaction,
} from '../../../domain/contracts/tax.ts';
import { sortTaxCategories, taxDateInTimezone } from '../../../domain/contracts/tax-rules.ts';
import {
  ExciseConfirmationRequiredError, InvoiceTaxBatchRequiredError, NoApplicableTaxLiabilityRuleError,
  NoApplicableTaxRateError, NotFoundError, TaxConfigurationError, TenantIsolationViolationError, ValidationError,
} from '../../../shared/errors.ts';
import { assertTaxAmount, assertTaxRateBps } from '../../../shared/tax-math.ts';
import { calculateCascadingTaxes, type ApplicableTax, type TaxComputationPlan } from './cascading.ts';

export function isExternalTaxLiability(result: TaxResolution): result is ExternalTaxLiabilityMarker {
  return 'kind' in result;
}
interface PreparedLine {
  readonly context: OrderLineTaxContext;
  readonly external: ExternalTaxLiabilityMarker | null;
  readonly computation: TaxComputationPlan | null;
}
function assertTenantScope(transaction: TaxResolutionTransaction, tenantId: string): void {
  if (transaction.tenantId.toLowerCase() !== tenantId.toLowerCase()) throw new TenantIsolationViolationError('Tax transaction tenant mismatch');
}
function chooseLiabilityRule(
  rules: readonly TaxLiabilityRule[], platformId: string | null, country: string, channel: string, on: string,
): TaxLiabilityRule {
  const exact = rules.filter((rule) => rule.deliveryPlatformId === platformId);
  const matches = exact.length > 0 ? exact : rules.filter((rule) => rule.deliveryPlatformId === null);
  if (matches.length > 1) throw new TaxConfigurationError('Ambiguous tax liability rules at the same specificity');
  const rule = matches[0];
  if (rule === undefined) throw new NoApplicableTaxLiabilityRuleError(country, channel, on);
  return rule;
}

async function prepareLine(transaction: TaxResolutionTransaction, request: TaxLineRequest): Promise<PreparedLine> {
  assertTaxAmount(request.grossOrNetAmountMinor);
  const branch = await transaction.getBranch(request.branchId);
  if (!branch?.isActive) throw new NotFoundError('Active tax branch not found');
  const jurisdiction = branch.jurisdiction;
  if (branch.countryCode === null || !jurisdiction?.isActive) {
    throw new TaxConfigurationError('Branch requires an active, explicitly backfilled tax jurisdiction');
  }
  if (request.currencyCode !== branch.currencyCode) throw new ValidationError('Tax currency must match the order branch currency', 'currencyCode');
  const on = taxDateInTimezone(request.at, branch.timezone);
  const channel = await transaction.getSalesChannel(request.salesChannel);
  if (channel === null) throw new TaxConfigurationError('Unknown sales channel');
  if (channel.requiresDeliveryPlatform !== (request.deliveryPlatformId !== null)) {
    throw new ValidationError('Delivery platform presence must match the sales channel requirements', 'deliveryPlatformId');
  }
  if (request.deliveryPlatformId !== null) {
    const platform = await transaction.getDeliveryPlatform(request.deliveryPlatformId);
    if (platform === null || !platform.isActive || (platform.countryCode !== null && platform.countryCode !== branch.countryCode)) {
      throw new TaxConfigurationError('Delivery platform is inactive, missing, or outside the branch jurisdiction');
    }
  }

  // 1. LIABILITY FIRST. No catalog/rate/consent read before this decision.
  const registered = await transaction.getVatRegistrationStatus() === 'registered';
  const candidates = await transaction.findLiabilityRules(branch.countryCode, request.salesChannel, request.deliveryPlatformId, registered, on);
  const matches = candidates.filter((rule) => rule.countryCode === branch.countryCode && rule.salesChannelCode === request.salesChannel
    && rule.appliesWhenTenantRegistered === registered && rule.effectiveFrom <= on && (rule.effectiveTo === null || rule.effectiveTo >= on)
    && (rule.deliveryPlatformId === null || rule.deliveryPlatformId === request.deliveryPlatformId));
  const liability = chooseLiabilityRule(matches, request.deliveryPlatformId, branch.countryCode, request.salesChannel, on);
  const context: OrderLineTaxContext = Object.freeze({
    ...request, at: new Date(request.at.getTime()), liabilityRuleId: liability.id,
    liableParty: liability.liableParty, roundingStrategy: jurisdiction.roundingStrategy,
  });
  if (liability.liableParty === 'marketplace') {
    if (request.deliveryPlatformId === null) throw new TaxConfigurationError('Marketplace liability requires a delivery platform');
    return {
      context,
      external: Object.freeze({ kind: 'external_tax_liability', liableParty: 'marketplace', liabilityRuleId: liability.id,
        countryCode: branch.countryCode, salesChannel: request.salesChannel,
        deliveryPlatformId: request.deliveryPlatformId, restaurantTaxInvoiceAllowed: false }),
      computation: null,
    };
  }

  // 2. Primary + explicitly linked additional categories, then branch overrides.
  const assignment = await transaction.getMenuItemAssignment(request.menuItemId);
  if (!assignment?.isActive) throw new NotFoundError('Active menu item not found');
  if (assignment.taxRuleId === null) throw new TaxConfigurationError('Menu item has no primary tax category');
  const categories = [];
  for (const originalId of [assignment.taxRuleId, ...assignment.additionalTaxCategoryIds]) {
    const source = await transaction.getCategory(originalId);
    if (!source?.isActive) throw new TaxConfigurationError('Assigned tax category is missing or inactive');
    const overrideId = await transaction.getBranchOverride(request.branchId, originalId);
    const category = overrideId === null ? source : await transaction.getCategory(overrideId);
    if (category === null || !category.isActive || category.countryCode !== branch.countryCode) {
      throw new TaxConfigurationError('Resolved tax category must be active and match the branch country');
    }
    if (category.taxFamily !== source.taxFamily) throw new TaxConfigurationError('Branch override cannot change tax family');
    if (category.taxFamily === 'excise' && !(await transaction.hasExciseConfirmation(request.menuItemId, category.id, request.branchId))) {
      throw new ExciseConfirmationRequiredError();
    }
    categories.push(category);
  }

  // 3. Explicit, deterministic priority sort, never database/insertion order.
  const ordered = sortTaxCategories(categories);
  const taxes: ApplicableTax[] = [];
  // 4a. Every category must have an applicable historical rate; never default 0.
  for (const category of ordered) {
    const rate = await transaction.getApplicableRate(category.id, on);
    if (rate === null) throw new NoApplicableTaxRateError(category.id, on);
    assertTaxRateBps(rate.rateBps);
    if (rate.taxCategoryId !== category.id || rate.effectiveFrom > on || (rate.effectiveTo !== null && rate.effectiveTo < on)) {
      throw new TaxConfigurationError('Resolved tax rate does not match category/date');
    }
    if ((category.kind === 'no_vat' && (rate.rateBps !== 0 || rate.effectiveTo !== null || rate.supersededBy !== null)) ||
      ((category.kind === 'zero_rated' || category.kind === 'exempt') && rate.rateBps !== 0)) {
      throw new TaxConfigurationError('Invalid zero/exempt/no_vat rate');
    }
    taxes.push({ category, rate });
  }
  return { context, external: null, computation: { orderLineId: request.orderLineId,
    amountMinor: request.grossOrNetAmountMinor, currencyCode: request.currencyCode, taxes } };
}

async function persistPrepared(transaction: TaxResolutionTransaction, prepared: PreparedLine, resolution: TaxResolution): Promise<void> {
  // 5. Both the order writer and these INSERTs share the SAME transaction.
  // Marketplace gets durable external context, never a fake restaurant tax row.
  await transaction.insertContext(prepared.context);
  if (!isExternalTaxLiability(resolution)) {
    await transaction.insertSnapshots(prepared.context.orderLineId, prepared.context.currencyCode, resolution);
  }
}

export interface TaxResolutionEngineDependencies {
  readonly transaction: TaxResolutionTransaction;
  /** Bound by the order-line unit of work (not supplied by an HTTP payload). */
  readonly orderLineId: string;
}
export class TaxResolutionEngine {
  private readonly transaction: TaxResolutionTransaction;
  private readonly orderLineId: string;
  constructor(dependencies: TaxResolutionEngineDependencies) {
    this.transaction = dependencies.transaction;
    this.orderLineId = dependencies.orderLineId;
  }
  async resolveAndSnapshot(
    tenantId: string, branchId: string, menuItemId: string, grossOrNetAmountMinor: bigint,
    currencyCode: string, at: Date, salesChannel: string, deliveryPlatformId: string | null,
  ): Promise<TaxResolution> {
    assertTenantScope(this.transaction, tenantId);
    const prepared = await prepareLine(this.transaction, { orderLineId: this.orderLineId, branchId, menuItemId,
      grossOrNetAmountMinor, currencyCode, at: new Date(at.getTime()), salesChannel, deliveryPlatformId });
    if (prepared.external !== null) {
      await persistPrepared(this.transaction, prepared, prepared.external);
      return prepared.external;
    }
    if (prepared.context.roundingStrategy === 'invoice_total') throw new InvoiceTaxBatchRequiredError();
    if (prepared.computation === null) throw new TaxConfigurationError('Missing tax computation plan');
    // 4b/c. Lower-priority tax cascades into the working base, half-up per tax.
    const taxes = calculateCascadingTaxes([prepared.computation], 'per_line').get(this.orderLineId);
    if (taxes === undefined) throw new TaxConfigurationError('Missing resolved tax lines');
    await persistPrepared(this.transaction, prepared, taxes);
    return taxes;
  }
}

/** Complete-invoice API for invoice_total; allocations are made before ANY snapshot write. */
export async function resolveInvoiceAndSnapshot(
  transaction: TaxResolutionTransaction, tenantId: string, requests: readonly TaxLineRequest[],
): Promise<ReadonlyMap<string, TaxResolution>> {
  assertTenantScope(transaction, tenantId);
  const capturedRequests = requests.map((r) => ({ ...r, at: new Date(r.at.getTime()) }));
  const first = capturedRequests[0];
  if (first === undefined) throw new ValidationError('An invoice must contain at least one line');
  if (new Set(requests.map((r) => r.orderLineId)).size !== requests.length) throw new ValidationError('Duplicate invoice line id');
  if (requests.some((r) => r.branchId !== first.branchId || r.currencyCode !== first.currencyCode ||
    r.salesChannel !== first.salesChannel || r.deliveryPlatformId !== first.deliveryPlatformId || r.at.getTime() !== first.at.getTime())) {
    throw new ValidationError('Invoice lines must share branch, currency, channel, platform and transaction time');
  }
  const prepared: PreparedLine[] = [];
  for (const request of capturedRequests) prepared.push(await prepareLine(transaction, request));
  const strategy = prepared[0]?.context.roundingStrategy;
  if (strategy === undefined || prepared.some((p) => p.context.roundingStrategy !== strategy)) throw new TaxConfigurationError('Inconsistent invoice rounding strategy');
  const computations = prepared.flatMap((p) => p.computation === null ? [] : [p.computation]);
  const calculated = calculateCascadingTaxes(computations, strategy);
  const result = new Map<string, TaxResolution>();
  for (const line of prepared) {
    const resolved = line.external ?? calculated.get(line.context.orderLineId);
    if (resolved === undefined) throw new TaxConfigurationError('Missing invoice tax result');
    await persistPrepared(transaction, line, resolved);
    result.set(line.context.orderLineId, resolved);
  }
  return result;
}
