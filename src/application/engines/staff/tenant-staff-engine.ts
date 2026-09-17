import type { AuthorizationEngine } from '../rbac/authorization-engine.ts';
import { ValidationError } from '../../../shared/errors.ts';
import type { CreateStaffUserInput, StaffPermissionAssignment, TenantStaffActor, TenantStaffRepository } from '../../../domain/contracts/tenant-staff.ts';
const context = { hasResource: false, actorBranchId: null, resourceBranchId: null, isSensitivePermission: true } as const;
export class TenantStaffEngine {
  constructor(
    private readonly authorization: AuthorizationEngine,
    private readonly repository: TenantStaffRepository,
  ) {}

  private async authorize(actor: TenantStaffActor): Promise<void> {
    await this.authorization.check({
      tenantId: actor.tenantId,
      userId: actor.userId,
      permissionKey: 'staff:manage',
      context,
      ...(actor.tokenSecV === undefined ? {} : { tokenSecV: actor.tokenSecV }),
    });
  }

  async createStaffUser(actor: TenantStaffActor, input: CreateStaffUserInput): Promise<void> {
    await this.authorize(actor);
    if (input.email.trim() === '') throw new ValidationError('email must be non-empty', 'email');
    await this.repository.createStaffUser(actor.tenantId, input);
  }

  async assignPermissions(
    actor: TenantStaffActor,
    userId: string,
    assignments: readonly StaffPermissionAssignment[],
  ): Promise<void> {
    await this.authorize(actor);
    await this.repository.assignPermissions(actor.tenantId, userId, assignments);
  }

  async deactivateStaffUser(actor: TenantStaffActor, userId: string): Promise<void> {
    await this.authorize(actor);
    await this.repository.deactivateStaffUser(actor.tenantId, userId);
  }
}
