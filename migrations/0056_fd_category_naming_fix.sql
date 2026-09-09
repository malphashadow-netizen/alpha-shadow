-- Migration 0056 — fixes a naming drift introduced by 0055: 'orders' (plural)
-- vs the established 'order' (singular) convention (0026, 0031, 0033...).
-- category is an unconstrained text column consumed by nothing at runtime —
-- this is cosmetic/registry-hygiene only, never a behavioral change.
UPDATE permissions_registry
SET category = 'order'
WHERE key IN ('order:item:transition', 'order:workflow:admin')
  AND category = 'orders';
