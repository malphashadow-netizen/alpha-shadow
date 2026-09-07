import type { TaxCategory, VatRegistrationStatus } from './tax.ts';

/** Exact text displayed on the SEPARATE explicit-confirmation admin interface. */
export const EXCISE_CONFIRMATION_TEXT = 'أنا مُصنِّع/مستورد هذا المنتج ومسجَّل ضريبيًا للإنتاج الانتقائي';
export const TAX_PERMISSION_KEYS = Object.freeze(['tax:read', 'tax:configure', 'tax:confirm_excise', 'tax:registration_write'] as const);
export interface TenantTaxActor {
  readonly tenantId: string;
  readonly userId: string;
  readonly tokenSecV: string;
}
export interface BranchTaxOverrideInput {
  readonly branchId: string;
  readonly menuItemTaxCategoryId: string;
  readonly overrideTaxCategoryId: string;
}
export interface ConfirmExciseAssignmentInput {
  readonly menuItemId: string;
  readonly taxCategoryId: string;
  readonly slot: 'primary' | 'additional';
  readonly confirmation: string;
}
export interface ConfirmExciseOverrideInput extends BranchTaxOverrideInput {
  readonly confirmedMenuItemIds: readonly string[];
  readonly confirmation: string;
}
export interface TenantTaxAdminRepository {
  getCategory(tenantId: string, categoryId: string): Promise<TaxCategory | null>;
  getBranchCountry(tenantId: string, branchId: string): Promise<string | null>;
  assignAdditionalCategory(actor: TenantTaxActor, menuItemId: string, taxCategoryId: string): Promise<void>;
  removeAdditionalCategory(actor: TenantTaxActor, menuItemId: string, taxCategoryId: string): Promise<void>;
  setBranchOverride(actor: TenantTaxActor, input: BranchTaxOverrideInput): Promise<void>;
  removeBranchOverride(actor: TenantTaxActor, branchId: string, categoryId: string): Promise<void>;
  confirmExciseAssignment(actor: TenantTaxActor, input: ConfirmExciseAssignmentInput): Promise<void>;
  confirmExciseBranchOverride(actor: TenantTaxActor, input: ConfirmExciseOverrideInput): Promise<void>;
  setVatRegistration(actor: TenantTaxActor, status: VatRegistrationStatus, number: string | null): Promise<void>;
}

/** Catalog writes must never be an alternate excise-confirmation path. */
export interface CatalogTaxAssignmentPolicy {
  assertOrdinaryAssignment(tenantId: string, taxCategoryId: string): Promise<void>;
}
