import { describe, expect, it, vi } from 'vitest';

import type { AuthorizationEngine } from '../../../../src/application/engines/rbac/authorization-engine.ts';
import { TenantTaxAdminEngine } from '../../../../src/application/engines/tax/tenant-tax-admin-engine.ts';
import type { TenantTaxActor, TenantTaxAdminRepository, TenantTaxRateAdminRepository } from '../../../../src/domain/contracts/tenant-tax-admin.ts';
import type { NewTaxRate, SupersedeTaxRateInput, TaxRate } from '../../../../src/domain/contracts/tax.ts';

const actor: TenantTaxActor = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  userId: '10000000-0000-4000-8000-000000000002',
  tokenSecV: 'verified-sec-v',
};
const categoryId = '10000000-0000-4000-8000-000000000003';
const rateId = '10000000-0000-4000-8000-000000000004';

function fixture() {
  const check: Pick<AuthorizationEngine, 'check'>['check'] = vi.fn(async () => ({
    allowed: true as const,
    effectiveMaxAmountMinorUnits: null,
  }));
  const created: TaxRate = {
    source: 'tenant', id: rateId, taxCategoryId: categoryId, rateBps: 1500,
    isPriceInclusiveDefault: false, effectiveFrom: '2027-01-01', effectiveTo: null, supersededBy: null,
  };
  const baseRepository: TenantTaxAdminRepository = {
    getCategory: vi.fn(async () => null), getBranchCountry: vi.fn(async () => null),
    assignAdditionalCategory: vi.fn(async () => undefined), removeAdditionalCategory: vi.fn(async () => undefined),
    setBranchOverride: vi.fn(async () => undefined), removeBranchOverride: vi.fn(async () => undefined),
    confirmExciseAssignment: vi.fn(async () => undefined), confirmExciseBranchOverride: vi.fn(async () => undefined),
    setVatRegistration: vi.fn(async () => undefined),
  };
  const rateRepository: TenantTaxRateAdminRepository = {
    createTenantTaxRate: vi.fn(async () => created),
    closeAndSupersedeTenantTaxRate: vi.fn(async (_tenantId: string, input: SupersedeTaxRateInput): Promise<TaxRate> => ({
      ...created, id: '10000000-0000-4000-8000-000000000005', rateBps: input.rateBps,
      effectiveFrom: input.effectiveFrom,
    })),
  };
  const repository = Object.assign(baseRepository, rateRepository);
  return { check, repository, engine: new TenantTaxAdminEngine({ repository, authorization: { check } }) };
}

describe('tenant tax-rate administration', () => {
  it('authorizes and delegates creation of a tenant tax rate', async () => {
    const f = fixture();
    const input: NewTaxRate = {
      taxCategoryId: categoryId, rateBps: 1500, isPriceInclusiveDefault: false,
      effectiveFrom: '2027-01-01', effectiveTo: null,
    };

    await expect(f.engine.createTenantTaxRate(actor, input)).resolves.toMatchObject({ source: 'tenant', rateBps: 1500 });
    expect(f.check).toHaveBeenCalledExactlyOnceWith({ tenantId: actor.tenantId, userId: actor.userId,
      permissionKey: 'tax_rate:create', tokenSecV: actor.tokenSecV,
      context: { hasResource: false, actorBranchId: null, isSensitivePermission: true } });
    expect(f.repository.createTenantTaxRate).toHaveBeenCalledExactlyOnceWith(actor.tenantId, input);
  });

  it('authorizes and delegates closing and superseding a tenant tax rate', async () => {
    const f = fixture();
    const input: SupersedeTaxRateInput = {
      taxRateId: rateId, rateBps: 1600, isPriceInclusiveDefault: false, effectiveFrom: '2028-01-01',
    };

    await expect(f.engine.closeAndSupersedeTenantTaxRate(actor, input)).resolves.toMatchObject({
      source: 'tenant', rateBps: 1600, effectiveFrom: '2028-01-01',
    });
    expect(f.check).toHaveBeenCalledExactlyOnceWith({ tenantId: actor.tenantId, userId: actor.userId,
      permissionKey: 'tax_rate:close_and_supersede', tokenSecV: actor.tokenSecV,
      context: { hasResource: false, actorBranchId: null, isSensitivePermission: true } });
    expect(f.repository.closeAndSupersedeTenantTaxRate).toHaveBeenCalledExactlyOnceWith(actor.tenantId, input);
  });
});
