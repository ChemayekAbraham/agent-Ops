// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- assertions over untyped rows returned by SQL */
/**
 * Salary advances to employees (CFO 11 Nov 2026):
 *   supabase/migrations/20261115110000_salary_advances_staff_receivable.sql  (categories, mappings, allowlist)
 *   docs/finance/corrections/2026-11-11_salary_advances.sql                 (backdated batch salary_adv_202611)
 * both run verbatim on PGlite with PRODUCTION's resolver (src/test/fixtures/sofp_ledger_legs.live.sql) and the
 * production advances / recoveries (ids and amounts as read on 11 Nov 2026).
 * create_ledger_transaction is a stand-in: inserts legs, enforces raw cash_in = cash_out, the allowlist and a unique
 * idempotency key.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 600_000 });

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const RESOLVER = read('src/test/fixtures/sofp_ledger_legs.live.sql');
const MIGRATION = read('supabase/migrations/20261115110000_salary_advances_staff_receivable.sql');
const ROLLBACK = read('supabase/rollbacks/20261115110000_salary_advances_staff_receivable.rollback.sql');
const BATCH = read('docs/finance/corrections/2026-11-11_salary_advances.sql');
const ALLOW_LIVE = ROLLBACK.slice(ROLLBACK.indexOf('CREATE OR REPLACE FUNCTION public.ledger_category_allowlist()'));

const ADV = {
  bwayo: '23f67875-5afb-4029-8193-8dd64413b32b',
  sarah: '0d724014-e940-4464-b6f8-4be6de9bdced',
  kalyango: '6b922d39-badc-409a-a5b9-d76b0bc9da61',
  waniaye: '6f793e50-66ca-481e-9bcd-e89ed69d5bfb',
};
const u = (n: number) => `00000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`;
const RUN = { '2026-08': u(81), '2026-09': u(82), '2026-10': u(83) } as const;

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth; create schema extensions;
create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create table public.general_ledger (
  id uuid primary key default gen_random_uuid(), transaction_group_id uuid, transaction_date timestamptz, created_at timestamptz default now(),
  ledger_scope text, category text, direction text, amount numeric, wallet_bucket text, user_id uuid,
  source_table text, source_id uuid, classification text default 'production', description text, idempotency_key text);
create table public.ledger_account_map (id uuid default gen_random_uuid(), ledger_scope text, category text, wallet_bucket text,
  account_code text, debit_when text, notes text);
create table public.ledger_account_catalog (code text primary key, label text, section text, nature text, sort_order int);
create table public.fin_pnl_lines (id serial primary key, account_code text not null, category text, section text not null,
  line_label text not null, sort int not null default 500, flag text, unique nulls not distinct (account_code, category));
create table public.merchandise_recovery_plans (id uuid, item_name text);
create function public.agent_product_category(p text) returns text language sql immutable as $$ select 'other'::text $$;
create function public.ledger_category_allowlist_base() returns text[] language sql immutable as
  $$ select array['salary_payout','payroll_expense','staff_loan_disbursement','staff_loan_repayment','wallet_deposit'] $$;
insert into public.ledger_account_catalog values
 ('A1','Cash and Bank Balances','current_asset','asset',1), ('A27','Staff loans receivable','current_asset','asset',127),
 ('L1','Wallet custody','current_liability','liability',10), ('X1','Operating Expenses','expense','expense',300);
insert into public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when) values
 ('platform','salary_payout',null,'X1','cash_out'), ('platform','staff_loan_disbursement',null,'A27','cash_out'),
 ('platform','staff_loan_repayment',null,'A27','cash_out');
insert into public.fin_pnl_lines (account_code, category, section, line_label, sort) values
 ('X1','salary_payout','operating_expense','Payroll and staff costs',310);

create table public.profiles (id uuid primary key, full_name text);
create table public.hr_staff (id uuid primary key, user_id uuid);
create table public.hr_pay_advances (id uuid primary key, staff_id uuid, principal numeric, status text, disbursed_at timestamptz);
create table public.hr_pay_periods (id uuid primary key, code text);
create table public.hr_pay_runs (id uuid primary key, period_id uuid, status text);
create table public.hr_pay_advance_recoveries (id uuid primary key default gen_random_uuid(), advance_id uuid, run_id uuid, amount numeric);
create table public.accounting_correction_register (
  id uuid primary key default gen_random_uuid(), batch text not null, correction_item text not null, action text not null,
  source_table text not null, source_id uuid not null, original_group_id uuid, original_leg_ids uuid[], correction_group_id uuid,
  amount numeric not null, before_value numeric, after_value numeric, detail jsonb not null default '{}'::jsonb,
  created_at timestamptz default now(), created_by uuid, rolled_back_at timestamptz, rollback_group_id uuid,
  unique (correction_item, source_table, source_id, action));

create function public.create_ledger_transaction(entries jsonb, idempotency_key text default null, skip_balance_check boolean default false)
returns uuid language plpgsql as $$
declare g uuid := gen_random_uuid(); e jsonb; v_in numeric := 0; v_out numeric := 0;
begin
  if idempotency_key is not null and exists (select 1 from public.general_ledger l where l.idempotency_key = create_ledger_transaction.idempotency_key) then
    raise exception 'duplicate idempotency key %', idempotency_key;
  end if;
  for e in select * from jsonb_array_elements(entries) loop
    if (e->>'amount')::numeric <= 0 then raise exception 'non-positive leg'; end if;
    if not (e->>'category') = any (public.ledger_category_allowlist()) then raise exception 'category % not allowlisted', e->>'category'; end if;
    if e->>'direction' = 'cash_in' then v_in := v_in + (e->>'amount')::numeric; else v_out := v_out + (e->>'amount')::numeric; end if;
    insert into public.general_ledger (transaction_group_id, transaction_date, ledger_scope, category, direction, amount, wallet_bucket,
      user_id, source_table, source_id, description, idempotency_key)
    values (g, coalesce((e->>'transaction_date')::timestamptz, now()), e->>'ledger_scope', e->>'category', e->>'direction',
      (e->>'amount')::numeric, case when e->>'ledger_scope' = 'wallet' then coalesce(e->>'wallet_bucket','withdrawable') end,
      (e->>'user_id')::uuid, e->>'source_table', (e->>'source_id')::uuid, e->>'description', idempotency_key);
  end loop;
  if abs(v_in - v_out) > 0.5 then raise exception 'raw group not balanced'; end if;
  return g;
end $$;
`;

// Production data as read on 11 Nov 2026 (ids of the advances; amounts of the advances and of every recovery).
const DATA = `
insert into public.profiles values ('${u(1)}','bwayo mark'), ('${u(2)}','SARAH ANGWEN'), ('${u(3)}','Timothy Kalyango'), ('${u(4)}','TIMOTHY CHRISTIAN WANIAYE');
insert into public.hr_staff values ('${u(11)}','${u(1)}'), ('${u(12)}','${u(2)}'), ('${u(13)}','${u(3)}'), ('${u(14)}','${u(4)}');
insert into public.hr_pay_advances values
 ('${ADV.bwayo}','${u(11)}',2500000,'approved','2026-09-27'), ('${ADV.sarah}','${u(12)}',2000000,'approved','2026-09-27'),
 ('${ADV.kalyango}','${u(13)}',1000000,'approved','2026-09-27'), ('${ADV.waniaye}','${u(14)}',1500000,'approved','2026-09-27'),
 ('${u(90)}','${u(11)}',250000,'cancelled',null);
insert into public.hr_pay_periods values ('${u(71)}','2026-08'), ('${u(72)}','2026-09'), ('${u(73)}','2026-10'), ('${u(74)}','2026-11');
insert into public.hr_pay_runs values ('${RUN['2026-08']}','${u(71)}','locked'), ('${RUN['2026-09']}','${u(72)}','locked'),
 ('${RUN['2026-10']}','${u(73)}','locked'), ('${u(84)}','${u(74)}','draft');
insert into public.hr_pay_advance_recoveries (advance_id, run_id, amount) values
 ('${ADV.bwayo}','${RUN['2026-08']}',625000), ('${ADV.waniaye}','${RUN['2026-08']}',375000), ('${ADV.sarah}','${RUN['2026-08']}',666667),
 ('${ADV.bwayo}','${RUN['2026-09']}',625000), ('${ADV.waniaye}','${RUN['2026-09']}',375000), ('${ADV.sarah}','${RUN['2026-09']}',666667),
 ('${ADV.kalyango}','${RUN['2026-09']}',333400),
 ('${ADV.bwayo}','${RUN['2026-10']}',625000), ('${ADV.waniaye}','${RUN['2026-10']}',375000), ('${ADV.sarah}','${RUN['2026-10']}',666666),
 ('${ADV.kalyango}','${RUN['2026-10']}',333400),
 ('${ADV.bwayo}','${u(84)}',625000);  -- November draft run: not yet recovered, must not be booked
-- the salary each employee received (take-home only), as hr-pay-release posts it
insert into public.general_ledger (transaction_group_id, transaction_date, ledger_scope, category, direction, amount, wallet_bucket, user_id, source_table, description)
select g, d::timestamptz, sc, 'salary_payout', dir, 1000000, case when sc = 'wallet' then 'withdrawable' end, usr, 'hr_pay_payslips',
       case when sc = 'wallet' then 'Salary for ' || per else 'Salary take-home' end
from (values ('2026-08','2026-08-27 14:33:20+00'), ('2026-09','2026-09-30 11:00:00+00'), ('2026-10','2026-10-28 12:57:00+00')) p(per, d),
     (values ('${u(1)}'::uuid), ('${u(2)}'::uuid), ('${u(3)}'::uuid), ('${u(4)}'::uuid)) s(usr),
     lateral (select gen_random_uuid() g) gg,
     (values ('platform','cash_out'), ('wallet','cash_in')) l(sc, dir);
`;

let db: PGlite;
const q = async <T = any>(sql: string) => (await db.query<T>(sql)).rows;
const acct = async (code: string) =>
  Number((await q<{ v: string }>(`select coalesce(round(sum(dr - cr)),0) v from public.sofp_ledger_legs(now()) where account_code = '${code}'`))[0].v);
/** Runs SQL that must fail, then clears the aborted transaction it leaves behind (the batch opens one itself). */
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
  await db.exec(DATA);
};

