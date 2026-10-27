// @vitest-environment node
/**
 * Special Advances Phase 4: payout, repayment and reconciliation
 * (supabase/migrations/20261028153000_special_advances_payout_repayment.sql) on PGlite.
 *
 * Real code, extracted verbatim from the repo's migrations at test time: create_ledger_transaction (balance checks and
 * insert), wallet_route_for_category (both forms), assert_routing_compatible, validate_ledger_category (boolean +
 * trigger, allowlist version) and ledger_category_allowlist(). Stand-ins: ledger_category_allowlist_base() (a sample;
 * production's list is not in the repo), general_ledger / wallets columns, and the wallet bucket trigger, which here
 * records the bucket chosen by the real wallet_route_for_category instead of running apply_wallet_movement.
 * The production ledger can differ from the migrations: the migration's preflight re-checks the live functions.
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
  extractFn('20260929230800_landlord_pool_topups_and_compounding.sql', 'public.ledger_category_allowlist()'),
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
-- production's base list is not in the repo; a sample with the shape the wrapper expects
create function public.ledger_category_allowlist_base() returns text[] language sql immutable as $$
  select array['wallet_deposit','wallet_withdrawal','agent_advance_credit','agent_advance_disbursement','rent_disbursement','access_fee_collected']::text[] $$;
create table public.ledger_account_catalog (code text primary key, label text not null,
  section text not null check (section in ('current_asset','non_current_asset','current_liability','non_current_liability','equity','revenue','expense')),
  nature text not null check (nature in ('asset','liability','equity','revenue','expense')), sort_order int not null default 100,
  created_at timestamptz not null default now());
insert into public.ledger_account_catalog (code, label, section, nature, sort_order) values
  ('A1','Cash and Bank Balances','current_asset','asset',10), ('A10','Agent Advances Receivable','current_asset','asset',100),
  ('A19','Business Advance Receivables','current_asset','asset',190), ('L1','Wallet Custody Payable','current_liability','liability',300),
  ('R1','Platform Revenue','revenue','revenue',500);
create table public.ledger_account_map (id uuid primary key default gen_random_uuid(), ledger_scope text not null, category text not null,
  wallet_bucket text, account_code text not null references public.ledger_account_catalog(code),
  debit_when text not null default 'cash_in' check (debit_when in ('cash_in','cash_out')), notes text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create unique index ledger_account_map_key on public.ledger_account_map (ledger_scope, category, coalesce(wallet_bucket,'*'));
insert into public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when) values
  ('platform','wallet_withdrawal',null,'A1','cash_out'), ('platform','access_fee_collected',null,'R1','cash_out');
`;

let db: PGlite;
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
type Err = { code?: string; message: string; detail?: string };
const cfo = uuid(), coo = uuid(), superAdmin = uuid(), tenant = uuid(), tenant2 = uuid(), agentUser = uuid();
const users = [cfo, coo, superAdmin, tenant, tenant2, agentUser];

async function call<T = Record<string, unknown>>(user: string, sql: string, params: unknown[] = []): Promise<{ out?: T; err?: Err }> {
  try {
    let out: T | undefined;
    await db.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user, role: 'authenticated', aal: 'aal2' })]);
      await tx.exec(`set local role authenticated`);
      out = (await tx.query<{ r: T }>(sql, params)).rows[0]?.r;
    });
    return { out };
  } catch (e) {
    return { err: e as Err };
  }
}
type Adv = { id: string; reference: string; status: string; updated_at: string; payout_date: string | null; payout_method: string | null;
  payout_ledger_group_id: string | null; schedule: Array<{ number: number; due_date: string | null; amount: number }>;
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
const repay = (a: { id: string }, rep: Record<string, unknown>, user = cfo) =>
  call<Adv>(user, `select public.special_advance_record_repayment($1, $2::jsonb) r`, [a.id, JSON.stringify({ idempotency_key: uuid(), method: 'mobile_money', received_date: today(), ...rep })]);

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

let allowlistBefore: string[] = [];

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STANDINS);
  await db.exec('set check_function_bodies = off;\n' + HELPERS + '\n' + REAL.join('\n') + '\n' + TRIGGER_VALIDATOR_INLINE + '\nset check_function_bodies = on;');
  await db.exec(`create trigger trg_validate_ledger_category before insert on public.general_ledger for each row execute function public.validate_ledger_category();`);
  for (const u of users) {
    await db.query(`insert into auth.users values ($1)`, [u]);
    await db.query(`insert into public.profiles (id, full_name) values ($1, 'Person')`, [u]);
  }
  await db.query(`insert into public.user_roles (user_id, role) values ($1,'cfo'), ($2,'coo'), ($3,'super_admin'), ($4,'tenant'), ($5,'tenant'), ($6,'agent')`, users);
  await db.exec(ENGINE);
  await db.exec(`BEGIN;\n${STORAGE}\nCOMMIT;`);
  await db.exec(`BEGIN;\n${FUNCTIONS}\nCOMMIT;`);
  await db.exec(`update public.special_advance_settings set issuance_enabled = true`);
  // an existing, unrelated posting that must stay exactly as it is
  await db.query(`select public.create_ledger_transaction($1::jsonb, 'existing-posting-0001', false)`, [JSON.stringify([
    { ledger_scope: 'platform', direction: 'cash_in', amount: 1000, category: 'wallet_withdrawal', source_table: 'existing' },
    { ledger_scope: 'platform', direction: 'cash_out', amount: 1000, category: 'access_fee_collected', source_table: 'existing' }])]);
  allowlistBefore = (await q<{ a: string[] }>(`select public.ledger_category_allowlist() a`))[0].a;
}, 60_000);
afterAll(async () => { await db?.close(); });

describe('Phase 4 migration: accounting-policy change', () => {
  it('refuses while the insert-time category validator checks its own inline list (the 2026-05-15 repo version)', async () => {
    const e = await db.exec(`BEGIN;\n${PAYOUT}\nCOMMIT;`).catch((x: Err) => x);
    await db.exec('ROLLBACK').catch(() => {});
    expect((e as Err).message).toMatch(/trigger checks its own list/);
    expect(await q(`select 1 from public.ledger_account_catalog where code = 'A20'`)).toEqual([]);
  });

  it('applies once the validators consult the allowlist (as production does per the 2026-09-24 chart of accounts)', async () => {
    await db.exec('set check_function_bodies = off;\n' + TRIGGER_VALIDATOR_ALLOWLIST + '\nset check_function_bodies = on;');
    await db.exec(`BEGIN;\n${PAYOUT}\nCOMMIT;`);
    const e = await db.exec(`BEGIN;\n${PAYOUT}\nCOMMIT;`).catch((x: Err) => x);
    await db.exec('ROLLBACK').catch(() => {});
    expect((e as Err).message).toMatch(/already exist/);
  });

  it('adds A20 after A19, six mapping rows and six categories; every existing category, row and account stays', async () => {
    expect(await q(`select code, label, section, nature, sort_order from public.ledger_account_catalog where code = 'A20'`))
      .toEqual([{ code: 'A20', label: 'Special Advances Receivable', section: 'current_asset', nature: 'asset', sort_order: 191 }]);
    expect(await q(`select ledger_scope, category, wallet_bucket, account_code, debit_when from public.ledger_account_map
                     where category like 'special\\_advance\\_%' order by category`)).toEqual([
      { ledger_scope: 'wallet', category: 'special_advance_credit', wallet_bucket: 'withdrawable', account_code: 'L1', debit_when: 'cash_out' },
      { ledger_scope: 'platform', category: 'special_advance_fee_revenue', wallet_bucket: null, account_code: 'R1', debit_when: 'cash_out' },
      { ledger_scope: 'platform', category: 'special_advance_payout_cash', wallet_bucket: null, account_code: 'A1', debit_when: 'cash_out' },
      { ledger_scope: 'platform', category: 'special_advance_receivable', wallet_bucket: null, account_code: 'A20', debit_when: 'cash_out' },
      { ledger_scope: 'platform', category: 'special_advance_repayment', wallet_bucket: null, account_code: 'A20', debit_when: 'cash_in' },
      { ledger_scope: 'platform', category: 'special_advance_repayment_received', wallet_bucket: null, account_code: 'A1', debit_when: 'cash_in' }]);
    expect(await q(`select count(*)::int n from public.ledger_account_map where category not like 'special\\_advance\\_%'`)).toEqual([{ n: 2 }]);
    const after = (await q<{ a: string[] }>(`select public.ledger_category_allowlist() a`))[0].a;
    expect(after.slice(0, allowlistBefore.length)).toEqual(allowlistBefore); // nothing removed or reordered
    expect(after.slice(allowlistBefore.length)).toEqual(['special_advance_credit', 'special_advance_receivable', 'special_advance_payout_cash',
      'special_advance_fee_revenue', 'special_advance_repayment_received', 'special_advance_repayment']);
    // the wrapper still calls the live base list (not frozen into a literal)
    expect((await q<{ s: string }>(`select prosrc s from pg_proc where proname = 'ledger_category_allowlist'`))[0].s).toMatch(/ledger_category_allowlist_base\(\)/);
  });
});

describe('Phase 4 payout (separate from approval)', () => {
  let w: Adv;

  it('pays a Welile borrower into their withdrawable wallet: balanced group, A20 receivable, fees recognised, due dates set', async () => {
    const a = await approved({ kind: 'welile_user', user_id: tenant });
    expect(a.payout_ledger_group_id).toBeNull();
    const r = await disburse(a, { payout_date: today(), method: 'wallet' });
    expect(r.err).toBeUndefined();
    w = r.out!;
    expect(w).toMatchObject({ status: 'disbursed', payout_date: today(), payout_method: 'wallet' });
    expect(w.schedule.map((s) => s.due_date)).toEqual([addDays(today(), 30), addDays(today(), 60), addDays(today(), 90)]);
    expect(w.events.map((e) => e.event_type)).toEqual(['created', 'approved', 'disbursed']);
    expect(w.position).toMatchObject({ outstanding: 940_000, total_paid: 0, overdue_amount: 0 });
    const g = w.payout_ledger_group_id!;
    const key = (x: Record<string, unknown>) => JSON.stringify(x);
    expect((await legs(g)).map(key).sort()).toEqual([
      { ledger_scope: 'wallet', direction: 'cash_in', category: 'special_advance_credit', amount: '500000', wallet_bucket: 'withdrawable', user_id: tenant },
      { ledger_scope: 'platform', direction: 'cash_in', category: 'special_advance_fee_revenue', amount: '420000', wallet_bucket: null, user_id: null },
      { ledger_scope: 'platform', direction: 'cash_in', category: 'special_advance_fee_revenue', amount: '20000', wallet_bucket: null, user_id: null },
      { ledger_scope: 'platform', direction: 'cash_out', category: 'special_advance_receivable', amount: '500000', wallet_bucket: null, user_id: null },
      { ledger_scope: 'platform', direction: 'cash_out', category: 'special_advance_receivable', amount: '420000', wallet_bucket: null, user_id: null },
      { ledger_scope: 'platform', direction: 'cash_out', category: 'special_advance_receivable', amount: '20000', wallet_bucket: null, user_id: null }]
      .map(key).sort());
    expect(await mapped(g)).toEqual([
      { account: 'A20', dr: 940_000, cr: 0 }, { account: 'L1', dr: 0, cr: 500_000 }, { account: 'R1', dr: 0, cr: 440_000 }]);
    // the REAL wallet router sends the credit to the borrower's withdrawable bucket
    expect(await q(`select bucket, signed_amount::bigint s from public.wallet_movements where user_id = $1`, [tenant])).toEqual([{ bucket: 'withdrawable', s: 500_000 }]);
  });

  it('a second payout can never post: stale version, already paid out, or the per-advance ledger key', async () => {
    expect((await disburse({ ...w, updated_at: '2000-01-01T00:00:00Z' }, { payout_date: today(), method: 'wallet' })).err?.message).toBe('STALE_VERSION');
    expect((await disburse(w, { payout_date: today(), method: 'wallet' })).err?.message).toBe('SPECIAL_ADVANCE_ALREADY_PAID_OUT');
    const again = (await q<{ g: string }>(`select public.create_ledger_transaction('[]'::jsonb, $1, false) g`, [`special_advance:${w.id}:payout`]))[0].g;
    expect(again).toBe(w.payout_ledger_group_id); // the ledger key returns the original group, never a new one
    expect(await q(`select count(distinct transaction_group_id)::int n from public.general_ledger where source_id = $1`, [w.id])).toEqual([{ n: 1 }]);
  });

  it('pays an external borrower off-platform from company cash, with the reference', async () => {
    const a = await approved({ kind: 'external', borrower_type: 'individual', full_name: 'John Mukasa', phone: '0772123456', national_id: 'CM900000000000' });
    expect((await disburse(a, { payout_date: today(), method: 'wallet' })).err?.message).toBe('SPECIAL_ADVANCE_INVALID_REQUEST');
    expect((await disburse(a, { payout_date: today(), method: 'mobile_money' })).err?.message).toBe('SPECIAL_ADVANCE_INVALID_REQUEST');
    const r = await disburse(a, { payout_date: today(), method: 'mobile_money', reference: 'MM-TXN-778899' });
    expect(r.out).toMatchObject({ status: 'disbursed', payout_method: 'mobile_money' });
    expect(await mapped(r.out!.payout_ledger_group_id!)).toEqual([
      { account: 'A1', dr: 0, cr: 500_000 }, { account: 'A20', dr: 940_000, cr: 0 }, { account: 'R1', dr: 0, cr: 440_000 }]);
    expect(await q(`select count(*)::int n from public.general_ledger where transaction_group_id = $1 and ledger_scope = 'wallet'`, [r.out!.payout_ledger_group_id])).toEqual([{ n: 0 }]);
  });

  it('payout needs: an approved advance, issuance on, a payout date between approval and today, an eligible borrower', async () => {
    const a = await approved({ kind: 'welile_user', user_id: tenant2 });
    expect((await disburse(a, { payout_date: addDays(today(), 1), method: 'wallet' })).err?.detail).toBe('["payout_date"]');
    expect((await disburse(a, { payout_date: addDays(today(), -1), method: 'wallet' })).err?.detail).toBe('["payout_date"]');
    await db.exec(`update public.special_advance_settings set issuance_enabled = false`);
    expect((await disburse(a, { payout_date: today(), method: 'wallet' })).err?.message).toBe('SPECIAL_ADVANCES_DISABLED');
    await db.exec(`update public.special_advance_settings set issuance_enabled = true`);
    await q(`insert into public.agent_advances (agent_id, status, outstanding_balance) values ($1, 'overdue', 5)`, [tenant2]);
    const blocked = await disburse(a, { payout_date: today(), method: 'wallet' });
    expect(blocked.err?.message).toBe('BORROWER_NOT_ELIGIBLE');
    await q(`delete from public.agent_advances where agent_id = $1`, [tenant2]);
    expect(await q(`select count(*)::int n from public.general_ledger where source_id = $1`, [a.id])).toEqual([{ n: 0 }]);
    expect((await disburse(a, { payout_date: today(), method: 'wallet' }, coo)).err?.message).toBe('NOT_AUTHORIZED');
    expect((await disburse(a, { payout_date: today(), method: 'wallet' }, superAdmin)).err?.message).toBe('NOT_AUTHORIZED');
  });

  it('an agent borrower is also paid to withdrawable (not float)', async () => {
    const a = await approved({ kind: 'welile_user', user_id: agentUser }, { ...TERMS, principal: 100_000, term_days: 14, frequency: 'weekly' });
    await disburse(a, { payout_date: today(), method: 'wallet' });
    expect(await q(`select bucket from public.wallet_movements where user_id = $1`, [agentUser])).toEqual([{ bucket: 'withdrawable' }]);
  });
});

describe('Phase 4 repayments (recorded by the CFO)', () => {
  let a: Adv;
  beforeAll(async () => {
    const id = (await q<{ id: string }>(`select id from public.special_advances where borrower_user_id = $1`, [tenant]))[0].id;
    a = (await call<Adv>(cfo, `select public.special_advance_statement($1) r`, [id])).out!;
  });

  it('a part payment pays the oldest instalment, access fee first; posts DR A1 / CR A20', async () => {
    const r = await repay(a, { amount: 200_000, reference: 'MM-REP-0001' });
    expect(r.err).toBeUndefined();
    expect(r.out!.position).toMatchObject({ total_paid: 200_000, outstanding: 740_000 });
    expect(r.out!.position.instalments.map((i) => [i.number, i.paid, i.status])).toEqual([[1, 200_000, 'part_paid'], [2, 0, 'due'], [3, 0, 'due']]);
    const rep = (await q<{ ledger_group_id: string }>(`select ledger_group_id from public.special_advance_repayments where reference = 'MM-REP-0001'`))[0];
    expect(await mapped(rep.ledger_group_id)).toEqual([{ account: 'A1', dr: 200_000, cr: 0 }, { account: 'A20', dr: 0, cr: 200_000 }]);
    expect(await q(`select instalment_number, access_fee::int a, registration_fee::int g, principal::int p from public.special_advance_repayment_allocations
                    where advance_id = $1`, [a.id])).toEqual([{ instalment_number: 1, a: 200_000, g: 0, p: 0 }]);
  });

  it('a payment spanning instalments splits by the waterfall within each', async () => {
    const r = await repay(a, { amount: 300_000, reference: 'BANK-REP-0002', method: 'bank_transfer' });
    expect(r.out!.position.instalments.map((i) => [i.number, i.paid])).toEqual([[1, 313_334], [2, 186_666], [3, 0]]);
    expect(await q(`select instalment_number, access_fee::int a, registration_fee::int g, principal::int p from public.special_advance_repayment_allocations
                    where repayment_id = (select id from public.special_advance_repayments where reference = 'BANK-REP-0002') order by 1`))
      .toEqual([{ instalment_number: 1, a: 113_334, g: 0, p: 0 }, { instalment_number: 2, a: 106_666, g: 20_000, p: 60_000 }]);
  });

  it('refuses an overpayment, a reused reference, a bad date or method, and replays an identical request', async () => {
    const over = await repay(a, { amount: 440_001, reference: 'MM-REP-0003' });
    expect(over.err?.message).toBe('OVERPAYMENT_REFUSED');
    expect(JSON.parse(over.err!.detail!)).toEqual({ outstanding: 440_000 });
    expect((await repay(a, { amount: 1_000, reference: 'mm-rep-0001' })).err?.message).toBe('REPAYMENT_REFERENCE_ALREADY_RECORDED');
    expect((await repay(a, { amount: 1_000, reference: 'MM-REP-0004', received_date: addDays(today(), 1) })).err?.detail).toBe('["received_date"]');
    expect((await repay(a, { amount: 1_000, reference: 'MM-REP-0004', received_date: addDays(today(), -1) })).err?.detail).toBe('["received_date"]');
    expect((await repay(a, { amount: 1_000, reference: 'CASH-1', method: 'cash' })).err?.detail).toBe('["method"]');
    expect((await repay(a, { amount: 10.5, reference: 'MM-REP-0005' })).err?.detail).toBe('["amount"]');
    const key = uuid();
    const first = await repay(a, { amount: 1_000, reference: 'MM-REP-0006', idempotency_key: key });
    const again = await repay(a, { amount: 1_000, reference: 'MM-REP-0006', idempotency_key: key });
    expect(again.out!.replayed).toBe(true);
    expect(again.out!.position.total_paid).toBe(first.out!.position.total_paid);
    expect((await repay(a, { amount: 2_000, reference: 'MM-REP-0006', idempotency_key: key })).err?.message).toBe('IDEMPOTENCY_CONFLICT');
    expect((await repay(a, { amount: 1_000, reference: 'MM-REP-0007' }, coo)).err?.message).toBe('NOT_AUTHORIZED');
  });

  it('early settlement pays the full agreed total and settles the advance; nothing more can be recorded', async () => {
    const st = (await call<Adv>(cfo, `select public.special_advance_statement($1) r`, [a.id])).out!;
    const r = await repay(a, { amount: st.position.outstanding, reference: 'BANK-SETTLE-0001', method: 'bank_transfer' });
    expect(r.out).toMatchObject({ status: 'settled' });
    expect(r.out!.position).toMatchObject({ outstanding: 0, total_paid: 940_000 });
    expect(r.out!.events.map((e) => e.event_type)).toEqual(['created', 'approved', 'disbursed', 'settled']);
    expect((await repay(a, { amount: 1, reference: 'MM-AFTER-1' })).err?.message).toBe('SPECIAL_ADVANCE_NOT_REPAYABLE');
    const alloc = (await q<{ a: number; g: number; p: number }>(`select sum(access_fee)::int a, sum(registration_fee)::int g, sum(principal)::int p
      from public.special_advance_repayment_allocations where advance_id = $1`, [a.id]))[0];
    expect(alloc).toEqual({ a: 420_000, g: 20_000, p: 500_000 });
  });

  it('repayment records and allocations cannot be edited or deleted', async () => {
    for (const sql of [`update public.special_advance_repayments set amount = 1`, `delete from public.special_advance_repayments`,
      `update public.special_advance_repayment_allocations set principal = 0`, `delete from public.special_advance_repayment_allocations`]) {
      expect(((await db.exec(sql).catch((x: Err) => x)) as Err).code, sql).toBe('42501');
    }
  });
});

describe('Phase 4 missed instalments, reconciliation, and existing postings', () => {
  it('a missed instalment is reported overdue; no late fee is charged', async () => {
    const id = (await q<{ id: string }>(`select id from public.special_advances where borrower_user_id = $1`, [agentUser]))[0].id;
    // move "today" 10 days ahead (test only) so the first weekly instalment is past due
    await db.exec(`CREATE OR REPLACE FUNCTION public._special_advance_kampala_today() RETURNS date LANGUAGE sql STABLE SET search_path = public AS $$
      SELECT (now() AT TIME ZONE 'Africa/Kampala')::date + 10 $$`);
    const st = (await call<Adv>(cfo, `select public.special_advance_statement($1) r`, [id])).out!;
    await db.exec(`CREATE OR REPLACE FUNCTION public._special_advance_kampala_today() RETURNS date LANGUAGE sql STABLE SET search_path = public AS $$
      SELECT (now() AT TIME ZONE 'Africa/Kampala')::date $$`);
    expect(st.position.overdue_instalments).toBe(1);
    expect(st.position.instalments.map((i) => i.status)).toEqual(['overdue', 'due']);
    expect(st.position.outstanding).toBe(st.position.instalments.reduce((s, i) => s + i.outstanding, 0)); // no late fee added
    expect(await q(`select count(*)::int n from public.general_ledger where category like '%late%'`)).toEqual([{ n: 0 }]);
  });

  it('the A20 ledger balance equals the subledger outstanding, per advance and in total', async () => {
    const r = (await call<{ balanced: boolean; difference: number; a20_ledger_balance: number; subledger_outstanding: number; mismatched_advances: unknown[] }>(
      cfo, `select public.special_advance_reconciliation() r`)).out!;
    expect(r).toMatchObject({ balanced: true, difference: 0, mismatched_advances: [] });
    expect(r.a20_ledger_balance).toBe(r.subledger_outstanding);
    expect(r.a20_ledger_balance).toBeGreaterThan(0);
  });

  it('reconciliation flags a stray A20 posting', async () => {
    await db.transaction(async (tx) => {
      await tx.query(`select public.create_ledger_transaction($1::jsonb, 'stray-a20-test-0001', false)`, [JSON.stringify([
        { ledger_scope: 'platform', direction: 'cash_out', amount: 7, category: 'special_advance_receivable', source_table: 'manual' },
        { ledger_scope: 'platform', direction: 'cash_in', amount: 7, category: 'special_advance_payout_cash', source_table: 'manual' }])]);
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: cfo, role: 'authenticated', aal: 'aal2' })]);
      const r = (await tx.query<{ r: { balanced: boolean; difference: number } }>(`select public.special_advance_reconciliation() r`)).rows[0].r;
      expect(r).toMatchObject({ balanced: false, difference: 7 });
      await tx.rollback();
    });
  });

  it('every Special Advances group balances raw and mapped; existing postings are untouched', async () => {
    const groups = await q<{ g: string; i: number; o: number }>(`select transaction_group_id g, sum(amount) filter (where direction = 'cash_in')::bigint i,
      sum(amount) filter (where direction = 'cash_out')::bigint o from public.general_ledger where category like 'special\\_advance\\_%' group by 1`);
    expect(groups.length).toBeGreaterThan(5);
    for (const g of groups) {
      expect(g.i).toBe(g.o);
      const m = await mapped(g.g);
      expect(m.some((x) => x.account === 'UNMAPPED')).toBe(false);
      expect(m.reduce((s, x) => s + Number(x.dr), 0)).toBe(m.reduce((s, x) => s + Number(x.cr), 0));
    }
    expect(await q(`select category, direction, amount::int a from public.general_ledger where source_table = 'existing' order by 1`))
      .toEqual([{ category: 'access_fee_collected', direction: 'cash_out', a: 1000 }, { category: 'wallet_withdrawal', direction: 'cash_in', a: 1000 }]);
    expect(await q(`select count(*)::int n from public.agent_advances`)).toEqual([{ n: 0 }]);
  });

  it('statement and reconciliation are CFO-only', async () => {
    for (const u of [coo, superAdmin, tenant]) {
      expect((await call(u, `select public.special_advance_reconciliation() r`)).err?.message).toBe('NOT_AUTHORIZED');
      expect((await call(u, `select public.special_advance_statement($1) r`, [uuid()])).err?.message).toBe('NOT_AUTHORIZED');
    }
  });
});

describe('Phase 4 rollback', () => {
  it('refuses once anything has been posted', async () => {
    const e = await db.exec(`BEGIN;\n${PAYOUT_RB}\nCOMMIT;`).catch((x: Err) => x);
    await db.exec('ROLLBACK').catch(() => {});
    expect((e as Err).message).toMatch(/cannot unwind posted money/);
    expect(await q(`select 1 from public.ledger_account_catalog where code = 'A20'`)).toHaveLength(1);
  });

  it('before any posting, it restores the allowlist exactly and removes A20 and the mappings', async () => {
    const fresh = new PGlite();
    const prev = db;
    db = fresh;
    try {
      await db.exec(STANDINS);
      await db.exec('set check_function_bodies = off;\n' + HELPERS + '\n' + REAL.join('\n') + '\n' + TRIGGER_VALIDATOR_ALLOWLIST + '\nset check_function_bodies = on;');
      await db.exec(ENGINE);
      await db.exec(`BEGIN;\n${STORAGE}\nCOMMIT;`);
      await db.exec(`BEGIN;\n${FUNCTIONS}\nCOMMIT;`);
      const before = (await q<{ a: string[]; s: string }>(`select public.ledger_category_allowlist() a, (select prosrc from pg_proc where proname = 'ledger_category_allowlist') s`))[0];
      await db.exec(`BEGIN;\n${PAYOUT}\nCOMMIT;`);
      await db.exec(`BEGIN;\n${PAYOUT_RB}\nCOMMIT;`);
      const after = (await q<{ a: string[]; s: string }>(`select public.ledger_category_allowlist() a, (select prosrc from pg_proc where proname = 'ledger_category_allowlist') s`))[0];
      expect(after.a).toEqual(before.a);
      expect(after.s.replace(/\s+/g, ' ').trim()).toBe(before.s.replace(/\s+/g, ' ').trim());
      expect(await q(`select count(*)::int n from public.ledger_account_map where category like 'special\\_advance\\_%'`)).toEqual([{ n: 0 }]);
      expect(await q(`select count(*)::int n from public.ledger_account_catalog where code = 'A20'`)).toEqual([{ n: 0 }]);
      await db.exec(`BEGIN;\n${PAYOUT}\nCOMMIT;`); // re-applies cleanly
    } finally {
      await fresh.close();
      db = prev;
    }
  }, 60_000);
});
