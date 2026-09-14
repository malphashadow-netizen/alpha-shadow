import type { TenantQuery } from '../../tenant-context.ts';

export async function getCoveredPermissionKeys(
  q: TenantQuery,
  tenantId: string,
  userId: string,
  branchId: string,
  candidateKeys: readonly string[],
): Promise<readonly string[]> {
  if (candidateKeys.length === 0) return [];
  const result = await q.query<{ permission_key: string }>(
    `SELECT DISTINCT rp.permission_key
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       JOIN user_roles ur ON ur.user_id = u.id AND ur.tenant_id = u.tenant_id
       JOIN roles r ON r.id = ur.role_id AND r.tenant_id = ur.tenant_id
       JOIN role_permissions rp ON rp.role_id = r.id AND rp.tenant_id = r.tenant_id
      WHERE u.id = $2 AND u.tenant_id = $1 AND u.is_active AND t.status = 'active' AND ur.is_active
        AND rp.permission_key = ANY($3::text[])
        AND (ur.scope_type = 'tenant' AND ur.scope_id IS NULL
             OR ur.scope_type = 'branch' AND ur.scope_id IS NOT DISTINCT FROM $4)`,
    [tenantId, userId, candidateKeys, branchId],
  );
  return result.rows.map((row) => row.permission_key);
}
