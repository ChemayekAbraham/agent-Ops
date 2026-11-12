// @vitest-environment node
/**
 * Special Advances: Pay from Wallet (supabase/migrations/20261118090000_special_advance_pay_from_wallet.sql).
 *
 * Runs on PGlite on top of production as on 12 Nov 2026: the Special Advances migrations up to the single access fee,
 * production's create_ledger_transaction, overdraft trigger (enforce_no_negative_wallet_ledger) and available-balance
 * function verbatim, production's allowlist of 12 Nov and production's balance-sheet resolver. The wallet projection is a
 * stand-in that recomputes the borrower's withdrawable balance from the ledger after every wallet leg (as production's
 * refresh_wallet_projection_for does).
 *
 * The last suite runs real concurrent requests on a throwaway Postgres (SA_PG_URL; see
 * scripts/run-special-advances-concurrency.mjs) and is skipped otherwise.
 */
import { readFileSync } from 'node:fs';
import { randomUUID as uuid } from 'node:crypto';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 600_000 });

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const MIG = (f: string) => read(`supabase/migrations/${f}`);
const WALLET_PAY = MIG('20261118090000_special_advance_pay_from_wallet.sql');
const WALLET_PAY_RB = read('supabase/rollbacks/20261118090000_special_advance_pay_from_wallet.rollback.sql');
const RESOLVER = read('src/test/fixtures/sofp_ledger_legs.live.sql');

/** The CREATE OR REPLACE FUNCTION block for `signature`, verbatim. */
function extractFn(file: string, signature: string): string {
  const src = MIG(file);
  const start = src.indexOf(`CREATE OR REPLACE FUNCTION ${signature}`);
  if (start < 0) throw new Error(`${signature} not found in ${file}`);
  const tail = src.slice(start);
  const end = tail.search(/\n(\$function\$|\$\$);\n/);
  return tail.slice(0, end) + '\n' + (tail.slice(end + 1).startsWith('$function$') ? '$function$;' : '$$;');
}

// production's wallet and ledger code of 12 Nov 2026 (read-only export), verbatim
const PROD_CREATE_LEDGER_TRANSACTION = read('scripts/fixtures/special-advance-wallet-pay-prod-2026-11-12.sql');

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
create type public.solvency_bypass_reason as enum ('cfo_override');
create table public.general_ledger (
  id uuid primary key default gen_random_uuid(), user_id uuid, wallet_id uuid, ledger_scope text, direction text, category text,
  amount numeric, currency text, description text, source_table text, source_id uuid, transaction_group_id uuid,
  idempotency_key text, transaction_date timestamptz, linked_party text, reference_id text, account text, classification text,
  recipient_type text, wallet_bucket text, routing_source text, solvency_bypass_reason public.solvency_bypass_reason,
  ip_address text, user_agent text, sub_category text, created_at timestamptz not null default now());
create table public.wallets (id uuid primary key default gen_random_uuid(), user_id uuid unique, withdrawable_balance numeric default 0);
create schema storage;
create table storage.buckets (id text primary key, name text not null, public boolean not null default false,
  file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, created_at timestamptz default now());
alter table storage.objects enable row level security;
create table public.wallet_fresh_start_anchors (user_id uuid primary key, anchor_at timestamptz);
create table public.wallet_routing_violations (id bigserial primary key, user_id uuid, category text, direction text, amount numeric,
  recipient_type text, reason text, context jsonb);
create table public.treasury_controls (control_key text primary key, enabled boolean);
insert into public.treasury_controls values ('strict_mode', true), ('advance_withdrawals_paused', false);
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
-- stand-in for refresh_wallet_projection_for: the owner's withdrawable balance, recomputed from the ledger, upserted on
-- the owner's projection row (production holds that row until commit in the same way)
create table public.wallet_balances_projection (user_id uuid primary key, withdrawable numeric not null default 0,
  float_balance numeric not null default 0, updated_at timestamptz not null default now());
create function public.tr_projection_standin() returns trigger language plpgsql as $$
DECLARE v numeric;
BEGIN
  IF NEW.ledger_scope = 'wallet' AND NEW.user_id IS NOT NULL THEN
    SELECT COALESCE(sum(CASE WHEN direction = 'cash_in' THEN amount ELSE -amount END), 0) INTO v FROM public.general_ledger
     WHERE user_id = NEW.user_id AND ledger_scope = 'wallet' AND COALESCE(wallet_bucket, 'withdrawable') = 'withdrawable';
    INSERT INTO public.wallet_balances_projection AS w (user_id, withdrawable) VALUES (NEW.user_id, v)
      ON CONFLICT (user_id) DO UPDATE SET withdrawable = EXCLUDED.withdrawable, updated_at = now();
    INSERT INTO public.wallets AS w (user_id, withdrawable_balance) VALUES (NEW.user_id, v)
      ON CONFLICT (user_id) DO UPDATE SET withdrawable_balance = EXCLUDED.withdrawable_balance;
  END IF;
  RETURN NEW;
