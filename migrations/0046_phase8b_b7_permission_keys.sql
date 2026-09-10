-- Migration 0046 — Phase 8b (B7): permission keys for payment collection,
-- shift open/close, and payment-method administration.
--
-- The catalog keys (catalog:read/write/archive) were seeded by 0008; B7 only
-- starts ENFORCING them. The four keys below are NEW registry rows:
--   payments:collect       — collecting a payment on an order (sensitive:
--                             money-affecting, never L1-cached);
--   shift:open / shift:close — opening / Z-closing a till shift (sensitive:
--                             financial control points, low frequency so the
--                             no-cache cost is nil);
--   payments:methods_admin  — creating/updating payment methods (sensitive:
--                             structural tender configuration, tax:configure
--                             parity).
--
-- Sensitivity follows the 0031 discipline (money-affecting or structural ⇒
-- true); engines pass the matching isSensitivePermission flag. GLOBAL
-- registry rows (no tenant_id), idempotent, no tables, no CASCADE.

INSERT INTO permissions_registry (key, category, is_sensitive) VALUES
  ('payments:collect', 'payments', true),
  ('shift:open', 'shift', true),
  ('shift:close', 'shift', true),
  ('payments:methods_admin', 'payments', true)
ON CONFLICT (key) DO NOTHING;
