// @vitest-environment node
/**
 * Merchandise receivable controls (supabase/migrations/20261104100000_merchandise_receivable_controls.sql): the
 * preventive side of the 3-4 Nov A12 / A13 corrections (20261104090000), so the same errors cannot recur.
 *
 * Runs on PGlite with production's own code verbatim (scripts/fixtures/merch-a12a13-prod-2026-11-04.sql,
 * scripts/fixtures/merch-controls-prod-2026-11-04.sql, scripts/fixtures/sofp-prod-2026-11-02.sql) over the replica of every
 * merchandise plan / order with an A12 / A13 balance and every ledger group touching them
 * (scripts/fixtures/merch-a12a13-prod-2026-11-04.json), plus the bike leases of the replica's bike plans.
 *
 * Proves: order of the two migrations (each refuses in the wrong order); the receivable measure equals the balance-sheet
 * resolver for every replica item, before and after the one-off corrections; bike and out-sourced payouts, manual payments
 * and rejections move exactly the same money and change exactly the same rows as before (old vs new, side by side) and
 * differ only in their company-side legs; the receivable lands in A13 / A12 (not X1) and charges in R1; a rejected,
 * cancelled or deleted order / plan is queued once, with the receivable left and the cash taken, and the CFO's decision
 * (E3 or X4) posts exactly what is left, once; a standing choice posts automatically, in the same transaction, and a
 * failure stops the operation; the Money received reports do not count derecognitions; only the CFO can decide; rollback.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const ONEOFF = read('supabase/migrations/20261104090000_merchandise_a12_a13_corrections.sql');
const CONTROLS = read('supabase/migrations/20261104100000_merchandise_receivable_controls.sql');
const ROLLBACK = read('supabase/rollbacks/20261104100000_merchandise_receivable_controls.rollback.sql');
const PROD = read('scripts/fixtures/merch-a12a13-prod-2026-11-04.sql');
const PROD2 = read('scripts/fixtures/merch-controls-prod-2026-11-04.sql');
const SOFP_ALL = read('scripts/fixtures/sofp-prod-2026-11-02.sql');
const SOFP = SOFP_ALL.slice(SOFP_ALL.indexOf('CREATE OR REPLACE FUNCTION public.sofp_ledger_legs'),
  SOFP_ALL.indexOf('CREATE OR REPLACE FUNCTION public.get_statement_of_financial_position'));

interface RawLeg { id: string; gid: string; sc: string; cat: string; dir: string; amt: number; st: string | null; sid: string | null;
  ref: string | null; idem: string | null; td: string; ca: string; bk: string | null; uid: string | null; cls: string | null }
interface Item { plan: string; sale: string | null; acct: 'A12' | 'A13'; L: number; orphan: boolean }
const FIX = JSON.parse(read('scripts/fixtures/merch-a12a13-prod-2026-11-04.json')) as {
  plans: Array<Record<string, unknown>>; sales: Array<Record<string, unknown>>; schedules: unknown[]; legs: RawLeg[]; map: unknown[];
  integrity: unknown[]; ddl: Record<string, Array<{ c: string; t: string; d: string | null }>>; items: Item[];
  expected_after: Record<string, number>; report_md5: Record<string, { old: string; new: string }>;
};
const FIX2 = JSON.parse(read('scripts/fixtures/merch-controls-prod-2026-11-04.json')) as {
  ddl: Record<string, Array<{ c: string; t: string; d: string | null }>>; bike_leases: unknown[];
};
const MD5 = {
  'public.cfo_disburse_bike_lease(uuid, numeric, text)': { old: '5cf5ce0d544f197672ea0c9f6a87b322', new: '4fa8771db4ab7e0cbf0c47b34cbcbcf0' },
  'public.cfo_issue_boutique_order(uuid)': { old: '5f70e9460916a188ae592b62b5e59a59', new: 'f9f0e813de2f65be67b864dde6b733a4' },
  'public.agent_pay_merchandise_plan(uuid, numeric)': { old: 'ecb3442334c8489213d4b5f7aa8cad89', new: '33263ebb983d0bcc1be47d4a62f99358' },
  'public.get_cfo_received_by_category_totals(date, date)': { old: '7cb4ad64e743816e8130e398735b30c6', new: '3dbe067c72c0ba48d0770fa44b88b55b' },
  'public.get_cfo_received_by_category_page(date, date, text, text, text, integer, integer)': { old: '6ff0d64da4142b425c0022663fcb0643', new: '2af9c35a580e52a264604bae7de1e9f7' },
  'public.get_cfo_received_agent_products_breakdown(date, date)': { old: 'fb673e6c61738bdb1c25359fe605b06b', new: '450e004ffe39bb905cae0a9e3054e973' },
} as Record<string, { old: string; new: string }>;

const DEF_OK = /^(gen_random_uuid\(\)|now\(\)|true|false|-?\d+(\.\d+)?|'[^']*'::[\w ]+(\[\])?)$/;
const ddlOf = (src: Record<string, Array<{ c: string; t: string; d: string | null }>>, t: string) => `create table public.${t} (${src[t].map((c) =>
  `"${c.c}" ${c.t}${c.d && DEF_OK.test(c.d) ? ` default ${c.d}` : ''}`).join(', ')});`;
const ROLES = ['tenant', 'agent', 'landlord', 'supporter', 'manager', 'ceo', 'coo', 'cfo', 'cto', 'cmo', 'crm', 'employee', 'operations',
  'super_admin', 'hr', 'senior_agent', 'sub_agent', 'admin', 'tenant_ops', 'landlord_ops', 'agent_ops', 'financial_ops', 'partner_ops', 'access_admin', 'rd'];
const CFO = '00000000-0000-0000-0000-0000000000cf';
const STANDINS = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create type public.solvency_bypass_reason as enum ('cfo_override');
${['general_ledger', 'ledger_account_map', 'ledger_integrity_config', 'merchandise_recovery_plans', 'merchandise_sales', 'smartphone_repayment_schedules']
    .map((t) => ddlOf(FIX.ddl, t)).join('\n')}
${['merchandise_recovery_deductions', 'audit_logs', 'agent_bike_leases', 'agent_bike_lease_schedules', 'system_events'].map((t) => ddlOf(FIX2.ddl, t)).join('\n')}
create table public.profiles (id uuid primary key, is_test boolean default false, full_name text, phone text);
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select coalesce(nullif(current_setting('test.uid', true), '')::uuid, '${CFO}'::uuid) $$;
create type public.app_role as enum (${ROLES.map((r) => `'${r}'`).join(', ')});
create table public.test_roles (user_id uuid, role text);
insert into public.test_roles values ('${CFO}', 'cfo');
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
create table public.smartphone_catalog (brand text, model_name text);
create function public.wallet_route_for_category(p_user uuid, p_category text, p_direction text) returns table(bucket text, sign numeric) language sql stable as $$ select null::text, null::numeric where false $$;
create function public.assert_routing_compatible(p_category text, p_recipient text) returns void language sql as $$ select $$;
insert into public.treasury_controls values ('strict_mode', true);
`;
const TRIGGERS = `
create trigger trg_validate_ledger_category before insert on public.general_ledger for each row execute function public.validate_ledger_category();
create constraint trigger trg_enforce_ledger_group_balance after insert on public.general_ledger deferrable initially deferred for each row execute function public.enforce_ledger_group_balance();
create constraint trigger trg_enforce_ledger_group_mapped_balance after insert on public.general_ledger deferrable initially deferred for each row execute function public.enforce_ledger_group_mapped_balance();
-- production's mode ('log'): legacy paths (e.g. the rejection refund) post groups the mapped check only logs; the controls'
-- own groups are checked explicitly below
-- production's cascade (merchandise_sale_cascade_recovery) so deleting an order deletes its plan, as in production
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
  await db.exec(TRIGGERS);
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
/** A wallet with money for a user (wallet scope, explicit bucket, production) so the posting balance check passes. */
async function fund(db: PGlite, user: string, amt = BIG) {
  await db.query(`insert into public.wallets (user_id, withdrawable_balance) values ($1, $2) on conflict (user_id) do update set withdrawable_balance = excluded.withdrawable_balance`, [user, amt]);
  await db.query(`insert into public.general_ledger (user_id, ledger_scope, direction, category, amount, wallet_bucket, classification, description, transaction_date, created_at)
    values ($1, 'wallet', 'cash_in', 'wallet_deposit', $2, 'withdrawable', 'production', 'test seed', '2026-01-01', '2026-01-01')`, [user, amt]);
  await db.query(`insert into public.test_avail values ($1, $2) on conflict (user_id) do update set amt = excluded.amt`, [user, amt]);
}
async function acct(db: PGlite, groupsSql: string, params: unknown[] = []): Promise<Record<string, number>> {
  const r = await rows<{ a: string; n: string }>(db, `select account_code a, sum(dr - cr) n from sofp_ledger_legs(now() + interval '1 day')
    where transaction_group_id in (${groupsSql}) group by 1`, params);
  return Object.fromEntries(r.map((x) => [x.a, num(x.n)]));
}
async function totals(db: PGlite): Promise<Record<string, number>> {
  const r = await rows<{ a: string; n: string }>(db, `select account_code a, sum(dr - cr) n from sofp_ledger_legs(now() + interval '1 day')
    where account_code in ('A12', 'A13', 'E3', 'R1', 'X1', 'X4', 'A10') group by 1`);
  return Object.fromEntries(r.map((x) => [x.a, num(x.n)]));
}
async function received(db: PGlite) {
  const day = (await rows<{ d: string }>(db, `select ((now() at time zone 'Africa/Kampala')::date)::text d`))[0].d;
  const t = await rows<{ category_key: string; amount: string }>(db, `select category_key, amount from get_cfo_received_by_category_totals($1::date, $1::date)`, [day]);
  const p = await rows<{ product_key: string; amount: string }>(db, `select product_key, amount from get_cfo_received_agent_products_breakdown($1::date, $1::date)`, [day]);
  const g = await rows<{ id: string }>(db, `select id from get_cfo_received_by_category_page($1::date, $1::date, null, null, null, 0, 1000)`, [day]);
  return { t: Object.fromEntries(t.map((x) => [x.category_key, num(x.amount)])), p: Object.fromEntries(p.map((x) => [x.product_key, num(x.amount)])), n: g.length };
}
const net = async (db: PGlite, sale: string | null, plans: string[], bike: boolean) =>
  (await rows<{ j: { a12: number; a13: number; cash: number } }>(db, `select public._merch_receivable_net($1::uuid, $2::uuid[], $3::boolean) j`, [sale, plans, bike]))[0].j;

