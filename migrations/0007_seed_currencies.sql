-- Migration 0007 — seed the GLOBAL ISO 4217 `currencies` reference registry.
--
-- Scope and rationale
-- -------------------
-- `currencies` was created schema-only by 0006_phase4_multi_currency_audit.sql
-- and left deliberately empty. This migration adds the base reference rows the
-- product needs (`exchange_rates.from_currency/to_currency` are FKs to this
-- table, and CurrencyConversionEngine reads `minor_unit_digits` from it).
--
-- This is NOT test/probe data. It is global, non-tenant ISO 4217 reference
-- data with no `tenant_id`, identical in every environment — the documented
-- exception to "migrations are schema-only" in migrations/README.md. Probe
-- tenants still live exclusively in test/support/seed.test.sql.
--
-- Values are the ISO 4217 minor-unit digit counts and MUST stay byte-for-byte
-- identical to `ISO_4217_MINOR_UNITS` in src/shared/money.ts, which is the
-- single source of truth for rounding scale. KWD is 3 (fils), not 2 — the
-- rounding scale of every KWD conversion depends on it.
-- Guarded by:
--   - test/unit/shared/currency-seed-migration.test.ts (static: this file vs.
--     ISO_4217_MINOR_UNITS, no DB needed)
--   - test/integration/phase4b-currency-seed.test.ts   (live: stored rows vs.
--     ISO_4217_MINOR_UNITS + a real KWD 3-decimal conversion)
--
-- Conflict policy: ON CONFLICT (code) DO NOTHING — never DO UPDATE.
-- ------------------------------------------------------------------------
-- These rows are global reference data. An existing row may already be in use
-- by historical `exchange_rates` and by reports whose rounding scale was
-- computed from it, so this migration must never silently rewrite a stored
-- `minor_unit_digits`. Re-running it is a no-op. If ISO 4217 itself ever
-- changes a minor-unit digit count (or a row was provisioned wrongly by hand),
-- the correction is an explicit, reviewed NEW migration that states the old
-- value, the new value and the reporting impact — not a silent upsert here.
--
-- No RLS block: `currencies` has no `tenant_id` column (confirmed in 0006), so
-- it is out of scope for the tenant-isolation contract, exactly like `tenants`
-- and `permissions_registry`. Least-privilege grants for this table are in
-- migrations/roles/004_app_login_phase4.sql (`SELECT` only for app_login).

INSERT INTO currencies (code, minor_unit_digits) VALUES
  ('SAR', 2),  -- Saudi riyal        — halalas
  ('EGP', 2),  -- Egyptian pound     — piastres
  ('KWD', 3),  -- Kuwaiti dinar      — fils: THREE decimal digits, not two
  ('USD', 2),  -- US dollar          — cents
  ('AED', 2),  -- UAE dirham         — fils (2 digits for AED)
  ('EUR', 2)   -- Euro               — cents
ON CONFLICT (code) DO NOTHING;
