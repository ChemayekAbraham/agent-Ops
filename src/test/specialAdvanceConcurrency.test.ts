// @vitest-environment node
/**
 * Special Advances readiness Phase E: concurrent requests on a REAL Postgres, each on its own connection, across
 * Phases 1-4 and A-D (payout, repayment, idempotency, provider references, corrections, write-off, provision reviews).
 * PGlite has one connection, so these races cannot be run in the other suites.
 *
 * Skipped unless SA_PG_URL points at an EMPTY, DISPOSABLE database: run `node scripts/run-special-advances-concurrency.mjs`,
 * which creates a throwaway local cluster, runs this file and deletes the cluster. Never point it at a shared database.
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


// ───────────── Phase E: true concurrency on a real Postgres (separate connections) ─────────────
// Runs only with SA_PG_URL pointing at a DISPOSABLE, empty database (scripts/run-special-advances-concurrency.mjs
// creates one in a temp folder and deletes it afterwards). Never point it at a shared or production database.
import postgres from 'postgres';

const PG_URL = process.env.SA_PG_URL;
const CORRECTIONS = MIG('20261102210000_special_advances_corrections.sql');
const IMPAIRMENT = MIG('20261102220000_special_advances_impairment_writeoff.sql');
const MEMO = MIG('20261102230000_sofp_special_advances_memo.sql');
// 2026-11-03: one access fee (sa-calc-2); the races run on the code as it will stand in production
const ONE_FEE = MIG('20261103170000_special_advances_single_access_fee.sql');
const SOFP_PROD = read('scripts/fixtures/sofp-prod-2026-11-02.sql');
const PARALLEL = 8;

type Sql = ReturnType<typeof postgres>;
let pg: Sql;
type Out<T> = { out?: T; err?: { message: string; code?: string } };

/** One request in its own connection and transaction, as `user` at `aal`, exactly as PostgREST would run it. */
async function pcall<T = Record<string, unknown>>(user: string, query: string, params: unknown[] = [], aal = 'aal2'): Promise<Out<T>> {
  try {
    const out = await pg.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: user, role: 'authenticated', aal })}, true)`;
      await tx.unsafe('set local role authenticated');
      const rows = await tx.unsafe(query, params as never[]);
      return (rows[0] as { r?: T } | undefined)?.r;
    });
    return { out: out as T };
  } catch (e) {
    return { err: e as { message: string; code?: string } };
  }
}
const pq = async <T = Record<string, unknown>>(query: string, params: unknown[] = []) => (await pg.unsafe(query, params as never[])) as unknown as T[];
const pcount = async (query: string, params: unknown[] = []) => Number((await pq<{ n: number }>(query, params))[0].n);
/** Start every request at once, each on its own connection. */
const race = <T>(n: number, f: (i: number) => Promise<Out<T>>) => Promise.all(Array.from({ length: n }, (_, i) => f(i)));
const ok = <T>(rs: Out<T>[]) => rs.filter((r) => !r.err);
const errs = <T>(rs: Out<T>[]) => rs.filter((r) => r.err).map((r) => r.err!.message);

const pApproved = async (borrower: Record<string, unknown>, terms = TERMS) => {
  const q0 = await pcall<{ schedule: { total_repayable: number } }>(cfo, `select public.special_advance_quote($1::text::jsonb) r`, [JSON.stringify({ terms })]);
  if (q0.err || !q0.out) throw new Error(`quote: ${q0.err?.message ?? JSON.stringify(q0)}`);
  const s = q0.out;
  const c = await pcall<Adv>(cfo, `select public.special_advance_create($1::text::jsonb) r`, [JSON.stringify({
    borrower, terms, purpose: 'Working capital for verified supplier stock', expected_total_repayable: s.schedule.total_repayable, idempotency_key: uuid() })]);
  if (c.err) throw new Error(c.err.message);
  const a = await pcall<Adv>(cfo, `select public.special_advance_approve($1, $2::text::timestamptz, null) r`, [c.out!.id, c.out!.updated_at]);
  if (a.err) throw new Error(a.err.message);
  return a.out!;
};
const pProof = async (advanceId: string, ext = 'pdf') => {
  const name = `advances/${advanceId}/${uuid()}.${ext}`;
  await pq(`insert into storage.objects (bucket_id, name) values ('special-advance-proofs', $1)`, [name]);
  return name;
};
const pDisburse = (a: { id: string; updated_at: string }, payout: Record<string, unknown>, user = cfo) =>
  pcall<Adv>(user, `select public.special_advance_disburse($1, $2::text::timestamptz, $3::text::jsonb) r`, [a.id, a.updated_at, JSON.stringify(payout)]);
const pRepay = async (id: string, rep: Record<string, unknown>, user = cfo) =>
  pcall<Adv>(user, `select public.special_advance_record_repayment($1, $2::text::jsonb) r`, [id, JSON.stringify({
    idempotency_key: uuid(), method: 'mobile_money', received_date: today(),
    ...('proof_path' in rep ? {} : { proof_path: await pProof(id) }), ...rep })]);
const pRecon = async () => (await pcall<{ balanced: boolean; difference: number; allowance_difference: number }>(cfo, `select public.special_advance_reconciliation() r`)).out!;
const pNewTenant = async () => {
  const u = uuid();
  await pq(`insert into auth.users values ($1)`, [u]);
  await pq(`insert into public.profiles (id, full_name) values ($1, 'Person')`, [u]);
  await pq(`insert into public.user_roles (user_id, role) values ($1, 'tenant')`, [u]);
  return u;
};
const pPaidOut = async (terms = TERMS) => (await pDisburse(await pApproved({ kind: 'welile_user', user_id: await pNewTenant() }, terms), { payout_date: today(), method: 'wallet' })).out!;

const describeIfDb = PG_URL ? describe : describe.skip;

describeIfDb('Phase E: concurrent requests on a real Postgres (separate connections)', () => {
  beforeAll(async () => {
    pg = postgres(PG_URL!, { max: PARALLEL + 4, onnotice: () => {} });
    const [{ n }] = await pq<{ n: number }>(`select count(*)::int n from pg_tables where schemaname = 'public'`);
    if (n !== 0) throw new Error('SA_PG_URL must be an EMPTY, disposable database');
    await pg.unsafe(STANDINS);
    await pg.unsafe('set check_function_bodies = off;\n' + HELPERS + '\n' + REAL.join('\n') + '\n' + TRIGGER_VALIDATOR_ALLOWLIST + '\nset check_function_bodies = on;');
    await pg.unsafe(`create trigger trg_validate_ledger_category before insert on public.general_ledger for each row execute function public.validate_ledger_category();
      insert into public.ledger_account_catalog (code, label, section, nature, sort_order) values ('X4', 'Credit Losses and Write-offs', 'expense', 'expense', 40);`);
    for (const u of users) {
      await pq(`insert into auth.users values ($1)`, [u]);
      await pq(`insert into public.profiles (id, full_name) values ($1, 'Person')`, [u]);
    }
    await pq(`insert into public.user_roles (user_id, role) values ($1,'cfo'), ($2,'coo'), ($3,'super_admin'), ($4,'tenant'), ($5,'tenant'), ($6,'agent')`, users);
    await pg.unsafe(ENGINE);
    for (const m of [STORAGE, FUNCTIONS, PAYOUT, POSITION, CORRECTIONS, IMPAIRMENT, ONE_FEE]) await pg.begin((tx) => tx.unsafe(m));
    // Phase D needs the statement's other inputs; production's statement and resolver are loaded verbatim
    await pg.unsafe(`create function public.has_role(p_user uuid, p_role text) returns boolean language sql stable as
        $f$ select exists (select 1 from public.user_roles where user_id = p_user and role = p_role and enabled) $f$;
      create table public.merchandise_recovery_plans (id uuid primary key, item_name text);
      create function public.agent_product_category(text) returns text language sql immutable as $f$ select 'other'::text $f$;
      alter table public.agent_advances add column arrears_balance numeric default 0, add column created_at timestamptz default now();
      alter table public.business_advances add column created_at timestamptz default now();
      alter table public.wallets add column locked_balance numeric default 0, add column float_balance numeric default 0;
      create table public.rent_requests (total_repayment numeric, amount_repaid numeric, status text, created_at timestamptz default now());
      create table public.credit_access_draws (outstanding_balance numeric, status text, created_at timestamptz default now());
      create table public.merchandise_sales (amount_outstanding numeric, created_at timestamptz default now());
      create table public.promissory_notes (amount numeric, total_collected numeric, status text, created_at timestamptz default now());
      create table public.investor_portfolios (investment_amount numeric, status text, created_at timestamptz default now());
      create table public.landlord_payouts (amount numeric, status text, created_at timestamptz default now());`);
    await pg.unsafe(SOFP_PROD);
    await pg.begin((tx) => tx.unsafe(MEMO));
    await pq(`update public.special_advance_settings set issuance_enabled = true`);
  }, 180_000);
  afterAll(async () => { await pg?.end({ timeout: 5 }); });

  it('the same payout sent 8 times at once posts once: one ledger group, one wallet credit', async () => {
    const a = await pApproved({ kind: 'welile_user', user_id: await pNewTenant() });
    const rs = await race(PARALLEL, () => pDisburse(a, { payout_date: today(), method: 'wallet' }));
    expect(ok(rs)).toHaveLength(1);
    expect(new Set(errs(rs).map((m) => m.match(/STALE_VERSION|SPECIAL_ADVANCE_ALREADY_PAID_OUT|SPECIAL_ADVANCE_NOT_APPROVED/)?.[0]))).not.toContain(undefined);
    expect(await pcount(`select count(distinct transaction_group_id)::int n from public.general_ledger where source_id = $1`, [a.id])).toBe(1);
    expect(await pcount(`select count(*)::int n from public.wallet_movements m join public.special_advances s on s.borrower_user_id = m.user_id where s.id = $1`, [a.id])).toBe(1);
  });

  it('8 simultaneous repayments that together exceed the balance: what is recorded never exceeds it', async () => {
    const a = await pPaidOut(); // 940,000 outstanding
    const rs = await race(PARALLEL, (i) => pRepay(a.id, { amount: 200_000, reference: `MM-RACE-${i}` }));
    expect(ok(rs)).toHaveLength(4);                                   // 4 x 200,000 = 800,000 fits; the 5th would not
    expect(errs(rs).every((m) => /OVERPAYMENT_REFUSED/.test(m))).toBe(true);
    expect(await pcount(`select coalesce(sum(amount),0)::int n from public.special_advance_repayments where advance_id = $1`, [a.id])).toBe(800_000);
    expect(await pRecon()).toMatchObject({ balanced: true, difference: 0 });
  });

  it('the same repayment request (same key) sent 8 times at once is recorded once; the others replay', async () => {
    const a = await pPaidOut();
    const body = { idempotency_key: uuid(), method: 'mobile_money', received_date: today(), amount: 50_000, reference: 'MM-SAMEKEY-1', proof_path: await pProof(a.id) };
    const rs = await race(PARALLEL, () => pcall<Adv>(cfo, `select public.special_advance_record_repayment($1, $2::text::jsonb) r`, [a.id, JSON.stringify(body)]));
    expect(ok(rs)).toHaveLength(PARALLEL);
    expect(rs.filter((r) => r.out?.replayed === true)).toHaveLength(PARALLEL - 1);
    expect(await pcount(`select count(*)::int n from public.special_advance_repayments where advance_id = $1`, [a.id])).toBe(1);
    expect(await pcount(`select count(distinct transaction_group_id)::int n from public.general_ledger where source_table = 'special_advance_repayments' and reference_id = $1`, [a.reference])).toBe(1);
  });

  it('one provider reference sent 8 times at once with different keys is booked once', async () => {
    const a = await pPaidOut();
    const rs = await race(PARALLEL, () => pRepay(a.id, { amount: 10_000, reference: 'MM-SAMEREF-1' }));
    expect(ok(rs)).toHaveLength(1);
    expect(errs(rs).every((m) => /REPAYMENT_REFERENCE_ALREADY_RECORDED|duplicate key/.test(m))).toBe(true);
    expect(await pcount(`select count(*)::int n from public.special_advance_repayments where reference = 'MM-SAMEREF-1'`)).toBe(1);
  });

  it('8 simultaneous corrections of one repayment (different keys) post exactly once; the same key 8 times posts once', async () => {
    const a = await pPaidOut();
    await pRepay(a.id, { amount: 100_000, reference: 'MM-CORR-RACE' });
    await pRepay(a.id, { amount: 50_000, reference: 'MM-CORR-RACE-2' });
    const rep = (await pq<{ id: string }>(`select id from public.special_advance_repayments where reference = 'MM-CORR-RACE'`))[0].id;
    const post = async (key: string, repayment: string, proofPath?: string) =>
      pcall<{ id: string; replayed: boolean }>(cfo, `select public.special_advance_record_correction($1, $2::text::jsonb) r`, [a.id, JSON.stringify({
        kind: 'repayment_reversal', repayment_id: repayment, reason: 'Recorded against the wrong advance; statement attached',
        proof_path: proofPath ?? await pProof(a.id), idempotency_key: key })]);
    const rs = await race(PARALLEL, () => post(uuid(), rep));
    expect(ok(rs)).toHaveLength(1);
    expect(errs(rs).every((m) => /REPAYMENT_ALREADY_REVERSED|duplicate key/.test(m))).toBe(true);
    const id = ok(rs)[0].out!.id;
    expect(await pcount(`select count(distinct transaction_group_id)::int n from public.general_ledger where source_table = 'special_advance_corrections' and source_id = $1`, [id])).toBe(1);
    // one request retried 8 times at once (same key, same proof): one posting, the rest replay it
    const rep2 = (await pq<{ id: string }>(`select id from public.special_advance_repayments where reference = 'MM-CORR-RACE-2'`))[0].id;
    const key = uuid(); const proofPath = await pProof(a.id);
    const same = await race(PARALLEL, () => post(key, rep2, proofPath));
    expect(ok(same)).toHaveLength(PARALLEL);
    expect(same.filter((r) => r.out?.replayed === false)).toHaveLength(1);
    expect(await pcount(`select count(*)::int n from public.special_advance_corrections where repayment_id = $1`, [rep2])).toBe(1);
    expect(await pRecon()).toMatchObject({ balanced: true, difference: 0 });
  });

  it('a repayment racing a write-off: either the write-off is refused as stale or the repayment is refused; the books tie', async () => {
    const a = await pPaidOut();
    const gross = (await pcall<{ position: { outstanding: number } }>(cfo, `select public.special_advance_statement($1) r`, [a.id])).out!.position.outstanding;
    const [woProof, rpProof] = [await pProof(a.id), await pProof(a.id)];
    const [wo, rp] = await Promise.all([
      pcall<{ id: string }>(cfo, `select public.special_advance_write_off($1, $2::text::jsonb) r`, [a.id, JSON.stringify({
        reason: 'Borrower unreachable for 120 days; demand letters returned', proof_path: woProof, idempotency_key: uuid(),
        expected_gross_amount: gross })]),
      pcall<Adv>(cfo, `select public.special_advance_record_repayment($1, $2::text::jsonb) r`, [a.id, JSON.stringify({
        idempotency_key: uuid(), method: 'mobile_money', received_date: today(), amount: 5_000, reference: 'MM-WO-RACE', proof_path: rpProof })])]);
    const exactlyOne = (!wo.err && !!rp.err && /SPECIAL_ADVANCE_NOT_REPAYABLE/.test(rp.err.message))
                    || (!rp.err && !!wo.err && /WRITE_OFF_STALE/.test(wo.err.message));
    expect(exactlyOne, JSON.stringify({ wo: wo.err?.message ?? 'ok', rp: rp.err?.message ?? 'ok' })).toBe(true);
    expect(await pRecon()).toMatchObject({ balanced: true, difference: 0, allowance_difference: 0 });
  });

  it('8 simultaneous provision postings (different keys) post exactly once; the others find nothing left to post', async () => {
    await pPaidOut();
    await pq(`CREATE OR REPLACE FUNCTION public._special_advance_kampala_today() RETURNS date LANGUAGE sql STABLE SET search_path = public AS
      $f$ SELECT (now() AT TIME ZONE 'Africa/Kampala')::date + 40 $f$`);
    try {
      const preview = (await pcall<{ total_delta: number }>(cfo, `select public.special_advance_provision_preview('{}'::jsonb) r`)).out!;
      const rs = await race(PARALLEL, () => pcall<{ id: string }>(cfo, `select public.special_advance_post_provision_review($1::text::jsonb) r`,
        [JSON.stringify({ individual_rates: {}, idempotency_key: uuid(), expected_total_delta: preview.total_delta })]));
      expect(ok(rs)).toHaveLength(1);
      expect(errs(rs).every((m) => /NOTHING_TO_PROVISION|PROVISION_REVIEW_STALE/.test(m))).toBe(true);
      const id = ok(rs)[0].out!.id;
      expect(await pcount(`select count(distinct gl.transaction_group_id)::int n from public.general_ledger gl
                             join public.special_advance_provision_lines l on l.id = gl.source_id where l.review_id = $1`, [id]))
        .toBe(await pcount(`select count(*)::int n from public.special_advance_provision_lines where review_id = $1 and delta <> 0`, [id]));
      expect(await pRecon()).toMatchObject({ balanced: true, allowance_difference: 0 });
    } finally {
      await pq(`CREATE OR REPLACE FUNCTION public._special_advance_kampala_today() RETURNS date LANGUAGE sql STABLE SET search_path = public AS
        $f$ SELECT (now() AT TIME ZONE 'Africa/Kampala')::date $f$`);
    }
  });

  it('after every race: each Special Advances ledger group balances raw and on the mapping, and the statement memo ties to the ledger', async () => {
    const bad = await pq(`
      select gl.transaction_group_id g,
             sum(case when gl.direction='cash_in' then gl.amount else -gl.amount end) raw,
             sum(case when gl.direction = coalesce(ms.debit_when, ma.debit_when) then gl.amount else -gl.amount end) mapped
        from public.general_ledger gl
        left join public.ledger_account_map ms on ms.ledger_scope=gl.ledger_scope and ms.category=gl.category and ms.wallet_bucket=gl.wallet_bucket
        left join public.ledger_account_map ma on ma.ledger_scope=gl.ledger_scope and ma.category=gl.category and ma.wallet_bucket is null
       where gl.category like 'special\\_advance%'
       group by 1 having sum(case when gl.direction='cash_in' then gl.amount else -gl.amount end) <> 0
                       or sum(case when gl.direction = coalesce(ms.debit_when, ma.debit_when) then gl.amount else -gl.amount end) <> 0`);
    expect(bad).toEqual([]);
    expect(await pRecon()).toMatchObject({ balanced: true, difference: 0, allowance_difference: 0 });
    const st = (await pcall<{ assets: { current: Array<{ source: string; value: number }> }; reconciliation: { memo_sub_ledgers: Array<{ label: string; value: number }> } }>(
      cfo, `select public.get_statement_of_financial_position(now() + interval '100 days') r`)).out!;
    const a24 = Number(st.assets.current.find((l) => l.source.endsWith('account A24'))!.value);
    expect(Number(st.reconciliation.memo_sub_ledgers.find((m) => m.label === 'Special Advances outstanding (paid out)')!.value)).toBe(a24);
  });
});
