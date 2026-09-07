import type {
  TaxCategory, TaxCategoryKind, TaxFamily, TaxJurisdiction, TaxLiabilityRule, TaxLiableParty, TaxRate, TaxRoundingStrategy,
} from '../../../domain/contracts/tax.ts';
import { parseLocalizedText } from '../../../domain/contracts/catalog-rules.ts';

export interface CategoryRow {
  id: string; country_code: string; code: string; kind: TaxCategoryKind; tax_family: TaxFamily;
  cascade_priority: number; name: unknown; is_active: boolean;
}
export interface RateRow {
  id: string; tax_category_id: string; rate_bps: number; is_price_inclusive_default: boolean;
  effective_from: string; effective_to: string | null; superseded_by: string | null;
}
export interface JurisdictionRow {
  country_code: string; name: unknown; default_currency_code: string; rounding_strategy: TaxRoundingStrategy; is_active: boolean;
}
export interface LiabilityRow {
  id: string; country_code: string; sales_channel_code: string; delivery_platform_id: string | null;
  applies_when_tenant_registered: boolean; liable_party: TaxLiableParty; effective_from: string; effective_to: string | null;
}
export const RATE_COLUMNS = 'id, tax_category_id, rate_bps, is_price_inclusive_default, effective_from::text, effective_to::text, superseded_by';
export const LIABILITY_COLUMNS = 'id, country_code, sales_channel_code, delivery_platform_id, applies_when_tenant_registered, liable_party, effective_from::text, effective_to::text';
export function mapTaxCategory(r: CategoryRow): TaxCategory {
  return Object.freeze({ id: r.id, countryCode: r.country_code, code: r.code, kind: r.kind, taxFamily: r.tax_family,
    cascadePriority: r.cascade_priority, name: parseLocalizedText(r.name, 'name', { allowEmpty: false }), isActive: r.is_active });
}
export function mapTaxRate(r: RateRow): TaxRate {
  return Object.freeze({ id: r.id, taxCategoryId: r.tax_category_id, rateBps: r.rate_bps,
    isPriceInclusiveDefault: r.is_price_inclusive_default, effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to, supersededBy: r.superseded_by });
}
export function mapJurisdiction(r: JurisdictionRow): TaxJurisdiction {
  return Object.freeze({ countryCode: r.country_code, name: parseLocalizedText(r.name, 'name', { allowEmpty: false }),
    defaultCurrencyCode: r.default_currency_code, roundingStrategy: r.rounding_strategy, isActive: r.is_active });
}
export function mapLiabilityRule(r: LiabilityRow): TaxLiabilityRule {
  return Object.freeze({ id: r.id, countryCode: r.country_code, salesChannelCode: r.sales_channel_code,
    deliveryPlatformId: r.delivery_platform_id, appliesWhenTenantRegistered: r.applies_when_tenant_registered,
    liableParty: r.liable_party, effectiveFrom: r.effective_from, effectiveTo: r.effective_to });
}
