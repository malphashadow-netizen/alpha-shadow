-- Audit F-D: human-actor keys that close the workflow-transition / workflow-admin
-- authorization holes. BEFORE this migration NO permission key existed for
-- either path — WorkflowTransitionEngine.transitionItem and the five
-- WorkflowAdminEngine mutations executed with zero authorization gate.
--
--   * order:item:transition — human actors moving an order item along the
--     tenant's effective workflow sequence. NON-sensitive: every granted
--     actor answers the same question (tenant-wide), so the L1 verdict cache
--     applies exactly like order:void and payments:collect.
--   * order:workflow:admin — human actors mutating the workflow DEFINITION
--     (add/disable/enable/reorder/delete states). SENSITIVE: definition
--     changes take effect on the next check — NEVER served from the L1
--     cache, exactly like order:discount:admin and payments:methods_admin.
--
-- Last line of defense (unchanged): the 0046 registry FK makes any grant of
-- an unregistered key impossible, so both engines fail closed even if this
-- migration is skipped — the check rejects with "missing permission".
INSERT INTO permissions_registry (key, category, is_sensitive)
VALUES
  ('order:item:transition', 'orders', false),
  ('order:workflow:admin', 'orders', true)
ON CONFLICT (key) DO NOTHING;
