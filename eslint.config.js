/**
 * ESLint flat config (ESLint 10, typescript-eslint 8) — JavaScript version.
 *
 * Uses plain `eslint.config.js` (not .ts) to avoid jiti <2.2.0 issue.
 */

import eslintJs from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

import { alphaShadowPlugin } from './eslint-rules/index.ts';

const layerImportGuard = (forbiddenLayers) => ({
  patterns: forbiddenLayers.map((layer) => ({
    regex: `(^|/)${layer}(/|$)`,
    message: `This layer must not import from "${layer}" (hexagonal dependency rule: dependencies point inward only).`,
  })),
});

const pgRestriction = {
  paths: [
    {
      name: 'pg',
      message:
        'Direct import of "pg" is forbidden outside src/infrastructure/db/pool.ts, src/infrastructure/db/tenant-context.ts, and tools/migrate.ts. Use withTenantContext() instead.',
    },
  ],
};

export default defineConfig([
  globalIgnores(['dist/**', 'node_modules/**', 'coverage/**', '.embedded-postgres/**']),

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

  {
    files: ['**/*.ts'],
    plugins: {
      'alpha-shadow': alphaShadowPlugin,
    },
    rules: {
      'alpha-shadow/no-role-name-compare': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['error', 'warn'] }],
      'no-restricted-syntax': [
        'error',
        {
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

  // Disable type-checked linting for JS config itself
  {
    files: ['eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },

  // Hexagonal layering + pg restriction combined (to avoid overriding)
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: pgRestriction.paths,
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
      'no-restricted-imports': [
        'error',
        {
          paths: pgRestriction.paths,
          patterns: layerImportGuard(['infrastructure', 'presentation']).patterns,
        },
      ],
    },
  },
  {
    files: ['src/infrastructure/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: pgRestriction.paths,
          patterns: layerImportGuard(['presentation']).patterns,
        },
      ],
    },
  },
  {
    files: ['src/presentation/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: pgRestriction.paths,
          patterns: [],
        },
      ],
    },
  },
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: pgRestriction.paths,
          patterns: layerImportGuard(['domain', 'application', 'infrastructure', 'presentation']).patterns,
        },
      ],
    },
  },
  // Allow pg in the three sanctioned files
  {
    files: ['src/infrastructure/db/pool.ts', 'src/infrastructure/db/tenant-context.ts', 'tools/migrate.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  // Test files are completely exempt from pg restriction and some strict rules
  {
    files: ['test/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/unbound-method': 'off',
      'preserve-caught-error': 'off',
    },
  },

  {
    files: ['tools/**/*.ts', 'test/**/*.ts', 'eslint-rules/**/*.ts', 'eslint.config.js', 'vitest.config.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
]);
