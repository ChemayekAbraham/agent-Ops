// @vitest-environment node
/**
 * Special Advances: ONE access fee, no registration fee (CFO decision 2026-11-03;
 * supabase/migrations/20261103170000_special_advances_single_access_fee.sql) on PGlite, on top of production as on
 * 2026-11-03 (Phases 1-4, A, B, C and the authenticator removal), with a replica of SA-000001.
 * Amounts, schedules, cash (A1), the receivable (A24) and fee income (R1) are unchanged; stored history is untouched;
 * new advances, repayment allocations, payout and reversal ledger rows and reports carry one access fee only; the
 * rollback restores the production definitions exactly.
 * Same real code and stand-ins as specialAdvancePayout.test.ts, plus X4.
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



// ───────────── 2026-11-03: one access fee, no registration fee (20261103170000) ─────────────
const CORRECTIONS = MIG('20261102210000_special_advances_corrections.sql');
const IMPAIRMENT = MIG('20261102220000_special_advances_impairment_writeoff.sql');
const NO_MFA = MIG('20261103150000_special_advances_remove_mfa.sql');
const ONE_FEE = MIG('20261103170000_special_advances_single_access_fee.sql');
const ONE_FEE_RB = read('supabase/rollbacks/20261103170000_special_advances_single_access_fee.rollback.sql');
/** Production definitions on 2026-11-03 (read-only check) and the definitions after the migration. */
const FNS: Record<string, [string, string]> = {
  'public._special_advance_schedule(numeric, numeric, text, numeric, text, date)': ['72d88fa24d0125c66ef7ad63579d8264', '96c3dd958601425c83b348e2d5e4fa42'],
  'public.special_advance_create(jsonb)': ['325f9aab5c6c69b120feda88634e40c5', '33c557fe3f0c106c90d6ec7be5fa2c0d'],
  'public._special_advance_verify_agreement()': ['114b0cd006b5618976b1f06694a3fca2', 'e2fda1064b19bf7df0ef325d9e74f0a2'],
  'public._special_advance_json(uuid)': ['340f44043709ad13682469d2b867d001', '2bd7bb27d9e06f6a9fdb250c6a0a774f'],
  'public._special_advance_position(uuid)': ['c17b7e48f943731c5c5f8d29f3c2e9dc', '30aa90195e213744277d1a502fd471d2'],
  'public._special_advance_verify_repayments()': ['50ff7fd66e4ba87d924c7815024fea35', '55dc4aad8afe801df0e514e427af5190'],
  'public.special_advance_record_repayment(uuid, jsonb)': ['6ccc510d8797574fb5e107065bf966e5', '72980eea5163e0b7de8dc4c24a0b91ed'],
  'public.special_advance_disburse(uuid, timestamp with time zone, jsonb)': ['44065a5c57df6f4f8bf785c80b2b3d15', 'c5848007e8960b5b2c1468414f08b7e5'],
  'public.special_advance_record_correction(uuid, jsonb)': ['bef74b0e245a0c754f00705ddddc768c', 'adc9fea292474059aa12b112c9fe6def'],
  'public._special_advance_audit()': ['c8033574751a7ee91b9318a0a00909da', '557a8d46434b4bf3562a2ccc0fc9a101'],
};

const run = async (sql: string) => {
  const e = await db.exec(`BEGIN;\n${sql}\nCOMMIT;`).then(() => undefined, (x: Err) => x);
  await db.exec('ROLLBACK').catch(() => {});
  return e;
};
const count = async (sql: string, params: unknown[] = []) => (await q<{ n: number }>(sql, params))[0].n;
const md5Of = async (sig: string) => (await q<{ m: string }>(`select md5(replace(prosrc, chr(13), '')) m from pg_proc where oid = to_regprocedure($1)`, [sig]))[0]?.m ?? null;
const fnState = async () => Object.fromEntries(await Promise.all(Object.keys(FNS).map(async (s) => [s, await md5Of(s)])));
const pins = (k: 0 | 1) => Object.fromEntries(Object.entries(FNS).map(([s, v]) => [s, v[k]]));
const constraints = () => q<{ name: string; valid: boolean }>(`select conname name, convalidated valid from pg_constraint
  where conname in ('special_advances_one_access_fee', 'special_advance_allocations_one_access_fee') order by 1`);
