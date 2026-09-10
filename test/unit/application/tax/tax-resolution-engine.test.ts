import { beforeEach, describe, expect, it } from 'vitest';
import { resolveInvoiceAndSnapshot, TaxResolutionEngine } from '../../../../src/application/engines/tax/tax-resolution-engine.ts';
import { calculateCascadingTaxes } from '../../../../src/application/engines/tax/cascading.ts';
import { ExciseConfirmationRequiredError, InvoiceTaxBatchRequiredError, NoApplicableTaxLiabilityRuleError, NoApplicableTaxRateError,
  TaxConfigurationError, TenantIsolationViolationError } from '../../../../src/shared/errors.ts';
import { FakeTaxTransaction, EXCISE_CATEGORY, EXCISE_RATE, RESTAURANT_RULE, TAX_AT, TAX_BRANCH, TAX_ITEM, TAX_LINE, TAX_PLATFORM, TAX_TENANT, VAT_CATEGORY, VAT_RATE } from '../../../support/tax-fakes.ts';

function existing<T>(value: T | null | undefined): T { if (value === null || value === undefined) throw new Error('Expected fixture value'); return value; }

describe('data-driven TaxResolutionEngine', () => {
  let tx: FakeTaxTransaction;
  let engine: TaxResolutionEngine;
  beforeEach(() => { tx = new FakeTaxTransaction(); engine = new TaxResolutionEngine({ transaction: tx, orderLineId: TAX_LINE }); });
  const resolve = (amount = 1000n, channel = 'dine_in', platform: string | null = null, at = TAX_AT) =>
    engine.resolveAndSnapshot(TAX_TENANT, TAX_BRANCH, TAX_ITEM, amount, 'SAR', at, channel, platform);

  it('VAT-only produces one row, never phantom excise; liability is resolved first', async () => {
    expect(await resolve()).toEqual([{ taxRateId: VAT_RATE.id, taxFamily: 'vat', computationSequence: 1, liableParty: 'restaurant',
      rateBps: 1500, isPriceInclusive: false, taxableAmountMinor: 1000n, taxAmountMinor: 150n }]);
    expect(tx.calls[0]).toBe('liability');
    expect(tx.snapshots.get(TAX_LINE)).toHaveLength(1);
  });
  it('extracts inclusive VAT from 1150 minor units (net=1000, tax=150)', async () => {
    tx.rates = [{ ...VAT_RATE, isPriceInclusiveDefault: true }];
    expect(await resolve(1150n)).toMatchObject([{ taxableAmountMinor: 1000n, taxAmountMinor: 150n }]);
  });
  it('cascades excise 100% BEFORE VAT 15%: base 1000 -> excise 1000 -> VAT base 2000/tax 300', async () => {
    tx.addExcise();
    const result = await resolve();
    expect(result).toMatchObject([
      { taxFamily: 'excise', computationSequence: 1, taxableAmountMinor: 1000n, taxAmountMinor: 1000n },
      { taxFamily: 'vat', computationSequence: 2, taxableAmountMinor: 2000n, taxAmountMinor: 300n },
    ]);
    expect(tx.snapshots.get(TAX_LINE)).toEqual(result);
    expect(Object.isFrozen(result)).toBe(true);
  });
  it('applies inclusivity independently at each cascade stage', async () => {
    tx.addExcise(); tx.rates = [{ ...VAT_RATE, isPriceInclusiveDefault: true }, EXCISE_RATE];
    expect(await resolve()).toMatchObject([
      { taxableAmountMinor: 1000n, taxAmountMinor: 1000n },
      { taxableAmountMinor: 1739n, taxAmountMinor: 261n },
    ]);
  });
  it('equal priorities use the same original base (stable UUID tie-break), not each other’s tax', () => {
    const second = { ...VAT_CATEGORY, id: EXCISE_CATEGORY.id };
    const r2 = { ...VAT_RATE, id: EXCISE_RATE.id, taxCategoryId: second.id, rateBps: 500 };
    const result = calculateCascadingTaxes([{ orderLineId: TAX_LINE, amountMinor: 1000n, currencyCode: 'SAR',
      taxes: [{ category: second, rate: r2 }, { category: VAT_CATEGORY, rate: VAT_RATE }] }], 'per_line').get(TAX_LINE);
    expect(result).toMatchObject([
      { taxRateId: VAT_RATE.id, taxableAmountMinor: 1000n, taxAmountMinor: 150n },
      { taxRateId: r2.id, taxableAmountMinor: 1000n, taxAmountMinor: 50n },
    ]);
  });
  it('rejects priority data that would put excise after/equal to VAT', async () => {
    tx.addExcise(); tx.categories.set(EXCISE_CATEGORY.id, { ...EXCISE_CATEGORY, cascadePriority: 50 });
    await expect(resolve()).rejects.toBeInstanceOf(TaxConfigurationError);
  });
  it('rejects missing rates instead of silently using zero', async () => {
    tx.rates = [];
    await expect(resolve()).rejects.toBeInstanceOf(NoApplicableTaxRateError);
    expect(tx.contexts).toHaveLength(0);
  });
  it('requires explicit primary category even if optional categories exist', async () => {
    tx.assignment = { ...tx.assignment, taxRuleId: null };
    await expect(resolve()).rejects.toBeInstanceOf(TaxConfigurationError);
  });
  it('requires an excise confirmation for every resolved product/category', async () => {
    tx.addExcise(); tx.confirmed.clear();
    await expect(resolve()).rejects.toBeInstanceOf(ExciseConfirmationRequiredError);
  });
  it('no_vat must remain zero without an end date or successor', async () => {
    tx.categories.set(VAT_CATEGORY.id, { ...VAT_CATEGORY, kind: 'no_vat' });
    tx.rates = [{ ...VAT_RATE, rateBps: 0 }];
    expect(await resolve(999999n)).toMatchObject([{ taxAmountMinor: 0n }]);
    tx.rates = [{ ...VAT_RATE, rateBps: 1 }];
    await expect(resolve()).rejects.toBeInstanceOf(TaxConfigurationError);
  });
  it('applies branch overrides but refuses target categories outside the branch country', async () => {
    const override = { ...VAT_CATEGORY, id: EXCISE_CATEGORY.id, code: 'reduced', kind: 'reduced' as const };
    tx.categories.set(override.id, override); tx.overrides.set(VAT_CATEGORY.id, override.id);
    tx.rates.push({ ...VAT_RATE, id: EXCISE_RATE.id, taxCategoryId: override.id, rateBps: 500 });
    expect(await resolve()).toMatchObject([{ taxRateId: EXCISE_RATE.id, taxAmountMinor: 50n }]);
    tx.categories.set(override.id, { ...override, countryCode: 'AE' });
    await expect(resolve()).rejects.toBeInstanceOf(TaxConfigurationError);
  });
  it('refuses override collisions rather than double-charging the same resolved rate', async () => {
    const second = { ...VAT_CATEGORY, id: EXCISE_CATEGORY.id };
    tx.categories.set(second.id, second); tx.assignment = { ...tx.assignment, additionalTaxCategoryIds: [second.id] };
    tx.overrides.set(second.id, VAT_CATEGORY.id);
    await expect(resolve()).rejects.toThrow(/same tax category/);
  });
  it('marketplace + unregistered returns immediately, even with missing menu tax configuration/rates', async () => {
    tx.registered = 'unregistered'; tx.rates = []; tx.assignment = { ...tx.assignment, taxRuleId: null };
    tx.rules = [{ ...RESTAURANT_RULE, salesChannelCode: 'delivery_app', deliveryPlatformId: TAX_PLATFORM,
      appliesWhenTenantRegistered: false, liableParty: 'marketplace' }];
    expect(await resolve(1000n, 'delivery_app', TAX_PLATFORM)).toEqual({ kind: 'external_tax_liability', liableParty: 'marketplace',
      liabilityRuleId: RESTAURANT_RULE.id, countryCode: 'SA', salesChannel: 'delivery_app', deliveryPlatformId: TAX_PLATFORM,
      restaurantTaxInvoiceAllowed: false });
    expect(tx.calls).toEqual(['liability']);
    expect(tx.snapshots.size).toBe(0);
    expect(tx.contexts[0]?.liableParty).toBe('marketplace');
  });
  it('same marketplace, registered tenant: normal restaurant calculation', async () => {
    tx.rules = [
      { ...RESTAURANT_RULE, salesChannelCode: 'delivery_app', deliveryPlatformId: TAX_PLATFORM,
        appliesWhenTenantRegistered: false, liableParty: 'marketplace' },
      { ...RESTAURANT_RULE, salesChannelCode: 'delivery_app', deliveryPlatformId: TAX_PLATFORM },
    ];
    expect(await resolve(1000n, 'delivery_app', TAX_PLATFORM)).toMatchObject([{ liableParty: 'restaurant', taxAmountMinor: 150n }]);
  });
  it('requires an explicit liability row for all channels, especially delivery_app', async () => {
    await expect(resolve(1000n, 'delivery_app', TAX_PLATFORM)).rejects.toBeInstanceOf(NoApplicableTaxLiabilityRuleError);
    expect(tx.calls).toEqual(['liability']);
  });
  it('requires the platform presence/availability dictated by channel data', async () => {
    await expect(resolve(1000n, 'delivery_app', null)).rejects.toThrow(/presence/);
    await expect(resolve(1000n, 'dine_in', TAX_PLATFORM)).rejects.toThrow(/presence/);
    tx.platforms.clear();
    await expect(resolve(1000n, 'delivery_app', TAX_PLATFORM)).rejects.toThrow(/platform/);
  });
  it('exact platform rule wins over an explicit wildcard; ambiguous specificity fails', async () => {
    tx.rules = [{ ...RESTAURANT_RULE, salesChannelCode: 'delivery_app', liableParty: 'marketplace' },
      { ...RESTAURANT_RULE, id: 'exact', salesChannelCode: 'delivery_app', deliveryPlatformId: TAX_PLATFORM }];
    expect(await resolve(1000n, 'delivery_app', TAX_PLATFORM)).toMatchObject([{ liableParty: 'restaurant' }]);
    tx.rules.push({ ...existing(tx.rules[1]), id: 'ambiguous' });
    await expect(resolve(1000n, 'delivery_app', TAX_PLATFORM)).rejects.toThrow(/Ambiguous/);
  });
  it('uses branch local date and closed effective intervals', async () => {
    tx.rates = [{ ...VAT_RATE, rateBps: 500, effectiveTo: '2026-09-06' }, { ...VAT_RATE, id: 'next', effectiveFrom: '2026-09-07' }];
    expect(await resolve(1000n, 'dine_in', null, new Date('2026-09-06T20:59:59Z'))).toMatchObject([{ rateBps: 500 }]);
    expect(await resolve(1000n, 'dine_in', null, new Date('2026-09-06T21:00:00Z'))).toMatchObject([{ rateBps: 1500 }]);
  });
  it('does not contain a country/channel allow-list: unseen data works unchanged', async () => {
    tx.branch = { ...tx.branch, countryCode: 'XZ', jurisdiction: { ...existing(tx.branch.jurisdiction), countryCode: 'XZ' } };
    tx.categories.set(VAT_CATEGORY.id, { ...VAT_CATEGORY, countryCode: 'XZ' });
    tx.channels.set('robot_pickup', { code: 'robot_pickup', name: { xx: 'Robot' }, requiresDeliveryPlatform: false });
    tx.rules = [{ ...RESTAURANT_RULE, countryCode: 'XZ', salesChannelCode: 'robot_pickup' }];
    tx.rates = [{ ...VAT_RATE, rateBps: 1234 }];
    expect(await resolve(10000n, 'robot_pickup')).toMatchObject([{ taxAmountMinor: 1234n }]);
  });
  it('fails closed on wrong tenant, currency, invalid amounts/date, and unbackfilled branches', async () => {
    await expect(engine.resolveAndSnapshot('other', TAX_BRANCH, TAX_ITEM, 100n, 'SAR', TAX_AT, 'dine_in', null)).rejects.toBeInstanceOf(TenantIsolationViolationError);
    await expect(engine.resolveAndSnapshot(TAX_TENANT, TAX_BRANCH, TAX_ITEM, 100n, 'USD', TAX_AT, 'dine_in', null)).rejects.toThrow(/currency/);
    await expect(resolve(-1n)).rejects.toThrow();
    await expect(resolve(100n, 'dine_in', null, new Date('invalid'))).rejects.toThrow();
    tx.branch = { ...tx.branch, countryCode: null };
    await expect(resolve()).rejects.toThrow(/backfilled/);
  });
  it('invoice_total requires a whole invoice, rounds once, and allocates by line UUID', async () => {
    tx.branch = { ...tx.branch, jurisdiction: { ...existing(tx.branch.jurisdiction), roundingStrategy: 'invoice_total' } };
    tx.rates = [{ ...VAT_RATE, rateBps: 500 }];
    await expect(resolve(10n)).rejects.toBeInstanceOf(InvoiceTaxBatchRequiredError);
    expect(tx.contexts).toHaveLength(0);
    const requests = ['b', 'a'].map((id) => ({ orderLineId: id, branchId: TAX_BRANCH, menuItemId: TAX_ITEM,
      grossOrNetAmountMinor: 10n, currencyCode: 'SAR', at: TAX_AT, salesChannel: 'dine_in', deliveryPlatformId: null }));
    const result = await resolveInvoiceAndSnapshot(tx, TAX_TENANT, requests);
    expect(result.get('a')).toMatchObject([{ taxAmountMinor: 1n }]);
    expect(result.get('b')).toMatchObject([{ taxAmountMinor: 0n }]);
    expect(tx.contexts).toHaveLength(2);
  });
  it('invoice-total cascading uses allocated excise in each following VAT base', () => {
    const plans = ['b', 'a'].map((id) => ({ orderLineId: id, currencyCode: 'SAR', amountMinor: 1n,
      taxes: [{ category: VAT_CATEGORY, rate: { ...VAT_RATE, rateBps: 5000 } },
        { category: EXCISE_CATEGORY, rate: { ...EXCISE_RATE, rateBps: 5000 } }] }));
    const result = calculateCascadingTaxes(plans, 'invoice_total');
    expect(result.get('a')).toMatchObject([{ taxAmountMinor: 1n }, { taxableAmountMinor: 2n, taxAmountMinor: 1n }]);
    expect(result.get('b')).toMatchObject([{ taxAmountMinor: 0n }, { taxableAmountMinor: 1n, taxAmountMinor: 1n }]);
  });
  it('B6 mixed-direction cascade: inclusive lower NEVER cascades, exclusive lower ALWAYS does', () => {
    const result = calculateCascadingTaxes([
      { orderLineId: 'incl-lower', amountMinor: 1000n, currencyCode: 'SAR',
        taxes: [{ category: EXCISE_CATEGORY, rate: { ...EXCISE_RATE, isPriceInclusiveDefault: true } },
          { category: VAT_CATEGORY, rate: VAT_RATE }] },
      { orderLineId: 'excl-lower', amountMinor: 1000n, currencyCode: 'SAR',
        taxes: [{ category: EXCISE_CATEGORY, rate: EXCISE_RATE },
          { category: VAT_CATEGORY, rate: { ...VAT_RATE, isPriceInclusiveDefault: true } }] },
    ], 'per_line');
    // Direction A (the B6 fix — Saudi tobacco): the embedded 500 does NOT
    // inflate the VAT base (pre-fix this VAT read 225 on a 1500 base).
    expect(result.get('incl-lower')).toMatchObject([
      { taxFamily: 'excise', taxableAmountMinor: 500n, taxAmountMinor: 500n },
      { taxFamily: 'vat', taxableAmountMinor: 1000n, taxAmountMinor: 150n },
    ]);
    // Direction B (preserved): the on-top 1000 DOES enter the VAT base.
    expect(result.get('excl-lower')).toMatchObject([
      { taxFamily: 'excise', taxableAmountMinor: 1000n, taxAmountMinor: 1000n },
      { taxFamily: 'vat', taxableAmountMinor: 1739n, taxAmountMinor: 261n },
    ]);
  });
});
