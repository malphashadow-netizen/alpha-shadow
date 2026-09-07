-- migrations/roles/002_app_login_rbac.sql — MANUAL, ONE-TIME DBA script.
--
-- ⚠️ THIS FILE IS NOT PART OF THE NORMAL MIGRATION CYCLE. ⚠️
-- See migrations/README.md → "migrations/roles/ — manual one-time DBA scripts"
-- and migrations/roles/001_app_login.sql (the Phase-1 template this extends).
--
-- Phase 2 grants for the RBAC/ABAC tables introduced by migration 0004.
-- Grants are per-table and are NOT carried by the schema migration itself,
-- so every new tenant-scoped table must be granted to app_login here.
--
-- Run once per environment, like 001:
--   psql "$MIGRATION_DATABASE_URL" -f migrations/roles/002_app_login_rbac.sql
--
-- All three tenant-scoped tables are bounded by RLS (FORCE + tenant_isolation)
-- and the role is NOBYPASSRLS, so SELECT/INSERT/UPDATE/DELETE are safe.

-- permissions_registry is the GLOBAL permissions registry (migration 0004) —
-- NOT a tenant-scoped table, so the RLS contract does not apply to it. Same
-- least-privilege decision as `tenants`: the application role receives SELECT
-- only. Registry INSERT/UPDATE/DELETE is a schema-owner / super-admin
-- operation, never per-tenant application traffic.
GRANT SELECT ON permissions_registry TO app_login;

-- roles / role_permissions / user_roles are the real tenant-scoped row tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON roles TO app_login;
GRANT SELECT, INSERT, UPDATE, DELETE ON role_permissions TO app_login;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_roles TO app_login;
