/**
 * CatalogEngine unit tests (InMemory adapter, no I/O).
 *
 * Covers the Phase-5 engine invariants that do not need PostgreSQL:
 *   - free-key JSONB names (no language allow-list)
 *   - min_selections > max_selections is rejected
 *   - category parent cycles are rejected at unbounded depth
 *   - branch overrides do not leak across branches or mutate base_price
 *   - Money is BigInt throughout
 *   - archive exists; physical delete methods do not
 */
import { describe, expect, it } from 'vitest';

import { CatalogEngine } from '../../../../src/application/engines/catalog/catalog-engine.ts';
import type { AuthorizationEngine } from '../../../../src/application/engines/rbac/authorization-engine.ts';
import {
  assertMinMaxSelections,
  assertSelectionTypeConsistency,
  parentChainContains,
  parseLocalizedText,
} from '../../../../src/domain/contracts/catalog-rules.ts';
import { InMemoryCatalogRepository } from '../../../../src/infrastructure/db/repositories/in-memory-catalog-repository.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../../../../src/shared/errors.ts';
import { currencyCode, CurrencyMismatchError, money } from '../../../../src/shared/money.ts';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const BRANCH_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const BRANCH_2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const SAR = currencyCode('SAR');
const ACTOR = 'unit-test-actor';

// B7: mutations name their actor; the allow-all stub keeps the pre-existing
// behavioral tests focused on engine invariants (key wiring is pinned by the
// recording-stub suite at the bottom of this file).
const allowAll: Pick<AuthorizationEngine, 'check'> = {
  check: async () => ({ allowed: true, effectiveMaxAmountMinorUnits: null }),
};

function makeEngine(): CatalogEngine {
  return new CatalogEngine({ catalog: new InMemoryCatalogRepository(), authorization: allowAll });
}

describe('parseLocalizedText — free language keys', () => {
  it('accepts arbitrary language keys, including ones that are not ISO codes', () => {
    const parsed = parseLocalizedText(
      { 'xx-UNREAL': 'X', 'zh-Hans': '你好', 'fr-CA': 'Bonjour', emoji: '☕' },
      'name',
      { allowEmpty: false },
    );
    expect(parsed['xx-UNREAL']).toBe('X');
    expect(parsed['zh-Hans']).toBe('你好');
    expect(parsed['fr-CA']).toBe('Bonjour');
    expect(parsed['emoji']).toBe('☕');
  });

  it('rejects arrays, empty objects (when required), and non-string values', () => {
    expect(() => parseLocalizedText(['ar', 'en'], 'name', { allowEmpty: false })).toThrow(ValidationError);
    expect(() => parseLocalizedText({}, 'name', { allowEmpty: false })).toThrow(ValidationError);
    expect(() => parseLocalizedText({ ar: 1 }, 'name', { allowEmpty: false })).toThrow(ValidationError);
    expect(() => parseLocalizedText({ '': 'x' }, 'name', { allowEmpty: false })).toThrow(ValidationError);
  });
});

describe('assertSelectionTypeConsistency', () => {
  it('rejects selection_type single with max_selections other than 1 or null', () => {
    expect(() => {
      assertSelectionTypeConsistency('single', 5);
    }).toThrow(ValidationError);
    expect(() => {
      assertSelectionTypeConsistency('single', 0);
    }).toThrow(ValidationError);
  });

  it('allows single with max 1 or null, and multiple with any valid cap', () => {
    expect(() => {
      assertSelectionTypeConsistency('single', 1);
    }).not.toThrow();
    expect(() => {
      assertSelectionTypeConsistency('single', null);
    }).not.toThrow();
    expect(() => {
      assertSelectionTypeConsistency('multiple', 5);
    }).not.toThrow();
  });
});

