// @vitest-environment node
/**
 * Special Advances readiness Phase C: impairment, write-off and recovery
 * (supabase/migrations/20261102220000_special_advances_impairment_writeoff.sql) on PGlite, on top of Phases 1-4, A and B.
 *
 * CFO decisions (2026-11-02): D7 minimum rates by days past due (0/10/25/50/100%), D8 A25 allowance + X4 expense,
 * provision reviews approved by a second CFO, D9 second-CFO write-off of the whole balance via A25 / X4, D10 recovery
 * DR A1 / CR X4. Same real code and stand-ins as specialAdvancePayout.test.ts, plus X4 and a second enabled CFO.
 */
import { readFileSync } from 'node:fs';
import { randomUUID as uuid } from 'node:crypto';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const MIG = (f: string) => read(`supabase/migrations/${f}`);
const ENGINE = MIG('20261028150000_special_advances_calc_engine.sql');
const STORAGE = MIG('20261028151000_special_advances_storage.sql');
const FUNCTIONS = MIG('20261028152000_special_advances_functions.sql');
const PAYOUT = MIG('20261028153000_special_advances_payout_repayment.sql');
const PAYOUT_RB = read('supabase/rollbacks/20261028153000_special_advances_payout_repayment.rollback.sql');
const HELPERS = read('scripts/fixtures/asset-register-helpers.sql');
const POLICIES = MIG('20261028153100_special_advances_proof_storage_policies.sql');
const POLICIES_RB = read('supabase/rollbacks/20261028153100_special_advances_proof_storage_policies.rollback.sql');
const POSITION = MIG('20261102200000_special_advances_receivable_after_payout.sql');
const POSITION_RB = read('supabase/rollbacks/20261102200000_special_advances_receivable_after_payout.rollback.sql');
// production's allowlist (wrapper + base list), verbatim; the migration pins this exact definition
const PROD_ALLOWLIST = read('scripts/fixtures/ledger-allowlist-prod-2026-10-27.sql');
const PROD_ALLOWLIST_MD5 = '736744d355fe913acfcc0593204613a6';
const PROD_ALLOWLIST_CONFIG = ['search_path=public, extensions, pg_temp'];
const SA_CATEGORIES = ['special_advance_credit', 'special_advance_receivable', 'special_advance_payout_cash',
  'special_advance_fee_revenue', 'special_advance_repayment_received', 'special_advance_repayment'];

/** The CREATE OR REPLACE FUNCTION block for `signature` (e.g. "public.create_ledger_transaction(entries"), verbatim. */
function extractFn(file: string, signature: string): string {
  const src = MIG(file);
  const start = src.indexOf(`CREATE OR REPLACE FUNCTION ${signature}`);
  if (start < 0) throw new Error(`${signature} not found in ${file}`);
  const tail = src.slice(start);
  const end = tail.search(/\n(\$function\$|\$\$);\n/);
  return tail.slice(0, end) + '\n' + (tail.slice(end + 1).startsWith('$function$') ? '$function$;' : '$$;');
}
const REAL = [
  extractFn('20260817070831_d61c0e97-c1bd-476c-8266-748f95b9204b.sql', 'public.wallet_route_for_category(p_category'),
  extractFn('20260817070831_d61c0e97-c1bd-476c-8266-748f95b9204b.sql', 'public.assert_routing_compatible('),
  extractFn('20260515113611_a78dae5e-607a-4e4a-ad99-0760db81e681.sql', 'public.wallet_route_for_category(p_user_id'),
  PROD_ALLOWLIST,
  extractFn('20260509085227_0a4f550d-0c03-48b0-b8c8-2c181e365198.sql', 'public.validate_ledger_category(p_category'),
  extractFn('20260914180000_adversarial_regression_fixes.sql', 'public.create_ledger_transaction(entries'),
];
const TRIGGER_VALIDATOR_ALLOWLIST = extractFn('20260509085227_0a4f550d-0c03-48b0-b8c8-2c181e365198.sql', 'public.validate_ledger_category()');
const TRIGGER_VALIDATOR_INLINE = extractFn('20260515170000_fix_unrouted_categories.sql', 'public.validate_ledger_category()');

const STANDINS = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt() ->> 'sub')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
create table public.user_roles (id uuid primary key default gen_random_uuid(), user_id uuid not null, role text not null, enabled boolean not null default true);
create table public.profiles (id uuid primary key, full_name text, deleted_at timestamptz);
create table public.staff_mfa_config (id boolean primary key, mode text not null);
insert into public.staff_mfa_config values (true, 'shadow');
create table public.agent_advances (id uuid primary key default gen_random_uuid(), agent_id uuid not null, status text not null, outstanding_balance numeric not null default 0);
create table public.business_advances (id uuid primary key default gen_random_uuid(), tenant_id uuid not null, status text not null, outstanding_balance numeric not null default 0);

-- ledger stand-ins (columns as used by create_ledger_transaction)
create type public.solvency_bypass_reason as enum ('cfo_override');
create table public.general_ledger (
  id uuid primary key default gen_random_uuid(), user_id uuid, wallet_id uuid, ledger_scope text, direction text, category text,
  amount numeric, currency text, description text, source_table text, source_id uuid, transaction_group_id uuid,
  idempotency_key text, transaction_date timestamptz, linked_party text, reference_id text, account text, classification text,
  recipient_type text, wallet_bucket text, routing_source text, solvency_bypass_reason public.solvency_bypass_reason,
  ip_address text, user_agent text, created_at timestamptz not null default now());
