// @vitest-environment node
/**
 * Merchandise receivables reconciliation (supabase/migrations/20261104180000_merchandise_receivables_reconciliation.sql):
 * the CMO dashboard and the Agent Products & Services page reconcile to A12 + A13 on the balance sheet.
 *
 * Runs on PGlite with production's code verbatim over the merchandise replica (fixtures as merchandisePhase3.test.ts,
 * plus production's get_agent_products_overview, scripts/fixtures/agent-products-overview-prod-2026-11-04.sql), with
 * production's merchandise migrations applied in order (20261104090000, 20261104100000, 20261104150000).
 *
 * Proves: preflight; issued orders + plans with no order = A12 + A13 from the balance-sheet resolver, to the cent; only
 * issued orders count, orders awaiting issue are apart; plan balance = ledger + amounts not in the ledger; it still
 * ties after the stock migration; authorisation and grants; read-only; the overview no longer counts cancelled plans
 * and carries the balance-sheet receivable; rollback.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// each call recomputes every order over the replica; under a parallel run 5s is too short
vi.setConfig({ testTimeout: 60_000 });

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const ONEOFF = read('supabase/migrations/20261104090000_merchandise_a12_a13_corrections.sql');
const CONTROLS = read('supabase/migrations/20261104100000_merchandise_receivable_controls.sql');
const PHASE3 = read('supabase/migrations/20261104150000_merchandise_phase3_stock_phone_pledge.sql');
const RECON = read('supabase/migrations/20261104180000_merchandise_receivables_reconciliation.sql');
const ROLLBACK = read('supabase/rollbacks/20261104180000_merchandise_receivables_reconciliation.rollback.sql');
const PROD3B = read('scripts/fixtures/merch-phase3b-prod-2026-11-04.sql');
const PROD = read('scripts/fixtures/merch-a12a13-prod-2026-11-04.sql');
const PROD2 = read('scripts/fixtures/merch-controls-prod-2026-11-04.sql');
const PROD3 = read('scripts/fixtures/merch-phase3-prod-2026-11-04.sql');
const SOFP_ALL = read('scripts/fixtures/sofp-prod-2026-11-02.sql');
const SOFP = SOFP_ALL.slice(SOFP_ALL.indexOf('CREATE OR REPLACE FUNCTION public.sofp_ledger_legs'),
  SOFP_ALL.indexOf('CREATE OR REPLACE FUNCTION public.get_statement_of_financial_position'));

type Ddl = Record<string, Array<{ c: string; t: string; d: string | null }>>;
interface RawLeg { id: string; gid: string; sc: string; cat: string; dir: string; amt: number; st: string | null; sid: string | null;
  ref: string | null; idem: string | null; td: string; ca: string; bk: string | null; uid: string | null; cls: string | null }
const FIX = JSON.parse(read('scripts/fixtures/merch-a12a13-prod-2026-11-04.json')) as {
  plans: unknown[]; sales: Array<Record<string, unknown>>; schedules: unknown[]; legs: RawLeg[]; map: unknown[]; integrity: unknown[]; ddl: Ddl;
};
const FIX2 = JSON.parse(read('scripts/fixtures/merch-controls-prod-2026-11-04.json')) as { ddl: Ddl; bike_leases: unknown[] };
const FIX3 = JSON.parse(read('scripts/fixtures/merch-phase3-prod-2026-11-04.json')) as {
  ddl: Ddl; pledges: unknown[]; phones: Array<[string, number]>; stock: Array<[string, number]>; rejected_bikes: string[];
  md5: Record<string, string>;
};

const FIX3B = JSON.parse(read('scripts/fixtures/merch-phase3b-prod-2026-11-04.json')) as {
  ddl: Ddl; advances: Array<Record<string, unknown>>; legs: Array<Record<string, unknown>>; cash_sales: unknown[];
  totals: { advances: number; net: number }; md5: Record<string, string>;
};
const DEF_OK = /^(gen_random_uuid\(\)|now\(\)|true|false|-?\d+(\.\d+)?|'[^']*'::[\w ]+(\[\])?)$/;
const ddlOf = (src: Ddl, t: string) => `create table public.${t} (${src[t].map((c) =>
  `"${c.c}" ${c.t}${c.d && DEF_OK.test(c.d) ? ` default ${c.d}` : ''}`).join(', ')});`;
const ROLES = ['tenant', 'agent', 'landlord', 'supporter', 'manager', 'ceo', 'coo', 'cfo', 'cto', 'cmo', 'crm', 'employee', 'operations',
  'super_admin', 'hr', 'senior_agent', 'sub_agent', 'admin', 'tenant_ops', 'landlord_ops', 'agent_ops', 'financial_ops', 'partner_ops', 'access_admin', 'rd'];
const CFO = '00000000-0000-0000-0000-0000000000cf';
const OPS = '00000000-0000-0000-0000-00000000000a';
const STANDINS = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create type public.solvency_bypass_reason as enum ('cfo_override');
${['general_ledger', 'ledger_account_map', 'ledger_integrity_config', 'merchandise_recovery_plans', 'merchandise_sales', 'smartphone_repayment_schedules']
    .map((t) => ddlOf(FIX.ddl, t)).join('\n')}
${['merchandise_recovery_deductions', 'audit_logs', 'agent_bike_leases', 'agent_bike_lease_schedules', 'system_events'].map((t) => ddlOf(FIX2.ddl, t)).join('\n')}
${['smartphone_roi_pledges', 'smartphone_roi_pledge_applications', 'notifications'].map((t) => ddlOf(FIX3.ddl, t)).join('\n')}
${['agent_advances', 'agent_advance_ledger', 'investor_portfolios'].map((t) => ddlOf(FIX3B.ddl, t)).join('\n')}
create function public._prepare_bike_priority(p uuid) returns numeric language sql stable as $$ select 1e15::numeric $$;
create function public.agent_advance_is_post_effective(p uuid) returns boolean language sql stable as $$ select false $$;
create function public.is_partner_ops(p uuid) returns boolean language sql stable as $$ select true $$;
create function public.can_view_staff_reports(p uuid) returns boolean language sql stable as $$ select true $$;
create table public.profiles (id uuid primary key, is_test boolean default false, full_name text, phone text);
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select coalesce(nullif(current_setting('test.uid', true), '')::uuid, '${CFO}'::uuid) $$;
create type public.app_role as enum (${ROLES.map((r) => `'${r}'`).join(', ')});
create table public.test_roles (user_id uuid, role text);
insert into public.test_roles values ('${CFO}', 'cfo'), ('${OPS}', 'agent_ops');
create table public.user_roles (user_id uuid, role text, enabled boolean default true);
insert into public.user_roles values ('${OPS}', 'agent_ops', true);
create function public.has_role(p_user uuid, p_role public.app_role) returns boolean language sql stable as
  $$ select exists (select 1 from public.test_roles where user_id = p_user and role = p_role::text) $$;
create function public.staff_mfa_ok() returns boolean language sql stable as $$ select true $$;
create function public.is_cfo_approver(p uuid) returns boolean language sql stable as $$ select true $$;
create function public.can_cfo_disburse_bike_leases(p uuid) returns boolean language sql stable as $$ select true $$;
create function public.can_act_pinned_finance_action(p uuid) returns boolean language sql stable as $$ select true $$;
create table public.test_avail (user_id uuid primary key, amt numeric);
create function public.get_user_available_balance(p uuid) returns numeric language sql stable as $$ select coalesce((select amt from public.test_avail where user_id = p), 0) $$;
create table public.wallets (id uuid default gen_random_uuid(), user_id uuid unique, withdrawable_balance numeric default 0);
create table public.wallet_fresh_start_anchors (user_id uuid, anchor_at timestamptz);
create table public.wallet_routing_violations (user_id uuid, category text, direction text, amount numeric, recipient_type text, reason text, context jsonb);
create table public.treasury_controls (control_key text, enabled boolean);
create table public.ledger_mapped_balance_violations (transaction_group_id uuid primary key, mapped_debits numeric, mapped_credits numeric, residual numeric, source_table text, leg_shape text, detected_at timestamptz default now());
create table public.smartphone_catalog (id uuid, brand text, model_name text, supplier_id uuid);
create table public.merchandise_catalog (id uuid default gen_random_uuid(), item_name text, unit_price numeric, unit_cost numeric, fulfilment_type text);
-- production's catalog rows for the items in these tests (read-only export 2026-11-04)
insert into public.merchandise_catalog (item_name, unit_price, unit_cost, fulfilment_type) values
  ('Press Jacket', 55000, 50000, 'company_issued'), ('Welile Polo', 35000, 25000, 'company_issued'),
  ('waiting chair', 650000, 0, 'outsourced'), ('office chair', 500000, 0, 'outsourced');
create function public.wallet_route_for_category(p_user uuid, p_category text, p_direction text) returns table(bucket text, sign numeric) language sql stable as $$ select null::text, null::numeric where false $$;
create function public.assert_routing_compatible(p_category text, p_recipient text) returns void language sql as $$ select $$;
insert into public.treasury_controls values ('strict_mode', true);
`;
const TRIGGERS = `
create trigger trg_validate_ledger_category before insert on public.general_ledger for each row execute function public.validate_ledger_category();
create constraint trigger trg_enforce_ledger_group_balance after insert on public.general_ledger deferrable initially deferred for each row execute function public.enforce_ledger_group_balance();
create constraint trigger trg_enforce_ledger_group_mapped_balance after insert on public.general_ledger deferrable initially deferred for each row execute function public.enforce_ledger_group_mapped_balance();
create trigger trg_merchandise_sale_cascade_recovery before delete on public.merchandise_sales for each row execute function public.merchandise_sale_cascade_recovery();
`;
const LEGS = FIX.legs.map((l) => ({ id: l.id, transaction_group_id: l.gid, ledger_scope: l.sc, category: l.cat, direction: l.dir, amount: l.amt,
  source_table: l.st, source_id: l.sid, reference_id: l.ref, idempotency_key: l.idem, transaction_date: l.td, created_at: l.ca,
  wallet_bucket: l.bk, user_id: l.uid, classification: l.cls }));
const BIG = 50_000_000;

async function build(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(STANDINS);
  await db.exec(PROD);
  await db.exec(PROD2);
  await db.exec(PROD3);
  await db.exec(PROD3B);
  await db.exec(SOFP);
  const load = async (t: string, r: unknown[]) =>
    db.query(`insert into public.${t} select * from json_populate_recordset(null::public.${t}, $1::json)`, [JSON.stringify(r)]);
  await load('ledger_account_map', FIX.map);
  await load('ledger_integrity_config', FIX.integrity);
  await load('merchandise_recovery_plans', FIX.plans);
  await load('merchandise_sales', FIX.sales);
  await load('smartphone_repayment_schedules', FIX.schedules);
  await load('general_ledger', LEGS);
  await load('agent_bike_leases', FIX2.bike_leases);
  await load('smartphone_roi_pledges', FIX3.pledges);
  await load('agent_advances', FIX3B.advances);
  await load('general_ledger', FIX3B.legs);
  await load('merchandise_sales', FIX3B.cash_sales);
  await db.exec(TRIGGERS);
  await db.exec(ONEOFF);
  await db.exec(CONTROLS);
  return db;
}
const num = (v: unknown) => Number(v);
async function rows<T = Record<string, unknown>>(db: PGlite, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}
async function fnMd5(db: PGlite, sig: string): Promise<string | null> {
  return (await rows<{ m: string | null }>(db, `select (select md5(replace(prosrc, chr(13), '')) from pg_proc where oid = to_regprocedure($1)) m`, [sig]))[0].m;
}
async function as<T>(db: PGlite, uid: string, fn: () => Promise<T>): Promise<T> {
  await db.query(`select set_config('test.uid', $1, false)`, [uid]);
  try { return await fn(); } finally { await db.query(`select set_config('test.uid', '', false)`); }
}
async function fund(db: PGlite, user: string, amt = BIG) {
  await db.query(`insert into public.wallets (user_id, withdrawable_balance) values ($1, $2) on conflict (user_id) do update set withdrawable_balance = excluded.withdrawable_balance`, [user, amt]);
  await db.query(`insert into public.general_ledger (user_id, ledger_scope, direction, category, amount, wallet_bucket, classification, description, transaction_date, created_at)
    values ($1, 'wallet', 'cash_in', 'wallet_deposit', $2, 'withdrawable', 'production', 'test seed', '2026-01-01', '2026-01-01')`, [user, amt]);
  await db.query(`insert into public.test_avail values ($1, $2) on conflict (user_id) do update set amt = excluded.amt`, [user, amt]);
}
/** Resolver balance by account, for all legs or for the groups selected by a sub-query. */
async function acct(db: PGlite, groupsSql?: string, params: unknown[] = []): Promise<Record<string, number>> {
  const r = await rows<{ a: string; n: string }>(db, `select account_code a, sum(dr - cr) n from sofp_ledger_legs(now() + interval '1 day')
    ${groupsSql ? `where transaction_group_id in (${groupsSql})` : ''} group by 1`, params);
  return Object.fromEntries(r.map((x) => [x.a, num(x.n)]));
}
async function saleAcct(db: PGlite, sale: string) {
  return acct(db, `select transaction_group_id from general_ledger where source_id = $1
    or source_id in (select id from merchandise_recovery_plans where sale_id = $1)`, [sale]);
}
async function received(db: PGlite) {
  const day = (await rows<{ d: string }>(db, `select ((now() at time zone 'Africa/Kampala')::date)::text d`))[0].d;
  const t = await rows<{ category_key: string; amount: string }>(db, `select category_key, amount from get_cfo_received_by_category_totals($1::date, $1::date)`, [day]);
  const g = await rows<{ id: string }>(db, `select id from get_cfo_received_by_category_page($1::date, $1::date, null, null, null, 0, 1000)`, [day]);
  return { t: Object.fromEntries(t.map((x) => [x.category_key, num(x.amount)])), n: g.length };
}
const t0 = async (db: PGlite) => (await rows<{ t: string }>(db, `select clock_timestamp()::text t`))[0].t;
async function effects(db: PGlite, since: string, customer?: string) {
  const who = customer ? ` where customer_id = '${customer}'` : '';
  return {
    wallet: await rows(db, `select user_id, direction, category, amount, wallet_bucket, recipient_type, description, source_table, source_id, reference_id
      from general_ledger where ledger_scope = 'wallet' and created_at >= $1 and description <> 'test seed' order by source_id, category, amount`, [since]),
    platform: await rows<{ category: string; direction: string; amount: string; source_id: string }>(db, `select ledger_scope, category, direction, amount, source_table, source_id
      from general_ledger where ledger_scope <> 'wallet' and created_at >= $1 order by source_id, category`, [since]),
    sales: await rows(db, `select id, order_status, payment_status, amount_paid, amount_outstanding, total_revenue, disbursed_amount, payment_projection,
      total_repayable, access_daily_amount, supplier_id, cfo_disbursed_by, handed_over_by from merchandise_sales${who} order by id`),
    plans: await rows(db, `select sale_id, customer_id, item_name, original_amount, outstanding_balance, amount_recovered, daily_rate, daily_deduction_amount,
      status, due_balance from merchandise_recovery_plans${who} order by sale_id, item_name, original_amount, outstanding_balance`),
    deductions: await rows(db, `select plan_id, customer_id, item_name, amount, withdrawable_before, outstanding_after from merchandise_recovery_deductions
      where created_at >= $1 order by plan_id, amount`, [since]),
    pledges: await rows(db, `select user_id, plan_id, reference, roi_amount, pledged_amount, applied_amount, outstanding_after from smartphone_roi_pledge_applications order by reference`),
    schedules: await rows(db, `select sale_id, month_index, principal_due, charge_due, total_due from smartphone_repayment_schedules order by sale_id, month_index`),
  };
}