END $$;
create trigger trg_wallet_projection_ledger after insert on public.general_ledger for each row execute function public.tr_projection_standin();
-- available-balance inputs: a funder hold (stand-in table) and the advance lock (production's function, below)
create table public.test_funder_hold (user_id uuid primary key, amount numeric not null);
create function public.funder_pending_hold(p_user_id uuid) returns numeric language sql stable as
  $$ select coalesce((select amount from public.test_funder_hold where user_id = p_user_id), 0)::numeric $$;
create function public.get_user_available_balance(p_user_id uuid) returns numeric language plpgsql stable as
  $$ begin return public.get_user_available_balance__impl(p_user_id); end $$;
create function public.get_user_advance_reversal_available(p_user_id uuid) returns numeric language sql stable as $$ select 0::numeric $$;
create table public.agent_bike_leases (sale_id uuid, agent_id uuid, status text);
create table public.merchandise_recovery_plans (id uuid primary key, item_name text, phone_collection_enabled boolean, is_bike_lease boolean);
create function public.agent_product_category(text) returns text language sql immutable as $$ select 'other'::text $$;
create table public.ledger_account_catalog (code text primary key, label text not null,
  section text not null check (section in ('current_asset','non_current_asset','current_liability','non_current_liability','equity','revenue','expense')),
  nature text not null check (nature in ('asset','liability','equity','revenue','expense')), sort_order int not null default 100,
  created_at timestamptz not null default now());
insert into public.ledger_account_catalog (code, label, section, nature, sort_order) values
  ('A1','Cash and Bank Balances','current_asset','asset',10), ('A10','Agent Advances Receivable','current_asset','asset',100),
  ('A19','Business Advance Receivables','current_asset','asset',190), ('L1','Wallet Custody Payable','current_liability','liability',300),
  ('R1','Platform Revenue','revenue','revenue',500), ('X4','Credit Losses and Write-offs','expense','expense',40),
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
  ('platform','wallet_deposit',null,'A1','cash_out');
`;

const REAL = [
  extractFn('20260817070831_d61c0e97-c1bd-476c-8266-748f95b9204b.sql', 'public.wallet_route_for_category(p_category'),
  extractFn('20260817070831_d61c0e97-c1bd-476c-8266-748f95b9204b.sql', 'public.assert_routing_compatible('),
  extractFn('20260515113611_a78dae5e-607a-4e4a-ad99-0760db81e681.sql', 'public.wallet_route_for_category(p_user_id'),
  read('scripts/fixtures/ledger-allowlist-prod-2026-10-27.sql'),
  extractFn('20260509085227_0a4f550d-0c03-48b0-b8c8-2c181e365198.sql', 'public.validate_ledger_category(p_category'),
  extractFn('20260509085227_0a4f550d-0c03-48b0-b8c8-2c181e365198.sql', 'public.validate_ledger_category()'),
  PROD_CREATE_LEDGER_TRANSACTION,
];
// production's allowlist of 12 Nov 2026; loaded after the Special Advances migrations (Phase 4 pins the 27 Oct one)
const PROD_ALLOWLIST_NOW = read('scripts/fixtures/ledger-allowlist-prod-2026-11-12.sql');
const SA = ['20261028150000_special_advances_calc_engine.sql', '20261028151000_special_advances_storage.sql',
  '20261028152000_special_advances_functions.sql', '20261028153000_special_advances_payout_repayment.sql',
  '20261102200000_special_advances_receivable_after_payout.sql', '20261102210000_special_advances_corrections.sql',
  '20261102220000_special_advances_impairment_writeoff.sql', '20261103150000_special_advances_remove_mfa.sql',
  '20261103170000_special_advances_single_access_fee.sql',
  // 12 Nov 2026 (live): record an already-issued outside-Welile advance without another payout
  '20261112080840_f2dc8ec7-d62e-49a7-adaa-e59a1bedd9b7.sql', '20261112081541_ada2af8d-2eb3-456b-80c0-1b298502b9df.sql'].map(MIG);
const TRIGGERS = `
create trigger trg_validate_ledger_category before insert on public.general_ledger for each row execute function public.validate_ledger_category();
create trigger trg_enforce_no_negative_wallet_ledger before insert on public.general_ledger for each row execute function public.enforce_no_negative_wallet_ledger();
`;

/** Production md5(prosrc) of 12 Nov 2026 for the functions the migration replaces, and after it. */
const PINS: Record<string, [string, string | null]> = {
  'public.special_advance_record_repayment(uuid,jsonb)': ['72980eea5163e0b7de8dc4c24a0b91ed', null],
  'public.special_advance_record_correction(uuid,jsonb)': ['adc9fea292474059aa12b112c9fe6def', null],
  'public.ledger_category_allowlist()': ['48c0d407fc784bdfebb59f7ed9364e14', null],
};

// ─────────────────────────── a database: PGlite, or a real Postgres for the races ───────────────────────────
type Err = { code?: string; message: string; detail?: string };
type Out<T> = { out?: T; err?: Err };
interface Db {
  exec(sql: string): Promise<void>;
  q<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** One request in its own transaction as `user` (role authenticated), as PostgREST runs it. */
  call<T = Record<string, unknown>>(user: string | null, sql: string, params?: unknown[], role?: string): Promise<Out<T>>;
  close(): Promise<void>;
}
function pglite(): Db {
  const db = new PGlite();
  return {
    exec: async (sql) => { await db.exec(sql); },
    q: async (sql, params = []) => (await db.query(sql, params)).rows as never[],
    call: async (user, sql, params = [], role = 'authenticated') => {
      try {
        let out: unknown;
        await db.transaction(async (tx) => {
          if (user) await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user, role, aal: 'aal2' })]);
          await tx.exec(`set local role ${role}`);
          out = (await tx.query<{ r: unknown }>(sql, params)).rows[0]?.r;
        });
        return { out: out as never };
      } catch (e) { return { err: e as Err }; }
    },
    close: () => db.close(),
  };
}
function realPg(url: string, max: number): Db {
  const pg = postgres(url, { max, onnotice: () => {} });
  return {
    exec: async (sql) => {
      // postgres.js runs explicit transactions through begin(), on one connection
      const m = /^BEGIN;\n([\s\S]*)\nCOMMIT;$/.exec(sql);
      if (m) await pg.begin((tx) => tx.unsafe(m[1])); else await pg.unsafe(sql);
    },
    q: async (sql, params = []) => (await pg.unsafe(sql, params as never[])) as never[],
    call: async (user, sql, params = [], role = 'authenticated') => {
      try {
        const out = await pg.begin(async (tx) => {
          if (user) await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: user, role, aal: 'aal2' })}, true)`;
          await tx.unsafe(`set local role ${role}`);
          const rows = await tx.unsafe(sql, params as never[]);
          return (rows[0] as { r?: unknown } | undefined)?.r;
        });
        return { out: out as never };
      } catch (e) { return { err: e as Err }; }
    },
    close: () => pg.end(),
  };
}

/** Production as on 12 Nov 2026 (before the migration). */
async function buildStack(db: Db, cfo: string) {
  await db.exec(STANDINS);
  await db.exec('set check_function_bodies = off;\n' + read('scripts/fixtures/asset-register-helpers.sql') + '\n' + REAL.join('\n') + '\nset check_function_bodies = on;');
  await db.exec(TRIGGERS);
  await db.q(`insert into auth.users values ($1)`, [cfo]);
  await db.q(`insert into public.profiles (id, full_name) values ($1, 'CFO')`, [cfo]);
  await db.q(`insert into public.user_roles (user_id, role) values ($1, 'cfo')`, [cfo]);
  await db.exec(SA[0]);
  for (const m of SA.slice(1)) await db.exec(`BEGIN;\n${m}\nCOMMIT;`);
  await db.exec(`update public.special_advance_settings set issuance_enabled = true`);
  await db.exec(PROD_ALLOWLIST_NOW);
  await db.exec(RESOLVER);
}

// ─────────────────────────── helpers over a Db ───────────────────────────
type Adv = { id: string; reference: string; status: string; updated_at: string; total_repayable: number;
  position: { outstanding: number; instalments: Array<{ number: number; paid: number; outstanding: number }> } };
type Receipt = { repayment_id: string; receipt_reference: string; advance_id: string; advance_reference: string; amount: number;
  applied_to_access_fee: number; applied_to_principal: number; status: string; outstanding: number; wallet_available: number; replayed: boolean };
const TERMS = { principal: 500_000, rate_percent: 28, rate_basis: 'monthly', term_days: 90, frequency: 'monthly' };
const today = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);

