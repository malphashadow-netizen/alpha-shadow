-- Migration 0054 — Audit F-A fix: scope-aware void authorization backstop.
--
-- THE HOLE (audit finding F-A): the engine resolved the actor's void tier
-- from tenant-wide atomic keys ANYWHERE in the tenant: a user holding the
-- tenant-wide base key 'order:void' PLUS a branch-scoped supervisor/manager
-- key for branch A resolved tier supervisor/manager for EVERY branch — so a
-- manager-tier reason on an order in branch B voided WITHOUT any live PIN
-- challenge. The validate_order_void trigger (0027) never re-proved the
-- ACTOR's keys at all, and never re-asserted the reason's enabled-ness.
--
-- This migration replaces validate_order_void (CREATE OR REPLACE, 0035
-- precedent) with a version that KEEPS every existing check byte-identical
-- (same order, same messages, same codes) and adds, AFTER the payment-policy
-- block so every pre-existing rejection keeps its error:
--   1. Branch fetch: the order's branch_id is read together with the payment
--      status and reused by the manager assert (previously a second
--      sub-select; identical semantics) and by the new actor asserts.
--   2. Reason freshness: the reason's required_permission_tier is fetched
--      through the SAME enabled gate the engine's loadVoidReason applies
--      (r.is_enabled AND the per-kind setting, default-true). A reason
--      disabled after the engine's check but before the write (the live-PIN
--      window) can no longer land. NOTE: 0049's "validate_order_void does
--      not check it either" described this trigger BEFORE this migration;
--      void now re-asserts at INSERT, adjustments stay engine-side.
--   3. Actor backstop. No override recorded: the actor must hold a key AT OR
--      ABOVE the reason's required tier (server reasons accept the base key,
--      supervisor reasons the top two, manager reasons the top key only)
--      through a grant COVERING the order's branch. Override recorded: the
--      actor must still hold the base 'order:void' key covering the branch
--      (the engine's stage-1 demands a tenant-wide grant, so every
--      legitimate flow passes; this closes grant-revocation inside the
--      challenge window). Both scope predicates mirror
--      assert_tenant_order_permission's covering rule exactly
--      (tenant-wide, or branch-scoped for exactly this branch).
--
-- The tier ladder below mirrors the code ladder VOID_PERMISSION_TIER_RANK +
-- ORDER_VOID_PERMISSION_KEYS (src/domain/contracts/orders.ts), pinned by
-- test/unit/application/orders/void-tier-ladder.test.ts — change one and you
-- must change the other.
--
-- RLS/grants: the new sub-selects read tables the app role already SELECTs
-- (tenant_void_reasons + kind_settings via 007; users/tenants/user_roles/
-- roles/role_permissions via 001/002 — the same joins assert_tenant_order_
-- permission already performs). No new functions, no grant changes.
--
-- Style notes: idempotent (CREATE OR REPLACE re-attaches to the existing
-- trigger; 0035 precedent), no new tables, no DROP, no CASCADE.

CREATE OR REPLACE FUNCTION validate_order_void() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_payment text;
  v_branch uuid;
  v_item_order uuid;
  v_required_tier text;
  v_keys text[];
