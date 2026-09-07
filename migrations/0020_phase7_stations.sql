-- Migration 0020 — Phase 7 (3/10): preparation stations + dynamic routing rules.
--
-- Stations are per-branch (grill / salads / desserts / bar …). Routing rules
-- decide — per branch — which station prepares an order item, matched on
-- (menu_item_id, sales_channel_code, order_type). A NULL criterion is an
-- explicit wildcard. Reuses the Phase-6 sales_channels registry.
--
-- DETERMINISTIC TIE-BREAK (named in the design, implemented everywhere):
--   specificity_score DESC → priority_weight DESC → rule_id ASC
--   * specificity_score: menu_item_id match = 100, sales_channel match = 20,
--     order_type match = 10 (any higher dimension outranks any combination of
--     lower ones: 100 > 20+10, 20 > 10).
--   * priority_weight: explicit tenant-controlled tie-break.
--   * rule_id ASC: final deterministic tie-break — there is ALWAYS exactly
--     one winner and it is reproducible. No random or read-order routing.
-- NO MATCHING RULE ⇒ the order item is REFUSED (fail-closed). There is no
-- default/random station: routing without an explicit rule is forbidden.
--
-- Style notes: idempotent, no DROP TABLE / CASCADE, mandatory RLS template.

CREATE TABLE IF NOT EXISTS stations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  branch_id uuid NOT NULL,
  name text NOT NULL CHECK (btrim(name) <> ''),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stations_id_tenant_key UNIQUE (id, tenant_id),
  FOREIGN KEY (branch_id, tenant_id) REFERENCES branches (id, tenant_id) ON DELETE RESTRICT
);
-- Station names are unique per branch, compared case-insensitively (an
-- expression index is required because table constraints cannot contain
-- expressions).
CREATE UNIQUE INDEX IF NOT EXISTS idx_stations_branch_name_ci ON stations (branch_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_stations_tenant_id ON stations (tenant_id);
CREATE INDEX IF NOT EXISTS idx_stations_branch ON stations (tenant_id, branch_id);

ALTER TABLE stations ENABLE ROW LEVEL SECURITY;
ALTER TABLE stations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON stations;
CREATE POLICY tenant_isolation ON stations
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS station_routing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  branch_id uuid NOT NULL,
  station_id uuid NOT NULL,
  -- All three criteria NULL = an EXPLICIT catch-all rule (still a deliberate
  -- tenant decision, never an engine-invented default).
  menu_item_id uuid,
  sales_channel_code text REFERENCES sales_channels (code),
  order_type text CHECK (order_type IN ('dine_in', 'takeaway', 'delivery')),
  -- Tenant-controlled tie-break inside one specificity class.
  priority_weight integer NOT NULL DEFAULT 0,
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT station_routing_rules_id_tenant_key UNIQUE (id, tenant_id),
  -- NOTE: deliberately NO uniqueness on the criteria set. Two rules with the
  -- SAME criteria (a specificity tie) are a legitimate configuration state;
  -- the DETERMINISTIC TIE-BREAK resolves them: priority_weight DESC first
  -- (tenant-controlled), then rule_id ASC (final reproducible ordering).
  FOREIGN KEY (branch_id, tenant_id) REFERENCES branches (id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (station_id, tenant_id) REFERENCES stations (id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (menu_item_id, tenant_id) REFERENCES menu_items (id, tenant_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_station_routing_rules_tenant_id ON station_routing_rules (tenant_id);
CREATE INDEX IF NOT EXISTS idx_station_routing_rules_branch ON station_routing_rules (branch_id);
CREATE INDEX IF NOT EXISTS idx_station_routing_rules_station ON station_routing_rules (station_id);

ALTER TABLE station_routing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE station_routing_rules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON station_routing_rules;
CREATE POLICY tenant_isolation ON station_routing_rules
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- A rule's station must be active at write time; routing to a retired station
-- is a configuration error, not a runtime fallback.
CREATE FUNCTION validate_station_routing_rule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.stations s
    WHERE s.id = NEW.station_id AND s.tenant_id = NEW.tenant_id AND s.branch_id = NEW.branch_id AND s.is_active) THEN
    RAISE EXCEPTION 'routing rule must point at an active station of the same branch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_validate_station_routing_rule ON station_routing_rules;
CREATE TRIGGER trg_validate_station_routing_rule BEFORE INSERT OR UPDATE ON station_routing_rules
  FOR EACH ROW EXECUTE FUNCTION validate_station_routing_rule();

REVOKE ALL ON stations, station_routing_rules FROM PUBLIC;