function helpers(db: Db, cfo: string) {
  const newUser = async (role = 'tenant') => {
    const u = uuid();
    await db.q(`insert into auth.users values ($1)`, [u]);
    await db.q(`insert into public.profiles (id, full_name) values ($1, 'Person')`, [u]);
    await db.q(`insert into public.user_roles (user_id, role) values ($1, $2)`, [u, role]);
    return u;
  };
  const approved = async (borrower: Record<string, unknown>, terms = TERMS) => {
    const s = (await db.call<{ schedule: { total_repayable: number } }>(cfo, `select public.special_advance_quote($1::text::jsonb) r`, [JSON.stringify({ terms })])).out!;
    const c = await db.call<Adv>(cfo, `select public.special_advance_create($1::text::jsonb) r`, [JSON.stringify({
      borrower, terms, purpose: 'Working capital for verified supplier stock', expected_total_repayable: s.schedule.total_repayable, idempotency_key: uuid() })]);
    if (c.err) throw new Error(c.err.message + ' ' + c.err.detail);
    const a = await db.call<Adv>(cfo, `select public.special_advance_approve($1, $2::text::timestamptz, null) r`, [c.out!.id, c.out!.updated_at]);
    if (a.err) throw new Error(a.err.message);
    return a.out!;
  };
  const proof = async (advanceId: string) => {
    const name = `advances/${advanceId}/${uuid()}.pdf`;
    await db.q(`insert into storage.objects (bucket_id, name) values ('special-advance-proofs', $1)`, [name]);
    return name;
  };
  /** A Welile user with a Special Advance paid out to their wallet (the wallet then holds the principal). */
  const paidOut = async (terms = TERMS) => {
    const user = await newUser();
    const a = await approved({ kind: 'welile_user', user_id: user }, terms);
    const d = await db.call<Adv>(cfo, `select public.special_advance_disburse($1, $2::text::timestamptz, $3::text::jsonb) r`,
      [a.id, a.updated_at, JSON.stringify({ payout_date: today(), method: 'wallet' })]);
    if (d.err) throw new Error(d.err.message);
    return { user, adv: d.out! };
  };
  /** Money into a wallet from outside (a deposit), so a borrower can pay more than the principal they received. */
  const deposit = async (user: string, amount: number) => {
    await db.q(`select public.create_ledger_transaction($1::text::jsonb, $2, false)`, [JSON.stringify([
      { ledger_scope: 'wallet', direction: 'cash_in', amount, category: 'wallet_deposit', user_id: user, wallet_bucket: 'withdrawable', recipient_type: 'user', source_table: 'test_deposits' },
      { ledger_scope: 'platform', direction: 'cash_out', amount, category: 'wallet_deposit', source_table: 'test_deposits' }]), `test-deposit:${uuid()}`]);
  };
  const wallet = async (user: string) => Number((await db.q<{ w: string }>(`select coalesce((select withdrawable from public.wallet_balances_projection where user_id = $1), 0)::text w`, [user]))[0].w);
  const outstanding = async (id: string) => Number((await db.q<{ o: string }>(`select (public._special_advance_position($1) ->> 'outstanding') o`, [id]))[0].o);
  const pay = (user: string | null, id: string, amount: number | null, expected: number | null, key: string = uuid()) =>
    db.call<Receipt>(user, `select public.special_advance_pay_from_wallet($1, $2::bigint, $3::bigint, $4) r`, [id, amount, expected, key]);
  const cfoRepay = async (id: string, rep: Record<string, unknown>) =>
    db.call<Adv>(cfo, `select public.special_advance_record_repayment($1, $2::text::jsonb) r`, [id, JSON.stringify({
      idempotency_key: uuid(), method: 'mobile_money', received_date: today(), reference: `MM${uuid().slice(0, 8)}`,
      ...('proof_path' in rep ? {} : { proof_path: await proof(id) }), ...rep })]);
  const allocations = async (id: string) => (await db.q<{ r: number[] }>(`select array[x.instalment_number, x.access_fee, x.registration_fee, x.principal]::int[] r
      from public.special_advance_repayment_allocations x join public.special_advance_repayments p on p.id = x.repayment_id
     where x.advance_id = $1 order by p.recorded_at, x.instalment_number`, [id])).map((x) => x.r);
  const counts = async () => (await db.q<{ gl: number; rep: number; alloc: number }>(`select (select count(*)::int from public.general_ledger) gl,
      (select count(*)::int from public.special_advance_repayments) rep, (select count(*)::int from public.special_advance_repayment_allocations) alloc`))[0];
  /** DR / CR per account of one ledger group, through ledger_account_map (bucket-specific row first). */
  const mapped = (group: string) => db.q<{ account: string; dr: number; cr: number }>(`
    select coalesce(ms.account_code, ma.account_code, 'UNMAPPED') account,
           sum(case when gl.direction = coalesce(ms.debit_when, ma.debit_when) then gl.amount else 0 end)::int dr,
           sum(case when gl.direction <> coalesce(ms.debit_when, ma.debit_when) then gl.amount else 0 end)::int cr
      from public.general_ledger gl
      left join public.ledger_account_map ms on ms.ledger_scope = gl.ledger_scope and ms.category = gl.category and ms.wallet_bucket = gl.wallet_bucket
      left join public.ledger_account_map ma on ma.ledger_scope = gl.ledger_scope and ma.category = gl.category and ma.wallet_bucket is null
     where gl.transaction_group_id = $1 group by 1 order by 1`, [group]);
  /** The same group through production's balance-sheet resolver (overrides and synthetic legs included). */
  const resolved = (group: string) => db.q<{ account: string; dr: number; cr: number }>(`
    select account_code account, sum(dr)::int dr, sum(cr)::int cr from public.sofp_ledger_legs(now() + interval '1 day')
     where transaction_group_id = $1 group by 1 order by 1`, [group]);
  const recon = async () => (await db.call<{ balanced: boolean; difference: number }>(cfo, `select public.special_advance_reconciliation() r`)).out!;
  return { newUser, approved, proof, paidOut, deposit, wallet, outstanding, pay, cfoRepay, allocations, counts, mapped, resolved, recon };
}

const md5Of = async (db: Db, sig: string) => (await db.q<{ m: string | null }>(`select md5(prosrc) m from pg_proc where oid = to_regprocedure($1)`, [sig]))[0]?.m ?? null;
const pinState = async (db: Db) => Object.fromEntries(await Promise.all(Object.keys(PINS).map(async (s) => [s, await md5Of(db, s)])));
const run = async (db: Db, sql: string) => db.exec(`BEGIN;\n${sql}\nCOMMIT;`).then(() => undefined, async (e: Err) => { await db.exec('ROLLBACK').catch(() => {}); return e; });

// ═══════════════════════════════════════════ PGlite suites ═══════════════════════════════════════════
const cfo = uuid();
let db: Db;
let h: ReturnType<typeof helpers>;
const parityAmounts = [150_000, 1, 99_999, 200_000];
let cfoBefore: number[][];   // CFO (Merchant Line) allocations recorded BEFORE the migration

beforeAll(async () => {
  db = pglite();
  await buildStack(db, cfo);
  h = helpers(db, cfo);
}, 600_000);
afterAll(async () => { await db?.close(); });

describe('before the migration: production as on 12 Nov 2026', () => {
  it('the replaced functions are production\'s; a wallet repayment is impossible', async () => {
    expect(Object.values(await pinState(db))).toEqual(Object.values(PINS).map((p) => p[0]));
    const { adv } = await h.paidOut();
    for (const amt of parityAmounts) expect((await h.cfoRepay(adv.id, { amount: amt })).err).toBeUndefined();
    cfoBefore = await h.allocations(adv.id);
    expect(cfoBefore.length).toBeGreaterThan(0);
    expect((await h.cfoRepay(adv.id, { amount: 1, method: 'wallet' })).err?.detail).toMatch(/method/);
  });
});

