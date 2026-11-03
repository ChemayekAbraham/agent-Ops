// @vitest-environment node
/**
 * Special Advances readiness Phase B: corrections
 * (supabase/migrations/20261102210000_special_advances_corrections.sql) on PGlite, on top of Phases 1-4 and Phase A.
 *
 * CFO decisions D11 (2026-11-02): opposite legs on the existing categories (no new mapping), repayments and external
 * payouts only, a reason and a proof file on every correction. CFO decision 2026-11-03: Welile has one CFO, who records
 * and posts a correction in ONE authorised action (no request, approval, queue or second CFO).
 * Same real code and stand-ins as specialAdvancePayout.test.ts (create_ledger_transaction, wallet routing and the
 * category validators extracted verbatim; production's allowlist fixture).
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


// ───────────── Phase B: corrections ─────────────
const CORRECTIONS = MIG('20261102210000_special_advances_corrections.sql');
const CORRECTIONS_RB = read('supabase/rollbacks/20261102210000_special_advances_corrections.rollback.sql');
const external = { kind: 'external', borrower_type: 'individual', full_name: 'John Mukasa', phone: '0772123456', national_id: 'CM900000000000' };

type Correction = { id: string; reference: string; kind: string; amount: number; ledger_group_id: string; repayment_id: string | null;
  recorded_by: string; recorded_by_name: string | null; replayed?: boolean };
type Statement = Adv & { repayments: Array<{ id: string; reference: string; reversed_by_correction: string | null }>; corrections: Correction[] };

const run = async (sql: string) => {
  const e = await db.exec(`BEGIN;\n${sql}\nCOMMIT;`).then(() => undefined, (x: Err) => x);
  await db.exec('ROLLBACK').catch(() => {});
  return e;
};
const statement = async (id: string) => (await call<Statement>(cfo, `select public.special_advance_statement($1) r`, [id])).out!;
const recon = async () => (await call<{ balanced: boolean; difference: number; a24_ledger_balance: number; subledger_outstanding: number;
  mismatched_advances: unknown[] }>(cfo, `select public.special_advance_reconciliation() r`)).out!;
/** The CFO's one authorised action: record and post a correction (CFO decision 2026-11-03, one step). */
const post = async (advanceId: string, req: Record<string, unknown>, user = cfo, aal = 'aal2') =>
  call<Correction>(user, `select public.special_advance_record_correction($1, $2::jsonb) r`, [advanceId, JSON.stringify({
    idempotency_key: uuid(), reason: 'Recorded against the wrong advance; bank statement attached',
    ...('proof_path' in req ? {} : { proof_path: await proof(advanceId) }), ...req })], aal);
/** The repayment recorded under a reference that still stands (a reversed one may share its reference). */
const repGroup = async (ref: string) => (await q<{ id: string; g: string }>(`select id, ledger_group_id g from public.special_advance_repayments
  where reference = $1 order by (reversed_by_correction is null) desc, recorded_at desc limit 1`, [ref]))[0];
const count = async (sql: string, params: unknown[] = []) => (await q<{ n: number }>(sql, params))[0].n;
const md5Of = async (sig: string) => (await q<{ m: string }>(`select md5(replace(prosrc, chr(13), '')) m from pg_proc where oid = $1::regprocedure`, [sig]))[0]?.m;
const ledgerRows = () => count(`select count(*)::int n from public.general_ledger`);
const correctionRows = () => count(`select count(*)::int n from public.special_advance_corrections`);

