# infrastructure — adapters

Depends on `application`, `domain`, `shared`. Never imports `presentation`.

- `db/tenant-context.ts` *(Phase 1)* — `withTenantContext(tenantId, fn)`:
  the **only** sanctioned entry point to PostgreSQL. Opens `BEGIN`, runs
  `SET LOCAL app.current_tenant_id = $1`, executes `fn`, then `COMMIT`/`ROLLBACK`.
  `DISCARD ALL` is issued on every connection release. No repository may touch
  the `pg.Pool` directly — that is an architecture violation.
- `db/migrations/` — SQL migrations. Every table with `tenant_id` uses the
  mandatory template: `ENABLE` + `FORCE ROW LEVEL SECURITY` and a single
  `FOR ALL … USING (…) WITH CHECK (…)` policy (verified by
  `test/contract/rls-coverage.test.ts` on every CI run).
- `db/repositories/` — Postgres implementations of the domain contracts.
  InMemory implementations exist for unit tests only; a startup guard refuses
  them under `NODE_ENV=production` *(Phase 2)*.

Database access is **raw `pg`** (node-postgres). No ORM: connection and
transaction lifecycle must remain fully under `withTenantContext()`'s control
(`BEGIN` / `SET LOCAL` / `COMMIT` / `DISCARD ALL` explicit). Any query-building
helper considered later must not own the connection or the transaction.
