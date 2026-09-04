/**
 * ESLint flat config (ESLint 10, typescript-eslint 8).
 *
 * This config is a `.ts` file. ESLint loads it through Node's built-in
 * TypeScript type stripping when the `unstable_native_nodejs_ts_config` flag
 * is set — `package.json` sets `ESLINT_FLAGS=unstable_native_nodejs_ts_config`
 * on every script that runs ESLint (`lint:eslint`, `test`, `test:unit`), so no
 * extra loader (jiti/tsx) is needed.
 *
 * Layering rules (hexagonal modular monolith) are enforced here with
 * `no-restricted-imports`, so a violation fails CI rather than being caught in
 * code review:
 *
 *   domain        → may import nothing outside `src/domain` and `src/shared`
 *   application   → may not import `infrastructure` or `presentation`
 *   infrastructure→ may not import `presentation`
 *   shared        → may import nothing from other layers
 *
 * Additionally, `src/domain` may not import ANY third-party package
 * (no `pg`, no `jsonwebtoken`, …) and not even `node:` built-ins: it must stay
 * a pure TypeScript core.
 */
import eslintJs from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

import { alphaShadowPlugin } from './eslint-rules/index.ts';

/** Matches any relative import that climbs out of the current layer directory. */
const layerImportGuard = (forbiddenLayers: readonly string[]) => ({
  patterns: forbiddenLayers.map((layer) => ({
    regex: `(^|/)${layer}(/|$)`,
    message: `This layer must not import from "${layer}" (hexagonal dependency rule: dependencies point inward only).`,
  })),
});

export default defineConfig([
  globalIgnores(['dist/**', 'node_modules/**', 'coverage/**', '.embedded-postgres/**']),

  // ---------------------------------------------------------------------------
  // Base: JS recommended + TS strict (type-checked) + stylistic
  // ---------------------------------------------------------------------------
  eslintJs.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // ---------------------------------------------------------------------------
  // Project-wide rules
  // ---------------------------------------------------------------------------
  {
    files: ['**/*.ts'],
    plugins: {
      'alpha-shadow': alphaShadowPlugin,
    },
    rules: {
      // Governing principle: no hard-coded role checks — anywhere.
      'alpha-shadow/no-role-name-compare': 'error',

      // Safety / correctness
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['error', 'warn'] }],
      'no-restricted-syntax': [
        'error',
        {
          // Money must never be a float — see shared/money.ts (BigInt minor units).
          selector: 'TSTypeReference > Identifier[name="Number"]',
          message: 'Use `number` primitive or, for money, `Money` (BigInt minor units). Never `Number` wrapper type.',
        },
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: false, allowAny: false, allowNullish: false, allowRegExp: false },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },

  // ---------------------------------------------------------------------------
  // Hexagonal layering — dependencies point inward only
  // ---------------------------------------------------------------------------
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          ...layerImportGuard(['application', 'infrastructure', 'presentation']),
          // Domain is a pure core: forbid every bare-specifier (third-party or node:) import.
          patterns: [
            ...layerImportGuard(['application', 'infrastructure', 'presentation']).patterns,
            {
              regex: '^(?!\\.{1,2}/)',
              message:
                'src/domain must have zero external dependencies (no third-party packages, no node: built-ins). Only relative imports within domain/ or shared/ are allowed.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/application/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', layerImportGuard(['infrastructure', 'presentation'])],
    },
  },
  {
    files: ['src/infrastructure/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', layerImportGuard(['presentation'])],
    },
  },
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        layerImportGuard(['domain', 'application', 'infrastructure', 'presentation']),
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Tooling / tests: relax a few rules that only make sense for product code
  // ---------------------------------------------------------------------------
  {
    files: ['tools/**/*.ts', 'test/**/*.ts', 'eslint-rules/**/*.ts', 'eslint.config.ts', 'vitest.config.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
]);
