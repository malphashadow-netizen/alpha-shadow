# application — use cases & engines

Depends on `domain` (and `shared`) only. Never imports `infrastructure` or
`presentation` (enforced by ESLint).

Engines live under `engines/`. Every engine is a placeholder until its phase:

| engine         | phase | status  |
| -------------- | ----- | ------- |
| `rbac/`        | 2     | planned |
| `tax/`         | 6     | FUTURE  |
| `catalog/`     | 5     | implemented |
| `orders/`      | 5+    | FUTURE  |
| `payments/`    | 5+    | FUTURE  |
| `inventory/`   | 5+    | FUTURE  |
| `reporting/`   | 4     | implemented |
| `shifts/`      | 5+    | FUTURE  |
| `zatca/`       | 12    | FUTURE  |
| `kds/`         | 5+    | FUTURE  |
| `integrations/`| 5+    | FUTURE  |

Rule for every future engine: any permission that touches sensitive money
flows (`order:void`, `payment:refund`, …) is registered in
`permissions_registry` with `is_sensitive = true` from the moment it is
created, so it automatically gets L1-cache bypass + mandatory audit logging.
