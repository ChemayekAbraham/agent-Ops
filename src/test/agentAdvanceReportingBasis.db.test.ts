// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- assertions over untyped rows returned by SQL */
/**
 * Agent advances reporting basis (supabase/migrations/20261115150000_agent_advance_reporting_basis.sql).
 *
 * Runs the migration's fin_balance_sheet and the rollback's (= production 11 Nov 2026) verbatim, and the two agent
 * blocks of v_receivables_lines from each, against stand-in data shaped like production:
 *   - an advance's outstanding_balance includes its access + registration fees and its arrears;
 *   - access_fee - access_fee_collected is the unpaid fee inside outstanding.
 * Reporting only: the test also proves no table row changes.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 600_000 });

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const MIG = read('supabase/migrations/20261115150000_agent_advance_reporting_basis.sql');
const RB = read('supabase/rollbacks/20261115150000_agent_advance_reporting_basis.rollback.sql');

/** The CREATE FUNCTION public.fin_balance_sheet statement from a file. */
const fbsOf = (sql: string) => {
  const s = sql.indexOf('CREATE OR REPLACE FUNCTION public.fin_balance_sheet');
  const e = sql.indexOf('$function$;', s) + '$function$;'.length;
  return sql.slice(s, e);
};
/** The two agent-advance blocks of v_receivables_lines from a file, as one SELECT. */
const agentBlocksOf = (sql: string) => {
  const s = sql.indexOf('CREATE OR REPLACE VIEW public.v_receivables_lines AS') + 'CREATE OR REPLACE VIEW public.v_receivables_lines AS'.length;
  const body = sql.slice(s, sql.indexOf(';\n\nCREATE OR REPLACE FUNCTION public.fin_run_daily_tieout'));
  const blocks = body.split(/\n\s*UNION ALL\n/).filter(b => /'agent_advance'::text AS product_key|'agent_advance_access_fee'::text AS product_key/.test(b));
  expect(blocks).toHaveLength(2);
  return blocks.join('\nUNION ALL\n');
};

// 3 advances shaped like production (all amounts UGX)
//   fresh:   principal 1,700,000 + fee 255,000 + reg 20,000 -> outstanding 1,975,000, nothing paid
//   overdue: principal 1,000,000 + fee 300,000 + reg 20,000; 600,000 repaid -> outstanding 720,000 incl. arrears 500,000;
//            fee collected pro rata 600/1,320 of 300,000 = 136,364
//   paid-fee: outstanding 100,000, fee fully collected
const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create function public._fin_can_view() returns boolean language sql stable as $$ select true $$;
create table public.profiles (id uuid primary key, full_name text);
create table public.agent_advances (id uuid primary key, agent_id uuid, status text, principal numeric, access_fee numeric,
  registration_fee numeric, access_fee_collected numeric, access_fee_status text, outstanding_balance numeric, arrears_balance numeric,
  daily_installment numeric, installment_amount numeric, expires_at timestamptz, created_at timestamptz default '2026-10-01');
insert into public.agent_advances (id, status, principal, access_fee, registration_fee, access_fee_collected, outstanding_balance, arrears_balance) values
 ('00000000-0000-0000-0000-00000000aa01','active', 1700000, 255000, 20000, 0,      1975000, 0),
 ('00000000-0000-0000-0000-00000000aa02','overdue',1000000, 300000, 20000, 136364, 720000,  500000),
 ('00000000-0000-0000-0000-00000000aa03','overdue', 400000,  60000, 10000, 60000,  100000,  100000),
 ('00000000-0000-0000-0000-00000000aa04','completed',500000, 75000, 10000, 75000,  0,       0);
create table public.wallets (withdrawable_balance numeric, locked_balance numeric, float_balance numeric, advance_balance numeric);
create table public.rent_requests (status text, total_repayment numeric, amount_repaid numeric, created_at timestamptz);
create table public.investor_portfolios (status text, investment_amount numeric, created_at timestamptz);
create table public.promissory_notes (id uuid, status text, amount numeric, total_collected numeric, created_at timestamptz);
create view public.v_partner_note_settlement as select null::uuid note_id, 0::numeric outstanding where false;
create table public.merchandise_sales (order_status text, amount_outstanding numeric, created_at timestamptz);
-- ledger: A10 2,500,000 + A11 300,000 + A20 50,000 = 2,850,000 (operational outstanding 2,795,000 -> exception 55,000)
create function public.get_statement_of_financial_position(p timestamptz) returns jsonb language sql stable as $$
  select jsonb_build_object('assets', jsonb_build_object('current', jsonb_build_array(
    jsonb_build_object('label','Agent Advances Receivable','value',2500000,'source','general_ledger trial balance — account A10'),
    jsonb_build_object('label','Agent Advance Access Fees Receivable','value',300000,'source','general_ledger trial balance — account A11'),
    jsonb_build_object('label','Agent Advance Registration Fees Receivable','value',50000,'source','general_ledger trial balance — account A20')),
    'non_current','[]'::jsonb),
  'liabilities', jsonb_build_object('current','[]'::jsonb,'non_current','[]'::jsonb),
  'reconciliation', jsonb_build_object('memo_sub_ledgers','[]'::jsonb)) $$;
