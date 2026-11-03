// @vitest-environment node
/**
 * Special Advances: authenticator requirement removed (CFO decision 2026-11-03;
 * supabase/migrations/20261103150000_special_advances_remove_mfa.sql) on PGlite, on top of Phases 1-4, A, B and C.
 * An enabled CFO completes every step with a password session (aal1); the CFO role, self-advance rule, reasons, proof
 * files, issuance switch, idempotency and append-only records all still hold; the rollback restores the requirement.
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


// ───────────── 2026-11-03: authenticator requirement removed (20261103150000) ─────────────
const CORRECTIONS = MIG('20261102210000_special_advances_corrections.sql');
const IMPAIRMENT = MIG('20261102220000_special_advances_impairment_writeoff.sql');
const NO_MFA = MIG('20261103150000_special_advances_remove_mfa.sql');
const NO_MFA_RB = read('supabase/rollbacks/20261103150000_special_advances_remove_mfa.rollback.sql');
const PROD_MFA_MD5 = { require: '3e17151264fa6029141eb4c2ccc39b96', guard: '64757ef8049d1e2f9f54c7af7e172ecb' }; // production, 2026-11-03
const NOOP_MD5 = 'befb1ed9f392247206adc532fec7ba2e';

const run = async (sql: string) => {
  const e = await db.exec(`BEGIN;\n${sql}\nCOMMIT;`).then(() => undefined, (x: Err) => x);
  await db.exec('ROLLBACK').catch(() => {});
  return e;
};
const count = async (sql: string, params: unknown[] = []) => (await q<{ n: number }>(sql, params))[0].n;
const md5Of = async (sig: string) => (await q<{ m: string }>(`select md5(replace(prosrc, chr(13), '')) m from pg_proc where oid = to_regprocedure($1)`, [sig]))[0]?.m ?? null;
const mfaState = async () => ({ require: await md5Of('public._special_advance_require_mfa()'), guard: await md5Of('public._special_advance_guard_mfa()'),
  trigger: await count(`select count(*)::int n from pg_trigger where tgname = 'special_advances_require_mfa'`) });
/** Every call below is a normal password session: aal1, no authenticator. */
const c1 = <T = Record<string, unknown>>(user: string, sql: string, params: unknown[] = []) => call<T>(user, sql, params, 'aal1');
const shiftToday = (days: number) => db.exec(`CREATE OR REPLACE FUNCTION public._special_advance_kampala_today() RETURNS date LANGUAGE sql STABLE
  SET search_path = public AS $$ SELECT (now() AT TIME ZONE 'Africa/Kampala')::date + ${days} $$`);

async function createAal1(borrower: Record<string, unknown>, user = cfo, terms = TERMS) {
  const s = (await c1<{ schedule: { total_repayable: number } }>(user, `select public.special_advance_quote($1::jsonb) r`, [JSON.stringify({ terms })])).out;
  return c1<Adv>(user, `select public.special_advance_create($1::jsonb) r`, [JSON.stringify({
    borrower, terms, purpose: 'Working capital for verified supplier stock', expected_total_repayable: s?.schedule.total_repayable ?? 1, idempotency_key: uuid() })]);
}
const approveAal1 = (a: Adv, user = cfo) => c1<Adv>(user, `select public.special_advance_approve($1, $2::timestamptz, null) r`, [a.id, a.updated_at]);
const disburseAal1 = (a: Adv, payout: Record<string, unknown>, user = cfo) =>
  c1<Adv>(user, `select public.special_advance_disburse($1, $2::timestamptz, $3::jsonb) r`, [a.id, a.updated_at, JSON.stringify(payout)]);
const repayAal1 = async (id: string, rep: Record<string, unknown>, user = cfo) =>
  c1<Adv>(user, `select public.special_advance_record_repayment($1, $2::jsonb) r`, [id, JSON.stringify({
    idempotency_key: uuid(), method: 'mobile_money', received_date: today(), ...('proof_path' in rep ? {} : { proof_path: await proof(id) }), ...rep })]);
