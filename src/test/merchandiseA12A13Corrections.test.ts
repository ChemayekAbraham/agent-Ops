// @vitest-environment node
/**
 * Merchandise Receivables A12 / A13 corrections (supabase/migrations/20261104090000_merchandise_a12_a13_corrections.sql).
 *
 * Runs on PGlite with production's own ledger code, resolver and CFO "Money received" reports verbatim
 * (scripts/fixtures/merch-a12a13-prod-2026-11-04.sql, scripts/fixtures/sofp-prod-2026-11-02.sql) over a replica of every
 * merchandise plan / order with an A12 or A13 balance or an active plan, and every ledger group that touches them
 * (scripts/fixtures/merch-a12a13-prod-2026-11-04.json, read-only export 2026-11-03 21:18 UTC, no names or phone numbers).
 *
 * Proves: the replica reproduces production's per-item A12 / A13 balances; the preflight refuses on any change in the
 * evidence or item state; the 27 correction groups each balance (raw and on mapped accounts), carry no wallet leg and edit
 * nothing; every item lands on its operational target; items needing a CFO decision are untouched; no item is corrected
 * twice (including the smartphone recoveries already reclassified by 20261103200000); the Money received reports do not
 * count the corrections; a second apply is refused and the posting block is idempotent; the rollback restores the reports.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const MIGRATION = read('supabase/migrations/20261104090000_merchandise_a12_a13_corrections.sql');
const ROLLBACK = read('supabase/rollbacks/20261104090000_merchandise_a12_a13_corrections.rollback.sql');
const PROD = read('scripts/fixtures/merch-a12a13-prod-2026-11-04.sql');
const SOFP_ALL = read('scripts/fixtures/sofp-prod-2026-11-02.sql');
const SOFP = SOFP_ALL.slice(SOFP_ALL.indexOf('CREATE OR REPLACE FUNCTION public.sofp_ledger_legs'),
  SOFP_ALL.indexOf('CREATE OR REPLACE FUNCTION public.get_statement_of_financial_position'));
const POSTINGS = MIGRATION.slice(MIGRATION.indexOf('DO $post$'), MIGRATION.indexOf('END $post$;') + 'END $post$;'.length);
const PREFIX = 'merch_a12_a13_correction_20261104:';

interface RawLeg { id: string; gid: string; sc: string; cat: string; dir: string; amt: number; st: string | null; sid: string | null;
  ref: string | null; idem: string | null; td: string; ca: string; bk: string | null; uid: string | null; cls: string | null }
interface Item { plan: string; sale: string | null; acct: 'A12' | 'A13'; L: number; D: number; treat: string; orphan: boolean }
interface Group { key: string; code: string; plan: string; acct: string; amount: number;
  legs: Array<{ category: string; ledger_scope: string; direction: string; amount: number; reference_id: string; _acct: string; _side: string }> }
const FIX = JSON.parse(read('scripts/fixtures/merch-a12a13-prod-2026-11-04.json')) as {
  plans: unknown[]; sales: unknown[]; schedules: unknown[]; legs: RawLeg[]; map: unknown[]; integrity: unknown[];
  ddl: Record<string, Array<{ c: string; t: string; d: string | null }>>; items: Item[]; groups: Group[];
  expected_after: Record<string, number>; by_acct: Record<string, number>; report_md5: Record<string, { old: string; new: string }>;
};

const DEF_OK = /^(gen_random_uuid\(\)|now\(\)|true|false|-?\d+(\.\d+)?|'[^']*'::[\w ]+(\[\])?)$/;
const ddl = (t: string) => `create table public.${t} (${FIX.ddl[t].map((c) =>
  `"${c.c}" ${c.t}${c.d && DEF_OK.test(c.d) ? ` default ${c.d}` : ''}`).join(', ')});`;
const STANDINS = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create type public.solvency_bypass_reason as enum ('cfo_override');
${['general_ledger', 'ledger_account_map', 'ledger_integrity_config', 'merchandise_recovery_plans', 'merchandise_sales', 'smartphone_repayment_schedules'].map(ddl).join('\n')}
create table public.profiles (id uuid primary key, is_test boolean default false, full_name text, phone text);
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select '00000000-0000-0000-0000-0000000000cf'::uuid $$;
create type public.app_role as enum ('cfo', 'ceo', 'super_admin');
create function public.has_role(p_user uuid, p_role public.app_role) returns boolean language sql stable as $$ select true $$;
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
-- stricter than production ('log'): every new group must balance on mapped accounts or the insert fails
update public.ledger_integrity_config set mapped_balance_mode = 'enforce';
`;

const LEGS = FIX.legs.map((l) => ({ id: l.id, transaction_group_id: l.gid, ledger_scope: l.sc, category: l.cat, direction: l.dir, amount: l.amt,
  source_table: l.st, source_id: l.sid, reference_id: l.ref, idempotency_key: l.idem, transaction_date: l.td, created_at: l.ca,
  wallet_bucket: l.bk, user_id: l.uid, classification: l.cls }));

async function build(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(STANDINS);
  await db.exec(PROD);
  await db.exec(SOFP);
  const load = async (t: string, rows: unknown[]) =>
    db.query(`insert into public.${t} select * from json_populate_recordset(null::public.${t}, $1::json)`, [JSON.stringify(rows)]);
  await load('ledger_account_map', FIX.map);
  await load('ledger_integrity_config', FIX.integrity);
  await load('merchandise_recovery_plans', FIX.plans);
  await load('merchandise_sales', FIX.sales);
  await load('smartphone_repayment_schedules', FIX.schedules);
  await load('general_ledger', LEGS);
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
/** Resolver A12 / A13 balance per item: the groups whose legs name the plan or order, plus groups that reference those groups. */
async function itemBalances(db: PGlite): Promise<Map<string, number>> {
  const r = await rows<{ plan: string; acct: string; bal: string }>(db, `
    with items(plan_id, sale_id, acct) as (select * from json_to_recordset($1::json) as x(plan uuid, sale uuid, acct text)),
    ig as materialized (
      select distinct i.plan_id, g.transaction_group_id gid from items i
      join general_ledger g on g.source_id in (i.plan_id, i.sale_id) or g.reference_id in (i.plan_id::text, i.sale_id::text)
      union
      select distinct i.plan_id, x.transaction_group_id from items i
      join general_ledger g on g.source_id in (i.plan_id, i.sale_id) or g.reference_id in (i.plan_id::text, i.sale_id::text)
      join general_ledger x on x.reference_id = g.transaction_group_id::text and x.transaction_group_id <> g.transaction_group_id),
    res as materialized (select s.transaction_group_id gid, s.account_code acct, sum(s.dr - s.cr) net
      from sofp_ledger_legs(now() + interval '1 day') s where s.account_code in ('A12', 'A13') group by 1, 2)
    select i.plan_id::text plan, i.acct, coalesce(sum(r.net), 0) bal from items i
    left join ig on ig.plan_id = i.plan_id left join res r on r.gid = ig.gid and r.acct = i.acct group by 1, 2`,
  [JSON.stringify(FIX.items.map((i) => ({ plan: i.plan, sale: i.sale, acct: i.acct })))]);
  return new Map(r.map((x) => [x.plan, num(x.bal)]));
}
async function accountTotals(db: PGlite): Promise<Record<string, number>> {
  const r = await rows<{ a: string; n: string }>(db, `select account_code a, sum(dr - cr) n from sofp_ledger_legs(now() + interval '1 day')
    where account_code in ('A12', 'A13', 'E3', 'R1', 'X1', 'A10') group by 1`);
  return Object.fromEntries(r.map((x) => [x.a, num(x.n)]));
}
async function received(db: PGlite) {
  const day = (await rows<{ d: string }>(db, `select ((now() at time zone 'Africa/Kampala')::date)::text d`))[0].d;
  const totals = await rows<{ category_key: string; amount: string }>(db, `select category_key, amount from get_cfo_received_by_category_totals($1::date, $1::date)`, [day]);
  const products = await rows<{ product_key: string; amount: string }>(db, `select product_key, amount from get_cfo_received_agent_products_breakdown($1::date, $1::date)`, [day]);
  const page = await rows<{ id: string }>(db, `select id from get_cfo_received_by_category_page($1::date, $1::date, null, null, null, 0, 1000)`, [day]);
  return { totals: Object.fromEntries(totals.map((x) => [x.category_key, num(x.amount)])),
    products: Object.fromEntries(products.map((x) => [x.product_key, num(x.amount)])), rows: page.length };
}
const REPORTS = Object.keys(FIX.report_md5);

