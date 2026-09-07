/**
 * Static guard for migrations/0008_phase5_catalog.sql (no database needed).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CATALOG_PERMISSION_ARCHIVE,
  CATALOG_PERMISSION_CATEGORY,
  CATALOG_PERMISSION_KEYS,
  CATALOG_PERMISSION_READ,
  CATALOG_PERMISSION_WRITE,
} from '../../../src/domain/contracts/catalog-permissions.ts';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const MIGRATION = join(REPO_ROOT, 'migrations', '0008_phase5_catalog.sql');
const HOTFIX = join(REPO_ROOT, 'migrations', '0009_phase5_modifier_single_max.sql');
const ROLES = join(REPO_ROOT, 'migrations', 'roles', '005_app_login_catalog.sql');

const TABLES = [
  'menu_categories',
  'menu_items',
  'branch_menu_item_overrides',
  'modifier_groups',
  'modifiers',
  'menu_item_modifier_groups',
] as const;

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

const sql = readFileSync(MIGRATION, 'utf8');
const code = stripSqlComments(sql);

describe('migrations/0008_phase5_catalog.sql — static contract', () => {
  it('is the next migration after 0007 (0001–0007 are untouched)', () => {
    const files = readdirSync(join(REPO_ROOT, 'migrations')).filter((name) => name.endsWith('.sql')).sort();
    expect(files).toContain('0007_seed_currencies.sql');
    expect(files).toContain('0008_phase5_catalog.sql');
    expect(files.indexOf('0008_phase5_catalog.sql')).toBe(files.indexOf('0007_seed_currencies.sql') + 1);
  });

  it('creates exactly the six catalog tables, each with tenant_id NOT NULL', () => {
    for (const table of TABLES) {
      expect(code).toMatch(new RegExp(`create\\s+table\\s+if\\s+not\\s+exists\\s+${table}`, 'i'));
      expect(code).toMatch(new RegExp(`${table}[\\s\\S]*?tenant_id\\s+uuid\\s+not\\s+null`, 'i'));
    }
    expect([...code.matchAll(/create\s+table\s+if\s+not\s+exists/gi)]).toHaveLength(6);
  });

  it('applies ENABLE + FORCE RLS and tenant_isolation once per table', () => {
    expect([...code.matchAll(/enable\s+row\s+level\s+security/gi)]).toHaveLength(6);
    expect([...code.matchAll(/force\s+row\s+level\s+security/gi)]).toHaveLength(6);
    expect([...code.matchAll(/create\s+policy\s+tenant_isolation/gi)]).toHaveLength(6);
    expect(code).toMatch(/using\s*\(\s*tenant_id\s*=\s*current_setting\('app\.current_tenant_id'\)::uuid\s*\)/i);
    expect(code).toMatch(/with\s+check\s*\(\s*tenant_id\s*=\s*current_setting\('app\.current_tenant_id'\)::uuid\s*\)/i);
  });

  it('uses ON DELETE RESTRICT on catalog FKs and never DROP TABLE / CASCADE', () => {
    expect(code).toMatch(/on\s+delete\s+restrict/i);
    expect(code).not.toMatch(/\bdrop\s+table\b/i);
    expect(code).not.toMatch(/\bcascade\b/i);
  });

  it('stores money as BIGINT minor units, never NUMERIC/float, and uses money.ts currency shape', () => {
    expect(code).toMatch(/base_price_amount_minor\s+bigint/i);
    expect(code).toMatch(/price_override_amount_minor\s+bigint/i);
    expect(code).toMatch(/price_delta_amount_minor\s+bigint/i);
    expect(code).not.toMatch(/base_price_amount_minor\s+numeric/i);
    expect(code).not.toMatch(/\bdouble\s+precision\b/i);
    expect(code).not.toMatch(/\breal\b/i);
  });

  it('leaves tax_rule_id without a FK (Phase-6 hook) and documents the future ALTER', () => {
    expect(sql).toMatch(/tax_rule_id\s+uuid\s+NULL/i);
    expect(sql).toMatch(/REFERENCES tax_rules \(id\)/);
    const taxLine = [...code.matchAll(/tax_rule_id[\s\S]{0,80}/gi)].map((match) => match[0]).join(' ');
    expect(taxLine).not.toMatch(/tax_rule_id\s+uuid\s+null\s+references/i);
  });

  it('rejects min_selections > max_selections at the CHECK boundary', () => {
    expect(code).toMatch(/min_selections\s*<=\s*max_selections/i);
  });

  it('does not constrain JSONB name keys to a language list', () => {
    expect(code).not.toMatch(/'ar'\s*,\s*'en'/);
    expect(code).not.toMatch(/supported_languages/i);
    expect(code).not.toMatch(/language_code/i);
    expect(code).toMatch(/jsonb_typeof\(\s*name\s*\)\s*=\s*'object'/i);
  });

  it('seeds catalog:read/write/archive as non-sensitive global registry keys', () => {
    expect(CATALOG_PERMISSION_KEYS).toEqual([CATALOG_PERMISSION_READ, CATALOG_PERMISSION_WRITE, CATALOG_PERMISSION_ARCHIVE]);
    expect(CATALOG_PERMISSION_CATEGORY).toBe('catalog');
    expect(code).toMatch(/insert\s+into\s+permissions_registry/i);
    expect(code).toMatch(/'catalog:read'\s*,\s*'catalog'\s*,\s*false/i);
    expect(code).toMatch(/'catalog:write'\s*,\s*'catalog'\s*,\s*false/i);
    expect(code).toMatch(/'catalog:archive'\s*,\s*'catalog'\s*,\s*false/i);
    expect(code).toMatch(/on\s+conflict\s*\(\s*key\s*\)\s*do\s+nothing/i);
    expect(code).not.toMatch(/do\s+update/i);
  });

  it('does not seed tenants or probe data', () => {
    expect(sql).not.toMatch(/INSERT\s+INTO\s+tenants/i);
    expect(sql).not.toMatch(/probe-tenant/i);
  });
});

describe('migrations/0009_phase5_modifier_single_max.sql — static contract', () => {
  const hotfix = stripSqlComments(readFileSync(HOTFIX, 'utf8'));

  it('is the next file after 0008 and does not rewrite 0008', () => {
    const files = readdirSync(join(REPO_ROOT, 'migrations')).filter((name) => name.endsWith('.sql')).sort();
    expect(files).toContain('0009_phase5_modifier_single_max.sql');
    expect(files.indexOf('0009_phase5_modifier_single_max.sql')).toBe(files.indexOf('0008_phase5_catalog.sql') + 1);
    expect(sql).not.toMatch(/modifier_groups_single_max/);
  });

  it('adds CHECK that single implies max_selections is 1 or NULL, without DROP TABLE / CASCADE', () => {
    expect(hotfix).toMatch(/modifier_groups_single_max/);
    expect(hotfix).toMatch(
      /selection_type\s*<>\s*'single'\s+OR\s+max_selections\s+IS\s+NULL\s+OR\s+max_selections\s*=\s*1/i,
    );
    expect(hotfix).not.toMatch(/\bdrop\s+table\b/i);
    expect(hotfix).not.toMatch(/\bcascade\b/i);
  });
});

describe('migrations/roles/005_app_login_catalog.sql', () => {
  it('grants SELECT/INSERT/UPDATE/DELETE on all six tables to app_login', () => {
    const roles = stripSqlComments(readFileSync(ROLES, 'utf8'));
    for (const table of TABLES) {
      expect(roles).toMatch(
        new RegExp(`grant\\s+select\\s*,\\s*insert\\s*,\\s*update\\s*,\\s*delete\\s+on\\s+${table}\\s+to\\s+app_login`, 'i'),
      );
    }
  });
});

describe('src/ catalog engine — no language allow-list in product code', () => {
  it('never enumerates language codes in the catalog engine or rules', () => {
    const files = [
      join(REPO_ROOT, 'src/domain/contracts/catalog-rules.ts'),
      join(REPO_ROOT, 'src/application/engines/catalog/catalog-engine.ts'),
      join(REPO_ROOT, 'src/application/engines/catalog/availability.ts'),
    ];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/SUPPORTED_LANG/);
      expect(source, file).not.toMatch(/LANGUAGE_CODES/);
      expect(source, file).not.toMatch(/\['ar'\s*,\s*'en'\]/);
      expect(source, file).not.toMatch(/\['en'\s*,\s*'ar'\]/);
    }
  });
});
