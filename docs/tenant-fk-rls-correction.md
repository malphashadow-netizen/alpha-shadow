# Tenant foreign keys and row-level security

This note corrects historical commentary without rewriting already-applied
migrations.

## Correction to migrations 0037 and 0040

The comments in `0037_phase9_inventory_items.sql` and
`0040_phase9_stock_movements.sql` say that a branch foreign-key check runs
under the caller's row-level-security policy. That statement is technically
incorrect: PostgreSQL referential-integrity checks bypass row security so that
RLS cannot hide a referenced row from an FK check. A single-column reference to
`branches(id)` therefore proves that the branch exists, but does not prove that
the referencing row has the same `tenant_id`.

Migration `0069_dd006_branch_tenant_composite_fk.sql` supplies that structural
same-tenant guarantee for `inventory_items` through
`FOREIGN KEY (branch_id, tenant_id) REFERENCES branches (id, tenant_id)`.

For `stock_movements`, the effective same-tenant branch protection is the
explicit check inside `validate_stock_movement()`: before insertion, it queries
`branches` with both `NEW.branch_id` and `NEW.tenant_id` and raises SQLSTATE
`23514` when no matching row exists. The protection does not come from the
single-column `stock_movements.branch_id` foreign key.
