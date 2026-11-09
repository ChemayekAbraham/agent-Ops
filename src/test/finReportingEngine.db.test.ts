// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- assertions over untyped JSON returned by the SQL functions */
/**
 * Financial reporting engine (Phase C, reporting only) — supabase/migrations/20261110090000_fin_reporting_engine.sql
 * run verbatim on PGlite over a synthetic ledger that follows the real Rent Plan flow traced on 9 Nov 2026
 * (plan 477a0208: pool deploy, funding, fees, float-backed repayment, four-part fee split, principal back to the pool),
 * plus a Supporter Return, a merchant float reset, a float correction, Supporter capital and one one-sided cash leg.
 *
 * sofp_ledger_legs is a stand-in returning pre-resolved legs (the production resolver is replayed separately,
 * read-only). get_statement_of_financial_position is a small stand-in with the production output shape.
 *
 * Money safety: every engine function must be STABLE (PostgreSQL refuses writes inside STABLE functions), and
 * tripwire triggers on wallet / ledger / payout tables fail the test on any write.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 600_000 });

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const MIG = read('supabase/migrations/20261110090000_fin_reporting_engine.sql');
const RB = read('supabase/rollbacks/20261110090000_fin_reporting_engine.rollback.sql');

const CFO = '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b';
const AGENT = '00000000-0000-0000-0000-00000000a001';
const g = (n: number) => `00000000-0000-0000-0004-${String(n).padStart(12, '0')}`;

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create type public.app_role as enum ('cfo','ceo','coo','manager','financial_ops','super_admin','cto','agent');
create table public.user_roles (user_id uuid, role public.app_role);
create function public.has_role(p_user uuid, p_role public.app_role) returns boolean language sql stable as
  $$ select exists (select 1 from public.user_roles where user_id = p_user and role = p_role) $$;
create function public.staff_mfa_ok() returns boolean language sql stable as $$ select true $$;
insert into public.user_roles values ('${CFO}','cfo'), ('${AGENT}','agent');

create table public.ledger_account_catalog (code text primary key, label text, section text, nature text, sort_order int);
insert into public.ledger_account_catalog values
 ('A1','Cash and Bank Balances','current_asset','asset',1), ('A2','Cash at Hand — Float with Agents','current_asset','asset',2),
 ('A3','Rent Access Receivables (Tenants)','current_asset','asset',3), ('A5','Cash in Transit','current_asset','asset',5),
 ('A7','Partner Product Receivables','current_asset','asset',7), ('A8','Float Cycle Control','current_asset','asset',8),
 ('A9','Suspense','current_asset','asset',9), ('A10','Agent Advances Receivable','current_asset','asset',10),
 ('A11','Agent Advance Access Fees Receivable','current_asset','asset',11), ('A20','Agent Advance Registration Fees','current_asset','asset',20),
 ('A22','Landlord Float Pool — Company-Managed','current_asset','asset',22),
 ('L1','Wallet Custody Payable','current_liability','liability',31), ('L2','Partner Portfolios — Capital Held','non_current_liability','liability',32),
 ('L4','Landlord Rent Payable','current_liability','liability',34), ('L7','Platform Treasury Control','current_liability','liability',37),
 ('E1','Shareholders Capital','equity','equity',41), ('R1','Platform Revenue','revenue','revenue',51),
 ('X1','Operating Expenses','expense','expense',61), ('X2','Partner Returns Expense','expense','expense',62),
 ('X3','Agent Commission Expense','expense','expense',63), ('X6','Float Restatement Adjustments','expense','expense',66);

create table public._legs (gid uuid, sc text, cat text, src text, acct text, dr numeric, cr numeric, legacy boolean default false, tdate timestamptz);
create function public.sofp_ledger_legs(p_as_at timestamptz)
returns table(transaction_group_id uuid, ledger_scope text, category text, source_table text, account_code text,
              dr numeric, cr numeric, group_one_sided boolean, is_legacy_counterpart boolean, transaction_date timestamptz)
language sql stable as $$ select gid, sc, cat, src, acct, dr, cr, false, legacy, tdate from public._legs where tdate <= p_as_at $$;

create function public.get_statement_of_financial_position(p_as_at timestamptz) returns jsonb language sql stable as $$
  with b as (select c.code, c.label, c.section, c.nature, c.sort_order,
                    coalesce(sum(case when c.nature in ('asset','expense') then l.dr - l.cr else l.cr - l.dr end), 0) v
             from public.ledger_account_catalog c left join public._legs l on l.acct = c.code and l.tdate <= p_as_at
             group by 1,2,3,4,5),
  line as (select section, jsonb_agg(jsonb_build_object('label', label, 'value', v, 'source', 'general_ledger trial balance — account ' || code) order by sort_order) j, sum(v) t
           from b group by section)
  select jsonb_build_object(
    'assets', jsonb_build_object('current', coalesce((select j from line where section='current_asset'),'[]'), 'non_current', '[]'::jsonb),
    'liabilities', jsonb_build_object('current', coalesce((select j from line where section='current_liability'),'[]'),
                                      'non_current', coalesce((select j from line where section='non_current_liability'),'[]')),
    'balance_check', jsonb_build_object('difference',
       coalesce((select t from line where section='current_asset'),0)
       - coalesce((select sum(t) from line where section in ('current_liability','non_current_liability')),0)
       - coalesce((select sum(t) from line where section='equity'),0)
       - (coalesce((select t from line where section='revenue'),0) - coalesce((select t from line where section='expense'),0))))
$$;

create table public.wallets (withdrawable_balance numeric, locked_balance numeric, float_balance numeric, advance_balance numeric);
create table public.rent_requests (id uuid, status text, total_repayment numeric, amount_repaid numeric, created_at timestamptz);
create table public.agent_advances (status text, outstanding_balance numeric, arrears_balance numeric, created_at timestamptz);
create table public.investor_portfolios (status text, investment_amount numeric, created_at timestamptz);
create table public.promissory_notes (status text, amount numeric, total_collected numeric, created_at timestamptz);
create table public.ledger_mapped_balance_violations (transaction_group_id uuid, residual numeric, source_table text, detected_at timestamptz);
create table public.gmail_transactions (channel text, balance numeric, internal_date timestamptz, created_at timestamptz, from_email text, direction text, amount numeric);
create table public.cash_deposit_verifications (deposit_request_id uuid, amount numeric, status text, verified_at timestamptz, created_at timestamptz);
create table public.deposit_requests (id uuid, purpose_audit jsonb);
create table public.general_ledger (id serial, transaction_group_id uuid, source_table text, source_id uuid, category text, ledger_scope text,
  direction text, amount numeric, classification text, transaction_date timestamptz, created_at timestamptz);
create table public.withdrawal_requests (id uuid, status text, amount numeric);
create table public.agent_collections (rent_request_id uuid, amount numeric, reversed_at timestamptz);
create table public.merchandise_recovery_plans (id uuid, item_name text, original_amount numeric, outstanding_balance numeric, daily_deduction_amount numeric, status text);
create table public.landlord_payouts (id uuid, rent_request_id uuid, amount numeric, status text, created_at timestamptz);

-- tripwires: any write to money tables fails the test
create table public._writes (t text, at timestamptz default now());
create function public._tripwire() returns trigger language plpgsql as $$ begin insert into public._writes(t) values (TG_TABLE_NAME); return null; end $$;
create trigger tw after insert or update or delete on public.wallets for each statement execute function public._tripwire();
create trigger tw after insert or update or delete on public.general_ledger for each statement execute function public._tripwire();
create trigger tw after insert or update or delete on public.landlord_payouts for each statement execute function public._tripwire();
create trigger tw after insert or update or delete on public.merchandise_recovery_plans for each statement execute function public._tripwire();
create trigger tw after insert or update or delete on public.withdrawal_requests for each statement execute function public._tripwire();
`;

// Resolved legs (account, DR, CR). October 2026 is the reporting period; G0 is September.
const LEGS = `
insert into public._legs (gid, sc, cat, src, acct, dr, cr, tdate) values
 ('${g(0)}','platform','share_capital','angel_pool_investments','A1',500000,0,'2026-09-01 10:00+03'),
 ('${g(0)}','platform','share_capital','angel_pool_investments','E1',0,500000,'2026-09-01 10:00+03'),
 ('${g(1)}','platform','rent_disbursement','rent_requests','A1',0,200000,'2026-10-02 11:25+03'),
 ('${g(1)}','bridge','rent_receivable_created','rent_requests','A3',200000,0,'2026-10-02 11:25+03'),
 ('${g(2)}','platform','landlord_pool_deploy_target','returned_principal','A1',200000,0,'2026-10-02 11:25+03'),
 ('${g(2)}','platform','landlord_pool_deploy_company_managed','returned_principal','A22',0,200000,'2026-10-02 11:25+03'),
 ('${g(3)}','bridge','fee_receivable_created','rent_requests','A3',76000,0,'2026-10-02 11:25+03'),
 ('${g(3)}','platform','treasury_fee_recognised','rent_requests','L7',0,76000,'2026-10-02 11:25+03'),
 ('${g(4)}','wallet','agent_float_deposit','deposit_requests','A2',23000,0,'2026-10-03 18:42+03'),
 ('${g(4)}','platform','agent_float_deposit','deposit_requests','A8',0,23000,'2026-10-03 18:42+03'),
 ('${g(5)}','wallet','agent_float_used_for_rent','agent_collections','A2',0,2000,'2026-10-07 11:57+03'),
 ('${g(5)}','platform','tenant_repayment_collected','agent_collections','A3',0,2000,'2026-10-07 11:57+03'),
 ('${g(5)}','reconciliation','float_backed_collection_counterpart','agent_collections','A5',2000,0,'2026-10-07 11:57+03'),
 ('${g(5)}','reconciliation','float_backed_collection_counterpart','agent_collections','L4',2000,0,'2026-10-07 11:57+03'),
 ('${g(5)}','platform','agent_commission_payable','agent_collections','X3',200,0,'2026-10-07 11:57+03'),
 ('${g(5)}','wallet','agent_commission_earned','agent_collections','L1',0,200,'2026-10-07 11:57+03'),
 ('${g(6)}','platform','treasury_fee_drawdown','agent_collections','L7',550,0,'2026-10-07 11:57+03'),
 ('${g(6)}','platform','platform_fee_collected','agent_collections','R1',0,133,'2026-10-07 11:57+03'),
 ('${g(6)}','platform','partner_returns_allocated','agent_collections','L7',0,217,'2026-10-07 11:57+03'),
 ('${g(6)}','platform','agent_commission_payable','agent_collections','X3',0,200,'2026-10-07 11:57+03'),
 ('${g(7)}','platform','landlord_pool_return_company_managed','returned_principal','A22',1450,0,'2026-10-07 11:57+03'),
 ('${g(7)}','platform','landlord_pool_return_source','returned_principal','A5',0,1450,'2026-10-07 11:57+03'),
 ('${g(8)}','platform','roi_expense','investor_portfolios','X2',10000,0,'2026-10-10 09:00+03'),
 ('${g(8)}','wallet','roi_wallet_credit','investor_portfolios','L1',0,10000,'2026-10-10 09:00+03'),
 ('${g(9)}','wallet','system_balance_correction','merchant_float_reconciliations','A2',0,1000000,'2026-10-11 09:00+03'),
 ('${g(9)}','platform','system_balance_correction','merchant_float_reconciliations','A8',1000000,0,'2026-10-11 09:00+03'),
 ('${g(10)}','platform','marketing_expense','landlords','X1',5000,0,'2026-10-12 09:00+03'),
 ('${g(10)}','platform','wallet_withdrawal','withdrawal_requests','A1',0,5000,'2026-10-12 09:00+03'),
 ('${g(11)}','platform','system_balance_correction','finops_wallet_move','X6',300,0,'2026-10-13 09:00+03'),
 ('${g(11)}','wallet','agent_float_assignment','finops_wallet_move','A2',0,300,'2026-10-13 09:00+03'),
 ('${g(12)}','platform','partner_capital_cash_received','investor_portfolios','A1',1000000,0,'2026-10-14 09:00+03'),
 ('${g(12)}','platform','partner_funding','investor_portfolios','L2',0,1000000,'2026-10-14 09:00+03'),
 ('${g(13)}','platform','wallet_deposit','deposit_requests','A1',777,0,'2026-10-15 09:00+03'),
 -- g14: fee received 30 Sep, reversed 3 Oct inside the same group (legs carry different dates)
 ('${g(14)}','platform','platform_fee_collected','agent_collections','A1',100,0,'2026-09-30 10:00+03'),
 ('${g(14)}','platform','platform_fee_collected','agent_collections','R1',0,100,'2026-09-30 10:00+03'),
 ('${g(14)}','platform','platform_fee_collected','agent_collections','A1',0,100,'2026-10-03 10:00+03'),
 ('${g(14)}','platform','platform_fee_collected','agent_collections','R1',100,0,'2026-10-03 10:00+03');

insert into public.wallets values (100, 50, 400, 0);
insert into public.rent_requests values ('${g(101)}','repaying',276000,2000,'2026-10-01'), ('${g(102)}','completed',100000,40000,'2026-09-01');
insert into public.agent_advances values ('active', 900, 100, '2026-10-01');
insert into public.investor_portfolios values ('active', 1000000, '2026-10-14');
insert into public.promissory_notes values ('activated', 0, 0, '2026-10-01');
insert into public.merchandise_recovery_plans values ('${g(201)}','Company Ids',3159000000,3159000000,41400000,'active'), ('${g(202)}','Phone',400000,300000,5000,'active');
insert into public.general_ledger (transaction_group_id, source_table, source_id, category, ledger_scope, direction, amount, classification, transaction_date, created_at) values
 ('${g(301)}','rent_requests','${g(103)}','rent_disbursement','platform','cash_out',700000,'production','2026-10-27','2026-10-27'),
 ('${g(302)}','rent_requests','${g(103)}','rent_disbursement','platform','cash_in',700000,'production','2026-11-03','2026-11-03');
insert into public.landlord_payouts values ('${g(401)}','${g(103)}',700000,'pending_merchant_payout','2026-10-27');
insert into public.withdrawal_requests values ('${g(501)}','completed',12345);
insert into public.agent_collections values ('${g(102)}', 100000, '2026-10-05'), ('${g(102)}', 30000, null);
`;

let db: PGlite;
const asUser = async (uid: string, sql: string) => {
  await db.exec(`select set_config('test.uid', '${uid}', false)`);
  return db.query<{ r: Record<string, any> }>(sql);
};
const call = async (sql: string) => (await asUser(CFO, `select ${sql} as r`)).rows[0].r;
const OCT = `'2026-10-01 00:00+03', '2026-11-01 00:00+03'`;

describe('fin reporting engine (reporting only)', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`set timezone = 'UTC'`);
    await db.exec(SCHEMA);
    await db.exec(LEGS);
    await db.exec(MIG);
    await db.exec('truncate public._writes'); // seeding above is not part of the test
  });

  it('income statement uses only revenue and expense accounts', async () => {
    const r = await call(`public.fin_income_statement(${OCT})`);
    expect(r.totals.revenue).toBe(33); // 133 four-part fee less the 100 reversed on 3 Oct
    expect(r.totals.cost_of_revenue).toBe(10000); // Supporter Returns 10,000; agent commission 200 - 200 = 0
    expect(r.totals.operating_expenses).toBe(5000);
    expect(r.totals.other_items).toBe(300);
    expect(r.totals.net_result).toBe(-15267);
    expect(r.reconciliation.ties_to_ledger).toBe(true);
    expect(r.sections.revenue.lines[0].label).toBe('Platform fee on repayments (four-part split)');
    expect(r.months).toEqual([{ month: '2026-10', revenue: 33, expenses: 15300, net_result: -15267 }]);
  });

  it('a merchant float reset and the Rent Plan advance never reach profit and loss', async () => {
    const r = await call(`public.fin_income_statement(${OCT})`);
    const labels = Object.values(r.sections).flatMap((s: any) => s.lines.map((l: any) => l.label));
    expect(labels.join('|')).not.toMatch(/float reset|rent/i);
  });

  it('cash flow: direct method, internal moves eliminated, no balancing line', async () => {
    const r = await call(`public.fin_cash_flow(${OCT})`);
    expect(r.opening_cash).toBe(500100);
    expect(r.net_change).toBe(797677);
    expect(r.closing_cash).toBe(1297777);
    expect(r.explained_net_change).toBe(796900);
    // the one-sided cash leg is reported as unexplained, not hidden in a line
    expect(r.unexplained_difference).toBe(777);
    expect(r.unexplained_groups_count).toBe(1);
    expect(r.unexplained_groups[0].group).toBe(g(13));
    expect(r.reconciles).toBe(false);
    const lines = ['operating', 'investing', 'financing'].flatMap((s) => r[s].groups.flatMap((x: any) => x.lines.map((l: any) => l.label)));
    expect(lines).toContain('Rent paid for tenants');
    expect(lines).toContain('Tenant repayments received');
    expect(lines).toContain('Supporter capital received');
    expect(lines.join('|')).not.toMatch(/pool|balancing|residual/i);
    expect(r.financing.total).toBe(1000000);
  });

  it('a reversal dated in a later month is explained in that month, not reported as a gap', async () => {
    const r = await call(`public.fin_cash_flow(${OCT})`);
    expect(r.unexplained_groups.map((x: any) => x.group)).not.toContain(g(14));
    const sep = await call(`public.fin_cash_flow('2026-09-01 00:00+03', '2026-10-01 00:00+03')`);
    expect(sep.unexplained_difference).toBe(0);
    expect(sep.net_change).toBe(500100);
  });

  it('cash flow ties to the balance-sheet cash accounts', async () => {
    const r = await call(`public.fin_cash_flow(${OCT})`);
    expect(r.ties_to_balance_sheet).toBe(true);
    const a22 = r.cash_accounts.find((a: any) => a.code === 'A22');
    expect(a22.restricted).toBe(true);
    expect(a22.closing).toBe(-198550);
  });

  it('balance sheet adds sub-ledger ties and disclosures', async () => {
    const r = await call(`public.fin_balance_sheet('2026-11-01 00:00+03')`);
    const tie = (k: string) => r.subledger_ties.find((t: any) => t.key === k);
    expect(tie('rent_plans').ledger).toBe(274000);      // 200,000 + 76,000 - 2,000
    expect(tie('rent_plans').operational).toBe(274000);  // repaying plan only; 'completed' plans are not in the book
    expect(tie('rent_plans').difference).toBe(0);
    expect(tie('agent_advances').operational).toBe(1000);
    expect(tie('supporter_capital').difference).toBe(0);
    expect(tie('wallet_custody').operational).toBe(150);
    expect(r.disclosures.length).toBe(4);
  });

  it('controls flag the real risks found in the investigation', async () => {
    const r = await call(`public.fin_controls('2026-11-09 12:00+03')`);
    const c = (id: string) => r.controls.find((x: any) => x.id === id);
    expect(c('C16').status).toBe('fail');
    expect(c('C16').value).toBe(1);
    expect(c('C19').status).toBe('fail');
    expect(c('C19').amount).toBe(700000);
    expect(c('C15').value).toBe(1);
    expect(c('C11').value).toBe(1);
    expect(c('C11').amount).toBe(70000); // 100,000 due less 30,000 actually collected (the reversed 100,000 does not count)
    expect(r.summary.fail).toBeGreaterThan(0);
  });

  it('every engine function is read-only (STABLE) and nothing was written', async () => {
    const f = await db.query<{ proname: string; provolatile: string }>(
      `select proname, provolatile from pg_proc where proname in ('fin_income_statement','fin_balance_sheet','fin_cash_flow','fin_controls','_fin_can_view')`);
    expect(f.rows.length).toBe(5);
    expect(f.rows.every((x) => x.provolatile === 's')).toBe(true);
    const w = await db.query<{ n: number }>(`select count(*)::int n from public._writes`);
    expect(w.rows[0].n).toBe(0);
  });

  it('re-running the migration does not duplicate line maps or change figures', async () => {
    const before = await call(`public.fin_income_statement(${OCT})`);
    await db.exec(MIG);
    const n = await db.query<{ n: number }>(`select count(*)::int n from public.fin_pnl_lines where category is null`);
    const d = await db.query<{ n: number }>(`select count(*)::int n from (select account_code from public.fin_pnl_lines where category is null group by 1 having count(*) > 1) z`);
    expect(n.rows[0].n).toBeGreaterThan(0);
    expect(d.rows[0].n).toBe(0);
    const after = await call(`public.fin_income_statement(${OCT})`);
    expect(after.totals).toEqual(before.totals);
  });

  it('refuses non-finance users', async () => {
    await expect(asUser(AGENT, `select public.fin_income_statement(${OCT})`)).rejects.toThrow(/Not authorised/);
    await expect(asUser(AGENT, `select public.fin_controls()`)).rejects.toThrow(/Not authorised/);
  });

  it('rollback removes the engine', async () => {
    await db.exec(RB);
    const f = await db.query<{ n: number }>(`select count(*)::int n from pg_proc where proname like 'fin\\_%' or proname = '_fin_can_view'`);
    expect(f.rows[0].n).toBe(0);
  });
});
