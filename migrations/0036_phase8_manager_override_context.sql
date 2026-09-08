-- Migration 0036 — Phase 8 fix: context_type on manager_override_attempts.
--
-- The Phase-7b live challenge ledger now serves TWO business contexts:
--   * 'void'     — order/item void overrides (Phase 7, the original user);
--   * 'discount' — discount cap/zero-out overrides (Phase 8).
-- Every attempt row now records WHICH context it was issued for, so override
-- evidence can never cross contexts: a successful 'void' challenge cannot
-- authorize a discount row, and a successful 'discount' challenge cannot
-- authorize a void (enforced for discounts in validate_order_discount,
-- upgraded below; the void engine stamps 'void' on every challenge it
-- issues).
--
-- Backfill: 'void' is the ONLY context that existed before Phase 8, so the
-- column is added NOT NULL DEFAULT 'void' — existing rows backfill
-- automatically — and the DEFAULT is then DROPPED: every future INSERT must
-- state its context explicitly (fail-closed; no silent default ever again).
--
-- DELIBERATE, NOT AN OMISSION: the rate-limiting state tables
-- manager_override_lockout_state and manager_override_actor_lockout_state
-- are NOT touched and do NOT record context_type. Lockouts stay in force
-- ACROSS ALL CONTEXTS, per (tenant, target manager) and per (tenant,
-- initiating actor): if lockouts were per-context, any party could bypass an
-- active lock simply by alternating between Void and Discount challenges.
-- For the same reason the lockout-serving indexes
-- (idx_manager_override_attempts_actor_time / _manager_time) stay
-- context-free on purpose.
--
-- Style notes: idempotent, no DROP TABLE / CASCADE, no new tables (the
-- existing tenant_isolation RLS policy on manager_override_attempts is
-- unaffected).

-- (a) The context column: 'void' backfill, then no default ever again.
ALTER TABLE manager_override_attempts
  ADD COLUMN IF NOT EXISTS context_type text NOT NULL DEFAULT 'void'
    CHECK (context_type IN ('void', 'discount'));
ALTER TABLE manager_override_attempts ALTER COLUMN context_type DROP DEFAULT;

-- (b) Evidence-lookup index, WITH context_type in the search key. No
-- pre-0036 index covered the successful-attempt evidence tuple (initiating
-- actor, target manager, order, outcome, created_at) — the two *_time
-- indexes above serve the lockout counters, not evidence lookups — so the
-- dedicated index is created here, backing the "latest successful attempt
-- in the SAME context" query (findSuccessfulOverrideAttemptId and the
-- validate_order_discount evidence check).
CREATE INDEX IF NOT EXISTS idx_manager_override_attempts_context_evidence
  ON manager_override_attempts (tenant_id, initiating_actor_user_id, target_manager_user_id, order_id, context_type, outcome, created_at);

-- (c) Upgrade of validate_order_discount (created in 0034; the trigger
-- trg_validate_order_discount stays attached): an escalated discount's
-- evidence must now be a SUCCESSFUL Phase-7b live PIN challenge of the SAME
-- initiating actor, for the SAME order, AND in the SAME 'discount' context.
CREATE OR REPLACE FUNCTION validate_order_discount() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_branch_id uuid;
  v_branch text;
  v_digits smallint;
  v_subtotal_minor bigint;
  v_applied_minor bigint;
  v_pct numeric;
  v_fixed numeric;
  v_coupon record;
  v_min_minor bigint;
