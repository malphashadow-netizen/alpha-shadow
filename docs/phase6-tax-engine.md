# Phase 6 — Dynamic multi-country tax engine

**Base:** `f4ee79980487ef530508fa88c18b27f12a84f94a`.
Migrations `0001–0009`, the `tax_rule_id` column name, and the ZATCA
placeholder are preserved. A SHA-256 contract test freezes those files.

> **تشغيل الإنتاج:** لا تُستنتج دولة الفرع من العملة أو المنطقة الزمنية.
> يجب إكمال ومراجعة Backfill يدوي لكل الفروع قبل تأكيد الهجرة `0013`.
> لا توجد قواعد مسؤولية تلقائية لمنصات التوصيل، ولا ربط تلقائي للإكسايز.

## Components and ownership

| Component | Responsibility |
| --- | --- |
| `TaxResolutionEngine` | Liability first, categories/overrides, historical rates, deterministic cascading, immutable snapshots |
| `resolveInvoiceAndSnapshot` | Full-invoice rounding/allocation; also supports per-line jurisdictions |
| `PlatformTaxAdminEngine` | Platform reference configuration and audited rate creation/supersession; **no tenantId input** |
| `TenantTaxAdminEngine` | Sensitive RBAC/ABAC-protected assignments, branch overrides, registration and separate excise confirmation |
| `OrderTaxCoordinator` | Reject settlement-net tax bases; create the order line and its tax evidence in one transaction |
| `PostgresTaxSnapshotReader` | Read historical evidence without recalculation (including external-liability context) |
| `presentation/routes/tax-admin.ts` | Separate authenticated administrative command handlers and the explicit confirmation prompt |

The six global registries (`tax_jurisdictions`, `tax_categories`, `tax_rates`,
`sales_channels`, `delivery_platforms`, `tax_liability_rules`) have **no tenant
column and no RLS**. `app_login` has SELECT only. Platform writes use a separate
`PLATFORM_TAX_DATABASE_URL`, a runtime database capability check, a transaction,
and `DISCARD ALL` before pool release. Neither an application role named
“platform_tax_admin” in tenant RBAC nor a fabricated actor UUID grants access
to this database capability.

`branch_tax_category_overrides`, excise confirmation evidence, and
`order_line_tax_contexts` have tenant_id, ENABLE/FORCE RLS and the tenant policy.
Additional item categories inherit RLS through `menu_items`; tax snapshots
inherit RLS through their tax context. Composite foreign keys protect branch
and item tenant ownership independently of RLS's FK behaviour.

### Two deliberate schema additions to close ownership gaps

* `menu_item_excise_confirmations`: immutable, per-product/category evidence,
  with the actor, exact confirmation text and optional branch. It does not
  infer whether a business legally owes excise; the administrator explicitly
  attests to that obligation.
* `order_line_tax_contexts`: an immutable, tax-owned anchor for an order-line
  UUID, customer price/currency, branch/item, effective liability rule/party,
  channel/platform, rounding strategy and transaction time. It preserves the
  marketplace marker and provides snapshot tenant isolation **before the
  orders schema exists**. It is not a replacement order table.

There is no snapshot/context UPDATE or DELETE API or app-role grant; triggers
also reject mutation by a table owner using ordinary DML. A deferred constraint
requires restaurant contexts to have snapshots and marketplace contexts to have
none. Duplicate line creation is an error, not an upsert of historical evidence.

## Rate administration and audit

`createTaxRate` is append-only. The **only exposed rate mutation** is
`closeAndSupersedeTaxRate`. Its database function:

1. Locks the existing rate `FOR UPDATE` and rejects an already superseded row.
2. Requires a new start strictly inside the old interval (after its first day).
3. Closes the old interval on `newStart - 1 day`, linking its successor.
4. Inserts the new rate, preserving any original finite end date.
5. Triggers mandatory auditing of both writes in the **same transaction**.

Intervals are **closed**, `[effective_from, effective_to]`. GIST exclusion
rejects both overlaps and two rates sharing an end/start day. A deferred
successor constraint verifies the same category and adjacent dates. Concurrent
supersession permits exactly one successor. Audit failure rolls everything
back. Old snapshots never change, even when a rate's end date is later closed.

Rate values/identity cannot be edited, rates cannot be deleted, and category
identity (including country, kind, family and priority) is frozen to prevent
indirect bypasses of historical meaning, no_vat or excise consent. Categories
can be activated/deactivated; structural changes require a new category.
`no_vat` requires zero bps, no end date and no successor. Zero-rated and exempt
categories also require zero bps while retaining their distinct legal kinds.