// ---------------------------------------------------------------- synthetic orders (same ids in both databases)
const AGENT = '00000000-0000-0000-0000-00000000a9e1';
const SUPPLIER = '00000000-0000-0000-0000-00000000bbb1';
const S = (n: number) => `00000000-0000-0000-0000-0000000005${String(n).padStart(2, '0')}`;
async function seedOrders(db: PGlite) {
  await db.query(`insert into profiles (id, full_name) values ($1, 'Test Agent'), ($2, 'Test Supplier') on conflict do nothing`, [AGENT, SUPPLIER]);
  await fund(db, AGENT);
  // S1 bike lease, COO-approved, supplier assigned
  await db.query(`insert into merchandise_sales (id, customer_id, supplier_id, item_name, quantity, valuation_amount, total_amount, total_revenue, lease_term_months, order_status, amount_paid, created_at)
    values ($1, $2, $3, 'Welile Spiro Bike', 1, 600000, 600000, 600000, 12, 'coo_approved', 0, now())`, [S(1), AGENT, SUPPLIER]);
  // S2 out-sourced boutique order, COO-approved
  await db.query(`insert into merchandise_sales (id, customer_id, item_name, quantity, total_revenue, amount_outstanding, payment_plan, fulfilment_type, order_status, created_at)
    values ($1, $2, 'Office chair', 1, 300000, 300000, 'installment', 'outsourced', 'coo_approved', now())`, [S(2), AGENT]);
  // S3..S6: pending orders that carry a receivable (as the legacy restatement left them) and a customer payment
  for (const [n, amt, paid] of [[3, 50000, 5000], [4, 80000, 0], [5, 40000, 0], [6, 70000, 0], [7, 90000, 0]] as const) {
    const plan = `00000000-0000-0000-0000-0000000006${String(n).padStart(2, '0')}`;
    await db.query(`insert into merchandise_sales (id, customer_id, item_name, quantity, total_revenue, amount_outstanding, amount_paid, order_status, created_at)
      values ($1, $2, 'Press Jacket', 1, $3, $3, $4, 'pending_approval', now())`, [S(n), AGENT, amt, paid]);
    await db.query(`insert into merchandise_recovery_plans (id, sale_id, customer_id, item_name, original_amount, outstanding_balance, amount_recovered, status, created_at)
      values ($1, $2, $3, 'Press Jacket', $4::numeric, $4::numeric - $5::numeric, $5::numeric, 'active', now())`, [plan, S(n), AGENT, amt, paid]);
    await db.query(`select public.create_ledger_transaction(jsonb_build_array(
        jsonb_build_object('ledger_scope', 'bridge', 'direction', 'cash_in', 'category', 'merchandise_recovery_receivable_opening', 'amount', $2::numeric, 'source_table', 'merchandise_recovery_plans', 'source_id', $1::uuid),
        jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'category', 'receivable_restatement_equity', 'amount', $2::numeric, 'source_table', 'merchandise_recovery_plans', 'source_id', $1::uuid)),
        'test_opening:' || $1)`, [plan, amt]);
    if (paid > 0) {
      await db.query(`select public.create_ledger_transaction(jsonb_build_array(
          jsonb_build_object('user_id', $2::uuid, 'ledger_scope', 'wallet', 'direction', 'cash_out', 'category', 'agent_repayment', 'amount', $3::numeric, 'recipient_type', 'user', 'wallet_bucket', 'withdrawable', 'source_table', 'merchandise_recovery_plans', 'source_id', $1::uuid),
          jsonb_build_object('user_id', $2::uuid, 'ledger_scope', 'platform', 'direction', 'cash_in', 'category', 'merchandise_recovery_repayment', 'amount', $3::numeric, 'source_table', 'merchandise_recovery_plans', 'source_id', $1::uuid)),
          'test_paid:' || $1)`, [plan, AGENT, paid]);
    }
  }
}
const P = (n: number) => `00000000-0000-0000-0000-0000000006${String(n).padStart(2, '0')}`;

