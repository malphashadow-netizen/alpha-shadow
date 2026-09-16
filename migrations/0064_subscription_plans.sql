-- Dynamic subscription plans: names are data, not an enum or code switch.
CREATE TABLE IF NOT EXISTS subscription_plans (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (btrim(name) <> ''),
  price_amount_minor integer NOT NULL CHECK (price_amount_minor >= 0),
  price_currency_code text NOT NULL CHECK (price_currency_code ~ '^[A-Z]{3}$'),
  duration_days integer NOT NULL CHECK (duration_days > 0),
  is_trial boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO subscription_plans (id, name, price_amount_minor, price_currency_code, duration_days, is_trial)
VALUES ('2c266ac8-6c2b-4e70-958b-0d02f4cb3c3f', 'Trial', 0, 'SAR', 7, true)
ON CONFLICT (id) DO NOTHING;
