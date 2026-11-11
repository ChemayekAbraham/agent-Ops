// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- assertions over untyped rows returned by SQL */
/**
 * CFO Cash Position chart (get_cfo_daily_cash_movement): real money received / paid out per Kampala day.
 *
 * Runs supabase/migrations/20261113040000_cfo_daily_cash_movement.sql verbatim on PGlite over minimal tables with
 * production's column names and the production mappings it relies on. Production was checked read-only on 11 Nov 2026:
 * over 5-11 Nov, received - paid + corrections = -109,025,231 = the change in the Treasury card's cash incl. the pool.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const MIG = read('supabase/migrations/20261113040000_cfo_daily_cash_movement.sql');
const RB = read('supabase/rollbacks/20261113040000_cfo_daily_cash_movement.rollback.sql');

const CFO = '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b';
const AGENT = '00000000-0000-0000-0000-00000000a001';

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create type public.app_role as enum ('cfo', 'ceo', 'coo', 'manager', 'financial_ops', 'super_admin', 'agent');
create table public.user_roles (user_id uuid, role public.app_role);
create function public.has_role(p_user uuid, p_role public.app_role) returns boolean language sql stable as
  $$ select exists (select 1 from public.user_roles where user_id = p_user and role = p_role) $$;
create table public.general_ledger (
  id uuid primary key default gen_random_uuid(), transaction_group_id uuid, transaction_date timestamptz, ledger_scope text,
  category text, direction text, amount numeric, wallet_bucket text, classification text default 'production',
  source_table text, idempotency_key text);
create table public.ledger_account_map (ledger_scope text, category text, wallet_bucket text, account_code text, debit_when text);
create table public.fin_cash_accounts (code text primary key, label text, included boolean, restricted boolean);
create table public.money_in_report_exclusions (transaction_group_id uuid, reason text, correction_item text);
insert into public.user_roles values ('${CFO}', 'cfo'), ('${AGENT}', 'agent');
insert into public.fin_cash_accounts values ('A1', 'Cash and bank', true, false), ('A5', 'Cash collected', true, false),
  ('A21', 'Pool self', true, true), ('A22', 'Pool managed', true, true), ('A99', 'Not cash', false, false);
insert into public.ledger_account_map values
  ('platform', 'verified_bank_cash_recognised', null, 'A1', 'cash_in'),
  ('platform', 'treasury_bank_deposit', null, 'A1', 'cash_in'),
  ('platform', 'cash_receipt_in_transit', null, 'A5', 'cash_in'),
  ('platform', 'landlord_pool_deploy_target', null, 'A22', 'cash_in'),
  ('platform', 'cash_custody_payable', null, 'L1', 'cash_in'),
  ('platform', 'agent_float_cash_offset', null, 'A2', 'cash_in'),
  ('platform', 'agent_float_deposit', null, 'A8', 'cash_in'),
  ('wallet', 'agent_float_deposit', null, 'A2', 'cash_in'),
  ('platform', 'withdrawal_payout', null, 'A1', 'cash_in'),
  ('wallet', 'withdrawal', null, 'L1', 'cash_out');
`;

let db: PGlite;
const q = async <T = any>(sql: string, p: any[] = []) => (await db.query<T>(sql, p)).rows;
const asCfo = async <T = any>(sql: string) => {
  await db.exec(`set test.uid = '${CFO}'`);
  try { return await q<T>(sql); } finally { await db.exec(`reset test.uid`); }
};
let n = 0;
/** Post one group. legs: [scope, category, direction, amount, bucket?]. Day is days before today (Kampala), at noon. */
const post = async (daysAgo: number, legs: [string, string, string, number, string?][], opts: { key?: string; cls?: string; exclude?: boolean } = {}) => {
  n += 1;
  const gid = `00000000-0000-0000-0002-${String(n).padStart(12, '0')}`;
  for (const [scope, cat, dir, amt, bucket] of legs) {
    await q(`insert into public.general_ledger (transaction_group_id, transaction_date, ledger_scope, category, direction, amount, wallet_bucket, classification, idempotency_key)
      values ($1, (((now() at time zone 'Africa/Kampala')::date - $2::int)::timestamp + interval '12 hours') at time zone 'Africa/Kampala', $3, $4, $5, $6, $7, $8, $9)`,
      [gid, daysAgo, scope, cat, dir, amt, bucket ?? null, opts.cls ?? 'production', opts.key ? `${opts.key}:${n}` : null]);
  }
  if (opts.exclude) await q(`insert into public.money_in_report_exclusions values ($1, 'test', 'T')`, [gid]);
  return gid;
};
const day = async (daysAgo: number, days = 7) => {
  const rows = await asCfo(`select day::text, inflow, outflow, corrections from public.get_cfo_daily_cash_movement(${days})`);
  const want = (await q<{ d: string }>(`select ((now() at time zone 'Africa/Kampala')::date - ${daysAgo})::text d`))[0].d;
  const r = rows.find((x: any) => x.day === want);
  return [Number(r.inflow), Number(r.outflow), Number(r.corrections)];
};

