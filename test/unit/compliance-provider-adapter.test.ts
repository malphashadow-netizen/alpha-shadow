import { describe, expect, it, vi } from 'vitest';

import type { ComplianceArtifactStore } from '../../src/domain/contracts/compliance.ts';
import { InMemoryComplianceProviderAdapter } from '../../src/infrastructure/db/repositories/in-memory-compliance-provider-adapter.ts';

describe('compliance provider adapter', () => {
  it('submits a document with stable artifact data and exposes its saved status', async () => {
    const putArtifact = vi.fn(async (_payload: Uint8Array) => ({
      artifactReference: 'artifact/invoice-1',
      artifactHash: 'sha256:fixed-hash',
    }));
    const store: ComplianceArtifactStore = {
      putArtifact,
      getArtifact: vi.fn(async () => null),
    };
    const adapter = new InMemoryComplianceProviderAdapter();

    const result = await adapter.submitDocument(
      {
        tenantId: 'tenant-1',
        complianceDocumentId: 'document-1',
        branchId: 'branch-1',
        orderId: 'order-1',
        documentType: 'tax_invoice',
        countryCode: 'SA',
        authorityId: 'authority-1',
        settlementMode: 'synchronous_clearance',
      },
      store,
    );

    expect(result.externalReference).toMatch(/^[0-9a-f-]{36}$/u);
    expect(result.artifactReference).toBe('artifact/invoice-1');
    expect(result.artifactHash).toBe('sha256:fixed-hash');
    expect(result.submittedAt).toBeInstanceOf(Date);
    expect(putArtifact).toHaveBeenCalledOnce();
    expect(await adapter.getStatus('tenant-1', result.externalReference)).toEqual({
      status: 'SUBMITTED',
      lastError: null,
      settledAt: null,
    });
  });
});
