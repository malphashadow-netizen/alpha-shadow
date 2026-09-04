# ADR-0001 — Toolchain versions (Phase 0)

Status: accepted · Date: 2026-09-04

Every version in `package.json` is pinned exactly (`.npmrc: save-exact=true`)
and `engine-strict=true` makes a wrong Node version fail `npm ci` instead of
warning. Any deviation from a number in this table requires a new ADR entry —
never a silent bump.

| Tool                | Pinned          | Reference (spec v4) | Note |
| ------------------- | --------------- | ------------------- | ---- |
| Node.js             | `^24.0.0`       | 24.x                | `.nvmrc = 24`; CI uses `actions/setup-node` with `node-version-file`. |
| TypeScript          | `6.0.3`         | 6.0.3               | See "Corrections" below. |
| Vitest              | `5.0.0`         | 5.0.0               | See "Corrections" below. |
| Vite                | `8.2.2`         | —                   | Vitest 5 declares `vite` as a **required** peer (`peerDependenciesMeta.vite.optional = false`), so it is pinned explicitly rather than left to npm's auto-install. |
| ESLint              | `10.10.0`       | 10.0.0              | **Deliberate bump.** 10.10.0 was the `latest` dist-tag at scaffold time; 10.0.0 → 10.10.0 is a patch/minor range with no breaking changes in the flat-config API we use (`defineConfig`, `globalIgnores`). The bump was applied without a note in the first report — this ADR closes that documentation gap. |
| typescript-eslint   | `8.69.0`        | 8.x                 | Peer range `typescript >=4.8.4 <6.1.0` — satisfied by 6.0.3. |
| @eslint/js          | `10.0.1`        | —                   | Companion to ESLint 10. |
| pg / @types/pg      | `8.23.0` / `8.23.1` | —               | Raw node-postgres; no ORM by design (see spec: transaction lifecycle must stay under `withTenantContext()`). |
| @types/node         | `24.13.3`       | —                   | The `@types/node` major tracks the Node major, so the pin follows `engines.node` (24.x) — not the registry `latest` tag, which was `26.4.1` (Node 26 typings) at scaffold time and would let code compile against APIs that do not exist on the Node we run; 24.13.3 is the newest release on the 24.x line. |
| embedded-postgres   | `18.4.0-beta.17`| —                   | Test-only. Only pre-release tags are published for PG 17/18 lines. Runs in an isolated child process (see `test/support/embedded-postgres.child.ts`). |

## Corrections to the first Phase-0 report

The first Phase-0 report pinned TypeScript `5.9.3` and Vitest `4.0.18`. Both
were **wrong calls based on an inaccurate diagnosis**, and were reverted to the
agreed versions before the first commit:

1. **TypeScript 5.9.3 → 6.0.3.** The report cited the typescript-eslint peer
   range `<6.1.0` as the reason to avoid TypeScript 7.x — which is true — but
   then dropped to 5.9.3 instead of staying on 6.0.3, which sits inside that
   range. A clean install of `typescript@6.0.3 + typescript-eslint@8.69.0 +
   eslint@10.10.0` succeeds (`tsc --version → Version 6.0.3`), and the full
   lint/build/test suite passes on it. There was no technical reason for 5.9.3.

2. **Vitest 4.0.18 → 5.0.0.** While bisecting an `npm install` failure the
   report concluded "Vitest" was the problem. The actual failure is an npm 10
   Arborist bug (`TypeError: Cannot read properties of null (reading 'edgesOut')`
   in `@npmcli/arborist/lib/arborist/build-ideal-tree.js #loadPeerSet`) that is
   triggered by the peer-dependency graph of **vitest 4.1.x specifically**.
   Raw evidence gathered afterwards:

   | Command (fresh dir)                                   | Node    | npm    | Result |
   | ----------------------------------------------------- | ------- | ------ | ------ |
   | `npm i -D vitest@4.1.11`                               | 22.22.3 | 10.9.8 | ✗ `edgesOut` |
   | `npm i -D vitest@4.1.11`                               | 24.20.0 | 10.9.8 | ✗ `edgesOut` (Node version is irrelevant) |
   | `npm i -D vitest@4.1.11`                               | 22.22.3 | 12.0.2 | ✓ (npm bug fixed in newer npm) |
   | `npm i -D vitest@5.0.0`                                | 22.22.3 | 10.9.8 | ✓ |
   | `npm i -D vitest@4.0.18`                               | 22.22.3 | 10.9.8 | ✓ |

   So Vitest 5.0.0 never had the problem; downgrading was unnecessary. The
   project uses 5.0.0 as agreed. (Vitest 5 requires `node ^22.12.0 || ^24.0.0 || >=26.0.0`.)

## Local-sandbox caveat (does not change the decision)

The development sandbox used for Phase 0 ships Node 22.22.3 and cannot reach
nodejs.org. Node 24.20.0 was obtained through the `node` npm package (binary
only) to run the gates under the agreed engine. GitHub-hosted runners install
Node 24 natively via `actions/setup-node`, so CI is unaffected by this caveat.
