-- Migration 0034 — Phase 8 (6/7): coupons, order discounts, stacking switch.
--
-- (a) tenants.allow_discount_stacking (NOT NULL, default false): when false,
--     at most ONE discount row can ever exist per order (enforced by the
--     stacking trigger on order_discounts); when true, discounts stack in the
--     mandated fixed order coupon → manual → points, each stage recomputed
--     against the remaining subtotal (application engine, docs/phase8).
--
-- (b) coupons — tenant-scoped, UNIQUE(tenant_id, code), with min_order_amount,
--     max_uses/uses_count, expiry and is_active (archival, never deletion,
--     while order_discounts reference it).
--
-- (c) order_discounts — the permanent pricing-evidence ledger. Append-only
--     (UPDATE/DELETE rejected). Every row records the mechanism, the
--     requested kind/value, the APPLIED amount (≤ the active subtotal, so the
--     discounted subtotal is never negative), and — when the application
--     required escalation — the SUCCESSFUL manager_override_attempt_id from
--     the Phase-7b live PIN challenge ledger, bound to the SAME actor and
--     order (validate_order_discount). The DB additionally re-verifies:
--       * applied ≤ active subtotal (capping never negative), and
--         applied ≥ subtotal ⇒ required_manager_override (zeroing ALWAYS
--         escalates);
--       * a non-escalated discount must sit inside the actor's per-user caps
--         (user_discount_limits, migration 0031) for its kind;
--       * coupon mechanism rows reference an available coupon of the same
--         tenant (FK + live is_active/expiry/uses checks).
--
-- Style notes: idempotent, no DROP TABLE / CASCADE, mandatory RLS template.

-- (a) Tenant settings: the stacking switch (defaults OFF — one discount).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS allow_discount_stacking boolean NOT NULL DEFAULT false;

-- (b) coupons.
CREATE TABLE IF NOT EXISTS coupons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  code text NOT NULL,
  discount_kind text NOT NULL CHECK (discount_kind IN ('percentage', 'fixed_amount')),
  discount_value numeric(18,4) NOT NULL CHECK (discount_value > 0),
  min_order_amount numeric(18,2) CHECK (min_order_amount IS NULL OR min_order_amount > 0),
  max_uses integer CHECK (max_uses IS NULL OR max_uses >= 0),
  uses_count integer NOT NULL DEFAULT 0 CHECK (uses_count >= 0),
  expires_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT coupons_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT coupons_tenant_code_key UNIQUE (tenant_id, code),
  CONSTRAINT coupons_percentage_bounds CHECK (discount_kind <> 'percentage' OR discount_value <= 100),
  CONSTRAINT coupons_uses_within_max CHECK (max_uses IS NULL OR uses_count <= max_uses)
);
CREATE INDEX IF NOT EXISTS idx_coupons_tenant_id ON coupons (tenant_id);

ALTER TABLE coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupons FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON coupons;
CREATE POLICY tenant_isolation ON coupons
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Tenant-safe composite FK target for the Phase-7b attempt ledger.
ALTER TABLE manager_override_attempts DROP CONSTRAINT IF EXISTS manager_override_attempts_id_tenant_key;
ALTER TABLE manager_override_attempts ADD CONSTRAINT manager_override_attempts_id_tenant_key UNIQUE (id, tenant_id);

-- (c) order_discounts.
CREATE TABLE IF NOT EXISTS order_discounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  order_id uuid NOT NULL,
  mechanism text NOT NULL CHECK (mechanism IN ('coupon', 'manual', 'points')),
  coupon_id uuid,
  discount_kind text NOT NULL CHECK (discount_kind IN ('percentage', 'fixed_amount')),
  discount_value numeric(18,4) NOT NULL CHECK (discount_value > 0),
  discount_amount_applied numeric(18,2) NOT NULL CHECK (discount_amount_applied >= 0),
  required_manager_override boolean NOT NULL DEFAULT false,
  manager_override_attempt_id uuid,
  applied_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_discounts_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT order_discounts_coupon_presence CHECK ((mechanism = 'coupon') = (coupon_id IS NOT NULL)),
  CONSTRAINT order_discounts_override_evidence CHECK (NOT required_manager_override OR manager_override_attempt_id IS NOT NULL),
  FOREIGN KEY (order_id, tenant_id) REFERENCES orders (id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (coupon_id, tenant_id) REFERENCES coupons (id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (manager_override_attempt_id, tenant_id)
    REFERENCES manager_override_attempts (id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (applied_by, tenant_id) REFERENCES users (id, tenant_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_order_discounts_tenant_id ON order_discounts (tenant_id);
CREATE INDEX IF NOT EXISTS idx_order_discounts_order ON order_discounts (tenant_id, order_id);

ALTER TABLE order_discounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_discounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON order_discounts;
CREATE POLICY tenant_isolation ON order_discounts
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Applied discounts are permanent pricing evidence: never rewritten.
CREATE FUNCTION prevent_order_discount_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable pricing evidence: % is forbidden', TG_TABLE_NAME, TG_OP USING ERRCODE = '55006';
END;
$$;
DROP TRIGGER IF EXISTS trg_order_discounts_immutable ON order_discounts;
CREATE TRIGGER trg_order_discounts_immutable BEFORE UPDATE OR DELETE ON order_discounts
  FOR EACH ROW EXECUTE FUNCTION prevent_order_discount_mutation();

-- Stacking gate: with allow_discount_stacking = false, a second active
-- discount row for the same order is rejected (every existing row is active —
-- the ledger is append-only, there is no "removed discount" state in MVP).
CREATE FUNCTION enforce_discount_stacking() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_stacking boolean;
BEGIN
  SELECT t.allow_discount_stacking INTO v_stacking FROM public.tenants t WHERE t.id = NEW.tenant_id;
  IF v_stacking IS NOT TRUE
     AND EXISTS (SELECT 1 FROM public.order_discounts d
                 WHERE d.order_id = NEW.order_id AND d.tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'discount stacking is disabled for this tenant: the order already has a discount' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_enforce_discount_stacking ON order_discounts;
CREATE TRIGGER trg_enforce_discount_stacking BEFORE INSERT ON order_discounts
  FOR EACH ROW EXECUTE FUNCTION enforce_discount_stacking();

-- Full structural validation of every discount row (fail-closed on all
-- paths): actor membership, capping, mandatory zero-out escalation, per-user
-- caps for non-escalated rows, coupon availability, and override evidence.
CREATE FUNCTION validate_order_discount() RETURNS trigger LANGUAGE plpgsql AS $$
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
  -- PIN challenge of the SAME initiating actor for the SAME order.
  IF NEW.required_manager_override THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.manager_override_attempts a
      WHERE a.id = NEW.manager_override_attempt_id AND a.tenant_id = NEW.tenant_id
        AND a.outcome = 'succeeded'
        AND a.initiating_actor_user_id = NEW.applied_by
        AND a.order_id = NEW.order_id) THEN
      RAISE EXCEPTION 'escalated discount requires a successful manager-override attempt bound to the same actor and order' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_validate_order_discount ON order_discounts;
CREATE TRIGGER trg_validate_order_discount BEFORE INSERT ON order_discounts
  FOR EACH ROW EXECUTE FUNCTION validate_order_discount();

REVOKE ALL ON coupons, order_discounts FROM PUBLIC;
