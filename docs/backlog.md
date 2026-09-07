# Backlog / known gaps (Phase 1 hardening)

This document is the single place where deliberate gaps are recorded so they
are visible to reviewers and follow-ups. It is maintained with the code: when a
gap is closed, move its entry to the relevant ADR/spec instead of deleting it
silently.

## Security gaps — tenant isolation layer

### Rate limiting (IMPLEMENTED for authentication — Phase 3)
`RateLimitError` (`rate_limit.exceeded`, → 429) is now enforced on the
authentication path. Two INDEPENDENT sliding-window limiters run per login /
refresh attempt — one on the caller IP, one on the targeted account identifier
— and BOTH counters are derived from the global `auth_audit_log` table
(`WHERE ip_address = … AND created_at > now() - interval …` and the same over
`identifier_attempted`; supporting indexes `(ip_address, created_at)` and
`(identifier_attempted, created_at)` from migration 0005). No Redis/external
store is introduced in this phase by design — the audit table is the
append-only source of attempt truth. Only FAILED attempts are counted, so a
user who logs in successfully never locks themselves out by volume. Limits
(`IP_RATE_LIMIT`, `ACCOUNT_RATE_LIMIT`) are constants on the engine and are
injectable for tests. Per-tenant/endpoint rate limiting for engines OTHER than
authentication is still future work and must reuse the same audit/counter
pattern or an approved distributed store.

### auth_audit_log — the ONE documented exception to withTenantContext() (Phase 3)
Every tenant-scoped DB access goes through `withTenantContext()` **except** the
global authentication audit table `auth_audit_log`, written/read ONLY by
`src/infrastructure/db/auth-audit.ts` (the fourth entry in the `pg` import
allow-list — `eslint-rules/pg-import-policy.ts`). The exception is deliberate
and architecturally forced: a failed login against a NON-EXISTENT tenant (or an
unknown user) carries no authenticated tenant context, while
`withTenantContext()` requires a valid tenant id, sets
`app.current_tenant_id`, and verifies the tenant row exists. Those attempts
must STILL be audited and counted toward rate limiting. Consequences, all
matching the `tenants` / `permissions_registry` global-table precedent:

- `auth_audit_log` has **no `tenant_id` column and no RLS policy**. The claimed
  tenant is the nullable, FK-free `tenant_id_attempted` — the value the caller
  asserted, not an authenticated tenant boundary. Naming it
  `tenant_id_attempted` (rather than `tenant_id`) keeps the generic, table-list
  independent RLS-coverage guard (`test/contract/rls-coverage.test.ts`,
  `tools/lib/migration-security.ts`) uniformly allow-list free: it keys on the
  exact column name `tenant_id`, and the global table is therefore out of scope
  by construction rather than by a maintained exception list.
- Containment is by a DEDICATED, least-privilege login role, `app_audit`
  (`migrations/roles/003_app_audit.sql`, NOBYPASSRLS, dormant NOLOGIN until the
  DBA activates it). It is granted EXECUTE on only two SECURITY DEFINER
  functions — `record_auth_attempt(...)` and
  `count_recent_auth_failures(...)` (migration 0005, `search_path` pinned) —
  and has NO direct SELECT/INSERT on the audit table and no privilege on any
  tenant-scoped table (proven live by
  `test/contract/auth-audit-role.test.ts`). The application reaches it via a
  separate `AUDIT_DATABASE_URL` connection, fail-closed at boot.
- All other auth tables (`auth_refresh_tokens`, and the `users` columns used by
  login) remain fully tenant-scoped and RLS-bound through
  `withTenantContext()`.

### Kill switch (NOT implemented)

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