describe('20261118090000 migration', () => {
  it('applies over production\'s definitions only, once', async () => {
    const before = await h.counts();
    expect(await run(db, WALLET_PAY)).toBeUndefined();
    const after = await pinState(db);
    for (const [sig, [prod]] of Object.entries(PINS)) expect(after[sig]).not.toBe(prod);
    expect(await h.counts()).toEqual(before); // posts nothing, records nothing
    expect((await run(db, WALLET_PAY))?.message).toMatch(/precondition failed/);
  });

  it('adds one category with two mapping rows: wallet -> L1 (debit when cash_out), platform -> A24 (debit when cash_out)', async () => {
    expect(await db.q(`select ledger_scope, wallet_bucket, account_code, debit_when from public.ledger_account_map
      where category = 'special_advance_wallet_repayment' order by ledger_scope`)).toEqual([
      { ledger_scope: 'platform', wallet_bucket: null, account_code: 'A24', debit_when: 'cash_out' },
      { ledger_scope: 'wallet', wallet_bucket: 'withdrawable', account_code: 'L1', debit_when: 'cash_out' }]);
    const [{ n, has, lost }] = await db.q<{ n: number; has: boolean; lost: number }>(`select cardinality(public.ledger_category_allowlist()) n,
      'special_advance_wallet_repayment' = any(public.ledger_category_allowlist()) has,
      (select count(*)::int from unnest($1::text[]) c where not c = any(public.ledger_category_allowlist())) lost`,
      [['special_advance_repayment', 'wh_landlord_float_settled', 'salary_advance_disbursed', 'wallet_deposit']]);
    expect([n, has, lost]).toEqual([203, true, 0]);
  });

  it('grants: borrowers can call the two borrower functions; nobody outside can call the helpers; anon nothing', async () => {
    const [g] = await db.q<Record<string, boolean>>(`select
      has_function_privilege('authenticated', 'public.special_advance_pay_from_wallet(uuid,bigint,bigint,text)', 'EXECUTE') pay_auth,
      has_function_privilege('anon', 'public.special_advance_pay_from_wallet(uuid,bigint,bigint,text)', 'EXECUTE') pay_anon,
      has_function_privilege('authenticated', 'public.special_advance_my_advances()', 'EXECUTE') mine_auth,
      has_function_privilege('anon', 'public.special_advance_my_advances()', 'EXECUTE') mine_anon,
      has_function_privilege('authenticated', 'public._special_advance_apply_repayment(uuid,uuid,bigint)', 'EXECUTE') core_auth,
      has_function_privilege('authenticated', 'public._special_advance_wallet_receipt(uuid)', 'EXECUTE') receipt_auth`);
    expect(g).toEqual({ pay_auth: true, pay_anon: false, mine_auth: true, mine_anon: false, core_auth: false, receipt_auth: false });
  });
});

describe('Merchant Line (CFO recording) is unchanged', () => {
  it('the same repayments allocate exactly as before the migration', async () => {
    const { adv } = await h.paidOut();
    for (const amt of parityAmounts) expect((await h.cfoRepay(adv.id, { amount: amt })).err).toBeUndefined();
    expect(await h.allocations(adv.id)).toEqual(cfoBefore);
  });

  it('still refuses method "wallet", still requires a proof file, still posts DR A1 / CR A24', async () => {
    const { adv } = await h.paidOut();
    expect((await h.cfoRepay(adv.id, { amount: 1000, method: 'wallet' })).err?.detail).toMatch(/method/);
    expect((await h.cfoRepay(adv.id, { amount: 1000, proof_path: null })).err).toBeDefined();
    const ok = await h.cfoRepay(adv.id, { amount: 1000 });
    expect(ok.err).toBeUndefined();
    const [{ g }] = await db.q<{ g: string }>(`select ledger_group_id g from public.special_advance_repayments where advance_id = $1`, [adv.id]);
    expect(await h.mapped(g)).toEqual([{ account: 'A1', dr: 1000, cr: 0 }, { account: 'A24', dr: 0, cr: 1000 }]);
  });

  it('the table still refuses a non-wallet repayment without a proof file', async () => {
    const { adv } = await h.paidOut();
    const e = await db.exec(`insert into public.special_advance_repayments (advance_id, amount, received_date, method, reference, idempotency_key, ledger_group_id, recorded_by)
      values ('${adv.id}', 1, current_date, 'mobile_money', 'REF123', '${uuid()}', '${uuid()}', '${cfo}')`).then(() => null, (x: Err) => x);
    expect(e?.message).toMatch(/proof_path_check/);
  });
});