describe('salary advances: rules (migration 20261115110000)', () => {
  beforeAll(fresh);

  it('the batch refuses to run before the migration', async () => {
    await fails(BATCH, /migration 20261115110000 is not applied|not allowlisted/);
    expect(Number((await q(`select count(*) n from public.general_ledger where category like 'salary_advance%'`))[0].n)).toBe(0);
  });

  it('maps the four categories, keeps every live allowlist entry, and adds a P&L line', async () => {
    const before = (await q<{ a: string[] }>(`select public.ledger_category_allowlist() a`))[0].a;
    await db.exec(MIGRATION);
    const after = (await q<{ a: string[] }>(`select public.ledger_category_allowlist() a`))[0].a;
    expect(before.every((c) => after.includes(c))).toBe(true);
    expect(after.filter((c) => !before.includes(c)).sort()).toEqual(
      ['salary_advance_cash_paid', 'salary_advance_disbursed', 'salary_advance_recovered', 'salary_advance_recovery_expense']);
    const map = await q(`select category, account_code, debit_when from public.ledger_account_map where category like 'salary_advance%' order by 1`);
    expect(map).toEqual([
      { category: 'salary_advance_cash_paid', account_code: 'A1', debit_when: 'cash_in' },
      { category: 'salary_advance_disbursed', account_code: 'A27', debit_when: 'cash_in' },
      { category: 'salary_advance_recovered', account_code: 'A27', debit_when: 'cash_out' },
      { category: 'salary_advance_recovery_expense', account_code: 'X1', debit_when: 'cash_out' },
    ]);
    expect((await q(`select label from public.ledger_account_catalog where code = 'A27'`))[0].label).toBe('Staff loans and salary advances receivable');
    expect((await q(`select line_label from public.fin_pnl_lines where category = 'salary_advance_recovery_expense'`))[0].line_label).toBe('Payroll and staff costs');
    await db.exec(MIGRATION); // re-runnable
    expect(Number((await q(`select count(*) n from public.ledger_account_map where category like 'salary_advance%'`))[0].n)).toBe(4);
  });
});

