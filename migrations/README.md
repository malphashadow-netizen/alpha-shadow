# Migrations — mandatory template & guardrails

Every `.sql` file in this directory is applied in filename order by
`tools/migrate.ts` (uses `MIGRATION_DATABASE_URL` exclusively) and by the test
harness global setup. `README.md` and `tools/` files are never applied.

## Data seeding: production migrations are schema-only

**Never put `INSERT`/seed rows in `migrations/*.sql`.** Test/probe data (e.g.
`probe-tenant-*`) lives in `test/support/seed.test.sql` and is applied ONLY by
the Vitest harness (`test/support/postgres.global-setup.ts`) on the throw-away
test database. Enforced by tests:

- `test/unit/tools/migration-security.test.ts` scans every `*.sql` in
  `migrations/` and fails if any of them seeds `tenants`.
- `tools/lib/migrate-env.ts` makes `tools/migrate.ts` refuse to run whenever
  `SEED_TEST_DATA=true`, in every environment including `NODE_ENV=production`.
  A production `npm run migrate` therefore applies schema changes only and can
  never plant probe rows.

### The one exception: global reference data (`0007_seed_currencies.sql`)

A migration MAY seed a **global, non-tenant reference registry** whose contents
are identical in every environment and are part of the schema contract rather
than of anybody's data — this includes `currencies` (ISO 4217 codes and
their minor-unit digit counts), permission keys, and the explicit Phase-6 tax
launch registries (see the runbook below). The rules for such a migration:

1. The table has **no `tenant_id`** column (so it is not tenant data and the
   RLS contract does not apply).
2. The rows contain **no environment-specific, tenant, or probe data** — the
   `INSERT INTO tenants` / `probe-tenant` guard above still holds unchanged.
3. The statement uses `INSERT … ON CONFLICT (<pk>) DO NOTHING` — **never
   `DO UPDATE`**. Re-running the migration must be a no-op. An existing row may
   already be referenced by historical rows (e.g. `exchange_rates`) and by
   reports whose rounding scale came from it, so it is never silently rewritten.
4. Correcting an already-seeded currency value is a **new, explicit migration**
   that states the old value, the new value and the reporting impact. Tax rate
   history instead uses the audited `closeAndSupersedeTaxRate` capability;
   never overwrite a rate or reapply seed data to change it.
5. `currencies.minor_unit_digits` must match `ISO_4217_MINOR_UNITS` in
   `src/shared/money.ts` exactly (the single source of truth for rounding
   scale — KWD is 3 digits, not 2). Enforced by
   `test/unit/tools/currency-seed-migration.test.ts` (static, no DB) and
   `test/integration/phase4b-currency-seed.test.ts` (live rows + a real KWD
   conversion through `CurrencyConversionEngine`).

Anything that is not a global reference registry stays out of `migrations/`.

## Mandatory template for tenant-scoped tables (RLS)

Any migration that creates a table with a `tenant_id` column **must** include —
in the same file — the complete block below. `tools/check-migrations.ts` and
`tools/migrate.ts` both fail closed when it is missing:

```sql
CREATE TABLE IF NOT EXISTS some_table (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  ...
);

-- REQUIRED: tenant_id is the RLS/query hot path — always index it.
CREATE INDEX IF NOT EXISTS idx_some_table_tenant_id ON some_table (tenant_id);

ALTER TABLE some_table ENABLE ROW LEVEL SECURITY;
ALTER TABLE some_table FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON some_table
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
```

Global (non-tenant) registries — e.g. `tenants`, `permissions_registry` — do
NOT carry a `tenant_id` column and are therefore out of scope for the RLS
coverage contract. They still need explicit least-privilege grants reviewed in
the PR.

## DROP … CASCADE prohibition (tracking system)

`DROP … CASCADE` performs a recursive delete and is **forbidden** in tracked
migrations unless the file is listed in `migrations/.cascade-approvals.json`
with a reason:

```json
{
  "approvals": {
    "0007_archive_customers.sql": "Confirmed by product/DB owner (2026-09-06): migration is a one-time cleanup of legacy archive schema, dry-run applied on staging."
  }
}
```

The approvals file is tracked in git; `tools/check-migrations.ts` (CI) and
`tools/migrate.ts` (before applying) both reject any unapproved `DROP … CASCADE`.

## Testing a migration

- `npm run check:migrations` — static guard (no database needed).
- `npm test` — integration + contract suites apply all migrations to a real
  PostgreSQL (embedded or `TEST_DATABASE_URL`) and verify the RLS contract on
  every `tenant_id` table.

## migrations/roles/ — manual one-time DBA scripts (NOT part of the migration cycle)

