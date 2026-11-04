// @vitest-environment node
/**
 * Agent Advances permanent controls (supabase/migrations/20261104230000_agent_advance_transfer_controls.sql), CFO 2026-11-04.
 *
 * Runs on PGlite with production's code verbatim: the merchandise replica (ledger, posting engine, resolver, advance tables) plus
 * production's advance functions (scripts/fixtures/agent-advance-prod-2026-11-04.sql: cancel, CFO-initiated create, disburse,
 * top-up, manual payment, allocation, the Money paid reports) and the full ledger_account_map.
 *
 * Proves: preflight / install / replay; genuine payouts and repayments unchanged; accounting-only transfers (replacement,
 * existing, ROI, partnership, partial, legacy) with no wallet leg and no duplicate receivable; payout-as-transfer refused unless
 * [NEW MONEY]; duplicate submissions refused; reversals linked and capped, advance payout reversals reduce the advance;
 * cancellation needs a transfer, recoup or an approved write-off (two people), posted to X4 and kept out of Money paid;
 * exceptions flag every historical pattern and none of the clean flows; historical data untouched; rollback.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 120_000 });

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const ONEOFF = read('supabase/migrations/20261104090000_merchandise_a12_a13_corrections.sql');
const CONTROLS = read('supabase/migrations/20261104100000_merchandise_receivable_controls.sql');
const PHASE3 = read('supabase/migrations/20261104150000_merchandise_phase3_stock_phone_pledge.sql');
const ONISSUE = read('supabase/migrations/20261104170000_merchandise_stock_recognise_on_issue.sql');
const ROLLBACK = read('supabase/rollbacks/20261104170000_merchandise_stock_recognise_on_issue.rollback.sql');
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

// ---------------------------------------------------------------- agent advance harness (production definitions)
const ADV = JSON.parse(read('scripts/fixtures/agent-advance-prod-2026-11-04.json')) as {
  ddl: Ddl; checks: Array<{ t: string; n: string; def: string }>; map: Array<Record<string, unknown>>; md5: Record<string, string>;
};
const ADV_SQL = read('scripts/fixtures/agent-advance-prod-2026-11-04.sql');
const MIG = read('supabase/migrations/20261104230000_agent_advance_transfer_controls.sql');
const RB = read('supabase/rollbacks/20261104230000_agent_advance_transfer_controls.rollback.sql');
const EDGE = read('supabase/functions/finops-wallet-move/index.ts');
const MGR = '00000000-0000-0000-0000-0000000000a9';   // a second approver (CEO)
const AG1 = '00000000-0000-0000-0000-00000000ad01';
const AG2 = '00000000-0000-0000-0000-00000000ad02';
const SIGS = ['cancel_agent_advance(uuid,boolean,text)', 'cfo_create_advance(uuid,numeric,integer,numeric,text,text,boolean,text)',
  'disburse_agent_advance_request(uuid,numeric,integer,numeric,text,text,text,text,numeric)', 'apply_advance_topup(uuid,numeric,integer,uuid,text,boolean)',
  'cfo_record_advance_payment(uuid,numeric,text,text,text)', 'get_cfo_paid_by_category_totals(date,date)',
  'get_cfo_paid_by_category_page(date,date,text,text,integer,integer)'];
const ADV_STANDINS = `
${['agent_advance_requests', 'agent_advance_topups', 'staff_permissions'].map((t) => ddlOf(ADV.ddl, t)).join('\n')}
alter table public.agent_advances add primary key (id); alter table public.agent_advance_requests add primary key (id); alter table public.agent_advance_topups add primary key (id);
create table if not exists public.staff_requisitions (wallet_transaction_id uuid, wallet_credit_status text, department_key text);
create table if not exists public.employee_requisitions (wallet_transaction_id uuid, wallet_credit_status text, department text);
create function public.agent_advance_blocking_gates(p_agent uuid, p_principal numeric, p_rate numeric) returns jsonb language sql stable as $$ select '{"gates":[]}'::jsonb $$;
create function public.agent_advance_topup_eligibility(p_agent uuid) returns jsonb language sql stable as $$ select '{"eligible":false,"reason":"test"}'::jsonb $$;
create function public._cfo_paid_category_for(p text) returns text language sql immutable as $$ select case when p = 'platform_loss_writeoff' then 'budget' end $$;
`;
async function buildA(withMig = true): Promise<PGlite> {
  const db = await build();
  await db.exec(ADV_STANDINS);
  for (const c of ADV.checks) {
    await db.exec(`alter table ${c.t.startsWith('public.') ? c.t : 'public.' + c.t} drop constraint if exists ${c.n}; alter table ${c.t.startsWith('public.') ? c.t : 'public.' + c.t} add constraint ${c.n} ${c.def}`);
  }
  await db.query(`insert into public.ledger_account_map select * from json_populate_recordset(null::public.ledger_account_map, $1::json) m
    where not exists (select 1 from public.ledger_account_map x where x.ledger_scope = m.ledger_scope and x.category = m.category and x.wallet_bucket is not distinct from m.wallet_bucket)`,
    [JSON.stringify(ADV.map)]);
  await db.exec(ADV_SQL);
  await db.exec(`insert into public.test_roles values ('${MGR}', 'ceo'), ('${CFO}', 'manager');
    insert into public.profiles (id, full_name) values ('${AG1}', 'Advance Agent One'), ('${AG2}', 'Advance Agent Two') on conflict do nothing;`);
  for (const a of [AG1, AG2]) await fund(db, a, 1000);
  if (withMig) await db.exec(MIG);
  return db;
}
async function cfo<T = Record<string, unknown>>(db: PGlite, sql: string, params: unknown[] = []): Promise<T> {
  return as(db, CFO, async () => (await rows<{ j: T }>(db, `select ${sql} j`, params))[0].j);
}
let nAdv = 0;
/** A genuine advance through the real flow: CFO-initiated request, then disbursement (wallet credit). */
async function issue(db: PGlite, agent: string, principal: number, reason = 'Working capital for the service centre') {
  nAdv += 1;
  // genuine payouts in these tests are new money by construction (the look-alike guard is tested on its own)
  if (!reason.includes('[NEW MONEY]')) reason = `[NEW MONEY] ${reason}`;
  const req = await cfo<{ request: { id: string } }>(db, `public.cfo_create_advance($1, $2, 30, 0.2, 'daily', $3, false, null)`, [agent, principal, `${reason} #${nAdv}`]);
  const out = await cfo<{ advance_id?: string }>(db, `public.disburse_agent_advance_request(p_request_id => $1)`, [req.request.id]);
  const adv = (await rows<{ id: string }>(db, `select id from agent_advances where request_id = $1`, [req.request.id]))[0].id;
  return { request: req.request.id, advance: adv, out };
}
async function book(db: PGlite, adv: string) {
  const b = (await rows<{ b: { a10: string; a11: string; a20: string } }>(db, `select public._agent_advance_book_balance($1) b`, [adv]))[0].b;
  return { a10: num(b.a10), a11: num(b.a11), a20: num(b.a20) };
}
async function advRow(db: PGlite, id: string) {
  const r = (await rows<{ j: Record<string, unknown> }>(db, `select to_jsonb(a) j from agent_advances a where id = $1`, [id]))[0].j;
  const pick = ['status', 'principal', 'outstanding_balance', 'cancellation_mode', 'funding_type', 'transferred_from_advance_id', 'recovery_source',
    'roi_recovery_percent', 'agent_id', 'pre_cancel_outstanding'];
  return Object.fromEntries(pick.map((k) => [k, r[k] === undefined || r[k] === null ? (r[k] as null | undefined) : String(r[k])])) as Record<string, string>;
}
/** A10 / A11 / A20 for one advance as the balance-sheet resolver carries it (works with or without the migration). */
async function bookSofp(db: PGlite, adv: string, req: string) {
  const x = await acct(db, `select transaction_group_id from general_ledger where source_id in ($1::uuid, $2::uuid)`, [adv, req]);
  return { a10: x.A10 ?? 0, a11: x.A11 ?? 0, a20: x.A20 ?? 0 };
}
const walletLegs = async (db: PGlite, since: string) =>
  rows<{ user_id: string; category: string; direction: string; amount: string }>(db, `select user_id, category, direction, amount from general_ledger
    where ledger_scope = 'wallet' and created_at >= $1 and description <> 'test seed' order by created_at`, [since]);