### Phase 4b: seeded `currencies` reference registry (migration 0007)
`currencies` is global reference data (no `tenant_id`, no RLS). Migration
`0007_seed_currencies.sql` seeds `SAR/EGP/KWD/USD/AED/EUR` with
`ON CONFLICT (code) DO NOTHING` — never `DO UPDATE`: a stored
`minor_unit_digits` may already have determined the rounding scale of
historical `exchange_rates` and past reports, so a correction must be a new,
explicit migration that states the old value, the new value and the reporting
impact. The seeded digits are contracted to equal `ISO_4217_MINOR_UNITS` in
`src/shared/money.ts` (KWD = 3, fils) and this is enforced twice: statically by
`test/unit/tools/currency-seed-migration.test.ts` and live by
`test/integration/phase4b-currency-seed.test.ts`. Adding a currency = a new
seed migration + the matching entry in `ISO_4217_MINOR_UNITS`.

## Catalog (Phase 5)

### tax_rule_id hook activated in Phase 6 (completed)
Migration 0016 activates the existing nullable `menu_items.tax_rule_id` as a
foreign key to `tax_categories(id)` without editing migration 0008 or renaming
the column. Ordinary catalog assignments now validate categories and reject
excise; the separate tenant tax administration records explicit confirmation.
See [Phase 6 deployment and invariants](phase6-tax-engine.md), including the
legacy UUID preflight and the mandatory branch-country backfill.

### sku is a future inventory hook
`menu_items.sku` is unique per tenant (`idx_menu_items_tenant_sku`, NULL
allowed). Inventory (a later phase) will join on `(tenant_id, sku)` — the
catalog engine does not track stock.

### Catalog permissions are not sensitive
`catalog:read`, `catalog:write`, `catalog:archive` are registered in
`permissions_registry` with `is_sensitive = false`. Editing a menu is not live
money movement; L1 cache applies. New money-moving permissions must still be
`is_sensitive = true` from the moment they are created.

### setBranchOverride is a partial merge (not a full overwrite)
`CatalogEngine.setBranchOverride` reads the current override and merges:
omitted fields (`undefined`) keep the stored value; explicit `null` on
`priceOverride` / `availabilitySchedule` clears that field. The repository
upserts the assembled snapshot. SQL `COALESCE(EXCLUDED.col, col)` is **not**
used — COALESCE cannot distinguish omit from explicit NULL on nullable
columns.

### selection_type='single' vs max_selections (migration 0009)
0008 did not bind `selection_type = 'single'` to `max_selections`. 0009 adds
`modifier_groups_single_max` (`max_selections` must be `1` or `NULL` when
the type is `single`). The engine rejects the same combination before
persistence. 0008 is not modified.

### KNOWN FLAKE (pre-existing, not Phase 4b): password truncated-record test
`test/unit/shared/auth/password.test.ts` → "never throws on a
malformed/truncated record" fails intermittently (measured ~1 in 20 runs on
`main` at 762a6c4, before any Phase-4b change). Root cause: the test truncates
the base64url record by 4 characters; with probability ~1/4 the remaining 82
characters still round-trip cleanly (the trailing unused bits happen to be
zero), so `parsePasswordHash` accepts a 61-byte hash — and because scrypt's
final step is PBKDF2 with one iteration, a 61-byte derivation IS the prefix of
the 64-byte one, so the compare legitimately succeeds and `verifyPassword`
returns `true`. The production code is not wrong; the *test fixture* is: it
should truncate the decoded bytes (or assert `parsePasswordHash(...) === null`)
instead of assuming a 4-character cut is always malformed. Fix belongs to the
auth phase owner — deliberately not touched by the Phase 4b branch.

## Tax / order / invoice integration (Phase 6)

The tax resolver, platform and tenant administration, snapshots and all 14
acceptance scenarios are implemented. General order lifecycle/persistence and
ZATCA remain future phases. The order implementation must use the supplied
transactional writer port, pass full customer prices (not settlement proceeds),
and honor `restaurantTaxInvoiceAllowed: false`. Future ZATCA reads immutable
snapshots/context, without recomputing amounts. Negative credit-note/refund
lifecycle is not introduced by Phase 6.

The platform-admin composition is another deliberate non-tenant transaction
boundary, **without expanding the raw-pg import allow-list**. Its dedicated DB
role cannot bypass RLS and has no direct tax-rate write grants. Tenant tax
requests continue to use `withTenantContext`. No production marketplace law or
branch-country mapping is guessed; both require explicit reviewed data.
