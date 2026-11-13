// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- assertions over untyped rows returned by SQL */
/**
 * Angel Pool share purchases through the buyer's float are the buyer's own money (CFO 11 Nov 2026):
 * supabase/migrations/20261115130000_share_purchase_float_own_money.sql, run verbatim on PGlite with PRODUCTION's
 * resolver (src/test/fixtures/sofp_ledger_legs.live.sql) and the 7 production purchases (amounts as read 11 Nov 2026,
 * including Pius's group 121a7430 that the resolver once special-cased to A23).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 600_000 });

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const RESOLVER = read('src/test/fixtures/sofp_ledger_legs.live.sql');
const MIGRATION = read('supabase/migrations/20261115130000_share_purchase_float_own_money.sql');
const ROLLBACK = read('supabase/rollbacks/20261115130000_share_purchase_float_own_money.rollback.sql');

const PIUS_GID = '121a7430-bb4a-458c-9859-51b8c16c63b5';
const PURCHASES: [string, number][] = [
  [PIUS_GID, 20000], ['0245b8d7-eaa6-4213-ab87-3a6a5717a10e', 100000], ['6221adcc-f5d0-40e9-84c6-990dfdb49144', 100000],
  ['20c22260-ecf0-4041-a962-a075434fae8b', 50000], ['a2fe7c78-8d33-4f4f-8826-6161388a96b2', 1027500],
  ['85412c7b-ad42-46da-a9a7-9a04bc56f032', 1027500], ['70fec9bf-f534-43f0-bf28-04be5aedea32', 1027500],
];

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth; create schema extensions;
create table public.general_ledger (
  id uuid primary key default gen_random_uuid(), transaction_group_id uuid, transaction_date timestamptz, created_at timestamptz default now(),
  ledger_scope text, category text, direction text, amount numeric, wallet_bucket text, user_id uuid,
  source_table text, source_id uuid, classification text default 'production', description text, idempotency_key text);
create table public.ledger_account_map (id uuid default gen_random_uuid(), ledger_scope text, category text, wallet_bucket text,
  account_code text, debit_when text, notes text);
create table public.merchandise_recovery_plans (id uuid, item_name text);
create function public.agent_product_category(p text) returns text language sql immutable as $$ select 'other'::text $$;
-- production rows for these categories (11 Nov 2026)
insert into public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when) values
 ('platform','share_capital',null,'E1','cash_out'),
 ('wallet','share_capital','float','A26','cash_out'),
 ('wallet','agent_float_deposit',null,'A2','cash_in'), ('platform','agent_float_deposit',null,'A8','cash_in');
`;

let db: PGlite;
const q = async <T = any>(sql: string) => (await db.query<T>(sql)).rows;
const acct = async (code: string) =>
  Number((await q<{ v: string }>(`select coalesce(round(sum(dr - cr)),0) v from public.sofp_ledger_legs(now()) where account_code = '${code}'`))[0].v);

describe('share purchases through the buyer\'s float (migration 20261115130000)', () => {
  let before: Record<string, number>;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`set timezone = 'UTC'`);
    await db.exec(SCHEMA);
    await db.exec(RESOLVER);
    // each buyer's own money arriving as float, then the share purchase through that float (production leg shapes)
    for (const [gid, amt] of PURCHASES) {
      await db.exec(`insert into public.general_ledger (transaction_group_id, transaction_date, ledger_scope, category, direction, amount, wallet_bucket, source_table) values
        (gen_random_uuid(), '2026-10-01', 'wallet', 'agent_float_deposit', 'cash_in', ${amt}, 'float', 'deposit_requests');
        insert into public.general_ledger (transaction_group_id, transaction_date, ledger_scope, category, direction, amount, wallet_bucket, source_table)
          select transaction_group_id, transaction_date, 'platform', 'agent_float_deposit', 'cash_out', amount, null, source_table
          from public.general_ledger where wallet_bucket = 'float' and category = 'agent_float_deposit' and amount = ${amt}
            and transaction_group_id not in (select transaction_group_id from public.general_ledger where ledger_scope = 'platform')
          limit 1;
        insert into public.general_ledger (transaction_group_id, transaction_date, ledger_scope, category, direction, amount, wallet_bucket, source_table) values
        ('${gid}', '2026-10-02', 'wallet', 'share_capital', 'cash_out', ${amt}, 'float', 'angel_pool_investments'),
        ('${gid}', '2026-10-02', 'platform', 'share_capital', 'cash_in', ${amt}, null, 'angel_pool_investments');`);
    }
    before = { A26: await acct('A26'), A8: await acct('A8'), A2: await acct('A2'), E1: await acct('E1'), A23: await acct('A23') };
  });

  it('before: the 7 purchases sit in A26 as money owed by the shareholders', () => {
    expect(before.A26).toBe(3352500);
    expect(before.A23).toBe(0);
  });

  it('after: nothing is owed, the float-control credit is closed, share capital and cash unchanged', async () => {
    await db.exec(MIGRATION);
    expect(await acct('A26')).toBe(0);
    expect(await acct('A23')).toBe(0); // Pius's group is not special-cased any more
    expect(await acct('A8') - before.A8).toBe(3352500);
    expect(await acct('A2')).toBe(before.A2);
    expect(await acct('E1')).toBe(before.E1);
  });

  it('every purchase group still balances in the production resolver; nothing is one-sided', async () => {
    const off = await q(`select transaction_group_id, round(sum(dr - cr)) r from public.sofp_ledger_legs(now()) group by 1 having abs(sum(dr - cr)) > 0.5`);
    expect(off).toEqual([]);
    expect(Number((await q(`select count(*) n from public.sofp_ledger_legs(now()) where is_legacy_counterpart`))[0].n)).toBe(0);
  });

  it('balances on the base mapping too (what the share functions check before posting)', async () => {
    const r = await q(`select g.transaction_group_id, sum(case when g.direction = m.debit_when then g.amount else -g.amount end) net
      from public.general_ledger g join public.ledger_account_map m on m.ledger_scope = g.ledger_scope and m.category = g.category
        and (m.wallet_bucket is not distinct from g.wallet_bucket or (m.wallet_bucket is null and g.ledger_scope = 'platform'))
      where g.category = 'share_capital' group by 1 having abs(sum(case when g.direction = m.debit_when then g.amount else -g.amount end)) > 0.5`);
    expect(r).toEqual([]);
  });

  it('re-running is a no-op; the rollback restores A26; an unexpected mapping stops the migration', async () => {
    await db.exec(MIGRATION);
    expect(await acct('A26')).toBe(0);
    await db.exec(ROLLBACK);
    expect(await acct('A26')).toBe(3352500);
    expect(await acct('A8')).toBe(before.A8);
    await db.exec(`update public.ledger_account_map set account_code = 'A2' where ledger_scope = 'wallet' and category = 'share_capital'`);
    let msg = '';
    try { await db.exec(MIGRATION); } catch (e: any) { msg = String(e?.message ?? e); }
    expect(msg).toMatch(/not the expected A26 row/);
  });
});
