/**
 * Guards the test harness itself against failing OPEN.
 *
 * Background: `embedded-postgres` pulls in `async-exit-hook`, whose
 * `beforeExit` handler calls `process.exit(0)`. If that library is ever loaded
 * into the Vitest main process again (e.g. someone "simplifies" the global
 * setup by importing it directly), a failing contract test would exit 0 and CI
 * would stay green while RLS is broken. These tests make that regression loud.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const VITEST_BIN = resolve(REPO_ROOT, 'node_modules/vitest/vitest.mjs');

describe('test harness: fail-closed exit codes', () => {
  it('postgres.global-setup.ts never imports embedded-postgres into the Vitest main process', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'test/support/postgres.global-setup.ts'), 'utf8');
    const importLines = source.split('\n').filter((line) => /^\s*import\b/.test(line));
    expect(importLines.some((line) => line.includes('embedded-postgres'))).toBe(false);
    expect(importLines.some((line) => line.includes('async-exit-hook'))).toBe(false);
  });

  it('a non-zero process.exitCode survives loading the global setup module', () => {
    const script = [
      "await import('./test/support/postgres.global-setup.ts');",
      'process.exitCode = 1;',
    ].join('\n');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.status, result.stderr).toBe(1);
  });

  describe('a failing test inside a real-database project makes vitest exit non-zero', () => {
    const probeDir = resolve(REPO_ROOT, 'test/contract/__fail-closed-probe__');
    afterEach(() => {
      rmSync(probeDir, { recursive: true, force: true });
    });

    it('contract project', () => {
      mkdirSync(probeDir, { recursive: true });
      writeFileSync(
        resolve(probeDir, 'deliberate-failure.test.ts'),
        "import { expect, it } from 'vitest';\nit('deliberately fails', () => { expect(1).toBe(2); });\n",
      );
      const result = spawnSync(process.execPath, [VITEST_BIN, 'run', '--project', 'contract', '--reporter=dot'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 170_000,
        env: { ...process.env, CI: 'true' },
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
      expect(result.status).not.toBeNull();
    }, 180_000);
  });
});
