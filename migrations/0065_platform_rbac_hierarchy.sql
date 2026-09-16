ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_plan_id uuid REFERENCES subscription_plans(id) ON DELETE NO ACTION;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_status text NOT NULL DEFAULT 'active'
  CHECK (subscription_status IN ('trial', 'active', 'suspended', 'cancelled'));
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_started_at timestamptz;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_ends_at timestamptz;

INSERT INTO permissions_registry (key, category, is_sensitive) VALUES
  ('platform:tenant:create', 'platform', true),
  ('platform:tenant:suspend', 'platform', true),
  ('platform:tenant:reactivate', 'platform', true),
  ('platform:tenant:list', 'platform', true),
  ('platform:tenant:view', 'platform', true),
  ('platform:subscription:assign', 'platform', true),
  ('platform:subscription_plan:manage', 'platform', true),
  ('staff:manage', 'staff', true)
ON CONFLICT (key) DO NOTHING;

-- Existing tenant-owner system roles receive staff administration through RBAC,
-- not through the tenant-creation function.
INSERT INTO role_permissions (tenant_id, role_id, permission_key, max_amount_minor_units)
SELECT r.tenant_id, r.id, 'staff:manage', NULL FROM roles r
WHERE r.name = 'TENANT_SUPER_ADMIN'
ON CONFLICT DO NOTHING;
