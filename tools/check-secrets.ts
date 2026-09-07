#!/usr/bin/env node
/**
 * CI guard: fail the build if any REAL password/PIN/pepper/key literal is
 * present in the tree (acceptance #3 — zero plaintext, tests included).
 *
 * Usage:
 *   node tools/check-secrets.ts               # scan src/, test/, tools/, migrations/
 *   node tools/check-secrets.ts <dir|file>…   # scan given paths
 *   node tools/check-secrets.ts --self-test   # prove the guard flags planted secrets
 *
 * Exit codes: 0 = clean, 1 = violations found (or self-test failed), 2 = usage.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatSecretFinding, scanSourceForPlaintextSecrets, type SecretFinding } from './lib/plaintext-secret-scanner.ts';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_TARGETS = ['src', 'test', 'tools', 'migrations'].map((d) => join(REPO_ROOT, d));
const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set(['.ts', '.tsx', '.mts', '.cts', '.sql', '.js', '.json', '.example', '.yml', '.yaml']);
const SKIPPED_DIRS: ReadonlySet<string> = new Set(['node_modules', 'dist', '.git', '.embedded-postgres', 'coverage']);

function hasSourceExtension(fileName: string): boolean {
  if (fileName.endsWith('.env.example') || fileName === '.env.example') return true;
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

function scanPaths(paths: readonly string[]): { findings: SecretFinding[]; filesScanned: number } {
  const findings: SecretFinding[] = [];
  let filesScanned = 0;
  for (const root of paths) {
    for (const file of walk(root)) {
      filesScanned += 1;
      const source = readFileSync(file, 'utf8');
      const rel = relative(REPO_ROOT, file);
      findings.push(...scanSourceForPlaintextSecrets(source, rel));
    }
  }
  return { findings, filesScanned };
}

function selfTest(): void {
  const dir = mkdtempSync(join(tmpdir(), 'secret-scanner-'));
  const planted = join(dir, 'planted.ts');
  // Deliberately planted plaintext secrets the guard MUST flag.
  writeFileSync(
    planted,
    [
      "// planted-fixture: scanner must flag the next literal",
      "const login = { password: 'RealStrongPassword99!' };",
      "// planted-fixture",
      "const body = { mode: 'pin', pin: '4829' };",
      "// planted-fixture",
      "const pepper = 'WJ90Xr4Kk2Nc8Z0Yp7Lm6Qe3T1Ub5Hv0Dw4Sx2Ga8=';",
    ].join('\n'),
  );
  const clean = join(dir, 'clean.ts');
  // Runtime-generated values / placeholders the guard MUST allow.
  writeFileSync(
    clean,
    [
      "const password = generatePassword();",
      "const pin = generatePin();",
      "const token: 'Bearer' = 'Bearer';",
      "const envPassword = process.env['DATABASE_URL'];",
      "const demo = { password: '<secret-from-secret-manager>' };",
      "const marker = 'scrypt$N=16$r=8$p=1$aa$bb';",
      "const schemaTest = { password: 'p', refreshToken: 'a.b.c', pin: '1' };",
      "const malformedJwt = { refreshToken: 'not-a-jwt' };",
    ].join('\n'),
  );

  const { findings } = scanPaths([dir]);
  const plantedFindings = findings.filter((f) => f.file.endsWith('planted.ts'));
  const cleanFindings = findings.filter((f) => f.file.endsWith('clean.ts'));

  const ok =
    plantedFindings.length >= 3 &&
    cleanFindings.length === 0 &&
    plantedFindings.some((f) => f.reason.includes('PIN'));

  rmSync(dir, { recursive: true, force: true });

  if (!ok) {
    console.error(`[secret-scanner] self-test FAILED.
  planted findings (want >= 3): ${String(plantedFindings.length)}
  clean false-positives (want 0): ${String(cleanFindings.length)}
${findings.map(formatSecretFinding).join('\n')}`);
    process.exit(1);
  }
  console.log('[secret-scanner] self-test passed — planted secrets flagged, placeholders allowed.');
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    selfTest();
    return;
  }
  const targets = args.length > 0 ? args.map((a) => resolve(a)) : DEFAULT_TARGETS;
  const { findings, filesScanned } = scanPaths(targets);
  if (findings.length > 0) {
    console.error(`[secret-scanner] FAILED — ${findings.length} plaintext-looking secret(s) in ${filesScanned} files:\n`);
    console.error(findings.map(formatSecretFinding).join('\n\n'));
    process.exit(1);
  }
  console.log(`[secret-scanner] no plaintext secrets found (${filesScanned} files scanned).`);
}

try {
  main();
} catch (error: unknown) {
  console.error('[secret-scanner] usage/IO error:', error);
  process.exit(2);
}
