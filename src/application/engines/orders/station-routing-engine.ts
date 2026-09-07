/**
 * Station-routing engine (Phase 7, spec 2.2).
 *
 * Resolves the preparation station for an order item from the branch's
 * station_routing_rules. Fail-closed: if NO enabled rule matches, the item is
 * REFUSED — there is no default and no random station. Partial bump support
 * comes from item-level station assignment: each station only ever bumps its
 * own items.
 *
 * DETERMINISTIC TIE-BREAK (the named design decision, implemented verbatim in
 * the adapter's SQL and mirrored by STATION_ROUTING_SPECIFICITY_WEIGHTS in
 * the domain contract):
 *
 *   ORDER BY specificity_score DESC, priority_weight DESC, rule_id ASC
 *
 *   specificity_score = 100·(menu_item matched) + 20·(sales_channel matched)
 *                     + 10·(order_type matched)
 *
 * A NULL criterion is an explicit wildcard that adds nothing. The weights
 * guarantee any higher dimension outranks any combination of lower ones
 * (100 > 20 + 10, 20 > 10). priority_weight is the tenant's explicit
 * tie-break; rule_id ASC is the final deterministic tie-break, so exactly one
 * reproducible winner ALWAYS exists.
 */
import type { OrdersStore, StationRoutingContext, StationRoutingDecision } from '../../../domain/contracts/orders.ts';
import { NoMatchingRoutingRuleError } from '../../../shared/errors.ts';

export interface StationRoutingEngineDependencies {
  readonly store: OrdersStore;
}

export class StationRoutingEngine {
  private readonly dependencies: StationRoutingEngineDependencies;

  constructor(dependencies: StationRoutingEngineDependencies) {
    this.dependencies = dependencies;
  }

  async route(tenantId: string, branchId: string, context: StationRoutingContext): Promise<StationRoutingDecision> {
    return this.dependencies.store.run(tenantId, async (scope) => {
      const decision = await scope.resolveStationRoute(tenantId, branchId, context);
      if (decision === null) {
        throw new NoMatchingRoutingRuleError(branchId, context.menuItemId);
      }
      return decision;
    });
  }
}
