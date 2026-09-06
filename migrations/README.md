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