/** What an operation changed, without ids and times, to compare the old and the new functions side by side. */
async function effects(db: PGlite, since: string) {
  return {
    wallet: await rows(db, `select user_id, direction, category, amount, wallet_bucket, recipient_type, description, source_table, source_id, reference_id
      from general_ledger where ledger_scope = 'wallet' and created_at >= $1 and description <> 'test seed' order by source_id, category, amount`, [since]),
    platform: await rows<{ category: string; direction: string; amount: string; source_id: string; ledger_scope: string }>(db, `select ledger_scope, category, direction, amount, source_table, source_id
      from general_ledger where ledger_scope <> 'wallet' and created_at >= $1 order by source_id, category`, [since]),
    sales: await rows(db, `select id, order_status, payment_status, amount_paid, amount_outstanding, total_amount, total_revenue, valuation_amount, unit_price,
      disbursed_amount, payment_projection, cfo_disbursed_by, rejection_reason, rejected_by, notes is not null has_notes from merchandise_sales order by id`),
    plans: await rows(db, `select sale_id, customer_id, item_name, original_amount, outstanding_balance, amount_recovered, daily_rate, status,
      pricing_basis, fee_total, principal_total, is_bike_lease, due_balance, recovery_hold, completed_at is not null done from merchandise_recovery_plans
      order by sale_id, item_name, original_amount, outstanding_balance`),
    recovered: await rows<{ id: string; fee_recovered: string; principal_recovered: string }>(db, `select coalesce(sale_id, id)::text id, fee_recovered, principal_recovered
      from merchandise_recovery_plans order by 1, 2, 3`),
    deductions: await rows(db, `select plan_id, customer_id, item_name, amount, withdrawable_before, outstanding_after from merchandise_recovery_deductions
      where created_at >= $1 order by plan_id, amount`, [since]),
    events: await rows(db, `select event_type, entity_id, metadata from system_events where created_at >= $1 order by entity_id`, [since]),
    audit: await rows(db, `select action_type, table_name, record_id from audit_logs where created_at >= $1 and action_type not like 'merchandise_receivable_%' order by action_type, record_id`, [since]),
  };
}
const t0 = async (db: PGlite) => (await rows<{ t: string }>(db, `select clock_timestamp()::text t`))[0].t;