const PROD_MD5: Record<string, string> = { // production, read-only check 2026-11-02
  'public._special_advance_guard_update()': '8277f5c1c14aa61f7a028729f41eac54',
  'public._special_advance_audit()': '9d7a51d617ceffbe8607074c518c9dd3',
  'public._special_advance_verify_repayments()': '5c5d5ecdf99e704b7d37516d43ed0095',
  'public._special_advance_check_proof(uuid,text)': '36340f50232b5e5c1c5b58137d0aa2b8',
  'public.special_advance_record_repayment(uuid,jsonb)': 'f497ebdd9ad89fc9c9d8a4672e9d716b',
  'public.special_advance_statement(uuid)': '91104eb0097c7f614022f07aca13025d',
  'public.special_advance_reconciliation()': '977598518dd47c483921aa5ba2cb42f0',
  'public._special_advance_position(uuid)': 'b2515026024dcd7ff7b2744f58d35b27',
};
const prodMd5s = async () => Object.fromEntries(await Promise.all(Object.keys(PROD_MD5).map(async (s) => [s, await md5Of(s)])));

async function setup() {
  await db.exec(STANDINS);
  await db.exec('set check_function_bodies = off;\n' + HELPERS + '\n' + REAL.join('\n') + '\n' + TRIGGER_VALIDATOR_ALLOWLIST + '\nset check_function_bodies = on;');
  await db.exec(`create trigger trg_validate_ledger_category before insert on public.general_ledger for each row execute function public.validate_ledger_category();`);
  for (const u of users) {
    await db.query(`insert into auth.users values ($1)`, [u]);
    await db.query(`insert into public.profiles (id, full_name) values ($1, 'Person')`, [u]);
  }
  await db.query(`insert into public.user_roles (user_id, role) values ($1,'cfo'), ($2,'coo'), ($3,'super_admin'), ($4,'tenant'), ($5,'tenant'), ($6,'agent')`, users);
  await db.exec(ENGINE);
  await db.exec(`BEGIN;\n${STORAGE}\nCOMMIT;`);
  await db.exec(`BEGIN;\n${FUNCTIONS}\nCOMMIT;`);
  await db.exec(`BEGIN;\n${PAYOUT}\nCOMMIT;`);
  await db.exec(`BEGIN;\n${POSITION}\nCOMMIT;`);
  await db.exec(`update public.special_advance_settings set issuance_enabled = true`);
}

beforeAll(async () => {
  db = new PGlite();
  await setup();
}, 120_000);
afterAll(async () => { await db?.close(); });

describe('Phase B migration', () => {
  it('starts from the production definitions (Phase 4 + Phase A) and applies once; a second run is refused', async () => {
    expect(await prodMd5s()).toEqual(PROD_MD5);
    expect(await run(CORRECTIONS)).toBeUndefined();
    expect((await run(CORRECTIONS))?.message).toMatch(/corrections already exist/);
  });

  it('adds no account, mapping or allowlist entry (D11a reuses the existing categories)', async () => {
    expect(await count(`select count(*)::int n from public.ledger_account_map where category like 'special\\_advance\\_%'`)).toBe(6);
    expect(await count(`select count(*)::int n from public.ledger_account_catalog where code in ('A24','A25')`)).toBe(1);
    expect(await count(`select count(*)::int n from unnest(public.ledger_category_allowlist()) c where c like 'special\\_advance%'`)).toBe(6);
  });

  it('corrections table: CFO read only (RLS + staff MFA), no client writes; one correction function, for signed-in users only', async () => {
    expect(await q(`select has_table_privilege('authenticated','public.special_advance_corrections','SELECT') s,
                           has_table_privilege('authenticated','public.special_advance_corrections','INSERT') i,
                           has_table_privilege('anon','public.special_advance_corrections','SELECT') a,
                           (select relrowsecurity from pg_class where oid = 'public.special_advance_corrections'::regclass) rls,
                           (select count(*)::int from pg_policies where tablename = 'special_advance_corrections') pols,
                           has_function_privilege('authenticated','public.special_advance_record_correction(uuid,jsonb)','EXECUTE') f,
                           has_function_privilege('anon','public.special_advance_record_correction(uuid,jsonb)','EXECUTE') g,
                           has_function_privilege('authenticated','public._special_advance_correction_json(uuid)','EXECUTE') h`))
      .toEqual([{ s: true, i: false, a: false, rls: true, pols: 2, f: true, g: false, h: false }]);
  });

  it('one step only (CFO decision 2026-11-03): no request, decision or queue function and no status column', async () => {
    expect(await q(`select p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace
                      and p.proname ~ '^special_advance_(request|decide|list)_correction' order by 1`)).toEqual([]);
    expect(await q(`select column_name from information_schema.columns where table_name = 'special_advance_corrections'
                      and column_name in ('status', 'decided_by', 'decided_at', 'decision_note', 'requested_by') order by 1`)).toEqual([]);
  });
});