create table public.wallets (id uuid primary key default gen_random_uuid(), user_id uuid unique, withdrawable_balance numeric default 0);
-- storage stand-ins: the proof bucket and its files (Supabase's storage schema, the columns the migration reads)
create schema storage;
create table storage.buckets (id text primary key, name text not null, public boolean not null default false,
  file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, created_at timestamptz default now());
alter table storage.objects enable row level security;
create table public.wallet_fresh_start_anchors (user_id uuid primary key, anchor_at timestamptz);
create table public.wallet_routing_violations (id bigserial primary key, user_id uuid, category text, direction text, amount numeric,
  recipient_type text, reason text, context jsonb);
create table public.treasury_controls (control_key text primary key, enabled boolean);
insert into public.treasury_controls values ('strict_mode', true);
-- stand-in for apply_wallet_movement: record the bucket the REAL router picks
create table public.wallet_movements (user_id uuid, category text, bucket text, signed_amount numeric);
create function public.tr_route_standin() returns trigger language plpgsql as $$
DECLARE r record;
BEGIN
  IF NEW.ledger_scope = 'wallet' AND NEW.user_id IS NOT NULL THEN
    SELECT * INTO r FROM public.wallet_route_for_category(NEW.user_id, NEW.category, NEW.direction);
    INSERT INTO public.wallet_movements VALUES (NEW.user_id, NEW.category, r.bucket, r.sign * NEW.amount);
  END IF;
  RETURN NEW;
END $$;
create trigger general_ledger_route_buckets after insert on public.general_ledger for each row execute function public.tr_route_standin();
create table public.ledger_account_catalog (code text primary key, label text not null,
  section text not null check (section in ('current_asset','non_current_asset','current_liability','non_current_liability','equity','revenue','expense')),
  nature text not null check (nature in ('asset','liability','equity','revenue','expense')), sort_order int not null default 100,
  created_at timestamptz not null default now());
insert into public.ledger_account_catalog (code, label, section, nature, sort_order) values
  ('A1','Cash and Bank Balances','current_asset','asset',10), ('A10','Agent Advances Receivable','current_asset','asset',100),
  ('A19','Business Advance Receivables','current_asset','asset',190), ('L1','Wallet Custody Payable','current_liability','liability',300),
  ('R1','Platform Revenue','revenue','revenue',500),
  -- production's A20-A23 (read-only, 2026-10-27): already taken, so Special Advances must use A24 and leave these alone
  ('A20','Agent Advance Registration Fees Receivable','current_asset','asset',49),
  ('A21','Landlord Float Pool — Self-Support','current_asset','asset',11),
  ('A22','Landlord Float Pool — Company-Managed','current_asset','asset',12),
  ('A23','Receivable from Pius — Angel Pool share','current_asset','asset',123);
create table public.ledger_account_map (id uuid primary key default gen_random_uuid(), ledger_scope text not null, category text not null,
  wallet_bucket text, account_code text not null references public.ledger_account_catalog(code),
  debit_when text not null default 'cash_in' check (debit_when in ('cash_in','cash_out')), notes text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create unique index ledger_account_map_key on public.ledger_account_map (ledger_scope, category, coalesce(wallet_bucket,'*'));
insert into public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when) values
  ('platform','wallet_withdrawal',null,'A1','cash_out'), ('platform','access_fee_collected',null,'R1','cash_out'),
  -- production's 16 mappings to A20-A23 (read-only, 2026-10-27)
  ('platform','agent_advance_registration_fee_charged',null,'A20','cash_out'),
  ('platform','agent_advance_registration_fee_collected',null,'A20','cash_out'),
  ('platform','agent_advance_registration_fee_collected_external',null,'A20','cash_in'),
  ('platform','agent_advance_registration_fee_written_off',null,'A20','cash_out'),
  ('platform','landlord_pool_compound_self_support',null,'A21','cash_in'), ('platform','landlord_pool_deploy_self_support',null,'A21','cash_in'),
  ('platform','landlord_pool_release_self_support',null,'A21','cash_in'), ('platform','landlord_pool_reserve_self_support',null,'A21','cash_in'),
  ('platform','landlord_pool_return_self_support',null,'A21','cash_in'), ('platform','landlord_pool_topup_self_support',null,'A21','cash_in'),
  ('platform','landlord_pool_compound_company_managed',null,'A22','cash_in'), ('platform','landlord_pool_deploy_company_managed',null,'A22','cash_in'),
  ('platform','landlord_pool_release_company_managed',null,'A22','cash_in'), ('platform','landlord_pool_reserve_company_managed',null,'A22','cash_in'),
  ('platform','landlord_pool_return_company_managed',null,'A22','cash_in'), ('platform','landlord_pool_topup_company_managed',null,'A22','cash_in');
`;
const EXISTING_ACCOUNTS_SQL = `select code, label, section, nature, sort_order from public.ledger_account_catalog where code in ('A20','A21','A22','A23') order by code`;
const EXISTING_MAPPINGS_SQL = `select ledger_scope, category, wallet_bucket, account_code, debit_when, notes from public.ledger_account_map
  where account_code in ('A20','A21','A22','A23') order by account_code, category`;
const allowlistMeta = async () => (await q<{ md5: string; config: string[] | null; vol: string; lang: string; acl: string | null }>(
  `select md5(replace(p.prosrc, chr(13), '')) md5, p.proconfig config, p.provolatile vol, l.lanname lang, p.proacl::text acl
     from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = 'public.ledger_category_allowlist()'::regprocedure`))[0];

let db: PGlite;
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
type Err = { code?: string; message: string; detail?: string };
const cfo = uuid(), coo = uuid(), superAdmin = uuid(), tenant = uuid(), tenant2 = uuid(), agentUser = uuid();
const users = [cfo, coo, superAdmin, tenant, tenant2, agentUser];

async function call<T = Record<string, unknown>>(user: string, sql: string, params: unknown[] = [], aal = 'aal2'): Promise<{ out?: T; err?: Err }> {
  try {
    let out: T | undefined;
    await db.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user, role: 'authenticated', aal })]);
      await tx.exec(`set local role authenticated`);
      out = (await tx.query<{ r: T }>(sql, params)).rows[0]?.r;
    });
    return { out };
  } catch (e) {
    return { err: e as Err };
  }
}
type Adv = { id: string; reference: string; status: string; updated_at: string; payout_date: string | null; payout_method: string | null;
  payout_ledger_group_id: string | null; payout_proof_path?: string | null; schedule: Array<{ number: number; due_date: string | null; amount: number }>;
  events: Array<{ event_type: string }>; replayed?: boolean;
  position: { outstanding: number; total_paid: number; overdue_amount: number; overdue_instalments: number;
    instalments: Array<{ number: number; paid: number; outstanding: number; status: string }> } };
const TERMS = { principal: 500_000, rate_percent: 28, rate_basis: 'monthly', term_days: 90, frequency: 'monthly' };
const today = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
const addDays = (ymd: string, d: number) => new Date(Date.parse(ymd) + d * 86_400_000).toISOString().slice(0, 10);

async function approved(borrower: Record<string, unknown>, terms = TERMS) {
  const s = (await call<{ schedule: { total_repayable: number } }>(cfo, `select public.special_advance_quote($1::jsonb) r`, [JSON.stringify({ terms })])).out!;
  const c = await call<Adv>(cfo, `select public.special_advance_create($1::jsonb) r`, [JSON.stringify({
    borrower, terms, purpose: 'Working capital for verified supplier stock', expected_total_repayable: s.schedule.total_repayable, idempotency_key: uuid() })]);
  if (c.err) throw new Error(c.err.message + ' ' + c.err.detail);
  const a = await call<Adv>(cfo, `select public.special_advance_approve($1, $2::timestamptz, null) r`, [c.out!.id, c.out!.updated_at]);
  if (a.err) throw new Error(a.err.message);
  return a.out!;
}
const disburse = (a: Adv, payout: Record<string, unknown>, user = cfo) =>
  call<Adv>(user, `select public.special_advance_disburse($1, $2::timestamptz, $3::jsonb) r`, [a.id, a.updated_at, JSON.stringify(payout)]);
/** An uploaded proof file for one advance (stand-in for a storage upload); returns its path. */
async function proof(advanceId: string, ext = 'pdf') {
  const name = `advances/${advanceId}/${uuid()}.${ext}`;
  await db.query(`insert into storage.objects (bucket_id, name) values ('special-advance-proofs', $1)`, [name]);
  return name;
}
const repay = async (a: { id: string }, rep: Record<string, unknown>, user = cfo) =>
  call<Adv>(user, `select public.special_advance_record_repayment($1, $2::jsonb) r`, [a.id, JSON.stringify({
    idempotency_key: uuid(), method: 'mobile_money', received_date: today(),
    ...('proof_path' in rep ? {} : { proof_path: await proof(a.id) }), ...rep })]);

/** DR / CR of a ledger group, resolved through ledger_account_map (bucket-specific row first). */
async function mapped(group: string) {
  return q<{ account: string; dr: number; cr: number }>(`
    select coalesce(ms.account_code, ma.account_code, 'UNMAPPED') account,
           sum(case when gl.direction = coalesce(ms.debit_when, ma.debit_when) then gl.amount else 0 end)::bigint dr,
           sum(case when gl.direction <> coalesce(ms.debit_when, ma.debit_when) then gl.amount else 0 end)::bigint cr
      from public.general_ledger gl
      left join public.ledger_account_map ms on ms.ledger_scope = gl.ledger_scope and ms.category = gl.category and ms.wallet_bucket = gl.wallet_bucket
      left join public.ledger_account_map ma on ma.ledger_scope = gl.ledger_scope and ma.category = gl.category and ma.wallet_bucket is null
     where gl.transaction_group_id = $1 group by 1 order by 1`, [group]);
}
const legs = (group: string) => q<{ ledger_scope: string; direction: string; category: string; amount: string; wallet_bucket: string | null; user_id: string | null }>(
  `select ledger_scope, direction, category, amount::text, wallet_bucket, user_id from public.general_ledger where transaction_group_id = $1 order by category, direction`, [group]);


// ───────────── Phase C: impairment, write-off, recovery ─────────────
const CORRECTIONS = MIG('20261102210000_special_advances_corrections.sql');
const IMPAIRMENT = MIG('20261102220000_special_advances_impairment_writeoff.sql');
const IMPAIRMENT_RB = read('supabase/rollbacks/20261102220000_special_advances_impairment_writeoff.rollback.sql');
const cfo2 = uuid(); // another enabled CFO: Welile has one, so `cfo` approves its own requests; cfo2 only checks withdraw rights
const PHASE4_ALLOWLIST_MD5 = 'f61da259fbb92c484402bb3149abac37'; // production, read-only check 2026-11-02
const C_CATEGORIES = ['special_advance_impairment_charge', 'special_advance_impairment_allowance', 'special_advance_write_off',
  'special_advance_write_off_loss', 'special_advance_recovery_received', 'special_advance_recovery_income'];

type Line = { advance_id: string; reference: string; gross_outstanding: number; days_past_due: number; minimum_rate: number;
  individual_rate: number | null; applied_rate: number; required_allowance: number; held_before: number; delta: number; ledger_group_id?: string | null };
type Review = { id: string; reference: string; status: string; total_delta: number; lines: Line[]; replayed?: boolean };
type WriteOff = { id: string; reference: string; status: string; gross_amount: number; allowance_released: number; net_loss: number;
  ledger_group_id: string | null; replayed?: boolean };
type Recon = { balanced: boolean; difference: number; a24_ledger_balance: number; subledger_outstanding: number;
  a25_ledger_balance: number; allowance_subledger: number; allowance_difference: number; net_receivable: number;
  mismatched_advances: unknown[]; mismatched_allowances: unknown[] };

const run = async (sql: string) => {
  const e = await db.exec(`BEGIN;\n${sql}\nCOMMIT;`).then(() => undefined, (x: Err) => x);
  await db.exec('ROLLBACK').catch(() => {});
  return e;
};
const count = async (sql: string, params: unknown[] = []) => (await q<{ n: number }>(sql, params))[0].n;
const md5Of = async (sig: string) => (await q<{ m: string }>(`select md5(replace(prosrc, chr(13), '')) m from pg_proc where oid = $1::regprocedure`, [sig]))[0]?.m;
const recon = async () => (await call<Recon>(cfo, `select public.special_advance_reconciliation() r`)).out!;
const statement = async (id: string) => (await call<Adv & { allowance_held: number; status: string }>(cfo, `select public.special_advance_statement($1) r`, [id])).out!;
const held = async (id: string) => (await statement(id)).allowance_held;
/** Move the server's Kampala "today" N days ahead (test only), so instalments fall past due. */
const shiftToday = (days: number) => db.exec(`CREATE OR REPLACE FUNCTION public._special_advance_kampala_today() RETURNS date LANGUAGE sql STABLE
  SET search_path = public AS $$ SELECT (now() AT TIME ZONE 'Africa/Kampala')::date + ${days} $$`);
const preview = async (rates: Record<string, number> = {}) =>
  (await call<{ lines: Line[]; total_delta: number }>(cfo, `select public.special_advance_provision_preview($1::jsonb) r`, [JSON.stringify({ individual_rates: rates })])).out!;
const requestReview = (rates: Record<string, number> = {}, user = cfo, key = uuid(), aal = 'aal2') =>
  call<Review>(user, `select public.special_advance_request_provision_review($1::jsonb) r`, [JSON.stringify({ individual_rates: rates, note: 'Month-end review', idempotency_key: key })], aal);
const decideReview = (id: string, decision: string, user: string, note: string | null = null) =>
  call<Review>(user, `select public.special_advance_decide_provision_review($1, $2, $3) r`, [id, decision, note]);
const requestWriteOff = async (id: string, req: Record<string, unknown> = {}, user = cfo) =>
  call<WriteOff>(user, `select public.special_advance_request_write_off($1, $2::jsonb) r`, [id, JSON.stringify({
    idempotency_key: uuid(), reason: 'Borrower unreachable for 120 days; demand letters returned',
    ...('proof_path' in req ? {} : { proof_path: await proof(id) }), ...req })]);
const decideWriteOff = (id: string, decision: string, user: string, note: string | null = null) =>
  call<WriteOff>(user, `select public.special_advance_decide_write_off($1, $2, $3) r`, [id, decision, note]);
const recover = async (id: string, rec: Record<string, unknown>, user = cfo) =>
  call<{ id: string; ledger_group_id: string; replayed: boolean }>(user, `select public.special_advance_record_recovery($1, $2::jsonb) r`, [id, JSON.stringify({
    idempotency_key: uuid(), method: 'mobile_money', received_date: today(),
    ...('proof_path' in rec ? {} : { proof_path: await proof(id) }), ...rec })]);
const newBorrower = async (role = 'tenant') => {
  const u = uuid();
  await db.query(`insert into auth.users values ($1)`, [u]);
  await db.query(`insert into public.profiles (id, full_name) values ($1, 'Person')`, [u]);
  await db.query(`insert into public.user_roles (user_id, role) values ($1, $2)`, [u, role]);
  return u;
};
const paidOut = async (borrower: string, terms = TERMS) => (await disburse(await approved({ kind: 'welile_user', user_id: borrower }, terms), { payout_date: today(), method: 'wallet' })).out!;

const PHASE_B_MD5: Record<string, string> = {
  'public._special_advance_guard_update()': '905973f98fe6440d21fd2edaa4591182',
  'public._special_advance_audit()': 'c0cc409f070905a07ff19504b0f196ac',
  'public._special_advance_check_proof(uuid,text)': 'd12aa37dc682ebe7f64b376e2255e263',
  'public.special_advance_statement(uuid)': 'e46ad4cc6e46cf0ea723c705db429947',
  'public.special_advance_reconciliation()': '538f7ed60a247b1b7f2eda3d25dd5da7',
  'public._special_advance_eligibility(text,uuid,text,text,text,uuid)': 'c5d49dfa28e9c6fa5cf1c270a8547cb0',
};
const md5s = async () => Object.fromEntries(await Promise.all(Object.keys(PHASE_B_MD5).map(async (s) => [s, await md5Of(s)])));

async function setup() {
  await db.exec(STANDINS);
  await db.exec('set check_function_bodies = off;\n' + HELPERS + '\n' + REAL.join('\n') + '\n' + TRIGGER_VALIDATOR_ALLOWLIST + '\nset check_function_bodies = on;');
  await db.exec(`create trigger trg_validate_ledger_category before insert on public.general_ledger for each row execute function public.validate_ledger_category();`);
  // production's chart has X4 (Credit Losses and Write-offs)
  await db.exec(`insert into public.ledger_account_catalog (code, label, section, nature, sort_order) values ('X4', 'Credit Losses and Write-offs', 'expense', 'expense', 40)`);
  for (const u of [...users, cfo2]) {
    await db.query(`insert into auth.users values ($1)`, [u]);
    await db.query(`insert into public.profiles (id, full_name) values ($1, 'Person')`, [u]);
  }
  await db.query(`insert into public.user_roles (user_id, role) values ($1,'cfo'), ($2,'coo'), ($3,'super_admin'), ($4,'tenant'), ($5,'tenant'), ($6,'agent')`, users);
  await db.query(`insert into public.user_roles (user_id, role) values ($1,'cfo')`, [cfo2]);
  await db.exec(ENGINE);
  for (const m of [STORAGE, FUNCTIONS, PAYOUT, POSITION, CORRECTIONS]) await db.exec(`BEGIN;\n${m}\nCOMMIT;`);
  await db.exec(`update public.special_advance_settings set issuance_enabled = true`);
}

beforeAll(async () => {
  db = new PGlite();
  await setup();
}, 120_000);
afterAll(async () => { await db?.close(); });

describe('Phase C migration (accounting policy: A25, six mappings, six categories)', () => {
  it('starts from Phase B and the Phase 4 allowlist; applies once; a second run is refused', async () => {
    expect(await md5s()).toEqual(PHASE_B_MD5);
    expect(await md5Of('public.ledger_category_allowlist()')).toBe(PHASE4_ALLOWLIST_MD5);
    expect(await run(IMPAIRMENT)).toBeUndefined();
    expect((await run(IMPAIRMENT))?.message).toMatch(/already exist/);
  });

  it('adds A25 after A24 and exactly these mappings; every earlier account, mapping and category stays', async () => {
    expect(await q(`select code, label, section, nature, sort_order from public.ledger_account_catalog where code = 'A25'`))
      .toEqual([{ code: 'A25', label: 'Special Advances — Impairment Allowance', section: 'current_asset', nature: 'asset', sort_order: 125 }]);
    expect(await q(`select category, account_code, debit_when from public.ledger_account_map where category = any($1) order by category`, [C_CATEGORIES])).toEqual([
      { category: 'special_advance_impairment_allowance', account_code: 'A25', debit_when: 'cash_out' },
      { category: 'special_advance_impairment_charge', account_code: 'X4', debit_when: 'cash_out' },
      { category: 'special_advance_recovery_income', account_code: 'X4', debit_when: 'cash_in' },
      { category: 'special_advance_recovery_received', account_code: 'A1', debit_when: 'cash_in' },
      { category: 'special_advance_write_off', account_code: 'A24', debit_when: 'cash_out' },
      { category: 'special_advance_write_off_loss', account_code: 'X4', debit_when: 'cash_out' }]);
    const a = (await q<{ a: string[] }>(`select public.ledger_category_allowlist() a`))[0].a;
    expect(a).toHaveLength(178 + 6 + 6);
    expect(a.slice(-6)).toEqual(C_CATEGORIES);
    expect(await q(`select proconfig c from pg_proc where oid = 'public.ledger_category_allowlist()'::regprocedure`)).toEqual([{ c: ['search_path=public, extensions, pg_temp'] }]);
    expect(await count(`select count(*)::int n from public.ledger_account_map where account_code in ('A20','A21','A22','A23')`)).toBe(16);
  });

  it('new tables: CFO read only (RLS + staff MFA), no client writes; new functions for signed-in users only', async () => {
    for (const t of ['special_advance_provision_reviews', 'special_advance_provision_lines', 'special_advance_write_offs', 'special_advance_recoveries']) {
      expect(await q(`select has_table_privilege('authenticated', $1, 'SELECT') s, has_table_privilege('authenticated', $1, 'INSERT') i,
                             has_table_privilege('anon', $1, 'SELECT') a, (select relrowsecurity from pg_class where oid = $1::regclass) rls,
                             (select count(*)::int from pg_policies where tablename = $2) p`, [`public.${t}`, t]))
        .toEqual([{ s: true, i: false, a: false, rls: true, p: 2 }]);
    }
    expect(await q(`select has_function_privilege('authenticated','public.special_advance_decide_write_off(uuid,text,text)','EXECUTE') a,
                           has_function_privilege('anon','public.special_advance_record_recovery(uuid,jsonb)','EXECUTE') b,
                           has_function_privilege('authenticated','public._special_advance_provision_line(uuid,numeric)','EXECUTE') c`))
      .toEqual([{ a: true, b: false, c: false }]);
  });
});

describe('Provisions (D7 minimums, D8 accounts, second-CFO approval)', () => {
  let w1: Adv;
  let w2: Adv;
  beforeAll(async () => {
    w1 = await paidOut(tenant);   // 500,000 at 28%/month, 90 days: gross 940,000
    w2 = await paidOut(tenant2);
    await shiftToday(40);          // instalment 1 (day 30) is 10 days past due
  });
  afterAll(() => shiftToday(0));

  it('D7 minimum rates by days past due', async () => {
    expect(await q(`select d, public._special_advance_minimum_rate(d)::int r from unnest(array[0,1,30,31,60,61,90,91,400]) d`)).toEqual(
      [[0, 0], [1, 10], [30, 10], [31, 25], [60, 25], [61, 50], [90, 50], [91, 100], [400, 100]].map(([d, r]) => ({ d, r })));
  });

  it('the preview proposes 10% of the gross outstanding for 10 days past due; it changes nothing', async () => {
    const p = await preview();
    expect(p.lines.map((l) => [l.reference, l.gross_outstanding, l.days_past_due, Number(l.minimum_rate), l.required_allowance, l.delta]))
      .toEqual([[w1.reference, 940_000, 10, 10, 94_000, 94_000], [w2.reference, 940_000, 10, 10, 94_000, 94_000]]);
    expect(await count(`select count(*)::int n from public.special_advance_provision_reviews`)).toBe(0);
  });

  it('an individual rate below the minimum is refused; a higher one applies; requests need aal2 and the CFO role', async () => {
    expect((await requestReview({ [w1.id]: 5 })).err?.message).toBe('INDIVIDUAL_RATE_BELOW_MINIMUM');
    expect((await requestReview({ [w1.id]: 150 })).err?.message).toBe('SPECIAL_ADVANCE_INVALID_REQUEST');
    expect((await requestReview({}, coo)).err?.message).toBe('NOT_AUTHORIZED');
    expect((await requestReview({}, cfo, uuid(), 'aal1')).err?.message).toBe('MFA_REQUIRED');
  });

  it('a review posts nothing until a CFO (the requester may) approves it; then DR X4 / CR A25 per advance', async () => {
    const ledger0 = await count(`select count(*)::int n from public.general_ledger`);
    const key = uuid();
    const r = (await requestReview({ [w1.id]: 60 }, cfo, key)).out!;
    expect(r).toMatchObject({ status: 'pending', total_delta: 564_000 + 94_000 });
    expect((await requestReview({ [w1.id]: 60 }, cfo, key)).out?.replayed).toBe(true);
    expect((await requestReview({}, cfo)).err?.message).toBe('PROVISION_REVIEW_ALREADY_PENDING');
    expect(await count(`select count(*)::int n from public.general_ledger`)).toBe(ledger0);
    const ok = await decideReview(r.id, 'approve', cfo, 'Agreed: W1 individually impaired');
    expect(ok.err).toBeUndefined();
    const l1 = ok.out!.lines.find((l) => l.advance_id === w1.id)!;
    expect(await mapped(l1.ledger_group_id!)).toEqual([{ account: 'A25', dr: 0, cr: 564_000 }, { account: 'X4', dr: 564_000, cr: 0 }]);
    expect(await held(w1.id)).toBe(564_000);
    expect(await held(w2.id)).toBe(94_000);
    const rc = await recon();
    expect(rc).toMatchObject({ balanced: true, difference: 0, a25_ledger_balance: 658_000, allowance_subledger: 658_000, allowance_difference: 0 });
    expect(rc.net_receivable).toBe(rc.a24_ledger_balance - 658_000);
  });

  it('the individual rate carries forward (nothing to change); 0 returns to the minimum and releases DR A25 / CR X4', async () => {
    expect((await requestReview({})).err?.message).toBe('NOTHING_TO_PROVISION');
    const r = (await requestReview({ [w1.id]: 0 })).out!;
    expect(r.lines.map((l) => [l.advance_id, l.delta])).toEqual([[w1.id, 94_000 - 564_000]]);
    const ok = (await decideReview(r.id, 'approve', cfo)).out!;
    expect(await mapped(ok.lines[0].ledger_group_id!)).toEqual([{ account: 'A25', dr: 470_000, cr: 0 }, { account: 'X4', dr: 0, cr: 470_000 }]);
    expect(await held(w1.id)).toBe(94_000);
  });

  it('approval is refused as stale when a figure moved after the request; nothing posts', async () => {
    const r = (await requestReview({ [w2.id]: 30 })).out!;
    await repay(w2, { amount: 100_000, reference: 'MM-W2-STALE-1' });
    const ledger0 = await count(`select count(*)::int n from public.general_ledger`);
    expect((await decideReview(r.id, 'approve', cfo)).err?.message).toBe('PROVISION_REVIEW_STALE');
    expect(await count(`select count(*)::int n from public.general_ledger`)).toBe(ledger0);
    expect((await decideReview(r.id, 'reject', cfo)).err?.message).toBe('REASON_REQUIRED');
    expect((await decideReview(r.id, 'reject', cfo, 'Stale: repayment received')).out?.status).toBe('rejected');
  });

  it('after a repayment the next review lowers the allowance to the new gross (release)', async () => {
    const r = (await requestReview({})).out!;
    expect(r.lines.map((l) => [l.advance_id, l.gross_outstanding, l.required_allowance, l.delta])).toEqual([[w2.id, 840_000, 84_000, -10_000]]);
    expect((await decideReview(r.id, 'withdraw', cfo2)).err?.message).toBe('ONLY_REQUESTER_MAY_WITHDRAW');
    await decideReview(r.id, 'approve', cfo);
    expect(await held(w2.id)).toBe(84_000);
    expect(await recon()).toMatchObject({ balanced: true, allowance_difference: 0 });
  });
});

describe('Write-off (D9) and recovery (D10)', () => {
  let w1: string;
  let w2: string;
  let wo: WriteOff;
  beforeAll(async () => {
    w1 = (await q<{ id: string }>(`select id from public.special_advances where borrower_user_id = $1 and status = 'disbursed'`, [tenant]))[0].id;
    w2 = (await q<{ id: string }>(`select id from public.special_advances where borrower_user_id = $1 and status = 'disbursed'`, [tenant2]))[0].id;
  });

  it('a request needs a 20+ character reason and an evidence file; posts nothing; one pending per advance', async () => {
    expect((await requestWriteOff(w1, { reason: 'Gone quiet' })).err?.message).toBe('REASON_REQUIRED');
    expect((await requestWriteOff(w1, { proof_path: null })).err?.message).toBe('PROOF_REQUIRED');
    const ledger0 = await count(`select count(*)::int n from public.general_ledger`);
    wo = (await requestWriteOff(w1)).out!;
    expect(wo).toMatchObject({ status: 'pending', gross_amount: 940_000, allowance_released: 94_000, net_loss: 846_000 });
    expect((await requestWriteOff(w1)).err?.message).toBe('WRITE_OFF_ALREADY_PENDING');
    expect(await count(`select count(*)::int n from public.general_ledger`)).toBe(ledger0);
  });

  it('the same CFO approves the write-off: CR A24 gross, DR A25 allowance, DR X4 the rest; the advance is written off and stays on record', async () => {
    const r = await decideWriteOff(wo.id, 'approve', cfo, 'Evidence reviewed');
    expect(r.err).toBeUndefined();
    expect(await mapped(r.out!.ledger_group_id!)).toEqual([
      { account: 'A24', dr: 0, cr: 940_000 }, { account: 'A25', dr: 94_000, cr: 0 }, { account: 'X4', dr: 846_000, cr: 0 }]);
    const st = await statement(w1);
    expect(st.status).toBe('written_off');
    expect(st.position).toMatchObject({ outstanding: 0 });
    expect(st.allowance_held).toBe(0);
    expect(st.events.map((e) => e.event_type).slice(-3).sort()).toEqual(['write_off_approved', 'write_off_requested', 'written_off']);
    expect(await recon()).toMatchObject({ balanced: true, difference: 0, allowance_difference: 0 });
    expect((await repay({ id: w1 }, { amount: 1_000, reference: 'MM-AFTER-WO' })).err?.message).toBe('SPECIAL_ADVANCE_NOT_REPAYABLE');
    expect((await decideWriteOff(wo.id, 'approve', cfo)).out?.replayed).toBe(true);
  });

  it('a written-off borrower cannot get a new Special Advance (safety default)', async () => {
    const q1 = await call<{ eligibility: { eligible: boolean; reasons: string[] } }>(cfo, `select public.special_advance_quote($1::jsonb) r`,
      [JSON.stringify({ borrower: { kind: 'welile_user', user_id: tenant }, terms: TERMS })]);
    expect(JSON.stringify(q1.out)).toMatch(/WRITTEN_OFF_SPECIAL_ADVANCE/);
  });

  it('a recovery posts DR A1 / CR X4, never more than was written off; references are booked once', async () => {
    const r = await recover(w1, { amount: 300_000, reference: 'MM-REC-0001' });
    expect(r.err).toBeUndefined();
    expect(await mapped(r.out!.ledger_group_id)).toEqual([{ account: 'A1', dr: 300_000, cr: 0 }, { account: 'X4', dr: 0, cr: 300_000 }]);
    expect((await recover(w1, { amount: 640_001, reference: 'MM-REC-0002' })).err?.message).toBe('RECOVERY_EXCEEDS_WRITTEN_OFF');
    expect((await recover(w1, { amount: 1_000, reference: 'mm-rec-0001' })).err?.message).toBe('REPAYMENT_REFERENCE_ALREADY_RECORDED');
    expect((await recover(w1, { amount: 1_000, reference: 'MM-W2-STALE-1' })).err?.message).toBe('REPAYMENT_REFERENCE_ALREADY_RECORDED');
    expect((await recover(w2, { amount: 1_000, reference: 'MM-REC-0003' })).err?.message).toBe('SPECIAL_ADVANCE_NOT_WRITTEN_OFF');
    expect((await recover(w1, { amount: 1_000, reference: 'MM-REC-0004' }, coo)).err?.message).toBe('NOT_AUTHORIZED');
    expect((await statement(w1)).status).toBe('written_off');
    expect(await recon()).toMatchObject({ balanced: true });
  });

  it('an allowance above the balance is released by the write-off (CR X4), and a stale request is refused', async () => {
    const id = (await paidOut(await newBorrower(), { ...TERMS, principal: 200_000 })).id; // gross 200,000 + 168,000 + 10,000 = 378,000
    await shiftToday(40);
    try {
      const r = (await requestReview({ [id]: 100 })).out!;
      await decideReview(r.id, 'approve', cfo);
      expect(await held(id)).toBe(378_000);
      await repay({ id }, { amount: 78_000, reference: 'MM-OVERPROV-1' }); // gross 300,000 < allowance 378,000
      const stale = (await requestWriteOff(id)).out!;
      await repay({ id }, { amount: 1_000, reference: 'MM-OVERPROV-2' });
      expect((await decideWriteOff(stale.id, 'approve', cfo)).err?.message).toBe('WRITE_OFF_STALE');
      await decideWriteOff(stale.id, 'withdraw', cfo);
      const w = (await requestWriteOff(id)).out!;
      expect(w).toMatchObject({ gross_amount: 299_000, allowance_released: 378_000, net_loss: -79_000 });
      const ok = (await decideWriteOff(w.id, 'approve', cfo)).out!;
      expect(await mapped(ok.ledger_group_id!)).toEqual([
        { account: 'A24', dr: 0, cr: 299_000 }, { account: 'A25', dr: 378_000, cr: 0 }, { account: 'X4', dr: 0, cr: 79_000 }]);
      expect(await recon()).toMatchObject({ balanced: true, difference: 0, allowance_difference: 0 });
    } finally {
      await shiftToday(0);
    }
  });
});

describe('Records stay append-only; the write-off edge only through an approved write-off', () => {
  it('provision lines, decided reviews and write-offs, and recoveries never change or disappear', async () => {
    for (const sql of [
      `update public.special_advance_provision_lines set delta = 0`,
      `delete from public.special_advance_provision_lines`,
      `update public.special_advance_provision_reviews set status = 'rejected' where status = 'approved'`,
      `update public.special_advance_write_offs set gross_amount = 1 where status = 'approved'`,
      `delete from public.special_advance_write_offs`,
      `update public.special_advance_recoveries set amount = 1`,
      `delete from public.special_advance_recoveries`]) {
      expect(((await db.exec(sql).catch((x: Err) => x)) as Err).code, sql).toBe('42501');
    }
  });

  it('disbursed -> written_off cannot be written directly', async () => {
    const id = (await q<{ id: string }>(`select id from public.special_advances where status = 'disbursed' limit 1`))[0].id;
    expect(((await db.exec(`update public.special_advances set status = 'written_off' where id = '${id}'`).catch((x: Err) => x)) as Err).message)
      .toMatch(/SPECIAL_ADVANCE_INVALID_TRANSITION/);
  });

  it('every Phase C group balances raw and on the mapping, and is platform-only', async () => {
    const groups = await q<{ g: string }>(`select distinct transaction_group_id g from public.general_ledger where category = any($1)`, [C_CATEGORIES]);
    expect(groups.length).toBeGreaterThanOrEqual(7);
    for (const { g } of groups) {
      expect((await mapped(g)).reduce((s, x) => s + Number(x.dr) - Number(x.cr), 0), g).toBe(0);
      expect(await count(`select count(*)::int n from public.general_ledger where transaction_group_id = $1 and ledger_scope <> 'platform'`, [g])).toBe(0);
      expect((await q<{ n: number }>(`select sum(case when direction='cash_in' then amount else -amount end)::int n from public.general_ledger where transaction_group_id = $1`, [g]))[0].n).toBe(0);
    }
  });
});

describe('Phase C rollback', () => {
  it('refuses once impairment, write-off or recovery has been used', async () => {
    expect((await run(IMPAIRMENT_RB))?.message).toMatch(/has been used/);
    expect(await count(`select count(*)::int n from public.ledger_account_catalog where code = 'A25'`)).toBe(1);
  });

  it('before any use, restores the six functions, the allowlist, the chart and the constraints exactly; re-applying works', async () => {
    const fresh = new PGlite();
    const prev = db;
    db = fresh;
    try {
      await setup();
      const before = { fns: await md5s(), allow: await md5Of('public.ledger_category_allowlist()'),
        cons: await q(`select conname, pg_get_constraintdef(oid) d from pg_constraint where conrelid in ('public.special_advances'::regclass, 'public.special_advance_events'::regclass) order by 1`),
        map: await count(`select count(*)::int n from public.ledger_account_map`), cat: await count(`select count(*)::int n from public.ledger_account_catalog`) };
      expect(await run(IMPAIRMENT)).toBeUndefined();
      expect(await run(IMPAIRMENT_RB)).toBeUndefined();
      expect(await md5s()).toEqual(before.fns);
      expect(await md5Of('public.ledger_category_allowlist()')).toBe(before.allow);
      expect(await q(`select proconfig c from pg_proc where oid = 'public.ledger_category_allowlist()'::regprocedure`)).toEqual([{ c: ['search_path=public, extensions, pg_temp'] }]);
      expect(await q(`select conname, pg_get_constraintdef(oid) d from pg_constraint where conrelid in ('public.special_advances'::regclass, 'public.special_advance_events'::regclass) order by 1`)).toEqual(before.cons);
      expect(await count(`select count(*)::int n from public.ledger_account_map`)).toBe(before.map);
      expect(await count(`select count(*)::int n from public.ledger_account_catalog`)).toBe(before.cat);
      expect(await q(`select to_regclass('public.special_advance_write_offs') t`)).toEqual([{ t: null }]);
      expect(await run(IMPAIRMENT)).toBeUndefined();
    } finally {
      await fresh.close();
      db = prev;
    }
  }, 120_000);
});

describe('Client helpers (src/lib/specialAdvances.ts, Phase C)', () => {
  it('request bodies carry rates and reasons only, never amounts', async () => {
    const { buildProvisionReviewRequest, buildWriteOffRequest } = await import('@/lib/specialAdvances');
    expect(buildProvisionReviewRequest({ individualRates: { a: 60 }, note: '  Month end  ', idempotencyKey: 'k' }))
      .toEqual({ individual_rates: { a: 60 }, note: 'Month end', idempotency_key: 'k' });
    expect(buildProvisionReviewRequest({ idempotencyKey: 'k' })).toEqual({ individual_rates: {}, idempotency_key: 'k' });
    expect(buildWriteOffRequest({ reason: ' Unreachable for 120 days now ', proofPath: 'p', idempotencyKey: 'k' }))
      .toEqual({ reason: 'Unreachable for 120 days now', proof_path: 'p', idempotency_key: 'k' });
  });

  it('words the Phase C refusals and the written-off eligibility code', async () => {
    const { describeSpecialAdvanceError, eligibilityText, STATUS_LABEL } = await import('@/lib/specialAdvances');
    expect(describeSpecialAdvanceError({ message: 'INDIVIDUAL_RATE_BELOW_MINIMUM', details: '{"minimum_rate": 25}' })).toMatch(/\(25%\)/);
    expect(describeSpecialAdvanceError({ message: 'RECOVERY_EXCEEDS_WRITTEN_OFF', details: '{"recoverable": 640000}' })).toMatch(/640,000/);
    expect(describeSpecialAdvanceError({ message: 'PROVISION_REVIEW_STALE' })).toMatch(/new review/);
    expect(describeSpecialAdvanceError({ message: 'REASON_REQUIRED', details: 'Explain the write-off in 20 to 1000 characters' })).toMatch(/at least 20/);
    expect(eligibilityText('WRITTEN_OFF_SPECIAL_ADVANCE')).toMatch(/written off/);
    expect(STATUS_LABEL.written_off).toBe('Written off');
  });
});