let db: PGlite;
let before: Map<string, number>;
let totalsBefore: Record<string, number>;
let legsBefore: string;
let reportBefore: Awaited<ReturnType<typeof received>>;

beforeAll(async () => {
  db = await build();
  before = await itemBalances(db);
  totalsBefore = await accountTotals(db);
  legsBefore = JSON.stringify(await rows(db, `select id, transaction_group_id, ledger_scope, category, direction, amount, source_id, reference_id, idempotency_key from general_ledger order by id`));
  reportBefore = await received(db);
}, 240_000);
afterAll(async () => { await db?.close(); });

describe('replica of production (2026-11-03 21:18 UTC)', () => {
  it('reproduces every item\'s A12 / A13 balance', () => {
    for (const i of FIX.items) expect(before.get(i.plan) ?? 0, `${i.plan} ${i.acct}`).toBeCloseTo(i.L, 2);
  });
  it('the planned groups are 27, one per item and code, and every J1b collection is a distinct, not yet split group', () => {
    expect(FIX.groups.length).toBe(27);
    const keys = new Set(FIX.groups.map((g) => g.key));
    expect(keys.size).toBe(27);
    const perItem = new Set(FIX.groups.filter((g) => g.code !== 'J1b').map((g) => `${g.plan}|${g.code}`));
    expect(perItem.size).toBe(FIX.groups.filter((g) => g.code !== 'J1b').length);
    const j1b = FIX.groups.filter((g) => g.code === 'J1b').map((g) => g.legs[0].reference_id);
    expect(new Set(j1b).size).toBe(j1b.length);
    for (const gid of j1b) {
      expect(FIX.legs.some((l) => l.gid === gid && l.cat === 'access_fee_collected'), gid).toBe(false);
      expect(FIX.legs.some((l) => l.ref === gid), `${gid} already referenced (e.g. reclassified)`).toBe(false);
    }
  });
});