// ---------------------------------------------------------------- extra stand-ins the Agent Products overview reads
const OVERVIEW_EXTRAS = `
alter table public.profiles add column if not exists avatar_url text, add column if not exists territory text;
alter table public.merchandise_catalog add column if not exists is_active boolean default true;
alter table public.smartphone_catalog add column if not exists is_active boolean default true, add column if not exists default_amount numeric;
create table if not exists public.service_centre_setups (id uuid default gen_random_uuid(), location_name text, agent_id uuid, agent_name text, status text);
create table if not exists public.merchandise_purchases (id uuid default gen_random_uuid(), item_name text, quantity numeric, total_cost numeric);
`;
const OVERVIEW_OLD = read('scripts/fixtures/agent-products-overview-prod-2026-11-04.sql');
const OVERVIEW_MD5 = '48c04e6e74f9e66bc5e60061ffab38df';
const STRANGER = '00000000-0000-0000-0000-0000000000ee';
const AG = '00000000-0000-0000-0000-000000000ab1';

async function buildR(withRecon = true): Promise<PGlite> {
  const db = await build();
  await db.exec(PHASE3);
  await db.exec(OVERVIEW_EXTRAS);
  await db.exec(OVERVIEW_OLD);
  // every order's customer is an agent, as on the page (the overview requires the agent role outside boutique)
  await db.exec(`insert into public.user_roles (user_id, role) select distinct customer_id, 'agent' from public.merchandise_sales where customer_id is not null`);
  if (withRecon) await db.exec(RECON);
  return db;
}
type Recon = {
  orders: Array<{ sale_id: string; issued: boolean; ledger_receivable: number; plan_balance: number; not_in_ledger: number;
    awaiting_recognition: number; note: string | null; no_customer_account: boolean; order_status: string }>;
  orphan_plans: Array<{ plan_id: string; ledger_receivable: number }>;
  awaiting_issue: { count: number; value: number };
  totals: Record<string, number>;
  balance_sheet: { a12: number; a13: number; total: number; difference: number } | null;
};
async function recon(db: PGlite, bs = true): Promise<Recon> {
  return as(db, CFO, async () => (await rows<{ j: Recon }>(db, `select get_merchandise_receivables_reconciliation($1) j`, [bs]))[0].j);
}
async function overview(db: PGlite, cat: string | null = null) {
  return as(db, CFO, async () => (await rows<{ j: { kpis: Record<string, number>; rows: Array<Record<string, unknown>> } }>(db,
    `select get_agent_products_overview($1) j`, [cat]))[0].j);
}
const r2 = (n: number) => Math.round(n * 100) / 100;

