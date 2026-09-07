/**
 * Tenant-scoped commercial audit-log adapter.
 *
 * The adapter receives the only sanctioned tenant DB entry point and applies
 * `snapshotForAudit` to both sides of every row. The auth_audit_log adapter is
 * deliberately not reused: that table is a separate global login-attempt
 * ledger with a different role and retention/security model.
 */
import type { AuditLogEntry, AuditLogRepository } from '../../../domain/contracts/audit-log.ts';
import { snapshotForAudit } from '../../../shared/audit-snapshot.ts';
import type { TenantQuery, WithTenantContext } from '../tenant-context.ts';

export interface PostgresAuditLogRepositoryDependencies {
  readonly withTenantContext: WithTenantContext;
}

export class PostgresAuditLogRepository implements AuditLogRepository {
  private readonly withTenantContext: WithTenantContext;

  constructor(dependencies: PostgresAuditLogRepositoryDependencies) {
    this.withTenantContext = dependencies.withTenantContext;
  }

  async append(entry: AuditLogEntry): Promise<void> {
    await this.withTenantContext(entry.tenantId, async (q) => appendAuditLogInTransaction(q, entry));
  }
}

/** Bind audit to an existing business transaction; never open a nested TX. */
export async function appendAuditLogInTransaction(q: TenantQuery, entry: AuditLogEntry): Promise<void> {
  const before = snapshotForAudit(entry.before);
  const after = snapshotForAudit(entry.after);
  await q.query(
    `INSERT INTO audit_log
       (tenant_id, user_id, action, resource, "before", "after", "timestamp")
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
    [entry.tenantId, entry.userId, entry.action, entry.resource, JSON.stringify(before), JSON.stringify(after), entry.timestamp ?? new Date()],
  );
}
