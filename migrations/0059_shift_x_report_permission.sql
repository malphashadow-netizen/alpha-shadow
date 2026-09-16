-- Migration 0059 — F-10a: permission key for the shift X-Report.
--
-- shift:x_report is READ-ONLY: it does not change money or structural
-- configuration, so it is non-sensitive under the 0046 sensitivity rule.

INSERT INTO permissions_registry (key, category, is_sensitive) VALUES
  ('shift:x_report', 'shift', false)
ON CONFLICT (key) DO NOTHING;
