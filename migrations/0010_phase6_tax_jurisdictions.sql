-- Phase 6: platform reference data. NO tenant_id and NO RLS on tax registries.
-- Rates use closed date intervals; consecutive versions meet at end + 1 day.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE tax_jurisdictions (
  country_code char(2) PRIMARY KEY CHECK (country_code ~ '^[A-Z]{2}$'),
  name jsonb NOT NULL CHECK (jsonb_typeof(name) = 'object'),
  default_currency_code text NOT NULL REFERENCES currencies(code),
  rounding_strategy text NOT NULL DEFAULT 'per_line'
    CHECK (rounding_strategy IN ('per_line', 'invoice_total')),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tax_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code char(2) NOT NULL REFERENCES tax_jurisdictions(country_code),
  code text NOT NULL CHECK (btrim(code) <> ''),
  kind text NOT NULL CHECK (kind IN ('standard','reduced','zero_rated','exempt','no_vat')),
  tax_family text NOT NULL DEFAULT 'vat' CHECK (tax_family IN ('vat','excise')),
  cascade_priority smallint NOT NULL DEFAULT 50,
  name jsonb NOT NULL CHECK (jsonb_typeof(name) = 'object'),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (country_code, code),
  CHECK (kind <> 'no_vat' OR tax_family = 'vat')
);

CREATE TABLE tax_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_category_id uuid NOT NULL REFERENCES tax_categories(id),
  rate_bps integer NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
  is_price_inclusive_default boolean NOT NULL,
  effective_from date NOT NULL CHECK (isfinite(effective_from)),
  effective_to date CHECK (isfinite(effective_to)),
  superseded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tax_rates_superseded_by_fkey FOREIGN KEY (superseded_by)
    REFERENCES tax_rates(id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (superseded_by IS NULL OR (superseded_by <> id AND effective_to IS NOT NULL)),
  CONSTRAINT tax_rates_no_overlap EXCLUDE USING gist (
    tax_category_id WITH =,
    daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[]') WITH &&
  )
);
CREATE INDEX idx_tax_rates_category_effective ON tax_rates(tax_category_id, effective_from);

CREATE FUNCTION enforce_no_vat_zero_rate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE category_kind text;
BEGIN
  SELECT kind INTO category_kind FROM public.tax_categories WHERE id = NEW.tax_category_id;
  IF category_kind = 'no_vat' AND (NEW.rate_bps <> 0 OR NEW.effective_to IS NOT NULL OR NEW.superseded_by IS NOT NULL) THEN
    RAISE EXCEPTION 'no_vat category must have rate_bps = 0 and no effective_to or successor' USING ERRCODE = '23514';
  END IF;
  IF category_kind IN ('zero_rated','exempt') AND NEW.rate_bps <> 0 THEN
    RAISE EXCEPTION 'zero_rated and exempt categories must have rate_bps = 0' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_enforce_no_vat_zero_rate BEFORE INSERT OR UPDATE ON tax_rates
  FOR EACH ROW EXECUTE FUNCTION enforce_no_vat_zero_rate();

-- Structural identity is immutable: changing kind/family/country behind an
-- existing assignment could bypass no_vat, excise consent or country guards.
CREATE FUNCTION guard_tax_category_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.country_code, NEW.code, NEW.kind, NEW.tax_family, NEW.cascade_priority, NEW.created_at)
    IS DISTINCT FROM (OLD.id, OLD.country_code, OLD.code, OLD.kind, OLD.tax_family, OLD.cascade_priority, OLD.created_at) THEN
    RAISE EXCEPTION 'tax category identity is immutable; create a new category' USING ERRCODE = '55006';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_tax_category_identity BEFORE UPDATE ON tax_categories
  FOR EACH ROW EXECUTE FUNCTION guard_tax_category_identity();

