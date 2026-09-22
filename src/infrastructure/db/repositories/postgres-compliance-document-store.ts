/**
 * PostgreSQL adapter for the D-3 compliance submission orchestrator port
 * (domain/contracts/compliance.ts — ComplianceDocumentStore).
 *
 * document_status, submission_attempt_no, submitted_at, settled_at and
 * last_error on compliance_documents are ALL derived by the
 * apply_compliance_document_status trigger from rows inserted into
 * compliance_document_transitions; this adapter NEVER writes those columns
 * directly. The only direct UPDATE this adapter performs targets
 * next_retry_at, which that trigger does not touch (Decision D-3).
 *
 * This class never imports pg (see eslint-rules/pg-import-policy.ts); it only
 * receives the transaction-scoped TenantQuery from withTenantContext().
 */
import type {
  ComplianceDocumentStatus,
  ComplianceDocumentStore,
  ComplianceDocumentTxScope,
  ComplianceSettlementMode,
  ComplianceSubmissionCandidate,
} from '../../../domain/contracts/compliance.ts';
import { NotFoundError } from '../../../shared/errors.ts';
import type { TenantQuery, WithTenantContext } from '../tenant-context.ts';

interface ComplianceDocumentCandidateRow {
  id: string;
  tenant_id: string;
  branch_id: string;
  order_id: string;
  document_type: string;
  country_code: string;
  authority_id: string;
  settlement_mode: ComplianceSettlementMode;
  document_status: ComplianceDocumentStatus;
  submission_attempt_no: number;
}

function mapCandidate(r: ComplianceDocumentCandidateRow): ComplianceSubmissionCandidate {
  return {
    complianceDocumentId: r.id,
    tenantId: r.tenant_id,
    branchId: r.branch_id,
    orderId: r.order_id,
    documentType: r.document_type,
    countryCode: r.country_code,
    authorityId: r.authority_id,
    settlementMode: r.settlement_mode,
    documentStatus: r.document_status,
    submissionAttemptNo: r.submission_attempt_no,
  };
}

export interface PostgresComplianceDocumentStoreDependencies {
  readonly withTenantContext: WithTenantContext;
}

export class PostgresComplianceDocumentStore implements ComplianceDocumentStore {
  private readonly dependencies: PostgresComplianceDocumentStoreDependencies;

  constructor(dependencies: PostgresComplianceDocumentStoreDependencies) {
    this.dependencies = dependencies;
  }

  run<T>(tenantId: string, fn: (scope: ComplianceDocumentTxScope) => Promise<T>): Promise<T> {
    return this.dependencies.withTenantContext(
      tenantId,
      async (q) => fn(buildScope(q)),
      { isolationLevel: 'repeatable read', verifyTenantExists: true },
    );
  }
}

function buildScope(q: TenantQuery): ComplianceDocumentTxScope {
  return {
    async loadClaimableDocuments(tid: string, limit: number): Promise<readonly ComplianceSubmissionCandidate[]> {
      const result = await q.query<ComplianceDocumentCandidateRow>(
        `SELECT id, tenant_id, branch_id, order_id, document_type, country_code,
                authority_id, settlement_mode, document_status, submission_attempt_no
           FROM compliance_documents
          WHERE tenant_id = $1
            AND (
              document_status = 'SIGNED'
              OR (document_status = 'RETRY' AND next_retry_at IS NOT NULL AND next_retry_at <= now())
            )
          ORDER BY next_retry_at ASC NULLS FIRST, created_at ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED`,
        [tid, limit],
      );
      return result.rows.map(mapCandidate);
    },

    async recordTransition(
      tid: string,
      input: {
        readonly complianceDocumentId: string;
        readonly orderId: string;
        readonly fromStatus: ComplianceDocumentStatus;
        readonly toStatus: ComplianceDocumentStatus;
        readonly reason?: string;
        readonly actorUserId?: string | null;
      },
    ): Promise<void> {
      await q.query(
        `INSERT INTO compliance_document_transitions
           (tenant_id, compliance_document_id, order_id, from_status, to_status, reason, actor_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          tid,
          input.complianceDocumentId,
          input.orderId,
          input.fromStatus,
          input.toStatus,
          input.reason ?? null,
          input.actorUserId ?? null,
        ],
      );
    },

    async scheduleRetry(tid: string, complianceDocumentId: string, nextRetryAt: Date): Promise<void> {
      const result = await q.query(
        `UPDATE compliance_documents
            SET next_retry_at = $3
          WHERE tenant_id = $1 AND id = $2`,
        [tid, complianceDocumentId, nextRetryAt],
      );
      if ((result.rowCount ?? 0) === 0) {
        throw new NotFoundError(`compliance_documents row "${complianceDocumentId}" not found for tenant "${tid}"`);
      }
    },

    async clearRetry(tid: string, complianceDocumentId: string): Promise<void> {
      const result = await q.query(
        `UPDATE compliance_documents
            SET next_retry_at = NULL
          WHERE tenant_id = $1 AND id = $2`,
        [tid, complianceDocumentId],
      );
      if ((result.rowCount ?? 0) === 0) {
        throw new NotFoundError(`compliance_documents row "${complianceDocumentId}" not found for tenant "${tid}"`);
      }
    },
  };
}
