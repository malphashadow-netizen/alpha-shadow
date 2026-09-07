# Backlog / known gaps (Phase 1 hardening)

This document is the single place where deliberate gaps are recorded so they
are visible to reviewers and follow-ups. It is maintained with the code: when a
gap is closed, move its entry to the relevant ADR/spec instead of deleting it
silently.

## Security gaps — tenant isolation layer

### Rate limiting (NOT implemented)
`RateLimitError` exists in `src/shared/errors.ts` (stable code
`rate_limit.exceeded`) but **no enforcement middleware exists yet**. There is
no per-tenant, per-IP or per-account request budget; the error type is a
contract for future engines to throw. A release that exposes authentication or
any tenant-facing endpoint MUST not be marked "tenant isolation complete"
until a rate-limiter (token bucket + distributed store) lands.

### Kill switch (NOT implemented)
There is **no global kill switch** (e.g. disable a tenant / disable tenant
access wholesale via a `tenants.status` revocation that immediately surfaces to
every connection). The `tenants.status` column introduced in migration 0002 is
only a data placeholder — `withTenantContext` does not read it today. A future
change must resolve tenant status ONCE per operation inside the same
transaction as the tenant-id check (never in a separate request).

### Circuit breaker / backoff (LOW priority)
`withTenantContext` currently surfaces every failure to the caller. A circuit
breaker (open on N consecutive tenant-isolation/DISCARD failures, exponential
backoff, half-open probe) is planned but deliberately deferred: the current
pool already bounds concurrency, and statement_timeout bounds in-flight time.
Tracked here; revisit when repositories exist.

## Money backlog

### FX conversion (NOT implemented)
`src/shared/money.ts` has **no currency conversion function**. Cross-currency
math is a deliberate bug: every operation enforces same-currency and throws
`CurrencyMismatchError`. Implementing FX requires: mid-market rate table with
`as_of` timestamps, spread policy, rounding at the converted minor unit (using
`minorUnitScale`), and audit. All cross-currency requirements must go through a
future `converted(amount, from, to, rate)` in money.ts — never inline.

### allocate() rounding model (implemented — documented)
`allocate()` uses an exact, deterministic Fowler-style distribution (each
bucket gets `trunc(total / parts)` and the leading `|remainder|` buckets get
±1). It deliberately does **not** perform per-bucket banker's rounding; the
remainder is distributed as whole minor units so the total is always exact.

## Roles & grants (Phase 1)

