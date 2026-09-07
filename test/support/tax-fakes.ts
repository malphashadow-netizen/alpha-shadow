import type {
  DeliveryPlatform, MenuItemTaxAssignment, OrderLineTaxContext, ResolvedTaxLine, SalesChannel, TaxBranch,
  TaxCategory, TaxLiabilityRule, TaxRate, TaxResolutionTransaction, VatRegistrationStatus,
} from '../../src/domain/contracts/tax.ts';

export const TAX_TENANT = '11111111-1111-4111-8111-111111111111';
export const TAX_BRANCH = '71000000-0000-4000-8000-000000000001';
export const TAX_ITEM = '71000000-0000-4000-8000-000000000002';
export const TAX_LINE = '71000000-0000-4000-8000-000000000003';
export const TAX_PLATFORM = '71000000-0000-4000-8000-000000000004';
export const TAX_ACTOR = '71000000-0000-4000-8000-000000000005';
export const VAT_CATEGORY: TaxCategory = { id: '61000000-0000-4000-8000-000000000001', countryCode: 'SA', code: 'vat',
  kind: 'standard', taxFamily: 'vat', cascadePriority: 50, name: { en: 'VAT' }, isActive: true };
export const EXCISE_CATEGORY: TaxCategory = { ...VAT_CATEGORY, id: '61000000-0000-4000-8000-000000000002', code: 'excise', taxFamily: 'excise', cascadePriority: 10 };
export const VAT_RATE: TaxRate = { id: '62000000-0000-4000-8000-000000000001', taxCategoryId: VAT_CATEGORY.id,
  rateBps: 1500, isPriceInclusiveDefault: false, effectiveFrom: '2020-01-01', effectiveTo: null, supersededBy: null };
export const EXCISE_RATE: TaxRate = { ...VAT_RATE, id: '62000000-0000-4000-8000-000000000002', taxCategoryId: EXCISE_CATEGORY.id, rateBps: 10000 };
export const RESTAURANT_RULE: TaxLiabilityRule = { id: '63000000-0000-4000-8000-000000000001', countryCode: 'SA',
  salesChannelCode: 'dine_in', deliveryPlatformId: null, appliesWhenTenantRegistered: true,
  liableParty: 'restaurant', effectiveFrom: '2020-01-01', effectiveTo: null };
export const TAX_AT = new Date('2026-09-07T10:00:00.000Z');

/** Unit-only transaction double. Real RLS/atomicity are never tested here. */
export class FakeTaxTransaction implements TaxResolutionTransaction {
  readonly tenantId = TAX_TENANT;
  branch: TaxBranch = { id: TAX_BRANCH, countryCode: 'SA', currencyCode: 'SAR', timezone: 'Asia/Riyadh', isActive: true,
    jurisdiction: { countryCode: 'SA', name: { en: 'Test' }, defaultCurrencyCode: 'SAR', roundingStrategy: 'per_line', isActive: true } };
  registered: VatRegistrationStatus = 'registered';
  assignment: MenuItemTaxAssignment = { menuItemId: TAX_ITEM, taxRuleId: VAT_CATEGORY.id, additionalTaxCategoryIds: [], isActive: true };
  readonly categories = new Map([[VAT_CATEGORY.id, VAT_CATEGORY]]);
  rates: TaxRate[] = [VAT_RATE];
  rules: TaxLiabilityRule[] = [RESTAURANT_RULE];
  readonly channels = new Map<string, SalesChannel>([
    ['dine_in', { code: 'dine_in', name: { en: 'Tables' }, requiresDeliveryPlatform: false }],
    ['delivery_app', { code: 'delivery_app', name: { en: 'Marketplace' }, requiresDeliveryPlatform: true }],
  ]);
  readonly platforms = new Map<string, DeliveryPlatform>([[TAX_PLATFORM, { id: TAX_PLATFORM, code: 'example', name: { en: 'Example' }, countryCode: null, isActive: true }]]);
  readonly overrides = new Map<string, string>();
  readonly confirmed = new Set<string>();
  readonly calls: string[] = [];
  readonly contexts: OrderLineTaxContext[] = [];
  readonly snapshots = new Map<string, readonly ResolvedTaxLine[]>();
  async getBranch(id: string): Promise<TaxBranch | null> { return this.branch.id === id ? this.branch : null; }
  async getVatRegistrationStatus(): Promise<VatRegistrationStatus> { return this.registered; }
  async getSalesChannel(code: string): Promise<SalesChannel | null> { return this.channels.get(code) ?? null; }
  async getDeliveryPlatform(id: string): Promise<DeliveryPlatform | null> { return this.platforms.get(id) ?? null; }
  async findLiabilityRules(_country: string, _channel: string, _platform: string | null, _registered: boolean, _on: string): Promise<readonly TaxLiabilityRule[]> {
    this.calls.push('liability'); return this.rules;
  }
  async getMenuItemAssignment(_id: string): Promise<MenuItemTaxAssignment | null> { this.calls.push('assignment'); return this.assignment; }
  async getCategory(id: string): Promise<TaxCategory | null> { this.calls.push('category'); return this.categories.get(id) ?? null; }
  async getBranchOverride(_branchId: string, original: string): Promise<string | null> { return this.overrides.get(original) ?? null; }
  async getApplicableRate(id: string, on: string): Promise<TaxRate | null> {
    this.calls.push('rate');
    return this.rates.find((r) => r.taxCategoryId === id && r.effectiveFrom <= on && (r.effectiveTo === null || r.effectiveTo >= on)) ?? null;
  }
  async hasExciseConfirmation(_item: string, category: string, _branch: string): Promise<boolean> { return this.confirmed.has(category); }
  async insertContext(context: OrderLineTaxContext): Promise<void> { this.contexts.push(context); }
  async insertSnapshots(id: string, _currency: string, taxes: readonly ResolvedTaxLine[]): Promise<void> { this.snapshots.set(id, taxes); }
  addExcise(): void {
    this.assignment = { ...this.assignment, additionalTaxCategoryIds: [EXCISE_CATEGORY.id] };
    this.categories.set(EXCISE_CATEGORY.id, EXCISE_CATEGORY);
    this.rates.push(EXCISE_RATE);
    this.confirmed.add(EXCISE_CATEGORY.id);
  }
}
