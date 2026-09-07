/** Phase 6 ports. Country/channel/platform identifiers are DATA, never enums. */
import type { LocalizedText } from './catalog.ts';

export type TaxFamily = 'vat' | 'excise';
export type TaxCategoryKind = 'standard' | 'reduced' | 'zero_rated' | 'exempt' | 'no_vat';
export type TaxRoundingStrategy = 'per_line' | 'invoice_total';
export type TaxLiableParty = 'restaurant' | 'marketplace';
export type VatRegistrationStatus = 'registered' | 'unregistered';

export interface TaxJurisdiction {
  readonly countryCode: string;
  readonly name: LocalizedText;
  readonly defaultCurrencyCode: string;
  readonly roundingStrategy: TaxRoundingStrategy;
  readonly isActive: boolean;
}
export interface TaxCategory {
  readonly id: string;
  readonly countryCode: string;
  readonly code: string;
  readonly kind: TaxCategoryKind;
  readonly taxFamily: TaxFamily;
  readonly cascadePriority: number;
  readonly name: LocalizedText;
  readonly isActive: boolean;
}
export interface TaxRate {
  readonly id: string;
  readonly taxCategoryId: string;
  readonly rateBps: number;
  readonly isPriceInclusiveDefault: boolean;
  /** Canonical calendar dates, not server-local midnight Date objects. */
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly supersededBy: string | null;
}
export interface SalesChannel {
  readonly code: string;
  readonly name: LocalizedText;
  readonly requiresDeliveryPlatform: boolean;
}
export interface DeliveryPlatform {
  readonly id: string;
  readonly code: string;
  readonly name: LocalizedText;
  readonly countryCode: string | null;
  readonly isActive: boolean;
}
export interface TaxLiabilityRule {
  readonly id: string;
  readonly countryCode: string;
  readonly salesChannelCode: string;
  readonly deliveryPlatformId: string | null;
  readonly appliesWhenTenantRegistered: boolean;
  readonly liableParty: TaxLiableParty;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}
export interface TaxBranch {
  readonly id: string;
  readonly countryCode: string | null;
  readonly currencyCode: string;
  readonly timezone: string;
  readonly isActive: boolean;
  readonly jurisdiction: TaxJurisdiction | null;
}
export interface MenuItemTaxAssignment {
  readonly menuItemId: string;
  readonly isActive: boolean;
  /** Original Phase-5 field name remains unchanged. */
  readonly taxRuleId: string | null;
  readonly additionalTaxCategoryIds: readonly string[];
}
export interface ResolvedTaxLine {
  readonly taxRateId: string;
  readonly taxFamily: TaxFamily;
  readonly computationSequence: number;
  readonly liableParty: TaxLiableParty;
  readonly rateBps: number;
  readonly isPriceInclusive: boolean;
  readonly taxableAmountMinor: bigint;
  readonly taxAmountMinor: bigint;
}
export interface ExternalTaxLiabilityMarker {
  readonly kind: 'external_tax_liability';
  readonly liableParty: 'marketplace';
  readonly liabilityRuleId: string;
  readonly countryCode: string;
  readonly salesChannel: string;
  readonly deliveryPlatformId: string;
  readonly restaurantTaxInvoiceAllowed: false;
}
export type TaxResolution = readonly ResolvedTaxLine[] | ExternalTaxLiabilityMarker;

export interface TaxLineRequest {
  readonly orderLineId: string;
  readonly branchId: string;
  readonly menuItemId: string;
  /** Full customer-facing price BEFORE ANY marketplace commission deduction. */
  readonly grossOrNetAmountMinor: bigint;
  readonly currencyCode: string;
  readonly at: Date;
  readonly salesChannel: string;
  readonly deliveryPlatformId: string | null;
}
export interface OrderLineTaxContext extends TaxLineRequest {
  readonly liabilityRuleId: string;
  readonly liableParty: TaxLiableParty;
  readonly roundingStrategy: TaxRoundingStrategy;
}
export interface StoredTaxLine extends ResolvedTaxLine {
  readonly orderLineId: string;
  readonly currencyCode: string;
}

/**
 * A transaction-bound port, NEVER an auto-committing repository. The order
 * writer and all these methods must use the exact same tenant DB transaction.
 * It becomes unusable as soon as the unit-of-work callback returns.
 */
export interface TaxResolutionTransaction {
  readonly tenantId: string;
  getBranch(branchId: string): Promise<TaxBranch | null>;
  getVatRegistrationStatus(): Promise<VatRegistrationStatus>;
  getSalesChannel(code: string): Promise<SalesChannel | null>;
  getDeliveryPlatform(id: string): Promise<DeliveryPlatform | null>;
  findLiabilityRules(countryCode: string, salesChannel: string, deliveryPlatformId: string | null,
    registered: boolean, on: string): Promise<readonly TaxLiabilityRule[]>;
  getMenuItemAssignment(menuItemId: string): Promise<MenuItemTaxAssignment | null>;
  getCategory(id: string): Promise<TaxCategory | null>;
  getBranchOverride(branchId: string, originalCategoryId: string): Promise<string | null>;
  getApplicableRate(categoryId: string, on: string): Promise<TaxRate | null>;
  hasExciseConfirmation(menuItemId: string, categoryId: string, branchId: string): Promise<boolean>;
  insertContext(context: OrderLineTaxContext): Promise<void>;
  insertSnapshots(orderLineId: string, currencyCode: string, taxes: readonly ResolvedTaxLine[]): Promise<void>;
}

/** Read-only evidence port for reporting/future ZATCA. No recalculate/update. */
export interface TaxSnapshotReader {
  readContext(tenantId: string, orderLineId: string): Promise<OrderLineTaxContext | null>;
  readSnapshots(tenantId: string, orderLineId: string): Promise<readonly StoredTaxLine[]>;
}

export type NewTaxCategory = Omit<TaxCategory, 'id'>;
export type NewTaxRate = Omit<TaxRate, 'id' | 'supersededBy'>;
export type NewDeliveryPlatform = Omit<DeliveryPlatform, 'id'>;
export type NewTaxLiabilityRule = Omit<TaxLiabilityRule, 'id'>;
export interface SupersedeTaxRateInput {
  readonly taxRateId: string;
  readonly rateBps: number;
  readonly isPriceInclusiveDefault: boolean;
  readonly effectiveFrom: string;
}

/** Platform capability only: intentionally NO tenantId parameter anywhere. */
export interface PlatformTaxAdminRepository {
  createJurisdiction(actorId: string, input: TaxJurisdiction): Promise<TaxJurisdiction>;
  configureJurisdiction(actorId: string, countryCode: string, rounding: TaxRoundingStrategy, active: boolean): Promise<void>;
  createCategory(actorId: string, input: NewTaxCategory): Promise<TaxCategory>;
  setCategoryActive(actorId: string, categoryId: string, active: boolean): Promise<void>;
  createTaxRate(actorId: string, input: NewTaxRate): Promise<TaxRate>;
  closeAndSupersedeTaxRate(actorId: string, input: SupersedeTaxRateInput): Promise<TaxRate>;
  createSalesChannel(actorId: string, input: SalesChannel): Promise<SalesChannel>;
  createDeliveryPlatform(actorId: string, input: NewDeliveryPlatform): Promise<DeliveryPlatform>;
  createLiabilityRule(actorId: string, input: NewTaxLiabilityRule): Promise<TaxLiabilityRule>;
  closeLiabilityRule(actorId: string, ruleId: string, effectiveTo: string): Promise<void>;
}
