/**
 * Dynamic catalog / menu engine — Phase 5.
 *
 * Categories, items, modifiers, languages and availability windows are data.
 * Money is BigInt minor units via `src/shared/money.ts`. Referenced rows are
 * archived (`is_active = false`), never physically deleted.
 */
export {
  CatalogEngine,
  type CatalogEngineDependencies,
  type BranchMenu,
  type CreateCategoryInput,
  type CreateItemInput,
  type CreateModifierGroupInput,
  type CreateModifierInput,
  type ResolvedCategoryNode,
  type ResolvedMenuItem,
  type ResolvedModifier,
  type ResolvedModifierGroup,
  type SetBranchOverrideInput,
  type UpdateCategoryInput,
  type UpdateItemInput,
  type UpdateModifierGroupInput,
  type UpdateModifierInput,
} from './catalog-engine.ts';
export {
  isWithinAvailabilitySchedule,
  parseAvailabilitySchedule,
  type AvailabilitySchedule,
  type AvailabilityWindow,
} from './availability.ts';
