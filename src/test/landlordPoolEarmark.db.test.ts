// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- assertions over untyped rows returned by SQL */
/**
 * Item 2, Landlord Float Pool as an earmark within cash (migration 20261125100000), on PGlite against PRODUCTION's
 * resolver, resolver window and fin_balance_sheet as they stand after item 1 (16 Nov 2026 fixtures).
 * get_statement_of_financial_position is a small stand-in with the production output shape, fed by the real resolver.
 *
 * Sample book (production leg shapes): 2,000,000 Supporter cash received (A5); pool reserve 1,000,000, compounding
 * 100,000, deploy 300,000, release 20,000 (all against A1), principal returned 50,000 (against A5).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const MIG = read('supabase/migrations/20261125100000_landlord_pool_earmark.sql');
const RB = read('supabase/rollbacks/20261125100000_landlord_pool_earmark.rollback.sql');
const FIX = ['sofp-ledger-legs-prod-2026-11-16b.sql', 'sofp-ledger-legs-window-prod-2026-11-16b.sql', 'fin-balance-sheet-prod-2026-11-16.sql']
  .map((f) => read(`scripts/fixtures/${f}`)).join('\n');
const G = (k: number) => `00000000-0000-0000-0cc0-${String(k).padStart(12, '0')}`;

const STANDIN = `
-- stand-in with the production output shape, fed by the real resolver
create function public.get_statement_of_financial_position(p_as_at timestamptz) returns jsonb language sql stable as $$
  with b as (select c.code, c.label, c.section, c.nature, c.sort_order,
                    coalesce(sum(case when c.nature in ('asset','expense') then l.dr - l.cr else l.cr - l.dr end), 0) v
             from public.ledger_account_catalog c left join public.sofp_ledger_legs(p_as_at) l on l.account_code = c.code
             group by 1,2,3,4,5),
  line as (select section, jsonb_agg(jsonb_build_object('label', label, 'value', v, 'source', 'general_ledger trial balance — account ' || code) order by sort_order) j, sum(v) t
           from b group by section)
  select jsonb_build_object(
    'assets', jsonb_build_object('current', coalesce((select j from line where section='current_asset'),'[]'), 'non_current', '[]'::jsonb),
    'liabilities', jsonb_build_object('current', coalesce((select j from line where section='current_liability'),'[]'), 'non_current', '[]'::jsonb),
    'reconciliation', jsonb_build_object('memo_sub_ledgers', '[]'::jsonb),
    'balance_check', jsonb_build_object('difference',
       coalesce((select t from line where section='current_asset'),0) - coalesce((select t from line where section='current_liability'),0)
       - coalesce((select t from line where section='equity'),0)))
$$;
`;

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth; create schema extensions;
create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create function public._fin_can_view() returns boolean language sql stable as $$ select true $$;
create table public.general_ledger (
  id uuid primary key default gen_random_uuid(), transaction_group_id uuid, transaction_date timestamptz, created_at timestamptz default now(),
  ledger_scope text, category text, direction text, amount numeric, wallet_bucket text, user_id uuid, reference_id text,
  source_table text, source_id uuid, classification text default 'production', description text, idempotency_key text);
create table public.ledger_account_map (id uuid default gen_random_uuid(), ledger_scope text, category text, wallet_bucket text,
  account_code text, debit_when text, notes text, created_at timestamptz default now(), updated_at timestamptz default now());
create table public.merchandise_recovery_plans (id uuid, item_name text);
create function public.agent_product_category(p text) returns text language sql immutable as $$ select 'other'::text $$;
create table public.ledger_account_catalog (code text primary key, label text, section text, nature text, sort_order int);
insert into public.ledger_account_catalog values
 ('A1','Cash and Bank Balances','current_asset','asset',1), ('A5','Cash in Transit','current_asset','asset',5),
 ('A21','Landlord Float Pool — Self-Support','current_asset','asset',21), ('A22','Landlord Float Pool — Company-Managed','current_asset','asset',22),
 ('A9','Suspense','current_asset','asset',9), ('L1','Wallet Custody Payable','current_liability','liability',31), ('E3','Legacy','equity','equity',43);
-- production mapping rows (16 Nov 2026)
insert into public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when) values
 ('platform','cash_receipt_in_transit',null,'A5','cash_in'), ('platform','cash_custody_payable',null,'L1','cash_in'),
 ('platform','landlord_pool_reserve_company_managed',null,'A22','cash_in'), ('platform','landlord_pool_reserve_source',null,'A1','cash_in'),
 ('platform','landlord_pool_compound_company_managed',null,'A22','cash_in'), ('platform','landlord_pool_deploy_company_managed',null,'A22','cash_in'),
 ('platform','landlord_pool_deploy_target',null,'A1','cash_in'), ('platform','landlord_pool_release_company_managed',null,'A22','cash_in'),
 ('platform','landlord_pool_release_target',null,'A1','cash_in'), ('platform','landlord_pool_return_company_managed',null,'A22','cash_in'),
 ('platform','landlord_pool_return_source',null,'A5','cash_in');
create table public.wallets (withdrawable_balance numeric, locked_balance numeric, float_balance numeric, advance_balance numeric);
create table public.rent_requests (id uuid, status text, total_repayment numeric, amount_repaid numeric, created_at timestamptz);
create table public.agent_advances (status text, outstanding_balance numeric, created_at timestamptz);
create table public.investor_portfolios (status text, investment_amount numeric, created_at timestamptz);
create table public.promissory_notes (id uuid, status text, amount numeric, total_collected numeric, created_at timestamptz);
create table public.v_partner_note_settlement (note_id uuid, outstanding numeric);
create table public.merchandise_sales (amount_outstanding numeric, order_status text, created_at timestamptz);

insert into public.general_ledger (transaction_group_id, transaction_date, ledger_scope, category, direction, amount) values
 ('${G(1)}','2026-10-01 09:00+03','platform','cash_receipt_in_transit','cash_in',2000000),
 ('${G(1)}','2026-10-01 09:00+03','platform','cash_custody_payable','cash_out',2000000),
 ('${G(2)}','2026-10-02 09:00+03','platform','landlord_pool_reserve_company_managed','cash_in',1000000),
 ('${G(2)}','2026-10-02 09:00+03','platform','landlord_pool_reserve_source','cash_out',1000000),
 ('${G(3)}','2026-10-03 09:00+03','platform','landlord_pool_compound_company_managed','cash_in',100000),
 ('${G(3)}','2026-10-03 09:00+03','platform','landlord_pool_reserve_source','cash_out',100000),
 ('${G(4)}','2026-10-04 09:00+03','platform','landlord_pool_deploy_company_managed','cash_out',300000),
 ('${G(4)}','2026-10-04 09:00+03','platform','landlord_pool_deploy_target','cash_in',300000),
 ('${G(5)}','2026-10-05 09:00+03','platform','landlord_pool_release_company_managed','cash_out',20000),
 ('${G(5)}','2026-10-05 09:00+03','platform','landlord_pool_release_target','cash_in',20000),
 ('${G(6)}','2026-10-06 09:00+03','platform','landlord_pool_return_company_managed','cash_in',50000),
 ('${G(6)}','2026-10-06 09:00+03','platform','landlord_pool_return_source','cash_out',50000);
`;

let db: PGlite;
const q = async <T = any>(sql: string) => (await db.query<T>(sql)).rows;
const bal = async (code: string) => Number((await q<{ v: string }>(
  `select coalesce(round(sum(dr - cr)), 0) v from public.sofp_ledger_legs(now()) where account_code = '${code}'`))[0].v);
const cash = async () => Object.fromEntries(await Promise.all(['A1', 'A5', 'A21', 'A22'].map(async (c) => [c, await bal(c)])));
const total = (c: Record<string, number>) => Object.values(c).reduce((s, v) => s + v, 0);
const residuals = async () => q(`select transaction_group_id::text g from public.sofp_ledger_legs(now())
  where not is_legacy_counterpart group by 1 having abs(sum(dr - cr)) > 0.5`);
const md5 = async (fn: string) => (await q<{ m: string }>(`select md5(prosrc) m from pg_proc where oid = '${fn}'::regprocedure`))[0].m;

describe('item 2: Landlord Float Pool as an earmark within cash', () => {
  let before: Record<string, number>;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`set timezone = 'UTC'`);
    await db.exec(SCHEMA);
    await db.exec(FIX);
    await db.exec(STANDIN);
    before = await cash();
  });

  it('today: the set-aside drains A1 and the pool is a separate cash line', () => {
    expect(before).toEqual({ A1: -780000, A5: 1950000, A21: 0, A22: 830000 });
    expect(total(before)).toBe(2000000);
  });

  it('after the migration: pool movements net out inside cash; A21/A22 vanish; total cash unchanged; every group balanced', async () => {
    await db.exec(`BEGIN;\n${MIG}\nCOMMIT;`);
    const after = await cash();
    expect(after).toEqual({ A1: 0, A5: 2000000, A21: 0, A22: 0 });
    expect(total(after)).toBe(total(before));
    expect(await residuals()).toEqual([]);
    expect(await q(`select count(*)::int n from public.general_ledger`)).toEqual([{ n: 12 }]);   // nothing posted
  });

  it('the balance sheet shows the earmark as a note and the updated disclosures', async () => {
    const bs = (await q<{ r: any }>(`select public.fin_balance_sheet(now()) r`))[0].r;
    const memo = bs.reconciliation.memo_sub_ledgers.find((m: any) => m.label.startsWith('Landlord Float Pool'));
    expect(memo).toMatchObject({ label: 'Landlord Float Pool — cash earmarked for landlords (included in cash above)', value: 830000 });
    expect(bs.disclosures.join(' ')).toMatch(/shown as a note within cash/);
    expect(bs.disclosures.join(' ')).toMatch(/rent owed to landlords for funded Rent Plans until the landlord payout is sent/);
    expect(bs.disclosures.join(' ')).not.toMatch(/holds no landlord obligations/);
    expect(Number(bs.balance_check.difference)).toBe(0);
    const pool = (await q<{ r: any }>(`select public.fin_balance_sheet('2026-10-03 12:00+03') r`))[0].r.reconciliation.memo_sub_ledgers
      .find((m: any) => m.label.startsWith('Landlord Float Pool'));
    expect(pool.value).toBe(1100000);                                       // as at a past date
  });

  it('refuses a changed production function; the rollback restores production exactly', async () => {
    const fresh = new PGlite();
    await fresh.exec(SCHEMA);
    await fresh.exec(FIX.replace("'Cash and Bank (A1) is negative mainly", "'Cash and Bank (A1) is negative largely"));
    await fresh.exec(STANDIN);
    await expect(fresh.exec(`BEGIN;\n${MIG}\nCOMMIT;`)).rejects.toThrow(/no longer production/);
    await fresh.close();
    await db.exec(`BEGIN;\n${RB}\nCOMMIT;`);
    expect(await md5('public.sofp_ledger_legs(timestamp with time zone)')).toBe('05abf47889ef136b2ba88ad8b72270f1');
    expect(await md5('public.sofp_ledger_legs_window(timestamp with time zone,timestamp with time zone)')).toBe('253a1cdbbb511bba125d08f526107f4e');
    expect(await md5('public.fin_balance_sheet(timestamp with time zone)')).toBe('4a15e6686e12ffb8c034b89b936e9af9');
    expect(await cash()).toEqual(before);
  });
});