describe('salary advances: batch salary_adv_202611', () => {
  let a1: number; let a27: number; let x1: number; let walletLegs: number;
  beforeAll(async () => {
    await fresh();
    await db.exec(MIGRATION);
    a1 = await acct('A1'); a27 = await acct('A27'); x1 = await acct('X1');
    walletLegs = Number((await q(`select count(*) n from public.general_ledger where ledger_scope = 'wallet'`))[0].n);
    await db.exec(BATCH);
  });

  it('records 4 payouts (7,000,000) and 11 recoveries (5,666,800); the November draft run is not booked', async () => {
    const reg = await q(`select correction_item, count(*)::int n, sum(amount)::numeric s from public.accounting_correction_register group by 1 order by 1`);
    expect(reg.map((r: any) => [r.correction_item, r.n, Number(r.s)])).toEqual([['SA1', 4, 7000000], ['SA2', 11, 5666800]]);
  });

  it('Loans and Advances to Employees +1,333,200; cash -7,000,000; salary cost +5,666,800', async () => {
    expect(await acct('A27') - a27).toBe(1333200);
    expect(await acct('A1') - a1).toBe(-7000000);
    expect(await acct('X1') - x1).toBe(5666800);
  });

  it('what each employee still owes matches the dashboard', async () => {
    const rows = await q(`select p.full_name, round(sum(case when g.direction = m.debit_when then g.amount else -g.amount end)) owed
      from public.general_ledger g join public.ledger_account_map m on m.category = g.category and m.ledger_scope = g.ledger_scope
      join public.profiles p on p.id = g.user_id where m.account_code = 'A27' group by 1 order by 1`);
    expect(Object.fromEntries(rows.map((r: any) => [r.full_name, Number(r.owed)]))).toEqual({
      'bwayo mark': 625000, 'SARAH ANGWEN': 0, 'Timothy Kalyango': 333200, 'TIMOTHY CHRISTIAN WANIAYE': 375000,
    });
  });

  it('every group balances in the production resolver and none is one-sided', async () => {
    const off = await q(`select transaction_group_id, round(sum(dr - cr)) r from public.sofp_ledger_legs(now())
      where category like 'salary_advance%' group by 1 having abs(sum(dr - cr)) > 0.5`);
    expect(off).toEqual([]);
    expect(Number((await q(`select count(*) n from public.sofp_ledger_legs(now()) where is_legacy_counterpart or (group_one_sided and category like 'salary_advance%')`))[0].n)).toBe(0);
  });

  it('dates: payouts 27 Aug before that payroll; each recovery on its month\'s salary date', async () => {
    const d = await q(`select category, to_char(transaction_date at time zone 'UTC','YYYY-MM-DD HH24:MI') d, count(*)::int n
      from public.general_ledger where category in ('salary_advance_disbursed','salary_advance_recovered') group by 1,2 order by 1,2`);
    expect(d.map((r: any) => [r.category, r.d, r.n])).toEqual([
      ['salary_advance_disbursed', '2026-08-27 05:00', 4],
      ['salary_advance_recovered', '2026-08-27 14:33', 3],
      ['salary_advance_recovered', '2026-09-30 11:00', 4],
      ['salary_advance_recovered', '2026-10-28 12:57', 4],
    ]);
  });

  it('posts platform legs only: no wallet leg, wallet totals unchanged', async () => {
    expect(Number((await q(`select count(*) n from public.general_ledger where category like 'salary_advance%' and ledger_scope <> 'platform'`))[0].n)).toBe(0);
    expect(Number((await q(`select count(*) n from public.general_ledger where ledger_scope = 'wallet'`))[0].n)).toBe(walletLegs);
  });

  it('cannot be posted twice', async () => {
    await fails(BATCH, /already posted/);
    expect(Number((await q(`select count(*) n from public.accounting_correction_register`))[0].n)).toBe(15);
  });

  it('the rule rollback refuses while the batch legs exist', async () => {
    await fails(ROLLBACK, /roll back the posting batch first/);
  });
});

