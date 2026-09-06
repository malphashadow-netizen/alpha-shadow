-- Migration 0002 — tenant registry (global, NOT tenant-scoped).
--
-- The `tenants` table is the single row source for tenant existence. It has no
-- `tenant_id` column, so the RLS coverage contract deliberately does NOT apply
-- to it (it is the root registry, analogous to a permissions registry).
--
-- withTenantContext(…, { verifyTenantExists: true }) — the production default —
-- verifies that a row exists here BEFORE running the tenant's operation:
--   SELECT EXISTS (SELECT 1 FROM tenants WHERE id = $1)
--
-- IMPORTANT (production safety): this migration contains NO data rows.
-- Test/probe tenants live in `test/support/seed.test.sql` and are applied ONLY
-- by the Vitest test harness (test/support/postgres.global-setup.ts). They are
-- never referenced by tools/migrate.ts — see tools/lib/migrate-env.ts, which
-- refuses to run when SEED_TEST_DATA is set.
--
-- Security note: grants must be least-privilege. The app role receives only
-- SELECT (never INSERT/UPDATE/DELETE); tenant creation is a cross-cutting
-- admin/super-admin operation.

CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The primary key already indexes `id`; keep the lookup index names explicit
-- for future tenant_id-carrying tables: every tenant-scoped table MUST have
-- CREATE INDEX … ON … (tenant_id) — see migrations/README.md template.
