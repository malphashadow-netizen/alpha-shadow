-- migrations/roles/011_backlog_i1_adjustment_reasons.sql — MANUAL, ONE-TIME DBA script.
--
-- ⚠️ THIS FILE IS NOT PART OF THE NORMAL MIGRATION CYCLE. ⚠️
-- Same provisioning contract as migrations/roles/007_phase7_orders.sql: run once
-- per environment with DBA authority AFTER migration 0049, never through
-- tools/migrate.ts (which only reads top-level migrations/*.sql).
--
-- Least-privilege grants for the I1 coded-adjustment-reason surface (exact
-- mirror of the void-reason grants in 007):
--   * Platform reference data (adjustment_reason_kinds): SELECT ONLY for
--     app_login — a tenant connection can never mutate it (grants +
--     guard_platform_order_write trigger).
--   * Tenant configuration tables: SELECT + INSERT + UPDATE through
--     withTenantContext(); DELETE on tenant_adjustment_reasons (an UNUSED
--     reason may be removed — reasons used in history are RESTRICT-blocked
--     by the stock_movements FK, never silently detached).

REVOKE ALL ON adjustment_reason_kinds FROM app_login;
GRANT SELECT ON adjustment_reason_kinds TO app_login;

REVOKE ALL ON tenant_adjustment_reasons, tenant_adjustment_reason_kind_settings FROM app_login;
GRANT SELECT, INSERT, UPDATE ON tenant_adjustment_reasons, tenant_adjustment_reason_kind_settings TO app_login;
GRANT DELETE ON tenant_adjustment_reasons TO app_login;
