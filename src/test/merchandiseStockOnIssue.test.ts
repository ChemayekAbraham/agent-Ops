// @vitest-environment node
/**
 * Company stock recognised when the order is marked issued (supabase/migrations/20261104170000_merchandise_stock_recognise_on_issue.sql),
 * CFO policy 2026-11-04: "once merchandise is marked as issued, it automatically qualifies for recognition in receivables.
 * No separate proof of receipt, signed delivery note or handover confirmation is required."
 *
 * Runs on PGlite with production's code verbatim over the merchandise replica (fixtures as merchandisePhase3.test.ts), with
 * production's merchandise migrations applied in order (20261104090000, 20261104100000, 20261104150000).
 *
 * Proves: order and preflight; the 7 items Phase 3 queued are recognised (DR A12 / CR R1 merchandise_revenue, 1,015,000),
 * once, platform only, nothing existing edited, not counted as money received; every future issue path recognises in its
 * own transaction with no proof, exactly once; orders not marked issued are not recognised; cancellations go to the
 * derecognition queue; the CFO action needs no document; grants; rollback.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

// ---------------------------------------------------------------- databases: production now (phase 3 applied) and + this migration
const P3_MD5 = {
  post: '02ef461b3be40455767aedf0582c9351', cfo: 'bd7bb30d5d5278a08c75c6633fdce853',
  handover: 'eb39ed08009547bc584c086c92bf2091', trg: '6cc969e183f4d4733ba7e51c28eb3308',
};
const RECOG_BLOCK = ONISSUE.slice(ONISSUE.indexOf('DO $recog$'), ONISSUE.indexOf('END $recog$;') + 'END $recog$;'.length);
let oldDb: PGlite;
let newDb: PGlite;
let totalsBefore: Record<string, number>;
let legsBefore: string;
let nBefore: number;
beforeAll(async () => {
  oldDb = await build(); newDb = await build();
  await oldDb.exec(PHASE3); await newDb.exec(PHASE3);
  totalsBefore = await acct(newDb);
  legsBefore = JSON.stringify(await rows(newDb, `select * from general_ledger order by id`));
  nBefore = num((await rows<{ n: string }>(newDb, `select count(*) n from general_ledger`))[0].n);
  await newDb.exec(ONISSUE);
}, 400_000);
afterAll(async () => { await oldDb?.close(); await newDb?.close(); });

describe('order and preflight', () => {
  it('starts from production\'s phase 3 definitions', async () => {
    expect(await fnMd5(oldDb, 'public._merch_post_stock_recognition(uuid, text, text, uuid)')).toBe(P3_MD5.post);
    expect(await fnMd5(oldDb, 'public.cfo_post_merchandise_stock_recognition(uuid, text)')).toBe(P3_MD5.cfo);
    expect(await fnMd5(oldDb, 'public._merch_stock_on_handover(uuid)')).toBe(P3_MD5.handover);
    expect(await fnMd5(oldDb, 'public.trg_merch_stock_issue_event()')).toBe(P3_MD5.trg);
  });
  it('refuses before phase 3, changing nothing', async () => {
    const db = await build();
    const n0 = (await rows<{ n: string }>(db, `select count(*) n from general_ledger`))[0].n;
    await expect(db.exec(ONISSUE)).rejects.toThrow(/apply 20261104150000 first/);
    expect((await rows<{ n: string }>(db, `select count(*) n from general_ledger`))[0].n).toBe(n0);
    await db.close();
  }, 400_000);
  it('refuses when the queue has moved (an item already decided), changing nothing', async () => {
    const db = await build();
    await db.exec(PHASE3);
    await db.query(`update merchandise_stock_recognitions set amount = amount + 1 where sale_id = $1`, [FIX3.stock[0][0]]);
    await expect(db.exec(ONISSUE)).rejects.toThrow(/queue moved/);
    expect((await rows(db, `select 1 from general_ledger where idempotency_key like 'merch_stock_recog:%'`)).length).toBe(0);
    await db.close();
  }, 400_000);
  it('a second apply is refused', async () => {
    await expect(newDb.exec(ONISSUE)).rejects.toThrow(/already applied/);
  });
});

describe('the 7 items queued by phase 3: recognised now (marked issued is enough)', () => {
  it('7 balanced platform-only groups, DR A12 / CR R1 merchandise_revenue, 1,015,000', async () => {
    const g = await rows<{ gid: string; n: string; amt: string; sale: string }>(newDb, `select transaction_group_id gid, count(*) n,
      sum(amount) filter (where direction = 'cash_in') amt, min(source_id::text) sale from general_ledger
      where idempotency_key like 'merch_stock_recog:%' group by 1 order by 4`);
    expect(g.length).toBe(7);
    expect(g.reduce((a, x) => a + num(x.amt), 0)).toBe(1_015_000);
    for (const x of g) expect(num(x.amt), x.sale).toBe(FIX3.stock.find(([s]) => s === x.sale)![1]);
    expect(await acct(newDb, `select transaction_group_id from general_ledger where idempotency_key like 'merch_stock_recog:%'`))
      .toEqual({ A12: 1_015_000, R1: -1_015_000 });
    expect((await rows(newDb, `select 1 from general_ledger where idempotency_key like 'merch_stock_recog:%' and ledger_scope <> 'platform'`)).length).toBe(0);
  });
  it('per order: A12 = price less principal already collected (jackets with 10,000 paid: 103,590)', async () => {
    for (const [sale, amt] of FIX3.stock) {
      const a = await saleAcct(newDb, sale);
      expect(a.A12, sale).toBe(sale === FIX3.stock[5][0] ? 103_590 : amt);
    }
  });
  it('queue rows: posted, revenue, recognised because the order was marked issued', async () => {
    const q = await rows<{ status: string; counterpart: string; evidence_kind: string; delivery_evidence: string }>(newDb,
      `select status, counterpart, evidence_kind, delivery_evidence from merchandise_stock_recognitions`);
    expect(q.length).toBe(7);
    for (const x of q) {
      expect([x.status, x.counterpart, x.evidence_kind]).toEqual(['posted', 'revenue', 'order_issued']);
      expect(x.delivery_evidence).toMatch(/order marked issued/);
    }
  });
  it('the migration moved only A12 and R1, appended 14 legs, edited nothing, wrote no wallet leg', async () => {
    const after = await acct(newDb);
    const diff = Object.fromEntries(Object.keys({ ...totalsBefore, ...after })
      .map((k) => [k, Math.round(((after[k] ?? 0) - (totalsBefore[k] ?? 0)) * 100) / 100]).filter(([, v]) => v !== 0));
    expect(diff).toEqual({ A12: 1_015_000, R1: -1_015_000 });
    expect(num((await rows<{ n: string }>(newDb, `select count(*) n from general_ledger`))[0].n) - nBefore).toBe(14);
    const old = JSON.parse(legsBefore) as Array<{ id: string }>;
    const now = await rows<{ id: string }>(newDb, `select * from general_ledger where id = any($1::uuid[]) order by id`, [old.map((l) => l.id)]);
    expect(JSON.stringify(now)).toBe(legsBefore);
  });
  it('is idempotent: running the block again posts nothing', async () => {
    const n0 = (await rows<{ n: string }>(newDb, `select count(*) n from general_ledger`))[0].n;
    await newDb.exec(RECOG_BLOCK);
    expect((await rows<{ n: string }>(newDb, `select count(*) n from general_ledger`))[0].n).toBe(n0);
  });
  it('the Money received report does not count it (no money moved)', async () => {
    const day = (await rows<{ d: string }>(newDb, `select ((now() at time zone 'Africa/Kampala')::date)::text d`))[0].d;
    const legs = await rows<{ id: string }>(newDb, `select id from get_cfo_received_by_category_page($1::date, $1::date, null, null, null, 0, 5000)`, [day]);
    const ours = await rows(newDb, `select 1 from general_ledger where id = any($1::uuid[]) and idempotency_key like 'merch_stock_recog:%'`, [legs.map((l) => l.id)]);
    expect(ours.length).toBe(0);
  });
});

describe('future company-stock issues: recognised when marked issued, once, on every path', () => {
  const AG = '00000000-0000-0000-0000-0000000009a1';
  const H = '00000000-0000-0000-0000-0000000009b1';
  const D = '00000000-0000-0000-0000-0000000009b2';
  let agentOpsSale = '';
  it('handover path: same order, plan and wallet rows as before; recognised as issued', async () => {
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
    const q = await rows<{ status: string; evidence_kind: string }>(newDb, `select status, evidence_kind from merchandise_stock_recognitions where sale_id = $1`, [H]);
    expect(q).toEqual([{ status: 'posted', evidence_kind: 'order_issued' }]);
    expect(await saleAcct(newDb, H)).toEqual({ A12: 110000, R1: -110000 });
  });
  it('marked issued with no handover record: recognised at once (no proof needed)', async () => {
    for (const db of [oldDb, newDb]) {
      await db.query(`insert into merchandise_sales (id, customer_id, item_name, quantity, unit_price, total_revenue, amount_outstanding, amount_paid,
        payment_plan, order_status, created_at) values ($1, $2, 'Welile Polo', 1, 35000, 35000, 35000, 0, 'installment', 'issued', now())`, [D, AG]);
    }
    // before: queued and left pending for evidence; now: recognised
    expect((await saleAcct(oldDb, D)).A12 ?? 0).toBe(0);
    expect(await saleAcct(newDb, D)).toEqual({ A12: 35000, R1: -35000 });
    expect((await rows<{ e: string }>(newDb, `select evidence_kind e from merchandise_stock_recognitions where sale_id = $1`, [D]))[0].e).toBe('order_issued');
  });
  it('Agent Ops issue: recognised in the issue transaction (the receivable less the 20,000 paid at issue)', async () => {
    const [{ s: sale }] = await as(newDb, OPS, () => rows<{ s: string }>(newDb,
      `select agent_ops_issue_agent_product($1, 'Welile Polo', 2, 35000, 25000, null, 'installment', 20000, 'issued at centre') s`, [AG]));
    agentOpsSale = sale;
    expect(await saleAcct(newDb, sale)).toEqual({ A12: 50000, R1: -50000 });
  });
  it('later changes (issued -> completed, a handover recorded later, an edited note) recognise nothing again', async () => {
    await newDb.query(`update merchandise_sales set order_status = 'completed' where id = $1`, [H]);
    await newDb.query(`update merchandise_sales set handed_over_at = now(), handed_over_by = $2, handover_note = 'collected' where id = $1`, [agentOpsSale, OPS]);
    await newDb.query(`update merchandise_sales set handover_note = 'edited' where id = $1`, [agentOpsSale]);
    for (const s of [H, D, agentOpsSale]) {
      expect((await rows(newDb, `select 1 from merchandise_stock_recognitions where sale_id = $1`, [s])).length, s).toBe(1);
      expect((await rows(newDb, `select 1 from general_ledger where idempotency_key like 'merch_stock_recog:%' and source_id = $1`, [s])).length, s).toBe(2);
    }
  });
  it('an order not yet marked issued is not recognised', async () => {
    const P = '00000000-0000-0000-0000-0000000009b4';
    for (const st of ['pending_approval', 'coo_approved', 'ops_approved', 'awaiting_handover']) {
      await newDb.query(`delete from merchandise_sales where id = $1`, [P]);
      await newDb.query(`insert into merchandise_sales (id, customer_id, item_name, quantity, unit_price, total_revenue, amount_outstanding, amount_paid,
        payment_plan, order_status, created_at) values ($1, $2, 'Welile Polo', 1, 35000, 35000, 35000, 0, 'installment', $3, now())`, [P, AG, st]);
      expect((await rows(newDb, `select 1 from merchandise_stock_recognitions where sale_id = $1`, [P])).length, st).toBe(0);
      expect((await saleAcct(newDb, P)).A12 ?? 0, st).toBe(0);
    }
  });
  it('a cancellation after recognition is caught by the derecognition queue', async () => {
    await newDb.query(`update merchandise_sales set order_status = 'cancelled' where id = $1`, [D]);
    const d = await rows<{ a12_net: string; status: string }>(newDb, `select a12_net, status from merchandise_receivable_derecognitions where sale_id = $1`, [D]);
    expect(d.map((x) => [num(x.a12_net), x.status])).toEqual([[35000, 'pending']]);
  });
  it('orders with a CFO payout (smartphone, bike, out-sourced) are never queued here', async () => {
    const q = await rows(newDb, `select 1 from merchandise_stock_recognitions r join merchandise_sales s on s.id = r.sale_id where s.cfo_disbursed_at is not null`);
    expect(q.length).toBe(0);
  });
});

describe('the CFO action (automatic recognition switched off)', () => {
  const AG = '00000000-0000-0000-0000-0000000009a1';
  const S = '00000000-0000-0000-0000-0000000009c1';
  let id = '';
  beforeAll(async () => {
    await newDb.query(`update merchandise_accounting_controls set stock_issue_counterpart = null`);
    await newDb.query(`insert into merchandise_sales (id, customer_id, item_name, quantity, unit_price, total_revenue, amount_outstanding, amount_paid,
      payment_plan, order_status, created_at) values ($1, $2, 'Press Jacket', 1, 55000, 55000, 55000, 0, 'installment', 'issued', now())`, [S, AG]);
    id = (await rows<{ id: string }>(newDb, `select id from merchandise_stock_recognitions where sale_id = $1`, [S]))[0].id;
  });
  afterAll(async () => { await newDb.query(`update merchandise_accounting_controls set stock_issue_counterpart = 'revenue'`); });
  it('with the switch off the issue waits for the CFO', async () => {
    expect((await rows<{ s: string }>(newDb, `select status s from merchandise_stock_recognitions where id = $1`, [id]))[0].s).toBe('pending');
    expect((await saleAcct(newDb, S)).A12 ?? 0).toBe(0);
  });
  it('only the CFO; an order not marked issued is refused', async () => {
    await expect(as(newDb, OPS, () => newDb.query(`select cfo_post_merchandise_stock_recognition($1, null)`, [id]))).rejects.toThrow(/Only the CFO/);
    await newDb.query(`update merchandise_sales set order_status = 'coo_approved' where id = $1`, [S]);
    await expect(as(newDb, CFO, () => newDb.query(`select cfo_post_merchandise_stock_recognition($1, null)`, [id]))).rejects.toThrow(/not marked issued/);
    await newDb.query(`update merchandise_sales set order_status = 'issued' where id = $1`, [S]);
  });
  it('an issued order is recognised with no document, once', async () => {
    const r1 = await as(newDb, CFO, () => rows<{ j: { status: string; amount: number } }>(newDb, `select cfo_post_merchandise_stock_recognition($1, null) j`, [id]));
    expect([r1[0].j.status, num(r1[0].j.amount)]).toEqual(['posted', 55000]);
    const r2 = await as(newDb, CFO, () => rows<{ j: { already: boolean } }>(newDb, `select cfo_post_merchandise_stock_recognition($1, null) j`, [id]));
    expect(r2[0].j.already).toBe(true);
    expect(await saleAcct(newDb, S)).toEqual({ A12: 55000, R1: -55000 });
  });
  it('a cancelled order closes as no action', async () => {
    const C = '00000000-0000-0000-0000-0000000009c2';
    await newDb.query(`insert into merchandise_sales (id, customer_id, item_name, quantity, unit_price, total_revenue, amount_outstanding, amount_paid,
      payment_plan, order_status, created_at) values ($1, $2, 'Welile Polo', 1, 35000, 35000, 35000, 0, 'installment', 'issued', now())`, [C, AG]);
    const [r] = await rows<{ id: string }>(newDb, `select id from merchandise_stock_recognitions where sale_id = $1`, [C]);
    await newDb.query(`update merchandise_sales set order_status = 'cancelled' where id = $1`, [C]);
    const j = await as(newDb, CFO, () => rows<{ j: { status: string } }>(newDb, `select cfo_post_merchandise_stock_recognition($1, null) j`, [r.id]));
    expect(j[0].j.status).toBe('no_action');
    expect((await saleAcct(newDb, C)).A12 ?? 0).toBe(0);
  });
  it('grants: app users reach only the CFO action', async () => {
    const g = await rows<{ a: boolean; b: boolean; c: boolean; d: boolean }>(newDb, `select
      has_function_privilege('authenticated', 'public._merch_stock_on_issue(uuid)', 'EXECUTE') a,
      has_function_privilege('authenticated', 'public._merch_post_stock_recognition(uuid, text, text, uuid)', 'EXECUTE') b,
      has_function_privilege('authenticated', 'public.cfo_post_merchandise_stock_recognition(uuid, text)', 'EXECUTE') c,
      has_function_privilege('anon', 'public.cfo_post_merchandise_stock_recognition(uuid, text)', 'EXECUTE') d`);
    expect(g[0]).toEqual({ a: false, b: false, c: true, d: false });
  });
});

describe('rollback', () => {
  it('restores the phase 3 functions; entries and queue rows stay', async () => {
    const db = await build();
    await db.exec(PHASE3); await db.exec(ONISSUE);
    const n0 = (await rows<{ n: string }>(db, `select count(*) n from general_ledger`))[0].n;
    await db.exec(ROLLBACK);
    expect(await fnMd5(db, 'public._merch_post_stock_recognition(uuid, text, text, uuid)')).toBe(P3_MD5.post);
    expect(await fnMd5(db, 'public.cfo_post_merchandise_stock_recognition(uuid, text)')).toBe(P3_MD5.cfo);
    expect(await fnMd5(db, 'public._merch_stock_on_handover(uuid)')).toBe(P3_MD5.handover);
    expect(await fnMd5(db, 'public.trg_merch_stock_issue_event()')).toBe(P3_MD5.trg);
    expect(await fnMd5(db, 'public._merch_stock_on_issue(uuid)')).toBeNull();
    expect((await rows<{ n: string }>(db, `select count(*) n from general_ledger`))[0].n).toBe(n0);
    expect((await rows(db, `select 1 from merchandise_stock_recognitions where status = 'posted'`)).length).toBe(7);
    await db.close();
  }, 400_000);
});
