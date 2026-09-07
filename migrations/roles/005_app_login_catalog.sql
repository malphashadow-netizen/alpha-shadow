-- migrations/roles/005_app_login_catalog.sql — MANUAL, ONE-TIME DBA script.
--
-- ⚠️ THIS FILE IS NOT PART OF THE NORMAL MIGRATION CYCLE. ⚠️
-- See migrations/README.md → "migrations/roles/ — manual one-time DBA scripts"
-- and migrations/roles/001_app_login.sql (the Phase-1 template this extends).
--
-- Phase 5 grants for the six catalog tables introduced by migration 0008.
-- Grants are per-table and are NOT carried by the schema migration itself.
--
-- Run once per environment, like 001/002/004:
--   psql "$MIGRATION_DATABASE_URL" -f migrations/roles/005_app_login_catalog.sql
--
-- All six tenant-scoped tables are bounded by RLS (FORCE + tenant_isolation)
-- and the role is NOBYPASSRLS, so SELECT/INSERT/UPDATE/DELETE are safe.
-- Physical DELETE of a referenced catalog row is still refused by
-- ON DELETE RESTRICT; the engine archives with is_active = false.

GRANT SELECT, INSERT, UPDATE, DELETE ON menu_categories TO app_login;
GRANT SELECT, INSERT, UPDATE, DELETE ON menu_items TO app_login;
GRANT SELECT, INSERT, UPDATE, DELETE ON branch_menu_item_overrides TO app_login;
GRANT SELECT, INSERT, UPDATE, DELETE ON modifier_groups TO app_login;
GRANT SELECT, INSERT, UPDATE, DELETE ON modifiers TO app_login;
GRANT SELECT, INSERT, UPDATE, DELETE ON menu_item_modifier_groups TO app_login;
