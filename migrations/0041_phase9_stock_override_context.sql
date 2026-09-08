-- Migration 0041 — Phase 9 (6/6): 'stock_override' context on manager_override_attempts.
--
-- The Phase-7b live challenge ledger now serves a THIRD business context:
--   * 'void'           — order/item void overrides (Phase 7);
--   * 'discount'       — discount cap/zero-out overrides (Phase 8);
--   * 'stock_override' — sale-into-shortage overrides (Phase 9).
-- The CHECK is re-created under an EXPLICIT stable name (the 0036 inline
-- CHECK carries a PostgreSQL-generated name): drop-then-add keeps this file
-- idempotent and re-runnable.
--
-- DELIBERATE, NOT AN OMISSION (same rationale as 0036, verbatim): the
-- rate-limiting state tables manager_override_lockout_state and
-- manager_override_actor_lockout_state are NOT touched and do NOT record
-- context_type. Lockouts stay in force ACROSS ALL CONTEXTS — if lockouts were
-- per-context, any party could bypass an active lock simply by alternating
-- between challenge contexts.
--
-- No new index: idx_manager_override_attempts_context_evidence (0036) already
-- carries context_type in its key and serves the new context unchanged.
--
-- Style notes: idempotent, no DROP TABLE / CASCADE, no new tables.

ALTER TABLE manager_override_attempts DROP CONSTRAINT IF EXISTS manager_override_attempts_context_type_check;
ALTER TABLE manager_override_attempts
  ADD CONSTRAINT manager_override_attempts_context_type_check
  CHECK (context_type IN ('void', 'discount', 'stock_override'));
