-- Migration 0051 — Backlog (I4): universal unit registry (tier-1 conversions).
--
-- WHAT: a platform-seeded registry of measurement units (code, kind,
-- exact factor to the kind's base unit). Receiving gains a UNIVERSAL
-- fallback: when no per-item conversion row exists (tier 2, 0038 —
-- UNCHANGED, still wins on conflict), two registered units of the SAME kind
-- convert through their base factors. Cross-kind pairs (kg→L) and unknown
-- units still fail closed at the engine.
--
-- WHY THIS RESPECTS 0037's "never a closed enum": the registry ADDS
-- capability, it never forbids. No FK points at it — base_unit and
-- unit_conversions stay free text, tenants keep full freedom via item rows
-- (a 'sachet' or 'box' converts exactly as before through tier 2). Unknown
-- units are not rejected for being unregistered; they simply have no
-- universal math, exactly like today. (Tenant-extensible registration would
-- mirror the void-reasons pattern — deliberately OUT of this scope.)
--
-- CANONICAL CODES (locked by the I4 audit: these 8 are the repo's entire
-- de-facto vocabulary, closed symmetrically):
--   mass (base g):   kg, g, mg, lb, oz
--   volume (base ml): L, ml
--   count (base piece): piece
-- Naming decisions (approved): the liter is canonical capital 'L' (the
-- SI-accepted symbol, unambiguous with digit '1'); lowercase 'l' and the
-- word 'liter' are NOT registered. Matching is exact — no case folding.
--
-- SCALE (0038 mirror): factors live at NUMERIC(18,8), the system's single
-- conversion-factor scale — the engine reuses its existing scale-8 helpers
-- untouched. All seeds are exact at 8dp except oz: exact 28.349523125 g
-- needs 9 places, so the seed carries 28.34952313 (explicit literal, half
-- UP from exact — a 5e-9 g/unit approximation, far below the terminal
-- scale-4 rounding). The engine derives working factors with banker
-- division to scale 8, then follows the existing exact receiving path.
--
-- DEPENDS ON: 0018 (guard pattern reference), 0037/0038 (unchanged tiers).

CREATE TABLE IF NOT EXISTS unit_registry (
  code text PRIMARY KEY CHECK (char_length(code) BETWEEN 1 AND 32),
  kind text NOT NULL CHECK (kind IN ('mass', 'volume', 'count')),
  kind_base_unit text NOT NULL CHECK (char_length(kind_base_unit) BETWEEN 1 AND 32),
  to_base_factor NUMERIC(18,8) NOT NULL CHECK (to_base_factor > 0)
);

-- Platform reference data: mutable only outside a tenant context (0018
-- guard mirror, with a unit-specific message).
CREATE OR REPLACE FUNCTION guard_platform_unit_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NULLIF(current_setting('app.current_tenant_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'platform unit registry cannot be mutated in a tenant context' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_platform_unit_registry_write ON unit_registry;
CREATE TRIGGER trg_platform_unit_registry_write BEFORE INSERT OR UPDATE OR DELETE ON unit_registry
  FOR EACH ROW EXECUTE FUNCTION guard_platform_unit_write();

REVOKE ALL ON unit_registry FROM PUBLIC;

-- oz: exact-by-definition 28.349523125 g, seeded at 8dp (see header).
INSERT INTO unit_registry (code, kind, kind_base_unit, to_base_factor) VALUES
  ('kg', 'mass', 'g', 1000),
  ('g', 'mass', 'g', 1),
  ('mg', 'mass', 'g', 0.001),
  ('lb', 'mass', 'g', 453.59237),
  ('oz', 'mass', 'g', 28.34952313),
  ('L', 'volume', 'ml', 1000),
  ('ml', 'volume', 'ml', 1),
  ('piece', 'count', 'piece', 1)
ON CONFLICT (code) DO NOTHING;
