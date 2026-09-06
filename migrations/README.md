# Migrations — mandatory template & guardrails

Every `.sql` file in this directory is applied in filename order by
`tools/migrate.ts` (uses `MIGRATION_DATABASE_URL` exclusively) and by the test
harness global setup. `README.md` and `tools/` files are never applied.

## Data seeding: production migrations are schema-only

**Never put `INSERT`/seed rows in `migrations/*.sql`.** Test/probe data (e.g.
`probe-tenant-*`) lives in `test/support/seed.test.sql` and is applied ONLY by
the Vitest harness (`test/support/postgres.global-setup.ts`) on the throw-away
test database. Enforced by tests:

- `test/unit/tools/migration-security.test.ts` scans every `*.sql` in
  `migrations/` and fails if any of them seeds `tenants`.
- `tools/lib/migrate-env.ts` makes `tools/migrate.ts` refuse to run whenever
  `SEED_TEST_DATA=true`, in every environment including `NODE_ENV=production`.
  A production `npm run migrate` therefore applies schema changes only and can
  never plant probe rows.

## Mandatory template for tenant-scoped tables (RLS)

Any migration that creates a table with a `tenant_id` column **must** include —
in the same file — the complete block below. `tools/check-migrations.ts` and
`tools/migrate.ts` both fail closed when it is missing:

```sql
CREATE TABLE IF NOT EXISTS some_table (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  ...
);

-- REQUIRED: tenant_id is the RLS/query hot path — always index it.
CREATE INDEX IF NOT EXISTS idx_some_table_tenant_id ON some_table (tenant_id);

ALTER TABLE some_table ENABLE ROW LEVEL SECURITY;
ALTER TABLE some_table FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON some_table
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
```

Global (non-tenant) registries — e.g. `tenants`, `permissions_registry` — do
NOT carry a `tenant_id` column and are therefore out of scope for the RLS
coverage contract. They still need explicit least-privilege grants reviewed in
the PR.

## DROP … CASCADE prohibition (tracking system)

`DROP … CASCADE` performs a recursive delete and is **forbidden** in tracked
migrations unless the file is listed in `migrations/.cascade-approvals.json`
with a reason:

```json
{
  "approvals": {
    "0007_archive_customers.sql": "Confirmed by product/DB owner (2026-09-06): migration is a one-time cleanup of legacy archive schema, dry-run applied on staging."
  }
}
```

The approvals file is tracked in git; `tools/check-migrations.ts` (CI) and
`tools/migrate.ts` (before applying) both reject any unapproved `DROP … CASCADE`.

## Testing a migration

- `npm run check:migrations` — static guard (no database needed).
- `npm test` — integration + contract suites apply all migrations to a real
  PostgreSQL (embedded or `TEST_DATABASE_URL`) and verify the RLS contract on
  every `tenant_id` table.

## migrations/roles/ — manual one-time DBA scripts (NOT part of the migration cycle)

Every `*.sql` file **directly inside** `migrations/` is applied in filename
order by `tools/migrate.ts` (via `MIGRATION_DATABASE_URL`) and by the Vitest
test harness. Files under `migrations/roles/` are deliberately **different**:

- They are **never applied** by `tools/migrate.ts` or the test harness (both
  read only top-level `migrations/*.sql`) and are **not** scanned by
  `tools/check-migrations.ts`.
- They create **cluster-global objects** (`CREATE ROLE`), which is a DBA
  action: a role is shared by every database in the cluster, survives
  per-database schema re-creates, and requires a superuser / `CREATEROLE`
  connection. The regular migrations run with the least-privilege
  `MIGRATION_DATABASE_URL` owner credentials, which must never be able to
  create login roles.
- They are bound to **secrets** (the role password exists only in the
  environment's secret manager). The committed file carries the full attribute
  set + grants but ships **NOLOGIN**; the DBA activates login with an
  `ALTER ROLE app_login WITH LOGIN PASSWORD '<secret>'` step. Never commit a
  real password.
- They are run **once per environment, manually, before the app's first
  deployment**:

  ```bash
  psql "$MIGRATION_DATABASE_URL" -f migrations/roles/001_app_login.sql
  psql "$MIGRATION_DATABASE_URL" -c "ALTER ROLE app_login WITH LOGIN PASSWORD '<secret-from-secret-manager>'"
  ```

| File                         | Object      | Grants                                                                                     |
| ---------------------------- | ----------- | ------------------------------------------------------------------------------------------ |
| `roles/001_app_login.sql`    | role `app_login` (`NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`) | `USAGE` on `public`; `SELECT` on `tenants`; `SELECT, INSERT, UPDATE, DELETE` on `branches`, `users` |

### Grant decision: does `app_login` need INSERT/UPDATE/DELETE on `tenants`? (2026-09-07)

**No.** `tenants` is the *global registry* (migration 0002) — it has no
`tenant_id` column, so the RLS contract intentionally does not apply to it, and
migration 0002's security note states the app role receives **only SELECT**
(never INSERT/UPDATE/DELETE): tenant creation is a cross-cutting
admin/super-admin operation. `app_login` therefore gets:

- `SELECT` on `tenants` — the read needed by
  `withTenantContext(…, { verifyTenantExists: true })`'s existence probe;
- `SELECT/INSERT/UPDATE/DELETE` on the tenant-scoped row tables `branches` and
  `users` — writes that RLS (`FORCE` + the `tenant_isolation` policy) bounds to
  `current_setting('app.current_tenant_id')`; the role's `NOBYPASSRLS`
  guarantees the app cannot bypass that bound.

If a later phase adds a first-class *self-service tenant creation* flow, the
grant must be revisited (and the RLS/ownership model re-reviewed) — until then,
least privilege stands. Tracked in `docs/backlog.md`.

