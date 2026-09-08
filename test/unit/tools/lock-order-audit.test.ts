/**
 * B3 — row-lock allowlist: every `SELECT … FOR UPDATE / FOR SHARE` in
 * PRODUCTION code (`src/`) must be an audited entry below, in lockstep with
 * the documented lock-order audit (`docs/concurrency-and-locking.md`).
 *
 * A new lock — or even a reworded SQL line — fails this test UNTIL the author
 * extends the audit document AND adds the line here in the same commit. The
 * match key is `file :: collapsed-line` (deliberately NOT the line number, so
 * unrelated insertions above never break the audit).
 *
 * Honest scope: this is a PRESENCE guard (no unaudited lock can slip in
 * silently). The lock ORDER itself is documented and human-reviewed; static
 * dataflow proof of acquisition order is out of reach for a unit test, and
 * this file does not pretend otherwise.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const SRC_ROOT = join(REPO_ROOT, 'src');
const MIGRATIONS_ROOT = join(REPO_ROOT, 'migrations');

const ROW_LOCK_PATTERN = /\bFOR\s+(NO\s+KEY\s+)?UPDATE\b|\bFOR\s+(KEY\s+)?SHARE\b/;

function listFilesRecursive(dir: string, suffix: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...listFilesRecursive(full, suffix));
    } else if (entry.endsWith(suffix)) {
      found.push(full);
    }
  }
  return found;
}

function isCommentLine(trimmed: string): boolean {
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

function collapseWhitespace(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

/** Every row-lock site in production code, as `relative-path :: collapsed-line`. */
function scanRowLocks(): string[] {
  const keys: string[] = [];
  for (const file of listFilesRecursive(SRC_ROOT, '.ts')) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const line of lines) {
      if (isCommentLine(line.trim())) continue;
      if (!ROW_LOCK_PATTERN.test(line)) continue;
      keys.push(`${relative(REPO_ROOT, file)} :: ${collapseWhitespace(line)}`);
    }
  }
  return keys.sort();
}

