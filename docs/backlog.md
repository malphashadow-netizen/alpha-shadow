# Backlog / known gaps (Phase 1 hardening)

This document is the single place where deliberate gaps are recorded so they
are visible to reviewers and follow-ups. It is maintained with the code: when a
gap is closed, move its entry to the relevant ADR/spec instead of deleting it
silently.

## Security gaps — tenant isolation layer

### Rate limiting (NOT implemented)
`RateLimitError` exists in `src/shared/errors.ts` (stable code
`rate_limit.exceeded`) but **no enforcement middleware exists yet**. There is
no per-tenant, per-IP or per-account request budget; the error type is a
contract for future engines to throw. A release that exposes authentication or
any tenant-facing endpoint MUST not be marked "tenant isolation complete"
until a rate-limiter (token bucket + distributed store) lands.

### Kill switch (NOT implemented)
There is **no global kill switch** (e.g. disable a tenant / disable tenant
access wholesale via a `tenants.status` revocation that immediately surfaces to
every connection). The `tenants.status` column introduced in migration 0002 is
only a data placeholder — `withTenantContext` does not read it today. A future
change must resolve tenant status ONCE per operation inside the same
transaction as the tenant-id check (never in a separate request).

### Circuit breaker / backoff (LOW priority)
`withTenantContext` currently surfaces every failure to the caller. A circuit
breaker (open on N consecutive tenant-isolation/DISCARD failures, exponential
backoff, half-open probe) is planned but deliberately deferred: the current
pool already bounds concurrency, and statement_timeout bounds in-flight time.
Tracked here; revisit when repositories exist.

## Money backlog

### FX conversion (NOT implemented)
`src/shared/money.ts` has **no currency conversion function**. Cross-currency
math is a deliberate bug: every operation enforces same-currency and throws
`CurrencyMismatchError`. Implementing FX requires: mid-market rate table with
`as_of` timestamps, spread policy, rounding at the converted minor unit (using
`minorUnitScale`), and audit. All cross-currency requirements must go through a
future `converted(amount, from, to, rate)` in money.ts — never inline.

### allocate() rounding model (implemented — documented)
`allocate()` uses an exact, deterministic Fowler-style distribution (each
bucket gets `trunc(total / parts)` and the leading `|remainder|` buckets get
±1). It deliberately does **not** perform per-bucket banker's rounding; the
remainder is distributed as whole minor units so the total is always exact.

## Tooling debt

### ESLint config: migrate to `.ts`
`eslint.config.js` is intentionally JavaScript while the pinned ESLint 10 /
jiti < 2.2.0 chain has a known loader issue with `.ts` configs. Returning to a
type-checked `eslint.config.ts` is tracked tech debt; all policy already lives
in `eslint-rules/*.ts`, so the migration is mechanical. Re-evaluate on every
toolchain bump (ADR-0001).

### pool.ts `asText` identity parser
The int8/numeric type parsers use an inline identity arrow (`(value: string) => value`)
with a comment. The previous named `asText` helper was removed — the point is
the identity parser itself, which the comment explains.

### Pool singleton entry points
`getPool()`, `ensureSharedPool()` and `acquireDbClient()` all resolve through
ONE memoised lazy promise (`sharedPoolPromise ??= Promise.resolve().then(createSharedPool)`).
There is no synchronous variant and no swallowed rejection: a configuration
failure rejects the same promise for every consumer (verified by
`test/unit/infrastructure/pool.test.ts`). If a synchronous acquisition is ever
needed again, it must not introduce a second error path.

### 500-class error redaction
`toErrorResponse()` returns the constant `"Internal server error"` for every
500-class code (`config.invalid`, unknown domain codes, non-domain errors) and
delivers the detailed error only to the injectable `ErrorLogSink` (default
`console.error`). This keeps connection-string/credential fragments inside
`ConfigurationError` messages server-side. Composition roots may replace the
default sink with a structured logger.

### exactOptionalPropertyTypes
`tsconfig.base.json` sets `"exactOptionalPropertyTypes": true` (verified with
`npm run typecheck`). All option bags in `pool.ts` / `tenant-context.ts` use
conditional spread (`{ ...base, ssl: options.ssl }` when defined) to stay
compatible with it. Any new option bag must follow the same pattern.

## Pool capacity

`src/infrastructure/db/pool.ts` sizes the shared pool with:

```
max = max(1, floor((DATABASE_MAX_CONNECTIONS - 5) / APP_INSTANCES))
```

- `DATABASE_MAX_CONNECTIONS` defaults to 100 (PostgreSQL default), override in
  production to the server's real `max_connections`.
- `APP_INSTANCES` defaults to 1; set it to the number of app replicas.
- The 5-connection headroom reserves room for administrative/replica
  connections and the migration client.
- Formula and guards are unit-tested; production boot also refuses URLs that
  are the known default superuser DSN or lack `sslmode=require`-family.
