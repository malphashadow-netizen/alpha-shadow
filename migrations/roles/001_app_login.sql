-- migrations/roles/001_app_login.sql — MANUAL, ONE-TIME DBA script.
--
-- ⚠️ THIS FILE IS NOT PART OF THE NORMAL MIGRATION CYCLE. ⚠️
-- See migrations/README.md → "migrations/roles/ — manual one-time DBA scripts".
--
-- Why not a regular `migrations/*.sql` file (never run by tools/migrate.ts
-- nor by the Vitest test harness — both read only top-level `migrations/*.sql`)?
--   1. `CREATE ROLE` is CLUSTER-GLOBAL: a role is shared by every database in
--      the cluster and survives per-database schema re-creates. Migrations run
--      per database under the least-privilege `MIGRATION_DATABASE_URL` owner
--      credentials, which must never be allowed to create login roles.
--   2. The role needs a real password that exists ONLY in the environment's
--      secret manager. This file ships with the activation step as a template
--      (see bottom); a real password is never committed.
--
-- Run once per environment with a superuser / CREATEROLE connection, BEFORE the
-- application's first deployment:
--
--   psql "$MIGRATION_DATABASE_URL" -f migrations/roles/001_app_login.sql
--   # then activate login with the value from the secret manager:
--   psql "$MIGRATION_DATABASE_URL" -c "ALTER ROLE app_login WITH LOGIN PASSWORD '<secret-from-secret-manager>'"
--
-- Password rotation later is just another ALTER ROLE … PASSWORD — no migration
-- and no application change is required.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_login') THEN
    -- NOLOGIN on purpose: the role is created dormant and only becomes a login
    -- role when the DBA activates the secret-manager password (template at the
    -- bottom of this file). Creating it here with a placeholder password would
    -- plant a weak, publicly-known credential in the cluster.
    --
    -- Attribute set is the fail-closed minimum for an application role:
    --   NOSUPERUSER   – never a superuser
    --   NOBYPASSRLS   – RLS (FORCE + tenant_isolation) ALWAYS applies to this
    --                   role; it cannot read or write another tenant's rows
    --   NOCREATEDB    – cannot create databases
    --   NOCREATEROLE  – cannot create/alter other roles (incl. itself's peers)
    CREATE ROLE app_login NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- Every application table lives in schema public; without USAGE on the schema
-- the table grants below are unusable (PostgreSQL checks schema access first).
GRANT USAGE ON SCHEMA public TO app_login;

-- tenants is the GLOBAL tenant registry (migration 0002) — NOT a tenant-scoped
-- table, so the RLS contract does not apply to it. Per migration 0002's
-- security note the application role receives SELECT ONLY on tenants:
-- tenant INSERT/UPDATE/DELETE is a cross-cutting super-admin / schema-owner
-- operation, never per-tenant application traffic. The only SELECT consumer
-- today is withTenantContext(…, { verifyTenantExists: true })'s existence
-- probe. (Decision recorded in migrations/README.md + docs/backlog.md.)
GRANT SELECT ON tenants TO app_login;

-- branches and users are the real tenant-scoped row tables (migration 0003).
-- The application creates/updates/deletes their rows ONLY through
-- withTenantContext(); RLS FORCE + the tenant_isolation policy bounds every
-- statement to current_setting('app.current_tenant_id'), and NOBYPASSRLS
-- guarantees the role itself cannot bypass that bound.
GRANT SELECT, INSERT, UPDATE, DELETE ON branches TO app_login;
GRANT SELECT, INSERT, UPDATE, DELETE ON users TO app_login;

-- ─────────────────────────────────────────────────────────────────────────────
-- ACTIVATE LOGIN (run manually by the DBA; value comes from the secret
-- manager, never from this file):
--
--   ALTER ROLE app_login WITH LOGIN PASSWORD '<secret-from-secret-manager>';
--
-- Future rotation:
--   ALTER ROLE app_login WITH LOGIN PASSWORD '<new-secret>';
-- ─────────────────────────────────────────────────────────────────────────────
