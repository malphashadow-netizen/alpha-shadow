# domain — pure core

Entities and contracts (ports) only. **Zero dependencies**: no third-party
packages, no `node:` built-ins — enforced by `eslint.config.ts`
(`no-restricted-imports`) and `test/unit/architecture/layering.test.ts`.

- `contracts/` — repository interfaces (`IPermissionReadRepository`, …),
  `AbacContext`, the `sec_v` derivation contract. *(Phase 2)*
- `entities/` — tenant, branch, user, role, … *(Phase 1+)*
