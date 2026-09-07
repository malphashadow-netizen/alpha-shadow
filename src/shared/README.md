# shared — cross-cutting primitives

Imports nothing from any other layer (enforced by ESLint).

Implemented modules (Phase 1 / 4):
- `money.ts` — `Money` value type: **BigInt minor units**, never `number`/float.
  Same-currency guard on every add/subtract (`CurrencyMismatchError`).
  `pg` drivers are configured to return `BIGINT`/`NUMERIC` as strings, never JS numbers.
  `convertMoneyAtRate()` is the sole Money × NUMERIC-rate operation and uses
  round-half-even exactly once for the target currency's minor-unit scale.
- `errors.ts`, `result.ts` — typed error / result primitives.
- `audit-snapshot.ts` — the single recursive before/after snapshot boundary;
  omits `_hash`, `_pepper`, `_secret` suffixes and exact `password`, `pin`,
  `secret` names before commercial audit rows are written.

Planned modules (future phases):
- `crypto-params.ts` — the one place scrypt cost parameters live
  (`N = 16384`, `r = 8`, `p = 1`, salt ≥ 16 bytes). No literal numbers at call sites.

Time: every timestamp column is `timestamptz` in **UTC**. `branches.timezone`
is display-only (reporting/presentation) and never affects stored values.
