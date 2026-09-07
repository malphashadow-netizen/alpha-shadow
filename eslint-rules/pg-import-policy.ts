/**
 * SINGLE SOURCE OF TRUTH for the `pg` import allow-list.
 *
 * Both `eslint.config.js` (no-restricted-imports) and the CI guard
 * (`test/unit/architecture/pg-import-policy.test.ts`) consume this module, so
 * the allow-list can never diverge between lint config and tests.
 *
 * Policy:
 *   - Production files may import `pg` ONLY if listed here.
 *   - `test/**` is exempt (test harness must talk to a real PostgreSQL), but
 *     test support files must not import real production code from `src/`
 *     (see test/unit/architecture/pg-import-policy.test.ts).
 *   - Any new sanctioned file MUST be added here, to `eslint.config.js`'s
 *     allow-list block and to the CI guard test — all three in one change.
 */
export const PG_IMPORT_ALLOWLIST: readonly string[] = Object.freeze([
  'src/infrastructure/db/pool.ts',
  'src/infrastructure/db/tenant-context.ts',
  // The ONE documented exception: the global auth_audit_log table has no
  // authenticated tenant context for unknown-tenant logins, so it cannot use
  // withTenantContext(). It talks to the least-privilege app_audit role via
  // two SECURITY DEFINER functions only — see src/infrastructure/db/auth-audit.ts.
  'src/infrastructure/db/auth-audit.ts',
  'tools/migrate.ts',
]);

/** Files that may import pg without an allow-list entry (test harness only). */
export const PG_IMPORT_TEST_EXEMPT_GLOB = 'test/**/*.ts';

export const PG_IMPORT_RESTRICTION_MESSAGE =
  `Direct import of "pg" is forbidden outside the sanctioned allow-list ` +
  `(${PG_IMPORT_ALLOWLIST.join(', ')}). Use withTenantContext() instead.`;

export const PG_IMPORT_RESTRICTION = Object.freeze({
  paths: Object.freeze([
    {
      name: 'pg',
      message: PG_IMPORT_RESTRICTION_MESSAGE,
    },
  ]),
});
