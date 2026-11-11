// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- assertions over untyped rows returned by SQL */
/**
 * Welile Homes landlord floats booked as payroll expense (CFO, 12 Nov 2026). NOT approved, NOT posted.
 *   supabase/migrations/20261116100000_wh_landlord_float_settles_l4.sql (+ rollback)
 *   docs/finance/corrections/2026-11-12_wh_landlord_floats_to_l4.sql (batch acct_corr_202611_wh_float_l4)
 * Run verbatim on PGlite with PRODUCTION's resolver. The CFO direct credits are seeded with their production ids,
 * references and amounts and production leg shape (wallet credit to the agent + platform payroll_expense).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 600_000 });

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const RESOLVER = read('src/test/fixtures/sofp_ledger_legs.live.sql');
const MIG = read('supabase/migrations/20261116100000_wh_landlord_float_settles_l4.sql');
const RB = read('supabase/rollbacks/20261116100000_wh_landlord_float_settles_l4.rollback.sql');
const BATCH = read('docs/finance/corrections/2026-11-12_wh_landlord_floats_to_l4.sql');
const ALLOW_LIVE = RB.slice(RB.indexOf('CREATE OR REPLACE FUNCTION public.ledger_category_allowlist()'));

const CREDITS: [string, string, number, string][] = [
  ['64646e28-0606-41c2-9a62-8642d692f3c3', 'PAY-MSRFPGPV-3OV7', 4527000, '2026-08-13 11:28:04+00'],
  ['d9c4241c-7ece-4c7b-b621-f5ef8007b2eb', 'PAY-MSYHRPIM-5HAT', 135000, '2026-08-18 10:00:11+00'], // "Buzzi": not in the batch
  ['216a42c4-1730-4d34-ba3a-e36c3d9ebe27', 'PAY-MTU3BP2T-SXR8', 5517000, '2026-09-09 12:44:27+00'],
  ['15463227-5dbf-4210-96d5-42d9ca4f7bed', 'PAY-MUY7COJU-Q0HB', 4700000, '2026-10-07 14:27:59+00'],
  ['2ddd50d8-12a9-43ce-bff9-a6e0b7688605', 'PAY-MWAKJFVB-80M6', 12596400, '2026-11-10 10:50:06+00'],
];
const AGENT = '99890a2e-b842-4d44-8516-e2eafe0711ff';

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth; create schema extensions;
create table public.general_ledger (
  id uuid primary key default gen_random_uuid(), transaction_group_id uuid, transaction_date timestamptz, created_at timestamptz default now(),
  ledger_scope text, category text, direction text, amount numeric, wallet_bucket text, user_id uuid, reference_id text,
  source_table text, source_id uuid, classification text default 'production', description text, idempotency_key text);
create table public.ledger_account_map (id uuid default gen_random_uuid(), ledger_scope text, category text, wallet_bucket text,
  account_code text, debit_when text, notes text);
insert into public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when) values
 ('platform','payroll_expense',null,'X1','cash_out'), ('platform','landlord_receivable_obligation',null,'L4','cash_in'),
 ('bridge','landlord_receivable_created',null,'A6','cash_in');
create table public.merchandise_recovery_plans (id uuid, item_name text);
create function public.agent_product_category(p text) returns text language sql immutable as $$ select 'other'::text $$;
create function public.ledger_category_allowlist_base() returns text[] language sql immutable as
  $$ select array['payroll_expense','wallet_deposit','landlord_receivable_created','landlord_receivable_obligation'] $$;
create table public.accounting_correction_register (
  id uuid primary key default gen_random_uuid(), batch text not null, correction_item text not null, action text not null,
  source_table text not null, source_id uuid not null, original_group_id uuid, original_leg_ids uuid[], correction_group_id uuid,
  amount numeric not null, before_value numeric, after_value numeric, detail jsonb not null default '{}'::jsonb,
  created_at timestamptz default now(), created_by uuid, unique (correction_item, source_table, source_id, action));
create function public.create_ledger_transaction(entries jsonb, idempotency_key text default null, skip_balance_check boolean default false)
returns uuid language plpgsql as $$
declare g uuid := gen_random_uuid(); e jsonb; v_in numeric := 0; v_out numeric := 0;
begin
  if idempotency_key is not null and exists (select 1 from public.general_ledger l where l.idempotency_key = create_ledger_transaction.idempotency_key) then
    raise exception 'duplicate idempotency key %', idempotency_key; end if;
  for e in select * from jsonb_array_elements(entries) loop
    if not (e->>'category') = any (public.ledger_category_allowlist()) then raise exception 'category % not allowlisted', e->>'category'; end if;
    if e->>'direction' = 'cash_in' then v_in := v_in + (e->>'amount')::numeric; else v_out := v_out + (e->>'amount')::numeric; end if;
    insert into public.general_ledger (transaction_group_id, transaction_date, ledger_scope, category, direction, amount,
      reference_id, source_table, source_id, description, idempotency_key)
    values (g, (e->>'transaction_date')::timestamptz, e->>'ledger_scope', e->>'category', e->>'direction', (e->>'amount')::numeric,
      e->>'reference_id', e->>'source_table', (e->>'source_id')::uuid, e->>'description', idempotency_key);
  end loop;
  if abs(v_in - v_out) > 0.5 then raise exception 'raw group not balanced'; end if;
  return g;
end $$;
-- the 12-month obligations recognised for these landlords (A6 / L4), production totals
insert into public.general_ledger (transaction_group_id, transaction_date, ledger_scope, category, direction, amount, source_table) values
 ('00000000-0000-0000-0000-0000000007a1','2026-08-01','bridge','landlord_receivable_created','cash_in',103925000,'welile_homes_subscriptions'),
 ('00000000-0000-0000-0000-0000000007a1','2026-08-01','platform','landlord_receivable_obligation','cash_out',103925000,'welile_homes_subscriptions');
`;
const SEED = CREDITS.map(([leg, ref, amt, td], i) => `
  insert into public.general_ledger (id, transaction_group_id, transaction_date, ledger_scope, category, direction, amount, wallet_bucket, user_id, reference_id, source_table, description) values
   (gen_random_uuid(), '00000000-0000-0000-0000-0000000008${i}0', '${td}', 'wallet', 'wallet_deposit', 'cash_in', ${amt}, 'withdrawable', '${AGENT}', '${ref}', 'cfo_direct_credit', 'Requisition credit'),
   ('${leg}', '00000000-0000-0000-0000-0000000008${i}0', '${td}', 'platform', 'payroll_expense', 'cash_out', ${amt}, null, '${AGENT}', '${ref}', 'cfo_direct_credit', 'Welile Homes Rent');`).join('\n');

let db: PGlite;
const q = async <T = any>(sql: string) => (await db.query<T>(sql)).rows;
const acct = async (code: string) =>
  Number((await q<{ v: string }>(`select coalesce(round(sum(dr - cr)),0) v from public.sofp_ledger_legs(now()) where account_code = '${code}'`))[0].v);
const fails = async (sql: string, re: RegExp) => {
  let msg = '';
  try { await db.exec(sql); } catch (e: any) { msg = String(e?.message ?? e); }
  await db.exec('rollback').catch(() => undefined);
  expect(msg).toMatch(re);
};
const fresh = async () => {
  db = new PGlite();
  await db.exec(`set timezone = 'UTC'`);
  await db.exec(SCHEMA);
  await db.exec(RESOLVER);
  await db.exec(ALLOW_LIVE);
  await db.exec(SEED);
};

describe('Welile Homes landlord floats -> L4 (draft)', () => {
  let before: Record<string, number>; let walletBefore: string;
  beforeAll(async () => {
    await fresh();
    before = { L4: await acct('L4'), X1: await acct('X1'), L1: await acct('L1'), A6: await acct('A6') };
    walletBefore = JSON.stringify(await q(`select * from public.general_ledger where ledger_scope = 'wallet' order by id`));
  });

  it('refuses to run before the migration', async () => {
    await fails(BATCH, /migration 20261116100000 is not applied|not allowlisted/);
  });

  it('migration: one L4 rule, every live allowlist entry kept, one category added', async () => {
    const live = (await q<{ a: string[] }>(`select public.ledger_category_allowlist() a`))[0].a;
    await db.exec(MIG);
    const now = (await q<{ a: string[] }>(`select public.ledger_category_allowlist() a`))[0].a;
    expect(live.every((c) => now.includes(c))).toBe(true);
    expect(now.filter((c) => !live.includes(c))).toEqual(['wh_landlord_float_settled']);
    expect(await q(`select account_code, debit_when from public.ledger_account_map where category = 'wh_landlord_float_settled'`))
      .toEqual([{ account_code: 'L4', debit_when: 'cash_out' }]);
  });

  it('batch: 15 lines, L4 settled by 23,709,400 and payroll expense reduced by the same; A6, wallets unchanged', async () => {
    await db.exec(BATCH);
    const reg = await q(`select count(*)::int n, sum(amount)::numeric s from public.accounting_correction_register where batch = 'acct_corr_202611_wh_float_l4'`);
    expect(reg[0].n).toBe(15); expect(Number(reg[0].s)).toBe(23709400);
    expect(await acct('L4') - before.L4).toBe(23709400);   // debit: obligation settled
    expect(await acct('X1') - before.X1).toBe(-23709400);  // expense removed
    expect(await acct('A6')).toBe(before.A6);
    expect(await acct('L1')).toBe(before.L1);
    expect(JSON.stringify(await q(`select * from public.general_ledger where ledger_scope = 'wallet' order by id`))).toBe(walletBefore);
  });

  it('per requisition, what is reclassified never exceeds the original credit; "Buzzi" is untouched', async () => {
    const r = await q(`select o.reference_id ref, o.amount orig, coalesce(sum(c.amount) filter (where c.category = 'payroll_expense'), 0) moved
      from public.general_ledger o left join public.general_ledger c on c.reference_id = o.reference_id and c.idempotency_key like 'acct_corr_202611_wh_float_l4:%'
      where o.ledger_scope = 'platform' and o.source_table = 'cfo_direct_credit' group by 1,2 order by 1`);
    const m = Object.fromEntries(r.map((x: any) => [x.ref, [Number(x.orig), Number(x.moved)]]));
    expect(m['PAY-MSRFPGPV-3OV7']).toEqual([4527000, 4527000]);
    expect(m['PAY-MTU3BP2T-SXR8']).toEqual([5517000, 4257000]);   // Mukambya 1,260,000 left out
    expect(m['PAY-MUY7COJU-Q0HB']).toEqual([4700000, 3755000]);   // Mukambya 945,000 left out
    expect(m['PAY-MWAKJFVB-80M6']).toEqual([12596400, 11170400]); // Mukambya 1,260,000 + Namudde 166,000 left out
    expect(m['PAY-MSYHRPIM-5HAT']).toEqual([135000, 0]);
  });

  it('every correction group balances in the production resolver, dated to its original credit', async () => {
    const off = await q(`select transaction_group_id from public.sofp_ledger_legs(now()) group by 1 having abs(sum(dr - cr)) > 0.5`);
    expect(off).toEqual([]);
    const bad = await q(`select count(*) n from public.general_ledger c join public.general_ledger o on o.id = c.source_id
      where c.idempotency_key like 'acct_corr_202611_wh_float_l4:%' and c.transaction_date <> o.transaction_date`);
    expect(Number(bad[0].n)).toBe(0);
  });

  it('cannot be posted twice; the rule rollback refuses while legs exist', async () => {
    await fails(BATCH, /already posted/);
    await fails(RB, /roll back the posting batch first/);
  });
});

describe('stops when the evidence changed; rollback restores the live allowlist', () => {
  it('refuses if an original credit changed', async () => {
    await fresh();
    await db.exec(MIG);
    await db.exec(`update public.general_ledger set amount = 4700001 where id = '15463227-5dbf-4210-96d5-42d9ca4f7bed'`);
    await fails(BATCH, /no longer matches the evidence/);
  });

  it('rollback with nothing posted restores the allowlist and removes the rule', async () => {
    await fresh();
    const live = (await q<{ a: string[] }>(`select public.ledger_category_allowlist() a`))[0].a;
    await db.exec(MIG);
    await db.exec(RB);
    expect((await q<{ a: string[] }>(`select public.ledger_category_allowlist() a`))[0].a).toEqual(live);
    expect(Number((await q(`select count(*) n from public.ledger_account_map where category = 'wh_landlord_float_settled'`))[0].n)).toBe(0);
  });
});
