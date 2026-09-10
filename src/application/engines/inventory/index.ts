// Phase 9: manual receiving (the single conversion point in the system) and
// manual stock adjustments. Receiving needs 'inventory:receive'; adjustments
// need the sensitive 'inventory:adjust' (never cached).
export { InventoryEngine } from './inventory-engine.ts';
