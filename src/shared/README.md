# shared — cross-cutting primitives

Imports nothing from any other layer (enforced by ESLint).

Planned modules (Phase 1 / 4):
- `money.ts` — `Money` value type: **BigInt minor units**, never `number`/float.
  Same-currency guard on every add/subtract (`CurrencyMismatchError`).
  `pg` drivers are configured to return `BIGINT`/`NUMERIC` as strings, never JS numbers.
  Single documented rounding rule (round-half-to-even) reused by every engine.
- `crypto-params.ts` — the one place scrypt cost parameters live
  (`N = 16384`, `r = 8`, `p = 1`, salt ≥ 16 bytes). No literal numbers at call sites.
- `errors.ts`, `result.ts` — typed error / result primitives.
- audit `snapshot()` helper — strips any column ending in `_hash`, `_pepper`,
  `_secret` before a before/after snapshot is taken (Phase 4).

Time: every timestamp column is `timestamptz` in **UTC**. `branches.timezone`
is display-only (reporting/presentation) and never affects stored values.
