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
import type { WithTenantContext } from '../tenant-context.ts';

export interface PostgresAuditLogRepositoryDependencies {
  readonly withTenantContext: WithTenantContext;
}

export class PostgresAuditLogRepository implements AuditLogRepository {
  private readonly withTenantContext: WithTenantContext;

  constructor(dependencies: PostgresAuditLogRepositoryDependencies) {
    this.withTenantContext = dependencies.withTenantContext;
  }

  async append(entry: AuditLogEntry): Promise<void> {
    // This is the only snapshot/redaction call site. No caller may provide a
    // pre-redacted object or bypass this path when recording commercial audit.
    const before = snapshotForAudit(entry.before);
    const after = snapshotForAudit(entry.after);
    const timestamp = entry.timestamp ?? new Date();

    await this.withTenantContext(entry.tenantId, async (q) => {
      await q.query(
        `INSERT INTO audit_log
           (tenant_id, user_id, action, resource, "before", "after", "timestamp")
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
        [entry.tenantId, entry.userId, entry.action, entry.resource, JSON.stringify(before), JSON.stringify(after), timestamp],
      );
    });
  }
}