let oldDb: PGlite;
let newDb: PGlite;
beforeAll(async () => { oldDb = await buildR(false); newDb = await buildR(true); }, 400_000);
afterAll(async () => { await oldDb?.close(); await newDb?.close(); });

describe('order and preflight', () => {
  it('starts from production\'s Agent Products overview', async () => {
    expect(await fnMd5(oldDb, 'public.get_agent_products_overview(text)')).toBe(OVERVIEW_MD5);
  });
  it('refuses when the overview has changed in production, changing nothing', async () => {
    const db = await buildR(false);
    await db.exec(`create or replace function public.get_agent_products_overview(p_category text default null) returns jsonb language sql as $$ select '{}'::jsonb $$`);
    await expect(db.exec(RECON)).rejects.toThrow(/production definitions differ/);
    expect(await fnMd5(db, 'public.get_merchandise_receivables_reconciliation(boolean)')).toBeNull();
    await db.close();
  }, 400_000);
});

describe('reconciliation ties to the balance sheet', () => {
  it('issued orders + plans with no order + other orders = A12 + A13 on the Statement of Financial Position, to the cent', async () => {
    const r = await recon(newDb);
    const bs = await acct(newDb);
    expect(r.balance_sheet!.a12).toBeCloseTo(bs.A12 ?? 0, 2);
    expect(r.balance_sheet!.a13).toBeCloseTo(bs.A13 ?? 0, 2);
    expect(r2(r.balance_sheet!.difference)).toBe(0);
    expect(r2(r.totals.ledger_issued + r.totals.ledger_not_issued + r.totals.ledger_orphan_plans)).toBe(r2(r.totals.ledger_total));
    expect(r2(r.totals.ledger_total)).toBe(r2((bs.A12 ?? 0) + (bs.A13 ?? 0)));
  });
  it('the two plans with no order (Saka Homi Melvin, 108,700) are listed', async () => {
    const r = await recon(newDb, false);
    expect(r.orphan_plans.length).toBe(2);
    expect(r2(r.totals.ledger_orphan_plans)).toBe(108_700);
    expect(r.balance_sheet).toBeNull();
  });
  it('only issued orders are receivables; plan balance = ledger + amounts not in the ledger (future charges, stock awaiting recognition)', async () => {
    const r = await recon(newDb, false);
    for (const o of r.orders.filter((x) => x.issued)) {
      expect(['issued', 'approved', 'completed']).toContain(o.order_status);
      expect(r2(o.plan_balance - o.ledger_receivable - o.not_in_ledger), o.sale_id).toBe(0);
    }
    expect(r2(r.totals.plan_balance_issued - r.totals.ledger_issued)).toBe(r2(r.totals.awaiting_recognition + r.totals.not_in_ledger_other));
    // the 7 company-stock items Phase 3 queued
    expect(r.totals.awaiting_recognition).toBe(1_015_000);
    expect(r.orders.filter((o) => o.note === 'awaiting_recognition').length).toBe(7);
  });
  it('orders awaiting issue are reported apart and never as a receivable', async () => {
    const P = '00000000-0000-0000-0000-000000000ab2';
    await newDb.query(`insert into profiles (id, full_name) values ($1, 'Pending Agent') on conflict do nothing`, [AG]);
    const before = await recon(newDb, false);
    await newDb.query(`insert into merchandise_sales (id, customer_id, item_name, quantity, unit_price, total_revenue, amount_outstanding, amount_paid,
      payment_plan, order_status, created_at) values ($1, $2, 'Company Ids', 45000, 45000, 2025000000, 2025000000, 0, 'installment', 'pending_approval', now())`, [P, AG]);
    await newDb.query(`insert into merchandise_recovery_plans (sale_id, customer_id, item_name, original_amount, outstanding_balance, amount_recovered, status, created_at)
      values ($1, $2, 'Company Ids', 2025000000, 2025000000, 0, 'active', now())`, [P, AG]);
    const after = await recon(newDb, false);
    expect(after.awaiting_issue.count).toBe(before.awaiting_issue.count + 1);
    expect(after.awaiting_issue.value - before.awaiting_issue.value).toBe(2_025_000_000);
    expect(after.totals.plan_balance_issued).toBe(before.totals.plan_balance_issued);
    expect(after.totals.ledger_total).toBe(before.totals.ledger_total);
    expect(after.orders.some((o) => o.sale_id === P)).toBe(false);
  });
  it('after the stock migration (20261104170000) nothing awaits recognition and it still ties', async () => {
    const db = await buildR(true);
    await db.exec(read('supabase/migrations/20261104170000_merchandise_stock_recognise_on_issue.sql'));
    const r = await recon(db);
    expect(r.totals.awaiting_recognition).toBe(0);
    expect(r2(r.balance_sheet!.difference)).toBe(0);
    expect(r2(r.balance_sheet!.a12 - (await recon(newDb)).balance_sheet!.a12)).toBe(1_015_000);
    await db.close();
  }, 400_000);
  it('only staff who may see Agent Products; app users without the role are refused', async () => {
    await expect(as(newDb, STRANGER, () => newDb.query(`select get_merchandise_receivables_reconciliation(false)`))).rejects.toThrow(/Not authorized/);
    const g = await rows<{ a: boolean; b: boolean }>(newDb, `select
      has_function_privilege('authenticated', 'public.get_merchandise_receivables_reconciliation(boolean)', 'EXECUTE') a,
      has_function_privilege('anon', 'public.get_merchandise_receivables_reconciliation(boolean)', 'EXECUTE') b`);
    expect(g[0]).toEqual({ a: true, b: false });
  });
  it('reads only: no ledger, order or plan row written', async () => {
    const snap = async () => JSON.stringify(await rows(newDb, `select (select count(*) from general_ledger) g, (select count(*) from merchandise_sales) s,
      (select sum(outstanding_balance) from merchandise_recovery_plans) p`));
    const s0 = await snap();
    await recon(newDb);
    await overview(newDb);
    expect(await snap()).toBe(s0);
  });
});

