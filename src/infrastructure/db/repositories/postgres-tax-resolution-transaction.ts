/** Transaction-scoped adapter. No pool, no BEGIN/COMMIT, no direct pg import. */
import type {
  DeliveryPlatform, MenuItemTaxAssignment, OrderLineTaxContext, ResolvedTaxLine, SalesChannel,
  TaxBranch, TaxCategory, TaxLiabilityRule, TaxRate, TaxResolutionTransaction, TaxRoundingStrategy, VatRegistrationStatus,
} from '../../../domain/contracts/tax.ts';
import { parseLocalizedText } from '../../../domain/contracts/catalog-rules.ts';
import { ConflictError, NotFoundError, TaxConfigurationError } from '../../../shared/errors.ts';
import { minorUnitsToDb } from '../../../shared/money.ts';
import type { TenantQuery } from '../tenant-context.ts';
import { LIABILITY_COLUMNS, RATE_COLUMNS, mapLiabilityRule, mapTaxCategory, mapTaxRate, type CategoryRow, type LiabilityRow, type RateRow } from './tax-row-mappers.ts';

export class PostgresTaxResolutionTransaction implements TaxResolutionTransaction {
  readonly tenantId: string;
  private readonly q: TenantQuery;
  private active = true;
  constructor(q: TenantQuery, tenantId: string) { this.q = q; this.tenantId = tenantId; }
  close(): void { this.active = false; }
  private get query(): TenantQuery {
    if (!this.active) throw new ConflictError('Tax transaction scope has ended');
    return this.q;
  }
  async getBranch(branchId: string): Promise<TaxBranch | null> {
    const r = await this.query.query<{
      id: string; country_code: string | null; base_currency: string; timezone: string; is_active: boolean;
      jurisdiction_name: unknown; default_currency_code: string | null; rounding_strategy: TaxRoundingStrategy | null; jurisdiction_active: boolean | null;
    }>(`SELECT b.id, b.country_code, b.base_currency, b.timezone, b.is_active,
          j.name AS jurisdiction_name, j.default_currency_code, j.rounding_strategy, j.is_active AS jurisdiction_active
        FROM branches b LEFT JOIN tax_jurisdictions j ON j.country_code = b.country_code
        WHERE b.id = $1 AND b.tenant_id = $2`, [branchId, this.tenantId]);
    const row = r.rows[0];
    if (row === undefined) return null;
    const jurisdiction = row.country_code === null || row.default_currency_code === null || row.rounding_strategy === null || row.jurisdiction_active === null
      ? null : { countryCode: row.country_code, name: parseLocalizedText(row.jurisdiction_name, 'name', { allowEmpty: false }),
        defaultCurrencyCode: row.default_currency_code, roundingStrategy: row.rounding_strategy, isActive: row.jurisdiction_active };
    return { id: row.id, countryCode: row.country_code, currencyCode: row.base_currency, timezone: row.timezone, isActive: row.is_active, jurisdiction };
  }
  async getVatRegistrationStatus(): Promise<VatRegistrationStatus> {
    const r = await this.query.query<{ vat_registration_status: VatRegistrationStatus }>('SELECT vat_registration_status FROM tenants WHERE id = $1', [this.tenantId]);
    const row = r.rows[0];
    if (row === undefined) throw new NotFoundError('Tenant not found');
    return row.vat_registration_status;
  }
  async getSalesChannel(code: string): Promise<SalesChannel | null> {
    const r = await this.query.query<{ code: string; name: unknown; requires_delivery_platform: boolean }>(
      'SELECT code, name, requires_delivery_platform FROM sales_channels WHERE code = $1', [code]);
    const row = r.rows[0];
    return row === undefined ? null : { code: row.code, name: parseLocalizedText(row.name, 'name', { allowEmpty: false }), requiresDeliveryPlatform: row.requires_delivery_platform };
  }
  async getDeliveryPlatform(id: string): Promise<DeliveryPlatform | null> {
    const r = await this.query.query<{ id: string; code: string; name: unknown; country_code: string | null; is_active: boolean }>(
      'SELECT id, code, name, country_code, is_active FROM delivery_platforms WHERE id = $1', [id]);
    const row = r.rows[0];
    return row === undefined ? null : { id: row.id, code: row.code, name: parseLocalizedText(row.name, 'name', { allowEmpty: false }),
      countryCode: row.country_code, isActive: row.is_active };
  }
  async findLiabilityRules(countryCode: string, salesChannel: string, deliveryPlatformId: string | null, registered: boolean, on: string): Promise<readonly TaxLiabilityRule[]> {
    const r = await this.query.query<LiabilityRow>(`SELECT ${LIABILITY_COLUMNS} FROM tax_liability_rules
      WHERE country_code = $1 AND sales_channel_code = $2 AND applies_when_tenant_registered = $4
        AND (delivery_platform_id = $3::uuid OR delivery_platform_id IS NULL)
        AND effective_from <= $5::date AND (effective_to IS NULL OR effective_to >= $5::date)`,
    [countryCode, salesChannel, deliveryPlatformId, registered, on]);
    return r.rows.map(mapLiabilityRule);
  }
  async getMenuItemAssignment(menuItemId: string): Promise<MenuItemTaxAssignment | null> {
    const r = await this.query.query<{ id: string; is_active: boolean; tax_rule_id: string | null; additional_ids: string[] }>(
      `SELECT m.id, m.is_active, m.tax_rule_id,
        ARRAY(SELECT a.tax_category_id FROM menu_item_additional_tax_categories a WHERE a.menu_item_id = m.id ORDER BY a.tax_category_id) AS additional_ids
       FROM menu_items m WHERE m.id = $1 AND m.tenant_id = $2`, [menuItemId, this.tenantId]);
    const row = r.rows[0];
    return row === undefined ? null : { menuItemId: row.id, isActive: row.is_active, taxRuleId: row.tax_rule_id, additionalTaxCategoryIds: row.additional_ids };
  }
  async getCategory(id: string): Promise<TaxCategory | null> {
    const r = await this.query.query<CategoryRow>('SELECT * FROM tax_categories WHERE id = $1', [id]);
    return r.rows[0] === undefined ? null : mapTaxCategory(r.rows[0]);
  }
  async getBranchOverride(branchId: string, originalCategoryId: string): Promise<string | null> {
    const r = await this.query.query<{ override_tax_category_id: string }>(`SELECT override_tax_category_id FROM branch_tax_category_overrides
      WHERE tenant_id = $1 AND branch_id = $2 AND menu_item_tax_category_id = $3`, [this.tenantId, branchId, originalCategoryId]);
    return r.rows[0]?.override_tax_category_id ?? null;
  }
  async getApplicableRate(categoryId: string, on: string): Promise<TaxRate | null> {
    const r = await this.query.query<RateRow>(`SELECT ${RATE_COLUMNS} FROM tax_rates WHERE tax_category_id = $1
      AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to >= $2::date)`, [categoryId, on]);
    if (r.rows.length > 1) throw new TaxConfigurationError('Overlapping tax rates');
    return r.rows[0] === undefined ? null : mapTaxRate(r.rows[0]);
  }
  async hasExciseConfirmation(menuItemId: string, categoryId: string, branchId: string): Promise<boolean> {
    const r = await this.query.query<{ confirmed: boolean }>(`SELECT EXISTS (SELECT 1 FROM menu_item_excise_confirmations
      WHERE tenant_id = $1 AND menu_item_id = $2 AND tax_category_id = $3 AND (branch_id IS NULL OR branch_id = $4)) AS confirmed`,
    [this.tenantId, menuItemId, categoryId, branchId]);
    return r.rows[0]?.confirmed === true;
  }
  async insertContext(context: OrderLineTaxContext): Promise<void> {
    await this.query.query(`INSERT INTO order_line_tax_contexts
      (order_line_id, tenant_id, branch_id, menu_item_id, customer_amount_minor, currency_code,
       sales_channel_code, delivery_platform_id, liability_rule_id, liable_party, rounding_strategy, occurred_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [context.orderLineId, this.tenantId, context.branchId,
      context.menuItemId, minorUnitsToDb(context.grossOrNetAmountMinor), context.currencyCode, context.salesChannel,
      context.deliveryPlatformId, context.liabilityRuleId, context.liableParty, context.roundingStrategy, context.at]);
  }
  async insertSnapshots(orderLineId: string, currencyCode: string, taxes: readonly ResolvedTaxLine[]): Promise<void> {
    for (const tax of taxes) {
      await this.query.query(`INSERT INTO order_line_tax_snapshots
        (order_line_id, tax_rate_id, tax_family, computation_sequence, liable_party, rate_bps_snapshot,
         is_price_inclusive_snapshot, taxable_amount_minor, tax_amount_minor, currency_code)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [orderLineId, tax.taxRateId, tax.taxFamily, tax.computationSequence,
        tax.liableParty, tax.rateBps, tax.isPriceInclusive, minorUnitsToDb(tax.taxableAmountMinor), minorUnitsToDb(tax.taxAmountMinor), currencyCode]);
    }
  }
}