describe('Repayment reversal (D11, one step: the CFO records and posts it with a reason and a proof file)', () => {
  let w: Adv;
  let corr: Correction;
  beforeAll(async () => {
    w = (await disburse(await approved({ kind: 'welile_user', user_id: tenant }), { payout_date: today(), method: 'wallet' })).out!;
    expect((await repay(w, { amount: 200_000, reference: 'MM-WRONG-0001' })).err).toBeUndefined();
  });

  it('needs a 20+ character reason, a proof of this advance used once, aal2 and the CFO role; a refusal posts and records nothing', async () => {
    const rep = await repGroup('MM-WRONG-0001');
    const ledger0 = await ledgerRows();
    expect((await post(w.id, { kind: 'repayment_reversal', repayment_id: rep.id, reason: 'Wrong one' })).err?.message).toBe('REASON_REQUIRED');
    expect((await post(w.id, { kind: 'repayment_reversal', repayment_id: rep.id, proof_path: null })).err?.message).toBe('PROOF_REQUIRED');
    const used = (await q<{ p: string }>(`select proof_path p from public.special_advance_repayments where id = $1`, [rep.id]))[0].p;
    expect((await post(w.id, { kind: 'repayment_reversal', repayment_id: rep.id, proof_path: used })).err?.message).toBe('PROOF_ALREADY_USED');
    expect((await post(w.id, { kind: 'repayment_reversal', repayment_id: uuid() })).err?.message).toBe('REPAYMENT_NOT_FOUND');
    expect((await post(w.id, { kind: 'wipe' })).err?.message).toBe('SPECIAL_ADVANCE_INVALID_REQUEST');
    for (const u of [coo, superAdmin, tenant]) {
      expect((await post(w.id, { kind: 'repayment_reversal', repayment_id: rep.id }, u)).err?.message, u).toBe('NOT_AUTHORIZED');
    }
    expect((await post(w.id, { kind: 'repayment_reversal', repayment_id: rep.id }, cfo, 'aal1')).err?.message).toBe('MFA_REQUIRED');
    expect((await post(w.id, { kind: 'repayment_reversal', repayment_id: rep.id, idempotency_key: 'short' })).err?.message).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(await ledgerRows()).toBe(ledger0);
    expect(await correctionRows()).toBe(0);
    expect((await statement(w.id)).position.outstanding).toBe(740_000);
  });

  it('the CFO posts it in one action: DR A24 / CR A1 once, the repayment stops counting, the original entries are untouched', async () => {
    const rep = await repGroup('MM-WRONG-0001');
    const original = await q(`select * from public.general_ledger where transaction_group_id = $1 order by id`, [rep.g]);
    const key = uuid(); const p = await proof(w.id);
    const r = await post(w.id, { kind: 'repayment_reversal', repayment_id: rep.id, idempotency_key: key, proof_path: p });
    expect(r.err).toBeUndefined();
    corr = r.out!;
    expect(corr).toMatchObject({ kind: 'repayment_reversal', amount: 200_000, recorded_by: cfo, repayment_id: rep.id, replayed: false });
    expect(corr.reference).toMatch(/^SAC-\d{6}$/);
    const g = corr.ledger_group_id;
    expect(await mapped(g)).toEqual([{ account: 'A1', dr: 0, cr: 200_000 }, { account: 'A24', dr: 200_000, cr: 0 }]);
    expect(await q(`select source_table, source_id, count(*)::int n, sum(case when direction='cash_in' then amount else -amount end)::int net
                      from public.general_ledger where transaction_group_id = $1 group by 1, 2`, [g]))
      .toEqual([{ source_table: 'special_advance_corrections', source_id: corr.id, n: 2, net: 0 }]);
    expect(await q(`select * from public.general_ledger where transaction_group_id = $1 order by id`, [rep.g])).toEqual(original);
    // the ledger key belongs to this correction: it can never post twice
    expect((await q<{ g: string }>(`select public.create_ledger_transaction('[]'::jsonb, $1, false) g`, [`special_advance:correction:${corr.id}`]))[0].g).toBe(g);
    const st = await statement(w.id);
    expect(st.position).toMatchObject({ outstanding: 940_000, total_paid: 0 });
    expect(st.repayments.find((x) => x.id === rep.id)?.reversed_by_correction).toBe(corr.id);
    expect(st.corrections.map((c) => [c.reference, c.recorded_by])).toEqual([[corr.reference, cfo]]);
    expect(st.events.map((e) => e.event_type).slice(-1)).toEqual(['correction_posted']);
    expect(await q(`select actor_id, reason from public.special_advance_events where event_type = 'correction_posted'`))
      .toEqual([{ actor_id: cfo, reason: 'Recorded against the wrong advance; bank statement attached' }]);
    expect(await recon()).toMatchObject({ balanced: true, difference: 0, mismatched_advances: [] });
    // a retry with the same key replays (no second posting); the same key with a different request is refused
    const ledger1 = await ledgerRows();
    expect((await post(w.id, { kind: 'repayment_reversal', repayment_id: rep.id, idempotency_key: key, proof_path: p })).out)
      .toMatchObject({ id: corr.id, replayed: true });
    expect((await post(w.id, { kind: 'repayment_reversal', repayment_id: rep.id, idempotency_key: key, proof_path: p, reason: 'A different reason for the same key' })).err?.message)
      .toBe('IDEMPOTENCY_CONFLICT');
    expect(await ledgerRows()).toBe(ledger1);
    // a reversed repayment cannot be reversed again, under any key
    expect((await post(w.id, { kind: 'repayment_reversal', repayment_id: rep.id })).err?.message).toBe('REPAYMENT_ALREADY_REVERSED');
  });

  it('the reversed provider reference can be recorded again (once); allocation restarts from the oldest instalment', async () => {
    const r = await repay(w, { amount: 200_000, reference: 'mm-wrong-0001' });
    expect(r.err).toBeUndefined();
    expect(r.out!.position.instalments.map((i) => [i.number, i.paid])).toEqual([[1, 200_000], [2, 0], [3, 0]]);
    expect((await repay(w, { amount: 1_000, reference: 'MM-WRONG-0001' })).err?.message).toBe('REPAYMENT_REFERENCE_ALREADY_RECORDED');
    expect(await recon()).toMatchObject({ balanced: true, difference: 0 });
  });

  it('reversing a repayment of a settled advance reopens it; paying again settles it again', async () => {
    const st = await statement(w.id);
    expect((await repay(w, { amount: st.position.outstanding, reference: 'BANK-SETTLE-W1', method: 'bank_transfer' })).out?.status).toBe('settled');
    const rep = await repGroup('BANK-SETTLE-W1');
    const r = await post(w.id, { kind: 'repayment_reversal', repayment_id: rep.id });
    expect(r.err).toBeUndefined();
    const after = await statement(w.id);
    expect(after).toMatchObject({ status: 'disbursed', settled_at: null });
    expect(after.position.outstanding).toBe(740_000);
    // posting and reopening are one transaction (same timestamp), so compare the last two as a set
    expect(after.events.map((e) => e.event_type).slice(-2).sort()).toEqual(['correction_posted', 'reopened']);
    expect((await repay(w, { amount: 740_000, reference: 'BANK-SETTLE-W1', method: 'bank_transfer' })).out?.status).toBe('settled');
    expect(await recon()).toMatchObject({ balanced: true, difference: 0 });
  });

  it('reopening is refused when the borrower already has another open advance; nothing is posted or recorded', async () => {
    const other = await approved({ kind: 'welile_user', user_id: tenant }); // allowed: the first one is settled
    const rep = await repGroup('BANK-SETTLE-W1');
    const ledger0 = await ledgerRows(); const n0 = await correctionRows();
    expect((await post(w.id, { kind: 'repayment_reversal', repayment_id: rep.id })).err?.message).toBe('BORROWER_HAS_OPEN_ADVANCE');
    expect([await ledgerRows(), await correctionRows()]).toEqual([ledger0, n0]);
    await call(cfo, `select public.special_advance_cancel($1, $2::timestamptz, $3) r`, [other.id, other.updated_at, 'Not needed after all']);
  });
});

