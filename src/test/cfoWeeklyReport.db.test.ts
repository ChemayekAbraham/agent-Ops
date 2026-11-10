// @vitest-environment node
/**
 * General Weekly CFO Report (get_cfo_weekly_report) — Monday-to-Sunday week, Kampala time, ledger-account basis.
 *
 * Runs supabase/migrations/20261109170000_cfo_weekly_report_mon_sun_ledger_basis.sql verbatim on PGlite over minimal
 * tables with production's column names. sofp_ledger_legs is a stand-in returning pre-resolved legs from a table (the
 * production resolver is checked separately: on 2026-11-09 the report's figures for 2-8 Nov 2026 equalled the treasury
 * card and the Statement of Financial Position, read-only). Then runs the rollback and checks the old signature returns.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { CfoWeeklyReport } from '../lib/cfoWeeklyReport';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 600_000 });

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const MIG = read('supabase/migrations/20261109170000_cfo_weekly_report_mon_sun_ledger_basis.sql');
const RB = read('supabase/rollbacks/20261109170000_cfo_weekly_report_mon_sun_ledger_basis.rollback.sql');

const CFO = '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b';
const AGENT = '00000000-0000-0000-0000-00000000a001';

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create type public.app_role as enum ('cfo', 'ceo', 'coo', 'manager', 'financial_ops', 'super_admin', 'cto', 'agent');
create table public.user_roles (user_id uuid, role public.app_role);
create function public.has_role(p_user uuid, p_role public.app_role) returns boolean language sql stable as
  $$ select exists (select 1 from public.user_roles where user_id = p_user and role = p_role) $$;
create table public.general_ledger (
  id bigserial primary key, transaction_date timestamptz, category text, description text, reference_id text,
  direction text, amount numeric, ledger_scope text, wallet_bucket text, classification text, source_table text);
create table public.ledger_account_map (ledger_scope text, category text, wallet_bucket text, account_code text, debit_when text);
create table public.ledger_account_catalog (code text primary key, label text);
create table public.pending_wallet_operations (amount numeric, status text);
create table public.agent_advances (outstanding_balance numeric, status text);
create table public.wallet_totals_cache (id int, total_balance numeric, total_withdrawable numeric, total_float numeric);
create table public.subscription_charges (accumulated_debt numeric, status text);
create table public._resolved_legs (account_code text, category text, dr numeric, cr numeric, transaction_date timestamptz);
create function public.sofp_ledger_legs(p_as_at timestamptz)
returns table(transaction_group_id uuid, ledger_scope text, category text, source_table text, account_code text,
              dr numeric, cr numeric, group_one_sided boolean, is_legacy_counterpart boolean, transaction_date timestamptz)
language sql stable as $$
  select null::uuid, 'platform', r.category, null, r.account_code, r.dr, r.cr, false, false, r.transaction_date
  from public._resolved_legs r where r.transaction_date <= p_as_at $$;
insert into public.user_roles values ('${CFO}', 'cfo'), ('${AGENT}', 'agent');
insert into public.ledger_account_map values
  ('platform', 'treasury_bank_deposit', null, 'A1', 'cash_in'),
  ('platform', 'cash_receipt_in_transit', null, 'A5', 'cash_in'),
  ('platform', 'landlord_pool_deploy_target', null, 'A22', 'cash_in');
insert into public.ledger_account_catalog values ('A3', 'Rent Access Receivables (Tenants)'), ('A7', 'Partner Product Receivables'),
  ('A10', 'Agent Advances Receivable'), ('L1', 'Wallet Custody Payable (user balances)'), ('L2', 'Partner Portfolios — Capital Held'),
  ('L7', 'Platform Treasury Control — Landlord Flow');
insert into public.pending_wallet_operations values (7887, 'pending'), (500, 'done');
insert into public.agent_advances values (100, 'active'), (50, 'closed');
`;

// Cash legs, Kampala local times (UTC+3). The reporting week is Mon 2 Nov - Sun 8 Nov 2026.
const CASH = `
insert into public.general_ledger (transaction_date, category, description, direction, amount, ledger_scope, classification) values
  ('2026-10-20 10:00+03', 'treasury_bank_deposit',   'old',            'cash_in',  1000, 'platform', 'production'),
  ('2026-10-28 10:00+03', 'cash_receipt_in_transit', 'previous week',  'cash_in',   300, 'platform', 'production'),
  ('2026-11-01 23:59+03', 'cash_receipt_in_transit', 'Sunday before',  'cash_in',    10, 'platform', 'production'),
  ('2026-11-02 00:00+03', 'cash_receipt_in_transit', 'Monday 00:00',   'cash_in',    20, 'platform', 'production'),
  ('2026-11-02 01:00+03', 'treasury_bank_deposit',   'Monday payout',  'cash_out',  200, 'platform', 'production'),
  ('2026-11-08 23:59+03', 'cash_receipt_in_transit', 'Sunday 23:59',   'cash_in',    40, 'platform', 'production'),
  ('2026-11-09 00:00+03', 'cash_receipt_in_transit', 'next Monday',    'cash_in',   999, 'platform', 'production'),
  ('2026-11-03 10:00+03', 'cash_receipt_in_transit', 'test row',       'cash_in',  5000, 'platform', 'test_dev'),
  ('2026-10-30 10:00+03', 'landlord_pool_deploy_target', 'pool',       'cash_in',   700, 'platform', 'production'),
  ('2026-11-04 10:00+03', 'landlord_pool_deploy_target', 'pool',       'cash_in',    70, 'platform', 'production');
insert into public._resolved_legs values
  ('R1', 'platform_fee_collected', 0,   30, '2026-11-03 10:00+03'),
  ('R1', 'platform_fee_collected', 0,   12, '2026-10-29 10:00+03'),
  ('R2', 'agent_advance_fee_revenue', 0, 5, '2026-11-08 23:00+03'),
  ('X2', 'roi_expense',            80,   0, '2026-11-05 10:00+03'),
  ('X6', 'system_balance_correction', 400, 0, '2026-11-06 10:00+03'),
  ('X1', 'interest_expense',       0,    9, '2026-11-06 10:00+03'),
  ('X1', 'marketing_expense',      7,    0, '2026-11-09 00:00+03'),
  ('A3', 'tenant_repayment',      500,   0, '2026-10-01 10:00+03'),
  ('A3', 'tenant_repayment',        0,  60, '2026-11-04 10:00+03'),
  ('A7', 'partner_receivable_capital', 1000, 0, '2026-10-01 10:00+03'),
  ('A10','agent_advance_disbursement', 40, 0, '2026-11-04 10:00+03'),
  ('A4', 'agent_advance_memo_offset',  9,  0, '2026-11-04 10:00+03'),
  ('L1', 'wallet_deposit',          0, 300, '2026-10-01 10:00+03'),
  ('L1', 'wallet_withdrawal',      50,   0, '2026-11-07 10:00+03'),
  ('L7', 'platform_fee_collected',  0,  25, '2026-11-03 10:00+03'),
  ('L2', 'partner_funding',         0, 5000, '2026-10-01 10:00+03');
`;

let db: PGlite;
const asUser = async (uid: string, sql: string) => {
  await db.exec(`select set_config('test.uid', '${uid}', false)`);
  return db.query<{ r: CfoWeeklyReport }>(sql);
};
const report = async (arg = `'2026-11-02'`) => (await asUser(CFO, `select public.get_cfo_weekly_report(${arg}) as r`)).rows[0].r;

describe('get_cfo_weekly_report: Monday to Sunday, ledger basis', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`set timezone = 'UTC'`);
    await db.exec(SCHEMA);
    await db.exec(CASH);
    await db.exec(MIG);
  });

  it('covers Monday 00:00 to the end of Sunday in Kampala time', async () => {
    const r = await report();
    expect(r.period.week_start).toBe('2026-11-02');
    expect(r.period.week_end).toBe('2026-11-08');
    expect(r.period.complete).toBe(true);
    expect(new Date(r.period.from).toISOString()).toBe('2026-11-01T21:00:00.000Z');
    expect(new Date(r.period.to).toISOString()).toBe('2026-11-08T21:00:00.000Z');
    expect(r.previous_period.week_start).toBe('2026-10-26');
    // Monday 00:00 (20) and Sunday 23:59 (40) are in; Sunday before (10) and next Monday (999) are out; test_dev ignored.
    expect(r.cash_flow.inflows).toBe(60);
    expect(r.cash_flow.outflows).toBe(200);
    expect(r.cash_flow.prev_inflows).toBe(310);
    expect(r.daily_flow.map((d) => d.day)).toEqual(['2026-11-02', '2026-11-08']);
  });

  it('reports cash and the landlord pool on the treasury card basis', async () => {
    const { cash } = await report();
    expect(cash.opening_cash).toBe(1310);
    expect(cash.closing_cash).toBe(1170);
    expect(cash.net_change).toBe(-140);
    expect(cash.opening_cash + cash.net_change).toBe(cash.closing_cash);
    expect(cash.opening_pool).toBe(700);
    expect(cash.closing_pool).toBe(770);
    expect(cash.closing_incl_pool).toBe(1940);
  });

  it('takes profit and loss from the revenue and expense accounts only', async () => {
    const { profit_and_loss: pnl, revenue_lines, expense_lines } = await report();
    expect(pnl.revenue).toBe(35);
    expect(pnl.expenses).toBe(471); // 80 + 400 - 9; the 7 dated next Monday is excluded
    expect(pnl.float_restatement).toBe(400);
    expect(pnl.prev_revenue).toBe(12);
    expect(revenue_lines[0]).toMatchObject({ account_code: 'R1', category: 'platform_fee_collected', amount: 30, prev_amount: 12 });
    expect(expense_lines.map((l) => l.account_code)).toEqual(['X6', 'X2', 'X1']);
  });

  it('takes receivables and payables from the balance-sheet accounts', async () => {
    const { receivables: rc, payables: pb, position: ps } = await report();
    expect(rc.tenant_outstanding).toBe(440);
    expect(rc.opening_tenant_outstanding).toBe(500);
    expect(rc.advances_outstanding).toBe(40);
    expect(rc.advances_active_count).toBe(1);
    expect(rc.other).toBe(1000);
    expect(rc.total).toBe(1480); // A4 excluded
    expect(pb.wallet_total).toBe(250);
    expect(pb.total).toBe(275);
    expect(pb.opening_total).toBe(300);
    expect(pb.supporter_capital).toBe(5000);
    expect(pb.pending_operations_amount).toBe(7887);
    expect(pb.lines.map((l) => l.account_code)).toEqual(['L1', 'L7']);
    expect(ps.current_assets).toBe(1489);
    expect(ps.current_liabilities).toBe(275);
    expect(ps.net_working_capital).toBe(1214);
    expect(ps.money_we_can_use).toBe(895);
  });

  it('moves any date to the Monday of its week', async () => {
    const r = await report(`'2026-11-05'`);
    expect(r.period.week_start).toBe('2026-11-02');
  });

  it('defaults to the last completed week and marks the current week as in progress', async () => {
    const def = await report('');
    const thisMon = (await db.query<{ d: string }>(
      `select to_char(date_trunc('week', now() at time zone 'Africa/Kampala'), 'YYYY-MM-DD') d`)).rows[0].d;
    const lastMon = new Date(`${thisMon}T00:00:00Z`);
    lastMon.setUTCDate(lastMon.getUTCDate() - 7);
    expect(def.period.week_start).toBe(lastMon.toISOString().slice(0, 10));
    expect(def.period.complete).toBe(true);
    const cur = await report(`'${thisMon}'`);
    expect(cur.period.complete).toBe(false);
  });

  it('refuses a future week and non-finance users', async () => {
    await expect(report(`'2999-01-04'`)).rejects.toThrow(/has not begun/);
    await expect(asUser(AGENT, `select public.get_cfo_weekly_report('2026-11-02')`)).rejects.toThrow(/Not authorised/);
  });

  it('rollback restores the previous function', async () => {
    await db.exec(RB);
    const sig = await db.query<{ s: string }>(`select p.oid::regprocedure::text s from pg_proc p where proname = 'get_cfo_weekly_report'`);
    expect(sig.rows.map((x) => x.s)).toEqual(['get_cfo_weekly_report(timestamp with time zone)']);
  });
});
