/**
 * Phase 5 live acceptance tests against PostgreSQL 18.
 *
 * Application operations use the NOBYPASSRLS app_login role through
 * withTenantContext(). Owner connections are only for grants, TRUNCATE, and
 * proving ON DELETE RESTRICT.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CatalogEngine } from '../../src/application/engines/catalog/catalog-engine.ts';
import { PostgresCatalogRepository } from '../../src/infrastructure/db/repositories/postgres-catalog-repository.ts';
import { createWithTenantContext, type WithTenantContext } from '../../src/infrastructure/db/tenant-context.ts';
import { ValidationError } from '../../src/shared/errors.ts';
import { currencyCode, money } from '../../src/shared/money.ts';
import { testDatabaseUrl } from '../support/database.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const BRANCH_A1 = 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
const BRANCH_A2 = 'a2a2a2a2-a2a2-42a2-82a2-a2a2a2a2a2a2';
const BRANCH_B1 = 'b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1';
const APP_LOGIN_PASSWORD = 'phase5-app-login-test';
const SAR = currencyCode('SAR');

const CATALOG_TABLES = [
  'menu_item_modifier_groups',
  'branch_menu_item_overrides',
  'modifiers',
  'menu_items',
  'modifier_groups',
  'menu_categories',
] as const;

async function bindTenant(client: pg.PoolClient, tenantId: string): Promise<void> {
  await client.query('BEGIN');
  await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', tenantId]);
}

describe('Phase 5 live acceptance: catalog engine, RLS, soft-delete', () => {
  let ownerPool: pg.Pool;
  let appPool: pg.Pool;
  let withAppContext: WithTenantContext;
  let engine: CatalogEngine;

  beforeAll(async () => {
    ownerPool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 4 });
    const owner = await ownerPool.connect();
    try {
      const tables = await owner.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
        [CATALOG_TABLES],
      );
      expect(tables.rows).toHaveLength(6);

      await owner.query(
        `DO $$ BEGIN
           IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_login') THEN
             CREATE ROLE app_login LOGIN PASSWORD '${APP_LOGIN_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
           END IF;
         END $$;`,
      );
      await owner.query(
        `ALTER ROLE app_login WITH LOGIN PASSWORD '${APP_LOGIN_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      await owner.query('GRANT USAGE ON SCHEMA public TO app_login');
      await owner.query('GRANT SELECT ON tenants, currencies, permissions_registry TO app_login');
      await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON branches TO app_login');
      await owner.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON
           menu_categories, menu_items, branch_menu_item_overrides,
           modifier_groups, modifiers, menu_item_modifier_groups
         TO app_login`,
      );
    } finally {
      owner.release();
    }

    const appUrl = new URL(testDatabaseUrl());
    appUrl.username = 'app_login';
    appUrl.password = APP_LOGIN_PASSWORD;
    appPool = new pg.Pool({ connectionString: appUrl.toString(), max: 5 });
    withAppContext = createWithTenantContext(
      { connect: async () => appPool.connect() },
      { verifyTenantExists: true },
    );
    engine = new CatalogEngine({ catalog: new PostgresCatalogRepository({ withTenantContext: withAppContext }) });
  });

  beforeEach(async () => {
    const owner = await ownerPool.connect();
    try {
      await owner.query(
        `TRUNCATE order_line_tax_snapshots, order_line_tax_contexts, menu_item_excise_confirmations, menu_item_additional_tax_categories, menu_item_modifier_groups, branch_menu_item_overrides, modifiers, menu_items, modifier_groups, menu_categories`,
      );
      await owner.query('DELETE FROM branches WHERE id = ANY($1::uuid[])', [[BRANCH_A1, BRANCH_A2, BRANCH_B1]]);
    } finally {
      owner.release();
    }

    await withAppContext(TENANT_A, async (q) => {
      await q.query(
        `INSERT INTO branches (id, tenant_id, name, base_currency, timezone, country_code)
         VALUES ($1, $2, 'catalog-a1', 'SAR', 'Asia/Riyadh', 'SA'),
                ($3, $2, 'catalog-a2', 'SAR', 'Asia/Riyadh', 'SA')`,
        [BRANCH_A1, TENANT_A, BRANCH_A2],
      );
    });
    await withAppContext(TENANT_B, async (q) => {
      await q.query(
        `INSERT INTO branches (id, tenant_id, name, base_currency, timezone, country_code)
         VALUES ($1, $2, 'catalog-b1', 'SAR', 'Asia/Riyadh', 'SA')`,
        [BRANCH_B1, TENANT_B],
      );
    });
  });

  afterAll(async () => {
    await appPool?.end();
    await ownerPool?.end();
  });

  it('tenant A cannot read or modify tenant B catalog rows through withTenantContext', async () => {
    const categoryA = await engine.createCategory(TENANT_A, { name: { ar: 'مشروبات أ' } });
    await engine.createItem(TENANT_A, {
      categoryId: categoryA.id,
      name: { ar: 'لاتيه' },
      basePrice: money(1800n, SAR),
    });

    expect(await engine.listCategories(TENANT_B)).toEqual([]);

    const fromB = await withAppContext(TENANT_B, async (q) => {
      const categories = await q.query('SELECT id FROM menu_categories');
      const items = await q.query('SELECT id FROM menu_items');
      return { categories: categories.rowCount, items: items.rowCount };
    });
    expect(fromB).toEqual({ categories: 0, items: 0 });

    await expect(
      withAppContext(TENANT_B, async (q) => {
        await q.query(`INSERT INTO menu_categories (tenant_id, name) VALUES ($1, $2::jsonb)`, [
          TENANT_A,
          { ar: 'سرقة' },
        ]);
      }),
    ).rejects.toThrow(/row-level security/);

    const raw = await appPool.connect();
    try {
      await bindTenant(raw, TENANT_B);
      const updated = await raw.query('UPDATE menu_categories SET name = $1::jsonb WHERE id = $2', [
        { ar: 'pwned' },
        categoryA.id,
      ]);
      expect(updated.rowCount).toBe(0);
      await raw.query('ROLLBACK');
      await raw.query('DISCARD ALL');
    } finally {
      raw.release();
    }

    const intact = await engine.listCategories(TENANT_A);
    expect(intact).toHaveLength(1);
    expect(intact[0]?.name).toEqual({ ar: 'مشروبات أ' });
  });

  it('rejects min_selections > max_selections in the engine and at the CHECK constraint', async () => {
    await expect(
      engine.createModifierGroup(TENANT_A, {
        name: { ar: 'إضافات' },
        selectionType: 'multiple',
        minSelections: 4,
        maxSelections: 1,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      withAppContext(TENANT_A, async (q) => {
        await q.query(
          `INSERT INTO modifier_groups (tenant_id, name, selection_type, min_selections, max_selections)
           VALUES ($1, $2::jsonb, 'multiple', 4, 1)`,
          [TENANT_A, { ar: 'bad' }],
        );
      }),
    ).rejects.toThrow(/modifier_groups_min_lte_max|check constraint/i);
  });

  it('refuses physical DELETE of a referenced category/group and proves soft-delete', async () => {
    const category = await engine.createCategory(TENANT_A, { name: { ar: 'قسم' } });
    const item = await engine.createItem(TENANT_A, {
      categoryId: category.id,
      name: { ar: 'صنف' },
      basePrice: money(1000n, SAR),
    });
    const group = await engine.createModifierGroup(TENANT_A, {
      name: { ar: 'مجموعة' },
      selectionType: 'single',
      minSelections: 0,
      maxSelections: 1,
    });
    await engine.createModifier(TENANT_A, {
      modifierGroupId: group.id,
      name: { ar: 'إضافة' },
      priceDeltaAmountMinor: 100n,
    });

    await expect(
      withAppContext(TENANT_A, async (q) => {
        await q.query('DELETE FROM menu_categories WHERE id = $1', [category.id]);
      }),
    ).rejects.toThrow(/restrict|foreign key/i);

    await expect(
      withAppContext(TENANT_A, async (q) => {
        await q.query('DELETE FROM modifier_groups WHERE id = $1', [group.id]);
      }),
    ).rejects.toThrow(/restrict|foreign key/i);

    const archivedCategory = await engine.archiveCategory(TENANT_A, category.id);
    const archivedGroup = await engine.archiveModifierGroup(TENANT_A, group.id);
    expect(archivedCategory.isActive).toBe(false);
    expect(archivedGroup.isActive).toBe(false);

    const stillThere = await withAppContext(TENANT_A, async (q) => {
      const items = await q.query<{ id: string; is_active: boolean }>('SELECT id, is_active FROM menu_items WHERE id = $1', [
        item.id,
      ]);
      const categories = await q.query<{ is_active: boolean }>('SELECT is_active FROM menu_categories WHERE id = $1', [
        category.id,
      ]);
      const groups = await q.query<{ is_active: boolean }>('SELECT is_active FROM modifier_groups WHERE id = $1', [group.id]);
      return { item: items.rows[0], category: categories.rows[0], group: groups.rows[0] };
    });
    expect(stillThere.item?.id).toBe(item.id);
    expect(stillThere.item?.is_active).toBe(true);
    expect(stillThere.category?.is_active).toBe(false);
    expect(stillThere.group?.is_active).toBe(false);
  });

  it('accepts arbitrary language keys on name JSONB with no allow-list', async () => {
    const name = { 'xx-UNREAL': 'Xylophone', 'zh-Hans': '分类', 'fr-CA': 'Catégorie', 'x-emoji': '☕' };
    const category = await engine.createCategory(TENANT_A, { name });
    expect(category.name).toEqual(name);

    const stored = await withAppContext(TENANT_A, async (q) => {
      const result = await q.query<{ name: Record<string, string> }>('SELECT name FROM menu_categories WHERE id = $1', [
        category.id,
      ]);
      return result.rows[0]?.name;
    });
    expect(stored).toEqual(name);
  });

  it('rejects selection_type single with max_selections other than 1 or null in the engine and at CHECK', async () => {
    await expect(
      engine.createModifierGroup(TENANT_A, {
        name: { ar: 'اختيار واحد' },
        selectionType: 'single',
        minSelections: 0,
        maxSelections: 5,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      withAppContext(TENANT_A, async (q) => {
        await q.query(
          `INSERT INTO modifier_groups (tenant_id, name, selection_type, min_selections, max_selections)
           VALUES ($1, $2::jsonb, 'single', 0, 5)`,
          [TENANT_A, { ar: 'bad-single' }],
        );
      }),
    ).rejects.toThrow(/modifier_groups_single_max|check constraint/i);

    const allowed = await engine.createModifierGroup(TENANT_A, {
      name: { ar: 'واحد' },
      selectionType: 'single',
      minSelections: 0,
      maxSelections: 1,
    });
    expect(allowed.maxSelections).toBe(1);
  });

  it('setBranchOverride is a partial merge: omitted schedule is kept, explicit null clears it', async () => {
    const category = await engine.createCategory(TENANT_A, { name: { ar: 'قهوة' } });
    const item = await engine.createItem(TENANT_A, {
      categoryId: category.id,
      name: { ar: 'لاتيه' },
      basePrice: money(1800n, SAR),
    });
    const lunch = {
      timeZone: 'UTC',
      windows: [{ daysOfWeek: [3], start: '15:00', end: '16:00' }],
    };

    await engine.setBranchOverride(TENANT_A, {
      branchId: BRANCH_A1,
      menuItemId: item.id,
      isAvailable: true,
      availabilitySchedule: lunch,
    });
    await engine.setBranchOverride(TENANT_A, {
      branchId: BRANCH_A1,
      menuItemId: item.id,
      priceOverride: money(2500n, SAR),
    });

    const afterPrice = await withAppContext(TENANT_A, async (q) => {
      const result = await q.query<{
        price_override_amount_minor: string | null;
        is_available: boolean;
        availability_schedule: unknown;
      }>(
        `SELECT price_override_amount_minor, is_available, availability_schedule
           FROM branch_menu_item_overrides
          WHERE branch_id = $1 AND menu_item_id = $2`,
        [BRANCH_A1, item.id],
      );
      return result.rows[0];
    });
    expect(afterPrice?.price_override_amount_minor).toBe('2500');
    expect(afterPrice?.is_available).toBe(true);
    expect(afterPrice?.availability_schedule).toEqual(lunch);

    const noon = new Date('2026-03-04T12:00:00.000Z');
    const lunchTime = new Date('2026-03-04T15:30:00.000Z');
    const menuNoon = await engine.getBranchMenu(TENANT_A, BRANCH_A1, noon, 'UTC');
    const menuLunch = await engine.getBranchMenu(TENANT_A, BRANCH_A1, lunchTime, 'UTC');
    expect(menuNoon.categories[0]?.items[0]?.isAvailable).toBe(false);
    expect(menuLunch.categories[0]?.items[0]?.isAvailable).toBe(true);
    expect(menuLunch.categories[0]?.items[0]?.effectivePrice.amountMinor).toBe(2500n);

    await engine.setBranchOverride(TENANT_A, {
      branchId: BRANCH_A1,
      menuItemId: item.id,
      availabilitySchedule: null,
    });
    const cleared = await withAppContext(TENANT_A, async (q) => {
      const result = await q.query<{
        price_override_amount_minor: string | null;
        availability_schedule: unknown;
      }>(
        `SELECT price_override_amount_minor, availability_schedule
           FROM branch_menu_item_overrides
          WHERE branch_id = $1 AND menu_item_id = $2`,
        [BRANCH_A1, item.id],
      );
      return result.rows[0];
    });
    expect(cleared?.availability_schedule).toBeNull();
    expect(cleared?.price_override_amount_minor).toBe('2500');
  });

  it('a branch override does not affect another branch or menu_items.base_price', async () => {
    const category = await engine.createCategory(TENANT_A, { name: { ar: 'قهوة' } });
    const item = await engine.createItem(TENANT_A, {
      categoryId: category.id,
      name: { ar: 'لاتيه', en: 'Latte' },
      basePrice: money(1800n, SAR),
      sku: 'LATTE-1',
    });

    await engine.setBranchOverride(TENANT_A, {
      branchId: BRANCH_A1,
      menuItemId: item.id,
      priceOverride: money(2500n, SAR),
      isAvailable: true,
      availabilitySchedule: { windows: [{ daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59' }] },
    });

    const menu1 = await engine.getBranchMenu(TENANT_A, BRANCH_A1, new Date('2026-03-04T12:00:00.000Z'), 'UTC');
    const menu2 = await engine.getBranchMenu(TENANT_A, BRANCH_A2, new Date('2026-03-04T12:00:00.000Z'), 'UTC');
    expect(menu1.categories[0]?.items[0]?.effectivePrice.amountMinor).toBe(2500n);
    expect(menu2.categories[0]?.items[0]?.effectivePrice.amountMinor).toBe(1800n);
    expect(typeof menu1.categories[0]?.items[0]?.effectivePrice.amountMinor).toBe('bigint');

    const base = await withAppContext(TENANT_A, async (q) => {
      const result = await q.query<{ base_price_amount_minor: string }>(
        'SELECT base_price_amount_minor FROM menu_items WHERE id = $1',
        [item.id],
      );
      return result.rows[0]?.base_price_amount_minor;
    });
    expect(base).toBe('1800');

    const otherOverride = await withAppContext(TENANT_A, async (q) => {
      const result = await q.query(
        'SELECT 1 FROM branch_menu_item_overrides WHERE branch_id = $1 AND menu_item_id = $2',
        [BRANCH_A2, item.id],
      );
      return result.rowCount;
    });
    expect(otherOverride).toBe(0);
  });
});
