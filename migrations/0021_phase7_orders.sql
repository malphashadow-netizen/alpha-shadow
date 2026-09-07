-- Migration 0021 — Phase 7 (4/10): orders.
--
-- INVARIANT: orders.current_status_kind_id is a DERIVED value, recomputed
-- from the aggregation of its items' statuses. It is written exactly once at
-- INSERT (the workflow's initial enabled state) and afterwards ONLY by the
-- recompute path (recompute_order_status, migration 0023/0024) which flags the
-- transaction with app.orders_derived_write. Any direct UPDATE of the derived
-- column is rejected at the database level (fail-closed).
--
-- payment_status is a Phase-7 STUB ONLY ('open'/'paid'/'refund_pending'/
-- 'refunded'); the payments engine is a future phase. The void engine refuses
-- every void on a non-open order with PaymentReversalRequiredError — never a
-- silent zero (same placeholder pattern as ZATCA).
--
-- table_id has NO foreign key on purpose: table management is a future phase.
-- It follows the menu_items.tax_rule_id precedent (migration 0008): the hook
-- column exists now, the referencing table arrives later.
--
-- Style notes: idempotent, no DROP TABLE / CASCADE, mandatory RLS template.

CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  branch_id uuid NOT NULL,
  order_type text NOT NULL CHECK (order_type IN ('dine_in', 'takeaway', 'delivery')),
  -- Phase-6 sales channel registry (code-keyed global reference data).
  sales_channel_code text NOT NULL REFERENCES sales_channels (code),
  delivery_platform_id uuid REFERENCES delivery_platforms (id),
  -- Future tables-module hook (see header): plain uuid, no FK yet.
  table_id uuid,
  -- References tenant_order_workflow_states(id) — the tenant's own state row,
  -- which carries the platform kind and its fixed behavior_flags. RESTRICT:
  -- a referenced state can never be hard-deleted (audit is permanent).
  current_status_kind_id uuid NOT NULL,
  payment_status text NOT NULL DEFAULT 'open'
    CHECK (payment_status IN ('open', 'paid', 'refund_pending', 'refunded')),
  placed_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orders_id_tenant_key UNIQUE (id, tenant_id),
  FOREIGN KEY (branch_id, tenant_id) REFERENCES branches (id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (current_status_kind_id, tenant_id)
    REFERENCES tenant_order_workflow_states (id, tenant_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_orders_tenant_id ON orders (tenant_id);
CREATE INDEX IF NOT EXISTS idx_orders_branch_placed ON orders (tenant_id, branch_id, placed_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (tenant_id, current_status_kind_id);

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON orders;
CREATE POLICY tenant_isolation ON orders
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Direct writes to the derived order status are forbidden; only the recompute
-- path may move it (it sets app.orders_derived_write inside the SAME
-- transaction, around its own UPDATE).
CREATE FUNCTION guard_orders_derived_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.current_status_kind_id IS DISTINCT FROM OLD.current_status_kind_id
     AND NULLIF(current_setting('app.orders_derived_write', true), '') IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'orders.current_status_kind_id is derived from the item statuses; direct writes are forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_orders_derived_status_guard ON orders;
CREATE TRIGGER trg_orders_derived_status_guard BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION guard_orders_derived_status();

-- The status must reference a workflow state of the SAME tenant. On INSERT it
-- must additionally be ENABLED (a new order starts at a live state); on UPDATE
-- the recompute path may legitimately land on a state that was disabled later
-- (historical items may still sit there — disabling never rewrites history).
CREATE FUNCTION validate_orders_status_ref() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_order_workflow_states s
    WHERE s.id = NEW.current_status_kind_id AND s.tenant_id = NEW.tenant_id
      AND (TG_OP = 'UPDATE' OR s.is_enabled)) THEN
    RAISE EXCEPTION 'order status must reference a workflow state of the same tenant (enabled at creation)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_validate_orders_status_ref ON orders;
CREATE TRIGGER trg_validate_orders_status_ref BEFORE INSERT OR UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION validate_orders_status_ref();

REVOKE ALL ON orders FROM PUBLIC;