describe('External payout reversal (one step)', () => {
  let e: Adv;
  beforeAll(async () => {
    const a = await approved(external, { principal: 300_000, rate_percent: 15, rate_basis: 'monthly', term_days: 30, frequency: 'monthly' });
    e = (await disburse(a, { payout_date: today(), method: 'mobile_money', reference: 'MM-PAYOUT-E1', proof_path: await proof(a.id, 'png') })).out!;
    await repay(e, { amount: 50_000, reference: 'MM-E-REP-1' });
  });

  it('is refused while a repayment on it stands, and for a payout to a Welile wallet', async () => {
    expect((await post(e.id, { kind: 'payout_reversal' })).err?.message).toBe('REPAYMENTS_MUST_BE_REVERSED_FIRST');
    const wallet = (await q<{ id: string }>(`select id from public.special_advances where borrower_user_id = $1 and status = 'settled'`, [tenant]))[0].id;
    expect((await post(wallet, { kind: 'payout_reversal' })).err?.message).toBe('PAYOUT_REVERSAL_NOT_SUPPORTED');
  });

  it('after its repayments are reversed, the CFO reverses the payout: DR A1, DR R1 fees, CR A24; the advance ends reversed at 0', async () => {
    const rep = await repGroup('MM-E-REP-1');
    expect((await post(e.id, { kind: 'repayment_reversal', repayment_id: rep.id })).err).toBeUndefined();
    const r = await post(e.id, { kind: 'payout_reversal', reason: 'Payout recorded twice; the provider shows one transfer only' });
    expect(r.err).toBeUndefined();
    expect(r.out!.amount).toBe(365_000);
    expect(await mapped(r.out!.ledger_group_id)).toEqual([
      { account: 'A1', dr: 300_000, cr: 0 }, { account: 'A24', dr: 0, cr: 365_000 }, { account: 'R1', dr: 65_000, cr: 0 }]);
    const st = await statement(e.id);
    expect(st.status).toBe('reversed');
    expect(st.position).toMatchObject({ paid_out: false, outstanding: 0 });
    expect(st.events.map((x) => x.event_type).slice(-2).sort()).toEqual(['correction_posted', 'reversed']);
    // the advance's A24 nets to zero through payout, repayment and both corrections
    const a24 = await q<{ n: number }>(`select coalesce(sum(case when gl.direction = m.debit_when then gl.amount else -gl.amount end),0)::int n
      from public.general_ledger gl join public.ledger_account_map m on m.ledger_scope=gl.ledger_scope and m.category=gl.category and m.account_code='A24'
      where gl.reference_id = $1`, [e.reference]);
    expect(a24).toEqual([{ n: 0 }]);
    expect(await recon()).toMatchObject({ balanced: true, difference: 0, mismatched_advances: [] });
    expect((await repay(e, { amount: 1_000, reference: 'MM-AFTER-REV' })).err?.message).toBe('SPECIAL_ADVANCE_NOT_REPAYABLE');
    expect((await post(e.id, { kind: 'payout_reversal' })).err?.message).toBe('SPECIAL_ADVANCE_NOT_CORRECTABLE');
  });
});

