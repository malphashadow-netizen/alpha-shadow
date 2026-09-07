/** Data-driven taxation only; no ZATCA formatting, signing or recalculation. */
export { TaxResolutionEngine, resolveInvoiceAndSnapshot, isExternalTaxLiability, type TaxResolutionEngineDependencies } from './tax-resolution-engine.ts';
export { calculateCascadingTaxes, type ApplicableTax, type TaxComputationPlan } from './cascading.ts';
export { PlatformTaxAdminEngine } from './platform-tax-admin-engine.ts';
export { TenantTaxAdminEngine, type TenantTaxAdminDependencies } from './tenant-tax-admin-engine.ts';
export type { ResolvedTaxLine, ExternalTaxLiabilityMarker, TaxResolution, TaxResolutionTransaction, TaxSnapshotReader } from '../../../domain/contracts/tax.ts';
