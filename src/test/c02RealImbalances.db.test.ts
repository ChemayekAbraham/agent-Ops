// @vitest-environment node
/**
 * Control C02 measures real imbalances (migration 20261125150000): groups unbalanced in the balance-sheet calculation.
 * PGlite with production's fin_controls of 16 Nov 2026; the new C02 query is run against a resolver-window stand-in.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const MIG = read('supabase/migrations/20261125150000_c02_real_imbalances.sql');
const RB = read('supabase/rollbacks/20261125150000_c02_real_imbalances.rollback.sql');
const PROD = read('scripts/fixtures/fin-controls-prod-2026-11-16c.sql');
const G = (k: number) => `00000000-0000-0000-0cc0-${String(k).padStart(12, '0')}`;

describe('C02 measures real imbalances', () => {
  it('pins production, applies, and the rollback restores production exactly', async () => {
    const db = new PGlite();
    await db.exec(PROD);
    const md5 = async () => (await db.query<{ m: string }>(`select md5(prosrc) m from pg_proc where proname = 'fin_controls'`)).rows[0].m;
    expect(await md5()).toBe('c9e38980dccb0c15483331342fe87dfb');
    await db.exec(`BEGIN;\n${MIG}\nCOMMIT;`);
    expect(await md5()).not.toBe('c9e38980dccb0c15483331342fe87dfb');
    await db.exec(`BEGIN;\n${RB}\nCOMMIT;`);
    expect(await md5()).toBe('c9e38980dccb0c15483331342fe87dfb');
    await db.close();
  });

  it('flags only groups whose resolved legs do not balance; legacy one-sided counterparts are ignored', async () => {
    const db = new PGlite();
    await db.exec(`
      create table public._legs (gid uuid, src text, dr numeric, cr numeric, legacy boolean, tdate timestamptz);
      create function public.sofp_ledger_legs_window(p_from timestamptz, p_as_at timestamptz)
      returns table(transaction_group_id uuid, ledger_scope text, category text, source_table text, account_code text, dr numeric, cr numeric,
                    group_one_sided boolean, is_legacy_counterpart boolean, transaction_date timestamptz)
      language sql stable as $$ select gid, 'platform', 'x', src, 'A1', dr, cr, false, legacy, tdate from public._legs
                                 where tdate between p_from and p_as_at $$;
      insert into public._legs values
        ('${G(1)}','agent_collections',100,0,false,now()), ('${G(1)}','agent_collections',0,100,false,now()),     -- balanced
        ('${G(2)}','wallet_route_repair',353000,0,false,now()), ('${G(2)}','wallet_route_repair',0,0,false,now()), -- unbalanced
        ('${G(3)}','legacy',500,0,false,now()), (null,'legacy',0,500,true,now()),                                 -- one-sided + E4
        ('${G(4)}','old',900,0,false,now() - interval '40 days');`);
    const s = MIG.indexOf('  SELECT COUNT(*), COALESCE(SUM(abs(r)),0),');
    const e = MIG.indexOf(') u) z;', s);
    const q = MIG.slice(s, e + 7).replace(/v_at/g, 'now()').replace('    INTO v_n, v_amt, v_detail\n', '');
    const r = await db.query<{ count: number; coalesce: string }>(q);
    expect(Number(r.rows[0].count)).toBe(2);              // group 2 and the one-sided group 3 (a new one-sided group is real)
    await db.close();
  });
});