### Global entries in the existing `audit_log`

The Phase-4 ledger originally required a tenant for every row. Phase 6 adds
`scope = 'tenant' | 'platform_tax'` and a CHECK pairing tenant scope with a
non-NULL tenant, platform scope with a NULL tenant. **No fake tenant is seeded.**

The tenant equality policy remains fail-closed, but uses
`NULLIF(current_setting('app.current_tenant_id', true), '')::uuid` for this
mixed-scope ledger only. Without a tenant GUC, no tenant row matches; this
avoids an exception while PostgreSQL evaluates a legitimate global-row policy.
A separate policy permits only the platform capability/schema owner to see
NULL-owned platform evidence. Tenant traffic cannot read or forge platform
rows. Every other tenant_id table keeps the original strict policy template.

Ordinary business objects pass through `appendAuditLogInTransaction` and the
existing `snapshotForAudit` redaction boundary. The SQL audit backstops serialize
only fixed tax-rate/registration/confirmation fields, never arbitrary account
objects or credentials. `auth_audit_log` is unchanged.

## Calculation contract

No jurisdiction, channel, platform, SKU or language allow-list exists in the
tax engine. All decisions come from stored data:

1. Validate branch jurisdiction/currency and channel/platform compatibility.
   Interpret `at` as a calendar date in the **branch timezone**, not the server
   timezone. Read current tenant registration status.
2. Resolve the matching liability rule. An exact platform rule wins over an
   **explicit** NULL-platform wildcard. Missing or ambiguous rules fail closed,
   including on non-delivery channels; there is no default restaurant decision.
3. If marketplace is liable, return `ExternalTaxLiabilityMarker` immediately,
   persist the external context, and do not read item tax assignments or rates.
   The order result has `restaurantTaxInvoiceAllowed: false` and no tax rows.
4. For restaurant liability, collect `tax_rule_id` plus explicit additional
   categories, applying each branch override. The resolved category must be
   active and in the branch country. Overrides cannot switch tax families.
   Missing primary categories, duplicate resolved categories and missing excise
   confirmations are explicit errors.
5. Sort by `cascade_priority ASC, category.id ASC`. Every applied excise
   category must precede every applied VAT category; invalid priorities are
   rejected, not silently reordered by a country-specific rule.
6. Resolve every applicable rate for the local date. Missing rates raise
   `NoApplicableTaxRateError`, never an implicit zero.
7. Each category's working amount is the original amount plus tax from
   **strictly lower** priorities. Equal-priority taxes do not compound each
   other. Apply this category's inclusive/exclusive formula to its working
   amount; record sequence, rate, inclusivity, base, tax and currency.

```text
exclusive: tax = half_up(base  * bps / 10000)
inclusive: tax = half_up(gross * bps / (10000 + bps)); taxable = gross - tax
```

Amounts, intermediate arithmetic and DB money serialization are BigInt/integer
text, never floating point. Negative sale amounts and int8 overflow fail closed;
refund/credit-note lifecycle belongs to a later phase.

**Tax rounding is half-up.** It is separate from the existing half-even FX
rounding in `money.ts`. Do not change tax half-up without legal review.

Inclusivity is applied **per category at its cascade stage**, as specified in
Phase 6, not by globally reversing a combined tax-inclusive bundle. For example,
an exclusive 100% excise on 1000 followed by inclusive 15% VAT uses working
amount 2000 for the VAT extraction: VAT 261, taxable amount 1739. The pricing
adapter must supply the amount with these documented semantics; do not silently
substitute a different interpretation of a bundled gross price.

### Required exclusive cascade example

| Stage | Base (halala) | Rate | Tax (halala) |
| --- | ---: | ---: | ---: |
| Excise, priority 10 | 1000 | 100% | 1000 |
| VAT, priority 50 | **1000 + 1000 = 2000** | 15% | **300** |
| Customer total | | | **1000 + 1000 + 300 = 2300 (SAR 23.00)** |

### `per_line` versus `invoice_total`

* `per_line`: round each category's tax at each line/stage.
* `invoice_total`: supply the **whole invoice** using `createInvoice` or
  `resolveInvoiceAndSnapshot`. Group by rate identity, bps, inclusivity and
  currency at each priority; round the exact aggregate once. Allocate the
  remaining minor units by largest remainder, ties by stable line UUID. The
  allocated lower-priority taxes enter each line's next-stage base.
