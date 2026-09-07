-- migrations/roles/007_phase7_orders.sql — MANUAL, ONE-TIME DBA script.
--
-- ⚠️ THIS FILE IS NOT PART OF THE NORMAL MIGRATION CYCLE. ⚠️
-- Same provisioning contract as migrations/roles/006_phase6_tax.sql: run once
-- per environment with DBA authority AFTER migration 0027, never through
-- tools/migrate.ts (which only reads top-level migrations/*.sql).
--
-- Least-privilege grants for the Phase-7 orders/KDS surface:
--   * Platform reference data (order_status_kinds, void_reason_kinds):
--     SELECT ONLY for app_login — a tenant connection can never mutate them
--     (grants + guard_platform_order_write trigger + no tenant RLS row
--     ownership). Platform evolution stays a DBA operation.
--   * Tenant configuration tables: full CRUD through withTenantContext().
--   * Evidence tables (order_item_status_events, order_events_outbox,
--     order_voids): INSERT + SELECT only — immutability is additionally
--     enforced by prevent_order_evidence_mutation triggers (55006).
--   * order_items / orders: UPDATE is required by the derived-status triggers
--     and the void lifecycle; the derived columns and purchase evidence are
--     protected by the guard triggers (GUC-scoped recompute path only).
--   * side_effect_delivery_log: INSERT + UPDATE (claim/retry state machine),
--     no DELETE (the ledger is permanent).

-- Platform-owned Phase-7 reference data: read-only for the application role.
REVOKE ALL ON order_status_kinds, void_reason_kinds FROM app_login;
GRANT SELECT ON order_status_kinds, void_reason_kinds TO app_login;

-- Tenant workflow configuration (hard delete of referenced states is blocked
-- by ON DELETE RESTRICT FKs from orders/order_items/order_item_status_events).
REVOKE ALL ON tenant_order_workflows, tenant_order_workflow_states FROM app_login;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_order_workflows, tenant_order_workflow_states TO app_login;

-- Stations + routing rules (tenant configuration).
REVOKE ALL ON stations, station_routing_rules FROM app_login;
GRANT SELECT, INSERT, UPDATE, DELETE ON stations, station_routing_rules TO app_login;

-- Orders / order items: creation + trigger-driven derived updates + void
-- lifecycle. Direct writes to the derived/routing columns are rejected by the
-- guard triggers regardless of these grants.
REVOKE ALL ON orders, order_items FROM app_login;
GRANT SELECT, INSERT, UPDATE ON orders, order_items TO app_login;

-- Immutable evidence ledgers: append + read only.
REVOKE ALL ON order_item_status_events, order_events_outbox, order_voids FROM app_login;
GRANT SELECT, INSERT ON order_item_status_events, order_events_outbox, order_voids TO app_login;

-- Per-branch gapless sequence counters (allocation does INSERT + UPDATE).
REVOKE ALL ON order_event_sequences FROM app_login;
GRANT SELECT, INSERT, UPDATE ON order_event_sequences TO app_login;

-- Claim-then-execute side-effect ledger: claim, mark, retry — never delete.
REVOKE ALL ON side_effect_delivery_log FROM app_login;
GRANT SELECT, INSERT, UPDATE ON side_effect_delivery_log TO app_login;

-- Tenant void configuration.
REVOKE ALL ON tenant_void_reasons, tenant_void_reason_kind_settings, tenant_void_settings FROM app_login;
GRANT SELECT, INSERT, UPDATE ON tenant_void_reasons, tenant_void_reason_kind_settings, tenant_void_settings TO app_login;
-- A reason row is deletable only while no audit evidence references it; the
-- FK from order_voids is ON DELETE RESTRICT either way.
GRANT DELETE ON tenant_void_reasons TO app_login;

-- Outbox/derived-status helper functions (transaction-scoped, RLS-bound).
REVOKE ALL ON FUNCTION next_order_event_sequence(uuid), append_order_event(uuid, uuid, text, jsonb),
  recompute_order_status(uuid, uuid) FROM app_login;
GRANT EXECUTE ON FUNCTION next_order_event_sequence(uuid), append_order_event(uuid, uuid, text, jsonb),
  recompute_order_status(uuid, uuid) TO app_login;

-- The order_voids validation trigger invokes the DB-level manager-permission
-- assertion with the caller's (app_login) privileges.
GRANT EXECUTE ON FUNCTION assert_tenant_order_permission(uuid, text, uuid) TO app_login;
