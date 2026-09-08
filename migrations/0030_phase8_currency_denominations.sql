-- Migration 0030 — Phase 8 (2/7): cash denomination registry (global reference data).
--
-- currency_denominations backs the shift cash-count screens: the cashier
-- counts the drawer by denomination (cash_count_details, migration 0032) and
-- this table supplies the enumerable denomination values per currency,
-- seeded by each currency's issuing country.
--
-- It is a GLOBAL, non-tenant reference registry — the documented exception to
-- "migrations are schema-only" (migrations/README.md): no tenant_id, no
-- environment-specific rows, ON CONFLICT DO NOTHING (never DO UPDATE), same
-- contract as 0007_seed_currencies.sql. No RLS block: the table has no
-- tenant_id column, so it is out of scope for the tenant-isolation contract
-- (exactly like `currencies` and `permissions_registry`).
--
-- NOTE on scale: value is NUMERIC(18,2) by spec. KWD/USD-style 3-digit
-- sub-minor coins (e.g. the 5-fils coin = 0.005 KWD) are therefore not
-- representable and are deliberately absent; the seeded rows are the
-- 2-decimal-representable denominations in common circulation.

CREATE TABLE IF NOT EXISTS currency_denominations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  currency_code text NOT NULL REFERENCES currencies (code),
  value numeric(18,2) NOT NULL CHECK (value > 0),
  label text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  CONSTRAINT currency_denominations_currency_value_key UNIQUE (currency_code, value)
);

CREATE INDEX IF NOT EXISTS idx_currency_denominations_currency
  ON currency_denominations (currency_code) WHERE is_active;

REVOKE ALL ON currency_denominations FROM PUBLIC;

-- Global reference seed — per-currency denominations of the issuing country.
-- Re-running is a no-op; corrections are a NEW, explicit migration (see the
-- currencies precedent in migrations/README.md).
INSERT INTO currency_denominations (currency_code, value, label) VALUES
  -- SAR — Saudi riyal (halalas / riyals)
  ('SAR', 0.05, '5 halalas'), ('SAR', 0.10, '10 halalas'), ('SAR', 0.25, '25 halalas'),
  ('SAR', 0.50, '50 halalas'), ('SAR', 1.00, '1 riyal'), ('SAR', 2.00, '2 riyals'),
  ('SAR', 5.00, '5 riyals'), ('SAR', 10.00, '10 riyals'), ('SAR', 20.00, '20 riyals'),
  ('SAR', 50.00, '50 riyals'), ('SAR', 100.00, '100 riyals'), ('SAR', 500.00, '500 riyals'),
  -- EGP — Egyptian pound (piastres / pounds)
  ('EGP', 0.25, '25 piastres'), ('EGP', 0.50, '50 piastres'), ('EGP', 1.00, '1 pound'),
  ('EGP', 5.00, '5 pounds'), ('EGP', 10.00, '10 pounds'), ('EGP', 20.00, '20 pounds'),
  ('EGP', 50.00, '50 pounds'), ('EGP', 100.00, '100 pounds'), ('EGP', 200.00, '200 pounds'),
  -- KWD — Kuwaiti dinar (fils / dinars; only 2-decimal-representable coins)
  ('KWD', 0.05, '50 fils'), ('KWD', 0.10, '100 fils'), ('KWD', 0.25, '250 fils'),
  ('KWD', 0.50, '500 fils'), ('KWD', 1.00, '1 dinar'), ('KWD', 5.00, '5 dinars'),
  ('KWD', 10.00, '10 dinars'), ('KWD', 20.00, '20 dinars'),
  -- USD — US dollar (cents / dollars)
  ('USD', 0.01, '1 cent'), ('USD', 0.05, '5 cents'), ('USD', 0.10, '10 cents'),
  ('USD', 0.25, '25 cents'), ('USD', 0.50, '50 cents'), ('USD', 1.00, '1 dollar'),
  ('USD', 2.00, '2 dollars'), ('USD', 5.00, '5 dollars'), ('USD', 10.00, '10 dollars'),
  ('USD', 20.00, '20 dollars'), ('USD', 50.00, '50 dollars'), ('USD', 100.00, '100 dollars'),
  -- AED — UAE dirham (fils / dirhams)
  ('AED', 0.25, '25 fils'), ('AED', 0.50, '50 fils'), ('AED', 1.00, '1 dirham'),
  ('AED', 5.00, '5 dirhams'), ('AED', 10.00, '10 dirhams'), ('AED', 20.00, '20 dirhams'),
  ('AED', 50.00, '50 dirhams'), ('AED', 100.00, '100 dirhams'), ('AED', 200.00, '200 dirhams'),
  ('AED', 500.00, '500 dirhams'),
  -- EUR — euro (cents / euros)
  ('EUR', 0.01, '1 cent'), ('EUR', 0.02, '2 cents'), ('EUR', 0.05, '5 cents'),
  ('EUR', 0.10, '10 cents'), ('EUR', 0.20, '20 cents'), ('EUR', 0.50, '50 cents'),
  ('EUR', 1.00, '1 euro'), ('EUR', 2.00, '2 euros'), ('EUR', 5.00, '5 euros'),
  ('EUR', 10.00, '10 euros'), ('EUR', 20.00, '20 euros'), ('EUR', 50.00, '50 euros'),
  ('EUR', 100.00, '100 euros'), ('EUR', 200.00, '200 euros'), ('EUR', 500.00, '500 euros')
ON CONFLICT (currency_code, value) DO NOTHING;
