-- Migration 0040 — Phase 9 (5/6): stock_override_claims + stock_movements.
--
-- stock_movements is the APPEND-ONLY, IMMUTABLE ledger of every stock change.
-- current_quantity on inventory_items is DERIVED from it — never written
-- directly (guard_inventory_item_writes below; same GUC tradition as
-- app.orders_derived_write, 0022/0023).
--
-- ── Why stock_override_claims exists (read before touching) ────────────────
-- A creation-time stock override MUST be verified BEFORE the order
-- transaction starts: the challenge commits its own transaction, so verifying
-- inside would leave the attempt row invisible to this transaction's
-- REPEATABLE READ snapshot (same constraint the discount engine documents).
-- But the order does not exist yet at verify time, so the attempt row can
-- never carry the order's id (the attempts→orders FK forbids dangling ids,
-- and the attempts ledger is immutable — no late UPDATE). The claim row,
-- written INSIDE the order transaction, is therefore the single-use binding
-- of one override attempt to exactly one order: the PRIMARY KEY makes a
-- double-claim structurally impossible (23505, fail-closed, race-safe under
-- every isolation level).
--
-- ── Message-stability contract ─────────────────────────────────────────────
-- The negative-balance rejection below starts with the stable prefix
-- 'stock: insufficient quantity'. The orders store maps (23514 + this prefix)
-- to the InsufficientStockError application error (same mapping discipline
-- as rethrowCatalogWriteError). NEVER reword the prefix without updating the
-- store mapper and its unit test together.
--
-- Style notes: idempotent, no DROP TABLE / CASCADE, mandatory RLS template.

