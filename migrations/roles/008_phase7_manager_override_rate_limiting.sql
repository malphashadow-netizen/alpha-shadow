-- migrations/roles/008_phase7_manager_override_rate_limiting.sql — MANUAL, ONE-TIME DBA script.
--
-- ⚠️ THIS FILE IS NOT PART OF THE NORMAL MIGRATION CYCLE. ⚠️
-- Same provisioning contract as migrations/roles/007_phase7_orders.sql: run once
-- per environment with DBA authority AFTER migration 0028, never through
-- tools/migrate.ts (which only reads top-level migrations/*.sql).
--
-- Least-privilege grants for the manager-override rate-limiting surface:
--   * manager_override_attempts: the append-only challenge ledger — SELECT +
--     INSERT only (immutability is additionally enforced by the
--     prevent_manager_override_attempt_mutation trigger, 55006).
--   * manager_override_lockout_state / manager_override_actor_lockout_state:
--     the lockout counters — SELECT + INSERT (claim/upsert) + UPDATE (count,
--     lock, reset). No DELETE: state rows are cleared by UPDATE (a reset
--     writes consecutive_failures = 0), never removed.
--   * audit_log already grants SELECT, INSERT to app_login from
--     migrations/roles/004_app_login_phase4.sql — the mandatory
--     security.manager_override_actor_locked event reuses that grant inside
--     the same transaction as the lock activation.

-- Append-only evidence ledger of every live challenge attempt.
REVOKE ALL ON manager_override_attempts FROM app_login;
GRANT SELECT, INSERT ON manager_override_attempts TO app_login;

-- Lockout counters (claim-then-count state machine; resets are UPDATEs).
REVOKE ALL ON manager_override_lockout_state, manager_override_actor_lockout_state FROM app_login;
GRANT SELECT, INSERT, UPDATE ON manager_override_lockout_state, manager_override_actor_lockout_state TO app_login;
