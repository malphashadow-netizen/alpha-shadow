import type { AuditJsonValue } from '../../shared/audit-snapshot.ts';

/** Commercial/business audit entry — intentionally separate from auth_audit_log. */
export interface AuditLogEntry {
  readonly tenantId: string;
  readonly userId: string | null;
  readonly action: string;
  readonly resource: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly timestamp?: Date | undefined;
}

export interface AuditLogRepository {
  append(entry: AuditLogEntry): Promise<void>;
}

/** Shape sent to JSONB after the shared redaction boundary. */
export interface StoredAuditSnapshot {
  readonly before: AuditJsonValue;
  readonly after: AuditJsonValue;
}
