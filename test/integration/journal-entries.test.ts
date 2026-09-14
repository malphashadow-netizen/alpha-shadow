import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PaymentsEngine } from '../../src/application/engines/payments/payments-engine.ts';
import type { AuthorizationEngine } from '../../src/application/engines/rbac/authorization-engine.ts';
import { createWithTenantContext, type WithTenantContext } from '../../src/infrastructure/db/tenant-context.ts';
import { PostgresPaymentsStore } from '../../src/infrastructure/db/repositories/postgres-payments-store.ts';
import { testDatabaseUrl } from '../support/database.ts';

const allowAll: Pick<AuthorizationEngine, 'check'> = {
  check: async () => ({ allowed: true, effectiveMaxAmountMinorUnits: null }),
};

describe('payment journal entries', () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  let withOwner: WithTenantContext;
  let withApp: WithTenantContext;
  let payments: PaymentsEngine;
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const branchId = randomUUID();
  const cashierId = randomUUID();
  const openerId = randomUUID();
  const verifierId = randomUUID();
  const shiftId = randomUUID();
  const methodIds = {
    cash: randomUUID(),
    card: randomUUID(),
    bankTransfer: randomUUID(),
  };

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: testDatabaseUrl(), max: 5 });
    await owner.query('INSERT INTO tenants (id, name) VALUES ($1, $2), ($3, $4)', [
      tenantId, 'journal-entries', otherTenantId, 'journal-entries-isolation',
    ]);

    for (const file of [
      '001_app_login.sql', '002_app_login_rbac.sql', '004_app_login_phase4.sql',
      '005_app_login_catalog.sql', '006_phase6_tax.sql', '007_phase7_orders.sql',
      '008_phase7_manager_override_rate_limiting.sql', '009_phase8_payments.sql',
      '010_phase9_inventory.sql', '015_payment_journal.sql',
    ]) {
      await owner.query(await readFile(new URL(`../../migrations/roles/${file}`, import.meta.url), 'utf8'));
    }

    const appPassword = randomBytes(24).toString('hex');
    await owner.query(`ALTER ROLE app_login LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    const appUrl = new URL(testDatabaseUrl());
    appUrl.username = 'app_login';
    appUrl.password = appPassword;
    app = new pg.Pool({ connectionString: appUrl.toString(), max: 5 });
    withOwner = createWithTenantContext(owner, { verifyTenantExists: true });
    withApp = createWithTenantContext(app, { verifyTenantExists: true });
    payments = new PaymentsEngine({
      store: new PostgresPaymentsStore({ withTenantContext: withApp }),
      authorization: allowAll,
    });

    await withOwner(tenantId, async (q) => {
      await q.query(
        `INSERT INTO branches (id, tenant_id, name, base_currency, timezone, country_code)
         VALUES ($1, $2, 'Journal branch', 'SAR', 'Asia/Riyadh', 'SA')`,
        [branchId, tenantId],
      );
      for (const [id, email] of [
        [cashierId, 'cashier'], [openerId, 'opener'], [verifierId, 'verifier'],
      ] as const) {
        await q.query(
          `INSERT INTO users (id, tenant_id, email, pin_hash)
           VALUES ($1, $2, $3, 'journal-test-pin')`,
          [id, tenantId, `${email}-${id}@example.test`],
        );
      }

      const workflowId = randomUUID();
      const stateId = randomUUID();
      const categoryId = randomUUID();
      const menuItemId = randomUUID();
      const stationId = randomUUID();
      await q.query('INSERT INTO tenant_order_workflows (id, tenant_id) VALUES ($1, $2)', [workflowId, tenantId]);
      await q.query(
        `INSERT INTO tenant_order_workflow_states
           (id, tenant_id, workflow_id, kind_code, position, label)
         VALUES ($1, $2, $3, 'received', 10, '{"en":"Received"}'::jsonb)`,
        [stateId, tenantId, workflowId],
      );
      await q.query(
        `INSERT INTO menu_categories (id, tenant_id, name)
         VALUES ($1, $2, '{"en":"Journal"}'::jsonb)`,
        [categoryId, tenantId],
      );
      await q.query(
        `INSERT INTO menu_items
           (id, tenant_id, category_id, name, base_price_amount_minor, base_price_currency_code)
         VALUES ($1, $2, $3, '{"en":"Journal item"}'::jsonb, 10000, 'SAR')`,
        [menuItemId, tenantId, categoryId],
      );
      await q.query(
        `INSERT INTO stations (id, tenant_id, branch_id, name)
         VALUES ($1, $2, $3, 'Journal station')`,
        [stationId, tenantId, branchId],
      );
      await q.query(
        `INSERT INTO shift_reconciliations
           (id, tenant_id, branch_id, cashier_id, opened_by_id,
            open_verified_by_id, opened_at, starting_float)
         VALUES ($1, $2, $3, $4, $5, $6, now(), 0)`,
        [shiftId, tenantId, branchId, cashierId, openerId, verifierId],
      );
      await q.query(
        `INSERT INTO accounts
           (tenant_id, code, name, account_type, normal_balance, system_purpose)
         VALUES ($1, '1150', 'Bank transfer clearing', 'asset', 'debit', 'bank_transfer_clearing')`,
        [tenantId],
      );
      await q.query(
        `INSERT INTO payment_methods
           (id, tenant_id, name, type, clearing_account_system_purpose)
         VALUES
           ($1, $4, 'Cash', 'cash', 'cash_on_hand'),
           ($2, $4, 'Card', 'card', 'card_clearing'),
           ($3, $4, 'Bank transfer', 'other', 'bank_transfer_clearing')`,
        [methodIds.cash, methodIds.card, methodIds.bankTransfer, tenantId],
      );

      for (const orderId of [randomUUID(), randomUUID(), randomUUID()]) {
        await q.query(
          `INSERT INTO orders
             (id, tenant_id, branch_id, order_type, sales_channel_code, current_status_kind_id)
           VALUES ($1, $2, $3, 'takeaway', 'takeaway', $4)`,
          [orderId, tenantId, branchId, stateId],
        );
        await q.query(
          `INSERT INTO order_items
             (tenant_id, order_id, menu_item_id, item_name_snapshot,
              unit_price_minor, quantity, current_status_kind_id, station_id)
           VALUES ($1, $2, $3, '{"en":"Journal item"}'::jsonb, 10000, 1, $4, $5)`,
          [tenantId, orderId, menuItemId, stateId, stationId],
        );
      }
    });
  });

  afterAll(async () => {
    await app?.end();
    await owner?.end();
  });

  async function unpostedOrderIds(): Promise<string[]> {
    return withApp(tenantId, async (q) => {
      const result = await q.query<{ id: string }>(
        `SELECT o.id FROM orders o
          WHERE o.tenant_id = $1
            AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.tenant_id = o.tenant_id AND p.order_id = o.id)
          ORDER BY o.created_at, o.id`,
        [tenantId],
      );
      return result.rows.map((row) => row.id);
    });
  }

  async function assertJournal(paymentId: string, debitPurpose: string, amountMinor: string): Promise<void> {
    await withApp(tenantId, async (q) => {
      const entries = await q.query<{ id: string }>(
        `SELECT id FROM journal_entries
          WHERE tenant_id = $1 AND source_type = 'payment' AND source_id = $2`,
        [tenantId, paymentId],
      );
      expect(entries.rowCount).toBe(1);
      const lines = await q.query<{ system_purpose: string; debit_minor: string; credit_minor: string }>(
        `SELECT a.system_purpose, l.debit_minor, l.credit_minor
           FROM journal_entry_lines l
           JOIN accounts a ON a.id = l.account_id AND a.tenant_id = l.tenant_id
          WHERE l.tenant_id = $1 AND l.journal_entry_id = $2
          ORDER BY l.line_number`,
        [tenantId, entries.rows[0]?.id],
      );
      expect(lines.rows).toEqual([
        { system_purpose: debitPurpose, debit_minor: amountMinor, credit_minor: '0' },
        { system_purpose: 'sales_revenue', debit_minor: '0', credit_minor: amountMinor },
      ]);
    });
  }

  it('posts cash, card, and data-only custom clearing purposes and deduplicates a replay', async () => {
    const [cashOrder, cardOrder, bankOrder] = await unpostedOrderIds();
    if (cashOrder === undefined || cardOrder === undefined || bankOrder === undefined) throw new Error('Missing journal test orders');

    const cash = await payments.recordPayment(tenantId, {
      orderId: cashOrder, paymentMethodId: methodIds.cash, cashierUserId: cashierId,
      amountText: '10.00', idempotencyKey: `cash-${randomUUID()}`,
    });
    await assertJournal(cash.payment.id, 'cash_on_hand', '1000');

    const cardKey = `card-${randomUUID()}`;
    const card = await payments.recordPayment(tenantId, {
      orderId: cardOrder, paymentMethodId: methodIds.card, cashierUserId: cashierId,
      amountText: '20.00', idempotencyKey: cardKey,
    });
    await assertJournal(card.payment.id, 'card_clearing', '2000');
    const replay = await payments.recordPayment(tenantId, {
      orderId: cardOrder, paymentMethodId: methodIds.card, cashierUserId: cashierId,
      amountText: '20.00', idempotencyKey: cardKey,
    });
    expect(replay.payment.id).toBe(card.payment.id);
    await assertJournal(card.payment.id, 'card_clearing', '2000');

    const bank = await payments.recordPayment(tenantId, {
      orderId: bankOrder, paymentMethodId: methodIds.bankTransfer, cashierUserId: cashierId,
      amountText: '30.00', idempotencyKey: `bank-${randomUUID()}`,
    });
    await assertJournal(bank.payment.id, 'bank_transfer_clearing', '3000');
  });

  it('forces tenant isolation on accounts, journal entries, and journal lines', async () => {
    const own = await withApp(tenantId, async (q) => ({
      accounts: Number((await q.query('SELECT id FROM accounts')).rowCount),
      entries: Number((await q.query('SELECT id FROM journal_entries')).rowCount),
      lines: Number((await q.query('SELECT id FROM journal_entry_lines')).rowCount),
    }));
    expect(own.accounts).toBe(4);
    expect(own.entries).toBe(3);
    expect(own.lines).toBe(6);

    const isolated = await withApp(otherTenantId, async (q) => ({
      accounts: Number((await q.query('SELECT id FROM accounts')).rowCount),
      entries: Number((await q.query('SELECT id FROM journal_entries')).rowCount),
      lines: Number((await q.query('SELECT id FROM journal_entry_lines')).rowCount),
    }));
    expect(isolated).toEqual({ accounts: 3, entries: 0, lines: 0 });
  });
});
