/**
 * Tenant-safe Postgres catalog adapter.
 *
 * No `pg` import and no pool: every statement runs inside the injected
 * `withTenantContext` transaction. BIGINT amounts stay strings at the driver
 * boundary and are converted with `minorUnitsFromDb` / `minorUnitsToDb`.
 */
import type {
  BranchMenuItemOverride,
  CatalogRepository,
  MenuCategory,
  MenuItem,
  MenuItemModifierGroupLink,
  Modifier,
  ModifierGroup,
  ModifierSelectionType,
  NewBranchMenuItemOverride,
  NewMenuCategory,
  NewMenuItem,
  NewMenuItemModifierGroupLink,
  NewModifier,
  NewModifierGroup,
} from '../../../domain/contracts/catalog.ts';
import { parseLocalizedText } from '../../../domain/contracts/catalog-rules.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../../shared/errors.ts';
import { currencyCode, minorUnitsFromDb, minorUnitsToDb, money } from '../../../shared/money.ts';
import type { WithTenantContext } from '../tenant-context.ts';

export interface PostgresCatalogRepositoryDependencies {
  readonly withTenantContext: WithTenantContext;
}

interface CategoryRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly name: unknown;
  readonly parent_category_id: string | null;
  readonly sort_order: number;
  readonly is_active: boolean;
}

interface ItemRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly category_id: string;
  readonly name: unknown;
  readonly description: unknown;
  readonly base_price_amount_minor: string;
  readonly base_price_currency_code: string;
  readonly tax_rule_id: string | null;
  readonly sku: string | null;
  readonly is_active: boolean;
  readonly sort_order: number;
  readonly image_url: string | null;
}

interface ModifierGroupRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly name: unknown;
  readonly selection_type: string;
  readonly min_selections: number;
  readonly max_selections: number | null;
  readonly is_required: boolean;
  readonly is_active: boolean;
  readonly sort_order: number;
}

interface ModifierRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly modifier_group_id: string;
  readonly name: unknown;
  readonly price_delta_amount_minor: string;
  readonly is_active: boolean;
  readonly sort_order: number;
}

interface OverrideRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly branch_id: string;
  readonly menu_item_id: string;
  readonly price_override_amount_minor: string | null;
  readonly is_available: boolean;
  readonly availability_schedule: unknown;
}

interface LinkRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly menu_item_id: string;
  readonly modifier_group_id: string;
  readonly sort_order: number;
}

function isDatabaseErrorWithCode(error: unknown, code: string): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return error.code === code;
}

function rethrowCatalogWriteError(error: unknown): never {
  if (isDatabaseErrorWithCode(error, '23505')) {
    throw new ConflictError('catalog unique constraint violated');
  }
  if (isDatabaseErrorWithCode(error, '23514')) {
    throw new ValidationError('catalog check constraint violated');
  }
  if (isDatabaseErrorWithCode(error, '23503')) {
    throw new NotFoundError('catalog foreign key target does not exist');
  }
  throw error;
}

function mapCategory(row: CategoryRow): MenuCategory {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: parseLocalizedText(row.name, 'name', { allowEmpty: false }),
    parentCategoryId: row.parent_category_id,
    sortOrder: row.sort_order,
    isActive: row.is_active,
  };
}

function mapItem(row: ItemRow): MenuItem {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    categoryId: row.category_id,
    name: parseLocalizedText(row.name, 'name', { allowEmpty: false }),
    description: parseLocalizedText(row.description, 'description', { allowEmpty: true }),
    basePrice: money(minorUnitsFromDb(row.base_price_amount_minor), currencyCode(row.base_price_currency_code)),
    taxRuleId: row.tax_rule_id,
    sku: row.sku,
    isActive: row.is_active,
    sortOrder: row.sort_order,
    imageUrl: row.image_url,
  };
}

function mapGroup(row: ModifierGroupRow): ModifierGroup {
  if (row.selection_type !== 'single' && row.selection_type !== 'multiple') {
    throw new ValidationError('selection_type is not recognised', 'selectionType');
  }
  const selectionType: ModifierSelectionType = row.selection_type;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: parseLocalizedText(row.name, 'name', { allowEmpty: false }),
    selectionType,
    minSelections: row.min_selections,
    maxSelections: row.max_selections,
    isRequired: row.is_required,
    isActive: row.is_active,
    sortOrder: row.sort_order,
  };
}