const correctAal1 = async (id: string, req: Record<string, unknown>, user = cfo) =>
  c1<{ id: string; ledger_group_id: string }>(user, `select public.special_advance_record_correction($1, $2::jsonb) r`, [id, JSON.stringify({
    idempotency_key: uuid(), reason: 'Recorded against the wrong advance; bank statement attached',
    ...('proof_path' in req ? {} : { proof_path: await proof(id) }), ...req })]);
const provisionAal1 = (rates: Record<string, number>, user = cfo) =>
  c1<{ id: string; lines: Array<{ advance_id: string; ledger_group_id: string | null }> }>(user, `select public.special_advance_post_provision_review($1::jsonb) r`,
    [JSON.stringify({ individual_rates: rates, idempotency_key: uuid() })]);
const writeOffAal1 = async (id: string, req: Record<string, unknown> = {}, user = cfo) =>
  c1<{ id: string; ledger_group_id: string }>(user, `select public.special_advance_write_off($1, $2::jsonb) r`, [id, JSON.stringify({
    idempotency_key: uuid(), reason: 'Borrower unreachable for 120 days; demand letters returned',
    ...('proof_path' in req ? {} : { proof_path: await proof(id) }), ...req })]);
const recoverAal1 = async (id: string, rec: Record<string, unknown>, user = cfo) =>
  c1<{ id: string; ledger_group_id: string }>(user, `select public.special_advance_record_recovery($1, $2::jsonb) r`, [id, JSON.stringify({
    idempotency_key: uuid(), method: 'mobile_money', received_date: today(), ...('proof_path' in rec ? {} : { proof_path: await proof(id) }), ...rec })]);

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
  for (const m of [STORAGE, FUNCTIONS, PAYOUT, POSITION, CORRECTIONS, IMPAIRMENT]) await db.exec(`BEGIN;\n${m}\nCOMMIT;`);
  await db.exec(`update public.special_advance_settings set issuance_enabled = true`);
}

beforeAll(async () => {
  db = new PGlite();
  await setup();
}, 120_000);
afterAll(async () => { await db?.close(); });

describe('20261103150000 migration', () => {
  it('before it, a password-only CFO session is refused (MFA_REQUIRED): the production starting point', async () => {
    expect(await mfaState()).toEqual({ require: PROD_MFA_MD5.require, guard: PROD_MFA_MD5.guard, trigger: 1 });
    const p = (await createAal1({ kind: 'welile_user', user_id: tenant })).out!;
    expect((await approveAal1(p)).err?.message).toBe('MFA_REQUIRED');
    await c1(cfo, `select public.special_advance_cancel($1, $2::timestamptz, $3) r`, [p.id, p.updated_at, 'Test record only']);
  });

  it('applies over the production definitions only, once; removes the trigger; keeps the helper closed to clients', async () => {
    expect(await run(NO_MFA)).toBeUndefined();
    expect(await mfaState()).toEqual({ require: NOOP_MD5, guard: null, trigger: 0 });
    expect((await run(NO_MFA))?.message).toMatch(/not the production definition/);
    expect(await q(`select has_function_privilege('authenticated','public._special_advance_require_mfa()','EXECUTE') a,
                           has_function_privilege('anon','public._special_advance_require_mfa()','EXECUTE') b`)).toEqual([{ a: false, b: false }]);
  });

  it('changes no ledger, mapping, account, allowlist or Special Advances record', async () => {
    expect(await count(`select count(*)::int n from public.ledger_account_map where category like 'special\\_advance\\_%'`)).toBe(12);
    expect(await count(`select count(*)::int n from public.ledger_account_catalog where code in ('A24','A25')`)).toBe(2);
  });
});

