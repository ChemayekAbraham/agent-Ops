// @vitest-environment node
/**
 * Merchandise phase 3 (supabase/migrations/20261104150000_merchandise_phase3_stock_phone_pledge.sql), CFO 2026-11-04:
 * smartphone X1 / L1 double count, company stock issued on credit, the two rejected bikes with cash kept, and the monthly
 * Returns smartphone pledge.
 *
 * Runs on PGlite with production's own code verbatim (scripts/fixtures/merch-a12a13-prod-2026-11-04.sql,
 * merch-controls-prod-2026-11-04.sql, merch-phase3-prod-2026-11-04.sql, sofp-prod-2026-11-02.sql) over the replica of every
 * merchandise plan / order with an A12 / A13 balance and every ledger group touching them (merch-a12a13-prod-2026-11-04.json),
 * with production's two earlier merchandise migrations applied first (20261104090000, 20261104100000), as in production.
 *
 * Proves: order and preflight; the 8 smartphone corrections (DR L1 / CR X1, 5,245,000) leave A12 and every wallet untouched
 * and are not repeatable; a new smartphone payout moves the same money as before and books the phone once (A12), with
 * no X1 and no net L1 for the agent memo; the 7 company-stock items (no delivery evidence) are queued (1,015,000) and
 * nothing is posted; sales revenue only, and only on delivery evidence (a handover record, automatic; or a CFO-verified
 * delivery document), exactly once; a future issue is queued on every path and recognised only when the handover is
 * confirmed, never twice, and a later cancellation is caught by the derecognition queue; the pledge collects exactly as
 * before on an eligible order and skips (and records) an ineligible one; the two rejected motorcycle plans' payments are
 * retained (CFO policy, no refund): DR E3 / CR R1 merchandise_payment_retained, review rows flagged retained_payment; a
 * future rejected motorcycle plan's cash is classified retained and recognised as income only on its credit balance; the
 * Money received report is unchanged; rollback.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const ONEOFF = read('supabase/migrations/20261104090000_merchandise_a12_a13_corrections.sql');
const CONTROLS = read('supabase/migrations/20261104100000_merchandise_receivable_controls.sql');
const PHASE3 = read('supabase/migrations/20261104150000_merchandise_phase3_stock_phone_pledge.sql');
const ROLLBACK = read('supabase/rollbacks/20261104150000_merchandise_phase3_stock_phone_pledge.rollback.sql');
const PHASE3B = read('supabase/migrations/20261104160000_merchandise_phase3b_controls.sql');
const ROLLBACK3B = read('supabase/rollbacks/20261104160000_merchandise_phase3b_controls.rollback.sql');
const PROD3B = read('scripts/fixtures/merch-phase3b-prod-2026-11-04.sql');
const PROD = read('scripts/fixtures/merch-a12a13-prod-2026-11-04.sql');
const PROD2 = read('scripts/fixtures/merch-controls-prod-2026-11-04.sql');
const PROD3 = read('scripts/fixtures/merch-phase3-prod-2026-11-04.sql');
const SOFP_ALL = read('scripts/fixtures/sofp-prod-2026-11-02.sql');
const SOFP = SOFP_ALL.slice(SOFP_ALL.indexOf('CREATE OR REPLACE FUNCTION public.sofp_ledger_legs'),
  SOFP_ALL.indexOf('CREATE OR REPLACE FUNCTION public.get_statement_of_financial_position'));
const PHONE_BLOCK = PHASE3.slice(PHASE3.indexOf('DO $phone$'), PHASE3.indexOf('END $phone$;') + 'END $phone$;'.length);

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

// ---------------------------------------------------------------- databases: production as now (old) and + phase 3 (new)
let oldDb: PGlite;
let newDb: PGlite;
let receivedBefore: Awaited<ReturnType<typeof received>>;
let totalsBefore: Record<string, number>;
let legsBefore: number;
let walletBefore: string;
beforeAll(async () => {
  oldDb = await build(); newDb = await build();
  receivedBefore = await received(newDb);
  totalsBefore = await acct(newDb);
  legsBefore = num((await rows<{ n: string }>(newDb, `select count(*) n from general_ledger`))[0].n);
  walletBefore = JSON.stringify(await rows(newDb, `select * from general_ledger where ledger_scope = 'wallet' order by id`));
  await newDb.exec(PHASE3);
}, 400_000);
afterAll(async () => { await oldDb?.close(); await newDb?.close(); });

describe('order and preflight', () => {
  it('runs production\'s definitions before the migration', async () => {
    expect(await fnMd5(oldDb, 'public.cfo_disburse_smartphone_order(uuid, numeric, text)')).toBe(FIX3.md5.phone_old);
    expect(await fnMd5(oldDb, 'public.apply_smartphone_roi_pledge(uuid, numeric, text)')).toBe(FIX3.md5.pledge_old);
    expect(await fnMd5(oldDb, 'public.ledger_category_allowlist()')).toBe(FIX3.md5.allow_old);
  });
  it('installs the new definitions', async () => {
    expect(await fnMd5(newDb, 'public.cfo_disburse_smartphone_order(uuid, numeric, text)')).toBe(FIX3.md5.phone_new);
    expect(await fnMd5(newDb, 'public.apply_smartphone_roi_pledge(uuid, numeric, text)')).toBe(FIX3.md5.pledge_new);
    expect(await fnMd5(newDb, 'public.ledger_category_allowlist()')).toBe(FIX3.md5.allow_new);
  });
  it('refuses before the two earlier merchandise migrations, and on evidence drift, changing nothing', async () => {
    const db = new PGlite();
    await db.exec(STANDINS); await db.exec(PROD); await db.exec(PROD2); await db.exec(PROD3); await db.exec(SOFP);
    const load = async (t: string, r: unknown[]) =>
      db.query(`insert into public.${t} select * from json_populate_recordset(null::public.${t}, $1::json)`, [JSON.stringify(r)]);
    await load('ledger_account_map', FIX.map); await load('ledger_integrity_config', FIX.integrity);
    await load('merchandise_recovery_plans', FIX.plans); await load('merchandise_sales', FIX.sales);
    await load('smartphone_repayment_schedules', FIX.schedules); await load('general_ledger', LEGS);
    await load('agent_bike_leases', FIX2.bike_leases);
    await db.exec(TRIGGERS); await db.exec(ONEOFF);
    await expect(db.exec(PHASE3)).rejects.toThrow(/apply 20261104090000 and 20261104100000 first/);
    await db.exec(CONTROLS);
    await db.query(`update merchandise_sales set total_revenue = 56000 where id = $1`, [FIX3.stock[0][0]]);
    await expect(db.exec(PHASE3)).rejects.toThrow(/company-stock evidence moved/);
    expect(await fnMd5(db, 'public.cfo_disburse_smartphone_order(uuid, numeric, text)')).toBe(FIX3.md5.phone_old);
    expect(to(await rows(db, `select to_regclass('public.merchandise_stock_recognitions') t`))).toBeNull();
    await db.close();
  }, 400_000);
  it('a second apply is refused', async () => {
    await expect(newDb.exec(PHASE3)).rejects.toThrow(/preflight refused|already applied/);
  });
});
const to = (r: Array<Record<string, unknown>>) => r[0].t;

describe('allowlist and mapping', () => {
  it('keeps every existing category and adds exactly the three new ones, each mapped once', async () => {
    const o = (await rows<{ a: string[] }>(oldDb, `select ledger_category_allowlist() a`))[0].a;
    const n = (await rows<{ a: string[] }>(newDb, `select ledger_category_allowlist() a`))[0].a;
    expect(n.slice(0, o.length)).toEqual(o);
    expect(n.slice(o.length)).toEqual(['merchandise_revenue', 'merchandise_advance_memo_offset', 'merchandise_payment_retained']);
    const m = await rows<{ c: string; a: string; d: string }>(newDb, `select category c, account_code a, debit_when d from ledger_account_map
      where category in ('merchandise_revenue', 'merchandise_advance_memo_offset', 'merchandise_payment_retained') order by 1`);
    expect(m).toEqual([{ c: 'merchandise_advance_memo_offset', a: 'L1', d: 'cash_out' },
      { c: 'merchandise_payment_retained', a: 'R1', d: 'cash_in' }, { c: 'merchandise_revenue', a: 'R1', d: 'cash_out' }]);
  });
});

describe('2. the 8 smartphone payouts: DR L1 / CR X1, once', () => {
  it('posts one balanced platform-only group per payout, 5,245,000, linked to the sale and to both original groups', async () => {
    const g = await rows<{ gid: string; n: string; sc: string[]; cin: string; cout: string; sid: string; refs: string[] }>(newDb, `
      select transaction_group_id gid, count(*) n, array_agg(distinct ledger_scope) sc, sum(amount) filter (where direction = 'cash_in') cin,
             sum(amount) filter (where direction = 'cash_out') cout, min(source_id::text) sid, array_agg(reference_id order by category) refs
      from general_ledger where idempotency_key like 'merch_phase3_20261104:%:PHONE_MEMO' group by 1`);
    expect(g.length).toBe(8);
    expect(g.reduce((a, x) => a + num(x.cin), 0)).toBe(5_245_000);
    for (const x of g) {
      expect([num(x.n), x.sc, num(x.cin)]).toEqual([2, ['platform'], num(x.cout)]);
      const want = FIX3.phones.find(([s]) => s === x.sid)!;
      expect(num(x.cin)).toBe(want[1]);
      expect(x.refs.every((r) => r && r.length === 36)).toBe(true);
    }
  });
  it('per payout: X1 0, the agent memo nets to 0 in L1 (the supplier credit stays), A12 unchanged', async () => {
    for (const [sale, amt] of FIX3.phones) {
      const o = await saleAcct(oldDb, sale); const n = await saleAcct(newDb, sale);
      expect(n.X1 ?? 0, `X1 ${sale}`).toBe(0);
      expect(o.X1, `X1 before ${sale}`).toBe(amt);
      expect(n.L1, `L1 ${sale}`).toBe(o.L1 + amt);
      expect(n.A12 ?? 0, `A12 ${sale}`).toBe(o.A12 ?? 0);
    }
  });
  it('totals: X1 -5,245,000, L1 -5,245,000 (liability), nothing else; no wallet leg, nothing edited', async () => {
    const n = await acct(newDb, `select transaction_group_id from general_ledger where idempotency_key like 'merch_phase3_20261104:%:PHONE_MEMO'`);
    expect(n).toEqual({ L1: 5_245_000, X1: -5_245_000 });
    expect(JSON.stringify(await rows(newDb, `select * from general_ledger where ledger_scope = 'wallet' order by id`))).toBe(walletBefore);
    for (const l of FIX.legs.slice(0, 400)) {
      const r = await rows<{ a: string }>(newDb, `select amount a from general_ledger where id = $1`, [l.id]);
      expect(num(r[0].a)).toBe(num(l.amt));
    }
  });
  it('is idempotent: running the block again posts nothing', async () => {
    const n0 = num((await rows<{ n: string }>(newDb, `select count(*) n from general_ledger`))[0].n);
    await newDb.exec(PHONE_BLOCK);
    expect(num((await rows<{ n: string }>(newDb, `select count(*) n from general_ledger`))[0].n)).toBe(n0);
  });
});

describe('2. a new smartphone payout: same money, the phone booked once (A12)', () => {
  const SALE = '00000000-0000-0000-0000-0000000007a1';
  const AGENT = '00000000-0000-0000-0000-0000000007a2';
  const SUP = '00000000-0000-0000-0000-0000000007a3';
  let o: Awaited<ReturnType<typeof effects>>; let n: Awaited<ReturnType<typeof effects>>;
  beforeAll(async () => {
    const res: Array<Awaited<ReturnType<typeof effects>>> = [];
    for (const db of [oldDb, newDb]) {
      await db.query(`insert into profiles (id, full_name) values ($1, 'Phone Agent'), ($2, 'Phone Supplier') on conflict do nothing`, [AGENT, SUP]);
      await db.query(`insert into merchandise_sales (id, customer_id, supplier_id, item_name, quantity, unit_price, total_amount, total_revenue,
        advance_period_months, grace_days, order_status, payment_plan, created_at) values ($1, $2, $3, 'Welile Smartphone', 1, 600000, 600000, 600000, 3, 7, 'coo_approved', 'full', now())`,
        [SALE, AGENT, SUP]);
      const since = await t0(db);
      await as(db, CFO, () => db.query(`select public.cfo_disburse_smartphone_order($1, null, 'test')`, [SALE]));
      res.push(await effects(db, since));
    }
    [o, n] = res;
  }, 120_000);
  it('the same wallet legs (supplier paid, advance shown to the agent), order, plan and schedule', () => {
    expect(n.wallet).toEqual(o.wallet);
    expect(n.wallet.length).toBe(2);
    expect(n.sales).toEqual(o.sales);
    expect(n.plans).toEqual(o.plans);
    expect(n.schedules).toEqual(o.schedules);
  });
  it('company side: old X1 + a second A12; new A12 once + the memo offset in L1', async () => {
    const cats = (e: typeof o) => e.platform.filter((l) => l.source_id === SALE).map((l) => `${l.category}/${l.direction}/${num(l.amount)}`).sort();
    expect(cats(o)).toEqual(['equipment_expense/cash_out/600000', 'smartphone_advance_receivable/cash_out/600000']);
    expect(cats(n)).toEqual(['merchandise_advance_memo_offset/cash_out/600000', 'smartphone_advance_receivable/cash_out/600000']);
    const a = await saleAcct(newDb, SALE); const b = await saleAcct(oldDb, SALE);
    expect(a).toEqual({ A12: 600000, L1: -600000 });
    expect(b).toEqual({ A12: 600000, X1: 600000, L1: -1200000 });
  });
});

describe('4. company stock: sales revenue, only on verified delivery evidence', () => {
  it('queues the 7 historical items, 1,015,000, none with delivery evidence, nothing posted', async () => {
    const q = await rows<{ sale_id: string; amount: string; flags: string[]; status: string; account: string; origin: string }>(newDb,
      `select sale_id, amount, flags, status, account, origin from merchandise_stock_recognitions order by sale_id`);
    expect(q.length).toBe(7);
    expect(q.reduce((a, x) => a + num(x.amount), 0)).toBe(1_015_000);
    for (const x of q) {
      expect([x.status, x.account, x.origin]).toEqual(['pending', 'A12', 'historical_20261104']);
      expect(x.flags).toEqual(expect.arrayContaining(['no_handover_record', 'historical']));
      expect(num(x.amount)).toBe(FIX3.stock.find(([s]) => s === x.sale_id)![1]);
    }
    // a customer payment is not delivery evidence; the out-sourced chair was never paid to a supplier
    expect(q.find((x) => x.sale_id === FIX3.stock[5][0])!.flags).toContain('customer_payment_only');
    expect(q.find((x) => x.sale_id === FIX3.stock[4][0])!.flags).toContain('outsourced_item_no_supplier_payout');
    expect((await rows(newDb, `select 1 from general_ledger where idempotency_key like 'merch_stock_recog:%'`)).length).toBe(0);
    expect((await rows<{ c: string }>(newDb, `select stock_issue_counterpart c from merchandise_accounting_controls`))[0].c).toBe('revenue');
  });
  it('only the CFO, only revenue, only with a verified delivery document when there is no handover record; posts once', async () => {
    const [aec] = await rows<{ id: string }>(newDb, `select id from merchandise_stock_recognitions where sale_id = $1`, [FIX3.stock[5][0]]);
    const DOC = 'Signed delivery note DN-0925-014, 2 jackets received 25 Sep';
    await expect(as(newDb, OPS, () => newDb.query(`select cfo_post_merchandise_stock_recognition($1, $2)`, [aec.id, DOC])))
      .rejects.toThrow(/Only the CFO/);
    await expect(as(newDb, CFO, () => newDb.query(`select cfo_post_merchandise_stock_recognition($1, 'paid 10,000')`, [aec.id])))
      .rejects.toThrow(/No handover record/);
    // E3 is gone: the table only accepts revenue
    await expect(newDb.query(`update merchandise_stock_recognitions set counterpart = 'E3' where id = $1`, [aec.id])).rejects.toThrow(/check/);
    const r1 = await as(newDb, CFO, () => rows<{ j: { status: string; amount: number; counterpart: string } }>(newDb,
      `select cfo_post_merchandise_stock_recognition($1, $2) j`, [aec.id, DOC]));
    expect([r1[0].j.status, num(r1[0].j.amount), r1[0].j.counterpart]).toEqual(['posted', 110000, 'revenue']);
    const r2 = await as(newDb, CFO, () => rows<{ j: { already: boolean } }>(newDb, `select cfo_post_merchandise_stock_recognition($1, $2) j`, [aec.id, DOC]));
    expect(r2[0].j.already).toBe(true);
    const row = (await rows<{ evidence_kind: string; delivery_evidence: string }>(newDb,
      `select evidence_kind, delivery_evidence from merchandise_stock_recognitions where id = $1`, [aec.id]))[0];
    expect(row).toEqual({ evidence_kind: 'cfo_verified_document', delivery_evidence: DOC });
    // A12 = 110,000 principal less the 6,410 principal already collected; the 110,000 is sales revenue
    expect(await saleAcct(newDb, FIX3.stock[5][0])).toEqual(expect.objectContaining({ A12: 103590 }));
    const g = await acct(newDb, `select transaction_group_id from general_ledger where idempotency_key like 'merch_stock_recog:%'`);
    expect(g).toEqual({ A12: 110000, R1: -110000 });
  });
  it('the other six stay pending (no evidence): nothing posted for them', async () => {
    const q = await rows<{ sale_id: string }>(newDb, `select sale_id from merchandise_stock_recognitions where status = 'pending' order by sale_id`);
    expect(q.length).toBe(6);
    for (const x of q) expect((await saleAcct(newDb, x.sale_id)).A12 ?? 0, x.sale_id).toBe(0);
  });
});

describe('4. future company-stock issues: queued on every path, recognised only after a confirmed handover', () => {
  const AG = '00000000-0000-0000-0000-0000000008a1';
  const H = '00000000-0000-0000-0000-0000000008b1'; // handover path
  let agentOpsSale = '';
  it('handover: same order and plan rows as before; receivable and revenue recognised in the handover transaction', async () => {
    const res: Array<Awaited<ReturnType<typeof effects>>> = [];
    for (const db of [oldDb, newDb]) {
      await db.query(`insert into profiles (id, full_name) values ($1, 'Stock Agent') on conflict do nothing`, [AG]);
      await db.query(`insert into merchandise_sales (id, customer_id, item_name, quantity, unit_price, total_revenue, amount_outstanding, amount_paid,
        payment_plan, fulfilment_type, order_status, created_at) values ($1, $2, 'Press Jacket', 2, 55000, 110000, 110000, 0, 'installment', 'company_issued', 'awaiting_handover', now())`, [H, AG]);
      const since = await t0(db);
      await as(db, OPS, () => db.query(`select confirm_merchandise_handover($1, 'handed over at the office')`, [H]));
      res.push(await effects(db, since));
    }
    expect(res[1].sales).toEqual(res[0].sales);
    expect(res[1].plans).toEqual(res[0].plans);
    expect(res[1].wallet).toEqual(res[0].wallet);
    const q = await rows<{ amount: string; status: string; origin: string; flags: string[]; evidence_kind: string; delivery_evidence: string; counterpart: string }>(newDb,
      `select amount, status, origin, flags, evidence_kind, delivery_evidence, counterpart from merchandise_stock_recognitions where sale_id = $1`, [H]);
    expect(q.map((x) => [num(x.amount), x.status, x.origin, x.counterpart, x.evidence_kind, x.delivery_evidence]))
      .toEqual([[110000, 'posted', 'issue', 'revenue', 'handover_record', 'handed over at the office']]);
    expect(q[0].flags).toEqual([]);
    expect(await saleAcct(newDb, H)).toEqual({ A12: 110000, R1: -110000 });
  });
  it('a second status change (issued -> completed) neither queues nor recognises again', async () => {
    await newDb.query(`update merchandise_sales set order_status = 'completed' where id = $1`, [H]);
    expect((await rows(newDb, `select 1 from merchandise_stock_recognitions where sale_id = $1`, [H])).length).toBe(1);
    expect(await saleAcct(newDb, H)).toEqual({ A12: 110000, R1: -110000 });
  });
  it('Agent Ops issue without a handover: queued, flagged, NOT recognised (status alone is not evidence)', async () => {
    const [{ s: sale }] = await as(newDb, OPS, () => rows<{ s: string }>(newDb,
      `select agent_ops_issue_agent_product($1, 'Welile Polo', 2, 35000, 25000, null, 'installment', 20000, 'issued at centre') s`, [AG]));
    agentOpsSale = sale;
    const q = await rows<{ amount: string; flags: string[]; status: string }>(newDb, `select amount, flags, status from merchandise_stock_recognitions where sale_id = $1`, [sale]);
    expect([num(q[0].amount), q[0].status]).toEqual([50000, 'pending']);
    expect(q[0].flags).toEqual(expect.arrayContaining(['no_handover_record', 'unrecorded_payment']));
    expect((await saleAcct(newDb, sale)).A12 ?? 0).toBe(0);
  });
  it('the handover recorded later is the evidence: recognised then, once', async () => {
    await newDb.query(`update merchandise_sales set handed_over_at = now(), handed_over_by = $2, handover_note = 'collected at the centre' where id = $1`, [agentOpsSale, OPS]);
    const q = await rows<{ status: string; evidence_kind: string }>(newDb, `select status, evidence_kind from merchandise_stock_recognitions where sale_id = $1`, [agentOpsSale]);
    expect(q).toEqual([{ status: 'posted', evidence_kind: 'handover_record' }]);
    expect(await saleAcct(newDb, agentOpsSale)).toEqual({ A12: 50000, R1: -50000 });
    await newDb.query(`update merchandise_sales set handover_note = 'edited' where id = $1`, [agentOpsSale]);
    expect((await rows(newDb, `select 1 from general_ledger where idempotency_key like 'merch_stock_recog:%' and source_id = $1`, [agentOpsSale])).length).toBe(2);
  });
  it('a cancellation after recognition is caught by the derecognition queue (nothing recognised twice)', async () => {
    await newDb.query(`update merchandise_sales set order_status = 'cancelled' where id = $1`, [H]);
    const d = await rows<{ a12_net: string; status: string }>(newDb, `select a12_net, status from merchandise_receivable_derecognitions where sale_id = $1`, [H]);
    expect(d.map((x) => [num(x.a12_net), x.status])).toEqual([[110000, 'pending']]);
  });
  it('an order cancelled before any evidence recognises nothing', async () => {
    const S3 = '00000000-0000-0000-0000-0000000008b3';
    await newDb.query(`insert into merchandise_sales (id, customer_id, item_name, quantity, unit_price, total_revenue, amount_outstanding, amount_paid,
      payment_plan, order_status, issued_channel, created_at) values ($1, $2, 'Welile Polo', 1, 35000, 35000, 35000, 0, 'installment', 'issued', null, now())`, [S3, AG]);
    const [r] = await rows<{ id: string }>(newDb, `select id from merchandise_stock_recognitions where sale_id = $1`, [S3]);
    await newDb.query(`update merchandise_sales set order_status = 'cancelled' where id = $1`, [S3]);
    const j = await as(newDb, CFO, () => rows<{ j: { status: string } }>(newDb, `select cfo_post_merchandise_stock_recognition($1, 'Signed delivery note DN-1104-001 received') j`, [r.id]));
    expect(j[0].j.status).toBe('no_action');
    expect((await saleAcct(newDb, S3)).A12 ?? 0).toBe(0);
  });
  it('orders with a CFO payout (smartphone, bike, out-sourced) are never queued here', async () => {
    const q = await rows(newDb, `select 1 from merchandise_stock_recognitions r join merchandise_sales s on s.id = r.sale_id where s.cfo_disbursed_at is not null`);
    expect(q.length).toBe(0);
  });
});

describe('5. monthly Returns pledge: eligible orders only', () => {
  const USER = FIX3.pledges.length ? (FIX3.pledges[0] as { user_id: string }).user_id : '';
  it('eligible order: collects exactly as before', async () => {
    const res: Array<Awaited<ReturnType<typeof effects>>> = []; const out: unknown[] = [];
    for (const db of [oldDb, newDb]) {
      await fund(db, USER, 30000);
      const since = await t0(db);
      out.push((await rows<{ j: unknown }>(db, `select apply_smartphone_roi_pledge($1, 25000, 'TEST-ROI-ELIG') j`, [USER]))[0].j);
      res.push(await effects(db, since, USER));
    }
    expect(out[1]).toEqual(out[0]);
    expect((out[0] as { applied: number }).applied).toBeGreaterThan(0);
    expect(res[1]).toEqual(res[0]);
  });
  it('ineligible order: old collects, new skips and records it; nothing raised, no ledger', async () => {
    const plan = (await rows<{ id: string; sale_id: string }>(newDb, `select p.id, p.sale_id from merchandise_recovery_plans p join merchandise_sales s on s.id = p.sale_id
      where p.customer_id = $1 and p.status = 'active' and s.item_name ilike '%smartphone%' order by p.created_at limit 1`, [USER]))[0];
    const out: Array<{ applied: number; reason?: string; detail?: string }> = []; const legs: number[] = [];
    for (const db of [oldDb, newDb]) {
      await db.query(`update merchandise_sales set order_status = 'pending_approval' where id = $1`, [plan.sale_id]);
      await fund(db, USER, 30000);
      const n0 = num((await rows<{ n: string }>(db, `select count(*) n from general_ledger`))[0].n);
      out.push((await rows<{ j: { applied: number } }>(db, `select apply_smartphone_roi_pledge($1, 25000, 'TEST-ROI-INELIG') j`, [USER]))[0].j);
      legs.push(num((await rows<{ n: string }>(db, `select count(*) n from general_ledger`))[0].n) - n0);
    }
    expect(out[0].applied).toBeGreaterThan(0);
    expect(legs[0]).toBeGreaterThan(0);
    expect(out[1]).toEqual({ applied: 0, reason: 'order_not_eligible', plan_id: plan.id, detail: 'order_pending_approval' });
    expect(legs[1]).toBe(0);
    const a = await rows(newDb, `select 1 from audit_logs where action_type = 'smartphone_pledge_skipped_ineligible' and record_id = $1`, [plan.id]);
    expect(a.length).toBe(1);
  });
});

describe('6. rejected motorcycle plans: payments retained (CFO policy, no refund)', () => {
  const PLANS: Record<string, string> = { [FIX3.rejected_bikes[0]]: '08f711e2-927a-43dd-bce0-73831c4dd16a', [FIX3.rejected_bikes[1]]: '9be1f0c5-c24a-4ea1-a4fc-c65fab57c2e0' };
  const AMT: Record<string, number> = { [FIX3.rejected_bikes[0]]: 109451, [FIX3.rejected_bikes[1]]: 103.48 };
  it('review rows: retained_payment (not possible_refund), recorded as no action with the policy and the income group', async () => {
    const q = await rows<{ sale_id: string; a13_net: string; cash: string; flags: string[]; status: string; counterpart: string; ledger_group_id: string; decision_note: string }>(newDb,
      `select sale_id, a13_net, cash_collected_net cash, flags, status, counterpart, ledger_group_id, decision_note from merchandise_receivable_derecognitions where sale_id = any($1::uuid[])`, [FIX3.rejected_bikes]);
    expect(q.length).toBe(2);
    for (const x of q) {
      expect([num(x.a13_net), num(x.cash), x.status, x.counterpart]).toEqual([0, AMT[x.sale_id], 'no_action', 'retained']);
      expect(x.flags).toContain('retained_payment');
      expect(x.flags).not.toContain('possible_refund');
      expect(x.decision_note).toMatch(/without a refund/);
      expect(x.ledger_group_id).toBeTruthy();
    }
  });
  it('DR E3 / CR R1 merchandise_payment_retained, 109,554.48, platform only; E3 for these plans nets to 0; no wallet leg', async () => {
    const g = await acct(newDb, `select transaction_group_id from general_ledger where idempotency_key like 'merch_phase3_20261104:%:RETAINED'`);
    expect(g).toEqual({ E3: 109554.48, R1: -109554.48 });
    for (const sale of FIX3.rejected_bikes) {
      const a = await acct(newDb, `select transaction_group_id from general_ledger where source_id = $1`, [PLANS[sale]]);
      expect([a.E3 ?? 0, a.A13 ?? 0, a.R1], sale).toEqual([0, 0, -AMT[sale]]);
    }
    expect((await rows(newDb, `select 1 from general_ledger where idempotency_key like 'merch_phase3_20261104:%:RETAINED' and ledger_scope <> 'platform'`)).length).toBe(0);
    // the original payments are untouched: the wallet debits are still there
    const w = await rows<{ n: string }>(newDb, `select sum(amount) n from general_ledger where ledger_scope = 'wallet' and category = 'agent_repayment' and source_id = any($1::uuid[])`, [Object.values(PLANS)]);
    expect(num(w[0].n)).toBe(109554.48);
  });
  it('a CFO decision on them posts nothing more', async () => {
    const [r] = await rows<{ id: string }>(newDb, `select id from merchandise_receivable_derecognitions where sale_id = $1`, [FIX3.rejected_bikes[1]]);
    const j = await as(newDb, CFO, () => rows<{ j: { already: boolean } }>(newDb, `select cfo_post_merchandise_derecognition($1, 'retained', 'reviewed: payments retained') j`, [r.id]));
    expect(j[0].j.already).toBe(true);
  });
  it('future: a rejected motorcycle plan with cash collected is flagged retained, and the credit balance is recognised as retained income once', async () => {
    const AG2 = '00000000-0000-0000-0000-0000000008a2';
    const SALE = '00000000-0000-0000-0000-0000000008c1';
    const PLAN = '00000000-0000-0000-0000-0000000008c2';
    await fund(newDb, AG2, 100000);
    await newDb.query(`insert into merchandise_sales (id, customer_id, item_name, quantity, unit_price, total_revenue, amount_outstanding, amount_paid,
      payment_plan, order_status, created_at) values ($1, $2, 'Welile Spiro Bike', 1, 600000, 600000, 600000, 0, 'installment', 'pending_approval', now())`, [SALE, AG2]);
    await newDb.query(`insert into merchandise_recovery_plans (id, sale_id, customer_id, item_name, original_amount, outstanding_balance, amount_recovered, daily_rate, status, is_bike_lease, created_at)
      values ($1, $2, $3, 'Welile Spiro Bike', 600000, 595000, 5000, 0.25, 'active', true, now())`, [PLAN, SALE, AG2]);
    await newDb.query(`select create_ledger_transaction(jsonb_build_array(
      jsonb_build_object('user_id', $1::uuid, 'ledger_scope', 'wallet', 'direction', 'cash_out', 'amount', 5000, 'category', 'agent_repayment', 'recipient_type', 'user',
        'wallet_bucket', 'withdrawable', 'source_table', 'merchandise_recovery_plans', 'source_id', $2::uuid, 'description', 'bike payment'),
      jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', 5000, 'category', 'bike_recovery_repayment',
        'source_table', 'merchandise_recovery_plans', 'source_id', $2::uuid, 'description', 'bike payment')), 'test-bike-pay-1')`, [AG2, PLAN]);
    const walletBefore = await rows(newDb, `select * from general_ledger where ledger_scope = 'wallet' and user_id = $1 order by id`, [AG2]);
    await newDb.query(`update merchandise_sales set order_status = 'rejected' where id = $1`, [SALE]);
    const [r] = await rows<{ id: string; flags: string[]; a13_net: string; cash: string }>(newDb,
      `select id, flags, a13_net, cash_collected_net cash from merchandise_receivable_derecognitions where sale_id = $1`, [SALE]);
    expect(r.flags).toEqual(expect.arrayContaining(['retained_payment', 'credit_balance']));
    expect(r.flags).not.toContain('possible_refund');
    expect([num(r.a13_net), num(r.cash)]).toEqual([-5000, 5000]);
    const j = await as(newDb, CFO, () => rows<{ j: { status: string } }>(newDb, `select cfo_post_merchandise_derecognition($1, 'retained', 'rejected motorcycle plan, payment kept') j`, [r.id]));
    expect(j[0].j.status).toBe('posted');
    expect(await saleAcct(newDb, SALE)).toEqual(expect.objectContaining({ A13: 0, R1: -5000 }));
    // no refund: the agent's wallet entries are exactly as before
    expect(await rows(newDb, `select * from general_ledger where ledger_scope = 'wallet' and user_id = $1 order by id`, [AG2])).toEqual(walletBefore);
  });
  it('"retained" is refused for anything but a motorcycle credit balance', async () => {
    const H = '00000000-0000-0000-0000-0000000008b1';
    const [r] = await rows<{ id: string }>(newDb, `select id from merchandise_receivable_derecognitions where sale_id = $1`, [H]);
    await expect(as(newDb, CFO, () => newDb.query(`select cfo_post_merchandise_derecognition($1, 'retained', 'not a motorcycle plan')`, [r.id])))
      .rejects.toThrow(/retained applies only/);
  });
});

describe('every group the migration and the controls posted', () => {
  it('balances raw and on mapped accounts, has no wallet leg and the resolver adds nothing', async () => {
    const bad = await rows(newDb, `
      select g.transaction_group_id from general_ledger g
      join ledger_account_map m on m.ledger_scope = g.ledger_scope and m.category = g.category and m.wallet_bucket is null
      where g.idempotency_key like 'merch_phase3_20261104:%' or g.idempotency_key like 'merch_stock_recog:%' or g.idempotency_key like 'merch_recv_derecog:%'
      group by 1
      having sum(case when g.direction = m.debit_when then g.amount else -g.amount end) <> 0
          or sum(case when g.direction = 'cash_in' then g.amount else -g.amount end) <> 0 or bool_or(g.ledger_scope = 'wallet')`);
    expect(bad.length).toBe(0);
    const one = await rows(newDb, `select 1 from sofp_ledger_legs(now() + interval '1 day') where group_one_sided and transaction_group_id in (
      select transaction_group_id from general_ledger where idempotency_key like 'merch_phase3_20261104:%' or idempotency_key like 'merch_stock_recog:%')`);
    expect(one.length).toBe(0);
    expect((await rows(newDb, `select * from ledger_mapped_balance_violations where transaction_group_id in (
      select transaction_group_id from general_ledger where idempotency_key like 'merch_phase3_20261104:%' or idempotency_key like 'merch_stock_recog:%')`)).length).toBe(0);
  });
  it('the Money received report does not count any of it (no money moved)', async () => {
    // only the migration's own groups (the later synthetic tests above added real activity on other days' rows)
    const day = (await rows<{ d: string }>(newDb, `select ((now() at time zone 'Africa/Kampala')::date)::text d`))[0].d;
    const legs = await rows<{ id: string }>(newDb, `select id from get_cfo_received_by_category_page($1::date, $1::date, null, null, null, 0, 5000)`, [day]);
    const ours = await rows(newDb, `select 1 from general_ledger where id = any($1::uuid[]) and (idempotency_key like 'merch_phase3_20261104:%' or idempotency_key like 'merch_stock_recog:%' or idempotency_key like 'merch_recv_derecog:%')`,
      [legs.map((l) => l.id)]);
    expect(ours.length).toBe(0);
    expect(receivedBefore.n).toBeGreaterThanOrEqual(0);
  });
  it('the migration itself moved only X1 / L1 (phones) and E3 / R1 (retained payments); the stock queue posts nothing', async () => {
    const db = await build();
    const before = await acct(db);
    const n0 = num((await rows<{ n: string }>(db, `select count(*) n from general_ledger`))[0].n);
    await db.exec(PHASE3);
    const after = await acct(db);
    const diff = Object.fromEntries(Object.keys({ ...before, ...after }).map((k) => [k, Math.round(((after[k] ?? 0) - (before[k] ?? 0)) * 100) / 100]).filter(([, v]) => v !== 0));
    expect(diff).toEqual({ L1: 5_245_000, X1: -5_245_000, E3: 109_554.48, R1: -109_554.48 });
    expect(num((await rows<{ n: string }>(db, `select count(*) n from general_ledger`))[0].n) - n0).toBe(20);
    expect(totalsBefore.A12).toBe(before.A12);
    expect(legsBefore).toBeGreaterThan(0);
    await db.close();
  }, 400_000);
});

describe('rollback', () => {
  it('restores the production functions; entries and review rows stay', async () => {
    const db = await build();
    await db.exec(PHASE3);
    const n = num((await rows<{ n: string }>(db, `select count(*) n from general_ledger where idempotency_key like 'merch_phase3_20261104:%'`))[0].n);
    await db.exec(ROLLBACK);
    expect(await fnMd5(db, 'public.cfo_disburse_smartphone_order(uuid, numeric, text)')).toBe(FIX3.md5.phone_old);
    expect(await fnMd5(db, 'public.apply_smartphone_roi_pledge(uuid, numeric, text)')).toBe(FIX3.md5.pledge_old);
    expect(await fnMd5(db, 'public.ledger_category_allowlist()')).toBe(FIX3.md5.allow_old);
    expect(await fnMd5(db, 'public._merch_stock_queue(uuid, text)')).toBeNull();
    expect(num((await rows<{ n: string }>(db, `select count(*) n from general_ledger where idempotency_key like 'merch_phase3_20261104:%'`))[0].n)).toBe(n);
    expect((await rows(db, `select 1 from merchandise_stock_recognitions`)).length).toBe(7);
    // the memo-offset mapping stays while legs use it; the unused revenue mapping goes
    expect((await rows<{ c: string }>(db, `select category c from ledger_account_map where category in ('merchandise_revenue', 'merchandise_advance_memo_offset', 'merchandise_payment_retained') order by 1`)).map((r) => r.c))
      .toEqual(['merchandise_advance_memo_offset', 'merchandise_payment_retained']);
    expect(await fnMd5(db, 'public._merch_receivable_event(uuid, uuid, text)')).toBe('bbea4b509dbf340a522ac66ad1ddb8c7');
    expect(await fnMd5(db, 'public._merch_post_derecognition(uuid, text, text, uuid)')).toBe('0cfb35ac332e0b1cc3241efcbb2f3cdb');
    await db.close();
  }, 400_000);
});

// ================================================================ phase 3b (20261104160000): additional controls
describe('phase 3b: order and preflight', () => {
  it('refuses before phase 3, and on penalty evidence drift, changing nothing', async () => {
    const db = await build();
    await expect(db.exec(PHASE3B)).rejects.toThrow(/apply 20261104150000 first/);
    await db.exec(PHASE3);
    const adv = String(FIX3B.advances[1].id);
    await db.query(`select create_ledger_transaction(jsonb_build_array(
      jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', 10, 'category', 'interest_expense', 'source_table', 'agent_advances', 'source_id', $1::uuid),
      jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', 10, 'category', 'receivable_restatement_equity', 'source_table', 'agent_advances', 'source_id', $1::uuid)), 'drift-1')`, [adv]);
    await expect(db.exec(PHASE3B)).rejects.toThrow(/penalty evidence moved/);
    expect(await fnMd5(db, 'public.record_advance_deduction_atomic(uuid, uuid, date, numeric, numeric, numeric, numeric, text, text, numeric, text, numeric, text, jsonb, text, jsonb)')).toBe(FIX3B.md5.rad_old);
    expect(to(await rows(db, `select to_regclass('public.merchandise_unrecorded_sales') t`))).toBeNull();
    await db.close();
  }, 400_000);
});

describe('phase 3b on the database with phase 3', () => {
  const RAD = 'public.record_advance_deduction_atomic(uuid, uuid, date, numeric, numeric, numeric, numeric, text, text, numeric, text, numeric, text, jsonb, text, jsonb)';
  const ADVS = FIX3B.advances.map((a) => String(a.id));
  const L = FIX3B.legs as Array<{ source_id: string; ledger_scope: string; wallet_bucket: string; direction: string; amount: number }>;
  const netOf = (id: string) => L.filter((l) => l.source_id === id && l.ledger_scope === 'wallet' && l.wallet_bucket === 'advance_credit')
    .reduce((a, l) => a + (l.direction === 'cash_in' ? num(l.amount) : -num(l.amount)), 0);
  // d03cff9d's two penalties (1,232) were reversed by an admin correction: net 0, nothing to correct
  const WITH_NET = ADVS.filter((id) => netOf(id) > 0);
  let n0 = 0; let walletBefore3b = '';
  beforeAll(async () => {
    await oldDb.exec(PHASE3); // old = production + phase 3 (the base 3b applies to)
    n0 = num((await rows<{ n: string }>(newDb, `select count(*) n from general_ledger`))[0].n);
    walletBefore3b = JSON.stringify(await rows(newDb, `select * from general_ledger where ledger_scope = 'wallet' order by id`));
    await newDb.exec(PHASE3B);
  }, 400_000);

  it('installs the new definitions; a second apply is refused', async () => {
    expect(await fnMd5(newDb, RAD)).toBe(FIX3B.md5.rad_new);
    expect(await fnMd5(newDb, 'public.get_partner_ops_returns_arrears(uuid[])')).toBe(FIX3B.md5.arr_new);
    expect(await fnMd5(newDb, 'public.ledger_category_allowlist()')).toBe(FIX3B.md5.allow_3b);
    expect(await fnMd5(newDb, 'public.recompute_wallet_buckets(uuid)')).toBe(FIX3B.md5.rec);
    await expect(newDb.exec(PHASE3B)).rejects.toThrow(/already applied|preflight refused/);
  });

  it('penalties: one balanced platform-only group per advance, DR L1 / CR X1 for its net; raw L1 and X1 per advance 0', async () => {
    const g = await rows<{ sid: string; n: string; amt: string; sc: string[] }>(newDb, `select min(source_id::text) sid, count(*) n,
      sum(amount) filter (where direction = 'cash_in') amt, array_agg(distinct ledger_scope) sc
      from general_ledger where idempotency_key like 'agent_penalty_memo_offset_20261104:%' group by transaction_group_id`);
    expect(g.length).toBe(WITH_NET.length);
    expect(WITH_NET.length).toBe(ADVS.length - 1);
    for (const x of g) {
      expect([num(x.n), x.sc]).toEqual([2, ['platform']]);
      expect(num(x.amt), x.sid).toBe(netOf(x.sid));
    }
    const raw = await rows<{ sid: string; l1: string; x1: string }>(newDb, `select source_id::text sid,
      sum(case when ledger_scope = 'wallet' and wallet_bucket = 'advance_credit' then case when direction = 'cash_in' then amount else -amount end
               when category = 'agent_advance_memo_offset' then case when direction = 'cash_out' then -amount else amount end else 0 end) l1,
      sum(case when category = 'interest_expense' then case when direction = 'cash_out' then amount else -amount end else 0 end) x1
      from general_ledger where source_table = 'agent_advances' and source_id = any($1::uuid[]) group by 1`, [ADVS]);
    for (const r of raw) expect([num(r.l1), num(r.x1)], r.sid).toEqual([0, 0]);
  });

  it('balance sheet: L1 and X1 of these advances go to 0, except the 1,232 an admin_correction reversal kept off the statement (d03cff9d)', async () => {
    const a = await acct(newDb, `select transaction_group_id from general_ledger where source_table = 'agent_advances' and source_id = any($1::uuid[])`, [ADVS]);
    expect([a.L1 ?? 0, a.X1 ?? 0, a.A10 ?? 0]).toEqual([-1232, 1232, 0]);
    expect((await rows(newDb, `select * from ledger_mapped_balance_violations where transaction_group_id in (
      select transaction_group_id from general_ledger where idempotency_key like 'agent_penalty_memo_offset_20261104:%')`)).length).toBe(0);
  });

  it('nothing existing edited, no wallet leg written; A10 untouched', async () => {
    expect(JSON.stringify(await rows(newDb, `select * from general_ledger where ledger_scope = 'wallet' order by id`))).toBe(walletBefore3b);
    expect((await acct(newDb, `select transaction_group_id from general_ledger where idempotency_key like 'agent_penalty_memo_offset_20261104:%'`)).A10 ?? 0).toBe(0);
    const added = num((await rows<{ n: string }>(newDb, `select count(*) n from general_ledger`))[0].n) - n0;
    expect(added).toBe(2 * WITH_NET.length);
  });

  it('daily penalty (legacy advance): same wallet leg, advance and statement row as before; company side memo in L1, no X1', async () => {
    const adv = FIX3B.advances[0];
    const res: Array<{ wallet: unknown[]; adv: unknown[]; led: unknown[]; plat: Array<{ category: string; direction: string; amount: string }> }> = [];
    for (const db of [oldDb, newDb]) {
      await db.query(`update agent_advances set status = 'overdue', deduction_paused = false, recovery_source = 'wallet_daily' where id = $1`, [adv.id]);
      const ob = num((await rows<{ o: string }>(db, `select coalesce(outstanding_balance, 0) o from agent_advances where id = $1`, [adv.id]))[0].o);
      const since = await t0(db);
      await db.query(`select ${RAD.replace(/\(.*$/, '')}($1, $2, '2026-11-05'::date, $3, 500, 0, $4, 'missed', 'overdue', 0, 'unpaid', 0,
        'Overdue advance penalty interest (1%/day on UGX 50,000)', '{}'::jsonb, null, '{}'::jsonb)`, [adv.id, adv.agent_id, ob, ob + 500]);
      res.push({
        wallet: await rows(db, `select user_id, direction, category, amount, wallet_bucket, recipient_type, description, idempotency_key from general_ledger
          where ledger_scope = 'wallet' and created_at >= $1 order by id`, [since]),
        adv: await rows(db, `select outstanding_balance, status, arrears_balance, access_fee_collected, access_fee_status from agent_advances where id = $1`, [adv.id]),
        led: await rows(db, `select date, opening_balance, interest_accrued, amount_deducted, closing_balance, deduction_status from agent_advance_ledger where advance_id = $1`, [adv.id]),
        plat: await rows(db, `select category, direction, amount from general_ledger where ledger_scope = 'platform' and created_at >= $1 order by category`, [since]),
      });
    }
    expect(res[1].wallet).toEqual(res[0].wallet);
    expect(res[1].adv).toEqual(res[0].adv);
    expect(res[1].led).toEqual(res[0].led);
    expect(res[0].plat.map((x) => [x.category, x.direction, num(x.amount)])).toEqual([['interest_expense', 'cash_out', 500]]);
    expect(res[1].plat.map((x) => [x.category, x.direction, num(x.amount)])).toEqual([['agent_advance_memo_offset', 'cash_out', 500]]);
    const g = await acct(newDb, `select transaction_group_id from general_ledger where idempotency_key = $1`, [`advance_penalty_interest:${adv.id}:2026-11-05`]);
    expect(g).toEqual({ L1: 0 });
  });

  it('paid sales with no money record: the 2 historical sales queued; a new one queued at commit; a wallet-paid sale is not', async () => {
    const q = await rows<{ sale_id: string; amount_paid: string; flags: string[]; status: string }>(newDb,
      `select sale_id, amount_paid, flags, status from merchandise_unrecorded_sales order by sale_id`);
    expect(q.map((x) => [x.sale_id.slice(0, 8), num(x.amount_paid), x.status])).toEqual([['9381fee7', 35000, 'pending'], ['e9b076af', 60000, 'pending']]);
    for (const x of q) expect(x.flags).toEqual(['cash_not_in_ledger', 'off_platform_client', 'historical']);
    const S1 = '00000000-0000-0000-0000-0000000009a1'; const S2 = '00000000-0000-0000-0000-0000000009a2';
    await newDb.query(`insert into merchandise_sales (id, item_name, quantity, unit_price, total_revenue, amount_paid, amount_outstanding, payment_status, order_status, sale_date)
      values ($1, 'Welile Polo', 1, 35000, 35000, 35000, 0, 'paid', 'completed', current_date)`, [S1]);
    await newDb.exec(`begin;
      insert into merchandise_sales (id, item_name, quantity, unit_price, total_revenue, amount_paid, amount_outstanding, payment_status, order_status, sale_date)
        values ('${S2}', 'Welile Polo', 1, 35000, 35000, 35000, 0, 'paid', 'completed', current_date);
      select create_ledger_transaction(jsonb_build_array(
        jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', 35000, 'category', 'merchandise_revenue', 'source_table', 'merchandise_sales', 'source_id', '${S2}'),
        jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', 35000, 'category', 'merchandise_revenue', 'source_table', 'merchandise_sales', 'source_id', '${S2}')), 'wallet-paid-sale-test');
      commit;`);
    const q2 = await rows<{ sale_id: string }>(newDb, `select sale_id from merchandise_unrecorded_sales where sale_id in ($1, $2)`, [S1, S2]);
    expect(q2.map((x) => x.sale_id)).toEqual([S1]);
  });

  it('recompute_wallet_buckets: service role only, never app users', async () => {
    const p = await rows<{ a: boolean; u: boolean; s: boolean }>(newDb, `select has_function_privilege('anon', 'public.recompute_wallet_buckets(uuid)', 'EXECUTE') a,
      has_function_privilege('authenticated', 'public.recompute_wallet_buckets(uuid)', 'EXECUTE') u, has_function_privilege('service_role', 'public.recompute_wallet_buckets(uuid)', 'EXECUTE') s`);
    expect(p[0]).toEqual({ a: false, u: false, s: true });
  });

  it('Partner Ops pledge preview: same as before on an eligible order, excludes an ineligible one (as the collection does)', async () => {
    const USER = (FIX3.pledges[0] as { user_id: string }).user_id;
    const PF = '00000000-0000-0000-0000-0000000009b1';
    const out: unknown[][] = [];
    // an earlier test let the old pledge collect on an ineligible order in oldDb only: start both from the same plan state
    for (const p of await rows<{ id: string; o: string; d: string | null }>(newDb, `select id, outstanding_balance o, due_balance d from merchandise_recovery_plans where customer_id = $1`, [USER])) {
      await oldDb.query(`update merchandise_recovery_plans set outstanding_balance = $2, due_balance = $3 where id = $1`, [p.id, p.o, p.d]);
    }
    for (const db of [oldDb, newDb]) {
      await db.query(`insert into investor_portfolios (id, investor_id, investment_amount, roi_percentage, created_at) values ($1, $2, 1000000, 15, now()) on conflict do nothing`, [PF, USER]);
      // production's order statuses for this partner (an earlier test set one to pending_approval)
      for (const sale of FIX.sales.filter((x) => x.customer_id === USER)) {
        await db.query(`update merchandise_sales set order_status = $2 where id = $1`, [sale.id, sale.order_status]);
      }
      out.push(await rows(db, `select * from get_partner_ops_returns_arrears(array[$1::uuid])`, [PF]));
    }
    expect(out[1]).toEqual(out[0]);
    expect(out[0].length).toBe(1);
    for (const db of [oldDb, newDb]) {
      await db.query(`update merchandise_sales set order_status = 'pending_approval' where id in (select sale_id from merchandise_recovery_plans where customer_id = $1)`, [USER]);
    }
    expect((await rows(oldDb, `select * from get_partner_ops_returns_arrears(array[$1::uuid])`, [PF])).length).toBe(1);
    expect((await rows(newDb, `select * from get_partner_ops_returns_arrears(array[$1::uuid])`, [PF])).length).toBe(0);
  });

  it('the Money received report does not count the corrections', async () => {
    const day = (await rows<{ d: string }>(newDb, `select ((now() at time zone 'Africa/Kampala')::date)::text d`))[0].d;
    const legs = await rows<{ id: string }>(newDb, `select id from get_cfo_received_by_category_page($1::date, $1::date, null, null, null, 0, 5000)`, [day]);
    const ours = await rows(newDb, `select 1 from general_ledger where id = any($1::uuid[]) and idempotency_key like 'agent_penalty_memo_offset_20261104:%'`, [legs.map((l) => l.id)]);
    expect(ours.length).toBe(0);
  });
});

describe('phase 3b rollback', () => {
  it('restores the production functions; corrections, review rows and the used mapping stay', async () => {
    const db = await build();
    await db.exec(PHASE3); await db.exec(PHASE3B);
    const n = (await rows(db, `select 1 from general_ledger where idempotency_key like 'agent_penalty_memo_offset_20261104:%'`)).length;
    await db.exec(ROLLBACK3B);
    expect(await fnMd5(db, 'public.record_advance_deduction_atomic(uuid, uuid, date, numeric, numeric, numeric, numeric, text, text, numeric, text, numeric, text, jsonb, text, jsonb)')).toBe(FIX3B.md5.rad_old);
    expect(await fnMd5(db, 'public.get_partner_ops_returns_arrears(uuid[])')).toBe(FIX3B.md5.arr_old);
    expect(await fnMd5(db, 'public.ledger_category_allowlist()')).toBe(FIX3.md5.allow_new);
    expect(await fnMd5(db, 'public._merch_unrecorded_sale_check(uuid, text)')).toBeNull();
    expect((await rows(db, `select 1 from general_ledger where idempotency_key like 'agent_penalty_memo_offset_20261104:%'`)).length).toBe(n);
    expect((await rows(db, `select 1 from merchandise_unrecorded_sales`)).length).toBe(2);
    expect((await rows(db, `select 1 from ledger_account_map where category = 'agent_advance_memo_offset'`)).length).toBe(1);
    await db.close();
  }, 400_000);
});
