/**
 * Local ESLint plugin `alpha-shadow`.
 *
 * Hosts project-specific, build-breaking architectural rules. Registered in
 * `eslint.config.ts` under the plugin name `alpha-shadow`.
 */
import type { ESLint } from 'eslint';

import { noRoleNameCompare, RULE_NAME as NO_ROLE_NAME_COMPARE } from './no-role-name-compare.ts';

export const alphaShadowPlugin: ESLint.Plugin = {
  meta: {
    name: 'eslint-plugin-alpha-shadow',
    version: '0.0.0',
  },
  rules: {
    // typescript-eslint's `RuleModule` and ESLint core's `RuleDefinition` are
    // structurally compatible at runtime but their TS declarations diverge
    // (typescript-eslint keeps the deprecated `context.parserOptions` etc. in
    // its type). typescript-eslint publishes its own plugin the same way
    // (`CompatiblePlugin`, see node_modules/typescript-eslint/dist/compatibility-types.d.ts).
    // The cast is confined to this single boundary; the rule itself is fully typed.
    [NO_ROLE_NAME_COMPARE]: noRoleNameCompare as unknown as ESLint.Plugin['rules'] extends
      | Record<string, infer R>
      | undefined
      ? R
      : never,
  },
};

export default alphaShadowPlugin;