async function groupOk(db: PGlite, key: string) {
  const g = await rows<{ raw: string; mapped: string; n: string }>(db, `select sum(case when g.direction = 'cash_in' then g.amount else -g.amount end) raw,
    sum(case when g.direction = m.debit_when then g.amount else -g.amount end) mapped, count(*) n
    from general_ledger g join ledger_account_map m on m.ledger_scope = g.ledger_scope and m.category = g.category and m.wallet_bucket is null
    where g.idempotency_key = $1`, [key]);
  return { raw: num(g[0].raw), mapped: num(g[0].mapped), n: num(g[0].n) };
}
const r2 = (n: number) => Math.round(n * 100) / 100;

let oldDb: PGlite;
let db: PGlite;
beforeAll(async () => { oldDb = await buildA(false); db = await buildA(true); }, 400_000);
afterAll(async () => { await oldDb?.close(); await db?.close(); });

describe('order, preflight, install', () => {
  it('the replica runs production\'s seven definitions', async () => {
    for (const s of SIGS) expect(await fnMd5(oldDb, `public.${s}`), s).toBe(ADV.md5[s]);
  });
  it('refuses when a production definition has changed, changing nothing', async () => {
    const x = await buildA(false);
    await x.exec(`create or replace function public.cancel_agent_advance(p_advance_id uuid, p_recoup boolean, p_reason text) returns jsonb language sql as $$ select '{}'::jsonb $$`);
    await expect(x.exec(MIG)).rejects.toThrow(/production definitions differ/);
    expect((await rows(x, `select to_regclass('public.agent_advance_transfers') t`))[0]).toEqual({ t: null });
    await x.close();
  }, 400_000);
  it('a second apply is refused', async () => {
    await expect(db.exec(MIG)).rejects.toThrow(/already applied|production definitions differ/);
  });
  it('the existing functions differ from production only by the inserted controls', async () => {
    for (const s of SIGS) {
      const src = async (d: PGlite) => (await rows<{ s: string }>(d, `select prosrc s from pg_proc where oid = to_regprocedure($1)`, [`public.${s}`]))[0].s.replace(/\r/g, '').split('\n');
      const n = await src(db); const o = await src(oldDb);
      const removed = o.filter((l) => !n.includes(l));
      // the cancel function rewrites two lines (declarations / audit fields); every other change is an addition
      expect(removed.filter((l) => !/BEGIN$|'principal', v_adv\.principal$/.test(l.trim())), s).toEqual([]);
      expect(n.length, s).toBeGreaterThan(o.length);
    }
  });
});

