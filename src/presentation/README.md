# presentation — HTTP surface

Outermost layer; may depend on everything inward. Contains middleware
(auth, tenant guard, rate limiting) and routes. *(Phase 3+)*

Rules that apply here from day one:
- `tenantId` is always derived server-side (from the authenticated user's DB
  record), never from client input.
- Responses go through safe DTOs — never a raw DB row. No `password_hash`,
  `pin_hash`, salt or pepper ever leaves the process.
- A missing secret (e.g. `PIN_HASH_PEPPER`) fails closed: the process refuses
  to boot; if somehow reached at request time the answer is `503`, never a
  fallback value.
