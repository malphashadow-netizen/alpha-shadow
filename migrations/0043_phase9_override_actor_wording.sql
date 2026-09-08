-- Migration 0043 — Phase 9 (message wording): unambiguous override-actor phrasing.
--
-- 0042 made the three override-evidence messages name the actual movement
-- type. Reviewing the live text showed one remaining ambiguity for
-- audit-log readers: 'bound to the same actor' has no in-sentence
-- antecedent (same as whom?). The check itself compares the attempt's
-- initiating_actor_user_id to the movement's actor_user_id, so the message
-- now states exactly that: 'initiated by the movement actor'. One string
-- only; the stable requirement-prefix asserted by the test suite
-- ('% override requires a successful stock_override attempt') is unchanged,
-- as are the stale-attempt and single-use-claim messages.
--
-- MESSAGE TEXT ONLY: no table, column, constraint, index, trigger, grant, or
-- logic change. 0040/0042 themselves are untouched.
--
-- Style notes: idempotent (CREATE OR REPLACE), no DROP / CASCADE, no new tables.
--
CREATE OR REPLACE FUNCTION validate_stock_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_item_branch uuid;
  v_item_order uuid;
  v_current NUMERIC(18,4);
  v_attempt record;
BEGIN
  -- (a) The component belongs to the movement's branch (same-tenant is
  -- implied by the FK; the BRANCH match is the critical correctness check).
  SELECT branch_id INTO v_item_branch FROM public.inventory_items
   WHERE id = NEW.inventory_item_id AND tenant_id = NEW.tenant_id;
  IF v_item_branch IS NULL THEN
    RAISE EXCEPTION 'stock movement must reference an inventory item of the same tenant' USING ERRCODE = '23514';
  END IF;
  IF v_item_branch <> NEW.branch_id THEN
    RAISE EXCEPTION 'stock movement branch must match the inventory item branch' USING ERRCODE = '23514';
  END IF;

  -- (b) The branch belongs to the tenant (the FK already runs under the
  -- caller's RLS; re-asserted explicitly for a fail-closed message).
  IF NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.id = NEW.branch_id AND b.tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'stock movement must reference a branch of the same tenant' USING ERRCODE = '23514';
  END IF;

  -- (c) The actor is an ACTIVE user of the same tenant (same shape as 0023).
  IF NOT EXISTS (SELECT 1 FROM public.users u
                 WHERE u.id = NEW.actor_user_id AND u.tenant_id = NEW.tenant_id AND u.is_active) THEN
    RAISE EXCEPTION 'stock movement actor must be an active user of the same tenant' USING ERRCODE = '23514';
  END IF;

  -- (d) The order line belongs to the movement's order (same tenant via FKs).
  IF NEW.order_item_id IS NOT NULL THEN
    SELECT order_id INTO v_item_order FROM public.order_items
     WHERE id = NEW.order_item_id AND tenant_id = NEW.tenant_id;
    IF v_item_order IS NULL OR v_item_order <> NEW.order_id THEN
      RAISE EXCEPTION 'stock movement order_item must belong to the movement order' USING ERRCODE = '23514';
    END IF;
  END IF;

  -- (e) Manual movements: the actor must hold the matching inventory key
  -- through an ACTIVE tenant-wide or branch-scoped grant (same DB-level
  -- assertion shape as validate_order_discount, 0034/0036; the function name
  -- is historical — it is generic over permission keys).
  IF NEW.movement_type = 'manual_receiving' THEN
    PERFORM public.assert_tenant_order_permission(NEW.actor_user_id, 'inventory:receive', NEW.branch_id);
  ELSIF NEW.movement_type = 'manual_adjustment' THEN
    PERFORM public.assert_tenant_order_permission(NEW.actor_user_id, 'inventory:adjust', NEW.branch_id);
  END IF;

  -- (f) Override evidence: the 0036 evidence shape, adapted to the claim
  -- design — the attempt (same actor, 'stock_override' context, succeeded,
  -- fresh) PLUS the single-use claim binding it to THIS order.
  IF NEW.manager_override_id IS NOT NULL THEN
    SELECT a.outcome, a.initiating_actor_user_id, a.target_manager_user_id, a.context_type, a.created_at
      INTO v_attempt FROM public.manager_override_attempts a
     WHERE a.id = NEW.manager_override_id AND a.tenant_id = NEW.tenant_id;
    -- IS DISTINCT FROM is NULL-safe: a missing row fails every comparison.
    IF v_attempt.outcome IS DISTINCT FROM 'succeeded'
       OR v_attempt.context_type IS DISTINCT FROM 'stock_override'
       OR v_attempt.initiating_actor_user_id IS DISTINCT FROM NEW.actor_user_id THEN
      RAISE EXCEPTION '% override requires a successful stock_override attempt initiated by the movement actor', NEW.movement_type USING ERRCODE = '23514';
    END IF;
    IF v_attempt.created_at <= now() - make_interval(mins => 15) THEN
      RAISE EXCEPTION '% override attempt is stale (older than 15 minutes)', NEW.movement_type USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.stock_override_claims c
                    WHERE c.manager_override_id = NEW.manager_override_id
                      AND c.tenant_id = NEW.tenant_id AND c.order_id = NEW.order_id) THEN
      RAISE EXCEPTION '% override requires a single-use claim binding the attempt to this order', NEW.movement_type USING ERRCODE = '23514';
    END IF;
    -- The approving manager must personally hold the sensitive adjustment
    -- key (void/discount manager-authorization parity, 0027/0034).
    PERFORM public.assert_tenant_order_permission(v_attempt.target_manager_user_id, 'inventory:adjust', NEW.branch_id);
  END IF;

  -- (g) MANDATORY negative-balance gate: a sale_deduction that would drive
  -- the balance below zero MUST carry override evidence, otherwise it is
  -- rejected HERE — a negative balance is a fully-controlled side effect of
  -- documented override evidence, never a default behaviour. The row lock is
  -- mandatory: two concurrent orders serialise on the component row instead
  -- of racing past the check.
  IF NEW.movement_type = 'sale_deduction' THEN
    SELECT current_quantity INTO v_current FROM public.inventory_items
     WHERE id = NEW.inventory_item_id AND tenant_id = NEW.tenant_id FOR UPDATE;
    IF v_current IS NULL THEN
      RAISE EXCEPTION 'sale_deduction must reference an inventory item of the same tenant' USING ERRCODE = '23514';
    END IF;
    IF (v_current + NEW.quantity_delta) < 0 AND NEW.manager_override_id IS NULL THEN
      RAISE EXCEPTION 'stock: insufficient quantity for sale_deduction without a manager override (item %, branch %)',
        NEW.inventory_item_id, NEW.branch_id USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
