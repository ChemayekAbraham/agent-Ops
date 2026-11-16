// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- assertions over untyped rows returned by SQL */
/**
 * Item 1, landlord rent payable (L4) — accounting only. Migration 20261125090000 and the DRAFT batch
 * docs/finance/corrections/2026-11-16_landlord_rent_payable.sql, run on PGlite against PRODUCTION's resolver,
 * resolver window, category allowlist and cash-flow statement (16 Nov 2026 fixtures), with production leg shapes.
 *
 * Sample book: plan A funded 500,000 and paid; plan B funded 300,000, payout failed (never paid); plan C funded
 * 200,000, paid, then its funding "returned" in the books (the batch undoes it); a 50,000 agent collection from float;
 * a Welile Homes rent paid through the agent's wallet (100,000, stays cash); a legacy agent-advance disbursement
 * (80,000, stays A10).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const MIG = read('supabase/migrations/20261125090000_landlord_rent_payable_accounting.sql');
const RB = read('supabase/rollbacks/20261125090000_landlord_rent_payable_accounting.rollback.sql');
const BATCH = read('docs/finance/corrections/2026-11-16_landlord_rent_payable.sql');
const FIX = ['sofp-ledger-legs-prod-2026-11-16.sql', 'sofp-ledger-legs-window-prod-2026-11-16.sql', 'ledger-allowlist-prod-2026-11-16.sql',
  'fin-cash-flow-prod-2026-11-16.sql'].map((f) => read(`scripts/fixtures/${f}`)).join('\n');

const id = (p: string, k: number) => `00000000-0000-0000-${p}-${String(k).padStart(12, '0')}`;
const RR = (k: number) => id('0aa0', k); const LP = (k: number) => id('0bb0', k); const G = (k: number) => id('0cc0', k);
const AG = id('0dd0', 1); const T = (k: number) => id('0ee0', k);

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth; create schema extensions;
create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create type public.app_role as enum ('cfo', 'ceo');
create function public.has_role(u uuid, r public.app_role) returns boolean language sql stable as $$ select false $$;
create function public.staff_mfa_ok() returns boolean language sql stable as $$ select true $$;
create function public._fin_can_view() returns boolean language sql stable as $$ select true $$;
create function public.ledger_category_allowlist_base() returns text[] language sql immutable as $$ select array['rent_disbursement']::text[] $$;
create table public.general_ledger (
  id uuid primary key default gen_random_uuid(), transaction_group_id uuid, transaction_date timestamptz, created_at timestamptz default now(),
  ledger_scope text, category text, direction text, amount numeric, wallet_bucket text, user_id uuid, reference_id text,
  source_table text, source_id uuid, classification text default 'production', description text, idempotency_key text);
create table public.ledger_account_map (id uuid default gen_random_uuid(), ledger_scope text, category text, wallet_bucket text,
  account_code text, debit_when text, notes text, created_at timestamptz default now(), updated_at timestamptz default now());
create table public.merchandise_recovery_plans (id uuid, item_name text);
create function public.agent_product_category(p text) returns text language sql immutable as $$ select 'other'::text $$;
create table public.fin_cash_accounts (code text primary key, label text, restricted boolean default false, included boolean default true);
insert into public.fin_cash_accounts values ('A1','Cash and bank',false,true), ('A5','Cash collected, not yet confirmed banked',false,true);
create table public.fin_cash_flow_map (id serial primary key, account_code text, category text, section text, group_label text,
  group_sort int, line_in text, line_out text, sort int);
insert into public.fin_cash_flow_map (account_code, category, section, group_label, group_sort, line_in, line_out, sort) values
  ('A3', null, 'operating', 'Rent Plans', 10, 'Tenant repayments received', 'Rent paid for tenants', 10),
  ('L4', null, 'operating', 'Landlord products', 20, 'Landlord obligations received', 'Landlord obligations settled', 20),
  ('A2', null, 'operating', 'Agent float (company-owned)', 30, 'Float returned by agents', 'Float issued to agents', 30),
  ('A8', null, 'operating', 'Agent float (company-owned)', 30, 'Float cycle returned', 'Float cycle issued', 31),
  ('A10', null, 'operating', 'Agent advances', 40, 'Advances repaid', 'Advances paid', 40);
-- production mapping rows (16 Nov 2026) for the categories in this book
insert into public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when) values
 ('platform','rent_disbursement',null,'A1','cash_in'), ('bridge','rent_receivable_created',null,'A3','cash_in'),
 ('wallet','agent_float_used_for_rent',null,'A2','cash_in'), ('platform','tenant_repayment_collected',null,'A3','cash_in'),
 ('wallet','agent_landlord_payout',null,'A2','cash_in');
create function public.create_ledger_transaction(entries jsonb, idempotency_key text default null, skip_balance_check boolean default false)
returns uuid language plpgsql as $$
declare g uuid := gen_random_uuid(); e jsonb; v_in numeric := 0; v_out numeric := 0;
begin
  if idempotency_key is not null and exists (select 1 from public.general_ledger x where x.idempotency_key = create_ledger_transaction.idempotency_key) then
    raise exception 'duplicate idempotency key %', idempotency_key; end if;
  for e in select * from jsonb_array_elements(entries) loop
    if (e->>'amount')::numeric = 13 then raise exception 'simulated posting failure'; end if;
    if e->>'direction' = 'cash_in' then v_in := v_in + (e->>'amount')::numeric; else v_out := v_out + (e->>'amount')::numeric; end if;
    insert into public.general_ledger (transaction_group_id, transaction_date, ledger_scope, category, direction, amount, source_table, source_id,
      reference_id, description, idempotency_key, classification)
    values (g, coalesce((e->>'transaction_date')::timestamptz, now()), e->>'ledger_scope', e->>'category', e->>'direction', (e->>'amount')::numeric,
            e->>'source_table', (e->>'source_id')::uuid, e->>'reference_id', e->>'description', create_ledger_transaction.idempotency_key,
            coalesce(e->>'classification', 'production'));
  end loop;
  if not skip_balance_check and abs(v_in - v_out) > 0.5 then
    raise exception 'group not balanced'; end if;
  return g;
end $$;
create table public.rent_requests (id uuid primary key, status text, rent_amount numeric, tenant_id uuid, agent_id uuid);
create table public.landlord_payouts (id uuid primary key, agent_id uuid, rent_request_id uuid, amount numeric, status text, landlord_name text,
  disbursed_at timestamptz, finops_disbursed_at timestamptz, finops_momo_reference text, external_reference text, created_at timestamptz default now());
create table public.accounting_correction_register (id uuid primary key default gen_random_uuid(), batch text not null, correction_item text not null,
  action text not null, source_table text not null, source_id uuid not null, rent_request_id uuid, original_group_id uuid, original_leg_ids uuid[],
  correction_group_id uuid, rebook_group_id uuid, amount numeric not null, before_value numeric, after_value numeric, detail jsonb default '{}'::jsonb,
  created_at timestamptz default now(), created_by uuid, rolled_back_at timestamptz, rollback_group_id uuid);
create table public.audit_logs (id uuid primary key default gen_random_uuid(), user_id uuid, action_type text, action text, table_name text,
  record_id text, reason text, metadata jsonb, created_at timestamptz default now());

insert into public.rent_requests values ('${RR(1)}','repaying',500000,'${T(1)}','${AG}'), ('${RR(2)}','funded',300000,'${T(2)}','${AG}'),
  ('${RR(3)}','repaying',200000,'${T(3)}','${AG}');
-- fundings: plan A 500,000; plan B 300,000; plan C 200,000 then "returned" 200,000
insert into public.general_ledger (transaction_group_id, transaction_date, ledger_scope, category, direction, amount, source_table, source_id) values
 ('${G(1)}','2026-10-01 09:00+03','bridge','rent_receivable_created','cash_in',500000,'rent_requests','${RR(1)}'),
 ('${G(1)}','2026-10-01 09:00+03','platform','rent_disbursement','cash_out',500000,'rent_requests','${RR(1)}'),
 ('${G(2)}','2026-10-02 09:00+03','bridge','rent_receivable_created','cash_in',300000,'rent_requests','${RR(2)}'),
 ('${G(2)}','2026-10-02 09:00+03','platform','rent_disbursement','cash_out',300000,'rent_requests','${RR(2)}'),
 ('${G(3)}','2026-10-03 09:00+03','bridge','rent_receivable_created','cash_in',200000,'rent_requests','${RR(3)}'),
 ('${G(3)}','2026-10-03 09:00+03','platform','rent_disbursement','cash_out',200000,'rent_requests','${RR(3)}'),
 ('${G(4)}','2026-10-10 09:00+03','bridge','rent_receivable_created','cash_out',200000,'rent_requests','${RR(3)}'),
 ('${G(4)}','2026-10-10 09:00+03','platform','rent_disbursement','cash_in',200000,'rent_requests','${RR(3)}'),
-- a 50,000 agent collection from float
 ('${G(5)}','2026-10-12 09:00+03','wallet','agent_float_used_for_rent','cash_out',50000,'agent_collections','${G(50)}'),
 ('${G(5)}','2026-10-12 09:00+03','platform','tenant_repayment_collected','cash_in',50000,'agent_collections','${G(50)}'),
-- Welile Homes rent paid through the agent's wallet (stays cash, A1)
 ('${G(6)}','2026-10-13 09:00+03','platform','rent_disbursement','cash_out',100000,'welile_homes_monthly_dues','${G(60)}'),
 ('${G(6)}','2026-10-13 09:00+03','wallet','agent_landlord_payout','cash_in',100000,'welile_homes_monthly_dues','${G(60)}'),
-- legacy rent disbursement as an agent advance (stays A10)
 ('${G(7)}','2026-09-01 09:00+03','platform','rent_disbursement','cash_out',80000,'agent_advance_requests','${G(70)}'),
 ('${G(7)}','2026-09-01 09:00+03','wallet','agent_advance_credit','cash_in',80000,'agent_advance_requests','${G(70)}');
update public.general_ledger set wallet_bucket = 'float', user_id = '${AG}' where transaction_group_id = '${G(5)}' and ledger_scope = 'wallet';
update public.general_ledger set user_id = '${AG}' where ledger_scope = 'wallet';
-- payouts: A completed, C completed (before the return), B failed
insert into public.landlord_payouts (id, agent_id, rent_request_id, amount, status, landlord_name, disbursed_at, finops_momo_reference) values
 ('${LP(1)}','${AG}','${RR(1)}',500000,'completed','Landlord A','2026-10-04 10:00+03','MP-A'),
 ('${LP(3)}','${AG}','${RR(3)}',200000,'completed','Landlord C','2026-10-05 10:00+03','MP-C'),
 ('${LP(2)}','${AG}','${RR(2)}',300000,'failed','Landlord B',null,null);
`;

let db: PGlite;
const q = async <T = any>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
/** debit-minus-credit balance of an account through the production resolver */
const bal = async (code: string) => Number((await q<{ v: string }>(
  `select coalesce(round(sum(dr - cr)), 0) v from public.sofp_ledger_legs(now()) where account_code = $1`, [code]))[0].v);