// ---------------------------------------------------------------- the two databases
let oldDb: PGlite; // production + 20261104090000 (today's functions)
let newDb: PGlite; // production + 20261104090000 + 20261104100000
beforeAll(async () => {
  oldDb = await build(); newDb = await build();
  for (const db of [oldDb, newDb]) { await db.exec(ONEOFF); await seedOrders(db); }
  await newDb.exec(CONTROLS);
}, 300_000);
afterAll(async () => { await oldDb?.close(); await newDb?.close(); });

describe('order of the two migrations', () => {
  it('the controls refuse before the one-off corrections, and the one-off corrections refuse after the controls', async () => {
    const db = await build();
    await expect(db.exec(CONTROLS)).rejects.toThrow(/apply 20261104090000_merchandise_a12_a13_corrections first/);
    expect(await fnMd5(db, 'public.cfo_disburse_bike_lease(uuid, numeric, text)')).toBe(MD5['public.cfo_disburse_bike_lease(uuid, numeric, text)'].old);
    await db.close();
    // the other way round: 20261104090000 pins the report functions this migration changes
    const report = CONTROLS.slice(CONTROLS.indexOf('CREATE OR REPLACE FUNCTION public.get_cfo_received_by_category_totals'));
    const db2 = await build();
    await db2.exec(report.slice(0, report.indexOf('$function$;') + '$function$;'.length));
    await expect(db2.exec(ONEOFF)).rejects.toThrow(/preflight refused/);
    await db2.close();
  }, 300_000);
  it('applied in the right order: new definitions, triggers, closed helpers, standing counterpart unset', async () => {
    for (const [sig, m] of Object.entries(MD5)) expect(await fnMd5(newDb, sig), sig).toBe(m.new);
    for (const [sig, m] of Object.entries(MD5)) expect(await fnMd5(oldDb, sig), sig).toBe(m.old);
    expect((await rows(newDb, `select 1 from pg_trigger where tgname like 'trg_merch_receivable_%'`)).length).toBe(4);
    expect((await rows<{ c: string | null }>(newDb, `select auto_derecognition_counterpart c from merchandise_accounting_controls`))[0].c).toBeNull();
    for (const fn of ['_merch_post_derecognition(uuid, text, text, uuid)', '_merch_receivable_event(uuid, uuid, text)', '_merch_manual_split_safe(uuid, numeric, date)'])
      expect((await rows<{ ok: boolean }>(newDb, `select has_function_privilege('authenticated', $1, 'EXECUTE') ok`, [`public.${fn}`]))[0].ok, fn).toBe(false);
  });
});

