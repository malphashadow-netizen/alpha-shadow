-- migrations/roles/003_app_audit.sql — MANUAL, ONE-TIME DBA script.
--
-- ⚠️ THIS FILE IS NOT PART OF THE NORMAL MIGRATION CYCLE. ⚠️
-- See migrations/README.md → "migrations/roles/ — manual one-time DBA scripts"
-- and migrations/roles/001_app_login.sql (the template this extends).
--
-- Phase 3 introduces the GLOBAL authentication audit table `auth_audit_log`
-- (migration 0005). Auth attempts against an UNKNOWN tenant/user have NO
-- authenticated tenant context, so they cannot go through
-- withTenantContext() — that helper requires a valid tenant and sets
-- app.current_tenant_id inside a transaction. The audit write path is the
-- ONE deliberately sanctioned exception to "all DB access goes through
-- withTenantContext()", documented in docs/backlog.md and in the header
-- comment of src/infrastructure/db/auth-audit.ts.
--
-- To keep that exception least-privilege, a dedicated login role exists:
--
--   app_audit — NOBYPASSRLS, NOCREATEDB, NOCREATEROLE, created dormant
--               (NOLOGIN) exactly like app_login. It is granted EXECUTE on
--               only the two SECURITY DEFINER functions
--                   * record_auth_attempt(...)
--                   * count_recent_auth_failures(...)
--               and NOTHING else: no direct SELECT/INSERT on
--               auth_audit_log, no access to any tenant-scoped table.
--
-- The connection string for this role is provided to the application via the
-- AUDIT_DATABASE_URL secret (fail-closed at boot like every other secret).
--
-- Run once per environment with a superuser / CREATEROLE connection:
--
--   psql "$MIGRATION_DATABASE_URL" -f migrations/roles/003_app_audit.sql
--   # then activate login with the value from the secret manager:
--   psql "$MIGRATION_DATABASE_URL" -c "ALTER ROLE app_audit WITH LOGIN PASSWORD '<secret-from-secret-manager>'"

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_audit') THEN
    -- NOLOGIN on purpose: the role is created dormant and only becomes a
    -- login role when the DBA activates the secret-manager password.
    CREATE ROLE app_audit NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- Schema access is checked first by PostgreSQL; USAGE only (no CREATE).
GRANT USAGE ON SCHEMA public TO app_audit;

-- The ONLY data surface: the two SECURITY DEFINER functions from migration
-- 0005. The functions run with the definer's (migration owner) rights, so the
-- role needs NO direct privilege on auth_audit_log itself.
GRANT EXECUTE ON FUNCTION record_auth_attempt(uuid, text, text, text, boolean, text, text) TO app_audit;
GRANT EXECUTE ON FUNCTION count_recent_auth_failures(text, text, text, integer) TO app_audit;

-- Defence in depth: make explicit that the audit role never touches tenant
-- tables (the role was created fresh, so these are no-ops on first run).
REVOKE ALL ON tenants, permissions_registry, branches, users, roles, role_permissions, user_roles, auth_refresh_tokens FROM app_audit;

-- Phase-3 tenant-scoped table used by the NORMAL application role:
-- auth_refresh_tokens (refresh-token ledger). It is bounded by RLS
-- (ENABLE + FORCE + tenant_isolation, migration 0005) and app_login is
-- NOBYPASSRLS, so SELECT/INSERT/UPDATE are safe. DELETE is intentionally NOT
-- granted: tokens are revoked by setting revoked_at, never by deleting rows
-- (the audit-grade rotation history must persist).
GRANT SELECT, INSERT, UPDATE ON auth_refresh_tokens TO app_login;

-- ─────────────────────────────────────────────────────────────────────────────
-- ACTIVATE LOGIN (run manually by the DBA; value comes from the secret
-- manager, never from this file):
--
--   ALTER ROLE app_audit WITH LOGIN PASSWORD '<secret-from-secret-manager>';
--
-- Future rotation:
--   ALTER ROLE app_audit WITH LOGIN PASSWORD '<new-secret>';
-- ─────────────────────────────────────────────────────────────────────────────