Every `*.sql` file **directly inside** `migrations/` is applied in filename
order by `tools/migrate.ts` (via `MIGRATION_DATABASE_URL`) and by the Vitest
test harness. Files under `migrations/roles/` are deliberately **different**:

- They are **never applied** by `tools/migrate.ts` or the test harness (both
  read only top-level `migrations/*.sql`) and are **not** scanned by
  `tools/check-migrations.ts`.
- They create **cluster-global objects** (`CREATE ROLE`), which is a DBA
  action: a role is shared by every database in the cluster, survives
  per-database schema re-creates, and requires a superuser / `CREATEROLE`
  connection. The regular migrations run with the least-privilege
  `MIGRATION_DATABASE_URL` owner credentials, which must never be able to
  create login roles.
- They are bound to **secrets** (the role password exists only in the
  environment's secret manager). The committed file carries the full attribute
  set + grants but ships **NOLOGIN**; the DBA activates login with an
  `ALTER ROLE app_login WITH LOGIN PASSWORD '<secret>'` step. Never commit a
  real password.
- They are run **once per environment, manually, before the app's first
  deployment**:

  ```bash
  psql "$MIGRATION_DATABASE_URL" -f migrations/roles/001_app_login.sql
  psql "$MIGRATION_DATABASE_URL" -c "ALTER ROLE app_login WITH LOGIN PASSWORD '<secret-from-secret-manager>'"
  ```

| File                         | Object      | Grants                                                                                     |
| ---------------------------- | ----------- | ------------------------------------------------------------------------------------------ |
| `roles/001_app_login.sql`    | role `app_login` (`NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`) | `USAGE` on `public`; `SELECT` on `tenants`; `SELECT, INSERT, UPDATE, DELETE` on `branches`, `users` |
| `roles/002_app_login_rbac.sql` | role `app_login` | `SELECT` on `permissions_registry`; `SELECT, INSERT, UPDATE, DELETE` on `roles`, `role_permissions`, `user_roles` |
| `roles/003_app_audit.sql`    | role `app_audit` (`NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`) — the ONE non-`withTenantContext` connection | `USAGE` on `public`; `EXECUTE` ONLY on `record_auth_attempt(...)` / `count_recent_auth_failures(...)` SECURITY DEFINER functions; `app_login` additionally gets `SELECT, INSERT, UPDATE` on `auth_refresh_tokens` |
| `roles/004_app_login_phase4.sql` | role `app_login` | `SELECT` on `currencies`; `SELECT, INSERT` on `exchange_rates`; `SELECT, INSERT` on `audit_log`; explicit `REVOKE UPDATE, DELETE` on both append-only/immutable tables |
| `roles/005_app_login_catalog.sql` | role `app_login` | `SELECT, INSERT, UPDATE, DELETE` on `menu_categories`, `menu_items`, `branch_menu_item_overrides`, `modifier_groups`, `modifiers`, `menu_item_modifier_groups` (RLS FORCE + `NOBYPASSRLS`) |
| `roles/009_phase8_payments.sql` | role `app_login` | Phase-8 payments surface: `SELECT` on `currency_denominations`; `SELECT, INSERT, UPDATE` on `payment_methods`, `coupons`, `payments`, `shift_reconciliations`; `SELECT, INSERT` on `order_discounts`, `cash_count_details`; full CRUD on `user_discount_limits` |

### Phase 4: multi-currency and commercial audit roles

Migration `0006_phase4_multi_currency_audit.sql` creates the global
`currencies` reference table plus tenant-scoped `exchange_rates` and
`audit_log`. The latter two have ENABLE + FORCE RLS and the standard
`tenant_isolation` policy. `exchange_rates` is append-only and `audit_log` is
immutable at the database trigger boundary; the `app_login` grants in
`roles/004_app_login_phase4.sql` add only SELECT/INSERT and explicitly revoke
UPDATE/DELETE. No currency or rate rows are seeded by production migrations.

`audit_log` is the commercial/business audit trail. It is not
`auth_audit_log`, which remains the separate global login-attempt/rate-limit
ledger from Phase 3.

### Phase 5: dynamic catalog (`0008_phase5_catalog.sql`)

Six tenant-scoped tables (`menu_categories`, `menu_items`,
`branch_menu_item_overrides`, `modifier_groups`, `modifiers`,
`menu_item_modifier_groups`), each with ENABLE + FORCE RLS and the standard
`tenant_isolation` policy. Amounts are `BIGINT` minor units. JSONB `name`
objects accept any language key — there is no language allow-list.
`menu_items.tax_rule_id` is an intentional Phase-6 hook **without** a FK
(see `docs/backlog.md`). Referenced rows are archived (`is_active = false`);
every catalog FK uses `ON DELETE RESTRICT`.

The same migration seeds the global `permissions_registry` keys
`catalog:read`, `catalog:write`, `catalog:archive` (`is_sensitive = false`,
`ON CONFLICT (key) DO NOTHING`). Least-privilege grants for the six tables
are in `roles/005_app_login_catalog.sql`.

`0009_phase5_modifier_single_max.sql` is a hotfix on top of 0008 (0008 is
not rewritten): `modifier_groups_single_max` CHECK requires
`selection_type <> 'single' OR max_selections IS NULL OR max_selections = 1`.

### Phase 4b: the seeded `currencies` registry (`0007_seed_currencies.sql`)

Migration `0006` left `currencies` empty on purpose. `0007_seed_currencies.sql`
adds the six base rows — `SAR 2`, `EGP 2`, `KWD 3`, `USD 2`, `AED 2`, `EUR 2` —
with `ON CONFLICT (code) DO NOTHING` (see the reference-data exception above).
`0006` is not modified; the seed is a separate file applied after it. No RLS
block is added because `currencies` has no `tenant_id`; `app_login` keeps
`SELECT`-only access from `roles/004_app_login_phase4.sql`.

### The `app_audit` role and the `auth_audit_log` RLS exception (Phase 3)

`auth_audit_log` is a **global** table (no `tenant_id`, no RLS) on purpose: a
failed login for a non-existent tenant has no authenticated tenant context. The
audited write/count path is therefore the single sanctioned exception to
"all DB access goes through withTenantContext()". Least privilege is enforced
through the dedicated `app_audit` role (see `roles/003_app_audit.sql`), which
can ONLY call two `SECURITY DEFINER` functions and never touches a table
directly — verified live by `test/contract/auth-audit-role.test.ts`. The full
rationale is in `docs/backlog.md` ("auth_audit_log — the ONE documented
exception").

### Grant decision: does `app_login` need INSERT/UPDATE/DELETE on `tenants`? (2026-09-07)

**No.** `tenants` is the *global registry* (migration 0002) — it has no
`tenant_id` column, so the RLS contract intentionally does not apply to it, and
migration 0002's security note states the app role receives **only SELECT**
(never INSERT/UPDATE/DELETE): tenant creation is a cross-cutting
admin/super-admin operation. `app_login` therefore gets:

- `SELECT` on `tenants` — the read needed by
  `withTenantContext(…, { verifyTenantExists: true })`'s existence probe;
- `SELECT/INSERT/UPDATE/DELETE` on the tenant-scoped row tables `branches` and
  `users` — writes that RLS (`FORCE` + the `tenant_isolation` policy) bounds to
  `current_setting('app.current_tenant_id')`; the role's `NOBYPASSRLS`
  guarantees the app cannot bypass that bound.

If a later phase adds a first-class *self-service tenant creation* flow, the
grant must be revisited (and the RLS/ownership model re-reviewed) — until then,
least privilege stands. Tracked in `docs/backlog.md`.


## Phase 6: 0010–0017 and an explicit two-stage deployment

[Full deployment/runbook and acceptance mapping](../docs/phase6-tax-engine.md).
Migrations 0001–0009 are frozen and are not edited by this phase.

| Migration | Purpose |
| --- | --- |
| 0010 | Global jurisdictions/categories/rates, GIST, no_vat, audited supersession; explicit launch seed |
| 0011 | Channels/platforms/liability intervals, wildcard precedence; no invented marketplace liability rules |
| 0012 | Add **nullable** branch country only; no inferred backfill |
| 0013 | **Separate operator-confirmed** NOT NULL contraction, exclusive lock, fails on any NULL |
| 0014 | Explicit tenant VAT registration state/number |
| 0015 | Tenant-isolated, country/family-checked branch category overrides |
| 0016 | Activate tax_rule_id FK, additional categories, protected excise confirmation and admin permissions |
| 0017 | Immutable tax contexts and multi-row snapshots, parent RLS and completeness checks |

Use `MIGRATION_THROUGH=0012 npm run migrate` for expansion. After a reviewed
cross-tenant manual backfill and legacy tax UUID reconciliation, resume with
`PHASE6_BRANCH_COUNTRY_BACKFILL_CONFIRMED=true npm run migrate`. The runner
will otherwise stop before 0013. No flag can make a remaining NULL pass the
PostgreSQL NOT NULL scan. Even an empty new database requires explicit opt-in;
only the disposable test harness does that automatically.

Run `roles/006_phase6_tax.sql` separately with DBA authority after 0017. It
creates the dormant `platform_tax_admin` capability, grants it only audited
functions for rate writes, and keeps app_login SELECT-only on all global tax
registries. It adds tenant DML/immutable evidence grants and EXECUTE on narrow
confirmed administrative functions. The app still cannot update `tenants`
directly, even for VAT registration.

The existing audit_log gains a scope/ownership CHECK: tenant evidence requires
non-NULL ownership, platform evidence requires NULL ownership. Its tenant
policy alone uses missing-safe equality so a global platform read/write has
no need for a fake tenant GUC. The separate platform policy never exposes
another tenant's rows. The RLS contract explicitly verifies that equality for
this one mixed-scope ledger; the mandatory template stays unchanged elsewhere.

Additional categories/snapshots have no duplicated tenant_id, but use ENABLE +
FORCE RLS through their protected parent. The live Phase-6 contract additionally
checks these tables, not just tables discovered by a tenant_id column.

## Phase 8: 0029–0036 (payments, discounts, shifts)

| Migration | Purpose |
| --- | --- |
| 0029 | `orders.split_people_count` (display only) + `order_items.split_group_id` (light split tag) — both frozen as order-time evidence |
| 0030 | Global `currency_denominations` registry + per-country denomination seed (the documented global-reference exception, same contract as 0007) |
| 0031 | `permissions_registry` cap columns (`max_discount_percentage`/`max_discount_fixed_amount`), keys `order:discount:apply` / `payments:refund` / `payments:void` (all sensitive), and per-user `user_discount_limits` |
| 0032 | `shift_reconciliations` (dual verification CHECKs, one-open-shift-per-cashier index, generated `variance`, immutable after close) + append-only `cash_count_details` with generated `subtotal` and a deferred sum-consistency trigger |
| 0033 | `payment_methods` (foreign currency = cash-only, manual fixed rate whose every change is appended to `exchange_rates` by a trigger) |
| 0034 | `tenants.allow_discount_stacking`, `coupons` (UNIQUE tenant+code), `order_discounts` (append-only; stacking gate, capping ≤ subtotal, mandatory zero-out escalation, per-user cap re-verification, successful Phase-7b override-attempt binding) |
| 0035 | `payments` (open-shift gateway, frozen `exchange_rate_snapshot`, net-of-change base amounts, completed → voided/refunded lifecycle) + the structural `recorded_cash_sales` verification at Z-Report close |
| 0036 | `manager_override_attempts.context_type` ('void' / 'discount' — backfilled as 'void', then the default is dropped so inserts state it explicitly), the context-scoped evidence index, and the `validate_order_discount` same-context evidence check. The lockout state tables stay cross-context ON PURPOSE (an active lock must not be bypassable by alternating contexts). |

Run `roles/009_phase8_payments.sql` separately with DBA authority after 0035
(same manual provisioning contract as `roles/006`–`roles/008`).

## Phase 9: 0037–0041 (inventory, recipes, stock ledger)

| Migration | Purpose |
| --- | --- |
| 0037 | `inventory_items` (per-branch stock: localized name, free-text `base_unit`, `NUMERIC(18,4)` balance, nullable low-stock threshold, `is_active`) + the global `inventory:read` / `inventory:receive` / `inventory:adjust` (sensitive) permission keys |
| 0038 | `unit_conversions` (tenant-level purchase→base factors; receiving-time use ONLY, never on the order-creation hot path) |
| 0039a | `menu_item_recipes` (real FKs to `menu_items` + `inventory_items`; `quantity_required` always in base units) |
| 0039b | `modifier_recipes` (same shape, real FK to `modifiers`) + the `recipe_ingredients` read view (`UNION ALL`, `security_invoker = true` so the caller's RLS applies — PostgreSQL 18) |
| 0040 | `stock_override_claims` (single-use claim: one override attempt authorizes exactly one order — the PK makes double-claim structurally impossible) + the append-only `stock_movements` ledger (per-kind sign CHECKs, order-link CHECKs, override-scope CHECK) + `validate_stock_movement` (branch match, active actor, inventory-key assertions for manual moves, 0036-shaped override evidence via the claim, the MANDATORY negative-balance gate with `FOR UPDATE` row lock) + `apply_stock_movement` (the ONLY writer of `current_quantity`) + `guard_inventory_item_writes` |
| 0041 | `manager_override_attempts.context_type` widened with `'stock_override'` under an explicit stable CHECK name; lockout tables untouched (cross-context, same rationale as 0036); no new index (the 0036 evidence index already keys on `context_type`) |

Balance design: `current_quantity` carries NO non-negative CHECK on purpose — a
manager-approved sale into shortage legitimately drives it below zero (a
shortage signal for reports). Negativity WITHOUT a `manager_override_id` is
rejected by the trigger itself (`stock: insufficient quantity…`, `23514`,
stable prefix — the orders store maps it to `InsufficientStockError`).

Run `roles/010_phase9_inventory.sql` separately with DBA authority after 0040
(same manual provisioning contract as `roles/006`–`roles/009`).