describe('the receivable measure equals the balance sheet for every replica item', () => {
  it('before and after the one-off corrections (93 items, A12 and A13)', async () => {
    const db = await build();
    const fn = CONTROLS.slice(CONTROLS.indexOf('CREATE OR REPLACE FUNCTION public._merch_receivable_net'));
    await db.exec(fn.slice(0, fn.indexOf('$function$;') + '$function$;'.length));
    for (const phase of ['before', 'after'] as const) {
      if (phase === 'after') await db.exec(ONEOFF);
      for (const i of FIX.items) {
        const n = await net(db, i.sale, [i.plan], i.acct === 'A13');
        const want = phase === 'before' ? i.L : FIX.expected_after[i.plan];
        expect(i.acct === 'A13' ? n.a13 : n.a12, `${phase} ${i.plan} ${i.acct}`).toBeCloseTo(num(want), 2);
      }
    }
    await db.close();
  }, 300_000);
});

describe('1. bike lease payout: same money, receivable in A13 instead of an expense in X1', () => {
  let o: Awaited<ReturnType<typeof effects>>; let n: Awaited<ReturnType<typeof effects>>;
  beforeAll(async () => {
    const [a, b] = [await t0(oldDb), await t0(newDb)];
    await oldDb.query(`select public.cfo_disburse_bike_lease($1, 0, 'test release')`, [S(1)]);
    await newDb.query(`select public.cfo_disburse_bike_lease($1, 0, 'test release')`, [S(1)]);
    o = await effects(oldDb, a); n = await effects(newDb, b);
  }, 120_000);
  it('pays the same supplier the same amount and changes the order and plan identically', () => {
    expect(n.wallet).toEqual(o.wallet);
    expect(o.wallet).toHaveLength(1);
    expect(n.sales).toEqual(o.sales);
    expect(n.plans).toEqual(o.plans);
    expect(n.audit).toEqual(o.audit);
  });
  it('old: DR X1 equipment_expense; new: DR A13 (bike_recovery_repayment) for the bike price, nothing in X1', async () => {
    expect(o.platform.map((l) => [l.category, l.direction, num(l.amount)])).toEqual([['equipment_expense', 'cash_out', 600000]]);
    expect(n.platform.map((l) => [l.category, l.direction, num(l.amount)])).toEqual([['bike_recovery_repayment', 'cash_out', 600000]]);
    const groups = `select transaction_group_id from general_ledger where source_id = $1 and source_table = 'merchandise_sales'`;
    expect(await acct(newDb, groups, [S(1)])).toEqual({ A13: 600000, L1: -600000 });
    expect(await acct(oldDb, groups, [S(1)])).toEqual({ X1: 600000, L1: -600000 });
    const plan = (await rows<{ id: string }>(newDb, `select id from merchandise_recovery_plans where sale_id = $1`, [S(1)]))[0].id;
    expect((await net(newDb, S(1), [plan], true)).a13).toBe(600000);
  });
});

describe('2. out-sourced merchandise payout: same money, receivable in A12 instead of an expense in X1', () => {
  let o: Awaited<ReturnType<typeof effects>>; let n: Awaited<ReturnType<typeof effects>>;
  beforeAll(async () => {
    const [a, b] = [await t0(oldDb), await t0(newDb)];
    await oldDb.query(`select public.cfo_issue_boutique_order($1)`, [S(2)]);
    await newDb.query(`select public.cfo_issue_boutique_order($1)`, [S(2)]);
    o = await effects(oldDb, a); n = await effects(newDb, b);
  }, 120_000);
  it('credits the agent the same funds and changes the order and plan identically', () => {
    expect(n.wallet).toEqual(o.wallet);
    expect(o.wallet).toHaveLength(1);
    expect(n.sales).toEqual(o.sales);
    expect(n.plans).toEqual(o.plans);
    expect(n.events).toEqual(o.events);
  });
  it('old: DR X1; new: DR A12 (smartphone_advance_receivable) for the funds', async () => {
    expect(o.platform.map((l) => [l.category, num(l.amount)])).toEqual([['equipment_expense', 300000]]);
    expect(n.platform.map((l) => [l.category, num(l.amount)])).toEqual([['smartphone_advance_receivable', 300000]]);
    expect(await acct(newDb, `select transaction_group_id from general_ledger where source_id = $1`, [S(2)])).toEqual({ A12: 300000, L1: -300000 });
  });
});

