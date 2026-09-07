import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogEngine } from '../../../../src/application/engines/catalog/catalog-engine.ts';
import { PlatformTaxAdminEngine } from '../../../../src/application/engines/tax/platform-tax-admin-engine.ts';
import { TenantTaxAdminEngine } from '../../../../src/application/engines/tax/tenant-tax-admin-engine.ts';
import { EXCISE_CONFIRMATION_TEXT, type TenantTaxActor, type TenantTaxAdminRepository } from '../../../../src/domain/contracts/tenant-tax-admin.ts';
import type { NewTaxRate, PlatformTaxAdminRepository, SupersedeTaxRateInput } from '../../../../src/domain/contracts/tax.ts';
import { assertOrdinaryTaxCategory } from '../../../../src/domain/contracts/tax-rules.ts';
import { InMemoryCatalogRepository, InMemoryCatalogStore } from '../../../../src/infrastructure/db/repositories/in-memory-catalog-repository.ts';
import { createTenantTaxAdminHandlers } from '../../../../src/presentation/routes/tax-admin.ts';
import { ExciseConfirmationRequiredError, ForbiddenError } from '../../../../src/shared/errors.ts';
import { currencyCode, money } from '../../../../src/shared/money.ts';
import { EXCISE_CATEGORY, TAX_ACTOR, TAX_BRANCH, TAX_ITEM, TAX_TENANT, VAT_CATEGORY, VAT_RATE } from '../../../support/tax-fakes.ts';

function tenantFixture() {
  const check = vi.fn(async () => ({ allowed: true as const, effectiveMaxAmountMinorUnits: null }));
  const repository: TenantTaxAdminRepository = {
    getCategory: vi.fn(async (_tid: string, id: string) => id === EXCISE_CATEGORY.id ? EXCISE_CATEGORY : VAT_CATEGORY),
    getBranchCountry: vi.fn(async () => 'SA'),
    assignAdditionalCategory: vi.fn(async () => undefined), removeAdditionalCategory: vi.fn(async () => undefined),
    setBranchOverride: vi.fn(async () => undefined), removeBranchOverride: vi.fn(async () => undefined),
    confirmExciseAssignment: vi.fn(async () => undefined), confirmExciseBranchOverride: vi.fn(async () => undefined),
    setVatRegistration: vi.fn(async () => undefined),
  };
  const actor: TenantTaxActor = { tenantId: TAX_TENANT, userId: TAX_ACTOR, tokenSecV: 'verified-sec-v' };
  const engine = new TenantTaxAdminEngine({ repository, authorization: { check } });
  return { repository, check, actor, engine };
}