BEGIN
  -- The order must be a same-tenant order with an active branch currency.
  SELECT o.branch_id, b.base_currency INTO v_branch_id, v_branch
    FROM public.orders o JOIN public.branches b ON b.id = o.branch_id AND b.tenant_id = o.tenant_id
    WHERE o.id = NEW.order_id AND o.tenant_id = NEW.tenant_id;
  IF v_branch IS NULL THEN
    RAISE EXCEPTION 'discount must reference an order of the same tenant' USING ERRCODE = '23514';
  END IF;
  SELECT c.minor_unit_digits INTO v_digits FROM public.currencies c WHERE c.code = v_branch;
  IF v_digits IS NULL THEN
    RAISE EXCEPTION 'branch base currency is not in the currencies registry' USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.users u
                 WHERE u.id = NEW.applied_by AND u.tenant_id = NEW.tenant_id AND u.is_active) THEN
    RAISE EXCEPTION 'discount actor must be an active member of the same tenant' USING ERRCODE = '23514';
  END IF;

  -- The applier must hold the atomic discount permission through an ACTIVE
  -- tenant-wide or branch-scoped grant (same DB-level assertion shape as the
  -- order_voids override manager check, 0027).
  PERFORM public.assert_tenant_order_permission(NEW.applied_by, 'order:discount:apply', v_branch_id);

  -- Active (non-voided) subtotal in minor units, and the applied amount at
  -- the same scale: capping must never produce a negative remainder.
  SELECT COALESCE(SUM(i.unit_price_minor * i.quantity), 0) INTO v_subtotal_minor
    FROM public.order_items i
    WHERE i.order_id = NEW.order_id AND i.tenant_id = NEW.tenant_id AND NOT i.is_voided;
  v_applied_minor := round(NEW.discount_amount_applied * power(10, v_digits));
  IF v_applied_minor > v_subtotal_minor THEN
    RAISE EXCEPTION 'discount_amount_applied must not exceed the active order subtotal (capping can never go negative)' USING ERRCODE = '23514';
  END IF;
  -- Zeroing out the subtotal ALWAYS requires a manager override.
  IF v_applied_minor >= v_subtotal_minor AND NOT NEW.required_manager_override THEN
    RAISE EXCEPTION 'a discount that zeroes out the order subtotal ALWAYS requires a manager override' USING ERRCODE = '23514';
  END IF;

  -- The actor's dynamic per-user caps (user_discount_limits). A NULL cap
  -- dimension means the kind is NOT granted — and a manager override can
  -- raise a SET cap, but it can never MINT authority that was never granted.
  SELECT l.max_discount_percentage, l.max_discount_fixed_amount INTO v_pct, v_fixed
    FROM public.user_discount_limits l
    WHERE l.tenant_id = NEW.tenant_id AND l.user_id = NEW.applied_by
      AND l.permission_key = 'order:discount:apply';
  IF NEW.discount_kind = 'percentage' AND v_pct IS NULL THEN
    RAISE EXCEPTION 'the actor has no percentage discount authority (cap dimension not granted)' USING ERRCODE = '23514';
  END IF;
  IF NEW.discount_kind = 'fixed_amount' AND v_fixed IS NULL THEN
    RAISE EXCEPTION 'the actor has no fixed-amount discount authority (cap dimension not granted)' USING ERRCODE = '23514';
  END IF;
  -- A NON-escalated discount must additionally sit inside the granted cap.
  IF NOT NEW.required_manager_override THEN
    IF NEW.discount_kind = 'percentage' AND NEW.discount_value > v_pct THEN
      RAISE EXCEPTION 'percentage discount exceeds the actor''s cap and was not manager-approved' USING ERRCODE = '23514';
    END IF;
    IF NEW.discount_kind = 'fixed_amount' AND NEW.discount_value > v_fixed THEN
      RAISE EXCEPTION 'fixed-amount discount exceeds the actor''s cap and was not manager-approved' USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Coupon mechanism: the referenced coupon must be live and usable.
  IF NEW.mechanism = 'coupon' THEN
    SELECT * INTO v_coupon FROM public.coupons c
      WHERE c.id = NEW.coupon_id AND c.tenant_id = NEW.tenant_id;
    IF v_coupon IS NULL OR NOT v_coupon.is_active THEN
      RAISE EXCEPTION 'coupon discount requires an active coupon of the same tenant' USING ERRCODE = '23514';
    END IF;
    IF v_coupon.expires_at IS NOT NULL AND v_coupon.expires_at <= now() THEN
      RAISE EXCEPTION 'coupon is expired' USING ERRCODE = '23514';
    END IF;
    IF v_coupon.max_uses IS NOT NULL AND v_coupon.uses_count >= v_coupon.max_uses THEN
      RAISE EXCEPTION 'coupon has reached its maximum uses' USING ERRCODE = '23514';
    END IF;
    IF v_coupon.min_order_amount IS NOT NULL THEN
      v_min_minor := round(v_coupon.min_order_amount * power(10, v_digits));
      IF v_subtotal_minor < v_min_minor THEN
        RAISE EXCEPTION 'order subtotal is below the coupon minimum' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  -- Escalated rows: the recorded attempt must be a SUCCESSFUL Phase-7b live
  -- PIN challenge of the SAME initiating actor, for the SAME order, AND in
  -- the SAME 'discount' context (0036: a void-context success is not
  -- discount evidence).
  IF NEW.required_manager_override THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.manager_override_attempts a
      WHERE a.id = NEW.manager_override_attempt_id AND a.tenant_id = NEW.tenant_id
        AND a.outcome = 'succeeded'
        AND a.initiating_actor_user_id = NEW.applied_by
        AND a.order_id = NEW.order_id
        AND a.context_type = 'discount') THEN
      RAISE EXCEPTION 'escalated discount requires a successful discount-context manager-override attempt bound to the same actor and order' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