describe('assertMinMaxSelections', () => {
  it('rejects min_selections > max_selections when max is not null', () => {
    expect(() => {
      assertMinMaxSelections(3, 1);
    }).toThrow(ValidationError);
    expect(() => {
      assertMinMaxSelections(1, 0);
    }).toThrow(ValidationError);
  });

  it('allows any min when max is null, and equal bounds', () => {
    expect(() => {
      assertMinMaxSelections(4, null);
    }).not.toThrow();
    expect(() => {
      assertMinMaxSelections(2, 2);
    }).not.toThrow();
    expect(() => {
      assertMinMaxSelections(0, 3);
    }).not.toThrow();
  });
});

describe('parentChainContains — unbounded depth', () => {
  it('detects a cycle of arbitrary length and a self-parent', () => {
    const parents = new Map<string, string | null>([
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'd'],
      ['d', 'e'],
      ['e', null],
    ]);
    expect(parentChainContains('e', 'a', parents)).toBe(true);
    expect(parentChainContains('a', 'a', parents)).toBe(true);
    expect(parentChainContains('a', 'e', parents)).toBe(false);
    expect(parentChainContains('a', null, parents)).toBe(false);
  });
});

describe('CatalogEngine', () => {
  it('stores a name whose keys are not in any language list', async () => {
    const engine = makeEngine();
    const category = await engine.createCategory(TENANT, ACTOR, {
      name: { 'xx-UNREAL': 'Mystery', ja: '分類', 'pt-BR': 'Categoria' },
    });
    expect(category.name).toEqual({ 'xx-UNREAL': 'Mystery', ja: '分類', 'pt-BR': 'Categoria' });
  });

  it('rejects min_selections > max_selections before persistence', async () => {
    const engine = makeEngine();
    await expect(
      engine.createModifierGroup(TENANT, ACTOR, {
        name: { ar: 'إضافات' },
        selectionType: 'multiple',
        minSelections: 5,
        maxSelections: 2,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a parent assignment that would cycle, including deep chains', async () => {
    const engine = makeEngine();
    const a = await engine.createCategory(TENANT, ACTOR, { name: { ar: 'A' } });
    const b = await engine.createCategory(TENANT, ACTOR, { name: { ar: 'B' }, parentCategoryId: a.id });
    const c = await engine.createCategory(TENANT, ACTOR, { name: { ar: 'C' }, parentCategoryId: b.id });
    await expect(engine.updateCategory(TENANT, ACTOR, a.id, { parentCategoryId: c.id })).rejects.toBeInstanceOf(ValidationError);
    await expect(engine.updateCategory(TENANT, ACTOR, a.id, { parentCategoryId: a.id })).rejects.toBeInstanceOf(ValidationError);
  });

  it('does not expose physical delete methods — archive sets is_active = false', async () => {
    const engine = makeEngine();
    const category = await engine.createCategory(TENANT, ACTOR, { name: { ar: 'مشروبات' } });
    const archived = await engine.archiveCategory(TENANT, ACTOR, category.id);
    expect(archived.isActive).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(engine, 'deleteCategory')).toBe(false);
    expect('deleteCategory' in engine).toBe(false);
    expect('deleteItem' in engine).toBe(false);
    expect('deleteModifierGroup' in engine).toBe(false);
  });

  it('a branch price override does not affect another branch or the item base price', async () => {
    const engine = makeEngine();
    const category = await engine.createCategory(TENANT, ACTOR, { name: { ar: 'قهوة' } });
    const item = await engine.createItem(TENANT, ACTOR, {
      categoryId: category.id,
      name: { ar: 'لاتيه', en: 'Latte' },
      basePrice: money(1800n, SAR),
    });
    expect(item.basePrice.amountMinor).toBe(1800n);

    await engine.setBranchOverride(TENANT, ACTOR, {
      branchId: BRANCH_1,
      menuItemId: item.id,
      priceOverride: money(2200n, SAR),
      isAvailable: true,
    });

    const menu1 = await engine.getBranchMenu(TENANT, BRANCH_1);
    const menu2 = await engine.getBranchMenu(TENANT, BRANCH_2);
    const resolved1 = menu1.categories[0]?.items[0];
    const resolved2 = menu2.categories[0]?.items[0];
    expect(resolved1?.effectivePrice.amountMinor).toBe(2200n);
    expect(resolved2?.effectivePrice.amountMinor).toBe(1800n);
    expect(typeof resolved1?.effectivePrice.amountMinor).toBe('bigint');
    expect(typeof resolved2?.effectivePrice.amountMinor).toBe('bigint');

    const reloaded = await engine.getItem(TENANT, item.id);
    expect(reloaded.basePrice.amountMinor).toBe(1800n);
    expect(reloaded.basePrice.currency).toBe('SAR');
  });

  it('rejects a price override in a different currency than the item', async () => {
    const engine = makeEngine();
    const category = await engine.createCategory(TENANT, ACTOR, { name: { ar: 'قهوة' } });
    const item = await engine.createItem(TENANT, ACTOR, {
      categoryId: category.id,
      name: { ar: 'لاتيه' },
      basePrice: money(1800n, SAR),
    });
    await expect(
      engine.setBranchOverride(TENANT, ACTOR, {
        branchId: BRANCH_1,
        menuItemId: item.id,
        priceOverride: money(500n, currencyCode('USD')),
        isAvailable: true,
      }),
    ).rejects.toBeInstanceOf(CurrencyMismatchError);
  });

  it('does not leak another tenant’s categories through the in-memory tenant filter', async () => {
    const repo = new InMemoryCatalogRepository();
    const engine = new CatalogEngine({ catalog: repo, authorization: allowAll });
    await engine.createCategory(TENANT, ACTOR, { name: { ar: 'خاص' } });
    expect(await engine.listCategories(OTHER)).toEqual([]);
    await expect(engine.getItem(OTHER, 'nope')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('composes modifier deltas as Money in the item currency (positive, negative, zero)', async () => {
    const engine = makeEngine();
    const category = await engine.createCategory(TENANT, ACTOR, { name: { ar: 'سندويتش' } });
    const item = await engine.createItem(TENANT, ACTOR, {
      categoryId: category.id,
      name: { ar: 'برجر' },
      basePrice: money(2500n, SAR),
    });
    const group = await engine.createModifierGroup(TENANT, ACTOR, {
      name: { ar: 'إضافات' },
      selectionType: 'multiple',
      minSelections: 0,
      maxSelections: null,
    });
    const extra = await engine.createModifier(TENANT, ACTOR, {
      modifierGroupId: group.id,
      name: { ar: 'جبن' },
      priceDeltaAmountMinor: 300n,
    });
    const noOnion = await engine.createModifier(TENANT, ACTOR, {
      modifierGroupId: group.id,
      name: { ar: 'بدون بصل' },
      priceDeltaAmountMinor: -100n,
    });
    const total = engine.priceWithModifiers(item, [extra, noOnion], null);
    expect(total.amountMinor).toBe(2700n);
    expect(total.currency).toBe('SAR');
  });

  it('rejects selection_type single when max_selections is not 1 or null', async () => {
    const engine = makeEngine();
    await expect(
      engine.createModifierGroup(TENANT, ACTOR, {
        name: { ar: 'اختيار واحد' },
        selectionType: 'single',
        minSelections: 0,
        maxSelections: 5,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const singleOne = await engine.createModifierGroup(TENANT, ACTOR, {
      name: { ar: 'واحد' },
      selectionType: 'single',
      minSelections: 0,
      maxSelections: 1,
    });
    expect(singleOne.maxSelections).toBe(1);

    const singleNull = await engine.createModifierGroup(TENANT, ACTOR, {
      name: { ar: 'واحد بلا سقف' },
      selectionType: 'single',
      minSelections: 0,
      maxSelections: null,
    });
    expect(singleNull.maxSelections).toBeNull();

    const multiple = await engine.createModifierGroup(TENANT, ACTOR, {
      name: { ar: 'متعدد' },
      selectionType: 'multiple',
      minSelections: 0,
      maxSelections: 5,
    });
    await expect(engine.updateModifierGroup(TENANT, ACTOR, multiple.id, { selectionType: 'single' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(engine.updateModifierGroup(TENANT, ACTOR, singleOne.id, { maxSelections: 5 })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('merges branch overrides: omitted fields keep, explicit null clears', async () => {
    const repo = new InMemoryCatalogRepository();
    const engine = new CatalogEngine({ catalog: repo, authorization: allowAll });
    const category = await engine.createCategory(TENANT, ACTOR, { name: { ar: 'قهوة' } });
    const item = await engine.createItem(TENANT, ACTOR, {
      categoryId: category.id,
      name: { ar: 'لاتيه' },
      basePrice: money(1800n, SAR),
    });
    const lunch = {
      timeZone: 'UTC',
      windows: [{ daysOfWeek: [3], start: '15:00', end: '16:00' }],
    };

    await engine.setBranchOverride(TENANT, ACTOR, {
      branchId: BRANCH_1,
      menuItemId: item.id,
      isAvailable: true,
      availabilitySchedule: lunch,
    });

    const afterPrice = await engine.setBranchOverride(TENANT, ACTOR, {
      branchId: BRANCH_1,
      menuItemId: item.id,
      priceOverride: money(2200n, SAR),
    });
    expect(afterPrice.priceOverrideAmountMinor).toBe(2200n);
    expect(afterPrice.isAvailable).toBe(true);
    expect(afterPrice.availabilitySchedule).toEqual(lunch);

    const noon = new Date('2026-03-04T12:00:00.000Z');
    const lunchTime = new Date('2026-03-04T15:30:00.000Z');
    const menuNoon = await engine.getBranchMenu(TENANT, BRANCH_1, noon, 'UTC');
    const menuLunch = await engine.getBranchMenu(TENANT, BRANCH_1, lunchTime, 'UTC');
    expect(menuNoon.categories[0]?.items[0]?.isAvailable).toBe(false);
    expect(menuLunch.categories[0]?.items[0]?.isAvailable).toBe(true);
    expect(menuLunch.categories[0]?.items[0]?.effectivePrice.amountMinor).toBe(2200n);

    const cleared = await engine.setBranchOverride(TENANT, ACTOR, {
      branchId: BRANCH_1,
      menuItemId: item.id,
      availabilitySchedule: null,
    });
    expect(cleared.availabilitySchedule).toBeNull();
    expect(cleared.priceOverrideAmountMinor).toBe(2200n);
    expect(cleared.isAvailable).toBe(true);

    const menuNoonAfterClear = await engine.getBranchMenu(TENANT, BRANCH_1, noon, 'UTC');
    expect(menuNoonAfterClear.categories[0]?.items[0]?.isAvailable).toBe(true);
    expect(menuNoonAfterClear.categories[0]?.items[0]?.effectivePrice.amountMinor).toBe(2200n);

    const priceCleared = await engine.setBranchOverride(TENANT, ACTOR, {
      branchId: BRANCH_1,
      menuItemId: item.id,
      priceOverride: null,
    });
    expect(priceCleared.priceOverrideAmountMinor).toBeNull();
    const menuBase = await engine.getBranchMenu(TENANT, BRANCH_1, noon, 'UTC');
    expect(menuBase.categories[0]?.items[0]?.effectivePrice.amountMinor).toBe(1800n);

    const stored = await repo.getBranchOverride(TENANT, BRANCH_1, item.id);
    expect(stored?.availabilitySchedule).toBeNull();
    expect(stored?.priceOverrideAmountMinor).toBeNull();
  });

  it('builds an unbounded category forest from parent ids', async () => {
    const engine = makeEngine();
    const root = await engine.createCategory(TENANT, ACTOR, { name: { ar: 'جذر' }, sortOrder: 1 });
    const child = await engine.createCategory(TENANT, ACTOR, { name: { ar: 'فرع' }, parentCategoryId: root.id, sortOrder: 1 });
    await engine.createCategory(TENANT, ACTOR, { name: { ar: 'حفيد' }, parentCategoryId: child.id, sortOrder: 1 });
    const menu = await engine.getBranchMenu(TENANT, BRANCH_1);
    expect(menu.categories).toHaveLength(1);
    expect(menu.categories[0]?.children).toHaveLength(1);
    expect(menu.categories[0]?.children[0]?.children).toHaveLength(1);
  });
});

describe('CatalogEngine B7 authorization wiring (recording stub)', () => {
  it('checks exactly one key per mutation: write for creates/updates/attach/override, archive for archives', async () => {
    const seen: { permissionKey: string; userId: string; tenantId: string; sensitive: unknown }[] = [];
    const recording: Pick<AuthorizationEngine, 'check'> = {
      check: async (input) => {
        seen.push({
          permissionKey: input.permissionKey,
          userId: input.userId,
          tenantId: input.tenantId,
          sensitive: input.context.isSensitivePermission,
        });
        return { allowed: true, effectiveMaxAmountMinorUnits: null };
      },
    };
    const engine = new CatalogEngine({ catalog: new InMemoryCatalogRepository(), authorization: recording });
    const category = await engine.createCategory(TENANT, ACTOR, { name: { ar: 'قسم' } });
    const item = await engine.createItem(TENANT, ACTOR, {
      categoryId: category.id, name: { ar: 'صنف' }, basePrice: money(1000n, SAR),
    });
    const group = await engine.createModifierGroup(TENANT, ACTOR, {
      name: { ar: 'إضافات' }, selectionType: 'multiple', minSelections: 0, maxSelections: null,
    });
    const modifier = await engine.createModifier(TENANT, ACTOR, {
      modifierGroupId: group.id, name: { ar: 'جبن' }, priceDeltaAmountMinor: 200n,
    });
    await engine.attachModifierGroupToItem(TENANT, ACTOR, item.id, group.id);
    await engine.setBranchOverride(TENANT, ACTOR, { branchId: BRANCH_1, menuItemId: item.id, isAvailable: false });
    await engine.updateCategory(TENANT, ACTOR, category.id, { sortOrder: 3 });
    await engine.updateItem(TENANT, ACTOR, item.id, { sortOrder: 3 });
    await engine.updateModifierGroup(TENANT, ACTOR, group.id, { sortOrder: 3 });
    await engine.updateModifier(TENANT, ACTOR, modifier.id, { sortOrder: 3 });
    await engine.archiveCategory(TENANT, ACTOR, category.id);
    await engine.archiveItem(TENANT, ACTOR, item.id);
    await engine.archiveModifierGroup(TENANT, ACTOR, group.id);
    await engine.archiveModifier(TENANT, ACTOR, modifier.id);
    // 14 mutations ⇒ exactly 14 checks: an archive delegating through the
    // public update (two keys for one op) would surface here as 18 entries.
    expect(seen.map((s) => s.permissionKey)).toEqual([
      'catalog:write', 'catalog:write', 'catalog:write', 'catalog:write', 'catalog:write', 'catalog:write',
      'catalog:write', 'catalog:write', 'catalog:write', 'catalog:write',
      'catalog:archive', 'catalog:archive', 'catalog:archive', 'catalog:archive',
    ]);
    expect(seen.every((s) => s.userId === ACTOR && s.tenantId === TENANT && s.sensitive === false)).toBe(true);
  });

  it('a denied check rejects the mutation before any write', async () => {
    const deny: Pick<AuthorizationEngine, 'check'> = {
      check: async () => { throw new ForbiddenError('missing permission catalog:write'); },
    };
    const engine = new CatalogEngine({ catalog: new InMemoryCatalogRepository(), authorization: deny });
    await expect(engine.createCategory(TENANT, ACTOR, { name: { ar: 'مرفوض' } })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await engine.listCategories(TENANT)).toHaveLength(0);
  });
});
