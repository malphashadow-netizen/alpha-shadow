/**
 * Dynamic catalog / menu engine.
 *
 * Zero catalog hardcoding: every section, item, modifier, language key and
 * availability window is data. Money in and out of this module is `Money`
 * (BigInt minor units) from `src/shared/money.ts` — never number/float.
 *
 * Physical DELETE of a referenced row is not offered. Archive sets
 * `is_active = false`. Category parent cycles are rejected here (unlimited
 * depth, no SQL-only crutch).
 */
import type {
  BranchMenuItemOverride,
  CatalogRepository,
  LocalizedText,
  MenuCategory,
  MenuItem,
  MenuItemModifierGroupLink,
  Modifier,
  ModifierGroup,
  ModifierSelectionType,
} from '../../../domain/contracts/catalog.ts';
import {
  parseLocalizedText,
  assertMinMaxSelections,
  assertSelectionTypeConsistency,
  parentChainContains,
} from '../../../domain/contracts/catalog-rules.ts';
import { NotFoundError, ValidationError } from '../../../shared/errors.ts';
import { add, CurrencyMismatchError, money, type Money } from '../../../shared/money.ts';
import { isWithinAvailabilitySchedule, parseAvailabilitySchedule } from './availability.ts';

export interface CatalogEngineDependencies {
  readonly catalog: CatalogRepository;
}

export interface CreateCategoryInput {
  readonly name: unknown;
  readonly parentCategoryId?: string | null;
  readonly sortOrder?: number;
}

export interface UpdateCategoryInput {
  readonly name?: unknown;
  readonly parentCategoryId?: string | null;
  readonly sortOrder?: number;
  readonly isActive?: boolean;
}

export interface CreateItemInput {
  readonly categoryId: string;
  readonly name: unknown;
  readonly description?: unknown;
  readonly basePrice: Money;
  readonly taxRuleId?: string | null;
  readonly sku?: string | null;
  readonly sortOrder?: number;
  readonly imageUrl?: string | null;
}

export interface UpdateItemInput {
  readonly categoryId?: string;
  readonly name?: unknown;
  readonly description?: unknown;
  readonly basePrice?: Money;
  readonly taxRuleId?: string | null;
  readonly sku?: string | null;
  readonly sortOrder?: number;
  readonly imageUrl?: string | null;
  readonly isActive?: boolean;
}

export interface CreateModifierGroupInput {
  readonly name: unknown;
  readonly selectionType: ModifierSelectionType;
  readonly minSelections: number;
  readonly maxSelections: number | null;
  readonly isRequired?: boolean;
  readonly sortOrder?: number;
}

export interface UpdateModifierGroupInput {
  readonly name?: unknown;
  readonly selectionType?: ModifierSelectionType;
  readonly minSelections?: number;
  readonly maxSelections?: number | null;
  readonly isRequired?: boolean;
  readonly sortOrder?: number;
  readonly isActive?: boolean;
}

export interface CreateModifierInput {
  readonly modifierGroupId: string;
  readonly name: unknown;
  readonly priceDeltaAmountMinor: bigint;
  readonly sortOrder?: number;
}

export interface UpdateModifierInput {
  readonly name?: unknown;
  readonly priceDeltaAmountMinor?: bigint;
  readonly sortOrder?: number;
  readonly isActive?: boolean;
}

/**
 * Partial branch override. Omitted fields (`undefined`) keep the stored
 * value (or the column default on first insert). An explicit `null` on
 * `priceOverride` or `availabilitySchedule` CLEARS that field:
 *   - priceOverride null → use the item base price
 *   - availabilitySchedule null → no time window (unrestricted, still gated by isAvailable)
 */
export interface SetBranchOverrideInput {
  readonly branchId: string;
  readonly menuItemId: string;
  readonly priceOverride?: Money | null;
  readonly isAvailable?: boolean;
  readonly availabilitySchedule?: unknown;
}

export interface ResolvedModifier {
  readonly modifier: Modifier;
  readonly priceDelta: Money;
}

export interface ResolvedModifierGroup {
  readonly group: ModifierGroup;
  readonly modifiers: readonly ResolvedModifier[];
}

export interface ResolvedMenuItem {
  readonly item: MenuItem;
  readonly effectivePrice: Money;
  readonly isAvailable: boolean;
  readonly modifierGroups: readonly ResolvedModifierGroup[];
}

export interface ResolvedCategoryNode {
  readonly category: MenuCategory;
  readonly children: readonly ResolvedCategoryNode[];
  readonly items: readonly ResolvedMenuItem[];
}

