-- Migration 0028 — Phase 7 (security patch): manager-override challenge rate limiting.
--
-- Closes the brute-force gap in the live manager-override PIN challenge
-- (PostgresManagerOverrideAuthenticator.verifyLiveChallenge): repeated PIN
-- guessing and manager_user_id enumeration are now counted and hard-locked,
-- with a permanent audit ledger of EVERY challenge attempt.
--
-- Three tables:
--   * manager_override_attempts — permanent APPEND-ONLY audit ledger (same
--     immutability pattern as order_item_status_events, 0023: no UPDATE, no
--     DELETE, ever). Records every challenge: the target manager, the
--     INITIATING ACTOR (the employee who requested the override), the
--     optional order link at the moment of the attempt, and the outcome:
--       succeeded | failed_wrong_pin | failed_unknown_or_inactive_manager
--       | rejected_locked.
--     The TARGET manager is deliberately NOT FK-validated nor
--     trigger-validated: probing unknown manager ids is exactly one of the
--     attacks this ledger exists to record (outcome
--     'failed_unknown_or_inactive_manager' — it COUNTS toward the locks).
--   * manager_override_lockout_state — one row per (tenant, manager):
--     5 consecutive failures inside a renewing 15-minute window → hard
--     15-minute lock of that manager.
--   * manager_override_actor_lockout_state — one row per (tenant, initiating
--     actor) ACROSS ALL MANAGERS: 10 failures against any managers inside a
--     renewing 15-minute window → hard 30-minute lock of the EMPLOYEE and a
--     mandatory high-severity security event in audit_log (Phase 4).
--
-- Counter semantics (enforced in the authenticator, one transaction):
--   * an attempt during an active lock is recorded as rejected_locked ONLY —
--     it is NOT counted again and does NOT extend the lock (a malicious
--     employee cannot keep a manager locked forever by hammering; the
--     actor-level lock is what stops the hammering itself);
--   * one success resets ONLY the target manager's counter — never the
--     actor's cross-manager counter (the threat there is trying MANY
--     managers);
--   * row locks are always taken actor-first, then manager (fixed order —
--     no deadlock).
--
-- Style notes: idempotent, no DROP TABLE / CASCADE, mandatory RLS template.

-- (a) Permanent append-only ledger of every live challenge attempt.
CREATE TABLE IF NOT EXISTS manager_override_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  -- The manager whose PIN was challenged. Deliberately NOT validated against
  -- users: enumeration probes against unknown ids are a recorded outcome.
  target_manager_user_id uuid NOT NULL,
  -- The employee who initiated the override request (the identity whose
  -- cross-manager guessing budget this ledger throttles).
  initiating_actor_user_id uuid NOT NULL,
  -- Optional link to the order whose void triggered the challenge, at the
  -- exact moment of the attempt.
  order_id uuid,
  outcome text NOT NULL
    CHECK (outcome IN ('succeeded', 'failed_wrong_pin', 'failed_unknown_or_inactive_manager', 'rejected_locked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (order_id, tenant_id) REFERENCES orders (id, tenant_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_manager_override_attempts_tenant_time
  ON manager_override_attempts (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_manager_override_attempts_actor_time
  ON manager_override_attempts (tenant_id, initiating_actor_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_manager_override_attempts_manager_time
  ON manager_override_attempts (tenant_id, target_manager_user_id, created_at);

ALTER TABLE manager_override_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE manager_override_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON manager_override_attempts;
CREATE POLICY tenant_isolation ON manager_override_attempts
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Same immutability pattern as prevent_order_evidence_mutation (0023).
CREATE FUNCTION prevent_manager_override_attempt_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable: % is forbidden', TG_TABLE_NAME, TG_OP USING ERRCODE = '55006';
END;
$$;
DROP TRIGGER IF EXISTS trg_manager_override_attempts_immutable ON manager_override_attempts;
CREATE TRIGGER trg_manager_override_attempts_immutable BEFORE UPDATE OR DELETE ON manager_override_attempts
  FOR EACH ROW EXECUTE FUNCTION prevent_manager_override_attempt_mutation();

-- The initiating actor must be a real, active user of the same tenant (fail
-- closed on bogus actor ids); the target manager may legitimately be unknown.
CREATE FUNCTION validate_manager_override_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = NEW.initiating_actor_user_id AND u.tenant_id = NEW.tenant_id AND u.is_active) THEN
    RAISE EXCEPTION 'manager override attempt requires an active initiating actor of the same tenant' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_validate_manager_override_attempt ON manager_override_attempts;
CREATE TRIGGER trg_validate_manager_override_attempt BEFORE INSERT ON manager_override_attempts
  FOR EACH ROW EXECUTE FUNCTION validate_manager_override_attempt();

-- (b) Per-manager lockout state: (tenant, manager) → 5 consecutive failures
--     in a renewing 15-minute window → 15-minute hard lock.
CREATE TABLE IF NOT EXISTS manager_override_lockout_state (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  manager_user_id uuid NOT NULL,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  -- NULL = no counting window is open (no failures since the last reset).
  window_started_at timestamptz,
  locked_until timestamptz,
  PRIMARY KEY (tenant_id, manager_user_id)
);
ALTER TABLE manager_override_lockout_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE manager_override_lockout_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON manager_override_lockout_state;
CREATE POLICY tenant_isolation ON manager_override_lockout_state
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- (c) Per-actor lockout state ACROSS ALL MANAGERS: (tenant, initiating
--     actor) → 10 failures against any managers in a renewing 15-minute
--     window → 30-minute hard lock + a high-severity security audit event.
CREATE TABLE IF NOT EXISTS manager_override_actor_lockout_state (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  initiating_actor_user_id uuid NOT NULL,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  window_started_at timestamptz,
  locked_until timestamptz,
  PRIMARY KEY (tenant_id, initiating_actor_user_id)
);
ALTER TABLE manager_override_actor_lockout_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE manager_override_actor_lockout_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON manager_override_actor_lockout_state;
CREATE POLICY tenant_isolation ON manager_override_actor_lockout_state
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

REVOKE ALL ON manager_override_attempts, manager_override_lockout_state, manager_override_actor_lockout_state FROM PUBLIC;