describe('Records stay append-only; correction edges only through a posted correction', () => {
  it('repayments: only the reversal stamp naming the correction that reversed that repayment may be written, once', async () => {
    const id = (await q<{ id: string }>(`select id from public.special_advance_repayments where reference = 'mm-wrong-0001'`))[0].id;
    const e1 = await db.exec(`update public.special_advance_repayments set amount = 1 where id = '${id}'`).catch((x: Err) => x);
    expect((e1 as Err).code).toBe('42501');
    // a real correction, but for another repayment
    const c = (await q<{ id: string }>(`select id from public.special_advance_corrections where repayment_id is not null and repayment_id <> $1 limit 1`, [id]))[0].id;
    const e2 = await db.exec(`update public.special_advance_repayments set reversed_by_correction = '${c}' where id = '${id}'`).catch((x: Err) => x);
    expect((e2 as Err).code).toBe('42501');
    const e3 = await db.exec(`delete from public.special_advance_repayments where id = '${id}'`).catch((x: Err) => x);
    expect((e3 as Err).code).toBe('42501');
    const rev = (await q<{ id: string; c: string }>(`select id, reversed_by_correction c from public.special_advance_repayments where reversed_by_correction is not null limit 1`))[0];
    const e4 = await db.exec(`update public.special_advance_repayments set reversed_by_correction = null where id = '${rev.id}'`).catch((x: Err) => x);
    expect((e4 as Err).code).toBe('42501');
  });

  it('a posted correction never changes and is never deleted; only an enabled CFO can be its recorder', async () => {
    const c = (await q<{ id: string }>(`select id from public.special_advance_corrections limit 1`))[0].id;
    for (const sql of [`update public.special_advance_corrections set amount = 1 where id = '${c}'`,
      `update public.special_advance_corrections set reason = 'Something else entirely here' where id = '${c}'`,
      `delete from public.special_advance_corrections where id = '${c}'`]) {
      expect(((await db.exec(sql).catch((x: Err) => x)) as Err).code, sql).toBe('42501');
    }
    const a = (await q<{ id: string }>(`select id from public.special_advances where status = 'settled' limit 1`))[0].id;
    const e = await db.query(`insert into public.special_advance_corrections (reference, advance_id, kind, amount, reason, proof_path, idempotency_key,
        ledger_group_id, recorded_by) values ('SAC-999999', $1, 'payout_reversal', 1, 'An insert by someone who is not the CFO', $2, $3, $4, $5)`,
      [a, `advances/${a}/${uuid()}.pdf`, uuid(), uuid(), coo]).catch((x: Err) => x);
    expect((e as Err).message).toMatch(/SPECIAL_ADVANCE_RECORDER_NOT_CFO/);
  });

  it('settled -> disbursed and disbursed -> reversed cannot be written directly', async () => {
    const s = (await q<{ id: string }>(`select id from public.special_advances where status = 'settled' limit 1`))[0].id;
    expect(((await db.exec(`update public.special_advances set status = 'disbursed', settled_at = null where id = '${s}'`).catch((x: Err) => x)) as Err).message)
      .toMatch(/SPECIAL_ADVANCE_INVALID_TRANSITION/);
  });

  it('every correction group balances raw and on the mapping; all are platform-only (no wallet moves)', async () => {
    const groups = await q<{ g: string }>(`select distinct transaction_group_id g from public.general_ledger where source_table = 'special_advance_corrections'`);
    expect(groups.length).toBe(4); // the four corrections posted above; refused ones post nothing
    expect(await correctionRows()).toBe(4);
    for (const { g } of groups) {
      const m = await mapped(g);
      expect(m.reduce((s, x) => s + Number(x.dr) - Number(x.cr), 0), g).toBe(0);
      expect(await count(`select count(*)::int n from public.general_ledger where transaction_group_id = $1 and ledger_scope <> 'platform'`, [g])).toBe(0);
      expect((await q<{ n: number }>(`select sum(case when direction='cash_in' then amount else -amount end)::int n from public.general_ledger where transaction_group_id = $1`, [g]))[0].n).toBe(0);
    }
  });
});