describe('3. manual payments: same money, principal to A12 / A13 and the charge to R1', () => {
  const phone = FIX.plans.find((p) => String(p.id).startsWith('9feb42a7'))!;
  const bike = FIX.plans.find((p) => String(p.id).startsWith('bfe58c27'))!;
  let o: Awaited<ReturnType<typeof effects>>; let n: Awaited<ReturnType<typeof effects>>;
  let ro: Awaited<ReturnType<typeof received>>; let rn: Awaited<ReturnType<typeof received>>;
  beforeAll(async () => {
    for (const db of [oldDb, newDb]) for (const p of [phone, bike]) await fund(db, String(p.customer_id), 40000);
    const [a, b] = [await t0(oldDb), await t0(newDb)];
    for (const db of [oldDb, newDb]) {
      for (const p of [phone, bike]) await as(db, String(p.customer_id), () => db.query(`select public.agent_pay_merchandise_plan($1, 25000)`, [p.id]));
    }
    o = await effects(oldDb, a); n = await effects(newDb, b);
    ro = await received(oldDb); rn = await received(newDb);
  }, 120_000);
  it('takes the same money from the same wallets and changes the same rows', () => {
    expect(o.wallet).toHaveLength(2);
    expect(n.wallet).toEqual(o.wallet);
    expect(n.deductions).toEqual(o.deductions);
    expect(n.plans).toEqual(o.plans);
    expect(n.sales).toEqual(o.sales);
  });
  it('old: all 25,000 to A12 / A13; new: principal + charge = 25,000, the charge in R1', () => {
    const by = (xs: typeof o.platform, id: unknown) => xs.filter((l) => l.source_id === id).map((l) => [l.category, num(l.amount)]);
    expect(by(o.platform, phone.id)).toEqual([['merchandise_recovery_repayment', 25000]]);
    expect(by(o.platform, bike.id)).toEqual([['bike_recovery_repayment', 25000]]);
    for (const [p, cat] of [[phone, 'merchandise_recovery_repayment'], [bike, 'bike_recovery_repayment']] as const) {
      const legs = by(n.platform, p.id);
      const fee = legs.find((l) => l[0] === 'access_fee_collected')?.[1] as number;
      const prin = legs.find((l) => l[0] === cat)?.[1] as number;
      expect(fee, String(p.id)).toBeGreaterThan(0);
      expect(prin + fee).toBe(25000);
    }
  });
  it('the v2 bike lease records principal and fee recovered as the daily engine does; nothing else differs', () => {
    const ob = o.recovered.find((r) => r.id === bike.sale_id)!; const nb = n.recovered.find((r) => r.id === bike.sale_id)!;
    const fee = n.platform.find((l) => l.source_id === bike.id && l.category === 'access_fee_collected')!;
    expect(num(nb.fee_recovered) - num(ob.fee_recovered)).toBe(num(fee.amount));
    expect(num(nb.principal_recovered) - num(ob.principal_recovered)).toBe(25000 - num(fee.amount));
    expect(n.recovered.filter((r) => r.id !== bike.sale_id)).toEqual(o.recovered.filter((r) => r.id !== bike.sale_id));
  });
  it('Money received: same total; the charge shows as Revenue Collected', () => {
    const sum = (r: typeof ro) => Object.values(r.t).reduce((x, y) => x + y, 0);
    expect(sum(rn)).toBe(sum(ro));
    const fees = n.platform.filter((l) => l.category === 'access_fee_collected').reduce((x, l) => x + num(l.amount), 0);
    expect(rn.t.fees - ro.t.fees).toBe(fees);
  });
});

