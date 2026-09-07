-- Orders are a later phase. This minimal tax-owned anchor provides tenant
-- ownership and preserves external liability now; it is NOT an order table.
-- Its ID is supplied by the order-line writer in the SAME transaction.
CREATE TABLE order_line_tax_contexts (
  order_line_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  branch_id uuid NOT NULL,
  menu_item_id uuid NOT NULL,
  customer_amount_minor bigint NOT NULL CHECK (customer_amount_minor >= 0),
  currency_code text NOT NULL REFERENCES currencies(code),
  sales_channel_code text NOT NULL REFERENCES sales_channels(code),
  delivery_platform_id uuid REFERENCES delivery_platforms(id),
  liability_rule_id uuid NOT NULL REFERENCES tax_liability_rules(id),
  liable_party text NOT NULL CHECK (liable_party IN ('restaurant','marketplace')),
  rounding_strategy text NOT NULL CHECK (rounding_strategy IN ('per_line','invoice_total')),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id),
  FOREIGN KEY (menu_item_id, tenant_id) REFERENCES menu_items(id, tenant_id)
);
CREATE INDEX idx_order_line_tax_contexts_tenant ON order_line_tax_contexts(tenant_id, order_line_id);
ALTER TABLE order_line_tax_contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_line_tax_contexts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON order_line_tax_contexts FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
CREATE TRIGGER trg_order_tax_context_immutable BEFORE UPDATE OR DELETE ON order_line_tax_contexts
  FOR EACH ROW EXECUTE FUNCTION prevent_tax_evidence_mutation();

CREATE TABLE order_line_tax_snapshots (
  order_line_id uuid NOT NULL REFERENCES order_line_tax_contexts(order_line_id),
  tax_rate_id uuid NOT NULL REFERENCES tax_rates(id),
  tax_family text NOT NULL CHECK (tax_family IN ('vat','excise')),
  computation_sequence smallint NOT NULL CHECK (computation_sequence > 0),
  liable_party text NOT NULL DEFAULT 'restaurant' CHECK (liable_party IN ('restaurant','marketplace')),
  rate_bps_snapshot integer NOT NULL CHECK (rate_bps_snapshot BETWEEN 0 AND 10000),
  is_price_inclusive_snapshot boolean NOT NULL,
  taxable_amount_minor bigint NOT NULL CHECK (taxable_amount_minor >= 0),
  tax_amount_minor bigint NOT NULL CHECK (tax_amount_minor >= 0),
  currency_code text NOT NULL REFERENCES currencies(code),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_line_id, tax_rate_id),
  UNIQUE (order_line_id, computation_sequence)
);
CREATE INDEX idx_order_line_tax_snapshots_line ON order_line_tax_snapshots(order_line_id, computation_sequence);
-- Snapshot ownership follows the immutable tax context, never a guessed
-- tenant id. The global reference tables above have no RLS by design.
ALTER TABLE order_line_tax_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_line_tax_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY order_tax_parent_isolation ON order_line_tax_snapshots FOR ALL
  USING (EXISTS (SELECT 1 FROM order_line_tax_contexts c WHERE c.order_line_id = order_line_tax_snapshots.order_line_id))
  WITH CHECK (EXISTS (SELECT 1 FROM order_line_tax_contexts c WHERE c.order_line_id = order_line_tax_snapshots.order_line_id));
CREATE TRIGGER trg_order_tax_snapshot_immutable BEFORE UPDATE OR DELETE ON order_line_tax_snapshots
  FOR EACH ROW EXECUTE FUNCTION prevent_tax_evidence_mutation();

CREATE FUNCTION validate_order_tax_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.order_line_tax_contexts c
    JOIN public.tax_rates r ON r.id = NEW.tax_rate_id
    JOIN public.tax_categories k ON k.id = r.tax_category_id
    WHERE c.order_line_id = NEW.order_line_id AND c.liable_party = 'restaurant' AND NEW.liable_party = 'restaurant'
      AND c.currency_code = NEW.currency_code AND k.tax_family = NEW.tax_family
      AND r.rate_bps = NEW.rate_bps_snapshot AND r.is_price_inclusive_default = NEW.is_price_inclusive_snapshot) THEN
    RAISE EXCEPTION 'tax snapshot must match rate, currency and restaurant liability context' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_validate_order_tax_snapshot BEFORE INSERT ON order_line_tax_snapshots
  FOR EACH ROW EXECUTE FUNCTION validate_order_tax_snapshot();
REVOKE ALL ON order_line_tax_contexts, order_line_tax_snapshots FROM PUBLIC;

-- Defend the context itself: an app cannot label a marketplace rule as a
-- restaurant rule, nor use net proceeds in a different currency/branch.
CREATE FUNCTION validate_order_tax_context() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.branches b JOIN public.tenants t ON t.id = b.tenant_id
      JOIN public.tax_jurisdictions j ON j.country_code = b.country_code
      JOIN public.tax_liability_rules r ON r.id = NEW.liability_rule_id
      JOIN public.sales_channels ch ON ch.code = NEW.sales_channel_code
    WHERE b.id = NEW.branch_id AND b.tenant_id = NEW.tenant_id AND b.is_active AND j.is_active
      AND b.base_currency = NEW.currency_code AND j.rounding_strategy = NEW.rounding_strategy
      AND r.country_code = b.country_code AND r.sales_channel_code = NEW.sales_channel_code
      AND r.liable_party = NEW.liable_party
      AND r.applies_when_tenant_registered = (t.vat_registration_status = 'registered')
      AND (r.delivery_platform_id IS NULL OR r.delivery_platform_id = NEW.delivery_platform_id)
      AND ch.requires_delivery_platform = (NEW.delivery_platform_id IS NOT NULL)
      AND r.effective_from <= (NEW.occurred_at AT TIME ZONE b.timezone)::date
      AND (r.effective_to IS NULL OR r.effective_to >= (NEW.occurred_at AT TIME ZONE b.timezone)::date)
  ) THEN
    RAISE EXCEPTION 'tax context must match branch, currency, channel and applicable liability rule' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_validate_order_tax_context BEFORE INSERT ON order_line_tax_contexts
  FOR EACH ROW EXECUTE FUNCTION validate_order_tax_context();

CREATE FUNCTION require_complete_order_tax_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.liable_party = 'restaurant') IS DISTINCT FROM EXISTS (
    SELECT 1 FROM public.order_line_tax_snapshots WHERE order_line_id = NEW.order_line_id) THEN
    RAISE EXCEPTION 'restaurant context requires tax snapshots; marketplace context forbids them' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER trg_complete_order_tax_evidence AFTER INSERT ON order_line_tax_contexts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_complete_order_tax_evidence();