const statement = async (id: string) => (await call<Record<string, unknown> & { position: Record<string, unknown>; schedule: Array<Record<string, unknown>>;
  events: Array<{ event_type: string; details: Record<string, unknown> | null }> }>(cfo, `select public.special_advance_statement($1) r`, [id])).out!;
/** Everything stored about Special Advances, to prove the migration and rollback leave history untouched. */
const history = async () => JSON.stringify(await q(`select
  (select jsonb_agg(to_jsonb(a) order by a.id) from public.special_advances a) adv,
  (select jsonb_agg(to_jsonb(i) order by i.advance_id, i.number) from public.special_advance_instalments i) inst,
  (select jsonb_agg(to_jsonb(r) order by r.id) from public.special_advance_repayments r) rep,
  (select jsonb_agg(to_jsonb(x) order by x.repayment_id, x.instalment_number) from public.special_advance_repayment_allocations x) alloc,
  (select jsonb_agg(to_jsonb(e) order by e.id) from public.special_advance_events e) ev,
  (select jsonb_agg(to_jsonb(g) order by g.id) from public.general_ledger g) gl`));
const accountTotals = async () => q<{ account: string; dr: string; cr: string }>(`
  select coalesce(ms.account_code, ma.account_code, 'UNMAPPED') account,
         sum(case when gl.direction = coalesce(ms.debit_when, ma.debit_when) then gl.amount else 0 end)::text dr,
         sum(case when gl.direction <> coalesce(ms.debit_when, ma.debit_when) then gl.amount else 0 end)::text cr
    from public.general_ledger gl
    left join public.ledger_account_map ms on ms.ledger_scope = gl.ledger_scope and ms.category = gl.category and ms.wallet_bucket = gl.wallet_bucket
    left join public.ledger_account_map ma on ma.ledger_scope = gl.ledger_scope and ma.category = gl.category and ma.wallet_bucket is null
   where gl.category like 'special\\_advance%' group by 1 order by 1`);
const descriptions = async (group: string) =>
  (await q<{ d: string }>(`select description d from public.general_ledger where transaction_group_id = $1 order by description`, [group])).map((r) => r.d);
const correct = async (id: string, req: Record<string, unknown>) =>
  call<{ id: string; ledger_group_id: string; amount: number }>(cfo, `select public.special_advance_record_correction($1, $2::jsonb) r`, [id, JSON.stringify({
    idempotency_key: uuid(), reason: 'Payout recorded twice; the provider shows one transfer only', proof_path: await proof(id), ...req })]);

/** SA-000001 in production: 20,000 at 15% per month for 7 days, daily; access fee 700, registration fee 10,000. */
const SA1 = { principal: 20_000, rate_percent: 15, rate_basis: 'monthly', term_days: 7, frequency: 'daily' };
const SA1_INSTALMENTS = [[4386, 700, 3686, 0], [4386, 0, 4386, 0], [4386, 0, 1928, 2458], [4386, 0, 0, 4386], [4386, 0, 0, 4386], [4386, 0, 0, 4386], [4384, 0, 0, 4384]];

async function setup() {
  await db.exec(STANDINS);
  await db.exec('set check_function_bodies = off;\n' + HELPERS + '\n' + REAL.join('\n') + '\n' + TRIGGER_VALIDATOR_ALLOWLIST + '\nset check_function_bodies = on;');
  await db.exec(`create trigger trg_validate_ledger_category before insert on public.general_ledger for each row execute function public.validate_ledger_category();`);
  await db.exec(`insert into public.ledger_account_catalog (code, label, section, nature, sort_order) values ('X4', 'Credit Losses and Write-offs', 'expense', 'expense', 40)`);
  for (const u of users) {
    await db.query(`insert into auth.users values ($1)`, [u]);
    await db.query(`insert into public.profiles (id, full_name) values ($1, 'Person')`, [u]);
  }
  await db.query(`insert into public.user_roles (user_id, role) values ($1,'cfo'), ($2,'coo'), ($3,'super_admin'), ($4,'tenant'), ($5,'tenant'), ($6,'agent')`, users);
  await db.exec(ENGINE);
  // production on 2026-11-03: Phases 1-4, A, B, C and the authenticator removal
  for (const m of [STORAGE, FUNCTIONS, PAYOUT, POSITION, CORRECTIONS, IMPAIRMENT, NO_MFA]) await db.exec(`BEGIN;\n${m}\nCOMMIT;`);
  await db.exec(`update public.special_advance_settings set issuance_enabled = true`);
}

