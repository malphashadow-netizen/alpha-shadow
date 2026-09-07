# domain — pure core

Entities and contracts (ports) only. **Zero dependencies**: no third-party
packages, no `node:` built-ins — enforced by `eslint.config.ts`
(`no-restricted-imports`) and `test/unit/architecture/layering.test.ts`.

- `contracts/` — repository interfaces (`IPermissionReadRepository`,
  `CatalogRepository`, …), `AbacContext`, the `sec_v` derivation contract,
  catalog rules (free-key localized text, unbounded category-cycle walk).
- `entities/` — tenant, branch, user, role, … *(Phase 1+)*
