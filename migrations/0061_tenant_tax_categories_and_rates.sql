-- Migration 0061 — tenant-owned tax categories and effective-dated rates.
-- Platform tax reference tables and their administration path remain unchanged.

CREATE TABLE tenant_tax_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  country_code char(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  code text NOT NULL CHECK (btrim(code) <> ''),
  kind text NOT NULL CHECK (kind IN ('standard','reduced','zero_rated','exempt','no_vat')),
  tax_family text NOT NULL DEFAULT 'vat' CHECK (tax_family IN ('vat','excise')),
  cascade_priority smallint NOT NULL DEFAULT 50,
  name jsonb NOT NULL CHECK (jsonb_typeof(name) = 'object'),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, code),
  CHECK (kind <> 'no_vat' OR tax_family = 'vat')
);

ALTER TABLE tenant_tax_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_tax_categories FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_tax_categories FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE tenant_tax_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  tax_category_id uuid NOT NULL,
  rate_bps integer NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
  is_price_inclusive_default boolean NOT NULL,
  effective_from date NOT NULL CHECK (isfinite(effective_from)),
  effective_to date CHECK (isfinite(effective_to)),
  superseded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_tax_rates_category_tenant_fkey
    FOREIGN KEY (tax_category_id, tenant_id)
    REFERENCES tenant_tax_categories(id, tenant_id),
  CONSTRAINT tenant_tax_rates_superseded_by_fkey FOREIGN KEY (superseded_by)
    REFERENCES tenant_tax_rates(id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (superseded_by IS NULL OR (superseded_by <> id AND effective_to IS NOT NULL)),
  CONSTRAINT tenant_tax_rates_no_overlap EXCLUDE USING gist (
    tax_category_id WITH =,
    daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[]') WITH &&
  )
);

ALTER TABLE tenant_tax_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_tax_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_tax_rates FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE FUNCTION enforce_tenant_no_vat_zero_rate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE category_kind text;
BEGIN
  SELECT kind INTO category_kind FROM public.tenant_tax_categories
    WHERE id = NEW.tax_category_id AND tenant_id = NEW.tenant_id;
  IF category_kind = 'no_vat' AND (NEW.rate_bps <> 0 OR NEW.effective_to IS NOT NULL OR NEW.superseded_by IS NOT NULL) THEN
    RAISE EXCEPTION 'no_vat category must have rate_bps = 0 and no effective_to or successor' USING ERRCODE = '23514';
  END IF;
  IF category_kind IN ('zero_rated','exempt') AND NEW.rate_bps <> 0 THEN
    RAISE EXCEPTION 'zero_rated and exempt categories must have rate_bps = 0' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_enforce_tenant_no_vat_zero_rate BEFORE INSERT OR UPDATE ON tenant_tax_rates
  FOR EACH ROW EXECUTE FUNCTION enforce_tenant_no_vat_zero_rate();

CREATE FUNCTION create_tenant_tax_rate(p_tenant uuid, p_category uuid, p_bps integer,
  p_inclusive boolean, p_from date, p_to date) RETURNS tenant_tax_rates
LANGUAGE plpgsql AS $$
DECLARE result public.tenant_tax_rates; context_tenant uuid;
BEGIN
  context_tenant := current_setting('app.current_tenant_id')::uuid;
  IF p_tenant IS DISTINCT FROM context_tenant THEN
    RAISE EXCEPTION 'tenant tax rate tenant_id must match the current tenant context' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.tenant_tax_rates(tenant_id, tax_category_id, rate_bps, is_price_inclusive_default, effective_from, effective_to)
    VALUES (p_tenant, p_category, p_bps, p_inclusive, p_from, p_to) RETURNING * INTO result;
  RETURN result;
END;
$$;

CREATE FUNCTION close_and_supersede_tenant_tax_rate(p_tenant uuid, p_id uuid, p_bps integer,
  p_inclusive boolean, p_from date) RETURNS tenant_tax_rates
LANGUAGE plpgsql AS $$
DECLARE context_tenant uuid; previous public.tenant_tax_rates; result public.tenant_tax_rates; next_id uuid := gen_random_uuid();
BEGIN
  context_tenant := current_setting('app.current_tenant_id')::uuid;
  IF p_tenant IS DISTINCT FROM context_tenant THEN
    RAISE EXCEPTION 'tenant tax rate tenant_id must match the current tenant context' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO previous FROM public.tenant_tax_rates
    WHERE id = p_id AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tenant tax rate not found' USING ERRCODE = 'P0002'; END IF;
  IF previous.superseded_by IS NOT NULL THEN
    RAISE EXCEPTION 'tenant tax rate already superseded' USING ERRCODE = '55006';
  END IF;
  IF p_from IS NULL OR NOT isfinite(p_from) OR p_from <= previous.effective_from OR
    (previous.effective_to IS NOT NULL AND p_from > previous.effective_to) THEN
    RAISE EXCEPTION 'successor date must split the existing effective period' USING ERRCODE = '23514';
  END IF;
  UPDATE public.tenant_tax_rates SET effective_to = p_from - 1, superseded_by = next_id
    WHERE id = p_id AND tenant_id = p_tenant;
  INSERT INTO public.tenant_tax_rates(id, tenant_id, tax_category_id, rate_bps,
    is_price_inclusive_default, effective_from, effective_to)
    VALUES (next_id, p_tenant, previous.tax_category_id, p_bps, p_inclusive, p_from, previous.effective_to)
    RETURNING * INTO result;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION create_tenant_tax_rate(uuid, uuid, integer, boolean, date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION close_and_supersede_tenant_tax_rate(uuid, uuid, integer, boolean, date) FROM PUBLIC;
REVOKE ALL ON tenant_tax_categories, tenant_tax_rates FROM PUBLIC;