/** Random valid agreements, with their sa-calc-1 schedules (captured before the migration). */
type Sched = { access_fee: number; registration_fee?: number; total_repayable: number; instalments: number; instalment_amount: number; calc_version: string;
  schedule: Array<{ due_date: string; amount: number; access_fee: number; registration_fee?: number; principal: number; balance_after: number }> };
const CASES: Array<{ args: unknown[]; v1?: Sched }> = [];
let seed = 20261103;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
for (let k = 0; k < 400; k++) {
  const basis = rnd() < 0.5 ? 'daily' : 'monthly';
  const rate = (1 + Math.floor(rnd() * (basis === 'daily' ? 100 : 2800))) / 100;
  const principal = [10_000, 199_999, 200_000, 200_001][k % 4] + (rnd() < 0.7 ? Math.floor(rnd() * 3_000_000) : 0);
  const term = 1 + Math.floor(rnd() * 90);
  CASES.push({ args: [principal, rate, basis, term, ['daily', 'weekly', 'monthly'][k % 3], '2026-11-03'] });
}
const engine = async (a: unknown[]) => (await q<{ s: Sched }>(`select public._special_advance_schedule($1, $2, $3, $4, $5, $6::date) s`, a))[0].s;

let legacy: Adv;          // the SA-000001 replica (sa-calc-1)
let before: string;       // stored history just before the migration

beforeAll(async () => {
  db = new PGlite();
  await setup();
  for (const c of CASES) c.v1 = await engine(c.args);
}, 180_000);
afterAll(async () => { await db?.close(); });

describe('before the migration: production as on 2026-11-03', () => {
  it('SA-000001 replica: two fees under sa-calc-1, paid out to the wallet, two ledger rows described "registration fee"', async () => {
    expect(await fnState()).toEqual(pins(0));
    const a = await approved({ kind: 'welile_user', user_id: tenant }, SA1 as typeof TERMS);
    const d = await disburse(a, { payout_date: today(), method: 'wallet' });
    expect(d.err).toBeUndefined();
    legacy = d.out!;
    expect(await q(`select access_fee::int, registration_fee::int, total_repayable::int, calc_version from public.special_advances where id = $1`, [legacy.id]))
      .toEqual([{ access_fee: 700, registration_fee: 10_000, total_repayable: 30_700, calc_version: 'sa-calc-1' }]);
    expect((await q<{ r: number[] }>(`select array[amount, access_fee, registration_fee, principal]::int[] r from public.special_advance_instalments
      where advance_id = $1 order by number`, [legacy.id])).map((x) => x.r)).toEqual(SA1_INSTALMENTS);
    expect((await descriptions(legacy.payout_ledger_group_id!)).filter((x) => /registration fee/.test(x))).toHaveLength(2);
    expect(await mapped(legacy.payout_ledger_group_id!)).toEqual([
      { account: 'A24', dr: 30_700, cr: 0 }, { account: 'L1', dr: 0, cr: 20_000 }, { account: 'R1', dr: 0, cr: 10_700 }]);
  });
});