const residuals = async () => q(`select transaction_group_id::text g, round(sum(dr - cr)) r from public.sofp_ledger_legs(now())
  where not is_legacy_counterpart group by 1 having abs(sum(dr - cr)) > 0.5`);
const run = async (sql: string) => db.exec(sql).then(() => undefined, async (e: { message: string }) => { await db.exec('ROLLBACK').catch(() => {}); return e; });
const sampleBatch = (p1n: number, p1amt: number) => {
  const s = BATCH.indexOf('insert into _undo (rent_request_id, amount, paid, returned) values');
  const e = BATCH.indexOf('\n;', s);
  return (BATCH.slice(0, s) + `insert into _undo (rent_request_id, amount, paid, returned) values ('${RR(3)}', 200000, 200000, 200000)` + BATCH.slice(e))
    .replace('insert into _expected values (0, 0, 23, 9290000);', `insert into _expected values (${p1n}, ${p1amt}, 1, 200000);`);
};
const md5 = async (fn: string) => (await q<{ m: string }>(`select md5(prosrc) m from pg_proc where oid = '${fn}'::regprocedure`))[0]?.m;

describe('item 1: landlord rent payable (accounting only)', () => {
  let before: Record<string, number>;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`set timezone = 'UTC'`);
    await db.exec(SCHEMA);
    await db.exec(FIX);
    before = { A1: await bal('A1'), L4: await bal('L4'), A3: await bal('A3'), A8: await bal('A8'), A10: await bal('A10'), A2: await bal('A2') };
  });

  it('the production schedule is 23 Rent Plans / 9,290,000, each undo = least(paid, returned)', () => {
    const rows = BATCH.slice(BATCH.indexOf('insert into _undo'), BATCH.indexOf('\n;', BATCH.indexOf('insert into _undo')))
      .split('\n').slice(1).map((l) => l.match(/\('([0-9a-f-]{36})', (\d+), (\d+), (\d+)\)/));
    expect(rows.every(Boolean)).toBe(true);
    expect(rows.length).toBe(23);
    expect(rows.reduce((s, m) => s + Number(m![2]), 0)).toBe(9290000);
    for (const m of rows) expect(Number(m![2])).toBe(Math.min(Number(m![3]), Number(m![4])));
  });

  it('today (production rules): funding is cash leaving, the collection reduces L4, payouts are not recorded', async () => {
    expect(before.A1).toBe(-(500000 + 300000 + 200000 - 200000) - 100000);            // fundings net + Welile Homes
    expect(before.L4).toBe(50000);                                                       // DR L4 from the collection counterpart
    expect(before.A10).toBe(80000);
    expect(await residuals()).toEqual([]);
  });

  it('the batch refuses to run before the migration', async () => {
    expect((await run(sampleBatch(2, 700000)))?.message).toMatch(/migration 20261125090000 is not installed/);
  });

  it('the migration: funding owes the landlord (L4), the collection closes the float cycle (A8); Welile Homes and advances unchanged', async () => {
    expect(await run(`BEGIN;\n${MIG}\nCOMMIT;`)).toBeUndefined();
    expect(await bal('A1')).toBe(-100000);                                // only the Welile Homes wallet-paid rent is still cash out
    expect(await bal('L4')).toBe(-800000);                                // rent owed to landlords (credit) for A, B, C net
    expect(await bal('A8') - before.A8).toBe(50000);
    expect(await bal('A10')).toBe(80000);
    expect(await bal('A2')).toBe(before.A2);
    expect(await residuals()).toEqual([]);
    expect((await run(`BEGIN;\n${MIG}\nCOMMIT;`))?.message).toMatch(/precondition failed/);
  });

  it('the batch: payouts recorded on their own dates (DR L4 / CR A1); plan C\'s wrong reversal undone; nothing wallet-side', async () => {
    const wallet = await q(`select count(*) n, sum(amount) s from public.general_ledger where ledger_scope = 'wallet'`);
    const lp = await q(`select md5(string_agg(t::text, '|' order by t.id)) m from public.landlord_payouts t`);
    expect((await run(sampleBatch(2, 600000)))?.message).toMatch(/P1 payouts are 2 \/ 700000, approved 2 \/ 600000/);
    expect(await run(sampleBatch(2, 700000))).toBeUndefined();
    expect(await bal('A1')).toBe(-100000 - 700000);                        // cash out = the two payouts actually sent (+ Welile Homes)
    expect(await bal('L4')).toBe(-300000);                                 // still owed: plan B (payout failed)
    expect(await bal('A3') - before.A3).toBe(200000);                      // plan C's receivable restored
    expect(await residuals()).toEqual([]);
    expect(await q(`select count(*)::int n, sum(amount)::int s from public.general_ledger where ledger_scope = 'wallet'`)).toEqual([
      { n: Number(wallet[0].n), s: Number(wallet[0].s) }]);
    expect(await q(`select md5(string_agg(t::text, '|' order by t.id)) m from public.landlord_payouts t`)).toEqual(lp);
    const dates = await q(`select g.transaction_date::date::text d, g.amount::int a from public.general_ledger g
      where g.category = 'landlord_rent_payout_cash' order by 1`);
    expect(dates).toEqual([{ d: '2026-10-04', a: 500000 }, { d: '2026-10-05', a: 200000 }]);
    expect((await run(sampleBatch(0, 0)))?.message).toMatch(/already posted/);
  });

  it('the cash flow shows the payouts as "Rent paid for tenants" and stays fully explained', async () => {
    const cf = (await q<{ r: any }>(`select public.fin_cash_flow('2026-09-30 21:00+00', now()) r`))[0].r;
    expect(cf.unexplained_difference).toBe(0);
    const rentPlans = cf.operating.groups.find((g: any) => g.label === 'Rent Plans');
    expect(rentPlans.lines).toEqual(expect.arrayContaining([{ label: 'Rent paid for tenants', amount: -700000 }]));
    const all = JSON.stringify(cf);
    expect(all).not.toMatch(/Unclassified/);
  });

  it('forward: a new payout is recorded when sent, reversed if it fails, recorded again if re-sent; the flow is never blocked', async () => {
    await q(`insert into public.rent_requests values ('${RR(4)}','funded',150000,'${T(4)}','${AG}')`);
    await q(`select public.create_ledger_transaction(jsonb_build_array(
      jsonb_build_object('ledger_scope','bridge','direction','cash_in','amount',150000,'category','rent_receivable_created','source_table','rent_requests','source_id','${RR(4)}'),
      jsonb_build_object('ledger_scope','platform','direction','cash_out','amount',150000,'category','rent_disbursement','source_table','rent_requests','source_id','${RR(4)}')), null, false)`);
    const l4 = await bal('L4'); const a1 = await bal('A1');
    expect(l4).toBe(-450000);
    await q(`insert into public.landlord_payouts (id, agent_id, rent_request_id, amount, status, landlord_name) values ('${LP(4)}','${AG}','${RR(4)}',150000,'otp_verified','Landlord D')`);
    expect(await bal('L4')).toBe(l4);                                      // not sent yet: nothing
    await q(`update public.landlord_payouts set status = 'pending_merchant_payout' where id = '${LP(4)}'`);
    await q(`update public.landlord_payouts set status = 'awaiting_agent_receipt', finops_disbursed_at = '2026-11-16 12:00+03', finops_momo_reference = 'MP-D' where id = '${LP(4)}'`);
    expect(await bal('L4')).toBe(-300000);
    expect(await bal('A1')).toBe(a1 - 150000);
    await q(`update public.landlord_payouts set status = 'completed' where id = '${LP(4)}'`);       // sent -> sent: once only
    expect(await bal('A1')).toBe(a1 - 150000);
    await q(`update public.landlord_payouts set status = 'failed' where id = '${LP(4)}'`);
    expect(await bal('L4')).toBe(-450000);
    expect(await bal('A1')).toBe(a1);
    await q(`update public.landlord_payouts set status = 'completed' where id = '${LP(4)}'`);
    expect(await bal('A1')).toBe(a1 - 150000);
    expect((await q(`select count(*)::int n from public.general_ledger where category = 'landlord_rent_payout_cash' and source_id = '${LP(4)}'`))[0].n).toBe(3);
    expect(await residuals()).toEqual([]);
    // a posting failure is logged and the payout still moves
    await q(`insert into public.landlord_payouts (id, agent_id, rent_request_id, amount, status, landlord_name) values ('${LP(5)}','${AG}','${RR(4)}',13,'otp_verified','Landlord E')`);
    await q(`update public.landlord_payouts set status = 'completed' where id = '${LP(5)}'`);
    expect((await q(`select status from public.landlord_payouts where id = '${LP(5)}'`))[0].status).toBe('completed');
    expect(await q(`select amount::int a, error from public.landlord_rent_payout_posting_exceptions`)).toEqual([{ a: 13, error: 'simulated posting failure' }]);
  });

  it('no wallet-scope leg is ever written by the trigger or the batch', async () => {
    expect(await q(`select count(*)::int n from public.general_ledger where ledger_scope = 'wallet'
       and (category like 'landlord_rent_payout%' or idempotency_key like 'acct_corr_202611_landlord_l4%' or idempotency_key like 'landlord_rent_payout:%')`))
      .toEqual([{ n: 0 }]);
  });
});

