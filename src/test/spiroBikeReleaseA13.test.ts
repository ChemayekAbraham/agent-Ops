// @vitest-environment node
/**
 * Spiro motorcycle releases in A13 and the merchandise release recognition controls (CFO rule 2026-11-04):
 *   supabase/migrations/20261104210000_spiro_bike_release_a13_corrections.sql (ALPHA SSEMA a544f375, PIUS MATA a3228b88)
 *   supabase/migrations/20261104220000_merchandise_release_recognition_controls.sql
 *
 * Runs on PGlite with production's code verbatim over the merchandise replica (fixtures as merchandisePhase3.test.ts) with
 * production's merchandise migrations applied in order (20261104090000, 20261104100000, 20261104150000, 20261104170000) and
 * production's unique index uq_general_ledger_reference_dedupe.
 *
 * Proves: the replica runs production's payout definitions; the release evidence; refusals; the 4 correction groups and their
 * effect (A13 +420,000, X1 -1,420,000, E3 +1,000,000, nothing else, nothing edited, no wallet / plan balance / order / lease /
 * deduction change, not counted as money received); recoveries take the same money and the receivable clears exactly when the
 * plan is paid; every payout recognises the release on the agent (A13 motorcycle, A12 otherwise) and moves the same money;
 * duplicates refused; recoveries credit the right receivable; rollbacks.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// every call recomputes over the replica; under a parallel run 5s is too short
vi.setConfig({ testTimeout: 120_000 });

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const ONEOFF = read('supabase/migrations/20261104090000_merchandise_a12_a13_corrections.sql');
const CONTROLS = read('supabase/migrations/20261104100000_merchandise_receivable_controls.sql');
const PHASE3 = read('supabase/migrations/20261104150000_merchandise_phase3_stock_phone_pledge.sql');
const ONISSUE = read('supabase/migrations/20261104170000_merchandise_stock_recognise_on_issue.sql');
const FIX_BIKES = read('supabase/migrations/20261104210000_spiro_bike_release_a13_corrections.sql');
const ROLLBACK1 = read('supabase/rollbacks/20261104210000_spiro_bike_release_a13_corrections.rollback.sql');
const CONTROLS2 = read('supabase/migrations/20261104220000_merchandise_release_recognition_controls.sql');
const ROLLBACK2 = read('supabase/rollbacks/20261104220000_merchandise_release_recognition_controls.rollback.sql');
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

// ---------------------------------------------------------------- the two bikes and the production definitions
const ALPHA = { sale: 'a544f375-e454-4ed6-a794-81a500916c8a', plan: '93d95269-34da-45f0-9845-fff6b7312220', release: '77e52832', opening: 'c1597078' };
const PIUS = { sale: 'a3228b88-6f28-459b-9ef4-48bfd11d3e44', plan: 'bfe58c27-4f9e-41f0-a5ff-fdbfa4c8fda9', release: '3b9350ea', opening: '7be1c065' };
const BIKES = [ALPHA, PIUS];
const PROD_MD5 = {
  phone: ['public.cfo_disburse_smartphone_order(uuid, numeric, text)', '2034e5c247e2cf8eacfbd5573873f3f3'],
  bike: ['public.cfo_disburse_bike_lease(uuid, numeric, text)', '4fa8771db4ab7e0cbf0c47b34cbcbcf0'],
  bout: ['public.cfo_issue_boutique_order(uuid)', 'f9f0e813de2f65be67b864dde6b733a4'],
} as const;
// production's index (read-only export 2026-11-04): what turns "agent on the receivable leg" into a database-level duplicate guard
const DEDUPE_INDEX = `CREATE UNIQUE INDEX IF NOT EXISTS uq_general_ledger_reference_dedupe ON public.general_ledger USING btree
  (user_id, category, reference_id, direction, ledger_scope) WHERE ((reference_id IS NOT NULL) AND (user_id IS NOT NULL) AND (created_at >= '2026-05-06 11:51:46.549455+00'::timestamp with time zone))`;

async function buildB(): Promise<PGlite> {
  const db = await build();
  await db.exec(PHASE3);
  await db.exec(ONISSUE);
  await db.exec(DEDUPE_INDEX);
  return db;
}
const r2 = (n: number) => Math.round(n * 100) / 100;
const KEYS = `select transaction_group_id from general_ledger where idempotency_key like 'spiro\\_release\\_a13\\_20261104:%'`;
async function orderAcct(db: PGlite, b: typeof ALPHA) {
  return acct(db, `select transaction_group_id from general_ledger where (source_table = 'merchandise_sales' and source_id = $1)
    or (source_table = 'merchandise_recovery_plans' and source_id = $2)`, [b.sale, b.plan]);
}
async function plan(db: PGlite, id: string) {
  return (await rows<Record<string, string>>(db, `select principal_total, fee_total, principal_recovered, fee_recovered, original_amount,
    outstanding_balance, amount_recovered, status from merchandise_recovery_plans where id = $1`, [id]))[0];
}

let oldDb: PGlite;   // production as now
let newDb: PGlite;   // + the bike corrections + the release controls
let before: Record<string, number>;
let legsBefore: string;
let nBefore: number;
let rowsBefore: string;
const snapRows = (db: PGlite) => rows(db, `select (select json_agg(w order by w.id) from (select id, user_id, withdrawable_balance from wallets) w) wallets,
  (select json_agg(p order by p.id) from (select id, status, original_amount, outstanding_balance, amount_recovered, due_balance from merchandise_recovery_plans) p) plans,
  (select json_agg(s order by s.id) from (select id, order_status, payment_status, amount_paid, amount_outstanding, disbursed_amount from merchandise_sales) s) sales,
  (select json_agg(l order by l.id) from (select id, status, amount_paid, amount_outstanding from agent_bike_leases) l) leases,
  (select count(*) from merchandise_recovery_deductions) deductions`);
beforeAll(async () => {
  oldDb = await buildB(); newDb = await buildB();
  before = await acct(newDb);
  legsBefore = JSON.stringify(await rows(newDb, `select * from general_ledger order by id`));
  nBefore = num((await rows<{ n: string }>(newDb, `select count(*) n from general_ledger`))[0].n);
  rowsBefore = JSON.stringify(await snapRows(newDb));
  await newDb.exec(FIX_BIKES);
  await newDb.exec(CONTROLS2);
}, 400_000);
afterAll(async () => { await oldDb?.close(); await newDb?.close(); });

describe('order and preflight', () => {
  it('the replica runs production\'s payout definitions', async () => {
    for (const [sig, m] of Object.values(PROD_MD5)) expect(await fnMd5(oldDb, sig), sig).toBe(m);
  });
  it('production evidence: each release is one group, DR X1 710,000 + the agent\'s withdrawable wallet 710,000', async () => {
    for (const b of BIKES) {
      const g = await rows<{ sc: string; c: string; d: string; a: string; bk: string | null; agent: boolean }>(oldDb,
        `select g.ledger_scope sc, g.category c, g.direction d, g.amount a, g.wallet_bucket bk, g.user_id = s.customer_id agent
         from general_ledger g join merchandise_sales s on s.id = $1 where g.idempotency_key = 'bike-lease-disbursement-' || $1 order by 1`, [b.sale]);
      expect(g.map((x) => [x.sc, x.c, x.d, num(x.a), x.bk])).toEqual([
        ['platform', 'equipment_expense', 'cash_out', 710000, null], ['wallet', 'agent_advance_credit', 'cash_in', 710000, 'withdrawable']]);
      expect(g[1].agent).toBe(true);
      const o = await orderAcct(oldDb, b);
      const p = await plan(oldDb, b.plan);
      expect([o.X1, o.E3, r2(o.A13)]).toEqual([710000, -500000, 500000 - num(p.principal_recovered)]);
      expect([num(p.principal_total), num(p.fee_total), num(p.original_amount)]).toEqual([500000, 910000, 1410000]);
    }
  });
  it('refuses when the evidence has moved (here: the plan split), changing nothing', async () => {
    const db = await buildB();
    await db.query(`update merchandise_recovery_plans set fee_total = 900000 where id = $1`, [PIUS.plan]);
    const n0 = (await rows<{ n: string }>(db, `select count(*) n from general_ledger`))[0].n;
    await expect(db.exec(FIX_BIKES)).rejects.toThrow(/evidence moved - PIUS MATA: plan/);
    expect((await rows<{ n: string }>(db, `select count(*) n from general_ledger`))[0].n).toBe(n0);
    expect(num((await plan(db, ALPHA.plan)).principal_total)).toBe(500000);
    await db.close();
  }, 400_000);
  it('refuses when a release is already recognised', async () => {
    const db = await buildB();
    await db.query(`select create_ledger_transaction(jsonb_build_array(
      jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', 1, 'category', 'bike_recovery_repayment', 'source_table', 'merchandise_recovery_plans', 'source_id', $1::uuid),
      jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', 1, 'category', 'equipment_expense', 'source_table', 'merchandise_recovery_plans', 'source_id', $1::uuid)), 'test_dup')`, [ALPHA.plan]);
    await expect(db.exec(FIX_BIKES)).rejects.toThrow(/ALPHA SSEMA: already recognised/);
    await db.close();
  }, 400_000);
  it('a second apply is refused', async () => {
    await expect(newDb.exec(FIX_BIKES)).rejects.toThrow(/already applied/);
  });
});

describe('the two corrections', () => {
  it('4 groups of 2 legs, platform / bridge only, balanced raw and on mapped accounts, on the agent, linked to the release and the opening', async () => {
    const g = await rows<{ k: string; n: string; sc: string; cats: string; refs: string; users: string }>(newDb, `select g.idempotency_key k, count(*) n,
      string_agg(distinct g.ledger_scope, ',') sc, string_agg(g.category || '/' || g.direction || '/' || g.amount, ',' order by g.category) cats,
      string_agg(distinct left(g.reference_id, 8), ',') refs, bool_and(g.user_id = s.customer_id)::text users
      from general_ledger g join merchandise_recovery_plans p on p.id = g.source_id join merchandise_sales s on s.id = p.sale_id
      where g.idempotency_key like 'spiro\\_release\\_a13\\_20261104:%' group by 1 order by 1`);
    expect(g.length).toBe(4);
    for (const b of BIKES) {
      const rec = g.find((x) => x.k === `spiro_release_a13_20261104:${b.sale}:RECOGNISE`)!;
      const opn = g.find((x) => x.k === `spiro_release_a13_20261104:${b.sale}:OPENING`)!;
      expect([num(rec.n), rec.sc, rec.cats, rec.refs, rec.users]).toEqual([2, 'platform',
        'bike_recovery_repayment/cash_out/710000,equipment_expense/cash_in/710000', b.release, 'true']);
      expect([num(opn.n), opn.sc, opn.cats, opn.refs, opn.users]).toEqual([2, 'bridge,platform',
        'bike_recovery_receivable_opening/cash_out/500000,receivable_restatement_equity/cash_in/500000', b.opening, 'true']);
    }
    expect(await acct(newDb, KEYS)).toEqual({ A13: 420000, X1: -1420000, E3: 1000000 });
    expect((await rows(newDb, `select 1 from ledger_mapped_balance_violations where transaction_group_id in (${KEYS})`)).length).toBe(0);
  });
  it('per bike: X1 0, E3 0, A13 = 710,000 (the release) less the principal recovered; nothing else on the order moves', async () => {
    for (const b of BIKES) {
      const o = await orderAcct(oldDb, b); const n = await orderAcct(newDb, b);
      const p = await plan(newDb, b.plan);
      expect([n.X1 ?? 0, n.E3 ?? 0, r2(n.A13)]).toEqual([0, 0, 710000 - num(p.principal_recovered)]);
      expect([n.L1, n.R1]).toEqual([o.L1, o.R1]);
    }
  });
  it('the migration moved only A13 (+420,000), X1 (-1,420,000) and E3 (+1,000,000), appended 8 legs and edited nothing', async () => {
    const after = await acct(newDb);
    const diff = Object.fromEntries(Object.keys({ ...before, ...after }).map((k) => [k, r2((after[k] ?? 0) - (before[k] ?? 0))]).filter(([, v]) => v !== 0));
    expect(diff).toEqual({ A13: 420000, X1: -1420000, E3: 1000000 });
    expect(num((await rows<{ n: string }>(newDb, `select count(*) n from general_ledger`))[0].n) - nBefore).toBe(8);
    const old = JSON.parse(legsBefore) as Array<{ id: string }>;
    expect(JSON.stringify(await rows(newDb, `select * from general_ledger where id = any($1::uuid[]) order by id`, [old.map((l) => l.id)]))).toBe(legsBefore);
  });
  it('no wallet, payment, plan balance, order, lease or deduction change; only the plans\' principal / fee split', async () => {
    expect(JSON.stringify(await snapRows(newDb))).toBe(rowsBefore);
    for (const b of BIKES) {
      const p = await plan(newDb, b.plan); const o = await plan(oldDb, b.plan);
      expect([num(p.principal_total), num(p.fee_total)]).toEqual([710000, 700000]);
      expect([p.outstanding_balance, p.amount_recovered, p.original_amount, p.status, p.principal_recovered, p.fee_recovered])
        .toEqual([o.outstanding_balance, o.amount_recovered, o.original_amount, o.status, o.principal_recovered, o.fee_recovered]);
    }
    expect((await rows(newDb, `select 1 from general_ledger where idempotency_key like 'spiro\\_release\\_a13\\_20261104:%' and ledger_scope = 'wallet'`)).length).toBe(0);
  });
  it('the Money received report does not count the corrections', async () => {
    const day = (await rows<{ d: string }>(newDb, `select ((now() at time zone 'Africa/Kampala')::date)::text d`))[0].d;
    const legs = await rows<{ id: string }>(newDb, `select id from get_cfo_received_by_category_page($1::date, $1::date, null, null, null, 0, 5000)`, [day]);
    const ours = await rows(newDb, `select 1 from general_ledger where id = any($1::uuid[]) and idempotency_key like 'spiro\\_release\\_a13\\_20261104:%'`, [legs.map((l) => l.id)]);
    expect(ours.length).toBe(0);
    const t = await rows<{ category_key: string; amount: string }>(newDb, `select category_key, amount from get_cfo_received_by_category_totals($1::date, $1::date)`, [day]);
    const to = await rows<{ category_key: string; amount: string }>(oldDb, `select category_key, amount from get_cfo_received_by_category_totals($1::date, $1::date)`, [day]);
    expect(t).toEqual(to);
  });
});

describe('recoveries after the correction: same money, the receivable clears exactly', () => {
  it('a payment takes the same money and splits the same way while charges are under the cap', async () => {
    const res = [];
    for (const db of [oldDb, newDb]) {
      const agent = (await rows<{ c: string }>(db, `select customer_id c from merchandise_sales where id = $1`, [PIUS.sale]))[0].c;
      await fund(db, agent, 5_000_000);
      const since = await t0(db);
      await as(db, agent, () => db.query(`select public.agent_pay_merchandise_plan($1, 25000)`, [PIUS.plan]));
      res.push(await effects(db, since));
    }
    expect(res[1].wallet).toEqual(res[0].wallet);
    expect(res[1].deductions).toEqual(res[0].deductions);
    expect(res[1].platform).toEqual(res[0].platform);
    expect((await plan(newDb, PIUS.plan)).outstanding_balance).toBe((await plan(oldDb, PIUS.plan)).outstanding_balance);
  });
  it('paid to the end: A13 clears to 0 exactly, charges stop at 700,000; without the correction 710,000 stays in X1 and E3 carries -500,000', async () => {
    for (const db of [oldDb, newDb]) {
      const agent = (await rows<{ c: string }>(db, `select customer_id c from merchandise_sales where id = $1`, [ALPHA.sale]))[0].c;
      await fund(db, agent, 5_000_000);
      for (let i = 0; i < 60; i++) {
        const out = num((await plan(db, ALPHA.plan)).outstanding_balance);
        if (out <= 0) break;
        // distinct amounts: the payment's idempotency key is plan + amount + minute
        await as(db, agent, () => db.query(`select public.agent_pay_merchandise_plan($1, $2)`, [ALPHA.plan, Math.min(out, 100000 - i)]));
      }
    }
    const n = await orderAcct(newDb, ALPHA); const o = await orderAcct(oldDb, ALPHA);
    const pn = await plan(newDb, ALPHA.plan); const po = await plan(oldDb, ALPHA.plan);
    expect(num(pn.outstanding_balance)).toBe(0);
    expect([num(pn.principal_recovered), num(pn.fee_recovered)]).toEqual([710000, 700000]);
    expect([n.A13 ?? 0, n.X1 ?? 0, n.E3 ?? 0, n.R1]).toEqual([0, 0, 0, -700000]);
    expect([num(po.principal_recovered), num(po.fee_recovered)]).toEqual([500000, 910000]);
    expect([o.A13 ?? 0, o.X1, o.E3, o.R1]).toEqual([0, 710000, -500000, -910000]);
    // the same money was taken in both, and every shilling taken is in the ledger
    expect(num(pn.amount_recovered)).toBe(num(po.amount_recovered));
    for (const db of [oldDb, newDb]) {
      const w = (await rows<{ n: string }>(db, `select coalesce(sum(amount), 0) n from general_ledger where ledger_scope = 'wallet' and category = 'agent_repayment'
        and source_table = 'merchandise_recovery_plans' and source_id = $1`, [ALPHA.plan]))[0].n;
      expect(num(w)).toBe(1410000);
    }
  }, 300_000);
});

describe('release controls: every payout recognises the release on the agent, A13 for motorcycles, A12 otherwise', () => {
  const AG = '00000000-0000-0000-0000-00000000c0a1';
  const SUP = '00000000-0000-0000-0000-00000000c0a2';
  const PH = '00000000-0000-0000-0000-00000000c0b1';
  const BK = '00000000-0000-0000-0000-00000000c0b2';
  const BT = '00000000-0000-0000-0000-00000000c0b3';
  const eff: Record<string, Array<Awaited<ReturnType<typeof effects>>>> = {};
  beforeAll(async () => {
    for (const db of [oldDb, newDb]) {
      await db.query(`insert into profiles (id, full_name) values ($1, 'Release Agent'), ($2, 'Release Supplier') on conflict do nothing`, [AG, SUP]);
      await fund(db, AG, 1_000_000);
      await db.query(`insert into merchandise_sales (id, customer_id, supplier_id, item_name, quantity, unit_price, total_amount, total_revenue,
        advance_period_months, grace_days, order_status, payment_plan, created_at) values ($1, $2, $3, 'Welile Smartphone', 1, 600000, 600000, 600000, 3, 7, 'coo_approved', 'full', now())`, [PH, AG, SUP]);
      await db.query(`insert into merchandise_sales (id, customer_id, supplier_id, item_name, quantity, valuation_amount, total_amount, total_revenue, lease_term_months, order_status, amount_paid, created_at)
        values ($1, $2, $3, 'Welile Spiro Bike', 1, 650000, 650000, 650000, 12, 'coo_approved', 0, now())`, [BK, AG, SUP]);
      await db.query(`insert into merchandise_sales (id, customer_id, item_name, quantity, total_revenue, amount_outstanding, payment_plan, fulfilment_type, order_status, created_at)
        values ($1, $2, 'Office chair', 1, 300000, 300000, 'installment', 'outsourced', 'coo_approved', now())`, [BT, AG]);
    }
    for (const [k, call, sale] of [['phone', `select public.cfo_disburse_smartphone_order($1, null, 'test')`, PH],
      ['bike', `select public.cfo_disburse_bike_lease($1, 0, 'test')`, BK], ['bout', `select public.cfo_issue_boutique_order($1)`, BT]] as const) {
      eff[k] = [];
      for (const db of [oldDb, newDb]) {
        const since = await t0(db);
        await as(db, CFO, () => db.query(call, [sale]));
        eff[k].push(await effects(db, since));
      }
    }
  }, 300_000);
  it('installs; the three payouts are the production definitions except the receivable leg', async () => {
    for (const [sig, m] of Object.values(PROD_MD5)) expect(await fnMd5(newDb, sig), sig).not.toBe(m);
    const NEW_OK = /^\s*--|_merch_release_receivable_category|'user_id', (v_agent|v_customer|v_sale\.customer_id), 'amount', (v_price|v_valuation|v_amt), 'direction', 'cash_out'/;
    const OLD_OK = /'user_id', (v_uid|auth\.uid\(\)), 'amount', (v_price|v_valuation|v_amt), 'direction', 'cash_out'|'category', '(smartphone_advance_receivable|bike_recovery_repayment)', 'ledger_scope', 'platform'/;
    for (const [sig] of Object.values(PROD_MD5)) {
      const src = async (db: PGlite) => (await rows<{ s: string }>(db, `select prosrc s from pg_proc where oid = to_regprocedure($1)`, [sig]))[0].s.replace(/\r/g, '').split('\n');
      const n = await src(newDb); const o = await src(oldDb);
      const added = n.filter((l) => !o.includes(l)); const removed = o.filter((l) => !n.includes(l));
      expect(added.filter((l) => !NEW_OK.test(l)), sig).toEqual([]);
      expect(removed.filter((l) => !OLD_OK.test(l)), sig).toEqual([]);
      expect(removed.length, sig).toBeGreaterThan(0);
    }
  });
  it('the same money moves: same wallet legs, orders, plans, schedules and audit rows as before', () => {
    for (const k of ['phone', 'bike', 'bout']) {
      const [o, n] = eff[k];
      expect(n.wallet, k).toEqual(o.wallet);
      expect(n.sales, k).toEqual(o.sales);
      expect(n.plans, k).toEqual(o.plans);
      expect(n.schedules, k).toEqual(o.schedules);
    }
  });
  it('the receivable = the full amount released, at release, on the agent (was: the approving CFO); A12 phone / boutique, A13 motorcycle; no revenue', async () => {
    for (const [k, sale, cat, acc, amt] of [['phone', PH, 'smartphone_advance_receivable', 'A12', 600000], ['bike', BK, 'bike_recovery_repayment', 'A13', 650000],
      ['bout', BT, 'smartphone_advance_receivable', 'A12', 300000]] as const) {
      const leg = async (db: PGlite) => (await rows<{ u: string; c: string; a: string }>(db, `select user_id u, category c, amount a from general_ledger
        where source_table = 'merchandise_sales' and source_id = $1 and ledger_scope = 'platform' and direction = 'cash_out' and category = $2`, [sale, cat]));
      const n = await leg(newDb); const o = await leg(oldDb);
      expect(n.map((x) => [x.u, x.c, num(x.a)]), k).toEqual([[AG, cat, amt]]);
      expect(o.map((x) => x.u), k).toEqual([CFO]);
      const released = eff[k][1].wallet.reduce((s, w) => s + (w.category === 'agent_advance_credit' ? 0 : num(w.amount)), 0);
      expect(released, k).toBe(amt);
      const a = await saleAcct(newDb, sale);
      expect(a[acc], k).toBe(amt);
      expect(a.R1 ?? 0, k).toBe(0);
      expect(a.X1 ?? 0, k).toBe(0);
    }
  });
  it('a motorcycle released through another route still lands in A13', async () => {
    expect((await rows<{ c: string }>(newDb, `select public._merch_release_receivable_category('Welile Spiro Bike') c`))[0].c).toBe('bike_recovery_repayment');
    expect((await rows<{ c: string }>(newDb, `select public._merch_release_receivable_category('Boda boda motorcycle') c`))[0].c).toBe('bike_recovery_repayment');
    expect((await rows<{ c: string }>(newDb, `select public._merch_release_receivable_category('Tecno Spark 20') c`))[0].c).toBe('smartphone_advance_receivable');
    expect((await rows<{ c: string }>(newDb, `select public._merch_release_receivable_category('Press Jacket') c`))[0].c).toBe('smartphone_advance_receivable');
  });
  it('a second recognition of the same release is refused by the database (and each payout is once per order)', async () => {
    const ref = (await rows<{ r: string }>(newDb, `select reference_id r from general_ledger where source_id = $1 and category = 'bike_recovery_repayment' and direction = 'cash_out'`, [BK]))[0].r;
    await expect(newDb.query(`select create_ledger_transaction(jsonb_build_array(
      jsonb_build_object('user_id', $1::uuid, 'ledger_scope', 'platform', 'direction', 'cash_out', 'amount', 650000, 'category', 'bike_recovery_repayment', 'source_table', 'merchandise_sales', 'source_id', $2::uuid, 'reference_id', $3::text),
      jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', 650000, 'category', 'equipment_expense', 'source_table', 'merchandise_sales', 'source_id', $2::uuid, 'reference_id', $3::text)), 'test_dup_release')`,
      [AG, BK, ref])).rejects.toThrow(/uq_general_ledger_reference_dedupe|duplicate key/);
    // calling the payout again posts nothing
    for (const [call, sale] of [[`select public.cfo_disburse_bike_lease($1, 0, 'again')`, BK], [`select public.cfo_issue_boutique_order($1)`, BT]] as const) {
      const n0 = (await rows<{ n: string }>(newDb, `select count(*) n from general_ledger where source_id = $1`, [sale]))[0].n;
      await as(newDb, CFO, () => newDb.query(call, [sale])).catch(() => undefined);
      expect((await rows<{ n: string }>(newDb, `select count(*) n from general_ledger where source_id = $1`, [sale]))[0].n).toBe(n0);
    }
  });
  it('recoveries credit the receivable the release opened (A13 for the motorcycle, A12 for the boutique order)', async () => {
    for (const [sale, acc] of [[BK, 'A13'], [BT, 'A12']] as const) {
      const p = (await rows<{ id: string }>(newDb, `select id from merchandise_recovery_plans where sale_id = $1 and status = 'active'`, [sale]))[0];
      const b0 = await saleAcct(newDb, sale);
      await as(newDb, AG, () => newDb.query(`select public.agent_pay_merchandise_plan($1, 20000)`, [p.id]));
      const b1 = await saleAcct(newDb, sale);
      const prin = r2((b0[acc] ?? 0) - (b1[acc] ?? 0));
      const charge = r2((b0.R1 ?? 0) - (b1.R1 ?? 0));
      expect(prin, sale).toBeGreaterThan(0);
      expect(r2(prin + charge), sale).toBe(20000);
    }
  });
  it('rollback restores production\'s payout definitions', async () => {
    const db = await buildB();
    await db.exec(CONTROLS2);
    await db.exec(ROLLBACK2);
    for (const [sig, m] of Object.values(PROD_MD5)) expect(await fnMd5(db, sig), sig).toBe(m);
    expect(await fnMd5(db, 'public._merch_release_receivable_category(text)')).toBeNull();
    await db.close();
  }, 400_000);
});

describe('correction rollback', () => {
  it('restores the plan split; the entries stay', async () => {
    const db = await buildB();
    await db.exec(FIX_BIKES);
    await db.exec(ROLLBACK1);
    for (const b of BIKES) {
      const p = await plan(db, b.plan);
      expect([num(p.principal_total), num(p.fee_total)]).toEqual([500000, 910000]);
    }
    expect((await rows(db, KEYS)).length).toBe(8);
    await db.close();
  }, 400_000);
});