describe('preflight', () => {
  it('refuses, changing nothing, when an item\'s ledger moved (a new collection on a not-delivered order)', async () => {
    const t = await build();
    const plan = FIX.items.find((i) => i.plan.startsWith('fdb05fd5'))!;
    // a balanced collection (wallet DR L1 / platform CR A12), as agent_pay_merchandise_plan would post
    await t.query(`insert into general_ledger (ledger_scope, direction, category, amount, wallet_bucket, recipient_type, source_table, source_id, transaction_group_id, classification)
      values ('wallet', 'cash_out', 'agent_repayment', 100, 'withdrawable', 'user', 'merchandise_recovery_plans', $1, '00000000-0000-0000-0000-00000000d41f', 'production'),
             ('platform', 'cash_in', 'merchandise_recovery_repayment', 100, null, null, 'merchandise_recovery_plans', $1, '00000000-0000-0000-0000-00000000d41f', 'production')`, [plan.plan]);
    await expect(t.exec(MIGRATION)).rejects.toThrow(/evidence or state changed for fdb05fd5/);
    expect((await rows(t, `select 1 from general_ledger where idempotency_key like '${PREFIX}%'`)).length).toBe(0);
    for (const sig of REPORTS) expect(await fnMd5(t, sig)).toBe(FIX.report_md5[sig].old);
    await t.close();
  }, 240_000);
  it('refuses when an order status changed (a pending order approved)', async () => {
    const t = await build();
    await t.exec(`update merchandise_sales set order_status = 'approved' where id::text like 'a8db01e9%'`);
    await expect(t.exec(MIGRATION)).rejects.toThrow(/evidence or state changed for ad7f535c/);
    await t.close();
  }, 240_000);
  it('refuses when a mapping is not as expected', async () => {
    const t = await build();
    await t.exec(`update ledger_account_map set account_code = 'A4' where category = 'smartphone_advance_receivable'`);
    await expect(t.exec(MIGRATION)).rejects.toThrow(/ledger_account_map/);
    await t.close();
  }, 240_000);
});