describe('20261103170000 migration', () => {
  it('applies over the production definitions only, once; adds the two constraints, both validated', async () => {
    before = await history();
    expect(await run(ONE_FEE)).toBeUndefined();
    expect(await fnState()).toEqual(pins(1));
    expect(await constraints()).toEqual([
      { name: 'special_advance_allocations_one_access_fee', valid: true }, { name: 'special_advances_one_access_fee', valid: true }]);
    expect((await run(ONE_FEE))?.message).toMatch(/precondition failed/);
  });

  it('changes no stored record, ledger row, mapping, account or privilege', async () => {
    expect(await history()).toBe(before);
    expect(await count(`select count(*)::int n from public.ledger_account_map where category like 'special\\_advance\\_%'`)).toBe(12);
    expect(await q(`select has_function_privilege('authenticated','public.special_advance_create(jsonb)','EXECUTE') c,
                           has_function_privilege('anon','public.special_advance_create(jsonb)','EXECUTE') a,
                           has_function_privilege('authenticated','public._special_advance_schedule(numeric, numeric, text, numeric, text, date)','EXECUTE') e,
                           has_function_privilege('authenticated','public._special_advance_position(uuid)','EXECUTE') p`))
      .toEqual([{ c: true, a: false, e: false, p: false }]);
  });
});

describe('SA-000001 after the migration: one access fee in reports, history unchanged', () => {
  it('the statement shows one access fee of 10,700 and no registration fee anywhere', async () => {
    const s = await statement(legacy.id);
    expect([s.access_fee, s.total_repayable, s.principal]).toEqual([10_700, 30_700, 20_000]);
    expect(s).not.toHaveProperty('registration_fee');
    expect(s.schedule.map((r) => [r.amount, r.access_fee, r.principal])).toEqual(SA1_INSTALMENTS.map(([amt, a, g, p]) => [amt, a + g, p]));
    expect(JSON.stringify({ ...s, events: [] })).not.toMatch(/registration_fee/);
    expect(s.position).toMatchObject({ outstanding: 30_700, outstanding_access_fee: 10_700, outstanding_principal: 20_000 });
    expect(s.position).not.toHaveProperty('outstanding_registration_fee');
  });

  it('a repayment allocates the whole fee part as access fee (no registration fee), then principal: DR A1 / CR A24', async () => {
    const r = await repay(legacy, { amount: 5_000, reference: 'MM-ONEFEE-1' });
    expect(r.err).toBeUndefined();
    expect(await q(`select instalment_number n, access_fee::int a, registration_fee::int g, principal::int p from public.special_advance_repayment_allocations
      where advance_id = $1 order by 1`, [legacy.id])).toEqual([{ n: 1, a: 4_386, g: 0, p: 0 }, { n: 2, a: 614, g: 0, p: 0 }]);
    const g = (await q<{ g: string }>(`select ledger_group_id g from public.special_advance_repayments where reference = 'MM-ONEFEE-1'`))[0].g;
    expect(await mapped(g)).toEqual([{ account: 'A1', dr: 5_000, cr: 0 }, { account: 'A24', dr: 0, cr: 5_000 }]);
    expect((await statement(legacy.id)).position).toMatchObject({ outstanding: 25_700, outstanding_access_fee: 5_700, outstanding_principal: 20_000, total_paid: 5_000 });
  });

  it('is repaid in full: fees then principal, exactly the agreed 30,700; the advance settles', async () => {
    const r = await repay(legacy, { amount: 25_700, reference: 'MM-ONEFEE-2' });
    expect(r.err).toBeUndefined();
    expect(r.out!.status).toBe('settled');
    expect(await q(`select sum(access_fee)::int a, sum(registration_fee)::int g, sum(principal)::int p from public.special_advance_repayment_allocations
      where advance_id = $1`, [legacy.id])).toEqual([{ a: 10_700, g: 0, p: 20_000 }]);
    // per instalment the fee and principal paid are exactly what the agreement set (fee = stored access + registration)
    expect((await q<{ r: number[] }>(`select array[i.amount, sum(x.access_fee), sum(x.principal)]::int[] r from public.special_advance_instalments i
      join public.special_advance_repayment_allocations x on x.advance_id = i.advance_id and x.instalment_number = i.number
      where i.advance_id = $1 group by i.number, i.amount order by i.number`, [legacy.id])).map((x) => x.r))
      .toEqual(SA1_INSTALMENTS.map(([amt, a, g, p]) => [amt, a + g, p]));
  });

  it('its stored agreement, instalments and payout ledger rows are still exactly as recorded', async () => {
    expect(await q(`select access_fee::int, registration_fee::int, calc_version from public.special_advances where id = $1`, [legacy.id]))
      .toEqual([{ access_fee: 700, registration_fee: 10_000, calc_version: 'sa-calc-1' }]);
    expect((await descriptions(legacy.payout_ledger_group_id!)).filter((x) => /registration fee/.test(x))).toHaveLength(2);
  });
});