describe('Agent Products overview', () => {
  it('cancelled plans are no longer counted (each order counted once); everything else unchanged', async () => {
    // production: 11 issued boutique orders carry a cancelled plan next to the active one with the same balance
    const base0 = await overview(newDb, 'boutique');
    const [{ id: sale, b }] = await rows<{ id: string; b: string }>(newDb, `select s.id, p.outstanding_balance b from merchandise_sales s
      join merchandise_recovery_plans p on p.sale_id = s.id and p.status = 'active'
      where s.order_status = 'issued' and public.agent_product_category(s.item_name) = 'boutique' and p.outstanding_balance > 0 order by s.id limit 1`);
    for (const db of [oldDb, newDb]) {
      await db.query(`insert into merchandise_recovery_plans (sale_id, customer_id, item_name, original_amount, outstanding_balance, amount_recovered, status, created_at)
        select sale_id, customer_id, item_name, original_amount, outstanding_balance, 0, 'cancelled', created_at - interval '1 day'
        from merchandise_recovery_plans where sale_id = $1 and status = 'active'`, [sale]);
    }
    const o = await overview(oldDb, 'boutique');
    const n = await overview(newDb, 'boutique');
    expect(r2(num(o.kpis.in_field_outstanding) - num(n.kpis.in_field_outstanding))).toBe(r2(num(b)));
    expect(num(n.kpis.in_field_outstanding)).toBe(num(base0.kpis.in_field_outstanding));
    // (pending_applications differs only by the pending order an earlier test added to newDb)
    for (const k of ['in_field_items', 'in_field_agents', 'in_field_amount', 'in_field_repaid']) expect(n.kpis[k], k).toEqual(o.kpis[k]);
  });
  it('carries the balance-sheet receivable per agent and in the KPIs, equal to the reconciliation for the same orders', async () => {
    const r = await recon(newDb, false);
    let all = 0;
    for (const cat of ['boutique', 'smart_phone', 'motor_bike', 'signage']) {
      const n = await overview(newDb, cat);
      const sumRows = n.rows.reduce((a, x) => a + num(x.ledger_receivable), 0);
      expect(r2(num(n.kpis.in_field_ledger_receivable)), cat).toBe(r2(sumRows));
      all += num(n.kpis.in_field_ledger_receivable);
    }
    // the page lists issued orders; the reconciliation adds the plans with no order
    expect(r2(all)).toBe(r2(r.totals.ledger_issued));
  });
});

describe('rollback', () => {
  it('restores production\'s overview and drops the reconciliation', async () => {
    const db = await buildR(true);
    await db.exec(ROLLBACK);
    expect(await fnMd5(db, 'public.get_agent_products_overview(text)')).toBe(OVERVIEW_MD5);
    expect(await fnMd5(db, 'public.get_merchandise_receivables_reconciliation(boolean)')).toBeNull();
    await db.close();
  }, 400_000);
});
