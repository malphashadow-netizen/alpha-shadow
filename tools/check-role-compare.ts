#!/usr/bin/env node
/**
 * CI guard: fail the build if any file under `src/` contains a hard-coded
 * role-name comparison (see `tools/lib/role-compare-scanner.ts`).
 *
 * Usage:
 *   node tools/check-role-compare.ts               # scan src/ (default)
 *   node tools/check-role-compare.ts <dir|file>…   # scan given paths
 *   node tools/check-role-compare.ts --self-test   # prove the guard works
 *
 * `--self-test` writes a throw-away file containing `role === 'ADMIN'` into a
 * temp directory, scans it, and exits 0 ONLY if the scanner flagged it. This
 * satisfies the Phase-0 acceptance criterion: "the role-string check must fail
 * on purpose against a sample file containing role === 'ADMIN' before any real
 * code exists" — and it re-proves that on every CI run, so a future regression
 * in the scanner itself cannot silently disable the guard.
 *
 * Exit codes: 0 = clean, 1 = violations found (or self-test failed),
 *             2 = usage / IO error.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatFinding, scanSource, type Finding } from './lib/role-compare-scanner.ts';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_TARGET = join(REPO_ROOT, 'src');
const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set(['.ts', '.tsx', '.mts', '.cts']);
const SKIPPED_DIRS: ReadonlySet<string> = new Set(['node_modules', 'dist', '.git']);

function hasSourceExtension(fileName: string): boolean {
  const dot = fileName.lastIndexOf('.');
  if (dot === -1) return false;
  if (fileName.endsWith('.d.ts')) return false;
  return SOURCE_EXTENSIONS.has(fileName.slice(dot));
}

function* walk(path: string): Generator<string> {
  const stats = statSync(path);
  if (stats.isFile()) {
    if (hasSourceExtension(path)) yield path;
    return;
  }
  if (!stats.isDirectory()) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) yield* walk(join(path, entry.name));
    } else if (entry.isFile() && hasSourceExtension(entry.name)) {
      yield join(path, entry.name);
    }
  }
}

function scanPaths(paths: readonly string[]): { findings: Finding[]; filesScanned: number } {
  const findings: Finding[] = [];
  let filesScanned = 0;
  for (const root of paths) {
    for (const file of walk(root)) {
      filesScanned += 1;
      const text = readFileSync(file, 'utf8');
      const rel = relative(REPO_ROOT, file) || file;
      findings.push(...scanSource(rel, text));
    }
  }
  return { findings, filesScanned };
}

function selfTest(): number {
  const dir = mkdtempSync(join(tmpdir(), 'alpha-shadow-role-guard-'));
  try {
    // Deliberately violating fixture. It must be flagged, otherwise the guard is broken.
    const violating = join(dir, 'violating.ts');
    writeFileSync(
      violating,
      [
        "declare const role: string;",
        "declare const user: { roleName: string; roles: string[] };",
        "export const a = role === 'ADMIN';",
        'export const b = user.roleName == "MANAGER";',
        "export const c = 'CASHIER' !== user.roles[0];",
        "export const d = ['ADMIN', 'OWNER'].includes(role);",
        "export function e(): number { switch (role) { case 'ADMIN': return 1; default: return 0; } }",
        '',
      ].join('\n'),
    );
    // Deliberately clean fixture. It must NOT be flagged (guards against a scanner that flags everything).
    const clean = join(dir, 'clean.ts');
    writeFileSync(
      clean,
      [
        "declare const status: string;",
        "declare function hasPermission(key: string): boolean;",
        "export const a = status === 'ACTIVE';",
        "export const b = hasPermission('order:void');",
        "export const c = ['a', 'b'].includes(status);",
        '',
      ].join('\n'),
    );

    const violatingFindings = scanSource('violating.ts', readFileSync(violating, 'utf8'));
    const cleanFindings = scanSource('clean.ts', readFileSync(clean, 'utf8'));

    const expectedKinds: readonly Finding['kind'][] = ['comparison', 'comparison', 'comparison', 'includes', 'switch'];
    const actualKinds = violatingFindings.map((f) => f.kind);
    const violatingOk =
      actualKinds.length === expectedKinds.length && actualKinds.every((k, i) => k === expectedKinds[i]);
    const cleanOk = cleanFindings.length === 0;

    if (violatingOk && cleanOk) {
      console.log(`[check-role-compare] self-test passed: ${String(violatingFindings.length)} violations flagged in fixture, 0 false positives on clean fixture.`);
      for (const f of violatingFindings) console.log('  ' + formatFinding(f));
      return 0;
    }
    console.error('[check-role-compare] SELF-TEST FAILED — the role-comparison guard is not working.');
    console.error(`  expected kinds: ${expectedKinds.join(', ')}`);
    console.error(`  actual kinds:   ${actualKinds.join(', ') || '(none)'}`);
    if (!cleanOk) {
      console.error('  false positives on clean fixture:');
      for (const f of cleanFindings) console.error('    ' + formatFinding(f));
    }
    return 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(argv: readonly string[]): number {
  if (argv.includes('--self-test')) return selfTest();

  const targets = argv.length > 0 ? argv.map((p) => resolve(p)) : [DEFAULT_TARGET];
  for (const t of targets) {
    try {
      statSync(t);
    } catch {
      console.error(`[check-role-compare] path not found: ${t}`);
      return 2;
    }
  }

  const { findings, filesScanned } = scanPaths(targets);
  if (findings.length === 0) {
    console.log(`[check-role-compare] OK — ${String(filesScanned)} file(s) scanned, no hard-coded role comparisons.`);
    return 0;
  }
  console.error(`[check-role-compare] FAILED — ${String(findings.length)} hard-coded role comparison(s) in ${String(filesScanned)} file(s):`);
  for (const f of findings) console.error('  ' + formatFinding(f));
  console.error('\nAuthorization must be checked against atomic permission keys (e.g. `order:void`) via the RBAC engine — never against role names.');
  return 1;
}

process.exitCode = main(process.argv.slice(2));
