# Permission Design Decisions

## Status

- Document status: Approved
- Implementation status: Not implemented unless explicitly stated otherwise
- Scope: Permission ownership, tenant/branch coverage, and deployment-level policy
- Out of scope:
  - No production-code change is authorized by this document alone.
  - No database migration is authorized by this document alone.
  - No change to the existing 24 documented authorization points is implied.
  - No change to `AuthorizationEngine`, `permission-queries.ts`, or current tenant/branch RBAC semantics is implied unless a later implementation task explicitly authorizes it.

## Existing authorization baseline

The existing authorization model remains based on atomic permission keys and role assignments.

A role assignment can cover either the whole tenant:

```text
scope_type = 'tenant'
scope_id = NULL
```

or one specific branch:

```text
scope_type = 'branch'
scope_id = <branch_id>
```

The coverage rules are:

- A tenant-scoped grant covers every branch belonging to that tenant.
- A branch-scoped grant covers only the branch identified by `scope_id`.
- A branch-scoped grant for branch A must never authorize an operation whose trusted resource branch is branch B.
- Tenant isolation remains mandatory in addition to permission coverage.
- Role names are never used as authorization predicates; authorization is based on atomic permission keys.

The deployment/ownership policy below is a separate layer and does not redefine these rules.

## DD-001 — Branch-scoped administration of payment methods

### Related authorization points

- `AUTH-BR-19`: `PaymentMethodsEngine.create`
- `AUTH-BR-20`: `PaymentMethodsEngine.update`

### Decision

The `payments:methods_admin` permission supports tenant-scoped and branch-scoped grants.

A tenant-scoped grant may administer payment methods for every branch belonging to the tenant. It does not bypass tenant isolation.

A branch-A-scoped grant may create, view through protected administration paths, and modify payment methods belonging to branch A. It must not permit the user to:

- create a method for branch B;
- view administrative details for a branch-B method;
- modify a branch-B method;
- move a branch-A method to branch B;
- create or control a tenant-wide method;
- infer whether another branch's method exists from differing errors.

### Trusted resource branch

For creation, the requested branch is present in the input but must be verified as belonging to the active tenant. The verified branch is the authorization resource branch.

For update, the authoritative branch is loaded from the existing payment-method record through tenant context. Authorization must not rely solely on a replacement branch supplied by the caller. A future cross-branch move must require coverage of both source and destination branches, or a tenant-scoped grant.

### Tenant-wide payment-method records

The ordinary branch-administration path does not currently need to create tenant-wide payment-method records. If such records remain representable:

- only a tenant-scoped `payments:methods_admin` grant may create, modify, or delete them;
- a branch-scoped grant never covers a record whose branch is `NULL`;
- operational visibility does not imply administration ownership.

Record scope, grant scope, and operational visibility are separate concepts.

### Authorization matrix

| Grant | Branch-A method | Branch-B method | Tenant-wide method |
|---|---:|---:|---:|
| Tenant-scoped `payments:methods_admin` | Allow | Allow | Allow |
| Branch-A-scoped `payments:methods_admin` | Allow | Deny | Deny |
| Branch-B-scoped `payments:methods_admin` | Deny | Allow | Deny |
| No grant | Deny | Deny | Deny |

All allowances remain subject to active tenant membership, role activity, security-version freshness, tenant isolation, and operation validation.

### Required future tests

Use real engines and repositories to verify:

1. one user has only a branch-A grant;
2. creation in A succeeds and creation in B is rejected;
3. update of an A method succeeds and update of a B method is rejected;
4. a tenant-scoped grant succeeds in A and B;
5. a branch grant cannot administer a tenant-wide method;
6. cross-branch denial does not disclose resource existence.

## DD-002 — Deployment-level ownership policy for catalog price modification

### Status and isolation

This is a separate future backlog item. It must not modify any of the existing 24 authorization points unless a later task explicitly authorizes that scope.

### Decision

Introduce a future tenant-level deployment-policy attribute:

```text
tenants.deployment_mode
```

with two conceptual values:

```text
self_hosted
hosted_subscription
```

The final representation, migration, default, and transition rules require separate approval.

The provisional atomic key is:

```text
catalog:price_write
```

If a canonical key already exists or is selected before implementation, that key must be used. Role names must never substitute for atomic permissions.

Deployment ownership is a layer above ordinary authorization:

```text
Deployment ownership policy
└── determines whether catalog:price_write is grantable/exercisable
    └── ordinary AuthorizationEngine.check
        └── evaluates active grants and branch coverage
```

A dedicated future price-mutation policy boundary must remain isolated from `getApplicableGrants`, `getCoveredPermissionKeys`, `resolveVoidPermissionTier`, current branch fixes, and unrelated permissions.

### Mode: self_hosted

The tenant owns the deployment and controls `catalog:price_write` as an ordinary atomic permission. Authorized tenant permission administrators may grant it tenant-wide, grant it to selected branches or users, revoke it, or grant it to nobody.

- A tenant-scoped grant can modify prices in every tenant branch.
- A branch-A grant can modify only prices whose trusted resource branch is A.
- A branch-A grant cannot modify prices in B.
- Self-hosting does not automatically authorize a user; an active atomic grant is still required.

### Mode: hosted_subscription

Price-modification authority belongs to the operating company above tenant ownership.

For tenant-managed identities:

- the key is absent from tenant role-management UI and metadata;
- tenant role APIs and bulk/import paths reject attempts to grant it;
- ordinary permission rows do not make it exercisable;
- tenant owners cannot bypass the policy through new, cloned, tenant-scoped, or branch-scoped roles;
- the execution policy fails closed regardless of an ordinary tenant RBAC row.

This applies to all tenant-managed users, including tenant owners and branch managers.

If the operating company needs to modify prices, it requires a separately designed platform-operator path. It must not use a role-name check, ordinary tenant role, tenant-context bypass, or direct unrestricted pool access. That design must define the platform principal, authentication, atomic platform permission, target tenant and branch binding, tenant-context entry, audit evidence, separation of duties, consent, and revocation.

Until that path exists, hosted mode denies price modification to tenant-managed users and provides no implicit operator bypass.

### Enforcement boundaries

A future implementation must enforce the policy at:

1. permission discovery/UI metadata;
2. every role/grant mutation path, including bulk/import;
3. the price-mutation execution boundary;
4. a separately evaluated database structural backstop;
5. immutable audit recording of the effective deployment mode and authorization route.

UI hiding alone is not a security control. Protected price values must continue to use the project's integer money representation and never floating point.

### Fail-closed behavior and mode transitions

A missing, invalid, or unreadable deployment mode must fail closed for protected price mutation.

The default mode for existing tenants is intentionally undecided. A separate migration design must decide it after assessing compatibility and security.

Mode transitions also require a separate policy defining:

- who can change mode;
- whether post-creation changes are allowed;
- whether existing price grants are revoked, disabled, quarantined, or merely non-exercisable;
- whether old grants can return after moving back to `self_hosted`.

Old grants should not reactivate automatically without explicit review.

### Required future tests

For `self_hosted`:

1. a tenant grant works in A and B;
2. a branch-A grant works in A and is rejected in B;
3. no grant is rejected;
4. an authorized administrator can grant and revoke the key.

For `hosted_subscription`:

1. the key is absent from tenant grant metadata;
2. tenant role and bulk/import APIs reject it;
3. a forged or stale role-permission row cannot authorize mutation;
4. tenant owner, tenant manager, and branch manager are rejected;
5. missing or invalid deployment mode fails closed.

Mode-transition tests must wait for the transition policy.

## Deferred item — AUTH-BR-22

`AUTH-BR-22` is the base `order:void` authorization gate.

Current status:

- void-tier resolution is branch-aware;
- actor and manager tier promotion have A/B coverage;
- the initial `AuthorizationEngine.check` for base `order:void` still uses tenant-level context;
- branch-only base `order:void`, without a tenant-wide base grant, has no independent A/B integration test.

Decision:

- Keep `AUTH-BR-22` in the backlog.
- Do not treat the current tier A/B test as coverage for the base gate.
- Before production changes, add an independent test with one user, only a branch-A `order:void` grant, no tenant-scoped base grant, a target in A, a target in B, and independent expectations that A is allowed and B is denied.
- This document authorizes no implementation change.

## Non-goals

This document does not authorize:

- hardcoded role-name checks;
- bypassing tenant context;
- direct pool access for tenant data;
- changing RLS policy;
- modifying the existing 24 authorization points;
- adding `deployment_mode` or `catalog:price_write` immediately;
- changing payment-method behavior immediately;
- creating an implicit platform-operator bypass;
- changing money representation or price arithmetic.