export interface BranchMenu {
  readonly categories: readonly ResolvedCategoryNode[];
}

function sortByOrder<T extends { readonly sortOrder: number; readonly id: string }>(left: T, right: T): number {
  if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function requireFound<T>(value: T | null, what: string): T {
  if (value === null) throw new NotFoundError(what);
  return value;
}

export class CatalogEngine {
  private readonly catalog: CatalogRepository;

  constructor(dependencies: CatalogEngineDependencies) {
    this.catalog = dependencies.catalog;
  }

  async createCategory(tenantId: string, input: CreateCategoryInput): Promise<MenuCategory> {
    const name = parseLocalizedText(input.name, 'name', { allowEmpty: false });
    const parentCategoryId = input.parentCategoryId ?? null;
    if (parentCategoryId !== null) {
      requireFound(await this.catalog.getCategory(tenantId, parentCategoryId), `category ${parentCategoryId} not found`);
    }
    return this.catalog.insertCategory(tenantId, {
      name,
      parentCategoryId,
      sortOrder: input.sortOrder ?? 0,
    });
  }

  async updateCategory(tenantId: string, categoryId: string, input: UpdateCategoryInput): Promise<MenuCategory> {
    const current = requireFound(await this.catalog.getCategory(tenantId, categoryId), `category ${categoryId} not found`);
    const name: LocalizedText =
      input.name === undefined ? current.name : parseLocalizedText(input.name, 'name', { allowEmpty: false });
    const parentCategoryId = input.parentCategoryId === undefined ? current.parentCategoryId : input.parentCategoryId;
    if (parentCategoryId !== null) {
      const parent = await this.catalog.getCategory(tenantId, parentCategoryId);
      requireFound(parent, `category ${parentCategoryId} not found`);
    }
    await this.assertAcyclicParent(tenantId, categoryId, parentCategoryId);
    return this.catalog.updateCategory(tenantId, {
      ...current,
      name,
      parentCategoryId,
      sortOrder: input.sortOrder ?? current.sortOrder,
      isActive: input.isActive ?? current.isActive,
    });
  }

  async archiveCategory(tenantId: string, categoryId: string): Promise<MenuCategory> {
    return this.updateCategory(tenantId, categoryId, { isActive: false });
  }

  async listCategories(tenantId: string): Promise<readonly MenuCategory[]> {
    return this.catalog.listCategories(tenantId);
  }

  async createItem(tenantId: string, input: CreateItemInput): Promise<MenuItem> {
    requireFound(await this.catalog.getCategory(tenantId, input.categoryId), `category ${input.categoryId} not found`);
    return this.catalog.insertItem(tenantId, {
      categoryId: input.categoryId,
      name: parseLocalizedText(input.name, 'name', { allowEmpty: false }),
      description: parseLocalizedText(input.description ?? {}, 'description', { allowEmpty: true }),
      basePrice: money(input.basePrice.amountMinor, input.basePrice.currency),
      taxRuleId: input.taxRuleId ?? null,
      sku: input.sku ?? null,
      sortOrder: input.sortOrder ?? 0,
      imageUrl: input.imageUrl ?? null,
    });
  }

  async updateItem(tenantId: string, itemId: string, input: UpdateItemInput): Promise<MenuItem> {
    const current = requireFound(await this.catalog.getItem(tenantId, itemId), `item ${itemId} not found`);
    const categoryId = input.categoryId ?? current.categoryId;
    if (categoryId !== current.categoryId) {
      requireFound(await this.catalog.getCategory(tenantId, categoryId), `category ${categoryId} not found`);
    }
    const basePrice = input.basePrice === undefined ? current.basePrice : money(input.basePrice.amountMinor, input.basePrice.currency);
    return this.catalog.updateItem(tenantId, {
      ...current,
      categoryId,
      name: input.name === undefined ? current.name : parseLocalizedText(input.name, 'name', { allowEmpty: false }),
      description:
        input.description === undefined
          ? current.description
          : parseLocalizedText(input.description, 'description', { allowEmpty: true }),
      basePrice,
      taxRuleId: input.taxRuleId === undefined ? current.taxRuleId : input.taxRuleId,
      sku: input.sku === undefined ? current.sku : input.sku,
      sortOrder: input.sortOrder ?? current.sortOrder,
      imageUrl: input.imageUrl === undefined ? current.imageUrl : input.imageUrl,
      isActive: input.isActive ?? current.isActive,
    });
  }

  async archiveItem(tenantId: string, itemId: string): Promise<MenuItem> {
    return this.updateItem(tenantId, itemId, { isActive: false });
  }

  async getItem(tenantId: string, itemId: string): Promise<MenuItem> {
    return requireFound(await this.catalog.getItem(tenantId, itemId), `item ${itemId} not found`);
  }

  async createModifierGroup(tenantId: string, input: CreateModifierGroupInput): Promise<ModifierGroup> {
    assertMinMaxSelections(input.minSelections, input.maxSelections);
    this.assertSelectionType(input.selectionType);
    assertSelectionTypeConsistency(input.selectionType, input.maxSelections);
    return this.catalog.insertModifierGroup(tenantId, {
      name: parseLocalizedText(input.name, 'name', { allowEmpty: false }),
      selectionType: input.selectionType,
      minSelections: input.minSelections,
      maxSelections: input.maxSelections,
      isRequired: input.isRequired ?? false,
      sortOrder: input.sortOrder ?? 0,
    });
  }

  async updateModifierGroup(tenantId: string, groupId: string, input: UpdateModifierGroupInput): Promise<ModifierGroup> {
    const current = requireFound(
      await this.catalog.getModifierGroup(tenantId, groupId),
      `modifier group ${groupId} not found`,
    );
    const minSelections = input.minSelections ?? current.minSelections;
    const maxSelections = input.maxSelections === undefined ? current.maxSelections : input.maxSelections;
    assertMinMaxSelections(minSelections, maxSelections);
    const selectionType = input.selectionType ?? current.selectionType;
    this.assertSelectionType(selectionType);
    assertSelectionTypeConsistency(selectionType, maxSelections);
    return this.catalog.updateModifierGroup(tenantId, {
      ...current,
      name: input.name === undefined ? current.name : parseLocalizedText(input.name, 'name', { allowEmpty: false }),
      selectionType,
      minSelections,
      maxSelections,
      isRequired: input.isRequired ?? current.isRequired,
      sortOrder: input.sortOrder ?? current.sortOrder,
      isActive: input.isActive ?? current.isActive,
    });
  }

  async archiveModifierGroup(tenantId: string, groupId: string): Promise<ModifierGroup> {
    return this.updateModifierGroup(tenantId, groupId, { isActive: false });
  }

  async createModifier(tenantId: string, input: CreateModifierInput): Promise<Modifier> {
    requireFound(
      await this.catalog.getModifierGroup(tenantId, input.modifierGroupId),
      `modifier group ${input.modifierGroupId} not found`,
    );
    return this.catalog.insertModifier(tenantId, {
      modifierGroupId: input.modifierGroupId,
      name: parseLocalizedText(input.name, 'name', { allowEmpty: false }),
      priceDeltaAmountMinor: input.priceDeltaAmountMinor,
      sortOrder: input.sortOrder ?? 0,
    });
  }

  async updateModifier(tenantId: string, modifierId: string, input: UpdateModifierInput): Promise<Modifier> {
    const current = requireFound(await this.catalog.getModifier(tenantId, modifierId), `modifier ${modifierId} not found`);
    const priceDeltaAmountMinor = input.priceDeltaAmountMinor ?? current.priceDeltaAmountMinor;
    return this.catalog.updateModifier(tenantId, {
      ...current,
      name: input.name === undefined ? current.name : parseLocalizedText(input.name, 'name', { allowEmpty: false }),
      priceDeltaAmountMinor,
      sortOrder: input.sortOrder ?? current.sortOrder,
      isActive: input.isActive ?? current.isActive,
    });
  }

  async archiveModifier(tenantId: string, modifierId: string): Promise<Modifier> {
    return this.updateModifier(tenantId, modifierId, { isActive: false });
  }

  async attachModifierGroupToItem(
    tenantId: string,
    menuItemId: string,
    modifierGroupId: string,
    sortOrder = 0,
  ): Promise<MenuItemModifierGroupLink> {
    requireFound(await this.catalog.getItem(tenantId, menuItemId), `item ${menuItemId} not found`);
    requireFound(await this.catalog.getModifierGroup(tenantId, modifierGroupId), `modifier group ${modifierGroupId} not found`);
    return this.catalog.insertItemModifierGroupLink(tenantId, { menuItemId, modifierGroupId, sortOrder });
  }

  async setBranchOverride(tenantId: string, input: SetBranchOverrideInput): Promise<BranchMenuItemOverride> {
    const item = requireFound(await this.catalog.getItem(tenantId, input.menuItemId), `item ${input.menuItemId} not found`);
    const current = await this.catalog.getBranchOverride(tenantId, input.branchId, input.menuItemId);
    return this.catalog.upsertBranchOverride(tenantId, {
      branchId: input.branchId,
      menuItemId: input.menuItemId,
      priceOverrideAmountMinor: this.mergePriceOverrideAmount(item, current, input.priceOverride),
      isAvailable: input.isAvailable ?? current?.isAvailable ?? true,
      availabilitySchedule: this.mergeAvailabilitySchedule(current, input.availabilitySchedule),
    });
  }

  /**
   * Effective price for one item at one branch. A missing override, or an
   * override whose price is NULL, leaves `basePrice` untouched.
   */
  resolveEffectivePrice(item: MenuItem, override: BranchMenuItemOverride | null): Money {
    const overrideAmount = override?.priceOverrideAmountMinor;
    if (overrideAmount === undefined || overrideAmount === null) {
      return item.basePrice;
    }
    return money(overrideAmount, item.basePrice.currency);
  }

  resolveAvailability(
    override: BranchMenuItemOverride | null,
    at: Date,
    fallbackTimeZone: string,
  ): boolean {
    if (override === null) return true;
    if (!override.isAvailable) return false;
    const schedule = parseAvailabilitySchedule(override.availabilitySchedule);
    return isWithinAvailabilitySchedule(schedule, at, fallbackTimeZone);
  }

  /**
   * Compose the branch menu from stored data. Archived rows are omitted.
   * Nested categories have unbounded depth (forest built from parent ids).
   */
  async getBranchMenu(
    tenantId: string,
    branchId: string,
    at: Date = new Date(),
    fallbackTimeZone = 'UTC',
  ): Promise<BranchMenu> {
    const [categories, items, groups, modifiers, links, overrides] = await Promise.all([
      this.catalog.listCategories(tenantId),
      this.catalog.listItems(tenantId),
      this.catalog.listModifierGroups(tenantId),
      this.catalog.listModifiers(tenantId),
      this.catalog.listItemModifierGroupLinks(tenantId),
      this.catalog.listBranchOverrides(tenantId, branchId),
    ]);

    const overrideByItemId = new Map(overrides.map((row) => [row.menuItemId, row]));
    const groupsById = new Map(groups.filter((group) => group.isActive).map((group) => [group.id, group]));
    const modifiersByGroup = new Map<string, Modifier[]>();
    for (const modifier of modifiers) {
      if (!modifier.isActive) continue;
      const list = modifiersByGroup.get(modifier.modifierGroupId) ?? [];
      list.push(modifier);
      modifiersByGroup.set(modifier.modifierGroupId, list);
    }
    const linksByItem = new Map<string, MenuItemModifierGroupLink[]>();
    for (const link of links) {
      const list = linksByItem.get(link.menuItemId) ?? [];
      list.push(link);
      linksByItem.set(link.menuItemId, list);
    }

    const resolvedItemsByCategory = new Map<string, ResolvedMenuItem[]>();
    for (const item of items) {
      if (!item.isActive) continue;
      const override = overrideByItemId.get(item.id) ?? null;
      const resolved: ResolvedMenuItem = {
        item,
        effectivePrice: this.resolveEffectivePrice(item, override),
        isAvailable: this.resolveAvailability(override, at, fallbackTimeZone),
        modifierGroups: this.resolveGroupsForItem(item, linksByItem, groupsById, modifiersByGroup),
      };
      const bucket = resolvedItemsByCategory.get(item.categoryId) ?? [];
      bucket.push(resolved);
      resolvedItemsByCategory.set(item.categoryId, bucket);
    }
    for (const bucket of resolvedItemsByCategory.values()) {
      bucket.sort((left, right) => sortByOrder(left.item, right.item));
    }

    const activeCategories = categories.filter((category) => category.isActive).slice().sort(sortByOrder);
    return { categories: this.buildForest(activeCategories, resolvedItemsByCategory) };
  }

  // Intentionally no deleteCategory / deleteItem / deleteModifierGroup /
  // deleteModifier: referenced catalog rows are archived, never removed.

  /**
   * Line total for an item plus selected modifier deltas. Deltas are stored as
   * signed minor units and wrapped in the item's currency at composition time.
   */
  priceWithModifiers(item: MenuItem, selectedModifiers: readonly Modifier[], override: BranchMenuItemOverride | null): Money {
    let total = this.resolveEffectivePrice(item, override);
    for (const modifier of selectedModifiers) {
      total = add(total, money(modifier.priceDeltaAmountMinor, item.basePrice.currency));
    }
    return total;
  }

  private resolveGroupsForItem(
    item: MenuItem,
    linksByItem: ReadonlyMap<string, readonly MenuItemModifierGroupLink[]>,
    groupsById: ReadonlyMap<string, ModifierGroup>,
    modifiersByGroup: ReadonlyMap<string, readonly Modifier[]>,
  ): readonly ResolvedModifierGroup[] {
    const itemLinks = [...(linksByItem.get(item.id) ?? [])].sort(sortByOrder);
    const resolved: ResolvedModifierGroup[] = [];
    for (const link of itemLinks) {
      const group = groupsById.get(link.modifierGroupId);
      if (group === undefined) continue;
      const groupModifiers = [...(modifiersByGroup.get(group.id) ?? [])].sort(sortByOrder);
      resolved.push({
        group,
        modifiers: groupModifiers.map((modifier) => ({
          modifier,
          priceDelta: money(modifier.priceDeltaAmountMinor, item.basePrice.currency),
        })),
      });
    }
    return resolved;
  }

  private buildForest(
    categories: readonly MenuCategory[],
    itemsByCategory: ReadonlyMap<string, readonly ResolvedMenuItem[]>,
  ): readonly ResolvedCategoryNode[] {
    interface MutableNode {
      readonly category: MenuCategory;
      readonly children: MutableNode[];
      readonly items: readonly ResolvedMenuItem[];
    }
    const nodes = new Map<string, MutableNode>();
    for (const category of categories) {
      nodes.set(category.id, {
        category,
        children: [],
        items: itemsByCategory.get(category.id) ?? [],
      });
    }
    const roots: MutableNode[] = [];
    for (const node of nodes.values()) {
      const parentId = node.category.parentCategoryId;
      const parent = parentId === null ? undefined : nodes.get(parentId);
      if (parent === undefined) {
        roots.push(node);
      } else {
        parent.children.push(node);
      }
    }
    const sortTree = (list: MutableNode[]): void => {
      list.sort((left, right) => sortByOrder(left.category, right.category));
      for (const node of list) sortTree(node.children);
    };
    sortTree(roots);
    return roots;
  }

  private async assertAcyclicParent(tenantId: string, categoryId: string, parentCategoryId: string | null): Promise<void> {
    if (parentCategoryId === null) return;
    if (parentCategoryId === categoryId) {
      throw new ValidationError('a category cannot be its own parent', 'parentCategoryId');
    }
    const categories = await this.catalog.listCategories(tenantId);
    const parentById = new Map(categories.map((category) => [category.id, category.parentCategoryId]));
    if (parentChainContains(categoryId, parentCategoryId, parentById)) {
      throw new ValidationError('category parent assignment would create a cycle', 'parentCategoryId');
    }
  }

  private assertSelectionType(value: string): asserts value is ModifierSelectionType {
    if (value !== 'single' && value !== 'multiple') {
      throw new ValidationError('selection_type is not recognised', 'selectionType');
    }
  }

  /**
   * `undefined` keeps the stored override (or NULL on first insert).
   * `null` clears the price so the item base price is used.
   * A `Money` value replaces the stored override after a currency check.
   */
  private mergePriceOverrideAmount(
    item: MenuItem,
    current: BranchMenuItemOverride | null,
    priceOverride: Money | null | undefined,
  ): bigint | null {
    if (priceOverride === undefined) {
      return current?.priceOverrideAmountMinor ?? null;
    }
    if (priceOverride === null) {
      return null;
    }
    if (priceOverride.currency !== item.basePrice.currency) {
      throw new CurrencyMismatchError(item.basePrice.currency, priceOverride.currency);
    }
    return money(priceOverride.amountMinor, priceOverride.currency).amountMinor;
  }

  /**
   * `undefined` keeps the stored schedule. `null` clears it. SQL
   * `COALESCE(EXCLUDED.availability_schedule, …)` is intentionally not used:
   * COALESCE cannot tell "omit" from "explicit SQL NULL".
   */
  private mergeAvailabilitySchedule(current: BranchMenuItemOverride | null, availabilitySchedule: unknown): unknown {
    if (availabilitySchedule === undefined) {
      return current?.availabilitySchedule ?? null;
    }
    return parseAvailabilitySchedule(availabilitySchedule);
  }
}