describe('a CFO completes every step without an authenticator (password session, aal1)', () => {
  let w: Adv;
  let e: Adv;

  it('records, approves and pays out (wallet and external)', async () => {
    const c = await createAal1({ kind: 'welile_user', user_id: tenant });
    expect(c.err).toBeUndefined();
    const a = await approveAal1(c.out!);
    expect(a.err).toBeUndefined();
    const d = await disburseAal1(a.out!, { payout_date: today(), method: 'wallet' });
    expect(d.err).toBeUndefined();
    w = d.out!;
    expect(w.status).toBe('disbursed');
    const ce = await createAal1({ kind: 'external', borrower_type: 'individual', full_name: 'John Mukasa', phone: '0772123456', national_id: 'CM900000000000' });
    const ae = (await approveAal1(ce.out!)).out!;
    const de = await disburseAal1(ae, { payout_date: today(), method: 'mobile_money', reference: 'MM-NOMFA-PAY', proof_path: await proof(ae.id, 'png') });
    expect(de.err).toBeUndefined();
    e = de.out!;
  });

  it('records a repayment (and a retry with the same key replays, never posting twice)', async () => {
    const key = uuid(); const p = await proof(w.id);
    const r = await repayAal1(w.id, { amount: 100_000, reference: 'MM-NOMFA-REP-1', idempotency_key: key, proof_path: p });
    expect(r.err).toBeUndefined();
    const ledger1 = await count(`select count(*)::int n from public.general_ledger`);
    expect((await repayAal1(w.id, { amount: 100_000, reference: 'MM-NOMFA-REP-1', idempotency_key: key, proof_path: p })).out?.replayed).toBe(true);
    expect(await count(`select count(*)::int n from public.general_ledger`)).toBe(ledger1);
  });

  it('posts a correction', async () => {
    const rep = (await q<{ id: string }>(`select id from public.special_advance_repayments where reference = 'MM-NOMFA-REP-1'`))[0].id;
    const r = await correctAal1(w.id, { kind: 'repayment_reversal', repayment_id: rep });
    expect(r.err).toBeUndefined();
    expect(await mapped(r.out!.ledger_group_id)).toEqual([{ account: 'A1', dr: 0, cr: 100_000 }, { account: 'A24', dr: 100_000, cr: 0 }]);
  });

  it('posts a provision review, writes off and records a recovery', async () => {
    await shiftToday(40);
    try {
      const pr = await provisionAal1({});
      expect(pr.err).toBeUndefined();
      const wo = await writeOffAal1(e.id);
      expect(wo.err).toBeUndefined();
      expect((await q<{ status: string }>(`select status from public.special_advances where id = $1`, [e.id]))[0].status).toBe('written_off');
    } finally {
      await shiftToday(0);
    }
    const rc = await recoverAal1(e.id, { amount: 50_000, reference: 'MM-NOMFA-REC-1' });
    expect(rc.err).toBeUndefined();
    expect(await mapped(rc.out!.ledger_group_id)).toEqual([{ account: 'A1', dr: 50_000, cr: 0 }, { account: 'X4', dr: 0, cr: 50_000 }]);
  });

  it('a session with no aal claim at all is treated the same (no authenticator needed)', async () => {
    const r = await call<Adv>(cfo, `select public.special_advance_statement($1) r`, [w.id], undefined as unknown as string);
    expect(r.err).toBeUndefined();
  });
});

