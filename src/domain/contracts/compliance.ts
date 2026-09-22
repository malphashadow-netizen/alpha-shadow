/**
 * Compliance-provider domain contracts.
 *
 * Pure types + ports only (zero dependencies outside domain/shared). This is
 * a port, not a provider implementation: concrete adapters such as ZATCA are
 * implemented later under infrastructure/ and keep document building and
 * signing details private behind this boundary.
 */

/** Provider-defined document kind; persisted values are non-empty text. */
export type ComplianceDocumentType = string;

export type ComplianceSettlementMode = 'synchronous_clearance' | 'asynchronous_reporting';

export type ComplianceDocumentStatus =
  | 'DRAFT'
  | 'FINALIZED'
  | 'COMPLIANCE_PENDING'
  | 'GENERATED'
  | 'SIGNED'
  | 'SUBMITTED'
  | 'ACCEPTED'
  | 'REPORTED'
  | 'REJECTED'
  | 'FAILED'
  | 'RETRY';

export interface ComplianceArtifactStore {
  putArtifact(payload: Uint8Array): Promise<{ artifactReference: string; artifactHash: string }>;
  getArtifact(artifactReference: string): Promise<Uint8Array | null>;
}

export interface ComplianceDocumentInput {
  readonly tenantId: string;
  readonly complianceDocumentId: string;
  readonly branchId: string;
  readonly orderId: string;
  readonly documentType: ComplianceDocumentType;
  readonly countryCode: string;
  readonly authorityId: string;
  readonly settlementMode: ComplianceSettlementMode;
}

export interface ComplianceSubmissionResult {
  readonly externalReference: string;
  readonly artifactReference: string;
  readonly artifactHash: string;
  readonly submittedAt: Date;
}

export interface ComplianceStatusResult {
  readonly status: ComplianceDocumentStatus;
  readonly lastError: string | null;
  readonly settledAt: Date | null;
}

/**
 * Port implemented by future compliance-provider adapters in infrastructure/.
 * Provider-specific build and sign operations remain internal to each adapter.
 */
export interface ComplianceProviderAdapter {
  submitDocument(
    input: ComplianceDocumentInput,
    store: ComplianceArtifactStore,
  ): Promise<ComplianceSubmissionResult>;
  getStatus(tenantId: string, externalReference: string): Promise<ComplianceStatusResult>;
}

/**
 * Application-layer port for the compliance submission orchestrator
 * (Decision D-3). document_status, submission_attempt_no, submitted_at,
 * settled_at and last_error on compliance_documents are ALL derived by a
 * database trigger (apply_compliance_document_status) from rows inserted
 * into compliance_document_transitions — this store never writes those
 * columns directly; it only appends transition rows and manages
 * next_retry_at, which the trigger does not touch.
 */
export interface ComplianceSubmissionCandidate {
  readonly complianceDocumentId: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly orderId: string;
  readonly documentType: ComplianceDocumentType;
  readonly countryCode: string;
  readonly authorityId: string;
  readonly settlementMode: ComplianceSettlementMode;
  readonly documentStatus: ComplianceDocumentStatus;
  readonly submissionAttemptNo: number;
}

export interface ComplianceDocumentTxScope {
  /**
   * Rows in SIGNED (first-time send) or RETRY with next_retry_at <= now(),
   * locked via SELECT ... FOR UPDATE SKIP LOCKED so concurrent orchestrator
   * runs never claim the same document twice. There is no separate claim
   * ledger table for compliance documents (unlike side_effect_delivery_log);
   * document_status itself is the single source of truth.
   */
  loadClaimableDocuments(
    tenantId: string,
    limit: number,
  ): Promise<readonly ComplianceSubmissionCandidate[]>;

  /**
   * Appends ONE row to compliance_document_transitions. The DB trigger
   * derives document_status, submission_attempt_no (incremented ONLY when
   * toStatus is 'SUBMITTED'), submitted_at, settled_at and last_error from
   * this row; this method never updates compliance_documents directly.
   */
  recordTransition(
    tenantId: string,
    input: {
      readonly complianceDocumentId: string;
      readonly orderId: string;
      readonly fromStatus: ComplianceDocumentStatus;
      readonly toStatus: ComplianceDocumentStatus;
      readonly reason?: string;
      readonly actorUserId?: string | null;
    },
  ): Promise<void>;

  /**
   * Direct UPDATE on compliance_documents.next_retry_at. Permitted because
   * the derived-status guard trigger only watches document_status; must be
   * called only after recording a FAILED -> RETRY transition for a
   * retryable error, never for permanent or ambiguous errors.
   */
  scheduleRetry(tenantId: string, complianceDocumentId: string, nextRetryAt: Date): Promise<void>;

  /** Clears next_retry_at on claim or on a successful SUBMITTED transition. */
  clearRetry(tenantId: string, complianceDocumentId: string): Promise<void>;
}

export interface ComplianceDocumentStore {
  /** Runs fn in one tenant-scoped transaction, mirroring OrdersStore.run. */
  run<T>(tenantId: string, fn: (scope: ComplianceDocumentTxScope) => Promise<T>): Promise<T>;
}
