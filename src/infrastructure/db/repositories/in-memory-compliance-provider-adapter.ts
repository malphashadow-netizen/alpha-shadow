/* eslint-disable @typescript-eslint/require-await --
 * The InMemory adapter satisfies an ASYNC contract over Map lookups so the
 * application and tests treat test doubles and real providers identically. */
/**
 * InMemory compliance-provider adapter — UNIT TESTS ONLY.
 */
import { randomUUID } from 'node:crypto';

import type {
  ComplianceArtifactStore,
  ComplianceDocumentInput,
  ComplianceProviderAdapter,
  ComplianceStatusResult,
  ComplianceSubmissionResult,
} from '../../../domain/contracts/compliance.ts';

export class InMemoryComplianceProviderAdapter implements ComplianceProviderAdapter {
  readonly #statuses = new Map<string, ComplianceStatusResult>();

  async submitDocument(
    input: ComplianceDocumentInput,
    store: ComplianceArtifactStore,
  ): Promise<ComplianceSubmissionResult> {
    const externalReference = randomUUID();
    const artifact = await store.putArtifact(new TextEncoder().encode(JSON.stringify(input)));
    const result: ComplianceSubmissionResult = {
      externalReference,
      artifactReference: artifact.artifactReference,
      artifactHash: artifact.artifactHash,
      submittedAt: new Date(),
    };

    this.#statuses.set(externalReference, {
      status: 'SUBMITTED',
      lastError: null,
      settledAt: null,
    });

    return result;
  }

  async getStatus(_tenantId: string, externalReference: string): Promise<ComplianceStatusResult> {
    const status = this.#statuses.get(externalReference);
    if (status === undefined) {
      throw new Error(`Unknown compliance submission: ${externalReference}`);
    }
    return status;
  }
}