describe('get_cfo_daily_cash_movement', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`set timezone = 'UTC'`);
    await db.exec(SCHEMA);
    await db.exec(MIG);
  });

  it('a Supporter\'s mobile-money deposit counts once as money received (not its wallet and offset legs)', async () => {
    await post(1, [['wallet', 'agent_float_deposit', 'cash_in', 300000, 'float'], ['platform', 'agent_float_cash_offset', 'cash_out', 300000],
      ['platform', 'verified_bank_cash_recognised', 'cash_in', 300000], ['platform', 'cash_custody_payable', 'cash_out', 300000]]);
    expect(await day(1)).toEqual([300000, 0, 0]);
  });

  it('an agent float deposit (DR A2 / CR A8) is not cash and does not appear', async () => {
    await post(2, [['wallet', 'agent_float_deposit', 'cash_in', 150000, 'float'], ['platform', 'agent_float_deposit', 'cash_out', 150000]]);
    expect(await day(2)).toEqual([0, 0, 0]);
  });

  it('a withdrawal paid from the bank is money paid out', async () => {
    await post(2, [['wallet', 'withdrawal', 'cash_out', 80000, 'withdrawable'], ['platform', 'withdrawal_payout', 'cash_out', 80000]]);
    expect(await day(2)).toEqual([0, 80000, 0]);
  });

  it('moves between cash accounts cancel: banking custody cash and earmarking to the landlord pool', async () => {
    await post(3, [['platform', 'treasury_bank_deposit', 'cash_in', 500000], ['platform', 'cash_receipt_in_transit', 'cash_out', 500000]]);
    await post(3, [['platform', 'landlord_pool_deploy_target', 'cash_in', 200000], ['platform', 'treasury_bank_deposit', 'cash_out', 200000]]);
    expect(await day(3)).toEqual([0, 0, 0]);
  });

  it('accounting corrections are returned separately, never as money received or paid', async () => {
    // excluded from Money In (as every acct_corr batch is), an acct_corr_ key, and a reclassification key
    await post(4, [['platform', 'verified_bank_cash_recognised', 'cash_in', 606000], ['platform', 'cash_custody_payable', 'cash_out', 606000]], { exclude: true });
    await post(4, [['platform', 'cash_custody_payable', 'cash_in', 905000], ['platform', 'cash_receipt_in_transit', 'cash_out', 905000]], { key: 'acct_corr_202611_cash1005' });
    await post(4, [['platform', 'treasury_bank_deposit', 'cash_in', 7000], ['platform', 'cash_custody_payable', 'cash_out', 7000]], { key: 'merch_recv_derecog' });
    expect(await day(4)).toEqual([0, 0, 606000 - 905000 + 7000]);
  });

  it('a key that merely contains "acct_corr" elsewhere is not a correction', async () => {
    await post(5, [['platform', 'treasury_bank_deposit', 'cash_in', 1000], ['platform', 'cash_custody_payable', 'cash_out', 1000]], { key: 'x_acct_corr_y' });
    expect(await day(5)).toEqual([1000, 0, 0]);
  });

  it('test and other non-production entries are ignored; merchant float reconciliations count', async () => {
    await post(6, [['platform', 'treasury_bank_deposit', 'cash_in', 9999], ['platform', 'cash_custody_payable', 'cash_out', 9999]], { cls: 'test_dev' });
    n += 1;
    await q(`insert into public.general_ledger (transaction_group_id, transaction_date, ledger_scope, category, direction, amount, classification, source_table)
      values (gen_random_uuid(), (((now() at time zone 'Africa/Kampala')::date - 6)::timestamp + interval '12 hours') at time zone 'Africa/Kampala',
              'platform', 'treasury_bank_deposit', 'cash_out', 400, 'admin_correction', 'merchant_float_reconciliations')`);
    expect(await day(6)).toEqual([0, 400, 0]);
  });

  it('returns every day of the window, oldest first, and days are Kampala calendar days', async () => {
    const rows = await asCfo(`select day::text from public.get_cfo_daily_cash_movement(7)`);
    expect(rows.length).toBe(7);
    expect(rows.map((r: any) => r.day)).toEqual([...rows.map((r: any) => r.day)].sort());
    // 23:30 Kampala on day -1 belongs to day -1 even though it is 20:30 UTC
    await q(`insert into public.general_ledger (transaction_group_id, transaction_date, ledger_scope, category, direction, amount)
      values (gen_random_uuid(), (((now() at time zone 'Africa/Kampala')::date - 1)::timestamp + interval '23 hours 30 minutes') at time zone 'Africa/Kampala',
              'platform', 'treasury_bank_deposit', 'cash_in', 50)`);
    expect(await day(1)).toEqual([300050, 0, 0]);
  });

  it('received - paid + corrections equals the change in cash over the window', async () => {
    const rows = await asCfo(`select sum(inflow - outflow + corrections) s from public.get_cfo_daily_cash_movement(7)`);
    const cash = await q(`select sum(case when gl.direction = m.debit_when then gl.amount else -gl.amount end) s
      from public.general_ledger gl join public.ledger_account_map m on m.ledger_scope = gl.ledger_scope and m.category = gl.category
      where m.account_code in ('A1','A5','A21','A22') and (gl.classification = 'production' or gl.source_table = 'merchant_float_reconciliations')`);
    expect(Number(rows[0].s)).toBe(Number(cash[0].s));
  });

  it('only finance roles may read it; anon cannot execute it', async () => {
    await db.exec(`set test.uid = '${AGENT}'`);
    await expect(q(`select * from public.get_cfo_daily_cash_movement(7)`)).rejects.toThrow(/Not authorized/);
    await db.exec(`reset test.uid`);
    await expect(q(`select * from public.get_cfo_daily_cash_movement(7)`)).rejects.toThrow(/Not authorized/);
    const g = await q(`select has_function_privilege('anon', 'public.get_cfo_daily_cash_movement(integer)', 'execute') a,
                              has_function_privilege('authenticated', 'public.get_cfo_daily_cash_movement(integer)', 'execute') b`);
    expect([g[0].a, g[0].b]).toEqual([false, true]);
  });

  it('the window is clamped to 1-90 days', async () => {
    expect((await asCfo(`select count(*)::int c from public.get_cfo_daily_cash_movement(500)`))[0].c).toBe(90);
    expect((await asCfo(`select count(*)::int c from public.get_cfo_daily_cash_movement(0)`))[0].c).toBe(1);
  });

  it('rollback drops the function', async () => {
    await db.exec(RB);
    expect((await q(`select count(*)::int c from pg_proc where proname = 'get_cfo_daily_cash_movement'`))[0].c).toBe(0);
  });
});
