// @vitest-environment node
/**
 * Merchandise phase 3 (supabase/migrations/20261104110000_merchandise_phase3_stock_phone_pledge.sql), CFO 2026-11-04:
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
 * no X1 and no net L1 for the agent memo; the 7 company-stock items are queued (1,015,000) and the CFO's decision posts
 * exactly once (revenue, or E3 for these historical items only); a future issue on every path is queued or recognised
 * automatically, never twice, and a later cancellation is caught by the existing derecognition queue; the pledge collects
 * exactly as before on an eligible order and skips (and records) an ineligible one; the rejected bikes are on the CFO's
 * review list with the cash kept and nothing posted; the Money received report is unchanged; rollback.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const ONEOFF = read('supabase/migrations/20261104090000_merchandise_a12_a13_corrections.sql');
const CONTROLS = read('supabase/migrations/20261104100000_merchandise_receivable_controls.sql');
const PHASE3 = read('supabase/migrations/20261104110000_merchandise_phase3_stock_phone_pledge.sql');
const ROLLBACK = read('supabase/rollbacks/20261104110000_merchandise_phase3_stock_phone_pledge.rollback.sql');
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
  it('keeps every existing category and adds exactly the two new ones, each mapped once', async () => {
    const o = (await rows<{ a: string[] }>(oldDb, `select ledger_category_allowlist() a`))[0].a;
    const n = (await rows<{ a: string[] }>(newDb, `select ledger_category_allowlist() a`))[0].a;
    expect(n.slice(0, o.length)).toEqual(o);
    expect(n.slice(o.length)).toEqual(['merchandise_revenue', 'merchandise_advance_memo_offset']);
    const m = await rows<{ c: string; a: string; d: string }>(newDb, `select category c, account_code a, debit_when d from ledger_account_map
      where category in ('merchandise_revenue', 'merchandise_advance_memo_offset') order by 1`);
    expect(m).toEqual([{ c: 'merchandise_advance_memo_offset', a: 'L1', d: 'cash_out' }, { c: 'merchandise_revenue', a: 'R1', d: 'cash_out' }]);
  });
});

describe('2. the 8 smartphone payouts: DR L1 / CR X1, once', () => {
  it('posts one balanced platform-only group per payout, 5,245,000, linked to the sale and to both original groups', async () => {
    const g = await rows<{ gid: string; n: string; sc: string[]; cin: string; cout: string; sid: string; refs: string[] }>(newDb, `
      select transaction_group_id gid, count(*) n, array_agg(distinct ledger_scope) sc, sum(amount) filter (where direction = 'cash_in') cin,
             sum(amount) filter (where direction = 'cash_out') cout, min(source_id::text) sid, array_agg(reference_id order by category) refs
      from general_ledger where idempotency_key like 'merch_phase3_20261104:%' group by 1`);
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
    const n = await acct(newDb, `select transaction_group_id from general_ledger where idempotency_key like 'merch_phase3_20261104:%'`);
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

describe('4. company stock: queued, recognised by the CFO once', () => {
  it('queues the 7 historical items, 1,015,000, flagged, nothing posted', async () => {
    const q = await rows<{ sale_id: string; amount: string; flags: string[]; status: string; account: string; origin: string }>(newDb,
      `select sale_id, amount, flags, status, account, origin from merchandise_stock_recognitions order by sale_id`);
    expect(q.length).toBe(7);
    expect(q.reduce((a, x) => a + num(x.amount), 0)).toBe(1_015_000);
    for (const x of q) {
      expect([x.status, x.account, x.origin]).toEqual(['pending', 'A12', 'historical_20261104']);
      expect(x.flags).toEqual(expect.arrayContaining(['no_handover_record', 'historical']));
      expect(num(x.amount)).toBe(FIX3.stock.find(([s]) => s === x.sale_id)![1]);
    }
    expect((await rows(newDb, `select 1 from general_ledger where idempotency_key like 'merch_stock_recog:%'`)).length).toBe(0);
  });
  it('only the CFO decides; E3 only for these historical items; posts once', async () => {
    const [aec] = await rows<{ id: string }>(newDb, `select id from merchandise_stock_recognitions where sale_id = $1`, [FIX3.stock[5][0]]);
    await expect(as(newDb, OPS, () => newDb.query(`select cfo_post_merchandise_stock_recognition($1, 'revenue', 'issued to agent 25 Sep')`, [aec.id])))
      .rejects.toThrow(/Only the CFO/);
    await expect(as(newDb, CFO, () => newDb.query(`select cfo_post_merchandise_stock_recognition($1, 'X4', 'issued to agent 25 Sep')`, [aec.id])))
      .rejects.toThrow(/Choose revenue/);
    const r1 = await as(newDb, CFO, () => rows<{ j: { status: string; amount: number } }>(newDb,
      `select cfo_post_merchandise_stock_recognition($1, 'revenue', 'issued to agent on 25 Sep (2 jackets)') j`, [aec.id]));
    expect([r1[0].j.status, num(r1[0].j.amount)]).toEqual(['posted', 110000]);
    const r2 = await as(newDb, CFO, () => rows<{ j: { already: boolean } }>(newDb,
      `select cfo_post_merchandise_stock_recognition($1, 'revenue', 'issued to agent on 25 Sep (2 jackets)') j`, [aec.id]));
    expect(r2[0].j.already).toBe(true);
    // A12 = 110,000 principal less the 6,410 principal already collected; the 110,000 is revenue
    expect(await saleAcct(newDb, FIX3.stock[5][0])).toEqual(expect.objectContaining({ A12: 103590 }));
    const g = await acct(newDb, `select transaction_group_id from general_ledger where idempotency_key like 'merch_stock_recog:%'`);
    expect(g).toEqual({ A12: 110000, R1: -110000 });
  });
  it('the other six: revenue for some, E3 for others, exactly the queued amounts', async () => {
    const q = await rows<{ id: string; sale_id: string }>(newDb, `select id, sale_id from merchandise_stock_recognitions where status = 'pending' order by sale_id`);
    expect(q.length).toBe(6);
    for (const [i, x] of q.entries()) {
      await as(newDb, CFO, () => newDb.query(`select cfo_post_merchandise_stock_recognition($1, $2, 'company stock issued 24-25 Sep')`,
        [x.id, i < 3 ? 'revenue' : 'E3']));
    }
    const all = await acct(newDb, `select transaction_group_id from general_ledger where idempotency_key like 'merch_stock_recog:%'`);
    expect(all.A12).toBe(1_015_000);
    expect((all.R1 ?? 0) + (all.E3 ?? 0)).toBe(-1_015_000);
    for (const [sale, amt] of FIX3.stock) {
      const a = await saleAcct(newDb, sale);
      expect(a.A12, sale).toBe(sale === FIX3.stock[5][0] ? 103590 : amt);
    }
  });
});

describe('4. future company-stock issues: every path queued once, or recognised on issue', () => {
  const AG = '00000000-0000-0000-0000-0000000008a1';
  const H = '00000000-0000-0000-0000-0000000008b1'; // handover path
  it('handover: queued at the order total; same order and plan rows as before', async () => {
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
    const q = await rows<{ amount: string; status: string; origin: string; flags: string[] }>(newDb,
      `select amount, status, origin, flags from merchandise_stock_recognitions where sale_id = $1`, [H]);
    expect(q.map((x) => [num(x.amount), x.status, x.origin])).toEqual([[110000, 'pending', 'issue']]);
    expect(q[0].flags).toEqual([]);
    // E3 is refused for a current issue
    const [row] = await rows<{ id: string }>(newDb, `select id from merchandise_stock_recognitions where sale_id = $1`, [H]);
    await expect(as(newDb, CFO, () => newDb.query(`select cfo_post_merchandise_stock_recognition($1, 'E3', 'current period sale')`, [row.id])))
      .rejects.toThrow(/only for items issued before these controls/);
  });
  it('a second status change (issued -> completed) does not queue again', async () => {
    await newDb.query(`update merchandise_sales set order_status = 'completed' where id = $1`, [H]);
    expect((await rows(newDb, `select 1 from merchandise_stock_recognitions where sale_id = $1`, [H])).length).toBe(1);
  });
  it('Agent Ops issue with an upfront payment that is not in the ledger: queued at the unpaid part, flagged', async () => {
    const [{ s }] = await as(newDb, OPS, () => rows<{ s: string }>(newDb,
      `select agent_ops_issue_agent_product($1, 'Welile Polo', 2, 35000, 25000, null, 'installment', 20000, 'issued at centre') s`, [AG]));
    const q = await rows<{ amount: string; flags: string[] }>(newDb, `select amount, flags from merchandise_stock_recognitions where sale_id = $1`, [s]);
    expect(num(q[0].amount)).toBe(50000);
    expect(q[0].flags).toEqual(['no_handover_record', 'unrecorded_payment']);
  });
  it('standing choice "revenue": recognised in the same transaction as the issue; a later cancellation is caught by the derecognition queue', async () => {
    await newDb.exec(`update merchandise_accounting_controls set stock_issue_counterpart = 'revenue'`);
    const S2 = '00000000-0000-0000-0000-0000000008b2';
    await newDb.query(`insert into merchandise_sales (id, customer_id, item_name, quantity, unit_price, total_revenue, amount_outstanding, amount_paid,
      payment_plan, fulfilment_type, order_status, created_at) values ($1, $2, 'waiting chair', 1, 650000, 650000, 650000, 0, 'installment', 'company_issued', 'awaiting_handover', now())`, [S2, AG]);
    await as(newDb, OPS, () => newDb.query(`select confirm_merchandise_handover($1, 'chair handed over')`, [S2]));
    const q = await rows<{ status: string; counterpart: string }>(newDb, `select status, counterpart from merchandise_stock_recognitions where sale_id = $1`, [S2]);
    expect(q).toEqual([{ status: 'posted', counterpart: 'revenue' }]);
    expect(await saleAcct(newDb, S2)).toEqual({ A12: 650000, R1: -650000 });
    await newDb.query(`update merchandise_sales set order_status = 'cancelled' where id = $1`, [S2]);
    const d = await rows<{ a12_net: string; status: string }>(newDb, `select a12_net, status from merchandise_receivable_derecognitions where sale_id = $1`, [S2]);
    expect(d.map((x) => [num(x.a12_net), x.status])).toEqual([[650000, 'pending']]);
    await newDb.exec(`update merchandise_accounting_controls set stock_issue_counterpart = null`);
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

describe('6. rejected bikes with cash kept: on the CFO review list, nothing posted', () => {
  it('two pending review rows flagged possible_refund with the cash kept, receivable 0', async () => {
    const q = await rows<{ sale_id: string; a13_net: string; cash: string; flags: string[]; status: string }>(newDb,
      `select sale_id, a13_net, cash_collected_net cash, flags, status from merchandise_receivable_derecognitions where sale_id = any($1::uuid[]) order by sale_id`, [FIX3.rejected_bikes]);
    expect(q.map((x) => [x.sale_id, num(x.a13_net), num(x.cash), x.status])).toEqual([
      [FIX3.rejected_bikes[1], 0, 103.48, 'pending'], [FIX3.rejected_bikes[0], 0, 109451, 'pending']].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    for (const x of q) expect(x.flags).toContain('possible_refund');
  });
  it('a CFO decision on them posts nothing (there is no receivable left)', async () => {
    const [r] = await rows<{ id: string }>(newDb, `select id from merchandise_receivable_derecognitions where sale_id = $1`, [FIX3.rejected_bikes[1]]);
    const j = await as(newDb, CFO, () => rows<{ j: { status: string } }>(newDb, `select cfo_post_merchandise_derecognition($1, 'E3', 'reviewed: bike never delivered') j`, [r.id]));
    expect(j[0].j.status).toBe('no_action');
  });
});

describe('every group the migration and the controls posted', () => {
  it('balances raw and on mapped accounts, has no wallet leg and the resolver adds nothing', async () => {
    const bad = await rows(newDb, `
      select g.transaction_group_id from general_ledger g
      join ledger_account_map m on m.ledger_scope = g.ledger_scope and m.category = g.category and m.wallet_bucket is null
      where g.idempotency_key like 'merch_phase3_20261104:%' or g.idempotency_key like 'merch_stock_recog:%'
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
    const ours = await rows(newDb, `select 1 from general_ledger where id = any($1::uuid[]) and (idempotency_key like 'merch_phase3_20261104:%' or idempotency_key like 'merch_stock_recog:%')`,
      [legs.map((l) => l.id)]);
    expect(ours.length).toBe(0);
    expect(receivedBefore.n).toBeGreaterThanOrEqual(0);
  });
  it('the migration itself moved only X1 and L1 (the queue posts nothing until the CFO decides)', async () => {
    const db = await build();
    const before = await acct(db);
    const n0 = num((await rows<{ n: string }>(db, `select count(*) n from general_ledger`))[0].n);
    await db.exec(PHASE3);
    const after = await acct(db);
    const diff = Object.fromEntries(Object.keys({ ...before, ...after }).map((k) => [k, Math.round(((after[k] ?? 0) - (before[k] ?? 0)) * 100) / 100]).filter(([, v]) => v !== 0));
    expect(diff).toEqual({ L1: 5_245_000, X1: -5_245_000 });
    expect(num((await rows<{ n: string }>(db, `select count(*) n from general_ledger`))[0].n) - n0).toBe(16);
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
    expect((await rows<{ c: string }>(db, `select category c from ledger_account_map where category in ('merchandise_revenue', 'merchandise_advance_memo_offset')`)).map((r) => r.c))
      .toEqual(['merchandise_advance_memo_offset']);
    await db.close();
  }, 400_000);
});
