/**
 * Separate administrative command interface. Mount ONLY behind the existing
 * authentication/CSRF boundary. Actor comes from verified auth middleware,
 * never the request body. A generic catalog command cannot invoke excise.
 */
import type { TenantTaxAdminEngine } from '../../application/engines/tax/tenant-tax-admin-engine.ts';
import { EXCISE_CONFIRMATION_TEXT, type TenantTaxActor } from '../../domain/contracts/tenant-tax-admin.ts';
import { AuthorizationError, toErrorResponse, ValidationError, type ErrorLogSink } from '../../shared/errors.ts';

export interface TaxAdminRequest {
  readonly actor: TenantTaxActor | null;
  readonly body: unknown;
}
export interface TaxAdminResponse {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}
export type TaxAdminHandler = (request: TaxAdminRequest) => Promise<TaxAdminResponse>;
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Expected an administrative command object');
  return value as Record<string, unknown>;
}
function text(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '') throw new ValidationError(`${key} must be a non-empty string`, key);
  return value;
}
function uuid(body: Record<string, unknown>, key: string): string {
  const value = text(body, key);
  if (!/^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(value)) throw new ValidationError(`${key} must be a UUID`, key);
  return value.toLowerCase();
}
export interface TenantTaxAdminHandlers {
  readonly confirmationPrompt: Readonly<{ confirmationText: string; automaticAssignmentAllowed: false }>;
  readonly assignAdditionalCategory: TaxAdminHandler;
  readonly setBranchOverride: TaxAdminHandler;
  readonly confirmExciseAssignment: TaxAdminHandler;
  readonly confirmExciseBranchOverride: TaxAdminHandler;
  readonly setVatRegistration: TaxAdminHandler;
}
export function createTenantTaxAdminHandlers(engine: TenantTaxAdminEngine, log?: ErrorLogSink): TenantTaxAdminHandlers {
  const command = (fn: (actor: TenantTaxActor, body: Record<string, unknown>) => Promise<void>): TaxAdminHandler => async (request) => {
    try {
      if (request.actor === null) throw new AuthorizationError('Authentication required');
      const body = object(request.body);
      // Reject identity spoofing instead of silently accepting misleading input.
      if ('tenantId' in body || 'userId' in body || 'actor' in body) throw new ValidationError('Identity must come from authenticated middleware');
      await fn(request.actor, body);
      return { status: 200, body: { ok: true } };
    } catch (error) {
      const mapped = toErrorResponse(error, log);
      return { status: mapped.status, body: { code: mapped.code, message: mapped.message } };
    }
  };
  return {
    confirmationPrompt: Object.freeze({ confirmationText: EXCISE_CONFIRMATION_TEXT, automaticAssignmentAllowed: false }),
    assignAdditionalCategory: command(async (actor, body) => engine.assignAdditionalCategory(actor, uuid(body, 'menuItemId'), uuid(body, 'taxCategoryId'))),
    setBranchOverride: command(async (actor, body) => engine.setBranchOverride(actor, {
      branchId: uuid(body, 'branchId'), menuItemTaxCategoryId: uuid(body, 'menuItemTaxCategoryId'), overrideTaxCategoryId: uuid(body, 'overrideTaxCategoryId'),
    })),
    confirmExciseAssignment: command(async (actor, body) => {
      const slot = text(body, 'slot');
      if (slot !== 'primary' && slot !== 'additional') throw new ValidationError('Invalid assignment slot');
      await engine.confirmExciseAssignment(actor, { menuItemId: uuid(body, 'menuItemId'), taxCategoryId: uuid(body, 'taxCategoryId'),
        slot, confirmation: text(body, 'confirmation') });
    }),
    confirmExciseBranchOverride: command(async (actor, body) => {
      const items = body['confirmedMenuItemIds'];
      if (!Array.isArray(items) || items.length === 0) throw new ValidationError('Explicit affected menu item list required');
      const ids = items.map((id: unknown) => uuid({ id }, 'id'));
      await engine.confirmExciseBranchOverride(actor, { branchId: uuid(body, 'branchId'),
        menuItemTaxCategoryId: uuid(body, 'menuItemTaxCategoryId'), overrideTaxCategoryId: uuid(body, 'overrideTaxCategoryId'),
        confirmedMenuItemIds: ids, confirmation: text(body, 'confirmation') });
    }),
    setVatRegistration: command(async (actor, body) => {
      const status = text(body, 'status');
      if (status !== 'registered' && status !== 'unregistered') throw new ValidationError('Invalid VAT registration status');
      const value = body['number'];
      if (value !== null && typeof value !== 'string') throw new ValidationError('Registration number must be text or null');
      await engine.setVatRegistration(actor, status, value);
    }),
  };
}