BEGIN
  SELECT payment_status, branch_id INTO v_payment, v_branch FROM public.orders
    WHERE id = NEW.order_id AND tenant_id = NEW.tenant_id;
  IF v_payment IS NULL THEN
    RAISE EXCEPTION 'void must reference an order of the same tenant' USING ERRCODE = '23514';
  END IF;
  -- orders.branch_id is NOT NULL: a NULL here means corruption, never a
  -- legitimate row — fail closed with the same same-tenant message (and never
  -- let a NULL branch reach the IS NOT DISTINCT FROM scope predicates).
  IF v_branch IS NULL THEN
    RAISE EXCEPTION 'void must reference an order of the same tenant' USING ERRCODE = '23514';
  END IF;
  -- Evidence integrity: the snapshot must equal the live payment status at
  -- insert time.
  IF NEW.order_payment_status_at_void_time <> v_payment THEN
    RAISE EXCEPTION 'order_voids.payment status snapshot must equal the order''s live payment status' USING ERRCODE = '23514';
  END IF;
  -- Fail-closed structural policy (Phase 7): a paid/refund-pending/refunded
  -- order can never be voided — the payments engine (future phase) owns the
  -- Void Payment → Reopen → Void Item → re-collection sequence. Removing this
  -- block is a deliberate, reviewed migration decision of that phase.
  IF v_payment <> 'open' THEN
    RAISE EXCEPTION 'PaymentReversalRequiredError: void on a % order requires the payments engine (fail closed)', v_payment USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.users u WHERE u.id = NEW.actor_user_id AND u.tenant_id = NEW.tenant_id AND u.is_active) THEN
    RAISE EXCEPTION 'void actor must be an active user of the same tenant' USING ERRCODE = '23514';
  END IF;
  IF NEW.order_item_id IS NOT NULL THEN
    SELECT order_id INTO v_item_order FROM public.order_items WHERE id = NEW.order_item_id AND tenant_id = NEW.tenant_id;
    IF v_item_order IS NULL OR v_item_order <> NEW.order_id THEN
      RAISE EXCEPTION 'voided item must belong to the voided order' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- Reason freshness (audit F-A, decision 1): the reason must be an ENABLED
  -- reason of the same tenant at INSERT time — the engine's loadVoidReason
  -- gate (r.is_enabled AND the per-kind setting, default-true), re-asserted
  -- here to close the live-challenge TOCTOU window. Also yields the required
  -- tier for the actor backstop below (required_permission_tier is NOT NULL,
  -- so NULL here unambiguously means disabled-or-foreign).
  SELECT r.required_permission_tier INTO v_required_tier
    FROM public.tenant_void_reasons r
    LEFT JOIN public.tenant_void_reason_kind_settings s
      ON s.tenant_id = r.tenant_id AND s.void_reason_kind_code = r.void_reason_kind_code
   WHERE r.id = NEW.void_reason_id AND r.tenant_id = NEW.tenant_id
     AND r.is_enabled AND COALESCE(s.is_enabled, true);
  IF v_required_tier IS NULL THEN
    RAISE EXCEPTION 'void reason must be an enabled reason of the same tenant' USING ERRCODE = '23514';
  END IF;
  -- Tier ladder → acceptable keys (mirrors VOID_PERMISSION_TIER_RANK +
  -- ORDER_VOID_PERMISSION_KEYS; pinned by void-tier-ladder.test.ts).
  v_keys := CASE v_required_tier
    WHEN 'server' THEN ARRAY['order:void', 'order:void:shift_supervisor', 'order:void:manager']
    WHEN 'shift_supervisor' THEN ARRAY['order:void:shift_supervisor', 'order:void:manager']
    ELSE ARRAY['order:void:manager']
  END;
  IF NEW.manager_user_id IS NOT NULL THEN
    -- A live PIN challenge timestamp is mandatory evidence for any recorded
    -- manager identity (name-only overrides are structurally impossible).
    IF NEW.override_authenticated_at IS NULL THEN
      RAISE EXCEPTION 'manager override without a recorded live authentication timestamp is forbidden' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.users u WHERE u.id = NEW.manager_user_id AND u.tenant_id = NEW.tenant_id AND u.is_active) THEN
      RAISE EXCEPTION 'override manager must be an active user of the same tenant' USING ERRCODE = '23514';
    END IF;
    PERFORM public.assert_tenant_order_permission(NEW.manager_user_id, 'order:void:manager', v_branch);
  END IF;
  -- Actor backstop (audit F-A): the recorded actor must hold a
  -- branch-COVERING key — at/above the required tier without an override,
  -- the base key with one (the engine demands a tenant-wide stage-1 grant,
  -- so every legitimate flow passes). Scope predicates mirror
  -- assert_tenant_order_permission exactly.
  IF NEW.required_manager_override THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.users u
        JOIN public.tenants t ON t.id = u.tenant_id
        JOIN public.user_roles ur ON ur.user_id = u.id AND ur.tenant_id = u.tenant_id
        JOIN public.roles r ON r.id = ur.role_id AND r.tenant_id = ur.tenant_id
        JOIN public.role_permissions rp ON rp.role_id = r.id AND rp.tenant_id = r.tenant_id
      WHERE u.id = NEW.actor_user_id AND u.tenant_id = NEW.tenant_id AND u.is_active AND t.status = 'active'
        AND ur.is_active
        AND (ur.scope_type = 'tenant' AND ur.scope_id IS NULL
             OR ur.scope_type = 'branch' AND ur.scope_id IS NOT DISTINCT FROM v_branch)
        AND rp.permission_key = 'order:void'
    ) THEN
      RAISE EXCEPTION 'void actor must hold the order:void permission covering the order branch' USING ERRCODE = '42501';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM public.users u
      JOIN public.tenants t ON t.id = u.tenant_id
      JOIN public.user_roles ur ON ur.user_id = u.id AND ur.tenant_id = u.tenant_id
      JOIN public.roles r ON r.id = ur.role_id AND r.tenant_id = ur.tenant_id
      JOIN public.role_permissions rp ON rp.role_id = r.id AND rp.tenant_id = r.tenant_id
    WHERE u.id = NEW.actor_user_id AND u.tenant_id = NEW.tenant_id AND u.is_active AND t.status = 'active'
      AND ur.is_active
      AND (ur.scope_type = 'tenant' AND ur.scope_id IS NULL
           OR ur.scope_type = 'branch' AND ur.scope_id IS NOT DISTINCT FROM v_branch)
      AND rp.permission_key = ANY(v_keys)
  ) THEN
    RAISE EXCEPTION 'void actor lacks a branch-covering void permission at the required % tier', v_required_tier USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