### app_login grants decision (2026-09-07) — tenants is SELECT-only
`migrations/roles/001_app_login.sql` is a manual, one-time DBA script (never
run by `tools/migrate.ts`: role creation is cluster-global and the password
belongs to the environment's secret manager — see `migrations/README.md`).

Decision recorded per migration 0002's security note: `app_login` receives
**SELECT only** on `tenants` (registry reads for
`withTenantContext`'s `verifyTenantExists` probe) and
`SELECT/INSERT/UPDATE/DELETE` on the tenant-scoped row tables `branches` and
`users`, bounded by RLS (`FORCE` + `tenant_isolation`) — the role is created
`NOBYPASSRLS`. **Tenant INSERT/UPDATE/DELETE is deliberately NOT granted**:
tenant lifecycle is a cross-cutting super-admin / schema-owner operation.
Revisit only if a first-class self-service tenant-creation flow lands in a
later phase; any revisit must also re-review the ownership model.

### app_batch role (NOT implemented)
README.md's "non-negotiable constraints" already anticipates a separate
`app_batch` role for cross-tenant batch jobs. It does not exist yet: no batch
job exists in Phase 1, and a cross-tenant role must NOT bypass RLS through the
normal `withTenantContext()` path. When batch jobs arrive, design the
role + its approved cross-tenant queries here first.

### Future tables need grants + roles/ entries
Every new tenant-scoped table added in later phases must be granted to
`app_login` in `migrations/roles/001_app_login.sql` (or a new `roles/00N_*.sql`)
for each environment — grants are per-table and are NOT carried by the schema
migration itself.

## Tooling debt

### ESLint config: migrate to `.ts`
`eslint.config.js` is intentionally JavaScript while the pinned ESLint 10 /
jiti < 2.2.0 chain has a known loader issue with `.ts` configs. Returning to a
type-checked `eslint.config.ts` is tracked tech debt; all policy already lives
in `eslint-rules/*.ts`, so the migration is mechanical. Re-evaluate on every
toolchain bump (ADR-0001).

### pool.ts `asText` identity parser
The int8/numeric type parsers use an inline identity arrow (`(value: string) => value`)
with a comment. The previous named `asText` helper was removed — the point is
the identity parser itself, which the comment explains.

### Pool singleton entry points
`getPool()`, `ensureSharedPool()` and `acquireDbClient()` all resolve through
ONE memoised lazy promise (`sharedPoolPromise ??= Promise.resolve().then(createSharedPool)`).
There is no synchronous variant and no swallowed rejection: a configuration
failure rejects the same promise for every consumer (verified by
`test/unit/infrastructure/pool.test.ts`). If a synchronous acquisition is ever
needed again, it must not introduce a second error path.

### 500-class error redaction
`toErrorResponse()` returns the constant `"Internal server error"` for every
500-class code (`config.invalid`, unknown domain codes, non-domain errors) and
delivers the detailed error only to the injectable `ErrorLogSink` (default
`console.error`). This keeps connection-string/credential fragments inside
`ConfigurationError` messages server-side. Composition roots may replace the
default sink with a structured logger.

### exactOptionalPropertyTypes
`tsconfig.base.json` sets `"exactOptionalPropertyTypes": true` (verified with
`npm run typecheck`). All option bags in `pool.ts` / `tenant-context.ts` use
conditional spread (`{ ...base, ssl: options.ssl }` when defined) to stay
compatible with it. Any new option bag must follow the same pattern.

## Pool capacity

`src/infrastructure/db/pool.ts` sizes the shared pool with:

```
max = max(1, floor((DATABASE_MAX_CONNECTIONS - 5) / APP_INSTANCES))
```

- `DATABASE_MAX_CONNECTIONS` defaults to 100 (PostgreSQL default), override in
  production to the server's real `max_connections`.
- `APP_INSTANCES` defaults to 1; set it to the number of app replicas.
- The 5-connection headroom reserves room for administrative/replica
  connections and the migration client.
- Formula and guards are unit-tested; production boot also refuses URLs that
  are the known default superuser DSN or lack `sslmode=require`-family.

## RBAC/ABAC (Phase 2) — decisions & notes

### TENANT_SUPER_ADMIN is seeded in the tenant-creation path (NOT a migration)
The system role `TENANT_SUPER_ADMIN` (`roles.is_system = true`, `role_version = 1`)
is created **automatically for every tenant the moment the tenant is created**,
inside the SAME transaction as the `tenants` INSERT — implemented by
`IPermissionWriteRepository.createTenantWithSystemRole` (both the InMemory and
Postgres adapters). It is deliberately NOT a static SQL migration: a migration
cannot know future tenant ids, and the super-admin role must always exist
atomically with its tenant. The role is identified by `roles.is_system = true`
(never by a hard-coded name — the name is only the display value set at seed
time). The corresponding migration (`migrations/0004_phase2_rbac_tables.sql`)
carries NO data rows.

### Tenant provisioning runs under admin credentials
`tenants` remains SELECT-only for `app_login` (Phase-1 decision unchanged).
`createTenantWithSystemRole` is therefore a cross-cutting super-admin / schema
owner operation: the caller must inject a `withTenantContext` whose connection
can INSERT into `tenants` (e.g. an admin composition root), and the method
disables the tenant-existence probe (`verifyTenantExists: false`) for that one
transaction only. Any self-service tenant-creation flow must route through this
single path — never an ad-hoc `INSERT INTO tenants` + `INSERT INTO roles`.

### New-table grants (migrations/roles/002_app_login_rbac.sql)
Phase-2 grants, applied like `001` (manual one-time DBA script, never run by
`tools/migrate.ts`):
- `permissions_registry` → `app_login` gets SELECT only (global registry, same
  logic as `tenants`); registry writes are schema-owner operations.
- `roles`, `role_permissions`, `user_roles` → SELECT/INSERT/UPDATE/DELETE,
  bounded by RLS (ENABLE + FORCE + tenant_isolation) and `NOBYPASSRLS`.

### L1 permission cache — sensitive permissions bypass in BOTH directions
The authorization engine memoises the Permission-Check stage in an LRU cache
(1-minute TTL). `permissions_registry.is_sensitive = true` checks are NEVER
cached — neither a grant nor a denial — and are re-read from the store on every
request. New permissions that touch sensitive money flows must be registered
with `is_sensitive = true` from the moment they are created.

### `sec_v` token derivation (Phase 2)
`sec_v` = SHA-256 hex digest over a fixed-format sorted JSON array of the
quadruples `(roleId, roleVersion, scopeType, scopeId)` for every ACTIVE
`user_roles` row plus `users.security_version`. The scope is part of the
quadruple on purpose: an UPDATE that only changes the scope (without touching
roleId/roleVersion) still changes the hash and therefore invalidates any token
that carried the old scope. Sorted by `roleId`, then `scopeId`, for determinism.

### Super-admin protection scope
`IPermissionWriteRepository.removeUserRoleAssignment` and
`deactivateUserRoleAssignment` take `SELECT … FOR UPDATE` on the tenant's active
`TENANT_SUPER_ADMIN` assignments inside the SAME transaction as the mutation and
refuse when the target is the last active one. `disableUser`
(`UPDATE users.is_active = false`) repeats the SAME lock + check — a user
disable that would remove the last active super-admin is refused, no exceptions.
