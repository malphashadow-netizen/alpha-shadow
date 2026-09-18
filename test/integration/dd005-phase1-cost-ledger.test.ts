import { describe, expect, it } from 'vitest';
import { connectTestClient } from '../support/database.ts';
describe('DD-005 phase 1 cost ledger structure', () => { it('installs the cost ledger tables', async () => { const client = await connectTestClient(); try { const result = await client.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_name IN ('inventory_cost_ledger', 'inventory_cost_layers')"); expect(result.rows).toHaveLength(2); } finally { await client.end(); } }); });
