import { describe, expect, it } from 'vitest';
import { connectTestClient } from '../support/database.ts';
describe('DD-005 cost ledger append-only barriers', () => { it('installs immutable guard functions', async () => { const client = await connectTestClient(); try { const result = await client.query<{ proname: string }>("SELECT proname FROM pg_proc WHERE proname = 'guard_inventory_cost_ledger_immutable'"); expect(result.rows).toHaveLength(1); } finally { await client.end(); } }); });