describe('apply', () => {
  beforeAll(async () => { await db.exec(MIGRATION); }, 240_000);

  it('posts 27 balanced platform/bridge groups (raw and mapped), no wallet leg, nothing existing edited', async () => {
    const g = await rows<{ gid: string; n: string; scopes: string[]; cin: string; cout: string }>(db, `
      select transaction_group_id gid, count(*) n, array_agg(distinct ledger_scope) scopes,
        sum(amount) filter (where direction = 'cash_in') cin, sum(amount) filter (where direction = 'cash_out') cout
      from general_ledger where idempotency_key like '${PREFIX}%' group by 1`);
    expect(g.length).toBe(27);
    for (const x of g) {
      expect(num(x.n)).toBe(2);
      expect(x.scopes.includes('wallet')).toBe(false);
      expect(num(x.cin)).toBe(num(x.cout));
    }
    expect((await rows(db, `select * from ledger_mapped_balance_violations`)).length).toBe(0);
    const now = JSON.stringify(await rows(db, `select id, transaction_group_id, ledger_scope, category, direction, amount, source_id, reference_id, idempotency_key
      from general_ledger where idempotency_key is null or idempotency_key not like '${PREFIX}%' order by id`));
    expect(now).toBe(legsBefore);
  });

  it('posts exactly the planned legs', async () => {
    for (const g of FIX.groups) {
      const r = await rows<{ category: string; ledger_scope: string; direction: string; amount: string; source_id: string; reference_id: string }>(db,
        `select category, ledger_scope, direction, amount, source_id, reference_id from general_ledger where idempotency_key = $1 order by category`, [g.key]);
      const want = [...g.legs].sort((a, b) => a.category.localeCompare(b.category))
        .map((l) => ({ category: l.category, ledger_scope: l.ledger_scope, direction: l.direction, amount: l.amount, source_id: g.plan, reference_id: l.reference_id }));
      expect(r.map((x) => ({ ...x, amount: num(x.amount) })), g.key).toEqual(want);
    }
  });

  it('every item lands on its operational target; items needing a CFO decision are untouched', async () => {
    const after = await itemBalances(db);
    for (const i of FIX.items) {
      expect(after.get(i.plan) ?? 0, `${i.plan} ${i.treat}`).toBeCloseTo(FIX.expected_after[i.plan], 2);
      // a decision item gets no receivable entry; only the charge split of its collections (J1b), if any
      const j1b = FIX.groups.filter((g) => g.plan === i.plan && g.code === 'J1b').reduce((a, g) => a + g.amount, 0);
      if (i.treat === 'needs CFO decision') expect(after.get(i.plan) ?? 0).toBeCloseTo((before.get(i.plan) ?? 0) + j1b, 2);
      else expect(after.get(i.plan) ?? 0, `${i.plan} target`).toBeCloseTo(i.D, 2);
    }
  });

  it('moves the accounts by exactly the schedule (resolver)', async () => {
    const t = await accountTotals(db);
    for (const [a, v] of Object.entries(FIX.by_acct)) expect(t[a] - totalsBefore[a], a).toBeCloseTo(v, 2);
    expect(t.A10 - totalsBefore.A10).toBeCloseTo(0, 2); // the smartphone reclassification is not repeated
    expect(t.A12).toBeCloseTo(11_174_793.44, 2);
    expect(t.A13).toBeCloseTo(1_109_288, 2);
  });

  it('the Money received reports do not count the corrections', async () => {
    for (const sig of REPORTS) expect(await fnMd5(db, sig), sig).toBe(FIX.report_md5[sig].new);
    expect(await received(db)).toEqual(reportBefore);
    const cin = num((await rows<{ n: string }>(db, `select sum(amount) n from general_ledger where idempotency_key like '${PREFIX}%' and direction = 'cash_in' and ledger_scope = 'platform' and category = 'access_fee_collected'`))[0].n);
    expect(cin).toBe(5416); // would otherwise show as fees received today
  });

  it('is idempotent and cannot be applied twice', async () => {
    const n0 = num((await rows<{ n: string }>(db, `select count(*) n from general_ledger`))[0].n);
    await db.exec(POSTINGS);
    expect(num((await rows<{ n: string }>(db, `select count(*) n from general_ledger`))[0].n)).toBe(n0);
    await expect(db.exec(MIGRATION)).rejects.toThrow(/preflight refused|already applied/);
  });
});

describe('rollback', () => {
  it('restores the report functions; the correction entries stay', async () => {
    const t = await build();
    await t.exec(MIGRATION);
    await t.exec(ROLLBACK);
    for (const sig of REPORTS) expect(await fnMd5(t, sig)).toBe(FIX.report_md5[sig].old);
    expect(num((await rows<{ n: string }>(t, `select count(distinct transaction_group_id) n from general_ledger where idempotency_key like '${PREFIX}%'`))[0].n)).toBe(27);
    await t.close();
  }, 240_000);
});