-- ─────────────────────────────────────────────────────────────────────────────
-- (1) stock_override_claims — single-use claim: one attempt, exactly one order.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_override_claims (
  manager_override_id uuid PRIMARY KEY REFERENCES manager_override_attempts (id) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  order_id uuid NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_override_claims_id_tenant_key UNIQUE (manager_override_id, tenant_id),
  CONSTRAINT stock_override_claims_order_fk
    FOREIGN KEY (order_id, tenant_id)
    REFERENCES orders (id, tenant_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_stock_override_claims_tenant_id ON stock_override_claims (tenant_id);
CREATE INDEX IF NOT EXISTS idx_stock_override_claims_order ON stock_override_claims (tenant_id, order_id);

ALTER TABLE stock_override_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_override_claims FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON stock_override_claims;
CREATE POLICY tenant_isolation ON stock_override_claims
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- ─────────────────────────────────────────────────────────────────────────────
-- (2) stock_movements — the append-only stock ledger.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  branch_id uuid NOT NULL REFERENCES branches (id) ON DELETE RESTRICT,
  inventory_item_id uuid NOT NULL,
  movement_type text NOT NULL,
  quantity_delta NUMERIC(18,4) NOT NULL,
  order_id uuid NULL,
  order_item_id uuid NULL,
  actor_user_id uuid NOT NULL,
  manager_override_id uuid NULL REFERENCES manager_override_attempts (id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_movements_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT stock_movements_type_valid CHECK (movement_type IN (
    'sale_deduction', 'void_restoration', 'waste_void',
    'waste_refund', 'manual_receiving', 'manual_adjustment')),
  CONSTRAINT stock_movements_item_fk
    FOREIGN KEY (inventory_item_id, tenant_id)
    REFERENCES inventory_items (id, tenant_id)
    ON DELETE RESTRICT,
  CONSTRAINT stock_movements_order_fk
    FOREIGN KEY (order_id, tenant_id)
    REFERENCES orders (id, tenant_id)
    ON DELETE RESTRICT,
  CONSTRAINT stock_movements_order_item_fk
    FOREIGN KEY (order_item_id, tenant_id)
    REFERENCES order_items (id, tenant_id)
    ON DELETE RESTRICT,
  -- The sign is fixed per movement kind: waste rows are report-only lines
  -- with a ZERO delta (a consumed quantity stays consumed).
  CONSTRAINT stock_movements_sign CHECK (
    (movement_type = 'sale_deduction' AND quantity_delta < 0) OR
    (movement_type = 'void_restoration' AND quantity_delta > 0) OR
    (movement_type IN ('waste_void', 'waste_refund') AND quantity_delta = 0) OR
    (movement_type = 'manual_receiving' AND quantity_delta > 0) OR
    (movement_type = 'manual_adjustment' AND quantity_delta <> 0)),
  -- Order-bound movements always name their order line; manual movements
  -- never do (the two paths cannot be mixed on one row).
  CONSTRAINT stock_movements_order_link CHECK (
    (movement_type IN ('sale_deduction', 'void_restoration', 'waste_void', 'waste_refund')
      AND order_id IS NOT NULL AND order_item_id IS NOT NULL) OR
    (movement_type IN ('manual_receiving', 'manual_adjustment')
      AND order_id IS NULL AND order_item_id IS NULL)),
  -- Override evidence is only meaningful on a sale into shortage.
  CONSTRAINT stock_movements_override_scope CHECK (
    manager_override_id IS NULL OR movement_type = 'sale_deduction')
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_tenant_id ON stock_movements (tenant_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_item_time ON stock_movements (tenant_id, branch_id, inventory_item_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_stock_movements_order ON stock_movements (tenant_id, order_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_order_item ON stock_movements (tenant_id, order_item_id);

ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON stock_movements;
CREATE POLICY tenant_isolation ON stock_movements
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- ─────────────────────────────────────────────────────────────────────────────
-- (3) Immutability: no UPDATE, no DELETE, ever (same pattern as 0023/0034).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION prevent_stock_movement_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable: % is forbidden', TG_TABLE_NAME, TG_OP USING ERRCODE = '55006';
END;
$$;
DROP TRIGGER IF EXISTS trg_stock_movements_immutable ON stock_movements;
CREATE TRIGGER trg_stock_movements_immutable BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION prevent_stock_movement_mutation();

DROP TRIGGER IF EXISTS trg_stock_override_claims_immutable ON stock_override_claims;
CREATE TRIGGER trg_stock_override_claims_immutable BEFORE UPDATE OR DELETE ON stock_override_claims
  FOR EACH ROW EXECUTE FUNCTION prevent_stock_movement_mutation();

-- ─────────────────────────────────────────────────────────────────────────────
-- (4) Structural validation of every movement row (fail-closed on all paths).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION validate_stock_movement() RETURNS trigger LANGUAGE plpgsql AS $$
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
      RAISE EXCEPTION 'sale_deduction override requires a successful stock_override attempt bound to the same actor' USING ERRCODE = '23514';
    END IF;
    IF v_attempt.created_at <= now() - make_interval(mins => 15) THEN
      RAISE EXCEPTION 'sale_deduction override attempt is stale (older than 15 minutes)' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.stock_override_claims c
                    WHERE c.manager_override_id = NEW.manager_override_id
                      AND c.tenant_id = NEW.tenant_id AND c.order_id = NEW.order_id) THEN
      RAISE EXCEPTION 'sale_deduction override requires a single-use claim binding the attempt to this order' USING ERRCODE = '23514';
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
DROP TRIGGER IF EXISTS trg_validate_stock_movement ON stock_movements;
CREATE TRIGGER trg_validate_stock_movement BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION validate_stock_movement();

-- ─────────────────────────────────────────────────────────────────────────────
-- (5) apply_stock_movement — the ONLY writer of current_quantity.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION apply_stock_movement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.inventory_derived_write', '1', true);
  UPDATE public.inventory_items
     SET current_quantity = current_quantity + NEW.quantity_delta, updated_at = now()
   WHERE id = NEW.inventory_item_id AND tenant_id = NEW.tenant_id;
  PERFORM set_config('app.inventory_derived_write', '', true);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_apply_stock_movement ON stock_movements;
CREATE TRIGGER trg_apply_stock_movement AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION apply_stock_movement();

-- ─────────────────────────────────────────────────────────────────────────────
-- (6) guard_inventory_item_writes — current_quantity moves only via movements.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION guard_inventory_item_writes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_quantity IS DISTINCT FROM OLD.current_quantity
     AND NULLIF(current_setting('app.inventory_derived_write', true), '') IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'inventory_items.current_quantity is derived from stock_movements; direct writes are forbidden' USING ERRCODE = '42501';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.branch_id IS DISTINCT FROM OLD.branch_id THEN
    RAISE EXCEPTION 'inventory_items tenant/branch identity is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_inventory_item_writes ON inventory_items;
CREATE TRIGGER trg_guard_inventory_item_writes BEFORE UPDATE ON inventory_items
  FOR EACH ROW EXECUTE FUNCTION guard_inventory_item_writes();

REVOKE ALL ON stock_override_claims, stock_movements FROM PUBLIC;
