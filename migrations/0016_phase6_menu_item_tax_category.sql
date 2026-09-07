-- Keep the Phase-5 column name. Invalid legacy UUIDs deliberately abort FK
-- validation: reconcile them explicitly; never silently drop/replace values.
ALTER TABLE menu_items ADD CONSTRAINT menu_items_tax_rule_id_fkey
  FOREIGN KEY (tax_rule_id) REFERENCES tax_categories(id);

CREATE TABLE menu_item_additional_tax_categories (
  menu_item_id uuid NOT NULL REFERENCES menu_items(id),
  tax_category_id uuid NOT NULL REFERENCES tax_categories(id),
  PRIMARY KEY (menu_item_id, tax_category_id)
);
-- No duplicated tenant_id: inherit ownership through the RLS-protected parent.
ALTER TABLE menu_item_additional_tax_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_item_additional_tax_categories FORCE ROW LEVEL SECURITY;
CREATE POLICY menu_item_tax_parent_isolation ON menu_item_additional_tax_categories FOR ALL
  USING (EXISTS (SELECT 1 FROM menu_items m WHERE m.id = menu_item_id))
  WITH CHECK (EXISTS (SELECT 1 FROM menu_items m WHERE m.id = menu_item_id));

-- Procedural evidence, NOT automatic classification by SKU/name/category.
-- Only the dedicated confirmed administrative functions may INSERT evidence.
CREATE TABLE menu_item_excise_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  menu_item_id uuid NOT NULL,
  tax_category_id uuid NOT NULL REFERENCES tax_categories(id),
  branch_id uuid,
  confirmed_by uuid NOT NULL REFERENCES users(id),
  confirmation_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (menu_item_id, tenant_id) REFERENCES menu_items(id, tenant_id),
  FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id)
);
CREATE INDEX idx_excise_confirmation_lookup ON menu_item_excise_confirmations
  (tenant_id, menu_item_id, tax_category_id, branch_id);
ALTER TABLE menu_item_excise_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_item_excise_confirmations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON menu_item_excise_confirmations FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE FUNCTION prevent_tax_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable: % is forbidden', TG_TABLE_NAME, TG_OP USING ERRCODE = '55006';
END;
$$;
CREATE TRIGGER trg_excise_confirmation_immutable BEFORE UPDATE OR DELETE ON menu_item_excise_confirmations
  FOR EACH ROW EXECUTE FUNCTION prevent_tax_evidence_mutation();

