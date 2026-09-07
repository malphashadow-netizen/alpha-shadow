/**
 * System role constants.
 *
 * `TENANT_SUPER_ADMIN` is seeded automatically for every tenant the moment the
 * tenant is created (in the same path, `is_system = true`), never by a static
 * migration — see docs/backlog.md.
 *
 * NOTE: authorization must NEVER branch on a role NAME (enforced by the
 * `alpha-shadow/no-role-name-compare` guards). The super-admin invariant is
 * matched by `roles.is_system = true`; this constant exists only to set the
 * seeded role's display name.
 */
export const TENANT_SUPER_ADMIN_ROLE_NAME = 'TENANT_SUPER_ADMIN' as const;