* Two lines of 10 minor units at 5% produce **2** units with per-line rounding,
  **1** unit with invoice-total rounding. Tests assert this difference.
* Isolated `resolveAndSnapshot`/`createLine` calls for an invoice-total
  jurisdiction raise `InvoiceTaxBatchRequiredError`. Never approximate invoice
  rounding by summing individually rounded snapshots.

## Launch reference data

The supplied configuration is seeded in migrations 0010/0011, with
`effective_from = 2026-09-07`, default **exclusive** prices and `per_line`
rounding. This is an explicit rollout baseline, **not historical legal
coverage**. Earlier dates require reviewed, nonoverlapping historical data.
Seed statements never overwrite existing reference rows.

| Country | Categories / bps | Default currency |
| --- | --- | --- |
| SA | standard 1500; optional confirmed excise_100 10000 | SAR |
| EG | standard 1400; reduced 500; zero_rated 0; exempt 0 | EGP |
| AE | standard 500; zero_rated 0 | AED |
| KW | no_vat 0, open-ended | KWD |

All four requested channels and seven requested delivery platform identifiers
are seeded. Platform entries are initially unscoped (`country_code = NULL`);
that is registry availability, **not** a legal deemed-supplier determination.

**No delivery-app liability rules are invented or seeded.** The platform tax
administrator must enter legally reviewed rules for the actual country,
channel, platform, tenant-registration condition and period. The tests use
explicit fictional marketplace rules to demonstrate both liability outcomes;
those fixture rules are never deployed by migrations.

Non-platform registered-tenant restaurant liability is seeded for the four
jurisdictions, plus an explicit unregistered/no-VAT configuration for KW.
Other unregistered-tenant cases fail closed until their applicable liability
and category configuration is explicitly supplied. VAT registration alone is
never treated as excise registration.

## Separate excise administration

Display the exact `confirmationPrompt` returned by `createTenantTaxAdminHandlers`:

> أنا مُصنِّع/مستورد هذا المنتج ومسجَّل ضريبيًا للإنتاج الانتقائي

* Normal catalog create/update and additional-category commands **reject**
  excise, even if the item is named “energy drink” or has earlier consent.
* `confirmExciseAssignment` requires the exact statement and a fresh, tenant-wide
  sensitive `tax:confirm_excise` permission. It can set primary or additional
  categories. The statement, actor and assignment are stored atomically.
* An excise branch override requires the exact list of all affected products.
  A newly linked product has no implicit consent to the override target and
  fails resolution until explicitly confirmed.
* Database guards prevent ordinary app-role SQL from bypassing these commands;
  the narrow SECURITY DEFINER functions independently check active tenant/user
  and a tenant-wide atomic permission. Their execution remains subject to the
  verified authenticated actor supplied by application middleware. The schema
  owner/DBA is a trusted migration authority, not a tenant-facing principal.
* Ordinary name/description edits preserve a previously confirmed, unchanged
  primary category without requiring another confirmation.

The transport adapter is framework-neutral, matching this engine-only repo; it
is **not a deployed frontend or HTTP server**. Mount it behind the existing
verified-token and CSRF/origin boundary. Identity fields in the body are rejected.
Do not expose the platform composition root through tenant-facing routes.

## Atomic order integration (no premature orders/ZATCA implementation)

```ts
const taxAdministration = new PostgresTenantTaxAdminRepository(withTenantContext);
const catalog = new CatalogEngine({
  catalog: new PostgresCatalogRepository({ withTenantContext }),
  taxAssignments: taxAdministration,
});

const orders = new OrderTaxCoordinator(new PostgresOrderTaxUnitOfWork({
  withTenantContext,
  writeOrderLine: yourTransactionalOrderLineWriter,
}));

const result = await orders.createLine(tenantId, {
  branchId, menuItemId,
  customerAmountMinor: 1000n, currencyCode: 'SAR',
  at: new Date('2026-09-07T10:00:00Z'),
  salesChannel: 'dine_in', deliveryPlatformId: null,
  amountBasis: 'customer_price',
});
```

`yourTransactionalOrderLineWriter(q, tenantId, input)` must use **that supplied
q**, not a pool or nested transaction, and return the ID and actual stored
price/currency/branch/item/basis. The coordinator checks them against the full
customer-facing input. The checkout/channel-pricing integration is responsible
for supplying that truthful customer price; the tax layer cannot reconstruct
an unknown commission or customer price from settlement proceeds.

