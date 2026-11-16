// @vitest-environment node
/**
 * Item 3 — migration 20261125140000: control C02 stops flagging collections recorded from float (balanced by the
 * balance-sheet resolver) and still flags everything else. PGlite with production's fin_controls of 16 Nov 2026.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const MIG = read('supabase/migrations/20261125140000_c02_float_collections_balanced.sql');
const RB = read('supabase/rollbacks/20261125140000_c02_float_collections_balanced.rollback.sql');
const PROD = read('scripts/fixtures/fin-controls-prod-2026-11-16b.sql');
const G = (k: number) => `00000000-0000-0000-0cc0-${String(k).padStart(12, '0')}`;

describe('C02 and collections recorded from float', () => {
  it('pins production, applies, and the rollback restores production exactly', async () => {
    const db = new PGlite();
    await db.exec(PROD);
    const md5 = async () => (await db.query<{ m: string }>(`select md5(prosrc) m from pg_proc where proname = 'fin_controls'`)).rows[0].m;
    expect(await md5()).toBe('e9f4e12b088f00bb34f3f57b3ec15dee');
    await db.exec(`BEGIN;\n${MIG}\nCOMMIT;`);
    expect(await md5()).not.toBe('e9f4e12b088f00bb34f3f57b3ec15dee');
    await expect(db.exec(`BEGIN;\n${MIG}\nCOMMIT;`)).rejects.toThrow(/precondition failed/);
    await db.exec('ROLLBACK').catch(() => {});
    await db.exec(`BEGIN;\n${RB}\nCOMMIT;`);
    expect(await md5()).toBe('e9f4e12b088f00bb34f3f57b3ec15dee');
    await db.close();
  });

  it('the new C02 rule: float collections and self-payments are not flagged; other unbalanced groups still are', async () => {
    const db = new PGlite();
    await db.exec(`
      create table public.general_ledger (transaction_group_id uuid, ledger_scope text, category text, direction text);
      create table public.ledger_mapped_balance_violations (transaction_group_id uuid, residual numeric, source_table text, detected_at timestamptz);
      insert into public.general_ledger values
        ('${G(1)}','wallet','agent_float_used_for_rent','cash_out'), ('${G(1)}','platform','tenant_repayment_collected','cash_in'),
        ('${G(2)}','wallet','agent_float_used_for_rent','cash_out'), ('${G(2)}','platform','tenant_repayment','cash_in'),
        ('${G(3)}','wallet','agent_float_used_for_rent','cash_out'), ('${G(3)}','platform','something_else','cash_in'),
        ('${G(4)}','wallet','cfo_credit','cash_in'), ('${G(4)}','platform','system_balance_correction','cash_out');
      insert into public.ledger_mapped_balance_violations values
        ('${G(1)}',-40000,'agent_collections',now()), ('${G(2)}',-20000,'agent_collections',now()),
        ('${G(3)}',-10000,'agent_collections',now()), ('${G(4)}',-5000,'cfo_direct_credit',now()),
        ('${G(1)}',-40000,'agent_collections',now() - interval '40 days');`);
    const s = MIG.indexOf('  FROM (SELECT v.*, row_number()');
    const e = MIG.indexOf(') z;', s);
    const sub = MIG.slice(s, e + 3).replace('v_at', 'now()');
    const r = await db.query<{ g: string }>(`select z.transaction_group_id::text g ${sub} order by 1`);
    expect(r.rows.map((x) => x.g)).toEqual([G(3), G(4)]);
    await db.close();
  });
});