describe('migration 20261125090000: preflight and rollback', () => {
  it('refuses a changed production resolver; the rollback restores production\'s resolver exactly', async () => {
    const fresh = new PGlite();
    await fresh.exec(`set timezone = 'UTC'`);
    await fresh.exec(SCHEMA);
    await fresh.exec(FIX.replace("WHEN b.sc = 'platform' AND b.cat = 'agent_repayment' AND b.src = 'agent_advances' THEN 'A10'",
      "WHEN b.sc = 'platform' AND b.cat = 'agent_repayment' AND b.src = 'agent_advances' THEN 'A11'"));
    await expect(fresh.exec(`BEGIN;\n${MIG}\nCOMMIT;`)).rejects.toThrow(/no longer production/);
    await fresh.close();

    const db2 = new PGlite();
    await db2.exec(`set timezone = 'UTC'`);
    await db2.exec(SCHEMA);
    await db2.exec(FIX);
    await db2.exec(`BEGIN;\n${MIG}\nCOMMIT;`);
    await db2.exec(`BEGIN;\n${RB}\nCOMMIT;`);
    const m = async (fn: string) => (await db2.query<{ m: string }>(`select md5(prosrc) m from pg_proc where oid = '${fn}'::regprocedure`)).rows[0].m;
    expect(await m('public.sofp_ledger_legs(timestamp with time zone)')).toBe('843ccf477014f8c7a8e0b5c6f14a1ba0');
    expect(await m('public.sofp_ledger_legs_window(timestamp with time zone,timestamp with time zone)')).toBe('fbd769b37dade4443eaa85d2f7cc0d31');
    expect((await db2.query(`select account_code from public.ledger_account_map where category = 'rent_disbursement'`)).rows).toEqual([{ account_code: 'A1' }]);
    expect((await db2.query(`select tgname from pg_trigger where tgname = 'trg_zz_post_landlord_rent_payout_accounting'`)).rows).toEqual([]);
    await db2.close();
    void md5;
  });
});