describe('a new advance (sa-calc-2): one access fee everywhere, same amounts', () => {
  let n: Adv;

  it('the quote has one access fee and no registration fee; total and instalments equal SA-000001', async () => {
    const s = (await call<{ schedule: Sched }>(cfo, `select public.special_advance_quote($1::jsonb) r`, [JSON.stringify({ terms: SA1 })])).out!.schedule;
    expect([s.access_fee, s.total_repayable, s.instalments, s.calc_version]).toEqual([10_700, 30_700, 7, 'sa-calc-2']);
    expect(JSON.stringify(s)).not.toMatch(/registration/);
    expect(s.schedule.map((r) => [r.amount, r.access_fee, r.principal])).toEqual(SA1_INSTALMENTS.map(([amt, a, g, p]) => [amt, a + g, p]));
  });

  it('is recorded with registration fee 0, its event shows one access fee, and the payout posts one access fee pair', async () => {
    const a = await approved({ kind: 'welile_user', user_id: tenant2 }, SA1 as typeof TERMS);
    expect(await q(`select access_fee::int, registration_fee::int, total_repayable::int, calc_version from public.special_advances where id = $1`, [a.id]))
      .toEqual([{ access_fee: 10_700, registration_fee: 0, total_repayable: 30_700, calc_version: 'sa-calc-2' }]);
    expect(await q(`select sum(registration_fee)::int g from public.special_advance_instalments where advance_id = $1`, [a.id])).toEqual([{ g: 0 }]);
    const created = (await statement(a.id)).events.find((e) => e.event_type === 'created')!;
    expect(created.details).toMatchObject({ access_fee: 10_700, total_repayable: 30_700, calc_version: 'sa-calc-2' });
    expect(created.details).not.toHaveProperty('registration_fee');
    const d = await disburse(a, { payout_date: today(), method: 'wallet' });
    expect(d.err).toBeUndefined();
    n = d.out!;
    const desc = await descriptions(n.payout_ledger_group_id!);
    expect(desc.filter((x) => /registration/i.test(x))).toEqual([]);
    expect(desc.filter((x) => /access fee/.test(x))).toHaveLength(2);
    expect(await mapped(n.payout_ledger_group_id!)).toEqual([
      { account: 'A24', dr: 30_700, cr: 0 }, { account: 'L1', dr: 0, cr: 20_000 }, { account: 'R1', dr: 0, cr: 10_700 }]);
  });

  it('a payout reversal (external advance) posts one access fee pair back: DR A1, DR R1, CR A24', async () => {
    const a = await approved({ kind: 'external', borrower_type: 'individual', full_name: 'Grace Namata', phone: '0772555111', national_id: 'CF900000000001' },
      { principal: 300_000, rate_percent: 28, rate_basis: 'monthly', term_days: 14, frequency: 'weekly' });
    const d = await disburse(a, { payout_date: today(), method: 'mobile_money', reference: 'MM-ONEFEE-PAY', proof_path: await proof(a.id, 'png') });
    expect(d.err).toBeUndefined();
    const fee = 39_200 + 20_000; // 300,000 x 28% x 14 / 30 = 39,200, plus the fixed 20,000
    expect(await mapped(d.out!.payout_ledger_group_id!)).toEqual([
      { account: 'A1', dr: 0, cr: 300_000 }, { account: 'A24', dr: 300_000 + fee, cr: 0 }, { account: 'R1', dr: 0, cr: fee }]);
    const r = await correct(a.id, { kind: 'payout_reversal' });
    expect(r.err).toBeUndefined();
    expect((await descriptions(r.out!.ledger_group_id)).filter((x) => /registration/i.test(x))).toEqual([]);
    expect(await mapped(r.out!.ledger_group_id)).toEqual([
      { account: 'A1', dr: 300_000, cr: 0 }, { account: 'A24', dr: 0, cr: 300_000 + fee }, { account: 'R1', dr: fee, cr: 0 }]);
  });

  it('400 random agreements: sa-calc-2 gives exactly the sa-calc-1 amounts, with the fixed part inside the access fee', async () => {
    for (const c of CASES) {
      const v2 = await engine(c.args);
      const v1 = c.v1!;
      expect([v2.access_fee, v2.total_repayable, v2.instalments, v2.instalment_amount], JSON.stringify(c.args))
        .toEqual([v1.access_fee + v1.registration_fee!, v1.total_repayable, v1.instalments, v1.instalment_amount]);
      expect(v2.schedule.map((r) => [r.due_date, r.amount, r.access_fee, r.principal, r.balance_after]), JSON.stringify(c.args))
        .toEqual(v1.schedule.map((r) => [r.due_date, r.amount, r.access_fee + r.registration_fee!, r.principal, r.balance_after]));
      expect(JSON.stringify(v2)).not.toMatch(/registration/);
    }
  }, 120_000);
});