`;

let db: PGlite;
const q = async <T = any>(sql: string) => (await db.query<T>(sql)).rows;
const snapshot = async () => JSON.stringify(await q(`select * from public.agent_advances order by id`));
const tie = async () => (await q(`select t from jsonb_array_elements(public.fin_balance_sheet(now())->'subledger_ties') t where t->>'key' = 'agent_advances'`))[0].t;

describe('agent advances reporting basis', () => {
  let before: any; let after: any; let rowsBefore: string;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(SCHEMA);
    rowsBefore = await snapshot();
    await db.exec(fbsOf(RB));
    before = await tie();
    await db.exec(fbsOf(MIG));
    after = await tie();
  });

  it('before (production): arrears were added on top of outstanding', () => {
    // 1,975,000 + 720,000 + 100,000 = 2,795,000 outstanding; + 600,000 arrears = 3,395,000
    expect(Number(before.operational)).toBe(3395000);
    expect(Number(before.difference)).toBe(2850000 - 3395000);
  });

  it('after: ledger A10+A11+A20 compared with outstanding only; the real exception stays visible', () => {
    expect(Number(after.ledger)).toBe(2850000);
    expect(Number(after.operational)).toBe(2795000);
    expect(Number(after.difference)).toBe(55000);
    expect(after.basis).toBe('outstanding_only_v2');
    expect(after.label).toMatch(/fees and arrears included/);
  });

  it('receivables lines: production counted the unpaid access fee twice; corrected lines add up to outstanding exactly', async () => {
    const sum = async (sql: string) => {
      const r = await q(`select product_key, round(sum(outstanding_amount)) s from (${sql}) x group by 1 order by 1`);
      return Object.fromEntries(r.map((x: any) => [x.product_key, Number(x.s)]));
    };
    const old = await sum(agentBlocksOf(RB));
    const neu = await sum(agentBlocksOf(MIG));
    // unpaid fees: 255,000 + (300,000-136,364) + 0 = 418,636
    expect(old).toEqual({ agent_advance: 2795000, agent_advance_access_fee: 418636 });
    expect(old.agent_advance + old.agent_advance_access_fee).toBe(2795000 + 418636); // double count
    expect(neu).toEqual({ agent_advance: 2795000 - 418636, agent_advance_access_fee: 418636 });
    expect(neu.agent_advance + neu.agent_advance_access_fee).toBe(2795000); // = outstanding
  });

  it('a fee that exceeds what is still owed is capped, never negative or hidden', async () => {
    await db.exec(`insert into public.agent_advances (id, status, principal, access_fee, registration_fee, access_fee_collected, outstanding_balance, arrears_balance)
      values ('00000000-0000-0000-0000-00000000aa05','overdue', 100000, 90000, 10000, 0, 50000, 50000)`);
    const r = await q(`select product_key, outstanding_amount::numeric a from (${agentBlocksOf(MIG)}) x where item_id = '00000000-0000-0000-0000-00000000aa05' order by 1`);
    expect(r.map((x: any) => [x.product_key, Number(x.a)])).toEqual([['agent_advance_access_fee', 50000]]);
    await db.exec(`delete from public.agent_advances where id = '00000000-0000-0000-0000-00000000aa05'`);
  });

  it('changes no record: advances are identical before and after', async () => {
    expect(await snapshot()).toBe(rowsBefore);
  });
});

describe('nightly tie-out records why a tie moved', () => {
  it('a basis change reads "comparison basis changed"; earlier nightly rows are untouched', () => {
    const fn = MIG.slice(MIG.indexOf('CREATE OR REPLACE FUNCTION public.fin_run_daily_tieout'));
    expect(fn).toMatch(/'basis_previous', p->>'basis', 'basis_current', t->>'basis'/);
    expect(fn).toMatch(/'comparison basis changed'/);
    expect(fn).not.toMatch(/UPDATE public\.fin_daily_tieout/i); // only the day's own row is written (upsert on run_date)
    expect(MIG).not.toMatch(/\b(INSERT INTO public\.general_ledger|create_ledger_transaction|UPDATE public\.agent_advances|ledger_account_map)\b/i);
  });
});