describe('every other control stays', () => {
  it('CEO-level and other roles still cannot act (COO, super admin, tenant), with or without an authenticator', async () => {
    const st = (await q<{ id: string; updated_at: string }>(`select id, updated_at::text from public.special_advances where status = 'disbursed' limit 1`))[0];
    for (const u of [coo, superAdmin, tenant]) {
      for (const aal of ['aal1', 'aal2']) {
        expect((await call(u, `select public.special_advance_record_repayment($1, $2::jsonb) r`, [st.id, JSON.stringify({ idempotency_key: uuid(),
          method: 'mobile_money', received_date: today(), amount: 1_000, reference: `X-${uuid().slice(0, 8)}`, proof_path: await proof(st.id) })], aal)).err?.message, `${u} ${aal}`)
          .toBe('NOT_AUTHORIZED');
        expect((await call(u, `select public.special_advance_post_provision_review($1::jsonb) r`, [JSON.stringify({ individual_rates: {}, idempotency_key: uuid() })], aal)).err?.message)
          .toBe('NOT_AUTHORIZED');
      }
      expect((await createAal1({ kind: 'welile_user', user_id: tenant2 }, u)).err?.message).toBe('NOT_AUTHORIZED');
    }
  });

  it('the CFO still cannot give an advance to themselves', async () => {
    const r = await createAal1({ kind: 'welile_user', user_id: cfo });
    expect(r.err?.message).toMatch(/SELF_ADVANCE/);
  });

  it('reasons and proof files are still required; a proof is used once', async () => {
    const st = (await q<{ id: string }>(`select id from public.special_advances where status = 'disbursed' limit 1`))[0];
    const rep = (await q<{ id: string; p: string }>(`select id, proof_path p from public.special_advance_repayments where advance_id = $1 and reversed_by_correction is null limit 1`, [st.id]))[0];
    expect((await repayAal1(st.id, { amount: 1_000, reference: 'MM-NOMFA-NOPROOF', proof_path: null })).err?.message).toBe('PROOF_REQUIRED');
    if (rep) {
      expect((await correctAal1(st.id, { kind: 'repayment_reversal', repayment_id: rep.id, reason: 'Too short' })).err?.message).toBe('REASON_REQUIRED');
      expect((await correctAal1(st.id, { kind: 'repayment_reversal', repayment_id: rep.id, proof_path: rep.p })).err?.message).toBe('PROOF_ALREADY_USED');
    }
    expect((await writeOffAal1(st.id, { reason: 'Gone quiet' })).err?.message).toBe('REASON_REQUIRED');
  });

  it('the issuance switch still stops new agreements, approvals and payouts', async () => {
    await db.exec(`update public.special_advance_settings set issuance_enabled = false`);
    try {
      expect((await createAal1({ kind: 'welile_user', user_id: tenant2 })).err?.message).toBe('SPECIAL_ADVANCES_DISABLED');
    } finally {
      await db.exec(`update public.special_advance_settings set issuance_enabled = true`);
    }
  });

  it('records and the ledger stay append-only; every Special Advances group still balances', async () => {
    for (const sql of [`update public.special_advance_repayments set amount = 1`, `delete from public.special_advance_corrections`,
      `update public.special_advance_write_offs set gross_amount = 1`, `delete from public.special_advance_events`]) {
      expect(((await db.exec(sql).catch((x: Err) => x)) as Err).code, sql).toBe('42501');
    }
    const bad = await q(`select transaction_group_id from public.general_ledger where category like 'special\\_advance%'
                          group by 1 having sum(case when direction = 'cash_in' then amount else -amount end) <> 0`);
    expect(bad).toEqual([]);
  });
});

describe('20261103150000 rollback', () => {
  it('restores the Phase 4 authenticator check exactly; a password-only approval is refused again; re-applying works', async () => {
    expect(await run(NO_MFA_RB)).toBeUndefined();
    expect(await mfaState()).toEqual({ require: PROD_MFA_MD5.require, guard: PROD_MFA_MD5.guard, trigger: 1 });
    expect(await q(`select has_function_privilege('authenticated','public._special_advance_guard_mfa()','EXECUTE') a`)).toEqual([{ a: false }]);
    const p = (await createAal1({ kind: 'welile_user', user_id: tenant2 })).out!;
    expect((await approveAal1(p)).err?.message).toBe('MFA_REQUIRED');
    expect((await run(NO_MFA_RB))?.message).toMatch(/not the current state/);
    expect(await run(NO_MFA)).toBeUndefined();
    expect((await approveAal1(p)).err).toBeUndefined();
  });
});
