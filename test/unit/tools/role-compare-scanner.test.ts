/**
 * Tests for the ESLint-independent role-comparison scanner used by
 * `tools/check-role-compare.ts` (the CI guard).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { scanSource } from '../../../tools/lib/role-compare-scanner.ts';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const GUARD_SCRIPT = join(REPO_ROOT, 'tools', 'check-role-compare.ts');

const kinds = (code: string): string[] => scanSource('fixture.ts', code).map((f) => f.kind);

describe('role-compare-scanner: detection', () => {
  it('flags role identifiers compared to string literals with any equality operator', () => {
    expect(kinds("const a = role === 'ADMIN';")).toEqual(['comparison']);
    expect(kinds("const a = role !== 'ADMIN';")).toEqual(['comparison']);
    expect(kinds('const a = role == "ADMIN";')).toEqual(['comparison']);
    expect(kinds('const a = role != "ADMIN";')).toEqual(['comparison']);
    expect(kinds("const a = 'ADMIN' === role;")).toEqual(['comparison']);
  });

  it('flags property access, element access, calls, and wrapped expressions', () => {
    expect(kinds("if (user.roleName === 'MANAGER') {}")).toEqual(['comparison']);
    expect(kinds("if (ctx.actor.role === 'OWNER') {}")).toEqual(['comparison']);
    expect(kinds("if (roles[0] === 'ADMIN') {}")).toEqual(['comparison']);
    expect(kinds("if (getRole() === 'ADMIN') {}")).toEqual(['comparison']);
    expect(kinds("if (user.getRoleName() === 'ADMIN') {}")).toEqual(['comparison']);
    expect(kinds("if (user?.role === 'ADMIN') {}")).toEqual(['comparison']);
    expect(kinds("if (role! === 'ADMIN') {}")).toEqual(['comparison']);
    expect(kinds("if ((role as string) === 'ADMIN') {}")).toEqual(['comparison']);
    expect(kinds("if ((role satisfies string) === 'ADMIN') {}")).toEqual(['comparison']);
    expect(kinds("if ((await loadRole()) === 'ADMIN') {}")).toEqual(['comparison']);
    expect(kinds('if (role === `ADMIN`) {}')).toEqual(['comparison']);
  });

  it('flags switch statements on a role with string cases', () => {
    expect(kinds("switch (role) { case 'ADMIN': break; default: break; }")).toEqual(['switch']);
    expect(kinds("switch (user.roleName) { case 'A': case 'B': break; }")).toEqual(['switch']);
  });

  it('flags membership tests against string-literal allow-lists', () => {
    expect(kinds("if (['ADMIN', 'MANAGER'].includes(role)) {}")).toEqual(['includes']);
    expect(kinds("if (roles.includes('ADMIN')) {}")).toEqual(['includes']);
    expect(kinds("if (user.roleNames.includes('ADMIN')) {}")).toEqual(['includes']);
  });

  it('reports 1-based line/column and the offending source text', () => {
    const [finding] = scanSource('x.ts', "\n\n  const a = role === 'ADMIN';");
    expect(finding).toBeDefined();
    expect(finding).toMatchObject({ file: 'x.ts', line: 3, column: 13, kind: 'comparison', code: "role === 'ADMIN'" });
  });

  it('is not disabled by eslint-disable comments', () => {
    expect(kinds("// eslint-disable-next-line alpha-shadow/no-role-name-compare\nconst a = role === 'ADMIN';")).toEqual([
      'comparison',
    ]);
  });
});

describe('role-compare-scanner: no false positives', () => {
  it('ignores permission-key checks and non-role comparisons', () => {
    expect(kinds("hasPermission('order:void');")).toEqual([]);
    expect(kinds("if (status === 'ACTIVE') {}")).toEqual([]);
    expect(kinds("if (order.state !== 'PAID') {}")).toEqual([]);
    expect(kinds("switch (status) { case 'OPEN': break; }")).toEqual([]);
    expect(kinds("['a', 'b'].includes(kind);")).toEqual([]);
  });

  it('ignores role comparisons against non-literals (ids from the database)', () => {
    expect(kinds('role === expectedRole;')).toEqual([]);
    expect(kinds('user.roleId === assignment.roleId;')).toEqual([]);
    expect(kinds('roles.includes(roleIdFromDb);')).toEqual([]);
    expect(kinds('allowedRoles.includes(role);')).toEqual([]);
    expect(kinds('role === `${prefix}_ADMIN`;')).toEqual([]);
    expect(kinds('[].includes(role);')).toEqual([]);
  });

  it('ignores string mentions of "role" that are not comparisons', () => {
    expect(kinds("const key = 'role:assign'; hasPermission(key);")).toEqual([]);
    expect(kinds("const label = `Role: ${role}`;")).toEqual([]);
  });
});

describe('check-role-compare CLI (tools/check-role-compare.ts)', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const run = (...args: string[]) =>
    spawnSync(process.execPath, [GUARD_SCRIPT, ...args], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000 });

  it('--self-test exits 0 and proves it flags `role === "ADMIN"`', () => {
    const result = run('--self-test');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('self-test passed');
    expect(result.stdout).toContain("role === 'ADMIN'");
  });

  it('exits 1 on a directory containing a hard-coded role comparison', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alpha-shadow-guard-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'bad.ts'), "declare const role: string;\nexport const x = role === 'ADMIN';\n");
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("role === 'ADMIN'");
    expect(result.stderr).toContain('bad.ts:2:18');
  });

  it('exits 0 on a directory with only permission-key checks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alpha-shadow-guard-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'good.ts'), "declare function can(k: string): boolean;\nexport const x = can('order:void');\n");
    const result = run(dir);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('no hard-coded role comparisons');
  });

  it('exits 2 for a path that does not exist', () => {
    const result = run(join(tmpdir(), 'definitely-missing-' + String(Date.now())));
    expect(result.status).toBe(2);
  });

  it('the real src/ tree is clean', () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
  });
});