`BEGIN ISOLATION LEVEL REPEATABLE READ` occurs before tenant/existence reads.
Order creation, context, and all tax snapshots share that transaction. Any
failure rolls everything back, including failure on the second tax row. The
transaction capability expires after its callback. Integration tests use a
**test-only** order table and assert equal PostgreSQL `xmin` values for the
order line, context and both snapshots; production contains no invented order
lifecycle/schema.

Future invoice/ZATCA code must check external liability context before issuing
a restaurant tax invoice, then read the snapshots as evidence. It must not
call the resolver again. `src/application/engines/zatca/index.ts` remains an
unchanged placeholder.

## Deployment: expand → reviewed backfill → contract

1. Back up the database and rehearse on a disposable/staging copy. Use the
   dedicated migration owner URL, never `DATABASE_URL`. These changes have
   **not** been applied to a production database by this implementation.
2. Apply only through the nullable branch country expansion:

   ```bash
   MIGRATION_THROUGH=0012 npm run migrate
   ```

3. In an approved DBA/cross-tenant maintenance session, prepare and review an
   explicit **branch UUID → country code** mapping for every branch, including
   inactive ones. Do not derive it from currency/timezone or assume one country
   for a tenant. For example, after loading a reviewed mapping into a temporary
   `branch_country_backfill(branch_id uuid PRIMARY KEY, country_code char(2))`:

   ```sql
   UPDATE branches AS b
      SET country_code = mapping.country_code
     FROM branch_country_backfill AS mapping
    WHERE b.id = mapping.branch_id;

   SELECT id, tenant_id, name FROM branches WHERE country_code IS NULL;
   -- Must return zero rows across ALL tenants.
   ```

   A normal tenant-bound connection cannot validate a global backfill. Do not
   disable FORCE RLS to work around that; use the approved maintenance authority.
4. Preflight legacy `menu_items.tax_rule_id` values against `tax_categories.id`.
   Migration 0016 validates the FK and **fails** on any obsolete arbitrary UUID.
   Explicitly reconcile these values using reviewed tax-category mappings;
   never silently clear them. NULL remains allowed for draft catalog items,
   but restaurant order acceptance requires a primary category.
5. Only after confirming completion, resume the contract migrations:

   ```bash
   PHASE6_BRANCH_COUNTRY_BACKFILL_CONFIRMED=true npm run migrate
   ```

   0013 takes an exclusive table lock. Even with the flag, **one NULL aborts**
   the migration. Without the flag the runner and SQL both refuse the step.
   To execute 0013 manually, the DBA must set the matching transaction-local
   `app.phase6_branch_country_backfill_confirmed = 'true'` inside BEGIN/COMMIT.
   Keep that operator flag unset outside this explicit rollout step.
6. Provision the grants **manually**, after 0017 and the earlier role scripts:

   ```bash
   psql "$MIGRATION_DATABASE_URL" -f migrations/roles/006_phase6_tax.sql
   ```

   Role creation requires an approved CREATEROLE/DBA connection if the migration
   owner is least-privileged. The platform role ships dormant; activate it with
   a secret-manager credential in that isolated admin service, never in source
   control. Do not grant the platform role to application/tenant principals.
7. Grant the appropriate atomic tenant tax permissions through the existing
   RBAC administration, verify tenant VAT registration numbers explicitly,
   configure reviewed delivery liability rules, assign categories, and obtain
   product-specific excise confirmations where applicable. Only then enable
   restaurant order acceptance. Defaults do not register any business for tax.

The test harness opts in only for its disposable database. The live acceptance
suite separately proves the no-opt-in failure, NULL-row failure, and successful
completed backfill. No production backfill has been inferred or executed.

## Verification and acceptance mapping

`test/integration/phase6-tax.test.ts` names **#1–#14** from the requested
acceptance list. Additional cases cover rate/audit concurrency and rollback,
invoice-total allocation, all country seeds, complete evidence, explicit
wildcards, override consent, wrong price basis and consistent rate reads.

`test/contract/tax-schema.test.ts` checks real catalog constraints and real
least-privilege grants, including RLS on parent-owned tables. Unit tests cover
formulas, large integers, priority ties, calendar boundaries, admin handlers,
capability cleanup, migration gates and the frozen files.

```bash
npm run lint
npm test
npm run build
npm run verify:financial-arithmetic
```

During baseline verification the existing auth concurrency test was observed
to race before any Phase-6 changes (5 versus expected 6 failures). Its test-only
barrier now ensures both real account reads occur before the concurrent wrong
password updates. The real hash verifier and database updates remain in use;
production authentication code was not changed.
