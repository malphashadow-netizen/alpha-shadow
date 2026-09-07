CREATE TABLE branch_tax_category_overrides (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  branch_id uuid NOT NULL,
  menu_item_tax_category_id uuid NOT NULL REFERENCES tax_categories(id),
  override_tax_category_id uuid NOT NULL REFERENCES tax_categories(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, branch_id, menu_item_tax_category_id),
  FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id),
  CHECK (menu_item_tax_category_id <> override_tax_category_id)
);
ALTER TABLE branch_tax_category_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE branch_tax_category_overrides FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON branch_tax_category_overrides FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE FUNCTION validate_branch_tax_override() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE branch_country char(2); target public.tax_categories; source public.tax_categories;
BEGIN
  SELECT country_code INTO branch_country FROM public.branches
    WHERE id = NEW.branch_id AND tenant_id = NEW.tenant_id FOR SHARE;
  SELECT * INTO target FROM public.tax_categories WHERE id = NEW.override_tax_category_id;
  SELECT * INTO source FROM public.tax_categories WHERE id = NEW.menu_item_tax_category_id;
  IF branch_country IS NULL OR target.country_code IS DISTINCT FROM branch_country THEN
    RAISE EXCEPTION 'override tax category country must match branch country' USING ERRCODE = '23514';
  END IF;
  -- A branch override may adjust a family, never silently introduce excise.
  IF source.tax_family IS DISTINCT FROM target.tax_family OR NOT target.is_active THEN
    RAISE EXCEPTION 'override must use an active category in the same tax family' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_validate_branch_tax_override BEFORE INSERT OR UPDATE ON branch_tax_category_overrides
  FOR EACH ROW EXECUTE FUNCTION validate_branch_tax_override();

CREATE FUNCTION guard_branch_tax_country_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.country_code IS DISTINCT FROM OLD.country_code AND EXISTS (
    SELECT 1 FROM public.branch_tax_category_overrides o JOIN public.tax_categories c ON c.id = o.override_tax_category_id
      WHERE o.branch_id = OLD.id AND c.country_code IS DISTINCT FROM NEW.country_code) THEN
    RAISE EXCEPTION 'branch country change would invalidate tax overrides' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_branch_tax_country_change BEFORE UPDATE OF country_code ON branches
  FOR EACH ROW EXECUTE FUNCTION guard_branch_tax_country_change();
