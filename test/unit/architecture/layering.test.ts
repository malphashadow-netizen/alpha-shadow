/**
 * Architectural guard tests — executed against the REAL ESLint configuration
 * (`eslint.config.js`), so they fail if someone weakens the config rather than
 * the code.
 *
 * Verifies the hexagonal dependency rule (dependencies point inward only) and
 * that `src/domain` stays a pure core with zero external dependencies.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

/**
 * Lints `code` as if it lived at `filePath` (a virtual path inside the layer
 * under test), using the REAL `eslint.config.js`.
 *
 * The rules being verified here (`no-restricted-imports`, the custom
 * `alpha-shadow/no-role-name-compare`) are purely syntactic. Type-aware rules
 * need the file to exist in the tsconfig project, which a virtual probe file
 * does not, so — for the probe paths only — type-checked linting is switched
 * off via typescript-eslint's own `disableTypeChecked` preset. Everything else
 * in the project config (layer guards, plugin registration, file globs) is
 * exercised unchanged.
 */
const lintAs = async (filePath: string, code: string): Promise<string[]> => {
  const eslint = new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: resolve(REPO_ROOT, 'eslint.config.js'),
    overrideConfig: [{ ...tseslint.configs.disableTypeChecked, files: ['**/probe.ts', '**/probe.test.ts'] }],
  });
  const [result] = await eslint.lintText(code, { filePath: resolve(REPO_ROOT, filePath) });
  return (result?.messages ?? []).map((m) => `${m.ruleId ?? 'fatal'}: ${m.message}`);
};

const hasRule = (messages: string[], ruleId: string): boolean => messages.some((m) => m.startsWith(`${ruleId}:`));

describe('hexagonal layering (eslint.config.js)', () => {
  it('domain may not import application, infrastructure, or presentation', async () => {
    for (const layer of ['application', 'infrastructure', 'presentation']) {
      const messages = await lintAs('src/domain/entities/probe.ts', `import { x } from '../../${layer}/x.ts';\nexport const y = x;\n`);
      expect(hasRule(messages, 'no-restricted-imports'), `domain → ${layer}: ${messages.join(' | ')}`).toBe(true);
    }
  });

  it('domain may not import third-party packages or node built-ins (pure core)', async () => {
    for (const specifier of ['pg', 'jsonwebtoken', 'node:crypto', 'crypto']) {
      const messages = await lintAs('src/domain/entities/probe.ts', `import x from '${specifier}';\nexport const y = x;\n`);
      expect(hasRule(messages, 'no-restricted-imports'), `domain → ${specifier}: ${messages.join(' | ')}`).toBe(true);
    }
  });

  it('domain may import relative modules within domain/ and shared/', async () => {
    const messages = await lintAs(
      'src/domain/entities/probe.ts',
      "import type { Money } from '../../shared/money.ts';\nimport type { Thing } from './thing.ts';\nexport type Probe = { money: Money; thing: Thing };\n",
    );
    expect(hasRule(messages, 'no-restricted-imports'), messages.join(' | ')).toBe(false);
  });

  it('application may not import infrastructure or presentation', async () => {
    for (const layer of ['infrastructure', 'presentation']) {
      const messages = await lintAs('src/application/engines/rbac/probe.ts', `import { x } from '../../../${layer}/x.ts';\nexport const y = x;\n`);
      expect(hasRule(messages, 'no-restricted-imports'), `application → ${layer}: ${messages.join(' | ')}`).toBe(true);
    }
  });

  it('application may import domain', async () => {
    const messages = await lintAs('src/application/engines/rbac/probe.ts', "import type { T } from '../../../domain/contracts/t.ts';\nexport type P = T;\n");
    expect(hasRule(messages, 'no-restricted-imports'), messages.join(' | ')).toBe(false);
  });

  it('infrastructure may not import presentation', async () => {
    const messages = await lintAs('src/infrastructure/db/probe.ts', "import { x } from '../../presentation/x.ts';\nexport const y = x;\n");
    expect(hasRule(messages, 'no-restricted-imports'), messages.join(' | ')).toBe(true);
  });

  it('shared may not import any layer', async () => {
    for (const layer of ['domain', 'application', 'infrastructure', 'presentation']) {
      const messages = await lintAs('src/shared/probe.ts', `import { x } from '../${layer}/x.ts';\nexport const y = x;\n`);
      expect(hasRule(messages, 'no-restricted-imports'), `shared → ${layer}: ${messages.join(' | ')}`).toBe(true);
    }
  });
});

describe('governing principle: no hard-coded role checks (eslint.config.js)', () => {
  it('the custom rule is active on product code', async () => {
    const messages = await lintAs('src/application/engines/rbac/probe.ts', "declare const role: string;\nexport const isAdmin = role === 'ADMIN';\n");
    expect(hasRule(messages, 'alpha-shadow/no-role-name-compare'), messages.join(' | ')).toBe(true);
  });

  it('the custom rule is active on tests and tooling too', async () => {
    const messages = await lintAs('test/unit/probe.test.ts', "declare const role: string;\nexport const isAdmin = role === 'ADMIN';\n");
    expect(hasRule(messages, 'alpha-shadow/no-role-name-compare'), messages.join(' | ')).toBe(true);
  });
});

describe('pg import restriction (eslint.config.js)', () => {
  it('src/presentation may not import pg directly', async () => {
    const messages = await lintAs('src/presentation/routes/probe.ts', "import pg from 'pg';\nexport const x = pg;\n");
    expect(hasRule(messages, 'no-restricted-imports')).toBe(true);
  });

  it('src/application may not import pg directly', async () => {
    const messages = await lintAs('src/application/engines/orders/probe.ts', "import pg from 'pg';\nexport const x = pg;\n");
    expect(hasRule(messages, 'no-restricted-imports')).toBe(true);
  });

  it('src/domain may not import pg directly (also pure core)', async () => {
    const messages = await lintAs('src/domain/entities/probe.ts', "import pg from 'pg';\nexport const x = pg;\n");
    expect(hasRule(messages, 'no-restricted-imports')).toBe(true);
  });

  it('src/infrastructure/db/pool.ts and tenant-context.ts ARE allowed to import pg', async () => {
    for (const file of ['src/infrastructure/db/pool.ts', 'src/infrastructure/db/tenant-context.ts']) {
      const messages = await lintAs(file, "import pg from 'pg';\nexport const x = pg;\n");
      expect(hasRule(messages, 'no-restricted-imports'), `${file} should be allowed`).toBe(false);
    }
  });

  it('tools/migrate.ts is allowed to import pg', async () => {
    const messages = await lintAs('tools/migrate.ts', "import pg from 'pg';\nexport const x = pg;\n");
    expect(hasRule(messages, 'no-restricted-imports')).toBe(false);
  });

  it('test files are exempt and may import pg freely', async () => {
    const messages = await lintAs('test/support/database.ts', "import pg from 'pg';\nexport const x = pg;\n");
    expect(hasRule(messages, 'no-restricted-imports')).toBe(false);
  });

  it('src/shared may not import pg', async () => {
    const messages = await lintAs('src/shared/probe.ts', "import pg from 'pg';\nexport const x = pg;\n");
    expect(hasRule(messages, 'no-restricted-imports')).toBe(true);
  });
});
