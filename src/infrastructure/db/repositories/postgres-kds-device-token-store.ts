/**
 * PostgreSQL adapter for the R1 KDS device-token port
 * (domain/contracts/kds.ts — KdsDeviceTokenStore).
 *
 * Every use case runs in ONE withTenantContext() transaction (repeatable
 * read, tenant existence verified). This class never imports pg; it only
 * receives the transaction-scoped TenantQuery.
 */
import type {
  KdsDeviceTokenRecord,
  KdsDeviceTokenStatus,
  KdsDeviceTokenStore,
  KdsDeviceTokenTxScope,
} from '../../../domain/contracts/kds.ts';
import type { WithTenantContext, TenantQuery } from '../tenant-context.ts';

interface KdsDeviceTokenRow {
  id: string;
  tenant_id: string;
  branch_id: string;
  token_hash: string;
  status: string;
  label: string;
  created_by: string;
  created_at: Date;
  last_used_at: Date | null;
}

function mapRow(row: KdsDeviceTokenRow): KdsDeviceTokenRecord {
  const status = row.status as KdsDeviceTokenStatus;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    branchId: row.branch_id,
    tokenHash: row.token_hash,
    status,
    label: row.label,
    createdBy: row.created_by,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

const SELECT_COLUMNS = 'id, tenant_id, branch_id, token_hash, status, label, created_by, created_at, last_used_at';

function buildScope(q: TenantQuery): KdsDeviceTokenTxScope {
  return {
    async insertDeviceToken(tenantId, input) {
      const result = await q.query<KdsDeviceTokenRow>(
        `INSERT INTO kds_device_tokens (tenant_id, branch_id, token_hash, label, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${SELECT_COLUMNS}`,
        [tenantId, input.branchId, input.tokenHash, input.label, input.createdBy],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error('kds_device_tokens INSERT returned no row');
      return mapRow(row);
    },

    async loadDeviceTokenById(tenantId, tokenId) {
      const result = await q.query<KdsDeviceTokenRow>(
        `SELECT ${SELECT_COLUMNS} FROM kds_device_tokens WHERE tenant_id = $1 AND id = $2`,
        [tenantId, tokenId],
      );
      const row = result.rows[0];
      return row === undefined ? null : mapRow(row);
    },

    async loadDeviceTokenByHash(tenantId, tokenHash) {
      const result = await q.query<KdsDeviceTokenRow>(
        `SELECT ${SELECT_COLUMNS} FROM kds_device_tokens WHERE tenant_id = $1 AND token_hash = $2`,
        [tenantId, tokenHash],
      );
      const row = result.rows[0];
      return row === undefined ? null : mapRow(row);
    },

    async revokeDeviceToken(tenantId, tokenId) {
      const result = await q.query<KdsDeviceTokenRow>(
        `UPDATE kds_device_tokens SET status = 'revoked' WHERE tenant_id = $1 AND id = $2 RETURNING ${SELECT_COLUMNS}`,
        [tenantId, tokenId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error(`KDS device token ${tokenId} not found for revocation`);
      return mapRow(row);
    },

    async touchDeviceTokenLastUsed(tenantId, tokenId) {
      await q.query(
        `UPDATE kds_device_tokens SET last_used_at = now()
         WHERE tenant_id = $1 AND id = $2 AND (last_used_at IS NULL OR last_used_at < now() - INTERVAL '60 seconds')`,
        [tenantId, tokenId],
      );
    },
  };
}

export interface PostgresKdsDeviceTokenStoreDependencies {
  readonly withTenantContext: WithTenantContext;
}

export class PostgresKdsDeviceTokenStore implements KdsDeviceTokenStore {
  private readonly dependencies: PostgresKdsDeviceTokenStoreDependencies;

  constructor(dependencies: PostgresKdsDeviceTokenStoreDependencies) {
    this.dependencies = dependencies;
  }

  run<T>(tenantId: string, fn: (scope: KdsDeviceTokenTxScope) => Promise<T>): Promise<T> {
    return this.dependencies.withTenantContext(
      tenantId,
      async (q) => fn(buildScope(q)),
      { isolationLevel: 'repeatable read', verifyTenantExists: true },
    );
  }
}