describe('B3 row-lock audit (static)', () => {
  it('every production row lock is an audited allowlist entry', () => {
    // To extend: document the new lock in docs/concurrency-and-locking.md
    // FIRST, then add its `file :: line` key here in the same commit.
    const allowlist = [
      // Auth sessions: single-row locks inside one short transaction (pre-B2, audited).
      "src/infrastructure/security/postgres-auth-repository.ts :: FOR UPDATE`,",
      "src/infrastructure/security/postgres-auth-repository.ts :: 'SELECT is_active, locked_until FROM users WHERE tenant_id = $1 AND id = $2 FOR SHARE',",
      // Catalog tax edit: single menu_items row (pre-B2, audited).
      "src/infrastructure/db/repositories/postgres-catalog-repository.ts :: const before = await q.query<{ tax_rule_id: string | null }>('SELECT tax_rule_id FROM menu_items WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId, item.id]);",
      // Manager override counters: single throttle-row (pre-B2, audited).
      'src/infrastructure/db/repositories/postgres-manager-override-authenticator.ts :: WHERE tenant_id = $1 AND ${idColumn} = $2 FOR UPDATE`,',
      // Super-admin guard: last-admin check, twice with identical text (assignRole + removeRole).
      "src/infrastructure/db/repositories/postgres-permission-repository.ts :: 'SELECT id FROM user_roles WHERE tenant_id = $1 AND role_id = $2 AND is_active = true FOR UPDATE',",
      "src/infrastructure/db/repositories/postgres-permission-repository.ts :: 'SELECT id FROM user_roles WHERE tenant_id = $1 AND role_id = $2 AND is_active = true FOR UPDATE',",
      "src/infrastructure/db/repositories/postgres-permission-repository.ts :: 'SELECT user_id FROM user_roles WHERE tenant_id = $1 AND role_id = $2 AND is_active = true FOR UPDATE',",
      // Tenant tax admin: single mapping row (pre-B2, audited).
      'src/infrastructure/db/repositories/postgres-tenant-tax-admin-repository.ts :: WHERE tenant_id = $1 AND branch_id = $2 AND menu_item_tax_category_id = $3 FOR UPDATE`, [actor.tenantId, input.branchId, input.menuItemTaxCategoryId]);',
      // B2: uniform orders → shifts order, first statement of every order-mutating transaction.
      "src/infrastructure/db/repositories/postgres-orders-store.ts :: const result = await q.query<OrderRow>('SELECT * FROM orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tid, orderId]);",
      "src/infrastructure/db/repositories/postgres-payments-store.ts :: const result = await q.query<{ id: string }>('SELECT id FROM orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tid, orderId]);",
      "src/infrastructure/db/repositories/postgres-payments-store.ts :: const result = await q.query<ShiftRow>('SELECT * FROM shift_reconciliations WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tid, shiftId]);",
      "src/infrastructure/db/repositories/postgres-shifts-store.ts :: const result = await q.query<ShiftRow>('SELECT * FROM shift_reconciliations WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tid, shiftId]);",
      // Outbox side-effect claim: single delivery-log row (pre-B2, audited).
      'src/infrastructure/db/repositories/postgres-orders-store.ts :: FOR UPDATE`,',
    ].sort();

    expect(scanRowLocks()).toEqual(allowlist);
  });

  it('no advisory locks and no LOCK TABLE in production code', () => {
    for (const file of listFilesRecursive(SRC_ROOT, '.ts')) {
      const content = readFileSync(file, 'utf8');
      expect(content, `${relative(REPO_ROOT, file)} must not use advisory locks`).not.toContain('pg_advisory');
      expect(content, `${relative(REPO_ROOT, file)} must not use LOCK TABLE`).not.toContain('LOCK TABLE');
    }
  });

  it('function/trigger row locks in migrations are audited; LOCK TABLE stays migrate-time only', () => {
    // Executable SQL only: strip block comments and full-line `--` comments
    // (prose may name locks; only statements lock).
    const executableLines = (content: string): string[] =>
      content
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'));

    const actual: string[] = [];
    const lockTableFiles: string[] = [];
    for (const file of listFilesRecursive(MIGRATIONS_ROOT, '.sql')) {
      const rel = relative(REPO_ROOT, file);
      for (const line of executableLines(readFileSync(file, 'utf8'))) {
        if (ROW_LOCK_PATTERN.test(line)) actual.push(`${rel} :: ${collapseWhitespace(line)}`);
      }
      if (readFileSync(file, 'utf8').includes('LOCK TABLE')) lockTableFiles.push(rel);
    }

    // Audited function/trigger locks: each is confined to one admin write or
    // one trigger firing over rows no app transaction locks out of order —
    // EXCEPT the stock-trigger line, the X-side of finding F-1 (see the doc).
    expect(actual.sort()).toEqual(
      [
        'migrations/0010_phase6_tax_jurisdictions.sql :: SELECT * INTO previous FROM public.tax_rates WHERE id = p_id FOR UPDATE;',
        'migrations/0015_phase6_branch_tax_overrides.sql :: WHERE id = NEW.branch_id AND tenant_id = NEW.tenant_id FOR SHARE;',
        'migrations/0016_phase6_menu_item_tax_category.sql :: SELECT tax_rule_id INTO primary_id FROM public.menu_items WHERE id = item_id FOR UPDATE;',
        'migrations/0016_phase6_menu_item_tax_category.sql :: PERFORM 1 FROM public.menu_items WHERE id = p_item AND tenant_id = tid AND is_active FOR UPDATE;',
        'migrations/0016_phase6_menu_item_tax_category.sql :: PERFORM 1 FROM public.branches WHERE id = p_branch AND tenant_id = tid FOR UPDATE;',
        'migrations/0016_phase6_menu_item_tax_category.sql :: INTO previous FROM public.tenants WHERE id = tid FOR UPDATE;',
        'migrations/0040_phase9_stock_movements.sql :: WHERE id = NEW.inventory_item_id AND tenant_id = NEW.tenant_id FOR UPDATE;',
        'migrations/0042_phase9_override_message_fix.sql :: WHERE id = NEW.inventory_item_id AND tenant_id = NEW.tenant_id FOR UPDATE;',
        'migrations/0043_phase9_override_actor_wording.sql :: WHERE id = NEW.inventory_item_id AND tenant_id = NEW.tenant_id FOR UPDATE;',
      ].sort(),
    );
    // 0013's LOCK TABLE is migrate-time DDL serialization, never runtime SQL.
    expect(lockTableFiles).toEqual(['migrations/0013_phase6_branch_country_not_null.sql']);
  });
});
