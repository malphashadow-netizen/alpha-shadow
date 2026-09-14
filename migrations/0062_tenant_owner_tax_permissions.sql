-- Tenant-owner tax administration permissions.
-- Existing tenant super-admin roles are backfilled idempotently.

INSERT INTO permissions_registry (key, category, is_sensitive) VALUES
  ('tax_rate:create', 'tax', true),
  ('tax_rate:close_and_supersede', 'tax', true)
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (tenant_id, role_id, permission_key, max_amount_minor_units)
SELECT r.tenant_id, r.id, p.key, NULL
  FROM roles r
  CROSS JOIN permissions_registry p
 WHERE r.name = 'TENANT_SUPER_ADMIN'
   AND p.key IN ('tax_rate:create', 'tax_rate:close_and_supersede', 'tax:configure')
ON CONFLICT DO NOTHING;
