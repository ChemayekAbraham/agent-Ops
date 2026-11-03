// @vitest-environment node
/**
 * Special Advances readiness Phase D: Special Advances in the balance sheet's memo of operational sub-ledgers
 * (supabase/migrations/20261102230000_sofp_special_advances_memo.sql), CFO decision D12 (2026-11-02).
 *
 * Runs production's statement of financial position and its resolver verbatim (scripts/fixtures/sofp-prod-2026-11-02.sql)
 * over a ledger with paid-out, part-repaid and provisioned Special Advances, and proves the migration only appends the
 * comparison lines. Same real ledger code and stand-ins as specialAdvancePayout.test.ts.
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


// ───────────── Phase D: Special Advances in the balance-sheet memo ─────────────
const CORRECTIONS = MIG('20261102210000_special_advances_corrections.sql');
const IMPAIRMENT = MIG('20261102220000_special_advances_impairment_writeoff.sql');
const MEMO = MIG('20261102230000_sofp_special_advances_memo.sql');
const MEMO_RB = read('supabase/rollbacks/20261102230000_sofp_special_advances_memo.rollback.sql');
// production's resolver and statement of financial position, verbatim (read-only export 2026-11-02)
const SOFP_PROD = read('scripts/fixtures/sofp-prod-2026-11-02.sql');
const SOFP_PROD_MD5 = '2ee44b04b0dd9f383116d3d218881c53';
const SOFP_SIG = 'public.get_statement_of_financial_position(timestamptz)';
const cfo2 = uuid();

// what the statement reads besides the ledger and the chart (columns as it uses them)
const SOFP_STANDINS = `
create function public.has_role(p_user uuid, p_role text) returns boolean language sql stable as
  $$ select exists (select 1 from public.user_roles where user_id = p_user and role = p_role and enabled) $$;
create table public.merchandise_recovery_plans (id uuid primary key, item_name text);
create function public.agent_product_category(text) returns text language sql immutable as $$ select 'other'::text $$;
alter table public.agent_advances add column arrears_balance numeric default 0, add column created_at timestamptz default now();
alter table public.business_advances add column created_at timestamptz default now();
alter table public.wallets add column locked_balance numeric default 0, add column float_balance numeric default 0;
create table public.rent_requests (total_repayment numeric, amount_repaid numeric, status text, created_at timestamptz default now());
create table public.credit_access_draws (outstanding_balance numeric, status text, created_at timestamptz default now());
create table public.merchandise_sales (amount_outstanding numeric, created_at timestamptz default now());
create table public.promissory_notes (amount numeric, total_collected numeric, status text, created_at timestamptz default now());
create table public.investor_portfolios (investment_amount numeric, status text, created_at timestamptz default now());
create table public.landlord_payouts (amount numeric, status text, created_at timestamptz default now());
insert into public.rent_requests values (1000, 400, 'repaying', now()); -- one existing memo figure that must not move
`;

type Line = { label: string; value: number; source: string };
type Sofp = { assets: { current: Line[]; total: number }; liabilities: { total: number }; equity: { total: number };
  trial_balance: { total_debits: number; total_credits: number }; balance_check: { difference: number; balanced: boolean };
  reconciliation: { memo_sub_ledgers: Line[] } & Record<string, unknown>; generated_at?: string };

const run = async (sql: string) => {
  const e = await db.exec(`BEGIN;\n${sql}\nCOMMIT;`).then(() => undefined, (x: Err) => x);
  await db.exec('ROLLBACK').catch(() => {});
  return e;
};
const md5Of = async (sig: string) => (await q<{ m: string }>(`select md5(replace(prosrc, chr(13), '')) m from pg_proc where oid = $1::regprocedure`, [sig]))[0]?.m;
const AS_AT = new Date(Date.now() + 86_400_000).toISOString(); // one fixed cut-off, so repeated statements compare exactly
const sofp = async (user = cfo) => call<Sofp>(user, `select public.get_statement_of_financial_position($1::timestamptz) r`, [AS_AT]);
const strip = (s: Sofp) => { const { generated_at, ...rest } = s; void generated_at; return rest; };
const memoSA = (s: Sofp) => s.reconciliation.memo_sub_ledgers.filter((m) => m.label.startsWith('Special Advances'));
const account = (s: Sofp, code: string) => s.assets.current.find((l) => l.source.endsWith(`account ${code}`))?.value ?? 0;

async function setup(withImpairment: boolean) {
  await db.exec(STANDINS);
  await db.exec('set check_function_bodies = off;\n' + HELPERS + '\n' + REAL.join('\n') + '\n' + TRIGGER_VALIDATOR_ALLOWLIST + '\nset check_function_bodies = on;');
  await db.exec(`create trigger trg_validate_ledger_category before insert on public.general_ledger for each row execute function public.validate_ledger_category();`);
  await db.exec(`insert into public.ledger_account_catalog (code, label, section, nature, sort_order) values ('X4', 'Credit Losses and Write-offs', 'expense', 'expense', 40)`);
  for (const u of [...users, cfo2]) {
    await db.query(`insert into auth.users values ($1)`, [u]);
    await db.query(`insert into public.profiles (id, full_name) values ($1, 'Person')`, [u]);
  }
  await db.query(`insert into public.user_roles (user_id, role) values ($1,'cfo'), ($2,'coo'), ($3,'super_admin'), ($4,'tenant'), ($5,'tenant'), ($6,'agent')`, users);
  await db.query(`insert into public.user_roles (user_id, role) values ($1,'cfo')`, [cfo2]);
  await db.exec(ENGINE);
  for (const m of [STORAGE, FUNCTIONS, PAYOUT, POSITION, CORRECTIONS, ...(withImpairment ? [IMPAIRMENT] : [])]) await db.exec(`BEGIN;\n${m}\nCOMMIT;`);
  await db.exec(SOFP_STANDINS);
  await db.exec(SOFP_PROD);
  await db.exec(`update public.special_advance_settings set issuance_enabled = true`);
  // a paid-out Welile advance (940,000) part repaid, an external one (365,000) and an approved unpaid one
  const w = (await disburse(await approved({ kind: 'welile_user', user_id: tenant }), { payout_date: today(), method: 'wallet' })).out!;
  await repay(w, { amount: 200_000, reference: 'MM-MEMO-0001' });
  const e = await approved({ kind: 'external', borrower_type: 'individual', full_name: 'John Mukasa', phone: '0772123456', national_id: 'CM900000000000' },
    { principal: 300_000, rate_percent: 15, rate_basis: 'monthly', term_days: 30, frequency: 'monthly' });
  await disburse(e, { payout_date: today(), method: 'mobile_money', reference: 'MM-PAY-MEMO', proof_path: await proof(e.id, 'png') });
  await approved({ kind: 'welile_user', user_id: tenant2 });
  if (withImpairment) { // an approved provision review: 60% individual rate on the Welile advance (444,000 of 740,000)
    const r = (await call<{ id: string }>(cfo, `select public.special_advance_request_provision_review($1::jsonb) r`,
      [JSON.stringify({ individual_rates: { [w.id]: 60 }, idempotency_key: uuid() })])).out!;
    await call(cfo2, `select public.special_advance_decide_provision_review($1, 'approve', null) r`, [r.id]);
  }
}

beforeAll(async () => {
  db = new PGlite();
  await setup(true);
}, 120_000);
afterAll(async () => { await db?.close(); });

describe('Phase D: Special Advances memo lines on the statement of financial position (D12)', () => {
  let before: Sofp;

  it('starts from the production statement (fixture fingerprint); its A24 line already shows the receivable', async () => {
    expect(await md5Of(SOFP_SIG)).toBe(SOFP_PROD_MD5);
    const r = await sofp();
    expect(r.err).toBeUndefined();
    before = r.out!;
    expect(account(before, 'A24')).toBe(740_000 + 365_000);
    expect(account(before, 'A25')).toBe(-444_000);
    expect(memoSA(before)).toEqual([]);
  });

  it('applies over the production definition only; a second run is refused', async () => {
    expect(await run(MEMO)).toBeUndefined();
    expect((await run(MEMO))?.message).toMatch(/already exists/);
  });

  it('adds the three comparison lines and changes nothing else: every balance, total and existing memo figure is identical', async () => {
    const after = (await sofp()).out!;
    const { memo_sub_ledgers: m0, ...rec0 } = before.reconciliation;
    const { memo_sub_ledgers: m1, ...rec1 } = after.reconciliation;
    expect({ ...strip(after), reconciliation: rec1 }).toEqual({ ...strip(before), reconciliation: rec0 });
    expect(m1.slice(0, m0.length)).toEqual(m0);
    expect(m1.slice(m0.length)).toEqual([
      { label: 'Special Advances outstanding (paid out)', value: 1_105_000, source: 'operational sub-ledger — compare against ledger account A24' },
      { label: 'Special Advances impairment allowance (comparison)', value: 444_000, source: 'operational sub-ledger — compare against ledger account A25' },
      { label: 'Special Advances net receivable (comparison)', value: 661_000, source: 'operational sub-ledger — compare against ledger accounts A24 less A25' }]);
  });

  it('the memo ties to the ledger lines and to the Special Advances reconciliation; the approved, unpaid advance is not counted', async () => {
    const after = (await sofp()).out!;
    const [out, allow, net] = memoSA(after).map((m) => Number(m.value));
    expect(out).toBe(account(after, 'A24'));
    expect(allow).toBe(-account(after, 'A25'));
    const rc = (await call<{ a24_ledger_balance: number; a25_ledger_balance: number; net_receivable: number }>(cfo, `select public.special_advance_reconciliation() r`)).out!;
    expect([out, allow, net]).toEqual([Number(rc.a24_ledger_balance), Number(rc.a25_ledger_balance), Number(rc.net_receivable)]);
  });

  it('access is unchanged: finance roles only; the helper is not callable by clients', async () => {
    expect((await sofp(tenant)).err?.message).toMatch(/Not authorised/);
    expect((await sofp(coo)).err).toBeUndefined();
    expect(await q(`select has_function_privilege('authenticated', 'public._special_advance_sofp_memo(timestamptz)', 'EXECUTE') a,
                           has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') b,
                           (select proconfig from pg_proc where oid = $1::regprocedure) c`, [SOFP_SIG]))
      .toEqual([{ a: false, b: true, c: ['search_path=public', 'statement_timeout=120s'] }]);
  });

  it('the rollback restores the production statement exactly; re-applying works', async () => {
    expect(await run(MEMO_RB)).toBeUndefined();
    expect(await md5Of(SOFP_SIG)).toBe(SOFP_PROD_MD5);
    expect(strip((await sofp()).out!)).toEqual(strip(before));
    expect((await run(MEMO_RB))?.message).toMatch(/not the Phase D definition/);
    expect(await run(MEMO)).toBeUndefined();
  });

  it('without Phase C the memo shows the outstanding line only', async () => {
    const fresh = new PGlite();
    const prev = db;
    db = fresh;
    try {
      await setup(false);
      expect(await run(MEMO)).toBeUndefined();
      expect(memoSA((await sofp()).out!)).toEqual([
        { label: 'Special Advances outstanding (paid out)', value: 1_105_000, source: 'operational sub-ledger — compare against ledger account A24' }]);
    } finally {
      await fresh.close();
      db = prev;
    }
  }, 120_000);
});