function mapModifier(row: ModifierRow): Modifier {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    modifierGroupId: row.modifier_group_id,
    name: parseLocalizedText(row.name, 'name', { allowEmpty: false }),
    priceDeltaAmountMinor: minorUnitsFromDb(row.price_delta_amount_minor),
    isActive: row.is_active,
    sortOrder: row.sort_order,
  };
}

function mapOverride(row: OverrideRow): BranchMenuItemOverride {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    branchId: row.branch_id,
    menuItemId: row.menu_item_id,
    priceOverrideAmountMinor:
      row.price_override_amount_minor === null ? null : minorUnitsFromDb(row.price_override_amount_minor),
    isAvailable: row.is_available,
    availabilitySchedule: row.availability_schedule,
  };
}

function mapLink(row: LinkRow): MenuItemModifierGroupLink {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    menuItemId: row.menu_item_id,
    modifierGroupId: row.modifier_group_id,
    sortOrder: row.sort_order,
  };
}

export class PostgresCatalogRepository implements CatalogRepository {
  private readonly withTenantContext: WithTenantContext;

  constructor(dependencies: PostgresCatalogRepositoryDependencies) {
    this.withTenantContext = dependencies.withTenantContext;
  }

  async insertCategory(tenantId: string, input: NewMenuCategory): Promise<MenuCategory> {
    try {
      return await this.withTenantContext(tenantId, async (q) => {
        const result = await q.query<CategoryRow>(
          `INSERT INTO menu_categories (tenant_id, name, parent_category_id, sort_order)
           VALUES ($1, $2::jsonb, $3, $4)
           RETURNING id, tenant_id, name, parent_category_id, sort_order, is_active`,
          [tenantId, input.name, input.parentCategoryId, input.sortOrder],
        );
        const row = result.rows[0];
        if (row === undefined) throw new Error('INSERT INTO menu_categories returned no row');
        return mapCategory(row);
      });
    } catch (error) {
      rethrowCatalogWriteError(error);
    }
  }

  async updateCategory(tenantId: string, category: MenuCategory): Promise<MenuCategory> {
    try {
      return await this.withTenantContext(tenantId, async (q) => {
        const result = await q.query<CategoryRow>(
          `UPDATE menu_categories
              SET name = $3::jsonb,
                  parent_category_id = $4,
                  sort_order = $5,
                  is_active = $6
            WHERE tenant_id = $1 AND id = $2
            RETURNING id, tenant_id, name, parent_category_id, sort_order, is_active`,
          [tenantId, category.id, category.name, category.parentCategoryId, category.sortOrder, category.isActive],
        );
        const row = result.rows[0];
        if (row === undefined) throw new NotFoundError(`category ${category.id} not found`);
        return mapCategory(row);
      });
    } catch (error) {
      rethrowCatalogWriteError(error);
    }
  }

