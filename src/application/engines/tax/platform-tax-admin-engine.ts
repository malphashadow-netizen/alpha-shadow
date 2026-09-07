/** Platform-only administration. Never constructed with a tenant repository. */
import type {
  DeliveryPlatform, NewDeliveryPlatform, NewTaxCategory, NewTaxLiabilityRule, NewTaxRate,
  PlatformTaxAdminRepository, SalesChannel, SupersedeTaxRateInput, TaxCategory, TaxJurisdiction,
  TaxLiabilityRule, TaxRate, TaxRoundingStrategy,
} from '../../../domain/contracts/tax.ts';
import { assertCountryCode, assertTaxDate, assertTaxDateRange } from '../../../domain/contracts/tax-rules.ts';
import { parseLocalizedText } from '../../../domain/contracts/catalog-rules.ts';
import { ValidationError } from '../../../shared/errors.ts';
import { assertTaxRateBps } from '../../../shared/tax-math.ts';

function nonEmpty(value: string, field: string): void {
  if (value.trim() === '') throw new ValidationError(`${field} must be non-empty`, field);
}
function rounding(value: string): void {
  if (value !== 'per_line' && value !== 'invoice_total') throw new ValidationError('Invalid tax rounding strategy');
}
export class PlatformTaxAdminEngine {
  private readonly repository: PlatformTaxAdminRepository;
  constructor(repository: PlatformTaxAdminRepository) { this.repository = repository; }
  async createJurisdiction(actorId: string, input: TaxJurisdiction): Promise<TaxJurisdiction> {
    assertCountryCode(input.countryCode); rounding(input.roundingStrategy);
    if (!/^[A-Z]{3}$/.test(input.defaultCurrencyCode)) throw new ValidationError('Invalid currency code');
    return this.repository.createJurisdiction(actorId, { ...input, name: parseLocalizedText(input.name, 'name', { allowEmpty: false }) });
  }
  async configureJurisdiction(actorId: string, countryCode: string, strategy: TaxRoundingStrategy, active: boolean): Promise<void> {
    assertCountryCode(countryCode); rounding(strategy);
    await this.repository.configureJurisdiction(actorId, countryCode, strategy, active);
  }
  async createCategory(actorId: string, input: NewTaxCategory): Promise<TaxCategory> {
    assertCountryCode(input.countryCode); nonEmpty(input.code, 'code');
    if (!Number.isInteger(input.cascadePriority) || input.cascadePriority < -32_768 || input.cascadePriority > 32_767) {
      throw new ValidationError('cascadePriority must be a SMALLINT');
    }
    if (!['standard', 'reduced', 'zero_rated', 'exempt', 'no_vat'].includes(input.kind) ||
      !['vat', 'excise'].includes(input.taxFamily) || (input.kind === 'no_vat' && input.taxFamily !== 'vat')) {
      throw new ValidationError('Invalid tax category kind/family');
    }
    return this.repository.createCategory(actorId, { ...input, name: parseLocalizedText(input.name, 'name', { allowEmpty: false }) });
  }
  async setCategoryActive(actorId: string, categoryId: string, active: boolean): Promise<void> {
    await this.repository.setCategoryActive(actorId, categoryId, active);
  }
  async createTaxRate(actorId: string, input: NewTaxRate): Promise<TaxRate> {
    assertTaxRateBps(input.rateBps); assertTaxDateRange(input.effectiveFrom, input.effectiveTo);
    return this.repository.createTaxRate(actorId, input);
  }
  /** Sole exposed mutation. The repository guarantees close+new rate+audit in one transaction. */
  async closeAndSupersedeTaxRate(actorId: string, input: SupersedeTaxRateInput): Promise<TaxRate> {
    assertTaxRateBps(input.rateBps); assertTaxDate(input.effectiveFrom);
    return this.repository.closeAndSupersedeTaxRate(actorId, input);
  }
  async createSalesChannel(actorId: string, input: SalesChannel): Promise<SalesChannel> {
    nonEmpty(input.code, 'code');
    return this.repository.createSalesChannel(actorId, { ...input, name: parseLocalizedText(input.name, 'name', { allowEmpty: false }) });
  }
  async createDeliveryPlatform(actorId: string, input: NewDeliveryPlatform): Promise<DeliveryPlatform> {
    nonEmpty(input.code, 'code'); if (input.countryCode !== null) assertCountryCode(input.countryCode);
    return this.repository.createDeliveryPlatform(actorId, { ...input, name: parseLocalizedText(input.name, 'name', { allowEmpty: false }) });
  }
  async createLiabilityRule(actorId: string, input: NewTaxLiabilityRule): Promise<TaxLiabilityRule> {
    assertCountryCode(input.countryCode); assertTaxDateRange(input.effectiveFrom, input.effectiveTo);
    nonEmpty(input.salesChannelCode, 'salesChannelCode');
    if (!['restaurant', 'marketplace'].includes(input.liableParty)) throw new ValidationError('Invalid liable party');
    return this.repository.createLiabilityRule(actorId, input);
  }
  async closeLiabilityRule(actorId: string, ruleId: string, effectiveTo: string): Promise<void> {
    assertTaxDate(effectiveTo);
    await this.repository.closeLiabilityRule(actorId, ruleId, effectiveTo);
  }
}
