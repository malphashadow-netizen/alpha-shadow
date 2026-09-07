import type {
  BranchTaxOverrideInput, CatalogTaxAssignmentPolicy, ConfirmExciseAssignmentInput, ConfirmExciseOverrideInput,
  TenantTaxActor, TenantTaxAdminRepository,
} from '../../../domain/contracts/tenant-tax-admin.ts';
import type { TaxCategory, VatRegistrationStatus } from '../../../domain/contracts/tax.ts';
import { assertOrdinaryTaxCategory } from '../../../domain/contracts/tax-rules.ts';
import { NotFoundError } from '../../../shared/errors.ts';
import type { TenantQuery, WithTenantContext } from '../tenant-context.ts';
import { appendAuditLogInTransaction } from './postgres-audit-log-repository.ts';
import { mapTaxCategory, type CategoryRow } from './tax-row-mappers.ts';

async function ordinaryCategory(q: TenantQuery, id: string): Promise<void> {
  const r = await q.query<CategoryRow>('SELECT * FROM tax_categories WHERE id = $1', [id]);
  const category = r.rows[0];
  if (category === undefined) throw new NotFoundError('Tax category not found');
  assertOrdinaryTaxCategory(mapTaxCategory(category));
}
export class PostgresTenantTaxAdminRepository implements TenantTaxAdminRepository, CatalogTaxAssignmentPolicy {
  private readonly withTenantContext: WithTenantContext;
  constructor(withTenantContext: WithTenantContext) { this.withTenantContext = withTenantContext; }
  async getCategory(tenantId: string, categoryId: string): Promise<TaxCategory | null> {
    return this.withTenantContext(tenantId, async (q) => {
      const r = await q.query<CategoryRow>('SELECT * FROM tax_categories WHERE id = $1', [categoryId]);
      return r.rows[0] === undefined ? null : mapTaxCategory(r.rows[0]);
    });
  }
  async assertOrdinaryAssignment(tenantId: string, taxCategoryId: string): Promise<void> {
    await this.withTenantContext(tenantId, async (q) => ordinaryCategory(q, taxCategoryId));
  }
  async getBranchCountry(tenantId: string, branchId: string): Promise<string | null> {
    return this.withTenantContext(tenantId, async (q) => {
      const r = await q.query<{ country_code: string | null }>('SELECT country_code FROM branches WHERE tenant_id = $1 AND id = $2', [tenantId, branchId]);
      return r.rows[0]?.country_code ?? null;
    });
  }
  async assignAdditionalCategory(actor: TenantTaxActor, menuItemId: string, taxCategoryId: string): Promise<void> {
    await this.withTenantContext(actor.tenantId, async (q) => {
      await q.query("SELECT assert_tenant_tax_permission($1, 'tax:configure')", [actor.userId]);
      await ordinaryCategory(q, taxCategoryId);
      await q.query('INSERT INTO menu_item_additional_tax_categories(menu_item_id, tax_category_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [menuItemId, taxCategoryId]);
      await appendAuditLogInTransaction(q, { tenantId: actor.tenantId, userId: actor.userId, action: 'tax:assign_additional',
        resource: `menu_items:${menuItemId}`, before: null, after: { taxCategoryId } });
    });
  }
  async removeAdditionalCategory(actor: TenantTaxActor, menuItemId: string, taxCategoryId: string): Promise<void> {
    await this.withTenantContext(actor.tenantId, async (q) => {
      await q.query("SELECT assert_tenant_tax_permission($1, 'tax:configure')", [actor.userId]);
      const r = await q.query('DELETE FROM menu_item_additional_tax_categories WHERE menu_item_id = $1 AND tax_category_id = $2 RETURNING tax_category_id', [menuItemId, taxCategoryId]);
      if (r.rowCount !== 1) throw new NotFoundError('Additional tax category assignment not found');
      await appendAuditLogInTransaction(q, { tenantId: actor.tenantId, userId: actor.userId, action: 'tax:remove_additional',
        resource: `menu_items:${menuItemId}`, before: { taxCategoryId }, after: null });
    });
  }
  async setBranchOverride(actor: TenantTaxActor, input: BranchTaxOverrideInput): Promise<void> {
    await this.withTenantContext(actor.tenantId, async (q) => {
      await q.query("SELECT assert_tenant_tax_permission($1, 'tax:configure')", [actor.userId]);
      await ordinaryCategory(q, input.overrideTaxCategoryId);
      const before = await q.query<{ override_tax_category_id: string }>(`SELECT override_tax_category_id FROM branch_tax_category_overrides
        WHERE tenant_id = $1 AND branch_id = $2 AND menu_item_tax_category_id = $3 FOR UPDATE`, [actor.tenantId, input.branchId, input.menuItemTaxCategoryId]);
      await q.query(`INSERT INTO branch_tax_category_overrides(tenant_id, branch_id, menu_item_tax_category_id, override_tax_category_id)
        VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, branch_id, menu_item_tax_category_id)
        DO UPDATE SET override_tax_category_id = EXCLUDED.override_tax_category_id`,
      [actor.tenantId, input.branchId, input.menuItemTaxCategoryId, input.overrideTaxCategoryId]);
      await appendAuditLogInTransaction(q, { tenantId: actor.tenantId, userId: actor.userId, action: 'tax:branch_override',
        resource: `branches:${input.branchId}`, before: before.rows[0] ?? null, after: input });
    });
  }
  async removeBranchOverride(actor: TenantTaxActor, branchId: string, categoryId: string): Promise<void> {
    await this.withTenantContext(actor.tenantId, async (q) => {
      await q.query("SELECT assert_tenant_tax_permission($1, 'tax:configure')", [actor.userId]);
      const r = await q.query<{ override_tax_category_id: string }>(`DELETE FROM branch_tax_category_overrides
        WHERE tenant_id = $1 AND branch_id = $2 AND menu_item_tax_category_id = $3 RETURNING override_tax_category_id`, [actor.tenantId, branchId, categoryId]);
      if (r.rowCount !== 1) throw new NotFoundError('Branch tax override not found');
      await appendAuditLogInTransaction(q, { tenantId: actor.tenantId, userId: actor.userId, action: 'tax:remove_override',
        resource: `branches:${branchId}`, before: r.rows[0], after: null });
    });
  }
  async confirmExciseAssignment(actor: TenantTaxActor, input: ConfirmExciseAssignmentInput): Promise<void> {
    await this.withTenantContext(actor.tenantId, async (q) => {
      await q.query('SELECT confirm_menu_item_excise($1,$2,$3,$4,$5)', [input.menuItemId, input.taxCategoryId, input.slot, actor.userId, input.confirmation]);
    });
  }
  async confirmExciseBranchOverride(actor: TenantTaxActor, input: ConfirmExciseOverrideInput): Promise<void> {
    await this.withTenantContext(actor.tenantId, async (q) => {
      await q.query('SELECT confirm_excise_branch_override($1,$2,$3,$4::uuid[],$5,$6)',
        [input.branchId, input.menuItemTaxCategoryId, input.overrideTaxCategoryId, input.confirmedMenuItemIds, actor.userId, input.confirmation]);
    });
  }
  async setVatRegistration(actor: TenantTaxActor, status: VatRegistrationStatus, number: string | null): Promise<void> {
    await this.withTenantContext(actor.tenantId, async (q) => {
      await q.query('SELECT set_tenant_vat_registration($1,$2,$3)', [status, number, actor.userId]);
    });
  }
}
