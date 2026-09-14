-- Migration 0063 — bridge between platform tax categories and tenant-owned
-- tax rates, and dual-source order tax evidence. No existing migration is
-- modified; the platform tax path and menu_items.tax_rule_id FK are untouched.

ALTER TABLE tenant_tax_categories
  ADD COLUMN platform_category_id uuid REFERENCES tax_categories(id);
CREATE UNIQUE INDEX uq_tenant_tax_categories_platform_link
  ON tenant_tax_categories(tenant_id, platform_category_id)
  WHERE platform_category_id IS NOT NULL;

-- Step order matters: drop the old primary key BEFORE altering tax_rate_id,
-- because a column that is part of a primary key cannot have its
-- NOT NULL/other properties changed while still part of that key.
ALTER TABLE order_line_tax_snapshots DROP CONSTRAINT order_line_tax_snapshots_pkey;

ALTER TABLE order_line_tax_snapshots
  ALTER COLUMN tax_rate_id DROP NOT NULL,
  ADD COLUMN tenant_tax_rate_id uuid REFERENCES tenant_tax_rates(id),
  ADD CONSTRAINT order_line_tax_snapshots_single_source CHECK (
    (tax_rate_id IS NOT NULL AND tenant_tax_rate_id IS NULL) OR
    (tax_rate_id IS NULL AND tenant_tax_rate_id IS NOT NULL)
  );

ALTER TABLE order_line_tax_snapshots
  ADD PRIMARY KEY (order_line_id, computation_sequence);

CREATE OR REPLACE FUNCTION validate_order_tax_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tax_rate_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.order_line_tax_contexts c
      JOIN public.tax_rates r ON r.id = NEW.tax_rate_id
      JOIN public.tax_categories k ON k.id = r.tax_category_id
      WHERE c.order_line_id = NEW.order_line_id AND c.liable_party = 'restaurant' AND NEW.liable_party = 'restaurant'
        AND c.currency_code = NEW.currency_code AND k.tax_family = NEW.tax_family
        AND r.rate_bps = NEW.rate_bps_snapshot AND r.is_price_inclusive_default = NEW.is_price_inclusive_snapshot) THEN
      RAISE EXCEPTION 'tax snapshot must match rate, currency and restaurant liability context' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.order_line_tax_contexts c
      JOIN public.tenant_tax_rates r ON r.id = NEW.tenant_tax_rate_id
      JOIN public.tenant_tax_categories k ON k.id = r.tax_category_id AND k.tenant_id = r.tenant_id
      WHERE c.order_line_id = NEW.order_line_id AND c.liable_party = 'restaurant' AND NEW.liable_party = 'restaurant'
        AND c.tenant_id = r.tenant_id AND c.currency_code = NEW.currency_code AND k.tax_family = NEW.tax_family
        AND r.rate_bps = NEW.rate_bps_snapshot AND r.is_price_inclusive_default = NEW.is_price_inclusive_snapshot) THEN
      RAISE EXCEPTION 'tenant tax snapshot must match tenant rate, currency and restaurant liability context' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