-- Definer functions retain the caller's tenant GUC; FORCE RLS still applies.
-- They additionally check active membership and a tenant-wide atomic grant.
CREATE FUNCTION assert_tenant_tax_permission(p_actor uuid, p_permission text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE tid uuid := current_setting('app.current_tenant_id')::uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users u
      JOIN public.tenants t ON t.id = u.tenant_id
      JOIN public.user_roles ur ON ur.user_id = u.id AND ur.tenant_id = u.tenant_id
      JOIN public.roles r ON r.id = ur.role_id AND r.tenant_id = ur.tenant_id
      JOIN public.role_permissions rp ON rp.role_id = r.id AND rp.tenant_id = r.tenant_id
    WHERE u.id = p_actor AND u.tenant_id = tid AND u.is_active AND t.status = 'active'
      AND ur.is_active AND ur.scope_type = 'tenant' AND ur.scope_id IS NULL
      AND rp.permission_key = p_permission
  ) THEN
    RAISE EXCEPTION 'active tenant administrator permission is required' USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE FUNCTION assert_excise_confirmation(p_confirmation text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_confirmation IS DISTINCT FROM 'أنا مُصنِّع/مستورد هذا المنتج ومسجَّل ضريبيًا للإنتاج الانتقائي' THEN
    RAISE EXCEPTION 'explicit manufacturer/importer excise registration confirmation is required' USING ERRCODE = '42501';
  END IF;
END;
$$;

-- Ordinary app-role SQL cannot attach excise even after earlier confirmation.
-- Only the dedicated SECURITY DEFINER operation (or trusted schema DBA) can.
CREATE FUNCTION guard_menu_tax_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target public.tax_categories; item_id uuid; category_id uuid; primary_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'menu_items' THEN
    IF TG_OP = 'UPDATE' AND NEW.tax_rule_id IS NOT DISTINCT FROM OLD.tax_rule_id THEN RETURN NEW; END IF;
    category_id := NEW.tax_rule_id; item_id := NEW.id;
    IF category_id IS NULL THEN RETURN NEW; END IF;
    IF EXISTS (SELECT 1 FROM public.menu_item_additional_tax_categories
      WHERE menu_item_id = item_id AND tax_category_id = category_id) THEN
      RAISE EXCEPTION 'tax category is already an additional assignment' USING ERRCODE = '23514';
    END IF;
  ELSE
    category_id := NEW.tax_category_id; item_id := NEW.menu_item_id;
    SELECT tax_rule_id INTO primary_id FROM public.menu_items WHERE id = item_id FOR UPDATE;
    IF primary_id = category_id THEN
      RAISE EXCEPTION 'tax category is already the primary assignment' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT * INTO target FROM public.tax_categories WHERE id = category_id;
  IF NOT FOUND OR NOT target.is_active THEN
    RAISE EXCEPTION 'active tax category is required' USING ERRCODE = '23514';
  END IF;
  IF target.tax_family = 'excise' AND current_user <>
    pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.menu_items'::regclass)) THEN
    RAISE EXCEPTION 'excise assignment requires the dedicated confirmed administrative path' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_guard_menu_tax_assignment BEFORE INSERT OR UPDATE OF tax_rule_id ON menu_items
  FOR EACH ROW EXECUTE FUNCTION guard_menu_tax_assignment();
CREATE TRIGGER trg_guard_additional_tax_assignment BEFORE INSERT OR UPDATE ON menu_item_additional_tax_categories
  FOR EACH ROW EXECUTE FUNCTION guard_menu_tax_assignment();

CREATE FUNCTION guard_excise_override_path() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.tax_categories WHERE id = NEW.override_tax_category_id AND tax_family = 'excise')
    AND current_user <> pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.menu_items'::regclass)) THEN
    RAISE EXCEPTION 'excise override requires the dedicated confirmed administrative path' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_excise_override_path BEFORE INSERT OR UPDATE ON branch_tax_category_overrides
  FOR EACH ROW EXECUTE FUNCTION guard_excise_override_path();