describe('Phase B rollback', () => {
  it('refuses once corrections have been used (they are part of the books)', async () => {
    expect((await run(CORRECTIONS_RB))?.message).toMatch(/corrections have been used/);
    expect(await correctionRows()).toBeGreaterThan(0);
  });

  it('before any use, restores the eight functions exactly and the original constraints; re-applying works', async () => {
    const fresh = new PGlite();
    const prev = db;
    db = fresh;
    try {
      await setup();
      const before = await prodMd5s();
      const cons0 = await q(`select conname, pg_get_constraintdef(oid) d from pg_constraint where conrelid in ('public.special_advances'::regclass, 'public.special_advance_events'::regclass) order by 1`);
      expect(await run(CORRECTIONS)).toBeUndefined();
      expect(await run(CORRECTIONS_RB)).toBeUndefined();
      expect(await prodMd5s()).toEqual(before);
      expect(await q(`select conname, pg_get_constraintdef(oid) d from pg_constraint where conrelid in ('public.special_advances'::regclass, 'public.special_advance_events'::regclass) order by 1`)).toEqual(cons0);
      expect(await q(`select to_regclass('public.special_advance_corrections') t, to_regprocedure('public.special_advance_record_correction(uuid,jsonb)') f,
                             to_regprocedure('public._special_advance_guard_posted()') gp,
                             (select count(*)::int from information_schema.columns where table_name = 'special_advance_repayments' and column_name = 'reversed_by_correction') c,
                             (select count(*)::int from pg_trigger where tgname = 'special_advance_repayments_append_only') t2`))
        .toEqual([{ t: null, f: null, gp: null, c: 0, t2: 1 }]);
      expect(await run(CORRECTIONS)).toBeUndefined();
    } finally {
      await fresh.close();
      db = prev;
    }
  }, 120_000);
});

