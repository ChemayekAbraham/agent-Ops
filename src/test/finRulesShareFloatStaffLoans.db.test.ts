// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- assertions over untyped JSON / rows returned by SQL */
/**
 * Permanent accounting rules for Angel Pool shares paid from company float and for staff loans
 * (supabase/migrations/20261111090100_fin_rules_share_float_staff_loans.sql) and the Balance Sheet comparison lines
 * (supabase/migrations/20261111090000_fin_bs_memo_lines.sql), run verbatim on PGlite.
 *
 * The ledger resolver is PRODUCTION's sofp_ledger_legs (fixture copied 11 Nov 2026; md5 87940f3b… matches live), so
 * the test reproduces the real −6,905,000 imbalance from the real leg shapes and proves the new mappings remove it.
 * create_ledger_transaction is a stand-in that inserts legs and enforces raw cash_in = cash_out per group.
 * Money safety: the wallet leg of a staff-loan recovery must be identical before and after the change.
 *
 * NOTE (pre-existing production defect, reported to the CFO 11 Nov 2026): staff_loan_recover_from_wallet fails in
 * production with "column reference loan_id is ambiguous" (its OUT column loan_id clashes with unqualified
 * loan_id in the loop; production plpgsql.variable_conflict = error). This test sets variable_conflict to
 * use_column for BOTH the production and the new version, only to exercise the accounting legs. Fixing the defect
 * would start real wallet deductions, which is a business decision outside this change.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 600_000 });

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const RESOLVER = read('src/test/fixtures/sofp_ledger_legs.live.sql');
const ENGINE = read('supabase/migrations/20261110090000_fin_reporting_engine.sql');
const MEMO = read('supabase/migrations/20261111090000_fin_bs_memo_lines.sql');
const RULES = read('supabase/migrations/20261111090100_fin_rules_share_float_staff_loans.sql');
const RULES_RB = read('supabase/rollbacks/20261111090100_fin_rules_share_float_staff_loans.rollback.sql');
// Production's recovery function as it is today = the body the rollback restores
const RECOVER_LIVE = RULES_RB.slice(RULES_RB.indexOf('CREATE OR REPLACE FUNCTION public.staff_loan_recover_from_wallet'));
const ALLOW_LIVE = RULES_RB.slice(RULES_RB.indexOf('CREATE OR REPLACE FUNCTION public.ledger_category_allowlist()'),
  RULES_RB.indexOf('CREATE OR REPLACE FUNCTION public.staff_loan_recover_from_wallet'));

const CFO = '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b';
const STAFF = '00000000-0000-0000-0000-0000000000a5';
const PIUS_GID = '121a7430-bb4a-458c-9859-51b8c16c63b5';
const gid = (n: number) => `00000000-0000-0000-00aa-${String(n).padStart(12, '0')}`;

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth; create schema extensions;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create type public.app_role as enum ('cfo','ceo','coo','manager','financial_ops','super_admin','cto','agent','employee');
create table public.user_roles (user_id uuid, role public.app_role);
create function public.has_role(p_user uuid, p_role public.app_role) returns boolean language sql stable as
  $$ select exists (select 1 from public.user_roles where user_id = p_user and role = p_role) $$;
create function public.staff_mfa_ok() returns boolean language sql stable as $$ select true $$;
insert into public.user_roles values ('${CFO}','cfo');

create table public.general_ledger (
  id uuid primary key default gen_random_uuid(), transaction_group_id uuid, transaction_date timestamptz, created_at timestamptz default now(),
  ledger_scope text, category text, direction text, amount numeric, wallet_bucket text, user_id uuid,
  source_table text, source_id uuid, classification text default 'production', description text, idempotency_key text);
create table public.ledger_account_map (id uuid default gen_random_uuid(), ledger_scope text, category text, wallet_bucket text,
  account_code text, debit_when text, notes text, created_at timestamptz default now(), updated_at timestamptz default now());
create table public.ledger_account_catalog (code text primary key, label text, section text, nature text, sort_order int, created_at timestamptz default now());
create table public.merchandise_recovery_plans (id uuid, item_name text);
create function public.agent_product_category(p text) returns text language sql immutable as $$ select 'other'::text $$;
create function public.ledger_category_allowlist_base() returns text[] language sql immutable as $$ select array['share_capital','staff_loan_disbursement','staff_loan_repayment'] $$;

insert into public.ledger_account_catalog (code, label, section, nature, sort_order) values
 ('A1','Cash','current_asset','asset',1), ('A2','Float','current_asset','asset',2), ('A9','Suspense','current_asset','asset',9),
 ('A23','Receivable from Pius','current_asset','asset',123), ('L1','Wallet custody','current_liability','liability',31),
 ('E1','Share capital','equity','equity',41), ('R1','Revenue','revenue','revenue',51);
insert into public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when) values
 ('platform','share_capital',null,'E1','cash_out'), ('platform','pool_capital_received',null,'E1','cash_out');

-- staff loans
create table public.staff_loans (id uuid primary key, user_id uuid, principal numeric, monthly_rate numeric, months int,
  outstanding_principal numeric, accrued_interest numeric, interest_charged_total numeric, total_repaid numeric default 0,
  status text, started_on date, due_on date, completed_at timestamptz, updated_at timestamptz);
create table public.staff_loan_instalments (id uuid primary key default gen_random_uuid(), loan_id uuid, seq int,
  amount_due numeric, amount_paid numeric default 0, due_on date, status text);
create table public.staff_loan_repayments (loan_id uuid, user_id uuid, amount numeric, interest_component numeric,
  principal_component numeric, source text);
create table public._balance (user_id uuid primary key, available numeric);
create function public.get_user_available_balance(p uuid) returns numeric language sql stable as $$ select available from public._balance where user_id = p $$;

-- stand-in for create_ledger_transaction: inserts legs, raw cash_in must equal cash_out
create function public.create_ledger_transaction(entries jsonb, idempotency_key text default null, skip_balance_check boolean default false)
returns uuid language plpgsql as $$
declare g uuid := gen_random_uuid(); e jsonb; v_in numeric := 0; v_out numeric := 0;
begin
  for e in select * from jsonb_array_elements(entries) loop
    if (e->>'amount')::numeric <= 0 then raise exception 'non-positive leg'; end if;
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

-- stand-in Balance Sheet carrying the two comparison lines the memo migration replaces
create function public.get_statement_of_financial_position(p_as_at timestamptz) returns jsonb language sql stable as $$
  select jsonb_build_object('assets', jsonb_build_object('current','[]'::jsonb), 'liabilities', jsonb_build_object('current','[]'::jsonb),
    'balance_check', jsonb_build_object('difference', 0),
    'reconciliation', jsonb_build_object('memo_sub_ledgers', jsonb_build_array(
       jsonb_build_object('label','Rent plans outstanding (rent_requests)','value', 1),
       jsonb_build_object('label','Merchandise sales outstanding','value', 2060711055.96),
       jsonb_build_object('label','Promissory notes uncollected','value', 4582982106)))) $$;
create table public.wallets (withdrawable_balance numeric, locked_balance numeric, float_balance numeric, advance_balance numeric);
create table public.rent_requests (status text, total_repayment numeric, amount_repaid numeric, created_at timestamptz);
create table public.agent_advances (status text, outstanding_balance numeric, arrears_balance numeric, created_at timestamptz);
create table public.investor_portfolios (status text, investment_amount numeric, created_at timestamptz);
create table public.promissory_notes (status text, amount numeric, total_collected numeric, created_at timestamptz);
create table public.merchandise_sales (order_status text, amount_outstanding numeric, created_at timestamptz);
`;

// The seven production groups (amounts, shapes, buckets as posted) plus the Pius precedent.
const SHARE = [[1, 100000], [2, 100000], [3, 50000], [4, 1027500], [5, 1027500], [6, 1027500]] as const;
const LEGS = `
insert into public.general_ledger (transaction_group_id, transaction_date, ledger_scope, category, direction, amount, wallet_bucket, source_table) values
${SHARE.map(([n, a]) => `('${gid(n)}','2026-11-04 10:00+03','platform','share_capital','cash_in',${a},null,'angel_pool_investments'),
('${gid(n)}','2026-11-04 10:00+03','wallet','share_capital','cash_out',${a},'float','angel_pool_investments')`).join(',\n')},
('${PIUS_GID}','2026-09-25 14:22+03','platform','share_capital','cash_in',20000,null,'angel_pool_investments'),
('${PIUS_GID}','2026-09-25 14:22+03','wallet','share_capital','cash_out',20000,'float','angel_pool_investments'),
('${gid(7)}','2026-10-19 00:00+03','platform','staff_loan_disbursement','cash_out',120000,null,'staff_requisitions'),
('${gid(7)}','2026-10-19 00:00+03','wallet','staff_loan_disbursement','cash_in',120000,'withdrawable','staff_requisitions');
`;

let db: PGlite;
const q = async <T = any>(sql: string) => (await db.query<T>(sql)).rows;
const residual = async () => Number((await q<{ r: string }>(`select coalesce(round(sum(dr - cr)),0) r from public.sofp_ledger_legs(now()) where not is_legacy_counterpart`))[0].r);
const acct = async (code: string) => Number((await q<{ v: string }>(`select coalesce(round(sum(dr - cr)),0) v from public.sofp_ledger_legs(now()) where account_code = '${code}'`))[0].v);
const groupResiduals = async () => q<{ gid: string; r: string }>(
  `select transaction_group_id::text gid, round(sum(dr - cr)) r from public.sofp_ledger_legs(now()) where not is_legacy_counterpart group by 1 having abs(sum(dr - cr)) > 0.5`);

describe('Angel Pool float-paid shares and staff loans: permanent rules', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`set timezone = 'UTC'`);
    await db.exec(`set plpgsql.variable_conflict = 'use_column'`); // see NOTE above
    await db.exec(SCHEMA);
    await db.exec(RESOLVER);
    await db.exec(ENGINE);
    await db.exec(ALLOW_LIVE);
    await db.exec(RECOVER_LIVE);
    await db.exec(LEGS);
  });

  it('reproduces production: the seven groups leave the books out by -6,905,000', async () => {
    expect(await residual()).toBe(-6905000);
    const g = await groupResiduals();
    expect(g.length).toBe(7);               // 6 share groups + 1 staff loan; Pius balances via its A23 override
    expect(await acct('A23')).toBe(20000);  // the 1 Oct precedent
    expect(await acct('A9')).toBe(-120000); // staff loan company leg in suspense
  });

  it('the new rules balance every group without posting anything', async () => {
    const before = await q<{ n: number }>(`select count(*)::int n from public.general_ledger`);
    await db.exec(RULES);
    const after = await q<{ n: number }>(`select count(*)::int n from public.general_ledger`);
    expect(after[0].n).toBe(before[0].n);   // no ledger rows added or changed
    expect(await residual()).toBe(0);
    expect(await groupResiduals()).toEqual([]);
    expect(await acct('A26')).toBe(3352500); // 3,332,500 + Pius 20,000: owed by the shareholders
    expect(await acct('A23')).toBe(0);
    expect(await acct('A27')).toBe(120000);  // staff loan receivable
    expect(await acct('A9')).toBe(0);        // suspense cleared
    expect(await acct('A2')).toBe(0);        // company float no longer reduced by share purchases
    expect(await acct('E1')).toBe(-3352500); // share capital unchanged (credit)
  });

  it('a future float-paid share purchase balances automatically', async () => {
    await db.exec(`insert into public.general_ledger (transaction_group_id, transaction_date, ledger_scope, category, direction, amount, wallet_bucket, source_table) values
      ('${gid(8)}', now(), 'platform','share_capital','cash_in', 200000, null, 'angel_pool_investments'),
      ('${gid(8)}', now(), 'wallet','share_capital','cash_out', 200000, 'float', 'angel_pool_investments')`);
    expect(await residual()).toBe(0);
    expect(await acct('A26')).toBe(3552500);
  });

  it('staff loan recovery: same wallet leg, company side split into principal and charge, books balance', async () => {
    const loan = gid(100);
    await db.exec(`insert into public.staff_loans values ('${loan}','${STAFF}',120000,0.28,1,120000,33600,33600,0,'active','2026-10-19', current_date - 1, null, now());
      insert into public.staff_loan_instalments (loan_id, seq, amount_due, due_on, status) values ('${loan}', 1, 153600, current_date - 1, 'due');
      insert into public._balance values ('${STAFF}', 500000);`);
    await db.exec(`select * from public.staff_loan_recover_from_wallet('${STAFF}')`);
    const legs = await q<any>(`select ledger_scope, category, direction, amount::numeric amount from public.general_ledger where source_table = 'staff_loans' order by ledger_scope, category`);
    expect(legs.map((l: any) => [l.ledger_scope, l.category, l.direction, Number(l.amount)])).toEqual([
      ['platform', 'staff_loan_charge_collected', 'cash_in', 33600],
      ['platform', 'staff_loan_repayment', 'cash_in', 120000],
      ['wallet', 'staff_loan_repayment', 'cash_out', 153600],
    ]);
    expect(await residual()).toBe(0);
    expect(await acct('A27')).toBe(0);        // loan fully recovered
    expect(await acct('R4')).toBe(-33600);    // charge recognised as revenue (credit)
  });

  it('partial and charge-only instalments post no zero legs', async () => {
    const loan = gid(101);
    await db.exec(`insert into public.staff_loans values ('${loan}','${STAFF}',120000,0.28,1,120000,33600,33600,0,'active','2026-10-19', current_date - 1, null, now());
      insert into public.staff_loan_instalments (loan_id, seq, amount_due, due_on, status) values ('${loan}', 1, 153600, current_date - 1, 'due');
      update public._balance set available = 20000 where user_id = '${STAFF}';`);
    await db.exec(`select * from public.staff_loan_recover_from_wallet('${STAFF}', null, 'test')`);
    const legs = await q<any>(`select ledger_scope, category, amount::numeric amount from public.general_ledger where source_id = '${loan}' order by ledger_scope, category`);
    expect(legs.map((l: any) => [l.ledger_scope, l.category, Number(l.amount)])).toEqual([
      ['platform', 'staff_loan_charge_collected', 20000],
      ['wallet', 'staff_loan_repayment', 20000],
    ]);
    expect(await residual()).toBe(0);
  });

  it('documents the production defect: recovery errors with the default setting', async () => {
    const db4 = new PGlite();
    await db4.exec(SCHEMA);
    await db4.exec(RECOVER_LIVE);
    const loan = gid(103);
    await db4.exec(`insert into public.staff_loans values ('${loan}','${STAFF}',120000,0.28,1,120000,33600,33600,0,'active','2026-10-19', current_date - 1, null, now());
      insert into public.staff_loan_instalments (loan_id, seq, amount_due, due_on, status) values ('${loan}', 1, 153600, current_date - 1, 'due');
      insert into public._balance values ('${STAFF}', 500000);`);
    await expect(db4.exec(`select * from public.staff_loan_recover_from_wallet('${STAFF}')`)).rejects.toThrow(/loan_id.*ambiguous/);
    await db4.close();
  });

  it('the wallet leg is identical to production behaviour (no money change)', async () => {
    // run the production version of the function on a fresh loan in a separate database and compare wallet legs
    const db2 = new PGlite();
    await db2.exec(`set timezone = 'UTC'`);
    await db2.exec(`set plpgsql.variable_conflict = 'use_column'`); // see NOTE above
    await db2.exec(SCHEMA);
    await db2.exec(RECOVER_LIVE);
    const loan = gid(102);
    await db2.exec(`insert into public.staff_loans values ('${loan}','${STAFF}',120000,0.28,1,120000,33600,33600,0,'active','2026-10-19', current_date - 1, null, now());
      insert into public.staff_loan_instalments (loan_id, seq, amount_due, due_on, status) values ('${loan}', 1, 153600, current_date - 1, 'due');
      insert into public._balance values ('${STAFF}', 500000);`);
    await db2.exec(`select * from public.staff_loan_recover_from_wallet('${STAFF}')`);
    const live = (await db2.query<any>(`select direction, amount::numeric a, category from public.general_ledger where ledger_scope = 'wallet'`)).rows;
    const mine = await q<any>(`select direction, amount::numeric a, category from public.general_ledger where ledger_scope = 'wallet' and source_table = 'staff_loans' and amount = 153600`);
    expect(mine.map((r: any) => [r.direction, Number(r.a), r.category])).toEqual(live.map((r: any) => [r.direction, Number(r.a), r.category]));
    const repay = (await db2.query<any>(`select amount::numeric a from public.staff_loan_repayments`)).rows;
    expect(Number(repay[0].a)).toBe(153600);
    await db2.close();
  });

  it('allowlist keeps every existing category and adds exactly one', async () => {
    const n = await q<{ n: number; has: boolean }>(`select cardinality(public.ledger_category_allowlist()) n, 'staff_loan_charge_collected' = any(public.ledger_category_allowlist()) has`);
    const db3 = new PGlite();
    await db3.exec(SCHEMA); await db3.exec(ALLOW_LIVE);
    const live = (await db3.query<{ n: number }>(`select cardinality(public.ledger_category_allowlist()) n`)).rows[0].n;
    await db3.close();
    expect(n[0].has).toBe(true);
    expect(n[0].n).toBe(live + 1);
  });

  it('Balance Sheet comparison lines: issued merchandise only; promissory notes split', async () => {
    await db.exec(`insert into public.merchandise_sales values ('issued',100,'2026-10-01'),('completed',50,'2026-10-01'),
        ('pending_approval',2025000000,'2026-09-30'),('rejected',10,'2026-10-01');
      insert into public.promissory_notes values ('activated',1000,100,'2026-10-01'),('pending',500,0,'2026-10-01');`);
    await db.exec(MEMO);
    await db.exec(`select set_config('test.uid', '${CFO}', false)`);
    const r = (await q<{ r: any }>(`select public.fin_balance_sheet(now()) r`))[0].r;
    const memo = Object.fromEntries(r.reconciliation.memo_sub_ledgers.map((m: any) => [m.label, Number(m.value)]));
    expect(memo['Merchandise sales outstanding — issued orders only']).toBe(150);
    expect(memo['Merchandise orders not yet issued (not a receivable)']).toBe(2025000000);
    expect(memo['Promissory notes activated, uncollected']).toBe(900);
    expect(memo['Promissory notes not yet activated (commitments only)']).toBe(500);
    expect(memo['Merchandise sales outstanding']).toBeUndefined();
    expect(memo['Promissory notes uncollected']).toBeUndefined();
    expect(memo['Rent plans outstanding (rent_requests)']).toBe(1); // other lines untouched
  });

  it('rollback restores the previous treatment', async () => {
    await db.exec(RULES_RB);
    const map = await q<{ n: number }>(`select count(*)::int n from public.ledger_account_map where account_code in ('A26','A27','R4')`);
    expect(map[0].n).toBe(0);
    expect(await acct('A23')).toBe(20000); // Pius back on its override
  });
});
