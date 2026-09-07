import type {
  DeliveryPlatform, NewDeliveryPlatform, NewTaxCategory, NewTaxLiabilityRule, NewTaxRate, PlatformTaxAdminRepository,
  SalesChannel, SupersedeTaxRateInput, TaxCategory, TaxJurisdiction, TaxLiabilityRule, TaxRate, TaxRoundingStrategy,
} from '../../../domain/contracts/tax.ts';
import { NotFoundError } from '../../../shared/errors.ts';
import type { WithPlatformTaxContext } from '../platform-tax-context.ts';
import { LIABILITY_COLUMNS, RATE_COLUMNS, mapJurisdiction, mapLiabilityRule, mapTaxCategory, mapTaxRate,
  type CategoryRow, type JurisdictionRow, type LiabilityRow, type RateRow } from './tax-row-mappers.ts';

function first<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new NotFoundError('Tax registry record not found');
  return row;
}
export class PostgresPlatformTaxAdminRepository implements PlatformTaxAdminRepository {
  private readonly withPlatform: WithPlatformTaxContext;
  constructor(withPlatform: WithPlatformTaxContext) { this.withPlatform = withPlatform; }
  async createJurisdiction(actorId: string, input: TaxJurisdiction): Promise<TaxJurisdiction> {
    return this.withPlatform(actorId, async (q) => {
      const r = await q.query<JurisdictionRow>(`INSERT INTO tax_jurisdictions(country_code, name, default_currency_code, rounding_strategy, is_active)
        VALUES ($1,$2::jsonb,$3,$4,$5) RETURNING *`, [input.countryCode, input.name, input.defaultCurrencyCode, input.roundingStrategy, input.isActive]);
      return mapJurisdiction(first(r.rows));
    });
  }
  async configureJurisdiction(actorId: string, countryCode: string, rounding: TaxRoundingStrategy, active: boolean): Promise<void> {
    await this.withPlatform(actorId, async (q) => {
      const r = await q.query('UPDATE tax_jurisdictions SET rounding_strategy = $2, is_active = $3 WHERE country_code = $1 RETURNING country_code', [countryCode, rounding, active]);
      first(r.rows);
    });
  }
  async createCategory(actorId: string, input: NewTaxCategory): Promise<TaxCategory> {
    return this.withPlatform(actorId, async (q) => {
      const r = await q.query<CategoryRow>(`INSERT INTO tax_categories(country_code, code, kind, tax_family, cascade_priority, name, is_active)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING *`, [input.countryCode, input.code, input.kind, input.taxFamily, input.cascadePriority, input.name, input.isActive]);
      return mapTaxCategory(first(r.rows));
    });
  }
  async setCategoryActive(actorId: string, categoryId: string, active: boolean): Promise<void> {
    await this.withPlatform(actorId, async (q) => { first((await q.query('UPDATE tax_categories SET is_active = $2 WHERE id = $1 RETURNING id', [categoryId, active])).rows); });
  }
  async createTaxRate(actorId: string, input: NewTaxRate): Promise<TaxRate> {
    return this.withPlatform(actorId, async (q) => {
      const r = await q.query<RateRow>(`SELECT ${RATE_COLUMNS} FROM create_tax_rate($1,$2,$3,$4::date,$5::date,$6)`,
        [input.taxCategoryId, input.rateBps, input.isPriceInclusiveDefault, input.effectiveFrom, input.effectiveTo, actorId]);
      return mapTaxRate(first(r.rows));
    });
  }
  async closeAndSupersedeTaxRate(actorId: string, input: SupersedeTaxRateInput): Promise<TaxRate> {
    return this.withPlatform(actorId, async (q) => {
      // SECURITY DEFINER function locks the old row, closes it, inserts its
      // successor and invokes the mandatory audit trigger inside THIS TX.
      const r = await q.query<RateRow>(`SELECT ${RATE_COLUMNS} FROM close_and_supersede_tax_rate($1,$2,$3,$4::date,$5)`,
        [input.taxRateId, input.rateBps, input.isPriceInclusiveDefault, input.effectiveFrom, actorId]);
      return mapTaxRate(first(r.rows));
    });
  }
  async createSalesChannel(actorId: string, input: SalesChannel): Promise<SalesChannel> {
    return this.withPlatform(actorId, async (q) => {
      await q.query('INSERT INTO sales_channels(code, name, requires_delivery_platform) VALUES ($1,$2::jsonb,$3)', [input.code, input.name, input.requiresDeliveryPlatform]);
      return Object.freeze({ ...input });
    });
  }
  async createDeliveryPlatform(actorId: string, input: NewDeliveryPlatform): Promise<DeliveryPlatform> {
    return this.withPlatform(actorId, async (q) => {
      const r = await q.query<{ id: string }>('INSERT INTO delivery_platforms(code, name, country_code, is_active) VALUES ($1,$2::jsonb,$3,$4) RETURNING id',
        [input.code, input.name, input.countryCode, input.isActive]);
      return Object.freeze({ ...input, id: first(r.rows).id });
    });
  }
  async createLiabilityRule(actorId: string, input: NewTaxLiabilityRule): Promise<TaxLiabilityRule> {
    return this.withPlatform(actorId, async (q) => {
      const r = await q.query<LiabilityRow>(`INSERT INTO tax_liability_rules(country_code, sales_channel_code, delivery_platform_id,
        applies_when_tenant_registered, liable_party, effective_from, effective_to)
        VALUES ($1,$2,$3,$4,$5,$6::date,$7::date) RETURNING ${LIABILITY_COLUMNS}`,
      [input.countryCode, input.salesChannelCode, input.deliveryPlatformId, input.appliesWhenTenantRegistered, input.liableParty, input.effectiveFrom, input.effectiveTo]);
      return mapLiabilityRule(first(r.rows));
    });
  }
  async closeLiabilityRule(actorId: string, ruleId: string, effectiveTo: string): Promise<void> {
    await this.withPlatform(actorId, async (q) => {
      const r = await q.query(`UPDATE tax_liability_rules SET effective_to = $2::date WHERE id = $1
        AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to >= $2::date) RETURNING id`, [ruleId, effectiveTo]);
      first(r.rows);
    });
  }
}