describe('Client helpers (src/lib/specialAdvances.ts)', () => {
  it('builds the request body (repayment_id only for a repayment reversal) and words the server refusals', async () => {
    const { buildCorrectionRequest, describeSpecialAdvanceError } = await import('@/lib/specialAdvances');
    expect(buildCorrectionRequest({ kind: 'payout_reversal', repaymentId: 'x', reason: '  Payout recorded twice in error  ', proofPath: 'p', idempotencyKey: 'k' }))
      .toEqual({ kind: 'payout_reversal', reason: 'Payout recorded twice in error', proof_path: 'p', idempotency_key: 'k' });
    expect(buildCorrectionRequest({ kind: 'repayment_reversal', repaymentId: 'r1', reason: 'r', proofPath: 'p', idempotencyKey: 'k' }))
      .toMatchObject({ kind: 'repayment_reversal', repayment_id: 'r1' });
    expect(describeSpecialAdvanceError({ message: 'REASON_REQUIRED', details: 'Explain the error in 20 to 1000 characters' })).toMatch(/at least 20/);
    expect(describeSpecialAdvanceError({ message: 'REASON_REQUIRED', details: 'A reason of 5 to 1000 characters is required' })).toMatch(/at least 5/);
    expect(describeSpecialAdvanceError({ message: 'PAYOUT_REVERSAL_NOT_SUPPORTED' })).toMatch(/Welile wallet/);
    expect(describeSpecialAdvanceError({ message: 'REPAYMENT_ALREADY_REVERSED' })).toMatch(/already been reversed/);
  });
});