describe('separate tenant tax administration and explicit excise interface', () => {
  let f: ReturnType<typeof tenantFixture>;
  beforeEach(() => { f = tenantFixture(); });
  it('ordinary additional assignment and branch overrides cannot introduce excise', async () => {
    await expect(f.engine.assignAdditionalCategory(f.actor, TAX_ITEM, EXCISE_CATEGORY.id)).rejects.toBeInstanceOf(ExciseConfirmationRequiredError);
    expect(f.repository.assignAdditionalCategory).not.toHaveBeenCalled();
    await expect(f.engine.setBranchOverride(f.actor, { branchId: TAX_BRANCH, menuItemTaxCategoryId: VAT_CATEGORY.id, overrideTaxCategoryId: EXCISE_CATEGORY.id })).rejects.toThrow(/family/);
    expect(f.repository.setBranchOverride).not.toHaveBeenCalled();
  });
  it('confirmation must be exact, sensitive uncached permission is explicit, and authenticated identity is preserved', async () => {
    const input = { menuItemId: TAX_ITEM, taxCategoryId: EXCISE_CATEGORY.id, slot: 'additional' as const, confirmation: EXCISE_CONFIRMATION_TEXT };
    await expect(f.engine.confirmExciseAssignment(f.actor, { ...input, confirmation: 'yes' })).rejects.toBeInstanceOf(ExciseConfirmationRequiredError);
    expect(f.repository.confirmExciseAssignment).not.toHaveBeenCalled();
    await f.engine.confirmExciseAssignment(f.actor, input);
    expect(f.check).toHaveBeenLastCalledWith({ tenantId: TAX_TENANT, userId: TAX_ACTOR, tokenSecV: f.actor.tokenSecV,
      permissionKey: 'tax:confirm_excise', context: { hasResource: false, actorBranchId: null, isSensitivePermission: true } });
    expect(f.repository.confirmExciseAssignment).toHaveBeenCalledExactlyOnceWith(f.actor, input);
  });
  it('authorization denial prevents every administrative write, even with the right confirmation', async () => {
    f.check.mockRejectedValue(new ForbiddenError('Denied'));
    await expect(f.engine.confirmExciseAssignment(f.actor, { menuItemId: TAX_ITEM, taxCategoryId: EXCISE_CATEGORY.id, slot: 'primary', confirmation: EXCISE_CONFIRMATION_TEXT })).rejects.toBeInstanceOf(ForbiddenError);
    expect(f.repository.confirmExciseAssignment).not.toHaveBeenCalled();
  });
  it('registration requires a number for registered tenants, but excise is not inferred from VAT registration', async () => {
    await expect(f.engine.setVatRegistration(f.actor, 'registered', null)).rejects.toThrow(/number/);
    await expect(f.engine.setVatRegistration(f.actor, 'registered', '  ')).rejects.toThrow(/number/);
    await f.engine.setVatRegistration(f.actor, 'registered', 'VAT-EXPLICIT');
    expect(f.repository.setVatRegistration).toHaveBeenCalledExactlyOnceWith(f.actor, 'registered', 'VAT-EXPLICIT');
    expect(f.repository.confirmExciseAssignment).not.toHaveBeenCalled();
  });
  it('admin transport rejects unauthenticated requests, spoofed identities, and missing confirmation', async () => {
    const handlers = createTenantTaxAdminHandlers(f.engine, () => undefined);
    expect(handlers.confirmationPrompt).toEqual({ confirmationText: EXCISE_CONFIRMATION_TEXT, automaticAssignmentAllowed: false });
    const body = { menuItemId: TAX_ITEM, taxCategoryId: EXCISE_CATEGORY.id, slot: 'additional', confirmation: EXCISE_CONFIRMATION_TEXT };
    expect((await handlers.confirmExciseAssignment({ actor: null, body })).status).toBe(401);
    expect((await handlers.confirmExciseAssignment({ actor: f.actor, body: { ...body, tenantId: 'spoof' } })).status).toBe(400);
    expect((await handlers.confirmExciseAssignment({ actor: f.actor, body: { ...body, confirmation: '' } })).status).toBe(400);
    expect(f.repository.confirmExciseAssignment).not.toHaveBeenCalled();
    expect((await handlers.confirmExciseAssignment({ actor: f.actor, body })).status).toBe(200);
    expect((await handlers.assignAdditionalCategory({ actor: f.actor, body })).status).toBe(403);
  });
});

