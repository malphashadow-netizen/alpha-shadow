/**
 * Catalog / menu engine contracts (ports) and value shapes.
 *
 * Everything a tenant sells — sections, items, modifiers, languages, branch
 * availability — is data. The TypeScript types describe the shape of that
 * data; they do not enumerate categories, SKUs, or language codes.
 */
import type { Money } from '../../shared/money.ts';

/** Free-key language map. Keys are whatever the tenant stored, never a fixed list. */
export type LocalizedText = Readonly<Record<string, string>>;

/** Schema CHECK on modifier_groups.selection_type — not catalog content. */
export type ModifierSelectionType = 'single' | 'multiple';

export interface MenuCategory {
  readonly id: string;
  readonly tenantId: string;
  readonly name: LocalizedText;
  readonly parentCategoryId: string | null;
  readonly sortOrder: number;
  readonly isActive: boolean;
}

export interface MenuItem {
  readonly id: string;
  readonly tenantId: string;
  readonly categoryId: string;
  readonly name: LocalizedText;
  readonly description: LocalizedText;
  readonly basePrice: Money;
  readonly taxRuleId: string | null;
  readonly sku: string | null;
  readonly isActive: boolean;
  readonly sortOrder: number;
  readonly imageUrl: string | null;
}

export interface ModifierGroup {
  readonly id: string;
  readonly tenantId: string;
  readonly name: LocalizedText;
  readonly selectionType: ModifierSelectionType;
  readonly minSelections: number;
  readonly maxSelections: number | null;
  readonly isRequired: boolean;
  readonly isActive: boolean;
  readonly sortOrder: number;
}

export interface Modifier {
  readonly id: string;
  readonly tenantId: string;
  readonly modifierGroupId: string;
  readonly name: LocalizedText;
  readonly priceDeltaAmountMinor: bigint;
  readonly isActive: boolean;
  readonly sortOrder: number;
}

export interface BranchMenuItemOverride {
  readonly id: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly menuItemId: string;
  readonly priceOverrideAmountMinor: bigint | null;
  readonly isAvailable: boolean;
  readonly availabilitySchedule: unknown;
}

export interface MenuItemModifierGroupLink {
  readonly id: string;
  readonly tenantId: string;
  readonly menuItemId: string;
  readonly modifierGroupId: string;
  readonly sortOrder: number;
}

export interface NewMenuCategory {
  readonly name: LocalizedText;
  readonly parentCategoryId: string | null;
  readonly sortOrder: number;
}

export interface NewMenuItem {
  readonly categoryId: string;
  readonly name: LocalizedText;
  readonly description: LocalizedText;
  readonly basePrice: Money;
  readonly taxRuleId: string | null;
  readonly sku: string | null;
  readonly sortOrder: number;
  readonly imageUrl: string | null;
}

export interface NewModifierGroup {
  readonly name: LocalizedText;
  readonly selectionType: ModifierSelectionType;
  readonly minSelections: number;
  readonly maxSelections: number | null;
  readonly isRequired: boolean;
  readonly sortOrder: number;
}

export interface NewModifier {
  readonly modifierGroupId: string;
  readonly name: LocalizedText;
  readonly priceDeltaAmountMinor: bigint;
  readonly sortOrder: number;
}

export interface NewBranchMenuItemOverride {
  readonly branchId: string;
  readonly menuItemId: string;
  readonly priceOverrideAmountMinor: bigint | null;
  readonly isAvailable: boolean;
  readonly availabilitySchedule: unknown;
}

export interface NewMenuItemModifierGroupLink {
  readonly menuItemId: string;
  readonly modifierGroupId: string;
  readonly sortOrder: number;
}

/**
 * Persistence port. Every production implementation MUST run through
 * `withTenantContext()`; the in-memory adapter is unit tests only.
 *
 * There is no `delete*` method: referenced catalog rows are archived
 * (`is_active = false`). PostgreSQL `ON DELETE RESTRICT` backs that rule.
 */
export interface CatalogRepository {
  insertCategory(tenantId: string, input: NewMenuCategory): Promise<MenuCategory>;
  updateCategory(tenantId: string, category: MenuCategory): Promise<MenuCategory>;
  getCategory(tenantId: string, id: string): Promise<MenuCategory | null>;
  listCategories(tenantId: string): Promise<readonly MenuCategory[]>;

  insertItem(tenantId: string, input: NewMenuItem): Promise<MenuItem>;
  updateItem(tenantId: string, item: MenuItem): Promise<MenuItem>;
  getItem(tenantId: string, id: string): Promise<MenuItem | null>;
  listItems(tenantId: string): Promise<readonly MenuItem[]>;

  insertModifierGroup(tenantId: string, input: NewModifierGroup): Promise<ModifierGroup>;
  updateModifierGroup(tenantId: string, group: ModifierGroup): Promise<ModifierGroup>;
  getModifierGroup(tenantId: string, id: string): Promise<ModifierGroup | null>;
  listModifierGroups(tenantId: string): Promise<readonly ModifierGroup[]>;

  insertModifier(tenantId: string, input: NewModifier): Promise<Modifier>;
  updateModifier(tenantId: string, modifier: Modifier): Promise<Modifier>;
  getModifier(tenantId: string, id: string): Promise<Modifier | null>;
  listModifiers(tenantId: string): Promise<readonly Modifier[]>;

  insertItemModifierGroupLink(
    tenantId: string,
    input: NewMenuItemModifierGroupLink,
  ): Promise<MenuItemModifierGroupLink>;
  listItemModifierGroupLinks(tenantId: string): Promise<readonly MenuItemModifierGroupLink[]>;

  upsertBranchOverride(tenantId: string, input: NewBranchMenuItemOverride): Promise<BranchMenuItemOverride>;
  getBranchOverride(
    tenantId: string,
    branchId: string,
    menuItemId: string,
  ): Promise<BranchMenuItemOverride | null>;
  listBranchOverrides(tenantId: string, branchId: string): Promise<readonly BranchMenuItemOverride[]>;
  branchBelongsToTenant(tenantId: string, branchId: string): Promise<boolean>;
}