CREATE FUNCTION assert_platform_tax_context() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NULLIF(current_setting('app.current_tenant_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'platform tax writes cannot run in a tenant context' USING ERRCODE = '42501';
  END IF;
END;
$$;
CREATE FUNCTION guard_platform_tax_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.assert_platform_tax_context();
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_platform_jurisdiction_write BEFORE INSERT OR UPDATE OR DELETE ON tax_jurisdictions
  FOR EACH ROW EXECUTE FUNCTION guard_platform_tax_write();
CREATE TRIGGER trg_platform_category_write BEFORE INSERT OR UPDATE OR DELETE ON tax_categories
  FOR EACH ROW EXECUTE FUNCTION guard_platform_tax_write();
CREATE TRIGGER trg_platform_rate_write BEFORE INSERT OR UPDATE OR DELETE ON tax_rates
  FOR EACH ROW EXECUTE FUNCTION guard_platform_tax_write();

-- Extend (do NOT replace) Phase-4 audit_log for platform evidence. Never invent
-- a tenant to own global changes. Existing tenant row isolation is retained.
ALTER TABLE audit_log ADD COLUMN scope text NOT NULL DEFAULT 'tenant'
  CHECK (scope IN ('tenant','platform_tax'));
ALTER TABLE audit_log ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_scope_owner CHECK (
  (scope = 'tenant' AND tenant_id IS NOT NULL) OR
  (scope = 'platform_tax' AND tenant_id IS NULL)
);
-- A global platform operation has NO tenant GUC. Missing-safe equality keeps
-- tenant rows invisible (NULL = tenant_id is never true) without inventing a
-- tenant UUID or throwing while PostgreSQL evaluates the global-row policy.
ALTER POLICY tenant_isolation ON audit_log
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
CREATE POLICY platform_tax_audit ON audit_log FOR ALL
  USING (scope = 'platform_tax' AND tenant_id IS NULL AND
    (current_user = 'platform_tax_admin' OR current_user =
      pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.audit_log'::regclass))))
  WITH CHECK (scope = 'platform_tax' AND tenant_id IS NULL AND
    (current_user = 'platform_tax_admin' OR current_user =
      pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.audit_log'::regclass))));

-- This DB backstop also audits privileged SQL/initial reference seeding.
-- Only fixed tax-rate columns are serialized (no user objects/secrets).
CREATE FUNCTION audit_tax_rate_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  INSERT INTO public.audit_log(scope, tenant_id, user_id, action, resource, "before", "after")
  VALUES ('platform_tax', NULL, NULLIF(current_setting('app.platform_tax_actor_id', true), '')::uuid,
    CASE WHEN TG_OP = 'INSERT' THEN 'tax_rate:create' ELSE 'tax_rate:close_and_supersede' END,
    'tax_rates:' || NEW.id::text,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END, to_jsonb(NEW));
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_audit_tax_rate_change AFTER INSERT OR UPDATE ON tax_rates
  FOR EACH ROW EXECUTE FUNCTION audit_tax_rate_change();

CREATE FUNCTION guard_tax_rate_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tax rates are historical evidence; deletion is forbidden' USING ERRCODE = '55006';
  END IF;
  IF (to_jsonb(NEW) - 'effective_to' - 'superseded_by') IS DISTINCT FROM
     (to_jsonb(OLD) - 'effective_to' - 'superseded_by') OR
     OLD.superseded_by IS NOT NULL OR NEW.superseded_by IS NULL OR NEW.effective_to IS NULL OR
     (OLD.effective_to IS NOT NULL AND NEW.effective_to >= OLD.effective_to) THEN
    RAISE EXCEPTION 'tax rates may only closeAndSupersede; direct update is forbidden' USING ERRCODE = '55006';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_tax_rate_history BEFORE UPDATE OR DELETE ON tax_rates
  FOR EACH ROW EXECUTE FUNCTION guard_tax_rate_history();

CREATE FUNCTION validate_tax_rate_successor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tax_rates r WHERE r.id = NEW.superseded_by
    AND r.tax_category_id = NEW.tax_category_id AND r.effective_from = NEW.effective_to + 1) THEN
    RAISE EXCEPTION 'successor must be the same category and start the day after closure' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER trg_tax_rate_successor AFTER UPDATE ON tax_rates
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_tax_rate_successor();

-- app_login cannot execute either function. platform_tax_admin has EXECUTE,
-- never INSERT/UPDATE/DELETE on rates. Both writes + their audit share the TX.
CREATE FUNCTION create_tax_rate(p_category uuid, p_bps integer, p_inclusive boolean,
  p_from date, p_to date, p_actor uuid) RETURNS tax_rates
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE result public.tax_rates;
BEGIN
  PERFORM public.assert_platform_tax_context();
  IF p_actor IS NULL THEN RAISE EXCEPTION 'platform actor is required' USING ERRCODE = '23514'; END IF;
  PERFORM set_config('app.platform_tax_actor_id', p_actor::text, true);
  INSERT INTO public.tax_rates(tax_category_id, rate_bps, is_price_inclusive_default, effective_from, effective_to)
    VALUES (p_category, p_bps, p_inclusive, p_from, p_to) RETURNING * INTO result;
  RETURN result;
END;
$$;
CREATE FUNCTION close_and_supersede_tax_rate(p_id uuid, p_bps integer,
  p_inclusive boolean, p_from date, p_actor uuid) RETURNS tax_rates
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE previous public.tax_rates; result public.tax_rates; next_id uuid := gen_random_uuid();
BEGIN
  PERFORM public.assert_platform_tax_context();
  IF p_actor IS NULL THEN RAISE EXCEPTION 'platform actor is required' USING ERRCODE = '23514'; END IF;
  PERFORM set_config('app.platform_tax_actor_id', p_actor::text, true);
  SELECT * INTO previous FROM public.tax_rates WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tax rate not found' USING ERRCODE = 'P0002'; END IF;
  IF previous.superseded_by IS NOT NULL THEN
    RAISE EXCEPTION 'tax rate already superseded' USING ERRCODE = '55006';
  END IF;
  IF p_from IS NULL OR NOT isfinite(p_from) OR p_from <= previous.effective_from OR
    (previous.effective_to IS NOT NULL AND p_from > previous.effective_to) THEN
    RAISE EXCEPTION 'successor date must split the existing effective period' USING ERRCODE = '23514';
  END IF;
  UPDATE public.tax_rates SET effective_to = p_from - 1, superseded_by = next_id WHERE id = p_id;
  INSERT INTO public.tax_rates(id, tax_category_id, rate_bps, is_price_inclusive_default, effective_from, effective_to)
    VALUES (next_id, previous.tax_category_id, p_bps, p_inclusive, p_from, previous.effective_to)
    RETURNING * INTO result;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION create_tax_rate(uuid, integer, boolean, date, date, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION close_and_supersede_tax_rate(uuid, integer, boolean, date, uuid) FROM PUBLIC;
REVOKE ALL ON tax_jurisdictions, tax_categories, tax_rates FROM PUBLIC;

-- User-specified launch configuration, effective from deployment baseline,
-- NOT a claim of historical legal coverage. Default prices are exclusive.
-- Historical intervals and legally reviewed marketplace rules are provisioned
-- explicitly by platform administration. No product is automatically linked.
INSERT INTO tax_jurisdictions(country_code, name, default_currency_code) VALUES
  ('SA', '{"ar":"السعودية","en":"Saudi Arabia"}', 'SAR'),
  ('EG', '{"ar":"مصر","en":"Egypt"}', 'EGP'),
  ('AE', '{"ar":"الإمارات","en":"United Arab Emirates"}', 'AED'),
  ('KW', '{"ar":"الكويت","en":"Kuwait"}', 'KWD')
ON CONFLICT (country_code) DO NOTHING;
INSERT INTO tax_categories(id, country_code, code, kind, tax_family, cascade_priority, name) VALUES
  ('61000000-0000-4000-8000-000000000001', 'SA', 'standard', 'standard', 'vat', 50, '{"ar":"ضريبة القيمة المضافة","en":"Standard VAT"}'),
  ('61000000-0000-4000-8000-000000000002', 'SA', 'excise_100', 'standard', 'excise', 10, '{"ar":"انتقائية 100% — تتطلب تأكيد المصنع/المستورد","en":"Excise 100% — manufacturer/importer confirmation required"}'),
  ('61000000-0000-4000-8000-000000000003', 'EG', 'standard', 'standard', 'vat', 50, '{"ar":"قيمة مضافة عامة","en":"Standard VAT"}'),
  ('61000000-0000-4000-8000-000000000004', 'EG', 'reduced', 'reduced', 'vat', 50, '{"ar":"قيمة مضافة مخفضة","en":"Reduced VAT"}'),
  ('61000000-0000-4000-8000-000000000005', 'EG', 'zero_rated', 'zero_rated', 'vat', 50, '{"ar":"نسبة صفرية","en":"Zero-rated"}'),
  ('61000000-0000-4000-8000-000000000006', 'EG', 'exempt', 'exempt', 'vat', 50, '{"ar":"معفى","en":"Exempt"}'),
  ('61000000-0000-4000-8000-000000000007', 'AE', 'standard', 'standard', 'vat', 50, '{"ar":"قيمة مضافة عامة","en":"Standard VAT"}'),
  ('61000000-0000-4000-8000-000000000008', 'AE', 'zero_rated', 'zero_rated', 'vat', 50, '{"ar":"نسبة صفرية","en":"Zero-rated"}'),
  ('61000000-0000-4000-8000-000000000009', 'KW', 'no_vat', 'no_vat', 'vat', 50, '{"ar":"لا ضريبة قيمة مضافة","en":"No VAT"}')
ON CONFLICT (country_code, code) DO NOTHING;
INSERT INTO tax_rates(tax_category_id, rate_bps, is_price_inclusive_default, effective_from)
  SELECT c.id, v.bps, false, DATE '2026-09-07' FROM (VALUES
    ('SA','standard',1500), ('SA','excise_100',10000), ('EG','standard',1400),
    ('EG','reduced',500), ('EG','zero_rated',0), ('EG','exempt',0),
    ('AE','standard',500), ('AE','zero_rated',0), ('KW','no_vat',0)
  ) AS v(country_code, code, bps) JOIN tax_categories c
    ON c.country_code = v.country_code AND c.code = v.code
ON CONFLICT DO NOTHING;