describe('4. rejection / cancellation / deletion: queued once, the CFO decides, posted once', () => {
  it('a rejection (order rejected + plan cancelled) moves the same money as before and queues ONE row with what is left', async () => {
    const [a, b] = [await t0(oldDb), await t0(newDb)];
    await oldDb.query(`select public.reject_merchandise_purchase($1, 'test rejection reason')`, [S(3)]);
    await newDb.query(`select public.reject_merchandise_purchase($1, 'test rejection reason')`, [S(3)]);
    const o = await effects(oldDb, a); const n = await effects(newDb, b);
    expect(n.wallet).toEqual(o.wallet); // the 5,000 refund, identical
    expect(o.wallet).toHaveLength(1);
    expect(n.platform).toEqual(o.platform);
    expect(n.sales).toEqual(o.sales);
    expect(n.plans).toEqual(o.plans);
    const q = await rows<{ a12_net: string; cash_collected_net: string; flags: string[]; status: string; events: unknown[] }>(newDb,
      `select * from merchandise_receivable_derecognitions where subject_id = $1`, [S(3)]);
    expect(q).toHaveLength(1);
    expect([num(q[0].a12_net), num(q[0].cash_collected_net), q[0].status, q[0].events.length]).toEqual([45000, 0, 'pending', 2]);
    expect(q[0].flags).toEqual(['receivable_open']);
    expect((await rows(newDb, `select 1 from audit_logs where action_type = 'merchandise_receivable_event' and reason in ('plan_cancelled', 'order_rejected')`)).length).toBe(2);
  });
  it('the CFO posts E3 once: exactly what is left, balanced, not counted as money received; a second call does nothing', async () => {
    const id = (await rows<{ id: string }>(newDb, `select id from merchandise_receivable_derecognitions where subject_id = $1`, [S(3)]))[0].id;
    const r0 = await received(newDb);
    const res = await as(newDb, CFO, () => rows<{ j: { status: string; ledger_group_id: string } }>(newDb,
      `select public.cfo_post_merchandise_derecognition($1, 'E3', 'Goods never delivered, order rejected') j`, [id]));
    expect(res[0].j.status).toBe('posted');
    expect(await acct(newDb, `select $1::uuid`, [res[0].j.ledger_group_id])).toEqual({ A12: -45000, E3: 45000 });
    expect((await net(newDb, S(3), [P(3)], false)).a12).toBe(0);
    expect(await received(newDb)).toEqual(r0);
    const again = await as(newDb, CFO, () => rows<{ j: { already: boolean } }>(newDb,
      `select public.cfo_post_merchandise_derecognition($1, 'X4', 'second attempt must not post') j`, [id]));
    expect(again[0].j.already).toBe(true);
    expect((await rows(newDb, `select 1 from general_ledger where idempotency_key like 'merch_recv_derecog:%'`)).length).toBe(2);
  });
  it('X4 (write-off) for a cancelled plan: A12 to zero, X4 debited, Money received unchanged', async () => {
    const r0 = await received(newDb);
    await newDb.query(`update merchandise_recovery_plans set status = 'cancelled' where id = $1`, [P(4)]);
    const id = (await rows<{ id: string }>(newDb, `select id from merchandise_receivable_derecognitions where subject_id = $1 and status = 'pending'`, [S(4)]))[0].id;
    const res = await as(newDb, CFO, () => rows<{ j: { ledger_group_id: string } }>(newDb,
      `select public.cfo_post_merchandise_derecognition($1, 'X4', 'Delivered, agent gone: write off') j`, [id]));
    expect(await acct(newDb, `select $1::uuid`, [res[0].j.ledger_group_id])).toEqual({ A12: -80000, X4: 80000 });
    expect((await net(newDb, S(4), [P(4)], false)).a12).toBe(0);
    expect(await received(newDb)).toEqual(r0);
  });
  it('deleting an order (and, by the cascade, its plan) queues ONE row that keeps the deleted plan; posting clears it', async () => {
    await newDb.query(`delete from merchandise_sales where id = $1`, [S(5)]);
    const q = await rows<{ id: string; plan_ids: string[]; flags: string[]; a12_net: string; events: Array<{ event: string }> }>(newDb,
      `select * from merchandise_receivable_derecognitions where subject_id = $1`, [S(5)]);
    expect(q).toHaveLength(1);
    expect(q[0].plan_ids).toEqual([P(5)]);
    expect(q[0].events.map((e) => e.event).sort()).toEqual(['order_deleted', 'plan_deleted']);
    expect(q[0].flags).toContain('deleted');
    expect(num(q[0].a12_net)).toBe(40000);
    await as(newDb, CFO, () => newDb.query(`select public.cfo_post_merchandise_derecognition($1, 'E3', 'Order deleted, never delivered')`, [q[0].id]));
    expect((await net(newDb, S(5), [P(5)], false)).a12).toBe(0);
  });
  it('a standing counterpart posts automatically in the same transaction', async () => {
    await newDb.exec(`update merchandise_accounting_controls set auto_derecognition_counterpart = 'E3'`);
    await newDb.query(`select public.reject_merchandise_purchase($1, 'test rejection reason')`, [S(6)]);
    const q = await rows<{ status: string; counterpart: string }>(newDb, `select * from merchandise_receivable_derecognitions where subject_id = $1`, [S(6)]);
    expect(q.map((x) => [x.status, x.counterpart])).toEqual([['posted', 'E3']]);
    expect((await net(newDb, S(6), [P(6)], false)).a12).toBe(0);
  });
  it('atomic: if the automatic posting fails, the rejection itself is undone (no money moved, no status changed)', async () => {
    await newDb.exec(`create function public.test_block() returns trigger language plpgsql as $f$ begin
      if new.idempotency_key like 'merch_recv_derecog:%' then raise exception 'posting blocked (test)'; end if; return new; end $f$;
      create trigger test_block before insert on public.general_ledger for each row execute function public.test_block();`);
    const before = await rows(newDb, `select order_status from merchandise_sales where id = $1`, [S(7)]);
    await expect(newDb.query(`select public.reject_merchandise_purchase($1, 'test rejection reason')`, [S(7)])).rejects.toThrow(/posting blocked/);
    expect(await rows(newDb, `select order_status from merchandise_sales where id = $1`, [S(7)])).toEqual(before);
    expect((await rows(newDb, `select 1 from merchandise_receivable_derecognitions where subject_id = $1`, [S(7)])).length).toBe(0);
    await newDb.exec(`drop trigger test_block on public.general_ledger; update merchandise_accounting_controls set auto_derecognition_counterpart = null`);
  });
  it('nothing left, nothing queued: a rejection of an order with no receivable and no cash creates no row', async () => {
    const id = '00000000-0000-0000-0000-0000000005ff';
    await newDb.query(`insert into merchandise_sales (id, customer_id, item_name, quantity, total_revenue, order_status, created_at) values ($1, $2, 'Polo', 1, 35000, 'pending_approval', now())`, [id, AGENT]);
    await newDb.query(`select public.reject_merchandise_purchase($1, 'test rejection reason')`, [id]);
    expect((await rows(newDb, `select 1 from merchandise_receivable_derecognitions where subject_id = $1`, [id])).length).toBe(0);
  });
  it('only the CFO can decide, with a reason, and only E3 or X4', async () => {
    const other = '00000000-0000-0000-0000-00000000c001';
    await newDb.query(`update merchandise_recovery_plans set status = 'cancelled' where id = $1`, [P(7)]);
    const id = (await rows<{ id: string }>(newDb, `select id from merchandise_receivable_derecognitions where subject_id = $1 and status = 'pending'`, [S(7)]))[0].id;
    await expect(as(newDb, other, () => newDb.query(`select public.cfo_post_merchandise_derecognition($1, 'E3', 'not the CFO at all')`, [id]))).rejects.toThrow(/Only the CFO/);
    await expect(as(newDb, CFO, () => newDb.query(`select public.cfo_post_merchandise_derecognition($1, 'A1', 'a plug account here')`, [id]))).rejects.toThrow(/E3 \(receivable/);
    await expect(as(newDb, CFO, () => newDb.query(`select public.cfo_post_merchandise_derecognition($1, 'E3', 'short')`, [id]))).rejects.toThrow(/10 characters/);
    expect((await rows<{ status: string }>(newDb, `select status from merchandise_receivable_derecognitions where id = $1`, [id]))[0].status).toBe('pending');
  });
});

describe('every group the controls posted', () => {
  it('balances raw and on mapped accounts and has no wallet leg', async () => {
    const bad = await rows(newDb, `
      select g.transaction_group_id from general_ledger g
      join ledger_account_map m on m.ledger_scope = g.ledger_scope and m.category = g.category and m.wallet_bucket is null
      where g.idempotency_key like 'merch_recv_derecog:%'
      group by 1 having sum(case when g.direction = m.debit_when then g.amount else -g.amount end) <> 0
        or sum(case when g.direction = 'cash_in' then g.amount else -g.amount end) <> 0 or bool_or(g.ledger_scope = 'wallet')`);
    expect(bad).toEqual([]);
    expect((await rows(newDb, `select 1 from ledger_mapped_balance_violations v where v.transaction_group_id in (select transaction_group_id from general_ledger where idempotency_key like 'merch_recv_derecog:%' or reference_id like 'bike-lease-supplier-payment-%' or reference_id like 'merch-outsourced-disburse-%')`)).length).toBe(0);
  });
  it('X1 is untouched by the new payouts and A10 is untouched throughout (no item corrected twice)', async () => {
    const tn = await totals(newDb); const to = await totals(oldDb);
    expect(tn.A10).toBe(to.A10);
    expect(to.X1 - tn.X1).toBe(900000); // bike 600,000 + out-sourced 300,000 are receivables, not expenses
  });
});

describe('rollback', () => {
  it('restores the payout, payment and report functions; tables and posted entries stay', async () => {
    const db = await build();
    await db.exec(ONEOFF); await db.exec(CONTROLS);
    await db.exec(ROLLBACK);
    for (const [sig, m] of Object.entries(MD5)) expect(await fnMd5(db, sig), sig).toBe(m.old);
    expect((await rows(db, `select 1 from pg_trigger where tgname like 'trg_merch_receivable_%'`)).length).toBe(0);
    expect(await fnMd5(db, 'public.cfo_post_merchandise_derecognition(uuid, text, text)')).toBeNull();
    expect((await rows(db, `select to_regclass('public.merchandise_receivable_derecognitions') t`))[0].t).not.toBeNull();
    await db.close();
  }, 300_000);
});
