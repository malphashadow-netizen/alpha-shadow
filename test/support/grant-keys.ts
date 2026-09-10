import { randomUUID } from 'node:crypto';
import type { PostgresPermissionWriteRepository } from '../../src/infrastructure/db/repositories/postgres-permission-repository.ts';

/**
 * B7 test helper: grants permission keys to a user via a FRESH role (created
 * per call, so repeated grants never collide — safe with fixed tenants too).
 * Only touches roles/grants/assignments; the registry rows themselves are
 * owned by the migrations (0046 for the B7 keys).
 */
export async function grantKeys(
  write: PostgresPermissionWriteRepository,
  tenantId: string,
  userId: string,
  keys: readonly string[],
): Promise<void> {
  const roleId = await write.createRole(tenantId, `b7-grant-${randomUUID()}`);
  for (const key of keys) {
    await write.assignRolePermission(tenantId, roleId, key, null);
  }
  await write.assignUserRole(tenantId, userId, roleId, 'tenant', null);
}