describe('catalog tax hook is no longer an unvalidated UUID or excise bypass', () => {
  it('fails closed without a policy, rejects excise via engine and direct repository, and permits unchanged excise on name-only edits', async () => {
    const store = new InMemoryCatalogStore(); store.taxCategories.set(VAT_CATEGORY.id, VAT_CATEGORY); store.taxCategories.set(EXCISE_CATEGORY.id, EXCISE_CATEGORY);
    const repo = new InMemoryCatalogRepository(store);
    const plain = new CatalogEngine({ catalog: repo });
    const category = await plain.createCategory(TAX_TENANT, { name: { en: 'Drinks' } });
    const input = { categoryId: category.id, name: { en: 'Energy drink' }, basePrice: money(1000n, currencyCode('SAR')) };
    await expect(plain.createItem(TAX_TENANT, { ...input, taxRuleId: VAT_CATEGORY.id })).rejects.toThrow(/policy/);
    const policy = { assertOrdinaryAssignment: vi.fn(async (_tid: string, id: string) => { assertOrdinaryTaxCategory(id === EXCISE_CATEGORY.id ? EXCISE_CATEGORY : VAT_CATEGORY); }) };
    const engine = new CatalogEngine({ catalog: repo, taxAssignments: policy });
    await expect(engine.createItem(TAX_TENANT, { ...input, taxRuleId: EXCISE_CATEGORY.id })).rejects.toBeInstanceOf(ExciseConfirmationRequiredError);
    const item = await engine.createItem(TAX_TENANT, { ...input, taxRuleId: VAT_CATEGORY.id });
    await expect(repo.updateItem(TAX_TENANT, { ...item, taxRuleId: EXCISE_CATEGORY.id })).rejects.toBeInstanceOf(ExciseConfirmationRequiredError);
    // Model a previously confirmed primary assignment (real confirmation is
    // exercised through the protected function in the integration tests).
    store.items.set(item.id, { ...item, taxRuleId: EXCISE_CATEGORY.id });
    policy.assertOrdinaryAssignment.mockClear();
    expect((await engine.updateItem(TAX_TENANT, item.id, { name: { en: 'Renamed' } })).taxRuleId).toBe(EXCISE_CATEGORY.id);
    expect(policy.assertOrdinaryAssignment).not.toHaveBeenCalled();
  });
});

describe('platform tax rate administration has no arbitrary update API', () => {
  it('validates dates/bps, delegates only audited create/supersede, and has no tenant parameter', async () => {
    const unexpected = vi.fn(async () => { throw new Error('Unexpected platform call'); });
    const create = vi.fn(async (_actor: string, input: NewTaxRate) => ({ ...input, id: VAT_RATE.id, supersededBy: null }));
    const supersede = vi.fn(async (_actor: string, input: SupersedeTaxRateInput) => ({ ...VAT_RATE, rateBps: input.rateBps, effectiveFrom: input.effectiveFrom }));
    const repository: PlatformTaxAdminRepository = { createJurisdiction: unexpected, configureJurisdiction: unexpected,
      createCategory: unexpected, setCategoryActive: unexpected, createTaxRate: create, closeAndSupersedeTaxRate: supersede,
      createSalesChannel: unexpected, createDeliveryPlatform: unexpected, createLiabilityRule: unexpected, closeLiabilityRule: unexpected };
    const engine = new PlatformTaxAdminEngine(repository);
    const input: NewTaxRate = { taxCategoryId: VAT_CATEGORY.id, rateBps: 1500, isPriceInclusiveDefault: false, effectiveFrom: '2026-09-07', effectiveTo: null };
    await expect(engine.createTaxRate(TAX_ACTOR, { ...input, rateBps: 10001 })).rejects.toThrow();
    await expect(engine.createTaxRate(TAX_ACTOR, { ...input, effectiveFrom: '2026-02-30' })).rejects.toThrow();
    await expect(engine.createTaxRate(TAX_ACTOR, { ...input, effectiveTo: '2026-01-01' })).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    await engine.createTaxRate(TAX_ACTOR, input);
    expect(create).toHaveBeenCalledExactlyOnceWith(TAX_ACTOR, input);
    const change = { taxRateId: VAT_RATE.id, rateBps: 1400, isPriceInclusiveDefault: false, effectiveFrom: '2027-01-01' };
    await engine.closeAndSupersedeTaxRate(TAX_ACTOR, change);
    expect(supersede).toHaveBeenCalledExactlyOnceWith(TAX_ACTOR, change);
    expect(Object.getOwnPropertyNames(PlatformTaxAdminEngine.prototype)).not.toContain('updateTaxRate');
  });
});
