-- Manual DBA bootstrap only. This is deliberately NOT run by tools/migrate.ts.
-- The tenant is a platform identity container, not a restaurant.
INSERT INTO tenants (id, name, status)
VALUES ('9f6c1e42-7041-4be1-9d4f-1e29157c8a10', 'Platform system container', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO roles (tenant_id, name, is_system)
VALUES ('9f6c1e42-7041-4be1-9d4f-1e29157c8a10', 'PLATFORM_OWNER', true)
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (tenant_id, role_id, permission_key, max_amount_minor_units)
SELECT r.tenant_id, r.id, p.key, NULL
FROM roles r JOIN permissions_registry p ON p.key IN (
  'platform:tenant:create', 'platform:tenant:suspend', 'platform:tenant:reactivate',
  'platform:tenant:list', 'platform:tenant:view', 'platform:subscription:assign',
  'platform:subscription_plan:manage', 'staff:manage'
)
WHERE r.tenant_id = '9f6c1e42-7041-4be1-9d4f-1e29157c8a10'
  AND r.name = 'PLATFORM_OWNER'
ON CONFLICT DO NOTHING;