  async getCategory(tenantId: string, id: string): Promise<MenuCategory | null> {
    return this.withTenantContext(tenantId, async (q) => {
      const result = await q.query<CategoryRow>(
        `SELECT id, tenant_id, name, parent_category_id, sort_order, is_active
           FROM menu_categories WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      );
      const row = result.rows[0];
      return row === undefined ? null : mapCategory(row);
    });
  }

  async listCategories(tenantId: string): Promise<readonly MenuCategory[]> {
    return this.withTenantContext(tenantId, async (q) => {
      const result = await q.query<CategoryRow>(
        `SELECT id, tenant_id, name, parent_category_id, sort_order, is_active
           FROM menu_categories WHERE tenant_id = $1
           ORDER BY sort_order, id`,
        [tenantId],
      );
      return result.rows.map(mapCategory);
    });
  }

  async insertItem(tenantId: string, input: NewMenuItem): Promise<MenuItem> {
    try {
      return await this.withTenantContext(tenantId, async (q) => {
        const result = await q.query<ItemRow>(
          `INSERT INTO menu_items
             (tenant_id, category_id, name, description, base_price_amount_minor, base_price_currency_code,
              tax_rule_id, sku, sort_order, image_url)
           VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8, $9, $10)
           RETURNING id, tenant_id, category_id, name, description, base_price_amount_minor,
                     base_price_currency_code, tax_rule_id, sku, is_active, sort_order, image_url`,
          [
            tenantId,
            input.categoryId,
            input.name,
            input.description,
            minorUnitsToDb(input.basePrice.amountMinor),
            input.basePrice.currency,
            input.taxRuleId,
            input.sku,
            input.sortOrder,
            input.imageUrl,
          ],
        );
        const row = result.rows[0];
        if (row === undefined) throw new Error('INSERT INTO menu_items returned no row');
        return mapItem(row);
      });
    } catch (error) {
      rethrowCatalogWriteError(error);
    }
  }

  async updateItem(tenantId: string, item: MenuItem): Promise<MenuItem> {
    try {
      return await this.withTenantContext(tenantId, async (q) => {
        const result = await q.query<ItemRow>(
          `UPDATE menu_items
              SET category_id = $3,
                  name = $4::jsonb,
                  description = $5::jsonb,
                  base_price_amount_minor = $6,
                  base_price_currency_code = $7,
                  tax_rule_id = $8,
                  sku = $9,
                  is_active = $10,
                  sort_order = $11,
                  image_url = $12
            WHERE tenant_id = $1 AND id = $2
            RETURNING id, tenant_id, category_id, name, description, base_price_amount_minor,
                      base_price_currency_code, tax_rule_id, sku, is_active, sort_order, image_url`,
          [
            tenantId,
            item.id,
            item.categoryId,
            item.name,
            item.description,
            minorUnitsToDb(item.basePrice.amountMinor),
            item.basePrice.currency,
            item.taxRuleId,
            item.sku,
            item.isActive,
            item.sortOrder,
            item.imageUrl,
          ],
        );
        const row = result.rows[0];
        if (row === undefined) throw new NotFoundError(`item ${item.id} not found`);
        return mapItem(row);
      });
    } catch (error) {
      rethrowCatalogWriteError(error);
    }
  }

  async getItem(tenantId: string, id: string): Promise<MenuItem | null> {
    return this.withTenantContext(tenantId, async (q) => {
      const result = await q.query<ItemRow>(
        `SELECT id, tenant_id, category_id, name, description, base_price_amount_minor,
                base_price_currency_code, tax_rule_id, sku, is_active, sort_order, image_url
           FROM menu_items WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      );
      const row = result.rows[0];
      return row === undefined ? null : mapItem(row);
    });
  }

  async listItems(tenantId: string): Promise<readonly MenuItem[]> {
    return this.withTenantContext(tenantId, async (q) => {
      const result = await q.query<ItemRow>(
        `SELECT id, tenant_id, category_id, name, description, base_price_amount_minor,
                base_price_currency_code, tax_rule_id, sku, is_active, sort_order, image_url
           FROM menu_items WHERE tenant_id = $1
           ORDER BY sort_order, id`,
        [tenantId],
      );
      return result.rows.map(mapItem);
    });
  }

  async insertModifierGroup(tenantId: string, input: NewModifierGroup): Promise<ModifierGroup> {
    try {
      return await this.withTenantContext(tenantId, async (q) => {
        const result = await q.query<ModifierGroupRow>(
          `INSERT INTO modifier_groups
             (tenant_id, name, selection_type, min_selections, max_selections, is_required, sort_order)
           VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7)
           RETURNING id, tenant_id, name, selection_type, min_selections, max_selections,
                     is_required, is_active, sort_order`,
          [
            tenantId,
            input.name,
            input.selectionType,
            input.minSelections,
            input.maxSelections,
            input.isRequired,
            input.sortOrder,
          ],
        );
        const row = result.rows[0];
        if (row === undefined) throw new Error('INSERT INTO modifier_groups returned no row');
        return mapGroup(row);
      });
    } catch (error) {
      rethrowCatalogWriteError(error);
    }
  }

  async updateModifierGroup(tenantId: string, group: ModifierGroup): Promise<ModifierGroup> {
    try {
      return await this.withTenantContext(tenantId, async (q) => {
        const result = await q.query<ModifierGroupRow>(
          `UPDATE modifier_groups
              SET name = $3::jsonb,
                  selection_type = $4,
                  min_selections = $5,
                  max_selections = $6,
                  is_required = $7,
                  is_active = $8,
                  sort_order = $9
            WHERE tenant_id = $1 AND id = $2
            RETURNING id, tenant_id, name, selection_type, min_selections, max_selections,
                      is_required, is_active, sort_order`,
          [
            tenantId,
            group.id,
            group.name,
            group.selectionType,
            group.minSelections,
            group.maxSelections,
            group.isRequired,
            group.isActive,
            group.sortOrder,
          ],
        );
        const row = result.rows[0];
        if (row === undefined) throw new NotFoundError(`modifier group ${group.id} not found`);
        return mapGroup(row);
      });
    } catch (error) {
      rethrowCatalogWriteError(error);
    }
  }

  async getModifierGroup(tenantId: string, id: string): Promise<ModifierGroup | null> {
    return this.withTenantContext(tenantId, async (q) => {
      const result = await q.query<ModifierGroupRow>(
        `SELECT id, tenant_id, name, selection_type, min_selections, max_selections,
                is_required, is_active, sort_order
           FROM modifier_groups WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      );
      const row = result.rows[0];
      return row === undefined ? null : mapGroup(row);
    });
  }

  async listModifierGroups(tenantId: string): Promise<readonly ModifierGroup[]> {
    return this.withTenantContext(tenantId, async (q) => {
      const result = await q.query<ModifierGroupRow>(
        `SELECT id, tenant_id, name, selection_type, min_selections, max_selections,
                is_required, is_active, sort_order
           FROM modifier_groups WHERE tenant_id = $1
           ORDER BY sort_order, id`,
        [tenantId],
      );
      return result.rows.map(mapGroup);
    });
  }

  async insertModifier(tenantId: string, input: NewModifier): Promise<Modifier> {
    try {
      return await this.withTenantContext(tenantId, async (q) => {
        const result = await q.query<ModifierRow>(
          `INSERT INTO modifiers (tenant_id, modifier_group_id, name, price_delta_amount_minor, sort_order)
           VALUES ($1, $2, $3::jsonb, $4, $5)
           RETURNING id, tenant_id, modifier_group_id, name, price_delta_amount_minor, is_active, sort_order`,
          [tenantId, input.modifierGroupId, input.name, minorUnitsToDb(input.priceDeltaAmountMinor), input.sortOrder],
        );
        const row = result.rows[0];
        if (row === undefined) throw new Error('INSERT INTO modifiers returned no row');
        return mapModifier(row);
      });
    } catch (error) {
      rethrowCatalogWriteError(error);
    }
  }

  async updateModifier(tenantId: string, modifier: Modifier): Promise<Modifier> {
    try {
      return await this.withTenantContext(tenantId, async (q) => {
        const result = await q.query<ModifierRow>(
          `UPDATE modifiers
              SET name = $3::jsonb,
                  price_delta_amount_minor = $4,
                  is_active = $5,
                  sort_order = $6
            WHERE tenant_id = $1 AND id = $2
            RETURNING id, tenant_id, modifier_group_id, name, price_delta_amount_minor, is_active, sort_order`,
          [
            tenantId,
            modifier.id,
            modifier.name,
            minorUnitsToDb(modifier.priceDeltaAmountMinor),
            modifier.isActive,
            modifier.sortOrder,
          ],
        );
        const row = result.rows[0];
        if (row === undefined) throw new NotFoundError(`modifier ${modifier.id} not found`);
        return mapModifier(row);
      });
    } catch (error) {
      rethrowCatalogWriteError(error);
    }
  }

  async getModifier(tenantId: string, id: string): Promise<Modifier | null> {
    return this.withTenantContext(tenantId, async (q) => {
      const result = await q.query<ModifierRow>(
        `SELECT id, tenant_id, modifier_group_id, name, price_delta_amount_minor, is_active, sort_order
           FROM modifiers WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      );
      const row = result.rows[0];
      return row === undefined ? null : mapModifier(row);
    });
  }

  async listModifiers(tenantId: string): Promise<readonly Modifier[]> {
    return this.withTenantContext(tenantId, async (q) => {
      const result = await q.query<ModifierRow>(
        `SELECT id, tenant_id, modifier_group_id, name, price_delta_amount_minor, is_active, sort_order
           FROM modifiers WHERE tenant_id = $1
           ORDER BY sort_order, id`,
        [tenantId],
      );
      return result.rows.map(mapModifier);
    });
  }

  async insertItemModifierGroupLink(
    tenantId: string,
    input: NewMenuItemModifierGroupLink,
  ): Promise<MenuItemModifierGroupLink> {
    try {
      return await this.withTenantContext(tenantId, async (q) => {
        const result = await q.query<LinkRow>(
          `INSERT INTO menu_item_modifier_groups (tenant_id, menu_item_id, modifier_group_id, sort_order)
           VALUES ($1, $2, $3, $4)
           RETURNING id, tenant_id, menu_item_id, modifier_group_id, sort_order`,
          [tenantId, input.menuItemId, input.modifierGroupId, input.sortOrder],
        );
        const row = result.rows[0];
        if (row === undefined) throw new Error('INSERT INTO menu_item_modifier_groups returned no row');
        return mapLink(row);
      });
    } catch (error) {
      rethrowCatalogWriteError(error);
    }
  }

  async listItemModifierGroupLinks(tenantId: string): Promise<readonly MenuItemModifierGroupLink[]> {
    return this.withTenantContext(tenantId, async (q) => {
      const result = await q.query<LinkRow>(
        `SELECT id, tenant_id, menu_item_id, modifier_group_id, sort_order
           FROM menu_item_modifier_groups WHERE tenant_id = $1
           ORDER BY sort_order, id`,
        [tenantId],
      );
      return result.rows.map(mapLink);
    });
  }

  /**
   * Writes the engine-assembled snapshot in full. Partial-update semantics
   * (omit vs explicit null) live in CatalogEngine.setBranchOverride — SQL
   * COALESCE(EXCLUDED.col, col) cannot distinguish those two cases on
   * nullable columns, so it is not used here.
   */
  async upsertBranchOverride(tenantId: string, input: NewBranchMenuItemOverride): Promise<BranchMenuItemOverride> {
    try {
      return await this.withTenantContext(tenantId, async (q) => {
        const result = await q.query<OverrideRow>(
          `INSERT INTO branch_menu_item_overrides
             (tenant_id, branch_id, menu_item_id, price_override_amount_minor, is_available, availability_schedule)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)
           ON CONFLICT (tenant_id, branch_id, menu_item_id)
           DO UPDATE SET price_override_amount_minor = EXCLUDED.price_override_amount_minor,
                         is_available = EXCLUDED.is_available,
                         availability_schedule = EXCLUDED.availability_schedule
           RETURNING id, tenant_id, branch_id, menu_item_id, price_override_amount_minor,
                     is_available, availability_schedule`,
          [
            tenantId,
            input.branchId,
            input.menuItemId,
            input.priceOverrideAmountMinor === null ? null : minorUnitsToDb(input.priceOverrideAmountMinor),
            input.isAvailable,
            input.availabilitySchedule,
          ],
        );
        const row = result.rows[0];
        if (row === undefined) throw new Error('upsert branch_menu_item_overrides returned no row');
        return mapOverride(row);
      });
    } catch (error) {
      rethrowCatalogWriteError(error);
    }
  }

  async getBranchOverride(
    tenantId: string,
    branchId: string,
    menuItemId: string,
  ): Promise<BranchMenuItemOverride | null> {
    return this.withTenantContext(tenantId, async (q) => {
      const result = await q.query<OverrideRow>(
        `SELECT id, tenant_id, branch_id, menu_item_id, price_override_amount_minor,
                is_available, availability_schedule
           FROM branch_menu_item_overrides
          WHERE tenant_id = $1 AND branch_id = $2 AND menu_item_id = $3`,
        [tenantId, branchId, menuItemId],
      );
      const row = result.rows[0];
      return row === undefined ? null : mapOverride(row);
    });
  }

  async listBranchOverrides(tenantId: string, branchId: string): Promise<readonly BranchMenuItemOverride[]> {
    return this.withTenantContext(tenantId, async (q) => {
      const result = await q.query<OverrideRow>(
        `SELECT id, tenant_id, branch_id, menu_item_id, price_override_amount_minor,
                is_available, availability_schedule
           FROM branch_menu_item_overrides
          WHERE tenant_id = $1 AND branch_id = $2`,
        [tenantId, branchId],
      );
      return result.rows.map(mapOverride);
    });
  }
}
