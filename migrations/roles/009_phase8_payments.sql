-- migrations/roles/009_phase8_payments.sql — MANUAL, ONE-TIME DBA script.
--
-- ⚠️ THIS FILE IS NOT PART OF THE NORMAL MIGRATION CYCLE. ⚠️
-- Same provisioning contract as migrations/roles/007_phase7_orders.sql: run
-- once per environment with DBA authority AFTER migration 0035, never through
-- tools/migrate.ts (which only reads top-level migrations/*.sql).
--
-- Least-privilege grants for the Phase-8 payments/shifts/discounts surface:
--   * currency_denominations (global reference): SELECT ONLY — a tenant
--     connection can never mutate platform reference data.
--   * payment_methods / coupons (tenant configuration): SELECT, INSERT,
--     UPDATE — deactivation (is_active = false) replaces deletion; no DELETE.
--   * user_discount_limits (per-user dynamic caps from the permissions
--     screen): full CRUD — the screen may set, change or revoke caps.
--   * order_discounts / cash_count_details (append-only evidence):
--     SELECT + INSERT only — immutability is additionally enforced by
--     prevent_* triggers (55006).
--   * payments: SELECT, INSERT, UPDATE — UPDATE is the void/refund lifecycle
--     only (guard_payment_writes rejects everything else); no DELETE.
--   * shift_reconciliations: SELECT, INSERT, UPDATE — UPDATE is the Z-Report
--     close only (validate_shift_reconciliation rejects everything else);
--     no DELETE.
--   * manager_override_attempts already grants SELECT to app_login from
--     roles/008 (the discount engine reads the successful attempt id);
--     exchange_rates INSERT and audit_log SELECT/INSERT already come from
--     roles/004 (the rate-change ledger trigger and refund audit rows).

-- Global reference data: read-only for the application role.
REVOKE ALL ON currency_denominations FROM app_login;
GRANT SELECT ON currency_denominations TO app_login;

-- Tenant configuration.
REVOKE ALL ON payment_methods, coupons FROM app_login;
GRANT SELECT, INSERT, UPDATE ON payment_methods, coupons TO app_login;

-- Per-user dynamic discount caps (permissions-management screen).
REVOKE ALL ON user_discount_limits FROM app_login;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_discount_limits TO app_login;

-- Append-only evidence ledgers: insert + read only.
REVOKE ALL ON order_discounts, cash_count_details FROM app_login;
GRANT SELECT, INSERT ON order_discounts, cash_count_details TO app_login;

-- Payments: insert + lifecycle updates; never delete.
REVOKE ALL ON payments FROM app_login;
GRANT SELECT, INSERT, UPDATE ON payments TO app_login;

-- Shifts: insert (the atomic open) + the Z-Report close update; never delete.
REVOKE ALL ON shift_reconciliations FROM app_login;
GRANT SELECT, INSERT, UPDATE ON shift_reconciliations TO app_login;
