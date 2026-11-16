// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- assertions over untyped rows returned by SQL */
/**
 * Item 7 — migration 20261125130000 and the DRAFT batch docs/finance/corrections/2026-11-16_legacy_plan_fees.sql, on
 * PGlite against PRODUCTION's resolver and category allowlist after items 1-5 (16 Nov 2026 fixtures).
 * Sample book: an older Rent Plan (rent 1,000,000, total 1,300,000 so fee 300,000; repaid 650,000) restated on
 * 22 Sep 2026; a collected-fee split whose partners' share (10,000) sits in deferred fees.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const MIG = read('supabase/migrations/20261125130000_rent_plan_fee_revenue.sql');
const BATCH = read('docs/finance/corrections/2026-11-16_legacy_plan_fees.sql');
const FIX = ['sofp-ledger-legs-prod-2026-11-16d.sql', 'sofp-ledger-legs-window-prod-2026-11-16d.sql', 'ledger-allowlist-prod-2026-11-16d.sql']
  .map((f) => read(`scripts/fixtures/${f}`)).join('\n');
const RR = '00000000-0000-0000-0aa0-000000000001';
const G = (k: number) => `00000000-0000-0000-0cc0-${String(k).padStart(12, '0')}`;

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth; create schema extensions; create schema cron;
create table cron.jobs (name text, schedule text, command text);
create function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.jobs values (n, s, c) returning 1::bigint $$;
create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create type public.app_role as enum ('cfo');
create function public.has_role(u uuid, r public.app_role) returns boolean language sql stable as $$ select false $$;
create function public.staff_mfa_ok() returns boolean language sql stable as $$ select true $$;
create function public.ledger_category_allowlist_base() returns text[] language sql immutable as $$ select array[]::text[] $$;
create table public.general_ledger (
  id uuid primary key default gen_random_uuid(), transaction_group_id uuid, transaction_date timestamptz, created_at timestamptz default now(),
  ledger_scope text, category text, direction text, amount numeric, wallet_bucket text, user_id uuid, reference_id text,
  source_table text, source_id uuid, classification text default 'production', description text, idempotency_key text);
create table public.ledger_account_map (id uuid default gen_random_uuid(), ledger_scope text, category text, wallet_bucket text,
  account_code text, debit_when text, notes text, created_at timestamptz default now(), updated_at timestamptz default now());
create table public.merchandise_recovery_plans (id uuid, item_name text);
create function public.agent_product_category(p text) returns text language sql immutable as $$ select 'other'::text $$;
create table public.fin_pnl_lines (id serial primary key, account_code text, category text, section text, line_label text, sort int, flag text);
insert into public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when) values
 ('platform','partner_returns_allocated',null,'L7','cash_out'), ('platform','treasury_fee_drawdown',null,'L7','cash_out'),
 ('platform','rent_plan_receivable_restatement',null,'A3','cash_out'), ('platform','receivable_restatement_equity',null,'E3','cash_out');
create function public.create_ledger_transaction(entries jsonb, idempotency_key text default null, skip_balance_check boolean default false)
returns uuid language plpgsql as $$
declare g uuid := gen_random_uuid(); e jsonb; v_in numeric := 0; v_out numeric := 0;
begin
  if idempotency_key is not null and exists (select 1 from public.general_ledger x where x.idempotency_key = create_ledger_transaction.idempotency_key) then
    raise exception 'duplicate idempotency key %', idempotency_key; end if;
  for e in select * from jsonb_array_elements(entries) loop
    if not ((e->>'category') = any (public.ledger_category_allowlist()) or (e->>'category') in (select category from public.ledger_account_map)) then
      raise exception 'category % not allowed', e->>'category'; end if;
    if e->>'direction' = 'cash_in' then v_in := v_in + (e->>'amount')::numeric; else v_out := v_out + (e->>'amount')::numeric; end if;
    insert into public.general_ledger (transaction_group_id, transaction_date, ledger_scope, category, direction, amount, source_table, source_id,
      description, idempotency_key, classification)
    values (g, coalesce((e->>'transaction_date')::timestamptz, now()), e->>'ledger_scope', e->>'category', e->>'direction', (e->>'amount')::numeric,
            e->>'source_table', (e->>'source_id')::uuid, e->>'description', create_ledger_transaction.idempotency_key, coalesce(e->>'classification','production'));
  end loop;
  if abs(v_in - v_out) > 0.5 then raise exception 'group not balanced'; end if;
  return g;
end $$;
create table public.rent_requests (id uuid primary key, status text, rent_amount numeric, total_repayment numeric, amount_repaid numeric);
create table public.accounting_correction_register (id uuid primary key default gen_random_uuid(), batch text not null, correction_item text not null,
  action text not null, source_table text not null, source_id uuid not null, rent_request_id uuid, original_group_id uuid, original_leg_ids uuid[],
  correction_group_id uuid, rebook_group_id uuid, amount numeric not null, before_value numeric, after_value numeric, detail jsonb default '{}'::jsonb,
  created_at timestamptz default now(), created_by uuid, rolled_back_at timestamptz, rollback_group_id uuid,
  constraint accounting_correction_register_once unique (correction_item, source_table, source_id, action));
create table public.audit_logs (id uuid primary key default gen_random_uuid(), user_id uuid, action_type text, action text, table_name text,
  record_id text, reason text, metadata jsonb, created_at timestamptz default now());

insert into public.rent_requests values ('${RR}','repaying',1000000,1300000,650000);
insert into public.general_ledger (transaction_group_id, transaction_date, ledger_scope, category, direction, amount, source_table, source_id) values
 ('${G(1)}','2026-09-22 12:00+03','platform','rent_plan_receivable_restatement','cash_out',650000,'rent_requests','${RR}'),
 ('${G(1)}','2026-09-22 12:00+03','platform','receivable_restatement_equity','cash_in',650000,'rent_requests','${RR}'),
 ('${G(2)}','2026-10-15 12:00+03','platform','partner_returns_allocated','cash_in',10000,'agent_collections',null),
 ('${G(2)}','2026-10-15 12:00+03','platform','treasury_fee_drawdown','cash_out',10000,'agent_collections',null);
`;

let db: PGlite;
const q = async <T = any>(sql: string) => (await db.query<T>(sql)).rows;
const accts = async () => Object.fromEntries((await q<{ a: string; v: string }>(
  `select account_code a, round(sum(dr - cr)) v from public.sofp_ledger_legs(now()) group by 1`)).map((r) => [r.a, Number(r.v)]));
const residuals = async () => q(`select transaction_group_id::text g from public.sofp_ledger_legs(now())
  where not is_legacy_counterpart group by 1 having abs(sum(dr - cr)) > 0.5`);
const sample = () => {
  const s = BATCH.indexOf('insert into _p (rent_request_id, fee, total, eff, before_rst, months) values'); const e = BATCH.indexOf('\n;', s);
  return (BATCH.slice(0, s) + `insert into _p (rent_request_id, fee, total, eff, before_rst, months) values ('${RR}', 300000, 1300000, 300000, 100000, '{"2026-10": 50000}'::jsonb)`
    + BATCH.slice(e)).replace(/insert into _expected values \([^)]*\);/, 'insert into _expected values (1, 300000, 100000, 50000, 1);');
};

describe('item 7: revenue recognition', () => {
  let before: Record<string, number>;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`set timezone = 'UTC'`);
    await db.exec(SCHEMA);
    await db.exec(FIX);
    before = await accts();
  });

  it('the production schedule: 928 Rent Plans, E3 180,767,810 = revenue 128,688,782 + 10,895,220 released + 41,183,808 deferred', () => {
    const rows = BATCH.slice(BATCH.indexOf('insert into _p'), BATCH.indexOf('\n;', BATCH.indexOf('insert into _p'))).split('\n').slice(1);
    expect(rows.length).toBe(928);
    let e3 = 0; let b = 0; let m = 0;
    for (const l of rows) {
      const x = l.match(/\('([0-9a-f-]{36})', (\d+), (\d+), (\d+), (\d+), '(.*)'::jsonb\)/)!;
      expect(x).toBeTruthy();
      const months = Object.values(JSON.parse(x[6]) as Record<string, number>).reduce((s, v) => s + v, 0);
      expect(Number(x[4])).toBeLessThanOrEqual(Number(x[2]));
      expect(Number(x[5]) + months).toBeLessThanOrEqual(Number(x[4]));
      e3 += Number(x[4]); b += Number(x[5]); m += months;
    }
    expect([e3, b, m]).toEqual([180767810, 128688782, 10895220]);
    expect(BATCH).toMatch(/insert into _expected values \(928, 180767810, 128688782, 10895220, 662\);/);
  });

  it('7b: the partners\' share of a collected fee reduces Supporter Returns (X2) instead of deferred fees (L7)', async () => {
    expect(before.L7).toBe(0);                                         // DR L7 drawdown 10,000 / CR L7 partners' share 10,000
    await db.exec(`BEGIN;\n${MIG}\nCOMMIT;`);
    const a = await accts();
    expect(a.X2).toBe(-10000);
    expect(a.L7).toBe(10000);                                          // the drawdown still releases deferred fees
    expect(await residuals()).toEqual([]);
    expect(await q(`select name, schedule from cron.jobs`)).toEqual([{ name: 'recognise-legacy-plan-fees-nightly', schedule: '15 20 * * *' }]);
    expect(await q(`select line_label from public.fin_pnl_lines where category = 'legacy_plan_fee_revenue'`)).toEqual([{ line_label: 'Rent Plan access fees' }]);
  });

  it('7a: the older Plan\'s fee leaves E3; collected fee is revenue, the rest deferred; the nightly job releases new repayments', async () => {
    const mid = await accts();
    await db.exec(sample());
    let a = await accts();
    expect(a.E3 - mid.E3).toBe(300000);                                // DR E3
    expect(mid.R1 ?? 0 - (a.R1 ?? 0)).toBeDefined();
    expect((a.R1 ?? 0) - (mid.R1 ?? 0)).toBe(-150000);                 // CR R1 100,000 + 50,000
    expect(a.L7 - mid.L7).toBe(-150000);                               // deferred: 300,000 - 150,000
    expect(await residuals()).toEqual([]);
    const dates = await q(`select category c, to_char(transaction_date at time zone 'Africa/Kampala','YYYY-MM-DD') d, amount::int a, direction dir
      from public.general_ledger where category like 'legacy_plan_fee_%' order by 2, 1, 3`);
    expect(dates).toEqual([
      { c: 'legacy_plan_fee_deferred', d: '2026-09-22', a: 200000, dir: 'cash_out' },
      { c: 'legacy_plan_fee_restated_e3', d: '2026-09-22', a: 300000, dir: 'cash_in' },
      { c: 'legacy_plan_fee_revenue', d: '2026-09-22', a: 100000, dir: 'cash_out' },
      { c: 'legacy_plan_fee_deferred', d: '2026-10-31', a: 50000, dir: 'cash_in' },
      { c: 'legacy_plan_fee_revenue', d: '2026-10-31', a: 50000, dir: 'cash_out' }]);
    // the tenant pays 130,000 more: fee share 30,000 released by the nightly job, once
    await q(`update public.rent_requests set amount_repaid = 780000 where id = '${RR}'`);
    expect(await q(`select public.recognise_legacy_plan_fees(now()) r`)).toEqual([{ r: expect.objectContaining({ plans: 1, amount: 30000 }) }]);
    expect(await q(`select public.recognise_legacy_plan_fees(now()) r`)).toEqual([{ r: expect.objectContaining({ plans: 0, amount: 0 }) }]);
    a = await accts();
    expect((a.R1 ?? 0) - (mid.R1 ?? 0)).toBe(-180000);
    expect(a.L7 - mid.L7).toBe(-120000);
    expect(await residuals()).toEqual([]);
    // paid in full: the whole fee is revenue, nothing more after that
    await q(`update public.rent_requests set amount_repaid = 1300000, status = 'completed' where id = '${RR}'`);
    await q(`select public.recognise_legacy_plan_fees(now())`);
    a = await accts();
    expect((a.R1 ?? 0) - (mid.R1 ?? 0)).toBe(-300000);
    expect(a.L7 - mid.L7).toBe(0);
    expect(await q(`select count(*)::int n from public.general_ledger where ledger_scope <> 'platform' and category like 'legacy_plan_fee_%'`)).toEqual([{ n: 0 }]);
    await expect(db.exec(sample())).rejects.toThrow(/already posted|already installed/);
  });
});