describe('the constraints refuse a registration fee', () => {
  it('a repayment allocation with a registration fee is refused', async () => {
    const rep = (await q<{ id: string; adv: string }>(`select id, advance_id adv from public.special_advance_repayments limit 1`))[0];
    const e = await run(`insert into public.special_advance_repayment_allocations (repayment_id, advance_id, instalment_number, access_fee, registration_fee, principal)
      values ('${rep.id}', '${rep.adv}', 7, 0, 1, 0);`);
    expect(e?.message).toMatch(/special_advance_allocations_one_access_fee/);
  });

  it('only a sa-calc-1 agreement may hold a registration fee', async () => {
    const def = (await q<{ d: string }>(`select pg_get_constraintdef(oid) d from pg_constraint where conname = 'special_advances_one_access_fee'`))[0].d;
    expect(def).toMatch(/calc_version = 'sa-calc-1'/);
    expect(def).toMatch(/registration_fee = 0/);
  });
});

describe('the books after the change', () => {
  it('every Special Advances ledger group balances; A1, A24 and R1 add up to the postings above', async () => {
    const bad = await q(`select transaction_group_id from public.general_ledger where category like 'special\\_advance%'
                          group by 1 having sum(case when direction = 'cash_in' then amount else -amount end) <> 0`);
    expect(bad).toEqual([]);
    // SA-000001 replica: paid out 30,700 receivable, repaid 30,700; new wallet advance 30,700 outstanding;
    // external advance paid out and reversed. Fee income: 10,700 + 10,700 + 59,200 - 59,200.
    expect(await accountTotals()).toEqual([
      { account: 'A1', dr: '330700', cr: '300000' },
      { account: 'A24', dr: String(30_700 + 30_700 + 359_200), cr: String(30_700 + 359_200) },
      { account: 'L1', dr: '0', cr: '40000' },
      { account: 'R1', dr: '59200', cr: String(10_700 + 10_700 + 59_200) },
    ]);
  });
});

describe('20261103170000 rollback', () => {
  it('restores the production definitions exactly, drops the constraints, keeps every record; re-applying works', async () => {
    const kept = await history();
    expect(await run(ONE_FEE_RB)).toBeUndefined();
    expect(await fnState()).toEqual(pins(0));
    expect(await constraints()).toEqual([]);
    expect(await history()).toBe(kept);
    // the old statement shows the two stored parts again; a sa-calc-2 advance reads registration fee 0
    expect(await statement(legacy.id)).toMatchObject({ access_fee: 700, registration_fee: 10_000 });
    const newer = (await q<{ id: string }>(`select id from public.special_advances where calc_version = 'sa-calc-2' and borrower_user_id = $1`, [tenant2]))[0].id;
    expect(await statement(newer)).toMatchObject({ access_fee: 10_700, registration_fee: 0 });
    expect((await run(ONE_FEE_RB))?.message).toMatch(/precondition failed/);
    expect(await run(ONE_FEE)).toBeUndefined();
    expect(await fnState()).toEqual(pins(1));
  });
});
