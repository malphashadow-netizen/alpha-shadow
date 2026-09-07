/* eslint-disable @typescript-eslint/require-await --
 * The InMemory adapter satisfies an ASYNC contract over Map lookups so the
 * engine and tests treat both adapters identically. */
/**
 * InMemory catalog repository — UNIT TESTS ONLY.
 *
 * A runtime guard refuses construction under NODE_ENV=production. Tenant
 * isolation is simulated by filtering on tenantId (production isolation is
 * RLS + withTenantContext).
 */
import { randomUUID } from 'node:crypto';

import type {
  BranchMenuItemOverride,
  CatalogRepository,
  MenuCategory,
  MenuItem,
  MenuItemModifierGroupLink,
  Modifier,
  ModifierGroup,
  NewBranchMenuItemOverride,
  NewMenuCategory,
  NewMenuItem,
  NewMenuItemModifierGroupLink,
  NewModifier,
  NewModifierGroup,
} from '../../../domain/contracts/catalog.ts';
import { ConfigurationError, ConflictError, NotFoundError } from '../../../shared/errors.ts';
import { money } from '../../../shared/money.ts';

function assertInMemoryNotInProduction(): void {
  if (process.env['NODE_ENV'] === 'production') {
    throw new ConfigurationError(
      'InMemory catalog repository is forbidden under NODE_ENV=production; use the Postgres implementation.',
      'NODE_ENV',
    );
  }
}

export class InMemoryCatalogStore {
  readonly categories = new Map<string, MenuCategory>();
  readonly items = new Map<string, MenuItem>();
  readonly groups = new Map<string, ModifierGroup>();
  readonly modifiers = new Map<string, Modifier>();
  readonly links = new Map<string, MenuItemModifierGroupLink>();
  readonly overrides = new Map<string, BranchMenuItemOverride>();
}

function overrideKey(tenantId: string, branchId: string, menuItemId: string): string {
  return `${tenantId}:${branchId}:${menuItemId}`;
}

function linkKey(tenantId: string, menuItemId: string, modifierGroupId: string): string {
  return `${tenantId}:${menuItemId}:${modifierGroupId}`;
}

export class InMemoryCatalogRepository implements CatalogRepository {
  private readonly store: InMemoryCatalogStore;

  constructor(store: InMemoryCatalogStore = new InMemoryCatalogStore()) {
    assertInMemoryNotInProduction();
    this.store = store;
  }

  async insertCategory(tenantId: string, input: NewMenuCategory): Promise<MenuCategory> {
    const row: MenuCategory = {
      id: randomUUID(),
      tenantId,
      name: input.name,
      parentCategoryId: input.parentCategoryId,
      sortOrder: input.sortOrder,
      isActive: true,
    };
    this.store.categories.set(row.id, row);
    return row;
  }

  async updateCategory(tenantId: string, category: MenuCategory): Promise<MenuCategory> {
    const current = this.owned(this.store.categories.get(category.id), tenantId, `category ${category.id} not found`);
    const next = { ...current, ...category, tenantId };
    this.store.categories.set(next.id, next);
    return next;
  }

  async getCategory(tenantId: string, id: string): Promise<MenuCategory | null> {
    const row = this.store.categories.get(id);
    if (row?.tenantId !== tenantId) return null;
    return row;
  }

  async listCategories(tenantId: string): Promise<readonly MenuCategory[]> {
    return [...this.store.categories.values()].filter((row) => row.tenantId === tenantId);
  }

  async insertItem(tenantId: string, input: NewMenuItem): Promise<MenuItem> {
    this.assertSkuUnique(tenantId, input.sku, null);
    const row: MenuItem = {
      id: randomUUID(),
      tenantId,
      categoryId: input.categoryId,
      name: input.name,
      description: input.description,
      basePrice: money(input.basePrice.amountMinor, input.basePrice.currency),
      taxRuleId: input.taxRuleId,
      sku: input.sku,
      isActive: true,
      sortOrder: input.sortOrder,
      imageUrl: input.imageUrl,
    };
    this.store.items.set(row.id, row);
    return row;
  }

  async updateItem(tenantId: string, item: MenuItem): Promise<MenuItem> {
    const current = this.owned(this.store.items.get(item.id), tenantId, `item ${item.id} not found`);
    this.assertSkuUnique(tenantId, item.sku, item.id);
    const next: MenuItem = {
      ...current,
      ...item,
      tenantId,
      basePrice: money(item.basePrice.amountMinor, item.basePrice.currency),
    };
    this.store.items.set(next.id, next);
    return next;
  }

  async getItem(tenantId: string, id: string): Promise<MenuItem | null> {
    const row = this.store.items.get(id);
    if (row?.tenantId !== tenantId) return null;
    return row;
  }

  async listItems(tenantId: string): Promise<readonly MenuItem[]> {
    return [...this.store.items.values()].filter((row) => row.tenantId === tenantId);
  }

