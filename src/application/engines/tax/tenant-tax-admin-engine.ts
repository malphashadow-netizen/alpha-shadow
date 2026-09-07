import type { BranchTaxOverrideInput, ConfirmExciseAssignmentInput, ConfirmExciseOverrideInput, TenantTaxActor, TenantTaxAdminRepository } from '../../../domain/contracts/tenant-tax-admin.ts';
import type { TaxCategory, VatRegistrationStatus } from '../../../domain/contracts/tax.ts';
import { assertExciseConfirmation, assertOrdinaryTaxCategory } from '../../../domain/contracts/tax-rules.ts';
import { NotFoundError, TaxConfigurationError, ValidationError } from '../../../shared/errors.ts';
import type { AuthorizationEngine } from '../rbac/authorization-engine.ts';

export interface TenantTaxAdminDependencies {
  readonly repository: TenantTaxAdminRepository;
  readonly authorization: Pick<AuthorizationEngine, 'check'>;
}
export class TenantTaxAdminEngine {
  private readonly dependencies: TenantTaxAdminDependencies;
  constructor(dependencies: TenantTaxAdminDependencies) { this.dependencies = dependencies; }
  private async authorize(actor: TenantTaxActor, key: string): Promise<void> {
    // Tenant-wide sensitive permission, no L1 cache and no caller-controlled
    // branch/sensitivity. This is NEVER a check of a tenant role's name.
    if (actor.tokenSecV.trim() === '') throw new ValidationError('Authenticated token security version is required');
    await this.dependencies.authorization.check({ tenantId: actor.tenantId, userId: actor.userId, permissionKey: key,
      tokenSecV: actor.tokenSecV, context: { hasResource: false, actorBranchId: null, isSensitivePermission: true } });
  }
  private async category(tenantId: string, id: string): Promise<TaxCategory> {
    const category = await this.dependencies.repository.getCategory(tenantId, id);
    if (category === null) throw new NotFoundError('Tax category not found');
    return category;
  }
  async assignAdditionalCategory(actor: TenantTaxActor, menuItemId: string, taxCategoryId: string): Promise<void> {
    await this.authorize(actor, 'tax:configure');
    assertOrdinaryTaxCategory(await this.category(actor.tenantId, taxCategoryId));
    await this.dependencies.repository.assignAdditionalCategory(actor, menuItemId, taxCategoryId);
  }
  async removeAdditionalCategory(actor: TenantTaxActor, menuItemId: string, taxCategoryId: string): Promise<void> {
    await this.authorize(actor, 'tax:configure');
    await this.dependencies.repository.removeAdditionalCategory(actor, menuItemId, taxCategoryId);
  }
  private async validateOverride(actor: TenantTaxActor, input: BranchTaxOverrideInput): Promise<TaxCategory> {
    if (input.menuItemTaxCategoryId === input.overrideTaxCategoryId) throw new ValidationError('Tax override cannot point to itself');
    const source = await this.category(actor.tenantId, input.menuItemTaxCategoryId);
    const target = await this.category(actor.tenantId, input.overrideTaxCategoryId);
    const country = await this.dependencies.repository.getBranchCountry(actor.tenantId, input.branchId);
    if (country === null) throw new NotFoundError('Branch with a verified tax country not found');
    if (country !== target.countryCode || source.taxFamily !== target.taxFamily || !target.isActive) {
      throw new TaxConfigurationError('Tax override must match the branch country and original family, and be active');
    }
    return target;
  }
  async setBranchOverride(actor: TenantTaxActor, input: BranchTaxOverrideInput): Promise<void> {
    await this.authorize(actor, 'tax:configure');
    assertOrdinaryTaxCategory(await this.validateOverride(actor, input));
    await this.dependencies.repository.setBranchOverride(actor, input);
  }
  async removeBranchOverride(actor: TenantTaxActor, branchId: string, categoryId: string): Promise<void> {
    await this.authorize(actor, 'tax:configure');
    await this.dependencies.repository.removeBranchOverride(actor, branchId, categoryId);
  }
  /** The ONLY item-assignment path which accepts an excise category. */
  async confirmExciseAssignment(actor: TenantTaxActor, input: ConfirmExciseAssignmentInput): Promise<void> {
    await this.authorize(actor, 'tax:confirm_excise');
    assertExciseConfirmation(input.confirmation);
    const category = await this.category(actor.tenantId, input.taxCategoryId);
    if (category.taxFamily !== 'excise' || !category.isActive) throw new TaxConfigurationError('Active excise category required');
    if (!['primary', 'additional'].includes(input.slot)) throw new ValidationError('Invalid tax assignment slot');
    await this.dependencies.repository.confirmExciseAssignment(actor, input);
  }
  async confirmExciseBranchOverride(actor: TenantTaxActor, input: ConfirmExciseOverrideInput): Promise<void> {
    await this.authorize(actor, 'tax:confirm_excise');
    assertExciseConfirmation(input.confirmation);
    const category = await this.validateOverride(actor, input);
    if (category.taxFamily !== 'excise') throw new TaxConfigurationError('Excise override category required');
    if (input.confirmedMenuItemIds.length === 0) throw new ValidationError('Explicit affected menu item list required');
    await this.dependencies.repository.confirmExciseBranchOverride(actor, input);
  }
  async setVatRegistration(actor: TenantTaxActor, status: VatRegistrationStatus, number: string | null): Promise<void> {
    await this.authorize(actor, 'tax:registration_write');
    if (!['registered', 'unregistered'].includes(status)) throw new ValidationError('Invalid VAT registration status');
    if (status === 'registered' && (number === null || number.trim() === '')) throw new ValidationError('Registered tenant requires a VAT registration number');
    await this.dependencies.repository.setVatRegistration(actor, status, number);
  }
}
