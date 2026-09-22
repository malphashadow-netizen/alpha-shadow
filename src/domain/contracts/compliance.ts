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