describe('genuine payouts and repayments are unchanged', () => {
  it('create + disburse posts the same wallet credit and receivable as before', async () => {
    const res = [];
    for (const d of [oldDb, db]) {
      const since = await t0(d);
      const x = await issue(d, AG1, 400000, 'Stock for the Kansanga centre');
      res.push({ wallet: (await walletLegs(d, since)).map((w) => [w.category, w.direction, num(w.amount)]), book: await bookSofp(d, x.advance, x.request),
        row: await advRow(d, x.advance) });
    }
    expect(res[1].wallet).toEqual(res[0].wallet);
    expect(res[1].wallet).toEqual([['agent_advance_credit', 'cash_in', 400000]]);
    expect(res[1].book).toEqual(res[0].book);
    expect(res[1].book.a10).toBe(400000);
    const base = (r: Record<string, string>) => ({ ...r, funding_type: undefined, transferred_from_advance_id: undefined });
    expect(base(res[1].row)).toEqual(base(res[0].row));
    expect(res[1].row.funding_type).toBe('disbursement');
  });
  it('a manual repayment takes the same money and posts the same entries as before', async () => {
    const res = [];
    for (const d of [oldDb, db]) {
      const x = (await rows<{ id: string }>(d, `select id from agent_advances where agent_id = $1 and status = 'active' order by issued_at desc limit 1`, [AG1]))[0].id;
      await fund(d, AG1, 1_000_000);
      const since = await t0(d);
      await cfo(d, `public.cfo_record_advance_payment($1, 50000, 'wallet_offset', 'REF-1', 'test')`, [x]);
      res.push({ legs: (await rows(d, `select ledger_scope, category, direction, amount from general_ledger where created_at >= $1 and description <> 'test seed' order by ledger_scope, category`, [since])),
        row: await advRow(d, x) });
    }
    expect(res[1].legs).toEqual(res[0].legs);
    expect(res[1].row.outstanding_balance).toBe(res[0].row.outstanding_balance);
  });
});

