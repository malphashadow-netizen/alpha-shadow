/**
 * CI contract for the `pg` import allow-list (single source of truth) and the
 * migration/DB policy files.
 *
 * Guards (all fail closed):
 *   1. `eslint.config.js` consumes the allow-list from
 *      `eslint-rules/pg-import-policy.ts` — no second hard-coded list.
 *   2. NO file under `src/` or `tools/` imports `pg` unless it is in the
 *      single allow-list (strict scan, independent of ESLint).
 *   3. `test/support/database.ts` never imports real production code from
 *      `src/` (it may only construct raw pg clients for the test harness).
 *   4. `tools/migrate.ts` uses MIGRATION_DATABASE_URL exclusively (no
 *      DATABASE_URL fallback for schema changes).
 *   5. `exactOptionalPropertyTypes` stays enabled; the migration RLS template
 *      docs + guard exist.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PG_IMPORT_ALLOWLIST, PG_IMPORT_RESTRICTION_MESSAGE } from '../../../eslint-rules/pg-import-policy.ts';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

function walk(dir: string, extensions: string[], out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, extensions, out);
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

function findRawPgImports(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const matches = [...source.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*['"]pg['"]/g)];
  return matches.map((m) => m[0]);
}

describe('pg import policy — single source of truth', () => {
  it('eslint.config.js uses the shared allow-list module (no duplicated literals)', () => {
    const config = readFileSync(join(REPO_ROOT, 'eslint.config.js'), 'utf8');
    expect(config).toContain("PG_IMPORT_ALLOWLIST");
    expect(config).toContain("PG_IMPORT_RESTRICTION");
    expect(config).not.toContain('src/infrastructure/db/pool.ts, src/infrastructure/db/tenant-context.ts, and tools/migrate.ts');
    expect(PG_IMPORT_ALLOWLIST).toHaveLength(4);
  });

  it('every production/tool file importing pg is on the allow-list (strict scan)', () => {
    const files = [...walk(join(REPO_ROOT, 'src'), ['.ts']), ...walk(join(REPO_ROOT, 'tools'), ['.ts'])];
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(REPO_ROOT, file);
      if (findRawPgImports(file).length > 0 && !PG_IMPORT_ALLOWLIST.includes(rel)) {
        offenders.push(rel);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('allow-list entries exist and match the eslint exemption file globs', () => {
    for (const file of PG_IMPORT_ALLOWLIST) {
      expect(() => readFileSync(join(REPO_ROOT, file), 'utf8')).not.toThrow();
    }
    expect(PG_IMPORT_RESTRICTION_MESSAGE).toContain('withTenantContext');
  });
});

describe('test support policy', () => {
  it('test/support/database.ts imports no production code from src/', () => {
    const source = readFileSync(join(REPO_ROOT, 'test/support/database.ts'), 'utf8');
    const srcImport = source.match(/from\s+['"][^'"]*src\/[^'"]*['"]/g);
    expect(srcImport, srcImport?.join('\n') ?? '(none)').toBeNull();
  });
});

describe('migration tooling policy', () => {
  it('tools/migrate.ts uses MIGRATION_DATABASE_URL exclusively (no DATABASE_URL fallback)', () => {
    const source = readFileSync(join(REPO_ROOT, 'tools/migrate.ts'), 'utf8');
    expect(source).toContain('MIGRATION_DATABASE_URL');
    expect(source).toContain('assertMigrationEnvironment');
    expect(source).not.toContain('?? databaseUrl');
    expect(source).not.toMatch(/process\.env\[['"]DATABASE_URL['"]\]/);
    expect(source).toContain('checkMigrationFile');
  });

  it('exactOptionalPropertyTypes is enabled and the RLS template is documented', () => {
    const base = readFileSync(join(REPO_ROOT, 'tsconfig.base.json'), 'utf8');
    expect(base).toContain('"exactOptionalPropertyTypes": true');
    const template = readFileSync(join(REPO_ROOT, 'migrations/README.md'), 'utf8');
    expect(template).toContain('ENABLE ROW LEVEL SECURITY');
    expect(template).toContain('FORCE ROW LEVEL SECURITY');
    expect(template).toContain('CREATE POLICY tenant_isolation');
    expect(template).toContain('cascade-approvals');
  });

  it('migration guard self-test is wired into npm scripts and CI', () => {
    const pkg = readFileSync(join(REPO_ROOT, 'package.json'), 'utf8');
    expect(pkg).toContain('"check:migrations"');
    const ci = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('npm run check:migrations');
  });
});