describe('Pay from Wallet', () => {
  it('part payment: wallet falls by the amount; one group DR L1 / CR A24; allocated access fee first; receipt returned', async () => {
    const { user, adv } = await h.paidOut();
    const w0 = await h.wallet(user);
    expect(w0).toBe(500_000);
    const due = await h.outstanding(adv.id);
    const r = await h.pay(user, adv.id, 120_000, due);
    expect(r.err).toBeUndefined();
    const rc = r.out!;
    expect(rc).toMatchObject({ amount: 120_000, status: 'disbursed', outstanding: due - 120_000, wallet_available: w0 - 120_000, replayed: false,
      advance_reference: adv.reference });
    expect(rc.receipt_reference).toMatch(/^WALLET-[0-9A-F]{12}$/);
    expect(rc.applied_to_access_fee + rc.applied_to_principal).toBe(120_000);
    expect(await h.wallet(user)).toBe(w0 - 120_000);
    const [rep] = await db.q<{ method: string; proof_path: string | null; reference: string; recorded_by: string; ledger_group_id: string; received_date: string }>(
      `select method, proof_path, reference, recorded_by, ledger_group_id, received_date::text from public.special_advance_repayments where id = $1`, [rc.repayment_id]);
    expect(rep).toMatchObject({ method: 'wallet', proof_path: null, reference: rc.receipt_reference, recorded_by: user, received_date: today() });
    expect(await h.mapped(rep.ledger_group_id)).toEqual([{ account: 'A24', dr: 0, cr: 120_000 }, { account: 'L1', dr: 120_000, cr: 0 }]);
    // production's resolver books it the same way: no override or synthetic leg captures this shape
    expect(await h.resolved(rep.ledger_group_id)).toEqual([{ account: 'A24', dr: 0, cr: 120_000 }, { account: 'L1', dr: 120_000, cr: 0 }]);
    expect(await db.q(`select ledger_scope, direction, category, wallet_bucket, recipient_type, user_id from public.general_ledger
      where transaction_group_id = $1 order by ledger_scope`, [rep.ledger_group_id])).toEqual([
      { ledger_scope: 'platform', direction: 'cash_in', category: 'special_advance_wallet_repayment', wallet_bucket: null, recipient_type: null, user_id: null },
      { ledger_scope: 'wallet', direction: 'cash_out', category: 'special_advance_wallet_repayment', wallet_bucket: 'withdrawable', recipient_type: 'user', user_id: user }]);
    expect(await db.q(`select bucket, signed_amount::int s from public.wallet_movements where category = 'special_advance_wallet_repayment' and user_id = $1`, [user]))
      .toEqual([{ bucket: 'withdrawable', s: -120_000 }]);
    expect((await h.recon()).balanced).toBe(true);
  });

  it('allocates exactly as a Merchant Line repayment of the same amounts would', async () => {
    const { user, adv } = await h.paidOut();
    await h.deposit(user, 1_000_000);
    for (const amt of parityAmounts) expect((await h.pay(user, adv.id, amt, await h.outstanding(adv.id))).err).toBeUndefined();
    expect(await h.allocations(adv.id)).toEqual(cfoBefore);
  });

  it('full payment settles the advance; the borrower is recorded as the actor', async () => {
    const { user, adv } = await h.paidOut();
    await h.deposit(user, 1_000_000);
    const due = await h.outstanding(adv.id);
    const r = await h.pay(user, adv.id, due, due);
    expect(r.out).toMatchObject({ status: 'settled', outstanding: 0 });
    expect(await db.q(`select event_type, actor_id from public.special_advance_events where advance_id = $1 and event_type = 'settled'`, [adv.id]))
      .toEqual([{ event_type: 'settled', actor_id: user }]);
    expect((await h.pay(user, adv.id, 1, 0)).err?.message).toBe('SPECIAL_ADVANCE_NOT_REPAYABLE');
    expect((await h.recon()).balanced).toBe(true);
  });

  it('a retry with the same key is not charged twice; the same key for another amount is refused', async () => {
    const { user, adv } = await h.paidOut();
    const key = uuid();
    const due = await h.outstanding(adv.id);
    const first = await h.pay(user, adv.id, 50_000, due, key);
    const before = await h.counts();
    const again = await h.pay(user, adv.id, 50_000, due, key);
    expect(again.out).toMatchObject({ repayment_id: first.out!.repayment_id, replayed: true });
    expect(await h.counts()).toEqual(before);
    expect(await h.wallet(user)).toBe(450_000);
    expect((await h.pay(user, adv.id, 60_000, due - 50_000, key)).err?.message).toBe('IDEMPOTENCY_CONFLICT');
    expect((await h.pay(user, adv.id, 50_000, due, 'short')).err?.message).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('refuses, and moves nothing, when the wallet cannot cover it, the balance shown is stale, or it overpays', async () => {
    const { user, adv } = await h.paidOut();
    const due = await h.outstanding(adv.id);
    const before = await h.counts();
    const poor = await h.pay(user, adv.id, 500_001, due);
    expect(poor.err?.message).toBe('INSUFFICIENT_WALLET_BALANCE');
    expect(JSON.parse(poor.err!.detail!)).toEqual({ available: 500_000 });
    // a pending funder hold is not available to pay with
    await db.q(`insert into public.test_funder_hold values ($1, 300000)`, [user]);
    expect((await h.pay(user, adv.id, 200_001, due)).err?.message).toBe('INSUFFICIENT_WALLET_BALANCE');
    await db.q(`delete from public.test_funder_hold where user_id = $1`, [user]);
    expect((await h.pay(user, adv.id, 1_000, due - 1)).err?.message).toBe('SPECIAL_ADVANCE_STATE_CHANGED');
    expect((await h.pay(user, adv.id, 1_000, null)).err?.message).toBe('SPECIAL_ADVANCE_STATE_CHANGED');
    await h.deposit(user, 1_000_000);
    const after0 = await h.counts();
    expect((await h.pay(user, adv.id, due + 1, due)).err?.message).toBe('OVERPAYMENT_REFUSED');
    expect((await h.pay(user, adv.id, 0, due)).err?.message).toBe('SPECIAL_ADVANCE_INVALID_REQUEST');
    expect(await h.counts()).toEqual(after0);
    expect(after0.rep).toBe(before.rep);
  });

  it('only the borrower can pay, only their own Welile-user advance, and only once it is paid out', async () => {
    const { user, adv } = await h.paidOut();
    const due = await h.outstanding(adv.id);
    const other = await h.newUser();
    await h.deposit(other, 1_000_000);
    expect((await h.pay(other, adv.id, 1_000, due)).err?.message).toBe('SPECIAL_ADVANCE_NOT_FOUND');
    expect((await h.pay(cfo, adv.id, 1_000, due)).err?.message).toBe('SPECIAL_ADVANCE_NOT_FOUND');
    expect((await h.pay(null, adv.id, 1_000, due)).err?.message).toBe('AUTH_REQUIRED');
    expect((await h.pay(user, adv.id, 1_000, due, uuid())).err).toBeUndefined(); // the borrower can
    // approved, not yet paid out
    const pending = await h.approved({ kind: 'welile_user', user_id: other });
    expect((await h.pay(other, pending.id, 1_000, 0)).err?.message).toBe('SPECIAL_ADVANCE_NOT_REPAYABLE');
    // anon cannot call it at all
    expect((await db.call(null, `select public.special_advance_pay_from_wallet($1, 1, 1, $2) r`, [adv.id, uuid()], 'anon')).err?.message).toMatch(/permission denied/);
  });

  it('a failure after the wallet leg posts rolls everything back: no wallet debit, no ledger row, no repayment', async () => {
    const { user, adv } = await h.paidOut();
    const due = await h.outstanding(adv.id);
    const w0 = await h.wallet(user);
    const before = await h.counts();
    await db.exec(`create function public.test_fail() returns trigger language plpgsql as $$ begin raise exception 'TEST_FAILURE_AFTER_LEDGER'; end $$;
      create trigger test_fail before insert on public.special_advance_repayment_allocations for each row execute function public.test_fail();`);
    const r = await h.pay(user, adv.id, 10_000, due);
    await db.exec(`drop trigger test_fail on public.special_advance_repayment_allocations; drop function public.test_fail();`);
    expect(r.err?.message).toBe('TEST_FAILURE_AFTER_LEDGER');
    expect(await h.wallet(user)).toBe(w0);
    expect(await h.counts()).toEqual(before);
  });

  it('the overdraft trigger still stands behind it: a wallet leg larger than the balance cannot post', async () => {
    const { user } = await h.paidOut();
    const e = await db.exec(`select public.create_ledger_transaction('${JSON.stringify([
      { ledger_scope: 'wallet', direction: 'cash_out', amount: 500_001, category: 'special_advance_wallet_repayment', user_id: user, wallet_bucket: 'withdrawable', recipient_type: 'user' },
      { ledger_scope: 'platform', direction: 'cash_in', amount: 500_001, category: 'special_advance_wallet_repayment' }])}'::jsonb, '${uuid()}', true)`).then(() => null, (x: Err) => x);
    expect(e?.message).toMatch(/LEDGER_BACKING_REQUIRED/);
  });

  it('the borrower sees their own advances and wallet balance only; no proof files', async () => {
    const { user, adv } = await h.paidOut();
    await h.pay(user, adv.id, 25_000, await h.outstanding(adv.id));
    await h.paidOut(); // someone else's
    const r = await db.call<{ wallet_available: number; advances: Array<Record<string, unknown> & { repayments: Array<Record<string, unknown>> }> }>(
      user, `select public.special_advance_my_advances() r`);
    expect(r.out!.wallet_available).toBe(475_000);
    expect(r.out!.advances.map((a) => a.id)).toEqual([adv.id]);
    expect(r.out!.advances[0].repayments).toEqual([expect.objectContaining({ amount: 25_000, method: 'wallet', reversed: false })]);
    expect(JSON.stringify(r.out)).not.toMatch(/proof_path|recorded_by|borrower_user_id/);
    const stranger = await h.newUser();
    expect((await db.call<{ advances: unknown[] }>(stranger, `select public.special_advance_my_advances() r`)).out!.advances).toEqual([]);
  });
});

describe('corrections', () => {
  it('reversing a wallet repayment returns the money to the wallet (CR L1) and restores the receivable (DR A24); a settled advance reopens', async () => {
    const { user, adv } = await h.paidOut();
    await h.deposit(user, 1_000_000);
    const due = await h.outstanding(adv.id);
    const r = await h.pay(user, adv.id, due, due);
    const w1 = await h.wallet(user);
    const c = await db.call<{ ledger_group_id: string }>(cfo, `select public.special_advance_record_correction($1, $2::text::jsonb) r`, [adv.id, JSON.stringify({
      idempotency_key: uuid(), kind: 'repayment_reversal', repayment_id: r.out!.repayment_id,
      reason: 'Borrower paid the wrong advance from the wallet; reversed on request', proof_path: await h.proof(adv.id) })]);
    expect(c.err).toBeUndefined();
    expect(await h.mapped(c.out!.ledger_group_id)).toEqual([{ account: 'A24', dr: due, cr: 0 }, { account: 'L1', dr: 0, cr: due }]);
    expect(await h.wallet(user)).toBe(w1 + due);
    expect(await h.outstanding(adv.id)).toBe(due);
    expect((await db.q<{ status: string }>(`select status from public.special_advances where id = $1`, [adv.id]))[0].status).toBe('disbursed');
    expect((await h.recon()).balanced).toBe(true);
  });

  it('a Merchant Line reversal is unchanged (DR A24 / CR A1, no wallet leg)', async () => {
    const { adv } = await h.paidOut();
    await h.cfoRepay(adv.id, { amount: 5_000 });
    const [{ id }] = await db.q<{ id: string }>(`select id from public.special_advance_repayments where advance_id = $1`, [adv.id]);
    const c = await db.call<{ ledger_group_id: string }>(cfo, `select public.special_advance_record_correction($1, $2::text::jsonb) r`, [adv.id, JSON.stringify({
      idempotency_key: uuid(), kind: 'repayment_reversal', repayment_id: id,
      reason: 'Mobile money repayment recorded against the wrong advance', proof_path: await h.proof(adv.id) })]);
    expect(await h.mapped(c.out!.ledger_group_id)).toEqual([{ account: 'A1', dr: 0, cr: 5_000 }, { account: 'A24', dr: 5_000, cr: 0 }]);
  });
});

describe('already-issued advance (Record already-issued) repaid by Merchant Line and from the wallet', () => {
  const daysAgo = (n: number) => new Date(Date.now() + 3 * 3_600_000 - n * 86_400_000).toISOString().slice(0, 10);
  const record = async (borrower: Record<string, unknown>, over: Record<string, unknown> = {}) => {
    const id = uuid();
    const quote = (await db.call<{ schedule: { total_repayable: number } }>(cfo, `select public.special_advance_quote($1::text::jsonb) r`, [JSON.stringify({ terms: TERMS })])).out!;
    const req = { advance_id: id, borrower, terms: TERMS, purpose: 'Original outside-Welile supplier stock payment',
      original_payout_date: daysAgo(40), method: 'cash', reference: `RCPT-${uuid().slice(0, 8)}`, proof_path: await h.proof(id),
      expected_total_repayable: quote.schedule.total_repayable, idempotency_key: uuid(), confirm_not_recorded: true, ...over };
    const r = await db.call<Adv & { payout_ledger_group_id: string; payment_sent: boolean; replayed: boolean; payout_date: string }>(
      cfo, `select public.special_advance_record_historical($1::text::jsonb) r`, [JSON.stringify(req)]);
    return { req, ...r };
  };
  const walletLegs = (user: string) => db.q(`select category, direction, amount::int from public.general_ledger where ledger_scope = 'wallet' and user_id = $1 order by created_at`, [user]);
  const a24For = async (id: string) => Number((await db.q<{ v: string }>(`select coalesce(sum(case when gl.direction = m.debit_when then gl.amount else -gl.amount end), 0)::text v
      from public.general_ledger gl join public.ledger_account_map m on m.ledger_scope = gl.ledger_scope and m.category = gl.category and m.account_code = 'A24'
     where (gl.source_table = 'special_advances' and gl.source_id = $1)
        or (gl.source_table = 'special_advance_repayments' and gl.source_id in (select id from public.special_advance_repayments where advance_id = $1))`, [id]))[0].v);

  let borrower: string;
  let adv: Adv & { payout_ledger_group_id: string };
  let req: Record<string, unknown>;

  it('records the original payment once: receivable and fee recognised, cash out on the original date, NO wallet movement, no payout', async () => {
    borrower = await h.newUser();
    const r = await record({ kind: 'welile_user', user_id: borrower });
    expect(r.err).toBeUndefined();
    adv = r.out!; req = r.req;
    expect(r.out).toMatchObject({ status: 'disbursed', payout_method: 'cash', payout_date: daysAgo(40), payment_sent: false, replayed: false });
    const total = adv.total_repayable;
    expect(await h.mapped(adv.payout_ledger_group_id)).toEqual([
      { account: 'A1', dr: 0, cr: 500_000 }, { account: 'A24', dr: total, cr: 0 }, { account: 'R1', dr: 0, cr: total - 500_000 }]);
    expect(await db.q(`select distinct ledger_scope from public.general_ledger where transaction_group_id = $1`, [adv.payout_ledger_group_id])).toEqual([{ ledger_scope: 'platform' }]);
    expect(await walletLegs(borrower)).toEqual([]);          // nothing credited to the borrower's wallet
    expect(await h.wallet(borrower)).toBe(0);
    expect(await h.outstanding(adv.id)).toBe(total);
    expect((await h.recon()).balanced).toBe(true);
  });

  it('cannot pay out again or be recorded twice', async () => {
    const again = await db.call<{ replayed: boolean }>(cfo, `select public.special_advance_record_historical($1::text::jsonb) r`, [JSON.stringify(req)]);
    expect(again.out?.replayed).toBe(true);
    expect(await db.q(`select count(distinct transaction_group_id)::int n from public.general_ledger where source_table = 'special_advances' and source_id = $1`, [adv.id])).toEqual([{ n: 1 }]);
    const [{ updated_at }] = await db.q<{ updated_at: string }>(`select updated_at::text from public.special_advances where id = $1`, [adv.id]);
    const payout = await db.call(cfo, `select public.special_advance_disburse($1, $2::text::timestamptz, $3::text::jsonb) r`,
      [adv.id, updated_at, JSON.stringify({ payout_date: today(), method: 'wallet' })]);
    expect(payout.err?.message).toBe('SPECIAL_ADVANCE_ALREADY_PAID_OUT');
    const id = uuid();
    const dupRef = await db.call(cfo, `select public.special_advance_record_historical($1::text::jsonb) r`, [JSON.stringify({ ...req, advance_id: id,
      idempotency_key: uuid(), proof_path: await h.proof(id), borrower: { kind: 'welile_user', user_id: await h.newUser() } })]);
    expect(dupRef.err?.message).toBe('HISTORICAL_REFERENCE_ALREADY_RECORDED');
    expect(await walletLegs(borrower)).toEqual([]);
  });

  it('a Merchant Line repayment posts DR A1 / CR A24 and is allocated; it cannot be dated before the original payment', async () => {
    expect((await h.cfoRepay(adv.id, { amount: 100_000, received_date: daysAgo(41) })).err?.detail).toMatch(/received_date/);
    const before = await h.outstanding(adv.id);
    expect((await h.cfoRepay(adv.id, { amount: 100_000, received_date: daysAgo(10) })).err).toBeUndefined();
    const [{ g }] = await db.q<{ g: string }>(`select ledger_group_id g from public.special_advance_repayments where advance_id = $1 and method = 'mobile_money'`, [adv.id]);
    expect(await h.mapped(g)).toEqual([{ account: 'A1', dr: 100_000, cr: 0 }, { account: 'A24', dr: 0, cr: 100_000 }]);
    expect(await h.outstanding(adv.id)).toBe(before - 100_000);
    expect(await walletLegs(borrower)).toEqual([]);
  });

  it('the borrower pays from the wallet: DR L1 / CR A24, wallet falls by exactly the amount', async () => {
    await h.deposit(borrower, 300_000);
    const due = await h.outstanding(adv.id);
    const r = await h.pay(borrower, adv.id, 250_000, due);
    expect(r.err).toBeUndefined();
    expect(r.out).toMatchObject({ amount: 250_000, outstanding: due - 250_000, wallet_available: 50_000 });
    const [{ g }] = await db.q<{ g: string }>(`select ledger_group_id g from public.special_advance_repayments where id = $1`, [r.out!.repayment_id]);
    expect(await h.mapped(g)).toEqual([{ account: 'A24', dr: 0, cr: 250_000 }, { account: 'L1', dr: 250_000, cr: 0 }]);
    expect(await walletLegs(borrower)).toEqual([
      { category: 'wallet_deposit', direction: 'cash_in', amount: 300_000 },
      { category: 'special_advance_wallet_repayment', direction: 'cash_out', amount: 250_000 }]);
    // the borrower sees it, with both payments listed
    const mine = (await db.call<{ advances: Array<{ id: string; repayments: Array<{ method: string }> }> }>(borrower, `select public.special_advance_my_advances() r`)).out!;
    expect(mine.advances.find((a) => a.id === adv.id)!.repayments.map((x) => x.method).sort()).toEqual(['mobile_money', 'wallet']);
    expect((await h.recon()).balanced).toBe(true);
  });

  it('the rest is cleared by a mix of both routes; the advance settles and its receivable is exactly zero', async () => {
    let due = await h.outstanding(adv.id);
    expect((await h.cfoRepay(adv.id, { amount: due - 50_000 })).err).toBeUndefined();
    due = await h.outstanding(adv.id);
    expect(due).toBe(50_000);
    const r = await h.pay(borrower, adv.id, 50_000, 50_000);
    expect(r.out).toMatchObject({ status: 'settled', outstanding: 0, wallet_available: 0 });
    expect(await a24For(adv.id)).toBe(0);
    expect(await db.q(`select sum(amount)::int paid from public.special_advance_repayments where advance_id = $1`, [adv.id])).toEqual([{ paid: adv.total_repayable }]);
    expect((await h.recon()).balanced).toBe(true);
  });

  it('an already-issued advance to an EXTERNAL borrower: Merchant Line works, wallet payment is not possible', async () => {
    const ext = await record({ kind: 'external', borrower_type: 'individual', full_name: 'Outside Borrower', phone: `+25670${String(Date.now()).slice(-7)}`, national_id: `CM${String(Date.now()).slice(-12)}ABCD` });
    expect(ext.err).toBeUndefined();
    expect((await h.cfoRepay(ext.out!.id, { amount: 10_000 })).err).toBeUndefined();
    const someone = await h.newUser();
    await h.deposit(someone, 50_000);
    expect((await h.pay(someone, ext.out!.id, 10_000, await h.outstanding(ext.out!.id))).err?.message).toBe('SPECIAL_ADVANCE_NOT_FOUND');
    expect((await h.recon()).balanced).toBe(true);
  });
});

describe('20261118090100: SMS after a wallet repayment', () => {
  const SMS = MIG('20261118090100_special_advance_wallet_payment_sms.sql');
  const SMS_RB = read('supabase/rollbacks/20261118090100_special_advance_wallet_payment_sms.rollback.sql');
  // stand-ins for pg_net (a queue table: a rolled-back insert leaves nothing queued, as with pg_net) and the vault
  const STUBS = `
    create schema net; create table net.queue (url text, headers jsonb, body jsonb);
    create function net.http_post(url text, headers jsonb, body jsonb) returns bigint language plpgsql as
      $$ begin insert into net.queue values (url, headers, body); return 1; end $$;
    create schema vault;
    create view vault.decrypted_secrets as select 'email_queue_service_role_key'::text name, 'svc-key'::text decrypted_secret;`;
  const queued = () => db.q<{ url: string; auth: string; body: Record<string, string> }>(`select url, headers->>'Authorization' auth, body from net.queue`);

  beforeAll(async () => {
    await db.exec(STUBS);
    expect(await run(db, SMS)).toBeUndefined();
  });

  it('a wallet payment queues exactly one text, naming only the repayment, with the service key', async () => {
    await db.exec('delete from net.queue');
    const { user, adv } = await h.paidOut();
    const r = await h.pay(user, adv.id, 10_000, await h.outstanding(adv.id));
    expect(await queued()).toEqual([{ url: 'https://byrzshwlentqvktcksem.supabase.co/functions/v1/notify-special-advance-payment',
      auth: 'Bearer svc-key', body: { repayment_id: r.out!.repayment_id } }]);
  });

  it('no text for a Merchant Line repayment, a refused payment, or a payment that rolled back', async () => {
    await db.exec('delete from net.queue');
    const { user, adv } = await h.paidOut();
    const due = await h.outstanding(adv.id);
    await h.cfoRepay(adv.id, { amount: 1_000 });
    expect((await h.pay(user, adv.id, 500_001, due - 1_000)).err?.message).toBe('INSUFFICIENT_WALLET_BALANCE'); // owed, but more than the wallet holds
    await db.exec(`create function public.test_fail() returns trigger language plpgsql as $$ begin raise exception 'TEST_FAILURE'; end $$;
      create trigger test_fail before insert on public.special_advance_repayment_allocations for each row execute function public.test_fail();`);
    expect((await h.pay(user, adv.id, 1_000, due - 1_000)).err?.message).toBe('TEST_FAILURE');
    await db.exec(`drop trigger test_fail on public.special_advance_repayment_allocations; drop function public.test_fail();`);
    expect(await queued()).toEqual([]);
  });

  it('a retry with the same key does not text twice', async () => {
    await db.exec('delete from net.queue');
    const { user, adv } = await h.paidOut();
    const due = await h.outstanding(adv.id);
    const key = uuid();
    await h.pay(user, adv.id, 5_000, due, key);
    expect((await h.pay(user, adv.id, 5_000, due, key)).out!.replayed).toBe(true);
    expect(await queued()).toHaveLength(1);
  });

  it('if the text cannot be queued, the payment still goes through', async () => {
    await db.exec(`create or replace function net.http_post(url text, headers jsonb, body jsonb) returns bigint language plpgsql as
      $$ begin raise exception 'pg_net down'; end $$;`);
    const { user, adv } = await h.paidOut();
    const r = await h.pay(user, adv.id, 7_000, await h.outstanding(adv.id));
    expect(r.err).toBeUndefined();
    expect(await h.wallet(user)).toBe(493_000);
  });

  it('rollback stops the texts and nothing else', async () => {
    expect(await run(db, SMS_RB)).toBeUndefined();
    expect(await db.q(`select count(*)::int n from pg_trigger where tgname = 'special_advance_repayments_sms_wallet'`)).toEqual([{ n: 0 }]);
    const { user, adv } = await h.paidOut();
    expect((await h.pay(user, adv.id, 1_000, await h.outstanding(adv.id))).err).toBeUndefined();
    expect(await run(db, SMS)).toBeUndefined(); // and it can be applied again
  });
});

describe('rollback', () => {
  it('is refused while wallet repayments exist (they are real money movements)', async () => {
    expect((await run(db, WALLET_PAY_RB))?.message).toMatch(/rollback refused/);
  });

  it('on a database without wallet repayments, restores production exactly', async () => {
    const fresh = pglite();
    await buildStack(fresh, cfo);
    const prod = await pinState(fresh);
    expect(await run(fresh, WALLET_PAY)).toBeUndefined();
    expect(await run(fresh, WALLET_PAY_RB)).toBeUndefined();
    expect(await pinState(fresh)).toEqual(prod);
    expect(await fresh.q(`select count(*)::int n from public.ledger_account_map where category = 'special_advance_wallet_repayment'`)).toEqual([{ n: 0 }]);
    expect(await fresh.q(`select to_regprocedure('public.special_advance_pay_from_wallet(uuid,bigint,bigint,text)') is null a,
      to_regprocedure('public._special_advance_apply_repayment(uuid,uuid,bigint)') is null b,
      (select attnotnull from pg_attribute where attrelid = 'public.special_advance_repayments'::regclass and attname = 'proof_path') c`))
      .toEqual([{ a: true, b: true, c: true }]);
    expect(await run(fresh, WALLET_PAY)).toBeUndefined(); // and it can be applied again
    await fresh.close();
  });
});

// ═══════════════════════════════ real concurrency (throwaway Postgres only) ═══════════════════════════════
const PG_URL = process.env.SA_PG_URL;
const PARALLEL = 8;
(PG_URL ? describe : describe.skip)('concurrent payments on a real Postgres (separate connections)', () => {
  let pg: Db;
  let ph: ReturnType<typeof helpers>;
  beforeAll(async () => {
    pg = realPg(PG_URL!, PARALLEL + 4);
    const [{ n }] = await pg.q<{ n: number }>(`select count(*)::int n from pg_tables where schemaname = 'public'`);
    if (n !== 0) throw new Error('SA_PG_URL must be an EMPTY, disposable database');
    await buildStack(pg, cfo);
    await pg.exec(`BEGIN;\n${WALLET_PAY}\nCOMMIT;`);
    ph = helpers(pg, cfo);
  }, 600_000);
  afterAll(async () => { await pg?.close(); });

  it(`${PARALLEL} payments at once that together exceed the wallet: the wallet never goes below zero`, async () => {
    const { user, adv } = await ph.paidOut();
    const due = await ph.outstanding(adv.id);
    // each one is affordable alone (200,000 of 500,000), all eight are not; each confirms the balance it saw
    const rs = await Promise.all(Array.from({ length: PARALLEL }, () => ph.pay(user, adv.id, 200_000, due)));
    const ok = rs.filter((r) => !r.err);
    expect(ok).toHaveLength(1); // the others see the balance moved (stale) or the wallet short
    for (const r of rs.filter((x) => x.err)) expect(r.err!.message).toMatch(/SPECIAL_ADVANCE_STATE_CHANGED|INSUFFICIENT_WALLET_BALANCE/);
    expect(await ph.wallet(user)).toBe(300_000);
    expect(await ph.outstanding(adv.id)).toBe(due - 200_000);
  });

  it('a payment waits for an in-flight wallet debit and then judges the committed balance', async () => {
    const { user, adv } = await ph.paidOut();
    const due = await ph.outstanding(adv.id);
    const raw = postgres(PG_URL!, { max: 1, onnotice: () => {} });
    let posted!: () => void; let release!: () => void;
    const isPosted = new Promise<void>((r) => (posted = r));
    const gate = new Promise<void>((r) => (release = r));
    // another path debits 400,000 and keeps its transaction open (it holds the wallet's projection row)
    const debit = raw.begin(async (tx) => {
      await tx.unsafe(`select public.create_ledger_transaction($1::text::jsonb, $2, false)`, [JSON.stringify([
        { ledger_scope: 'wallet', direction: 'cash_out', amount: 400_000, category: 'wallet_withdrawal', user_id: user, wallet_bucket: 'withdrawable', recipient_type: 'user' },
        { ledger_scope: 'platform', direction: 'cash_in', amount: 400_000, category: 'wallet_withdrawal' }]), `test-wd:${uuid()}`] as never[]);
      posted();
      await gate;
    });
    await isPosted;
    const payment = ph.pay(user, adv.id, 200_000, due); // affordable on the old 500,000, not on the committed 100,000
    await new Promise((r) => setTimeout(r, 750));
    release();
    await debit;
    const r = await payment;
    await raw.end();
    expect(r.err?.message).toBe('INSUFFICIENT_WALLET_BALANCE');
    expect(JSON.parse(r.err!.detail!)).toEqual({ available: 100_000 });
    expect(await ph.wallet(user)).toBe(100_000);
    expect(await ph.outstanding(adv.id)).toBe(due);
  });

  it(`the same payment sent ${PARALLEL} times at once (double taps) is charged once`, async () => {
    const { user, adv } = await ph.paidOut();
    const due = await ph.outstanding(adv.id);
    const key = uuid();
    const rs = await Promise.all(Array.from({ length: PARALLEL }, () => ph.pay(user, adv.id, 100_000, due, key)));
    expect(rs.filter((r) => r.err)).toEqual([]);
    expect(new Set(rs.map((r) => r.out!.repayment_id)).size).toBe(1);
    expect(rs.filter((r) => !r.out!.replayed)).toHaveLength(1);
    expect(await ph.wallet(user)).toBe(400_000);
  });
});
