# alpha-shadow

Multi-tenant, multi-branch, multi-currency cloud POS engine for cafés and
restaurants.

The code is an **engine**: permissions, taxes, catalog, payment methods are
configurable data, never hard-coded. Authorization is always checked against an
atomic permission key (`order:void`) — never a role name — and CI breaks on any
violation.

## Status

| Phase | Scope                                                   | State |
| ----- | ------------------------------------------------------- | ----- |
| 0     | Project scaffold, quality gates, CI, DB test harness    | ✅    |
| 1     | Tenants / branches / users, RLS, `withTenantContext()`  | ⏳    |
| 2     | Dynamic RBAC/ABAC engine, `sec_v`, super-admin guards   | ⏳    |
| 3     | Authentication (password + PIN), JWT, refresh tokens     | ⏳    |
| 4     | Multi-currency, `audit_log`, foundation freeze          | ⏳    |
| 5–14  | Tax, catalog, orders, payments, inventory, reporting, shifts, ZATCA, KDS, integrations | 📐 design only |

## Requirements

- Node.js **24.x** (`engines` is enforced with `engine-strict`; uses built-in
  TypeScript type stripping for tooling — no `tsx`/`ts-node`)
- npm 10+
- Exact toolchain pins and the reasoning behind them: `docs/decisions/0001-toolchain-versions.md`
- PostgreSQL is **not** required locally: integration/contract tests start an
  embedded PostgreSQL 18 automatically. Set `TEST_DATABASE_URL` to use your own
  disposable server instead (see `docker-compose.test.yml`).

## Commands

| Command                       | What it does                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `npm run lint`                | `tsc --noEmit` (strict) → ESLint (incl. custom rule) → AST role-compare guard  |
| `npm run build`               | Compiles `src/` to `dist/`                                                    |
| `npm test`                    | All Vitest projects: `unit`, `integration`, `contract`                        |
| `npm run test:unit`           | Pure tests, no I/O                                                            |
| `npm run test:integration`    | Behaviour against a real PostgreSQL                                           |
| `npm run test:contract`       | Architectural invariants against the real PostgreSQL catalog                  |
| `npm run check:roles`         | Fails if any `src/` file compares a role name to a string literal             |
| `npm run check:roles:selftest`| Proves the guard flags `role === 'ADMIN'` (runs in CI on every build)         |
| `npm run check:migrations`    | Migration security guard: no unapproved `DROP … CASCADE`, RLS template enforced |

## Architecture

Modular monolith, hexagonal. Dependencies point **inward only** (enforced by ESLint):

```
src/
  domain/          pure core — zero dependencies (no pg, no jwt, no node: built-ins)
    contracts/     ports: repositories, AbacContext, sec_v derivation
    entities/
  application/     use cases & engines (rbac, // FUTURE: tax, catalog, orders, …)
  infrastructure/  adapters — db/tenant-context.ts (withTenantContext), migrations, repositories
  presentation/    HTTP middleware & routes
  shared/          money (BigInt minor units), crypto-params, errors, result
test/
  unit/  integration/  contract/  support/
tools/             CI guards (AST role-compare scanner)
eslint-rules/      local ESLint plugin (alpha-shadow/no-role-name-compare)
```

### Non-negotiable constraints (enforced, not advised)

- **No role-name checks.** Two independent guards: ESLint rule
  `alpha-shadow/no-role-name-compare` and `tools/check-role-compare.ts`
  (TypeScript compiler API, ignores `eslint-disable`). Both are CI steps.
- **Tenant isolation.** Every DB access goes through `withTenantContext()`
  (explicit `BEGIN` → transaction-scoped, parameterized
  `set_config('app.current_tenant_id', $1, true)` → tenant-existence check →
  30s `statement_timeout` → `COMMIT/ROLLBACK`; `DISCARD ALL` on every pool
  release). Every `tenant_id` table has RLS `ENABLE` + `FORCE` and one
  `FOR ALL … USING … WITH CHECK …` policy — verified by
  `test/contract/rls-coverage.test.ts` against a **real** PostgreSQL catalog
  on every CI run. No mock path exists. Known gaps (rate limiting, kill
  switch, FX conversion) are tracked in `docs/backlog.md`.
- **Money is `BigInt` minor units**, never float. `NUMERIC(18,8)` for rates.
- **Fail closed.** Missing secrets abort boot; audit-log write failure fails the
  login; unreachable test DB fails the test project instead of skipping it.
- **Least privilege.** `app_login` DB role has no `BYPASSRLS`; a separate
  `app_batch` role exists only for cross-tenant batch jobs.
- **Raw `pg`, no ORM** — the transaction lifecycle must stay explicit.

## CI

`.github/workflows/ci.yml` runs three required jobs: static gates
(typecheck, ESLint, role-guard self-test + scan), build + unit tests, and
integration + contract tests against a `postgres:18-alpine` service container.
