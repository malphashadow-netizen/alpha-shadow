/**
 * Workflow administration (Phase 7) — the tenant-facing configuration surface
 * for tenant_order_workflow_states, implementing the fail-closed modification
 * contract:
 *
 *   * HARD DELETE: always REJECTED while any row — active or archived — in
 *     orders / order_items / order_item_status_events references the state
 *     (application pre-check with an explicit WorkflowStateInUseError, plus
 *     the FK ON DELETE RESTRICT chain as the structural guarantee). There is
 *     no exception: the audit trail is permanent.
 *   * SOFT DISABLE (is_enabled = false): always allowed, at any time — the
 *     state disappears from NEW transition options only; historical orders
 *     that point at it are untouched (same pattern as
 *     tenant_void_reason_kind_settings).
 *   * REORDER (position): always allowed — orders reference the state row id,
 *     never its position.
 */
import type { LocalizedText } from '../../../domain/contracts/catalog.ts';
import type { OrdersStore, TenantWorkflowState } from '../../../domain/contracts/orders.ts';
import { NotFoundError } from '../../../shared/errors.ts';

export interface WorkflowAdminEngineDependencies {
  readonly store: OrdersStore;
}

export interface AddWorkflowStateInput {
  readonly kindCode: string;
  readonly parentKindCode: string | null;
  readonly position: number;
  readonly label: LocalizedText;
}

export class WorkflowAdminEngine {
  private readonly dependencies: WorkflowAdminEngineDependencies;

  constructor(dependencies: WorkflowAdminEngineDependencies) {
    this.dependencies = dependencies;
  }

  async listStates(tenantId: string, enabledOnly = false): Promise<readonly TenantWorkflowState[]> {
    return this.dependencies.store.run(tenantId, (scope) => scope.loadWorkflowStates(tenantId, enabledOnly));
  }

  async ensureWorkflow(tenantId: string, topLevelKinds: readonly { kindCode: string; position: number; label: LocalizedText }[]): Promise<string> {
    return this.dependencies.store.run(tenantId, (scope) => scope.createWorkflow(tenantId, topLevelKinds));
  }

  async addState(tenantId: string, input: AddWorkflowStateInput): Promise<string> {
    return this.dependencies.store.run(tenantId, (scope) => scope.addWorkflowState(tenantId, input));
  }

  /** Always allowed: hides the state from NEW transitions only. */
  async disableState(tenantId: string, stateId: string): Promise<void> {
    await this.dependencies.store.run(tenantId, (scope) => scope.setWorkflowStateEnabled(tenantId, stateId, false));
  }

  async enableState(tenantId: string, stateId: string): Promise<void> {
    await this.dependencies.store.run(tenantId, (scope) => scope.setWorkflowStateEnabled(tenantId, stateId, true));
  }

  /** Always allowed: orders reference the state id, never its position. */
  async reorderState(tenantId: string, stateId: string, position: number): Promise<void> {
    await this.dependencies.store.run(tenantId, (scope) => scope.setWorkflowStatePosition(tenantId, stateId, position));
  }

  /** Fail-closed: rejects while ANY evidence row references the state. */
  async deleteState(tenantId: string, stateId: string): Promise<void> {
    await this.dependencies.store.run(tenantId, async (scope) => {
      const states = await scope.loadWorkflowStates(tenantId, false);
      if (!states.some((s) => s.id === stateId)) {
        throw new NotFoundError(`Workflow state ${stateId} not found for tenant ${tenantId}`);
      }
      await scope.deleteWorkflowState(tenantId, stateId);
    });
  }
}