describe('1-2. accounting-only transfers: no payout, no duplicate receivable', () => {
  it('to a new replacement advance: one balanced group, source credited by exactly what moves, source closed, no wallet leg', async () => {
    const x = await issue(db, AG2, 600000, 'Rent support for agent two');
    const before = await book(db, x.advance);
    const out0 = num((await advRow(db, x.advance)).outstanding_balance);
    const since = await t0(db);
    const t = await cfo<{ transfer_id: string; to_advance_id: string; amount: number; source_closed: boolean; not_previously_booked: number }>(db,
      `public.cfo_transfer_agent_advance($1, 'new_advance', 'Replacement on new terms agreed with the agent', 'xfer-test-0001')`, [x.advance]);
    expect([num(t.amount), t.source_closed]).toEqual([out0, true]);
    expect(await walletLegs(db, since)).toEqual([]);
    expect(await groupOk(db, `adv_transfer:${t.transfer_id}`)).toEqual(expect.objectContaining({ raw: 0, mapped: 0 }));
    const src = await book(db, x.advance); const dst = await book(db, t.to_advance_id);
    expect(r2(src.a10 + src.a11 + src.a20)).toBe(0);
    expect(r2(dst.a10)).toBe(r2(before.a10 + before.a11 + before.a20 + num(t.not_previously_booked)));
    const s = await advRow(db, x.advance); const n = await advRow(db, t.to_advance_id);
    expect([s.status, s.cancellation_mode, num(s.outstanding_balance)]).toEqual(['cancelled', 'transfer', 0]);
    expect([n.status, n.funding_type, n.transferred_from_advance_id, num(n.outstanding_balance)]).toEqual(['active', 'transfer', x.advance, out0]);
  });
  it('idempotent: the same key replays the first result and posts nothing', async () => {
    const t = (await rows<{ id: string; from_advance_id: string }>(db, `select id, from_advance_id from agent_advance_transfers where idempotency_key = 'xfer-test-0001'`))[0];
    const n0 = (await rows<{ n: string }>(db, `select count(*) n from general_ledger`))[0].n;
    const r = await cfo<{ replayed: boolean; id: string }>(db, `public.cfo_transfer_agent_advance($1, 'new_advance', 'Replacement on new terms agreed with the agent', 'xfer-test-0001')`, [t.from_advance_id]);
    expect([r.replayed, r.id]).toEqual([true, t.id]);
    expect((await rows<{ n: string }>(db, `select count(*) n from general_ledger`))[0].n).toBe(n0);
    await expect(as(db, CFO, () => db.query(`select public.cfo_transfer_agent_advance($1, 'new_advance', 'another reason long enough', 'xfer-test-0001')`, [t.id])))
      .rejects.toThrow(/already used|not found/);
  });
  it('to an existing advance (top-up without payout); partial amounts keep the source open', async () => {
    const a = await issue(db, AG1, 300000, 'Second advance agent one');
    const b = await issue(db, AG1, 200000, 'Third advance agent one');
    const outA = num((await advRow(db, a.advance)).outstanding_balance); const outB = num((await advRow(db, b.advance)).outstanding_balance);
    const since = await t0(db);
    const t = await cfo<{ transfer_id: string; source_closed: boolean }>(db,
      `public.cfo_transfer_agent_advance($1, 'existing_advance', 'Merge part of the balance into the active advance', 'xfer-test-0002', $2, 100000)`, [a.advance, b.advance]);
    expect(t.source_closed).toBe(false);
    expect(await walletLegs(db, since)).toEqual([]);
    expect([num((await advRow(db, a.advance)).outstanding_balance), num((await advRow(db, b.advance)).outstanding_balance)]).toEqual([outA - 100000, outB + 100000]);
    const ba = await book(db, a.advance); const bb = await book(db, b.advance);
    expect(r2(ba.a10 + ba.a11 + ba.a20 + bb.a10 + bb.a11 + bb.a20)).toBe(r2(outA + outB));   // nothing created, nothing lost
  });
  it('ROI-recovered replacement and partnership (another account) need the right details', async () => {
    const a = await issue(db, AG2, 250000, 'Advance to move to Returns recovery');
    await expect(as(db, CFO, () => db.query(`select public.cfo_transfer_agent_advance($1, 'new_advance', 'Recover through the partner Returns', 'xfer-roi-0001', p_new_recovery_source => 'roi')`, [a.advance])))
      .rejects.toThrow(/ROI recovery needs a percentage/);
    await expect(as(db, CFO, () => db.query(`select public.cfo_transfer_agent_advance($1, 'new_advance', 'Move to the partnership account', 'xfer-ptn-0001', p_new_agent_id => $2)`, [a.advance, AG1])))
      .rejects.toThrow(/cross-account reason/);
    const t = await cfo<{ to_advance_id: string }>(db, `public.cfo_transfer_agent_advance($1, 'new_advance', 'Move to the partnership account', 'xfer-ptn-0002',
      p_new_agent_id => $2, p_new_recovery_source => 'roi', p_new_roi_percent => 20, p_cross_account_reason => 'Same person, partner account holds the portfolio')`, [a.advance, AG1]);
    const n = await advRow(db, t.to_advance_id);
    expect([n.agent_id, n.recovery_source, num(n.roi_recovery_percent), n.funding_type]).toEqual([AG1, 'roi', 20, 'transfer']);
  });
  it('limits: more than the balance, a closed source, the same advance, a short reason or key', async () => {
    const a = await issue(db, AG2, 150000, 'Advance for limit checks');
    const out = num((await advRow(db, a.advance)).outstanding_balance);
    await expect(as(db, CFO, () => db.query(`select public.cfo_transfer_agent_advance($1, 'new_advance', 'Too much for this advance', 'xfer-lim-0001', p_amount => $2)`, [a.advance, out + 1]))).rejects.toThrow(/at most the outstanding/);
    await expect(as(db, CFO, () => db.query(`select public.cfo_transfer_agent_advance($1, 'existing_advance', 'Into itself is not allowed', 'xfer-lim-0002', $1)`, [a.advance]))).rejects.toThrow(/itself/);
    await expect(as(db, CFO, () => db.query(`select public.cfo_transfer_agent_advance($1, 'new_advance', 'short', 'xfer-lim-0003')`, [a.advance]))).rejects.toThrow(/at least 15/);
    await expect(as(db, CFO, () => db.query(`select public.cfo_transfer_agent_advance($1, 'new_advance', 'Key too short for safety', 'k1')`, [a.advance]))).rejects.toThrow(/idempotency key/);
    await expect(as(db, OPS, () => db.query(`select public.cfo_transfer_agent_advance($1, 'new_advance', 'Agent Ops cannot transfer', 'xfer-lim-0004')`, [a.advance]))).rejects.toThrow(/Only CFO or Manager/);
  });
  it('a legacy advance whose record carries more than the books: the difference is credited to E3, the source ends at zero', async () => {
    const a = await issue(db, AG2, 100000, 'Legacy advance with unbooked penalties');
    await db.query(`update agent_advances set outstanding_balance = outstanding_balance + 33333 where id = $1`, [a.advance]);   // e.g. a legacy penalty
    const t = await cfo<{ transfer_id: string; not_previously_booked: number }>(db, `public.cfo_transfer_agent_advance($1, 'new_advance', 'Replacement for the legacy advance', 'xfer-leg-0001')`, [a.advance]);
    expect(num(t.not_previously_booked)).toBe(33333);
    const b = await book(db, a.advance);
    expect(r2(b.a10 + b.a11 + b.a20)).toBe(0);
    expect(await groupOk(db, `adv_transfer:${t.transfer_id}`)).toEqual(expect.objectContaining({ raw: 0, mapped: 0 }));
    const e3 = await rows<{ n: string }>(db, `select sum(amount) n from general_ledger where idempotency_key = $1 and category = 'receivable_restatement_equity'`, [`adv_transfer:${t.transfer_id}`]);
    expect(num(e3[0].n)).toBe(33333);
  });
  it('balance sheet: a transfer leaves A10 + A11 + A20 unchanged in total and is invisible to the cash reports', async () => {
    const a = await issue(db, AG2, 120000, 'Advance for the statement check');
    const tot = async () => { const x = await acct(db); return r2((x.A10 ?? 0) + (x.A11 ?? 0) + (x.A20 ?? 0)); };
    const b0 = await tot();
    const t = await cfo<{ transfer_id: string }>(db, `public.cfo_transfer_agent_advance($1, 'new_advance', 'Statement check replacement', 'xfer-sofp-0001')`, [a.advance]);
    expect(await tot()).toBe(b0);
    const g = await acct(db, `select transaction_group_id from general_ledger where idempotency_key = $1`, [`adv_transfer:${t.transfer_id}`]);
    expect(Object.keys(g).every((k) => ['A10', 'A11', 'A20'].includes(k))).toBe(true);
    const day = (await rows<{ d: string }>(db, `select ((now() at time zone 'Africa/Kampala')::date)::text d`))[0].d;
    const legs = await rows<{ id: string }>(db, `select id from get_cfo_received_by_category_page($1::date, $1::date, null, null, null, 0, 5000)`, [day]);
    expect((await rows(db, `select 1 from general_ledger where id = any($1::uuid[]) and idempotency_key like 'adv\\_transfer:%'`, [legs.map((l) => l.id)])).length).toBe(0);
  });
});

