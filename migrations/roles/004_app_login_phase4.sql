-- migrations/roles/004_app_login_phase4.sql — MANUAL, ONE-TIME DBA script.
--
-- Phase 4 least-privilege grants. Run after migrations/0006 has been applied
-- and after roles/001_app_login.sql has created app_login:
--
--   psql "$MIGRATION_DATABASE_URL" -f migrations/roles/004_app_login_phase4.sql
--
-- `currencies` is a global read-only reference registry. `exchange_rates` and
-- `audit_log` are tenant-scoped; their ENABLE + FORCE RLS policies still apply
-- to app_login because the role is NOBYPASSRLS.

GRANT SELECT ON currencies TO app_login;
GRANT SELECT, INSERT ON exchange_rates TO app_login;
GRANT SELECT, INSERT ON audit_log TO app_login;

-- State the immutable/append-only privilege boundary explicitly. These REVOKEs
-- are intentional even though the grants above do not include UPDATE/DELETE:
-- they also remove a privilege inherited from an older/manual deployment.
REVOKE UPDATE, DELETE ON exchange_rates FROM app_login;
REVOKE UPDATE, DELETE ON audit_log FROM app_login;