CREATE FUNCTION confirm_menu_item_excise(p_item uuid, p_category uuid, p_slot text, p_actor uuid, p_confirmation text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE tid uuid := current_setting('app.current_tenant_id')::uuid;
BEGIN
  PERFORM public.assert_tenant_tax_permission(p_actor, 'tax:confirm_excise');
  PERFORM public.assert_excise_confirmation(p_confirmation);
  IF p_slot IS NULL OR p_slot NOT IN ('primary','additional') THEN
    RAISE EXCEPTION 'invalid tax assignment slot' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM public.menu_items WHERE id = p_item AND tenant_id = tid AND is_active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'menu item not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tax_categories WHERE id = p_category AND is_active AND tax_family = 'excise') THEN
    RAISE EXCEPTION 'active excise category required' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.menu_item_excise_confirmations(tenant_id, menu_item_id, tax_category_id, confirmed_by, confirmation_text)
    VALUES (tid, p_item, p_category, p_actor, p_confirmation);
  IF p_slot = 'primary' THEN
    UPDATE public.menu_items SET tax_rule_id = p_category WHERE id = p_item AND tenant_id = tid;
  ELSE
    INSERT INTO public.menu_item_additional_tax_categories(menu_item_id, tax_category_id)
      VALUES (p_item, p_category) ON CONFLICT DO NOTHING;
  END IF;
  INSERT INTO public.audit_log(tenant_id, user_id, action, resource, "after") VALUES
    (tid, p_actor, 'tax:confirm_excise', 'menu_items:' || p_item::text,
      jsonb_build_object('tax_category_id', p_category, 'slot', p_slot, 'confirmation', p_confirmation));
END;
$$;

-- Branch overrides affect all products assigned to their source category.
-- The admin must explicitly confirm the EXACT affected list (no hidden bulk
-- consent). A later new product fails resolution until explicitly confirmed.
CREATE FUNCTION confirm_excise_branch_override(p_branch uuid, p_source uuid, p_target uuid,
  p_items uuid[], p_actor uuid, p_confirmation text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE tid uuid := current_setting('app.current_tenant_id')::uuid; affected uuid[]; supplied uuid[]; item uuid;
BEGIN
  PERFORM public.assert_tenant_tax_permission(p_actor, 'tax:confirm_excise');
  PERFORM public.assert_excise_confirmation(p_confirmation);
  IF NOT EXISTS (SELECT 1 FROM public.tax_categories WHERE id = p_target AND tax_family = 'excise' AND is_active) THEN
    RAISE EXCEPTION 'active excise category required' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM public.branches WHERE id = p_branch AND tenant_id = tid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'branch not found' USING ERRCODE = 'P0002'; END IF;
  SELECT array_agg(id ORDER BY id) INTO affected FROM public.menu_items m WHERE m.tenant_id = tid AND
    (m.tax_rule_id = p_source OR EXISTS (SELECT 1 FROM public.menu_item_additional_tax_categories a
      WHERE a.menu_item_id = m.id AND a.tax_category_id = p_source));
  SELECT array_agg(id ORDER BY id) INTO supplied FROM (SELECT DISTINCT unnest(p_items) AS id) s;
  IF affected IS NULL OR supplied IS DISTINCT FROM affected THEN
    RAISE EXCEPTION 'explicit confirmation of every affected menu item is required' USING ERRCODE = '23514';
  END IF;
  FOREACH item IN ARRAY affected LOOP
    INSERT INTO public.menu_item_excise_confirmations(tenant_id, menu_item_id, tax_category_id, branch_id, confirmed_by, confirmation_text)
      VALUES (tid, item, p_target, p_branch, p_actor, p_confirmation);
  END LOOP;
  INSERT INTO public.branch_tax_category_overrides(tenant_id, branch_id, menu_item_tax_category_id, override_tax_category_id)
    VALUES (tid, p_branch, p_source, p_target)
    ON CONFLICT (tenant_id, branch_id, menu_item_tax_category_id) DO UPDATE SET override_tax_category_id = EXCLUDED.override_tax_category_id;
  INSERT INTO public.audit_log(tenant_id, user_id, action, resource, "after") VALUES
    (tid, p_actor, 'tax:confirm_excise_override', 'branches:' || p_branch::text,
      jsonb_build_object('source', p_source, 'target', p_target, 'confirmed_items', affected, 'confirmation', p_confirmation));
END;
$$;

-- tenants remains a global SELECT-only registry to app_login. This narrow
-- function updates only the authenticated current tenant, with audit in-TX.
CREATE FUNCTION set_tenant_vat_registration(p_status text, p_number text, p_actor uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE tid uuid := current_setting('app.current_tenant_id')::uuid; previous jsonb;
BEGIN
  PERFORM public.assert_tenant_tax_permission(p_actor, 'tax:registration_write');
  SELECT jsonb_build_object('vat_registration_status', vat_registration_status, 'vat_registration_number', vat_registration_number)
    INTO previous FROM public.tenants WHERE id = tid FOR UPDATE;
  UPDATE public.tenants SET vat_registration_status = p_status, vat_registration_number = p_number WHERE id = tid;
  INSERT INTO public.audit_log(tenant_id, user_id, action, resource, "before", "after") VALUES
    (tid, p_actor, 'tax:registration_write', 'tenants:' || tid::text, previous,
      jsonb_build_object('vat_registration_status', p_status, 'vat_registration_number', p_number));
END;
$$;
REVOKE ALL ON FUNCTION confirm_menu_item_excise(uuid, uuid, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION confirm_excise_branch_override(uuid, uuid, uuid, uuid[], uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_tenant_vat_registration(text, text, uuid) FROM PUBLIC;
REVOKE ALL ON menu_item_additional_tax_categories, menu_item_excise_confirmations, branch_tax_category_overrides FROM PUBLIC;

INSERT INTO permissions_registry(key, category, is_sensitive) VALUES
  ('tax:read','tax',false), ('tax:configure','tax',true),
  ('tax:confirm_excise','tax',true), ('tax:registration_write','tax',true)
ON CONFLICT (key) DO NOTHING;