  async insertModifierGroup(tenantId: string, input: NewModifierGroup): Promise<ModifierGroup> {
    const row: ModifierGroup = {
      id: randomUUID(),
      tenantId,
      name: input.name,
      selectionType: input.selectionType,
      minSelections: input.minSelections,
      maxSelections: input.maxSelections,
      isRequired: input.isRequired,
      isActive: true,
      sortOrder: input.sortOrder,
    };
    this.store.groups.set(row.id, row);
    return row;
  }

  async updateModifierGroup(tenantId: string, group: ModifierGroup): Promise<ModifierGroup> {
    const current = this.owned(this.store.groups.get(group.id), tenantId, `modifier group ${group.id} not found`);
    const next = { ...current, ...group, tenantId };
    this.store.groups.set(next.id, next);
    return next;
  }

  async getModifierGroup(tenantId: string, id: string): Promise<ModifierGroup | null> {
    const row = this.store.groups.get(id);
    if (row?.tenantId !== tenantId) return null;
    return row;
  }

  async listModifierGroups(tenantId: string): Promise<readonly ModifierGroup[]> {
    return [...this.store.groups.values()].filter((row) => row.tenantId === tenantId);
  }

  async insertModifier(tenantId: string, input: NewModifier): Promise<Modifier> {
    const row: Modifier = {
      id: randomUUID(),
      tenantId,
      modifierGroupId: input.modifierGroupId,
      name: input.name,
      priceDeltaAmountMinor: input.priceDeltaAmountMinor,
      isActive: true,
      sortOrder: input.sortOrder,
    };
    this.store.modifiers.set(row.id, row);
    return row;
  }

  async updateModifier(tenantId: string, modifier: Modifier): Promise<Modifier> {
    const current = this.owned(this.store.modifiers.get(modifier.id), tenantId, `modifier ${modifier.id} not found`);
    const next = { ...current, ...modifier, tenantId };
    this.store.modifiers.set(next.id, next);
    return next;
  }

  async getModifier(tenantId: string, id: string): Promise<Modifier | null> {
    const row = this.store.modifiers.get(id);
    if (row?.tenantId !== tenantId) return null;
    return row;
  }

  async listModifiers(tenantId: string): Promise<readonly Modifier[]> {
    return [...this.store.modifiers.values()].filter((row) => row.tenantId === tenantId);
  }

  async insertItemModifierGroupLink(
    tenantId: string,
    input: NewMenuItemModifierGroupLink,
  ): Promise<MenuItemModifierGroupLink> {
    const key = linkKey(tenantId, input.menuItemId, input.modifierGroupId);
    if (this.store.links.has(key)) {
      throw new ConflictError('modifier group is already attached to this item');
    }
    const row: MenuItemModifierGroupLink = {
      id: randomUUID(),
      tenantId,
      menuItemId: input.menuItemId,
      modifierGroupId: input.modifierGroupId,
      sortOrder: input.sortOrder,
    };
    this.store.links.set(key, row);
    return row;
  }

  async listItemModifierGroupLinks(tenantId: string): Promise<readonly MenuItemModifierGroupLink[]> {
    return [...this.store.links.values()].filter((row) => row.tenantId === tenantId);
  }

  /** Full snapshot write — the engine merges omit vs explicit-null first. */
  async upsertBranchOverride(tenantId: string, input: NewBranchMenuItemOverride): Promise<BranchMenuItemOverride> {
    const key = overrideKey(tenantId, input.branchId, input.menuItemId);
    const existing = this.store.overrides.get(key);
    const row: BranchMenuItemOverride = {
      id: existing?.id ?? randomUUID(),
      tenantId,
      branchId: input.branchId,
      menuItemId: input.menuItemId,
      priceOverrideAmountMinor: input.priceOverrideAmountMinor,
      isAvailable: input.isAvailable,
      availabilitySchedule: input.availabilitySchedule,
    };
    this.store.overrides.set(key, row);
    return row;
  }

  async getBranchOverride(
    tenantId: string,
    branchId: string,
    menuItemId: string,
  ): Promise<BranchMenuItemOverride | null> {
    const row = this.store.overrides.get(overrideKey(tenantId, branchId, menuItemId));
    if (row?.tenantId !== tenantId) return null;
    return row;
  }

  async listBranchOverrides(tenantId: string, branchId: string): Promise<readonly BranchMenuItemOverride[]> {
    return [...this.store.overrides.values()].filter((row) => row.tenantId === tenantId && row.branchId === branchId);
  }

  private owned<T extends { readonly tenantId: string }>(row: T | undefined, tenantId: string, message: string): T {
    if (row?.tenantId !== tenantId) {
      throw new NotFoundError(message);
    }
    return row;
  }

  private assertSkuUnique(tenantId: string, sku: string | null, itemId: string | null): void {
    if (sku === null) return;
    for (const item of this.store.items.values()) {
      if (item.tenantId !== tenantId || item.sku !== sku) continue;
      if (itemId !== null && item.id === itemId) continue;
      throw new ConflictError('sku is already used in this tenant');
    }
  }
}
