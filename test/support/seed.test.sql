-- TEST-ONLY seed data — applied by test/support/postgres.global-setup.ts.
--
-- This file is intentionally OUTSIDE migrations/ so `tools/migrate.ts` can
-- never apply probe tenants to a production database. The Vitest harness runs
-- it after migrations on the throw-away test server (embedded or
-- TEST_DATABASE_URL); `tools/lib/migrate-env.ts` refuses to migrate when
-- SEED_TEST_DATA=true, so even a misconfigured production run cannot pick
-- this file up.
--
-- Idempotent: ON CONFLICT never overwrites an existing tenant.

INSERT INTO tenants (id, name, status)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'probe-tenant-11111111-1111-4111-8111-111111111111', 'active'),
  ('22222222-2222-4222-8222-222222222222', 'probe-tenant-22222222-2222-4222-8222-222222222222', 'active'),
  ('33333333-3333-4333-8333-333333333333', 'probe-tenant-33333333-3333-4333-8333-333333333333', 'active'),
  ('123e4567-e89b-4123-a456-426614174000', 'probe-tenant-123e4567-e89b-4123-a456-426614174000', 'active')
ON CONFLICT (id) DO NOTHING;