describe('3-4. a payout that is really a transfer is refused; new money is explicit', () => {
  it('creating an advance equal to another advance\'s balance (the replacement pattern) is refused', async () => {
    const a = await issue(db, AG1, 350000, 'Advance whose balance someone tries to re-pay');
    const out = num((await advRow(db, a.advance)).outstanding_balance);
    await expect(as(db, CFO, () => db.query(`select public.cfo_create_advance($1, $2, 30, 0, 'daily', 'Recovery of company funds via ROI', true, 'override')`, [AG1, out])))
      .rejects.toThrow(/ADVANCE_POSSIBLE_TRANSFER/);
    // another account (partnership) with exactly that balance
    await expect(as(db, CFO, () => db.query(`select public.cfo_create_advance($1, $2, 30, 0, 'daily', 'Moving the balance to the partner', true, 'override')`, [AG2, out])))
      .rejects.toThrow(/ADVANCE_POSSIBLE_TRANSFER/);
    const ok = await cfo<{ request: { id: string } }>(db, `public.cfo_create_advance($1, $2, 30, 0.2, 'daily', '[NEW MONEY] second stock purchase', false, null)`, [AG1, out]);
    expect(ok.request.id).toBeTruthy();
  });
  it('a top-up equal to an advance the agent received in the last 7 days is refused (the 1,500,000 duplicate)', async () => {
    const a = await issue(db, AG2, 700000, 'Service centre opening Kansanga');
    const b = await issue(db, AG2, 900000, 'Active advance to top up');
    await expect(as(db, CFO, () => db.query(`select public.apply_advance_topup($1, 700000, 30, null, 'Topped up for Kansanga', true)`, [b.advance])))
      .rejects.toThrow(/ADVANCE_POSSIBLE_TRANSFER/);
    const ok = await cfo<Record<string, unknown>>(db, `public.apply_advance_topup($1, 650000, 30, null, '[NEW MONEY] extra stock for Kansanga', true)`, [b.advance]);
    expect(ok).toBeTruthy();
    expect(a.advance).toBeTruthy();
  });
});

