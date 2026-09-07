-- All channels, marketplaces and legal liability decisions are DATA.
CREATE TABLE sales_channels (
  code text PRIMARY KEY CHECK (btrim(code) <> ''),
  name jsonb NOT NULL CHECK (jsonb_typeof(name) = 'object'),
  requires_delivery_platform boolean NOT NULL DEFAULT false
);
CREATE TABLE delivery_platforms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (btrim(code) <> ''),
  name jsonb NOT NULL CHECK (jsonb_typeof(name) = 'object'),
  country_code char(2) REFERENCES tax_jurisdictions(country_code),
  is_active boolean NOT NULL DEFAULT true
);
CREATE TABLE tax_liability_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code char(2) NOT NULL REFERENCES tax_jurisdictions(country_code),
  sales_channel_code text NOT NULL REFERENCES sales_channels(code),
  delivery_platform_id uuid REFERENCES delivery_platforms(id),
  applies_when_tenant_registered boolean NOT NULL,
  liable_party text NOT NULL CHECK (liable_party IN ('restaurant','marketplace')),
  effective_from date NOT NULL CHECK (isfinite(effective_from)),
  effective_to date CHECK (isfinite(effective_to)),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  UNIQUE NULLS NOT DISTINCT (country_code, sales_channel_code, delivery_platform_id, applies_when_tenant_registered, effective_from),
  -- Separate wildcard and exact-platform periods. An exact rule has priority
  -- over an EXPLICIT wildcard; absence of both never means restaurant/zero.
  EXCLUDE USING gist (country_code WITH =, sales_channel_code WITH =,
    delivery_platform_id WITH =, applies_when_tenant_registered WITH =,
    daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[]') WITH &&)
    WHERE (delivery_platform_id IS NOT NULL),
  EXCLUDE USING gist (country_code WITH =, sales_channel_code WITH =,
    applies_when_tenant_registered WITH =,
    daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[]') WITH &&)
    WHERE (delivery_platform_id IS NULL)
);
CREATE INDEX idx_tax_liability_lookup ON tax_liability_rules
  (country_code, sales_channel_code, applies_when_tenant_registered, effective_from);

CREATE FUNCTION validate_tax_liability_rule() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE platform_country char(2); requires_platform boolean;
BEGIN
  SELECT requires_delivery_platform INTO requires_platform FROM public.sales_channels WHERE code = NEW.sales_channel_code;
  IF NEW.delivery_platform_id IS NOT NULL THEN
    SELECT country_code INTO platform_country FROM public.delivery_platforms WHERE id = NEW.delivery_platform_id;
    IF requires_platform = false OR (platform_country IS NOT NULL AND platform_country <> NEW.country_code) THEN
      RAISE EXCEPTION 'liability rule platform does not match channel/country' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.liable_party = 'marketplace' AND requires_platform = false THEN
    RAISE EXCEPTION 'marketplace liability requires a platform channel' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_tax_liability_rule BEFORE INSERT OR UPDATE ON tax_liability_rules
  FOR EACH ROW EXECUTE FUNCTION validate_tax_liability_rule();
CREATE TRIGGER trg_platform_channel_write BEFORE INSERT OR UPDATE OR DELETE ON sales_channels
  FOR EACH ROW EXECUTE FUNCTION guard_platform_tax_write();
CREATE TRIGGER trg_platform_delivery_write BEFORE INSERT OR UPDATE OR DELETE ON delivery_platforms
  FOR EACH ROW EXECUTE FUNCTION guard_platform_tax_write();
CREATE TRIGGER trg_platform_liability_write BEFORE INSERT OR UPDATE OR DELETE ON tax_liability_rules
  FOR EACH ROW EXECUTE FUNCTION guard_platform_tax_write();
REVOKE ALL ON sales_channels, delivery_platforms, tax_liability_rules FROM PUBLIC;

INSERT INTO sales_channels(code, name, requires_delivery_platform) VALUES
  ('dine_in','{"ar":"طاولات","en":"Dine in"}',false),
  ('takeaway','{"ar":"سفري","en":"Takeaway"}',false),
  ('delivery_app','{"ar":"توصيل تطبيقات","en":"Delivery platform"}',true),
  ('own_delivery','{"ar":"توصيل الفرع","en":"Own delivery"}',false)
ON CONFLICT (code) DO NOTHING;
-- NULL country means an unscoped registry entry, NOT a legal liability rule.
INSERT INTO delivery_platforms(code, name) VALUES
  ('talabat','{"ar":"طلبات","en":"Talabat"}'), ('jahez','{"ar":"جاهز","en":"Jahez"}'),
  ('hungerstation','{"ar":"هنقرستيشن","en":"HungerStation"}'), ('keeta','{"ar":"كيتا","en":"Keeta"}'),
  ('careem_food','{"ar":"كريم فود","en":"Careem Food"}'), ('toyou','{"ar":"تويو","en":"ToYou"}'),
  ('mrsool','{"ar":"مرسول","en":"Mrsool"}')
ON CONFLICT (code) DO NOTHING;
-- Never guess deemed-supplier law. delivery_app has NO seeded liability rule.
-- Non-platform sales by registered tenants: restaurant is the supplier.
INSERT INTO tax_liability_rules(country_code, sales_channel_code, applies_when_tenant_registered, liable_party, effective_from)
  SELECT j.country_code, c.code, true, 'restaurant', DATE '2026-09-07'
    FROM tax_jurisdictions j CROSS JOIN sales_channels c WHERE NOT c.requires_delivery_platform
ON CONFLICT DO NOTHING;
-- Explicit no-VAT launch data for unregistered tenants (not an engine branch).
INSERT INTO tax_liability_rules(country_code, sales_channel_code, applies_when_tenant_registered, liable_party, effective_from)
  SELECT 'KW', c.code, false, 'restaurant', DATE '2026-09-07'
    FROM sales_channels c WHERE NOT c.requires_delivery_platform
ON CONFLICT DO NOTHING;