describe('salary advances: the batch stops when the evidence changed', () => {
  it('refuses if an advance amount no longer matches', async () => {
    await fresh();
    await db.exec(MIGRATION);
    await db.exec(`update public.hr_pay_advances set principal = 2600000 where id = '${ADV.bwayo}'`);
    await fails(BATCH, /STOP: advances are/);
    expect(Number((await q(`select count(*) n from public.general_ledger where category like 'salary_advance%'`))[0].n)).toBe(0);
  });

  it('refuses if a recovery was added or removed', async () => {
    await fresh();
    await db.exec(MIGRATION);
    await db.exec(`delete from public.hr_pay_advance_recoveries where amount = 333400 and run_id = '${RUN['2026-10']}'`);
    await fails(BATCH, /STOP: recoveries are/);
  });

  it('the rule rollback restores the live allowlist, mapping and label when nothing was posted', async () => {
    await fresh();
    const live = (await q<{ a: string[] }>(`select public.ledger_category_allowlist() a`))[0].a;
    await db.exec(MIGRATION);
    await db.exec(ROLLBACK);
    expect((await q<{ a: string[] }>(`select public.ledger_category_allowlist() a`))[0].a).toEqual(live);
    expect(Number((await q(`select count(*) n from public.ledger_account_map where category like 'salary_advance%'`))[0].n)).toBe(0);
    expect((await q(`select label from public.ledger_account_catalog where code = 'A27'`))[0].label).toBe('Staff loans receivable');
  });
});