describe('5. duplicate submissions are refused', () => {
  it('the same create, top-up and manual payment twice inside two minutes', async () => {
    await cfo(db, `public.cfo_create_advance($1, 123000, 30, 0.2, 'daily', 'Double click protection check', false, null)`, [AG1]);
    await expect(as(db, CFO, () => db.query(`select public.cfo_create_advance($1, 123000, 30, 0.2, 'daily', 'Double click protection check', false, null)`, [AG1])))
      .rejects.toThrow(/ADVANCE_DUPLICATE_SUBMISSION/);
    const b = await issue(db, AG1, 500000, 'Advance for duplicate top-up');
    await cfo(db, `public.apply_advance_topup($1, 111000, 30, null, '[NEW MONEY] first top-up', true)`, [b.advance]);
    await expect(as(db, CFO, () => db.query(`select public.apply_advance_topup($1, 111000, 30, null, '[NEW MONEY] first top-up', true)`, [b.advance])))
      .rejects.toThrow(/ADVANCE_DUPLICATE_SUBMISSION/);
    await fund(db, AG1, 1_000_000);
    await cfo(db, `public.cfo_record_advance_payment($1, 20000, 'wallet_offset', 'DUP-1', 'test')`, [b.advance]);
    await expect(as(db, CFO, () => db.query(`select public.cfo_record_advance_payment($1, 20000, 'wallet_offset', 'DUP-1', 'test')`, [b.advance])))
      .rejects.toThrow(/ADVANCE_DUPLICATE_SUBMISSION/);
    // the window is two minutes
    await db.query(`update agent_advance_op_guard set created_at = now() - interval '3 minutes'`);
    await cfo(db, `public.cfo_record_advance_payment($1, 20000, 'wallet_offset', 'DUP-1', 'test')`, [b.advance]);
  });
});

