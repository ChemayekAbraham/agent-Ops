// @vitest-environment node
/**
 * CFO Tenant Repayment Tracker (migrations 20261108090000 + 20261108120000 Money In basis), read-only.
 *
 * Runs the migration verbatim on PGlite over minimal tables carrying production's column names (read-only export
 * 2026-11-07). The shared payout clock (am_plan_clock / am_plan_arrears) is a simple stand-in here: it has its own tests
 * (supabase/tests/am_hardening.sql) and the tracker only displays what it returns.
 *
 * Proves: collected = Money In (Tenant Products and Services) entries on the plan from 1 Oct 2026, net, plus receipts and
 * ledger-backed repayment records before it; never the stored status; a manual balance reduction is never a repayment and the ops payment-edit mirror is counted once; every exception;
 * legacy plans are not flagged on the newer ledger checks; CFO / super_admin only; grants; nothing is ever written.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const MIG = read('supabase/migrations/20261108090000_cfo_tenant_repayment_tracker.sql');
const MIG2 = read('supabase/migrations/20261108120000_cfo_tenant_repayment_tracker_money_in.sql');
const RB = read('supabase/rollbacks/20261108090000_cfo_tenant_repayment_tracker.rollback.sql');
const RB2 = read('supabase/rollbacks/20261108120000_cfo_tenant_repayment_tracker_money_in.rollback.sql');

const CFO = '00000000-0000-0000-0000-0000000000cf';
const SA = '00000000-0000-0000-0000-0000000000aa';
const MGR = '00000000-0000-0000-0000-0000000000a9';
const FINOPS = '00000000-0000-0000-0000-0000000000f0';
const CEO = '00000000-0000-0000-0000-0000000000ce';
const AGENT = '00000000-0000-0000-0000-00000000a001';
const OPS = '00000000-0000-0000-0000-00000000a002';
const T = (n: number) => `00000000-0000-0000-0000-0000000010${String(n).padStart(2, '0')}`;
const P = (n: number) => `00000000-0000-0000-0000-0000000020${String(n).padStart(2, '0')}`;
const LL = '00000000-0000-0000-0000-000000003001';

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create type public.app_role as enum ('cfo', 'super_admin', 'manager', 'financial_ops', 'ceo', 'agent', 'tenant');
create table public.user_roles (user_id uuid, role public.app_role, enabled boolean default true);
create function public.has_role(p_user uuid, p_role public.app_role) returns boolean language sql stable as
  $$ select exists (select 1 from public.user_roles where user_id = p_user and role = p_role and enabled) $$;
create table public.profiles (id uuid primary key, full_name text, phone text);
create table public.landlords (id uuid primary key, name text);
create table public.rent_requests (id uuid primary key, tenant_id uuid, agent_id uuid, landlord_id uuid, status text,
  rent_amount numeric, access_fee numeric, request_fee numeric, total_repayment numeric, amount_repaid numeric default 0,
  daily_repayment numeric, duration_days integer, funded_at timestamptz, disbursed_at timestamptz, created_at timestamptz default now());
create table public.agent_collections (id uuid primary key default gen_random_uuid(), agent_id uuid, tenant_id uuid, rent_request_id uuid,
  amount numeric, payment_method text, notes text, reversed_at timestamptz, deposit_request_id uuid, token_id uuid, visit_id uuid,
  momo_transaction_id text, tracking_id text, created_at timestamptz default now());
create table public.repayments (id uuid primary key default gen_random_uuid(), tenant_id uuid, rent_request_id uuid, amount numeric,
  created_at timestamptz default now(), payment_method text, paid_by uuid, initiated_by uuid, deposit_request_id uuid, external_reference text);
create table public.general_ledger (id uuid primary key default gen_random_uuid(), transaction_group_id uuid default gen_random_uuid(),
  ledger_scope text, direction text, amount numeric, category text, source_table text, source_id uuid, reference_id text,
  description text, user_id uuid, created_at timestamptz default now(), transaction_date timestamptz default now(),
  classification text default 'production', idempotency_key text);
-- production's Money In category functions, verbatim (read-only export 2026-11-07)
create function public._cfo_received_category_for(p_category text) returns text language sql immutable as $$
  SELECT CASE p_category
    WHEN 'partner_funding' THEN 'partner' WHEN 'tenant_repayment_collected' THEN 'land' WHEN 'tenant_repayment' THEN 'land'
    WHEN 'landlord_receivable_collected' THEN 'land' WHEN 'agent_advance_repayment' THEN 'agent' WHEN 'agent_repayment' THEN 'agent'
    WHEN 'bike_recovery_repayment' THEN 'agent' WHEN 'merchandise_recovery_repayment' THEN 'agent' WHEN 'listing_rejection_recovery' THEN 'agent'
    WHEN 'platform_fee_collected' THEN 'fees' WHEN 'access_fee_collected' THEN 'fees' WHEN 'agent_advance_fee_revenue' THEN 'fees'
    WHEN 'agent_advance_access_fee_collected' THEN 'fees' WHEN 'agent_advance_registration_fee_collected' THEN 'fees'
    WHEN 'share_capital' THEN 'capital' ELSE NULL END $$;
create function public._cfo_received_category_for(p_category text, p_source_table text) returns text language sql immutable as $$
  SELECT CASE WHEN p_category = 'landlord_receivable_collected' AND p_source_table = 'welile_homes_subscriptions' THEN 'landlord'
    ELSE public._cfo_received_category_for(p_category) END $$;
create table public.tenant_balance_edits (id uuid primary key default gen_random_uuid(), rent_request_id uuid, tenant_id uuid, agent_id uuid,
  editor_id uuid, editor_name text, old_outstanding numeric, new_outstanding numeric, reason text, status text, source text,
  decided_by uuid, decided_at timestamptz, decision_note text, applied_at timestamptz, created_at timestamptz default now());
create table public.landlord_payment_edits (id uuid primary key default gen_random_uuid(), edit_type text, rent_request_id uuid,
  old_amount numeric, new_amount numeric, final_amount numeric, reason text, edited_by uuid, edited_by_name text, agent_response text,
  reverted_on_dispute boolean default false, resolution text, resolved_by_name text, resolution_note text, created_at timestamptz default now());
create table public.rent_amount_change_log (id uuid primary key default gen_random_uuid(), rent_request_id uuid,
  old_total_repayment numeric, new_total_repayment numeric, old_amount_repaid numeric, new_amount_repaid numeric,
  changed_by uuid, changed_at timestamptz default now(), source text);
-- stand-ins for the shared payout clock (same signatures and columns as production)
create function public.am_plan_clock(p_rent_request_ids uuid[]) returns table(rent_request_id uuid, bucket text, landlord_paid_count integer,
  landlord_paid_total numeric, landlord_paid_dates_estimated integer, first_landlord_paid_on date, last_landlord_paid_on date,
  clock_start date, clock_end date, current_start date, shift_days integer) language sql stable as $$
  select r.id, 'counting', 1, r.rent_amount, 0, (r.funded_at at time zone 'Africa/Kampala')::date, (r.funded_at at time zone 'Africa/Kampala')::date,
         (r.funded_at at time zone 'Africa/Kampala')::date, (r.funded_at at time zone 'Africa/Kampala')::date + r.duration_days - 1,
         (r.funded_at at time zone 'Africa/Kampala')::date, 0
  from public.rent_requests r where r.id = any(p_rent_request_ids) and r.funded_at is not null $$;
create function public.am_plan_arrears(p_rent_request_ids uuid[], p_as_at date) returns table(rent_request_id uuid, bucket text, cadence text,
  unit text, clock_start date, expected_to_date numeric, paid_to_date numeric, arrears numeric, days_behind integer, days_ahead integer,
  periods_behind integer, periods_ahead integer) language sql stable as $$
  select r.id, 'counting', 'daily', 'day', (r.funded_at at time zone 'Africa/Kampala')::date, 100000::numeric, 0::numeric, 100000::numeric, 5, 0, 5, 0
  from public.rent_requests r where r.id = any(p_rent_request_ids) and r.funded_at is not null $$;
`;

// plan helper: obligation = rent + 300,000 access fee + 20,000 request fee
async function plan(db: PGlite, n: number, o: { status: string; rent?: number; repaid?: number; funded: string }) {
  const rent = o.rent ?? 1_000_000;
  await db.query(`insert into public.profiles values ($1, $2, $3) on conflict do nothing`, [T(n), `Tenant ${n}`, `+25670000${String(n).padStart(4, '0')}`]);
  await db.query(`insert into public.rent_requests (id, tenant_id, agent_id, landlord_id, status, rent_amount, access_fee, request_fee, total_repayment,
      amount_repaid, daily_repayment, duration_days, funded_at, created_at) values ($1, $2, $3, $4, $5, $6, 300000, 20000, $7, $8, 44000, 30, $9, $9)`,
    [P(n), T(n), AGENT, LL, o.status, rent, rent + 320000, o.repaid ?? 0, o.funded]);
}
const receipt = (db: PGlite, n: number, amount: number, at: string, extra: Record<string, unknown> = {}) =>
  db.query(`insert into public.agent_collections (agent_id, tenant_id, rent_request_id, amount, payment_method, notes, reversed_at, momo_transaction_id, tracking_id, created_at)
      values ($1, $2, $3, $4, 'cash', $5, $6, $7, $8, $9)`,
    [AGENT, T(n), P(n), amount, extra.notes ?? null, extra.reversed_at ?? null, extra.momo ?? null, `AGT-${n}-${amount}`, at]);
const leg = (db: PGlite, n: number, category: string, direction: string, amount: number, at: string, source = 'agent_collections', scope = 'platform') =>
  db.query(`insert into public.general_ledger (ledger_scope, direction, amount, category, source_table, source_id, description, created_at, transaction_date)
      values ($1, $2, $3, $4, $5, $6, 'test', $7, $7)`, [scope, direction, amount, category, source, P(n), at]);

let db: PGlite;
type Row = Record<string, any>;
async function asUser<X>(uid: string, f: () => Promise<X>): Promise<X> {
  await db.query(`select set_config('test.uid', $1, false)`, [uid]);
  try { return await f(); } finally { await db.query(`select set_config('test.uid', '', false)`); }
}
const register = async (uid = CFO) => asUser(uid, async () => (await db.query<Row>(`select * from public.get_cfo_tenant_repayment_register()`)).rows);
const byPlan = (rows: Row[], n: number) => rows.find((r) => r.rent_request_id === P(n))!;
const num = (v: unknown) => Number(v);
async function snapshot() {
  const t = ['rent_requests', 'agent_collections', 'repayments', 'general_ledger', 'tenant_balance_edits', 'landlord_payment_edits', 'rent_amount_change_log', 'profiles'];
  return JSON.stringify(await Promise.all(t.map(async (x) => (await db.query(`select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) h from public.${x} t`)).rows[0])));
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(`
    insert into public.user_roles values ('${CFO}', 'cfo', true), ('${SA}', 'super_admin', true), ('${MGR}', 'manager', true),
      ('${FINOPS}', 'financial_ops', true), ('${CEO}', 'ceo', true);
    insert into public.profiles values ('${AGENT}', 'Agent A', '+256700000001'), ('${OPS}', 'Ops Person', '+256700000002'), ('${CFO}', 'The CFO', null);
    insert into public.landlords values ('${LL}', 'Landlord L');`);

  // 1 clean: two receipts = obligation, completed, ledger postings present (current scheme)
  await plan(db, 1, { status: 'completed', repaid: 1_320_000, funded: '2026-10-02 08:00+03' });
  await receipt(db, 1, 700_000, '2026-10-10 09:00+03'); await leg(db, 1, 'tenant_repayment_collected', 'cash_in', 700_000, '2026-10-10 09:00:30+03');
  await receipt(db, 1, 620_000, '2026-10-20 09:00+03'); await leg(db, 1, 'tenant_repayment_collected', 'cash_in', 620_000, '2026-10-20 09:00:30+03');
  await leg(db, 1, 'rent_receivable_created', 'cash_in', 1_000_000, '2026-10-02 08:00+03', 'rent_requests', 'bridge');
  await leg(db, 1, 'fee_receivable_created', 'cash_in', 320_000, '2026-10-02 08:00+03', 'rent_requests', 'bridge');
  await leg(db, 1, 'rent_disbursement', 'cash_out', 1_000_000, '2026-10-02 08:00+03', 'rent_requests', 'platform');

  // 2 reversed receipts (reversed_at, and a "[REVERSED:" note) still counted in amount_repaid
  await plan(db, 2, { status: 'repaying', repaid: 900_000, funded: '2026-09-01 08:00+03' });
  await receipt(db, 2, 500_000, '2026-09-05 09:00+03');
  await receipt(db, 2, 300_000, '2026-09-06 09:00+03', { reversed_at: '2026-09-07 09:00+03' });
  await receipt(db, 2, 100_000, '2026-09-08 09:00+03', { notes: 'collected [REVERSED: duplicate]' });

  // 3 Wasajja Simon shape: 4,000,000 + 1,320,000 + 20,000 = 5,340,000; one 820,000 receipt; balance cut 5,340,000 -> 820,000 by an
  //   approved edit mirrored in landlord_payment_edits; amount_repaid raised by the approval; status completed
  await db.query(`insert into public.profiles values ($1, 'Tenant 3', '+256781604060')`, [T(3)]);
  await db.query(`insert into public.rent_requests (id, tenant_id, agent_id, landlord_id, status, rent_amount, access_fee, request_fee, total_repayment,
      amount_repaid, daily_repayment, duration_days, funded_at, created_at) values ($1, $2, $3, $4, 'completed', 4000000, 1320000, 20000, 5340000,
      5340000, 178000, 30, '2026-10-08 12:10+03', '2026-10-08 09:48+03')`, [P(3), T(3), AGENT, LL]);
  await leg(db, 3, 'rent_receivable_created', 'cash_in', 4_000_000, '2026-10-08 12:10+03', 'rent_requests', 'bridge');
  await leg(db, 3, 'fee_receivable_created', 'cash_in', 1_340_000, '2026-10-08 12:10+03', 'rent_requests', 'bridge');
  await db.query(`insert into public.tenant_balance_edits (rent_request_id, editor_id, editor_name, old_outstanding, new_outstanding, reason, status, source,
      decided_by, decided_at, applied_at, created_at) values ($1, $2, 'Ops Person', 5340000, 820000, 'system bal correction', 'approved', 'ops_payment_edit',
      $3, '2026-10-25 09:13+03', '2026-10-25 09:13+03', '2026-10-13 12:10+03')`, [P(3), OPS, CFO]);
  await db.query(`insert into public.landlord_payment_edits (edit_type, rent_request_id, old_amount, new_amount, reason, edited_by, edited_by_name,
      agent_response, created_at) values ('outstanding_balance', $1, 5340000, 820000, 'system bal correction', $2, 'Ops Person', 'agreed', '2026-10-13 12:10+03')`, [P(3), OPS]);
  await db.query(`insert into public.rent_amount_change_log (rent_request_id, old_total_repayment, new_total_repayment, old_amount_repaid, new_amount_repaid,
      changed_by, changed_at, source) values ($1, 5340000, 5340000, 0, 4520000, $2, '2026-10-25 09:13+03', 'cfo_approved_ops_payment_edit')`, [P(3), CFO]);
  await receipt(db, 3, 820_000, '2026-10-26 09:27+03'); await leg(db, 3, 'tenant_repayment_collected', 'cash_in', 820_000, '2026-10-26 09:27:20+03');

  // 4 repayments rows with no receipt: one backed by the ledger (counted), one not (unverified, never counted)
  await plan(db, 4, { status: 'repaying', repaid: 300_000, funded: '2026-08-01 08:00+03' });
  await db.query(`insert into public.repayments (tenant_id, rent_request_id, amount, created_at, external_reference) values
      ($1, $2, 200000, '2026-08-10 09:00+03', 'LEG-1'), ($1, $2, 100000, '2026-08-11 09:00+03', null)`, [T(4), P(4)]);
  await leg(db, 4, 'tenant_repayment', 'cash_in', 200_000, '2026-08-10 09:01+03', 'rent_requests');

  // 5 receipts with no ledger posting: one from 1 Oct (flagged), one in September (earlier scheme, not flagged)
  await plan(db, 5, { status: 'repaying', repaid: 400_000, funded: '2026-09-15 08:00+03' });
  await receipt(db, 5, 150_000, '2026-09-20 09:00+03');
  await receipt(db, 5, 250_000, '2026-10-05 09:00+03');

  // 6 funded from October with books short of the obligation; 7 legacy plan with no receivables at all (not flagged)
  await plan(db, 6, { status: 'repaying', funded: '2026-10-03 08:00+03' });
  await leg(db, 6, 'rent_receivable_created', 'cash_in', 1_000_000, '2026-10-03 08:00+03', 'rent_requests', 'bridge');
  await plan(db, 7, { status: 'repaying', funded: '2026-06-03 08:00+03' });

  // 8 obligation lowered after funding; 9 collected more than owed
  await plan(db, 8, { status: 'repaying', funded: '2026-07-01 08:00+03' });
  await db.query(`insert into public.rent_amount_change_log (rent_request_id, old_total_repayment, new_total_repayment, old_amount_repaid, new_amount_repaid,
      changed_by, changed_at) values ($1, 1500000, 1320000, 0, 0, $2, '2026-07-20 09:00+03')`, [P(8), OPS]);
  await plan(db, 9, { status: 'completed', repaid: 1_320_000, funded: '2026-07-01 08:00+03' });
  await receipt(db, 9, 1_000_000, '2026-07-10 09:00+03'); await receipt(db, 9, 400_000, '2026-07-12 09:00+03');

  // 11 Money In basis from October: an entry with no receipt counts; a reversal leg nets out; a non-cash correction before the
  //    cut-over (shape of the 16 Sep 92.66M contra) never counts
  await plan(db, 11, { status: 'repaying', funded: '2026-09-20 08:00+03' });
  await leg(db, 11, 'tenant_repayment_collected', 'cash_in', 300_000, '2026-10-12 10:00+03');
  await leg(db, 11, 'tenant_repayment_collected', 'cash_in', 50_000, '2026-10-13 10:00+03');
  await leg(db, 11, 'tenant_repayment_collected', 'cash_out', 50_000, '2026-10-14 10:00+03');
  await leg(db, 11, 'tenant_repayment_collected', 'cash_in', 900_000, '2026-09-16 10:00+03');
  // 12 a Money In entry that the Money In page itself excludes (reclassification key) does not count either
  await plan(db, 12, { status: 'repaying', funded: '2026-10-05 08:00+03' });
  await db.query(`insert into public.general_ledger (ledger_scope, direction, amount, category, source_table, source_id, description, created_at, transaction_date, idempotency_key)
      values ('platform', 'cash_in', 70000, 'tenant_repayment_collected', 'agent_collections', $1, 'reclass', '2026-10-20 10:00+03', '2026-10-20 10:00+03', 'merch_recv_derecog:x')`, [P(12)]);
  await db.query(`insert into public.general_ledger (ledger_scope, direction, amount, category, source_table, source_id, description, created_at, transaction_date, classification)
      values ('platform', 'cash_in', 80000, 'tenant_repayment_collected', 'agent_collections', $1, 'test row', '2026-10-21 10:00+03', '2026-10-21 10:00+03', 'admin_correction')`, [P(12)]);

  // 10 never funded (pending): not in the register
  await db.query(`insert into public.rent_requests (id, tenant_id, status, rent_amount, access_fee, request_fee, total_repayment) values ($1, $2, 'pending', 1, 0, 0, 1)`, [P(10), T(1)]);

  await db.exec(MIG);
  await db.exec(MIG2);
}, 120_000);
afterAll(async () => { await db?.close(); });

describe('balances come from verified collections', () => {
  it('a clean plan: verified = obligation, nothing outstanding, no exception', async () => {
    const r = byPlan(await register(), 1);
    expect([num(r.obligation), num(r.verified_collected), num(r.calc_outstanding), num(r.progress_pct), r.exceptions]).toEqual([1_320_000, 1_320_000, 0, 100, []]);
    expect([num(r.money_in_collected), num(r.pre_cutoff_collected)]).toEqual([1_320_000, 0]);
    expect([num(r.principal), num(r.fees), num(r.disbursed), num(r.books_receivable), r.receipts_count]).toEqual([1_000_000, 320_000, 1_000_000, 1_320_000, 2]);
  });
  it('reversed receipts (reversed_at or a [REVERSED: note) are never counted', async () => {
    const r = byPlan(await register(), 2);
    expect([num(r.verified_collected), num(r.reversed_amount), r.reversed_count, num(r.stored_repaid)]).toEqual([500_000, 400_000, 2, 900_000]);
    expect(num(r.calc_outstanding)).toBe(1_320_000 - 500_000);
    expect(num(r.repaid_without_receipts)).toBe(400_000);
    expect(r.exceptions).toContain('repaid_without_receipts');
  });
  it('the Wasajja Simon shape: 4,520,000 cut by an edit is not a repayment, counted once, and the plan is flagged', async () => {
    const r = byPlan(await register(), 3);
    expect([num(r.obligation), num(r.verified_collected), num(r.calc_outstanding), num(r.stored_outstanding)]).toEqual([5_340_000, 820_000, 4_520_000, 0]);
    expect([num(r.money_in_collected), num(r.pre_cutoff_collected)]).toEqual([820_000, 0]);
    expect([num(r.repaid_without_receipts), num(r.manual_reduction_total), r.manual_reduction_count]).toEqual([4_520_000, 4_520_000, 1]);
    expect([...r.exceptions].sort()).toEqual(['completed_with_balance', 'manual_balance_reduction', 'repaid_without_receipts']);
  });
  it('repayment records without a receipt count only when the ledger carries the cash', async () => {
    const r = byPlan(await register(), 4);
    expect([num(r.verified_collected), num(r.ledger_backed_amount), num(r.unverified_amount), r.unverified_count]).toEqual([200_000, 200_000, 100_000, 1]);
    expect(r.exceptions).toEqual(expect.arrayContaining(['unverified_repayment_records', 'repaid_without_receipts']));
  });
  it('collected more than owed is flagged', async () => {
    const r = byPlan(await register(), 9);
    expect([num(r.verified_collected), num(r.calc_outstanding), num(r.progress_pct)]).toEqual([1_400_000, 0, 100]);
    expect(r.exceptions).toEqual(expect.arrayContaining(['collected_more_than_owed', 'receipts_exceed_recorded']));
  });
});

describe('ledger and obligation checks', () => {
  it('a receipt from 1 Oct 2026 that is not on Money In is flagged and NOT counted; an earlier receipt counts', async () => {
    const r = byPlan(await register(), 5);
    expect(r.receipts_not_posted).toBe(1);
    expect(r.exceptions).toContain('receipt_not_in_ledger');
    expect([num(r.verified_collected), num(r.pre_cutoff_collected), num(r.money_in_collected)]).toEqual([150_000, 150_000, 0]);
  });
  it('from 1 Oct 2026 Money In is the basis: an entry without a receipt counts, a reversal nets out, a pre-October entry never counts', async () => {
    const r = byPlan(await register(), 11);
    expect([num(r.money_in_collected), num(r.pre_cutoff_collected), num(r.verified_collected), r.receipts_count]).toEqual([300_000, 0, 300_000, 0]);
  });
  it('rows the Money In page excludes (reclassification keys, non-production classification) are not counted', async () => {
    const r = byPlan(await register(), 12);
    expect([num(r.money_in_collected), num(r.verified_collected)]).toEqual([0, 0]);
  });
  it('books short of the obligation are flagged for plans funded from October only', async () => {
    const rows = await register();
    expect(byPlan(rows, 6).exceptions).toContain('books_obligation_mismatch');
    const legacy = byPlan(rows, 7);
    expect([legacy.is_legacy, legacy.exceptions.includes('books_obligation_mismatch')]).toEqual([true, false]);
  });
  it('an obligation lowered after funding is flagged', async () => {
    const r = byPlan(await register(), 8);
    expect(num(r.obligation_reduced)).toBe(180_000);
    expect(r.exceptions).toContain('obligation_reduced_after_funding');
  });
  it('only funded plans appear; schedule figures come from the payout clock', async () => {
    const rows = await register();
    expect(rows.find((r) => r.rent_request_id === P(10))).toBeUndefined();
    expect(rows).toHaveLength(11);
    const r = byPlan(rows, 1);
    const day = (d: unknown) => new Date(d as string).toISOString().slice(0, 10);
    expect([r.clock_bucket, num(r.arrears), r.days_behind, num(r.expected_to_date), day(r.clock_start), day(r.clock_end)])
      .toEqual(['counting', 100_000, 5, 100_000, '2026-10-02', '2026-10-31']);
  });
});

describe('plan detail', () => {
  const detail = async (n: number, uid = CFO) => asUser(uid, async () => (await db.query<Row>(`select public.get_cfo_tenant_repayment_detail($1) d`, [P(n)])).rows[0].d);
  it('lists every receipt, marks reversed ones and the ledger check', async () => {
    const d = await detail(2);
    expect(d.receipts.map((r: Row) => [num(r.amount), r.reversed])).toEqual([[100_000, true], [300_000, true], [500_000, false]]);
    expect(num(d.plan.verified_collected)).toBe(500_000);
    const d5 = await detail(5);
    expect(d5.receipts.map((r: Row) => [num(r.amount), r.ledger_checked, r.ledger_posted, r.counted])).toEqual([[250_000, true, false, false], [150_000, false, false, true]]);
    const d11 = await detail(11);
    expect(d11.money_in.map((m: Row) => [num(m.amount), m.direction, m.counted])).toEqual([[50_000, 'cash_out', true], [50_000, 'cash_in', true], [300_000, 'cash_in', true], [900_000, 'cash_in', false]]);
  });
  it('balance adjustments show who, when and why; the mirrored ops edit is listed once', async () => {
    const d = await detail(3);
    const kinds = d.adjustments.map((a: Row) => a.kind);
    expect(kinds.filter((k: string) => k === 'Tenant balance edit')).toHaveLength(1);
    expect(kinds.filter((k: string) => k.startsWith('Outstanding balance edit'))).toHaveLength(0);
    const edit = d.adjustments.find((a: Row) => a.kind === 'Tenant balance edit');
    expect([edit.by, edit.approved_by, edit.reason, num(edit.reduction)]).toEqual(['Ops Person', 'The CFO', 'system bal correction', 4_520_000]);
    expect(kinds).toContain('Approved change (cfo_approved_ops_payment_edit)');
  });
  it('repayment records show whether the ledger backs them; the ledger tab lists the plan entries', async () => {
    const d = await detail(4);
    expect(d.repayment_records.map((r: Row) => [num(r.amount), r.ledger_backed, r.counted])).toEqual([[100_000, false, false], [200_000, true, true]]);
    expect(d.ledger.map((l: Row) => l.category)).toEqual(['tenant_repayment']);
  });
  it('an unknown or never-funded plan is refused', async () => {
    await expect(detail(10)).rejects.toThrow(/not found or never funded/);
  });
});

describe('permissions, grants and read-only', () => {
  it('CFO and super_admin can read; manager, finance ops, CEO, an agent and no user cannot', async () => {
    expect((await register(CFO)).length).toBe(11);
    expect((await register(SA)).length).toBe(11);
    for (const uid of [MGR, FINOPS, CEO, AGENT]) await expect(register(uid)).rejects.toThrow(/Not authorized/);
    await expect(db.query(`select * from public.get_cfo_tenant_repayment_register()`)).rejects.toThrow(/Not authorized/);
    await expect(asUser(MGR, () => db.query(`select public.get_cfo_tenant_repayment_detail($1)`, [P(1)]))).rejects.toThrow(/Not authorized/);
  });
  it('grants: signed-in users may call the two entry points (each checks the role); anon may not; the helpers are closed', async () => {
    const g = (await db.query<Row>(`select
      has_function_privilege('authenticated', 'public.get_cfo_tenant_repayment_register()', 'EXECUTE') reg_auth,
      has_function_privilege('anon', 'public.get_cfo_tenant_repayment_register()', 'EXECUTE') reg_anon,
      has_function_privilege('authenticated', 'public.get_cfo_tenant_repayment_detail(uuid)', 'EXECUTE') det_auth,
      has_function_privilege('anon', 'public.get_cfo_tenant_repayment_detail(uuid)', 'EXECUTE') det_anon,
      has_function_privilege('authenticated', 'public._cfo_tenant_repayment_rows(uuid)', 'EXECUTE') rows_auth,
      has_function_privilege('authenticated', 'public._cfo_tenant_repayment_can_view()', 'EXECUTE') gate_auth`)).rows[0];
    expect(g).toEqual({ reg_auth: true, reg_anon: false, det_auth: true, det_anon: false, rows_auth: false, gate_auth: false });
  });
  it('every function is STABLE (Postgres refuses writes inside it) and SECURITY DEFINER with a fixed search_path', async () => {
    const f = (await db.query<Row>(`select proname, provolatile, prosecdef, proconfig from pg_proc
      where proname in ('_cfo_tenant_repayment_rows', '_cfo_tenant_repayment_can_view', 'get_cfo_tenant_repayment_register', 'get_cfo_tenant_repayment_detail') order by 1`)).rows;
    expect(f).toHaveLength(4);
    for (const x of f) {
      expect([x.proname, x.provolatile, x.prosecdef]).toEqual([x.proname, 's', true]);
      expect(String(x.proconfig)).toContain('search_path=public');
    }
  });
  it('reading changes nothing in any table', async () => {
    const before = await snapshot();
    await register(); await register(SA);
    await asUser(CFO, () => db.query(`select public.get_cfo_tenant_repayment_detail($1)`, [P(3)]));
    expect(await snapshot()).toBe(before);
  });
  it('neither migration creates a table or writes data; rolling back 120000 restores 090000, rolling back 090000 removes all four', async () => {
    for (const m of [MIG, MIG2]) {
      const body = m.replace(/--[^\n]*/g, '');
      expect(body).not.toMatch(/\b(CREATE|ALTER|DROP)\s+TABLE\b/i);
      expect(body).not.toMatch(/\bINSERT\s+INTO\b|\bUPDATE\s+public\.|\bDELETE\s+FROM\b|\bTRUNCATE\b/i);
    }
    const x = new PGlite();
    await x.exec(SCHEMA); await x.exec(MIG); await x.exec(MIG2);
    await x.exec(`create schema supabase_migrations; create table supabase_migrations.schema_migrations (version text);`);
    await x.exec(RB2);
    const cols = (await x.query<Row>(`select pg_get_function_result('public.get_cfo_tenant_repayment_register()'::regprocedure) r`)).rows[0].r;
    expect(cols).not.toContain('money_in_collected');
    expect((await x.query<Row>(`select has_function_privilege('authenticated', 'public.get_cfo_tenant_repayment_register()', 'EXECUTE') ok`)).rows[0].ok).toBe(true);
    await x.exec(RB);
    const left = (await x.query<Row>(`select count(*)::int n from pg_proc where proname like '%cfo_tenant_repayment%'`)).rows[0].n;
    expect(left).toBe(0);
    await x.close();
  });
});
