# DD-005 execution plan

This is the first document to read before continuing DD-005 work.

## Preflight (read-only)

Run this query before a production migration. It reports code-purpose conflicts,
purposes assigned to unexpected codes, branch currencies missing from the
registry, and duplicate account purposes.

```sql
WITH expected(code, purpose) AS (
  VALUES
    ('1200', 'inventory_asset'),
    ('1300', 'cost_of_goods_in_process'),
    ('5000', 'cost_of_goods_sold'),
    ('5100', 'waste_expense'),
    ('5200', 'purchase_price_variance'),
    ('5300', 'inventory_variance')
)
SELECT 'code_purpose_conflict' AS issue, a.tenant_id, a.code, a.system_purpose
FROM accounts a
JOIN expected e ON e.code = a.code
WHERE a.system_purpose IS DISTINCT FROM e.purpose
UNION ALL
SELECT 'purpose_on_unexpected_code', a.tenant_id, a.code, a.system_purpose
FROM accounts a
JOIN expected e ON e.purpose = a.system_purpose
WHERE a.code IS DISTINCT FROM e.code
UNION ALL
SELECT 'unknown_branch_currency', b.tenant_id, b.base_currency, NULL
FROM branches b
LEFT JOIN currencies c ON c.code = b.base_currency
WHERE c.code IS NULL
UNION ALL
SELECT 'duplicate_system_purpose', a.tenant_id, a.system_purpose, count(*)::text
FROM accounts a
WHERE a.system_purpose IS NOT NULL
GROUP BY a.tenant_id, a.system_purpose
HAVING count(*) > 1;
```

## Seven phases

1. **Phase 0 — foundation: complete.** Migration 0067 seeds account purposes,
   creates one disabled system accounting user per tenant, adds rate provenance,
   installs the branch currency foreign key, and revokes PUBLIC execution from
   its seed functions; `test/contract/dd005-exchange-rate-barriers.test.ts`
   proves the live SQLSTATE `42501` denial.
2. **Phase 1 — purchase evidence: pending.** Define immutable receiving and
   supplier-cost facts; do not infer cost from quantity movements.
3. **Phase 2 — valuation policy: pending.** Approve FIFO or weighted-average
   behavior, negative-stock rules, and backdating treatment.
4. **Phase 3 — cost allocation: pending.** Model immutable cost layers or
   average snapshots and their links to inventory movements.
5. **Phase 4 — posting: pending.** Post balanced inventory, COGS, waste, and
   variance journals from approved immutable evidence.
6. **Phase 5 — reporting: pending.** Build fail-closed market-rate reporting
   and reconciliation views.
7. **Phase 6 — rollout: pending.** Rehearse preflight, migrate production,
   reconcile opening balances, and monitor the first close.