describe('6. wallet reversals are linked and capped', () => {
  it('cannot exceed the original credit, in one or several reversals', async () => {
    const a = await issue(db, AG1, 210000, 'Advance paid in error');
    const g = (await rows<{ g: string }>(db, `select transaction_group_id g from general_ledger where category = 'agent_advance_credit' and source_id = $1`, [a.request]))[0].g;
    await expect(db.query(`select public.reserve_wallet_reversal($1, $2, 210001, 'ECW-T1', $3)`, [g, AG1, CFO])).rejects.toThrow(/REVERSAL_EXCEEDS_ORIGINAL/);
    const r1 = (await rows<{ j: { link_id: string; advance_id: string; platform_category: string } }>(db, `select public.reserve_wallet_reversal($1, $2, 200000, 'ECW-T2', $3) j`, [g, AG1, CFO]))[0].j;
    expect([r1.advance_id, r1.platform_category]).toEqual([a.advance, 'agent_advance_reversed']);
    await expect(db.query(`select public.reserve_wallet_reversal($1, $2, 10001, 'ECW-T3', $3)`, [g, AG1, CFO])).rejects.toThrow(/REVERSAL_EXCEEDS_ORIGINAL/);
    await expect(db.query(`select public.reserve_wallet_reversal($1, $2, 100, 'ECW-T4', $3)`, [g, AG2, CFO])).rejects.toThrow(/REVERSAL_ORIGINAL_NOT_FOUND/);
    // a voided reservation frees its amount
    await db.query(`select public.settle_wallet_reversal($1, null)`, [r1.link_id]);
    await db.query(`select public.reserve_wallet_reversal($1, $2, 210000, 'ECW-T5', $3)`, [g, AG1, CFO]);
  });
  it('reversing an advance payout reduces the advance and its A10 - no equity entry, no duplicate', async () => {
    const a = await issue(db, AG2, 260000, 'Advance credited by mistake');
    const g = (await rows<{ g: string }>(db, `select transaction_group_id g from general_ledger where category = 'agent_advance_credit' and source_id = $1`, [a.request]))[0].g;
    const r = (await rows<{ j: { link_id: string; platform_category: string; advance_id: string } }>(db, `select public.reserve_wallet_reversal($1, $2, 260000, 'ECW-T6', $3) j`, [g, AG2, CFO]))[0].j;
    // what finops-wallet-move posts: wallet out + the category the reservation returns
    await fund(db, AG2, 1_000_000);
    const grp = (await rows<{ g: string }>(db, `select public.create_ledger_transaction(jsonb_build_array(
      jsonb_build_object('user_id', $1::uuid, 'ledger_scope', 'wallet', 'direction', 'cash_out', 'amount', 260000, 'category', 'wallet_transfer', 'wallet_bucket', 'withdrawable', 'recipient_type', 'user', 'source_table', 'finops_wallet_move', 'description', 'Error correction: returned'),
      jsonb_build_object('user_id', $1::uuid, 'ledger_scope', 'platform', 'direction', 'cash_in', 'amount', 260000, 'category', $2::text, 'source_table', 'agent_advances', 'source_id', $3::uuid, 'description', 'Error correction')),
      'ECW-T6') g`, [AG2, r.platform_category, r.advance_id]))[0].g;
    const before = await book(db, a.advance);
    await db.query(`select public.settle_wallet_reversal($1, $2)`, [r.link_id, grp]);
    const row = await advRow(db, a.advance);
    expect(num(row.principal)).toBe(0);
    const after = await book(db, a.advance);
    expect(after.a10).toBe(before.a10);            // the reversal leg already credited A10 (posted before settle)
    expect(after.a10).toBe(0);
    expect(r2(after.a11 + after.a20)).toBe(r2(num(row.outstanding_balance)));   // fees still owed stay on the books
  });
  it('the edge function requires the reversed transaction for reversal codes and uses the reservation', () => {
    expect(EDGE).toMatch(/REVERSAL_REASON_CODES\.has\(reasonCode\) && !reversesGroupId/);
    expect(EDGE).toMatch(/rpc\("reserve_wallet_reversal"/);
    expect(EDGE).toMatch(/rpc\("settle_wallet_reversal", \{ p_link_id: reversal\.link_id, p_reversal_group: groupId \}\)/);
    expect(EDGE).toMatch(/category: reversal\?\.platform_category \?\?/);
    for (const c of ['duplicate_credit', 'wrong_user', 'wrong_recipient', 'failed_funding_reversal', 'wrong_bucket', 'test_transaction']) expect(EDGE).toContain(`"${c}"`);
  });
});

describe('7. cancelling needs a destination or an approved write-off', () => {
  it('an outstanding balance cannot be dropped; recoup still allowed; zero balance unchanged', async () => {
    const a = await issue(db, AG1, 180000, 'Advance someone tries to cancel');
    await expect(as(db, CFO, () => db.query(`select public.cancel_agent_advance($1, false, 'GOING TO CREATE A NEW ONE')`, [a.advance]))).rejects.toThrow(/ADVANCE_CANCEL_NEEDS_DESTINATION/);
    const b = await issue(db, AG1, 170000, 'Advance kept for wallet recoup');
    const r = await cfo<{ mode: string }>(db, `public.cancel_agent_advance($1, true, 'Recover from the wallet later')`, [b.advance]);
    expect(r.mode).toBe('recoup_from_wallet');
    expect((await advRow(db, b.advance)).outstanding_balance).not.toBe('0');
  });
  it('write-off: requested, approved by someone else, then posted DR X4 / CR A10, A11, A20 and kept out of Money paid', async () => {
    const a = await issue(db, AG2, 160000, 'Advance to be written off');
    const out = num((await advRow(db, a.advance)).outstanding_balance);
    const bk = await book(db, a.advance);
    const req = await cfo<{ request_id: string }>(db, `public.request_agent_advance_write_off($1, 'Agent deceased - estate has no assets to recover')`, [a.advance]);
    await expect(as(db, CFO, () => db.query(`select public.decide_agent_advance_write_off($1, true, 'Approving my own request')`, [req.request_id]))).rejects.toThrow(/someone other/);
    await expect(as(db, CFO, () => db.query(`select public.cancel_agent_advance($1, false, 'Write off not yet approved')`, [a.advance]))).rejects.toThrow(/ADVANCE_CANCEL_NEEDS_DESTINATION/);
    await as(db, MGR, () => db.query(`select public.decide_agent_advance_write_off($1, true, 'Approved by the CEO after review')`, [req.request_id]));
    const c = await cfo<{ mode: string }>(db, `public.cancel_agent_advance($1, false, 'Approved write-off of the balance')`, [a.advance]);
    expect(c.mode).toBe('write_off_approved');
    const after = await book(db, a.advance);
    expect(r2(after.a10 + after.a11 + after.a20)).toBe(0);
    const g = await groupOk(db, `adv_writeoff:${req.request_id}`);
    expect([g.raw, g.mapped]).toEqual([0, 0]);
    const x4 = await rows<{ n: string }>(db, `select sum(amount) n from general_ledger where idempotency_key = $1 and category = 'platform_loss_writeoff'`, [`adv_writeoff:${req.request_id}`]);
    expect(num(x4[0].n)).toBe(r2(bk.a10 + bk.a11 + bk.a20));
    expect((await advRow(db, a.advance)).pre_cancel_outstanding).toBe(String(out));
    const paid = await rows<{ s: string }>(db, `select prosrc s from pg_proc where proname in ('get_cfo_paid_by_category_totals', 'get_cfo_paid_by_category_page')`);
    for (const p of paid) expect(p.s).toContain(`<> 'adv_writeoff:'`);
  });
});

describe('8. reconciliation and exceptions', () => {
  let ex: { counts: Record<string, number>; exceptions: Array<{ kind: string; advance_id: string | null; agent_id: string; detail: Record<string, unknown> }> };
  const Y = '00000000-0000-0000-0000-00000000ad31';
  beforeAll(async () => {
    await db.exec(`insert into profiles (id, full_name) values ('${Y}', 'Replica Case') on conflict do nothing`);
    await fund(db, Y, 1000);
    // the old pattern, replayed with production's own functions before the controls (oldDb) is not needed: build the shapes directly
    // 1. replacement paid out, then returned by an unlinked error correction (+ an extra 22,913): payout_returned + reversal_exceeds
    const p = await issue(db, Y, 1033875, '[NEW MONEY] replica of a replacement payout');
    await fund(db, Y, 2_000_000);
    await db.query(`select public.create_ledger_transaction(jsonb_build_array(
      jsonb_build_object('user_id', $1::uuid, 'ledger_scope', 'wallet', 'direction', 'cash_out', 'amount', 1056788, 'category', 'wallet_transfer', 'wallet_bucket', 'withdrawable', 'recipient_type', 'user', 'source_table', 'finops_wallet_move', 'description', 'Error correction: returned UGX 1,056,788'),
      jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', 1056788, 'category', 'balance_correction', 'source_table', 'finops_wallet_move', 'description', 'Error correction')), 'ECW-REPLICA')`, [Y]);
    // 2. legacy cancellation of an advance with a balance (production's old function on the controls-free path)
    await db.query(`update agent_advances set status = 'cancelled', cancellation_mode = 'write_off', pre_cancel_outstanding = outstanding_balance, outstanding_balance = 0, cancelled_at = now() where id = $1`, [p.advance]);
    // 3. two equal payouts within 48 hours
    await issue(db, Y, 777000, '[NEW MONEY] first equal payout');
    await issue(db, Y, 777000, '[NEW MONEY] second equal payout');
    ex = await cfo(db, `public.get_agent_advance_exceptions()`);
  }, 120_000);
  it('flags every historical pattern', () => {
    const mine = ex.exceptions.filter((e) => e.agent_id === Y).map((e) => e.kind).sort();
    expect(mine).toEqual(expect.arrayContaining(['closed_with_book_balance', 'duplicate_payout', 'payout_returned_by_unlinked_correction',
      'reversal_exceeds_original', 'undocumented_cancellation']));
    const over = ex.exceptions.find((e) => e.agent_id === Y && e.kind === 'reversal_exceeds_original')!;
    expect(num(over.detail.excess)).toBe(22913);
  });
  it('clean transfers and approved write-offs produce no exception', () => {
    const clean = ex.exceptions.filter((e) => e.agent_id !== Y && ['closed_with_book_balance', 'undocumented_cancellation'].includes(e.kind));
    expect(clean).toEqual([]);
  });
  it('the daily run stores a snapshot; only finance roles can read', async () => {
    const id = (await rows<{ id: string }>(db, `select public.run_agent_advance_reconciliation() id`))[0].id;
    expect((await rows(db, `select 1 from agent_advance_exception_runs where id = $1`, [id])).length).toBe(1);
    await expect(as(db, AG1, () => db.query(`select public.get_agent_advance_exceptions()`))).rejects.toThrow(/Not authorized/);
    const g = await rows<Record<string, boolean>>(db, `select
      has_function_privilege('authenticated', 'public.reserve_wallet_reversal(uuid, uuid, numeric, text, uuid)', 'EXECUTE') rv,
      has_function_privilege('authenticated', 'public._agent_advance_post_write_off(uuid, uuid)', 'EXECUTE') wo,
      has_function_privilege('authenticated', 'public.cfo_transfer_agent_advance(uuid, text, text, text, uuid, numeric, uuid, text, numeric, integer, text)', 'EXECUTE') tr,
      has_function_privilege('anon', 'public.cfo_transfer_agent_advance(uuid, text, text, text, uuid, numeric, uuid, text, numeric, integer, text)', 'EXECUTE') tr_anon,
      has_table_privilege('authenticated', 'public.agent_advance_transfers', 'INSERT') tbl_ins`);
    expect(g[0]).toEqual({ rv: false, wo: false, tr: true, tr_anon: false, tbl_ins: false });
  });
});

describe('historical cases are not touched', () => {
  it('the migration changes no existing ledger entry, advance or wallet', async () => {
    const x = await buildA(false);
    await issue(x, AG1, 300000, 'Pre-existing advance');
    const snap = async () => JSON.stringify(await rows(x, `select (select json_agg(g order by g.id) from general_ledger g) l,
      (select json_agg(a order by a.id) from (select id, status, principal, outstanding_balance, cancellation_mode from agent_advances) a) a,
      (select json_agg(w order by w.user_id) from wallets w) w`));
    const s0 = await snap();
    await x.exec(MIG);
    expect(await snap()).toBe(s0);
    await x.close();
  }, 400_000);
});

describe('rollback', () => {
  it('restores production\'s seven definitions; transfers and write-offs posted meanwhile stay', async () => {
    const x = await buildA(true);
    const a = await issue(x, AG1, 220000, 'Advance before rollback');
    await as(x, CFO, () => x.query(`select public.cfo_transfer_agent_advance($1, 'new_advance', 'Transfer before the rollback', 'xfer-rb-00001')`, [a.advance]));
    await x.exec(RB);
    for (const s of SIGS) expect(await fnMd5(x, `public.${s}`), s).toBe(ADV.md5[s]);
    expect(await fnMd5(x, 'public.cfo_transfer_agent_advance(uuid,text,text,text,uuid,numeric,uuid,text,numeric,integer,text)')).toBeNull();
    expect((await rows(x, `select 1 from general_ledger where idempotency_key like 'adv\\_transfer:%'`)).length).toBeGreaterThan(0);
    await x.close();
  }, 400_000);
});
