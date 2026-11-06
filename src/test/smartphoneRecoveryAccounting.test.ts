// @vitest-environment node
/**
 * Smartphone recovery accounting: A10 -> A12 (principal) / R1 (monthly charge), CFO instruction 2026-11-03
 * (supabase/migrations/20261103200000_smartphone_recovery_to_a12.sql).
 *
 * Runs on PGlite with production's own code, verbatim (scripts/fixtures/smartphone-recovery-prod-2026-11-03.sql and the
 * balance-sheet resolver scripts/fixtures/sofp-prod-2026-11-02.sql), over a replica of production's 8 smartphone plans,
 * their sales, repayment schedules and every ledger group that touches them (scripts/fixtures/
 * smartphone-recovery-prod-2026-11-03.json, read-only export 2026-11-03 19:57 UTC, no names or phone numbers).
 *
 * Proves: the replica reproduces production's resolver balances; the migration's preflight refuses anything but the
 * production definitions; the historical reclassification moves exactly the A10 smartphone recoveries to A12 / R1 with
 * new balanced platform-only groups (nothing edited, no wallet leg), split as an independent calculation says; it is
 * idempotent; the hourly job and the Returns pledge take exactly the same money from the same wallets, change the same
 * plan, sale, deduction and notification rows as before and differ only in their platform legs; a plan paid off
 * recognises exactly its principal in A12 and its charges in R1; a failing split never stops a collection; the
 * rollback restores the production functions.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const MIGRATION = read('supabase/migrations/20261103200000_smartphone_recovery_to_a12.sql');
const ROLLBACK = read('supabase/rollbacks/20261103200000_smartphone_recovery_to_a12.rollback.sql');
const PROD = read('scripts/fixtures/smartphone-recovery-prod-2026-11-03.sql');
const SOFP_ALL = read('scripts/fixtures/sofp-prod-2026-11-02.sql');
const SOFP = SOFP_ALL.slice(SOFP_ALL.indexOf('CREATE OR REPLACE FUNCTION public.sofp_ledger_legs'),
  SOFP_ALL.indexOf('CREATE OR REPLACE FUNCTION public.get_statement_of_financial_position'));
const RECLASS_BLOCK = MIGRATION.slice(MIGRATION.indexOf('DO $reclass$'), MIGRATION.indexOf('END $reclass$;') + 'END $reclass$;'.length);

interface Leg { id: string; transaction_group_id: string; ledger_scope: string; direction: string; category: string; amount: number;
  source_table: string; source_id: string; transaction_date: string; created_at: string; wallet_bucket: string | null }
interface Plan { id: string; sale_id: string; original_amount: number; starts_on: string; customer_id: string }
interface Sale { id: string; disbursed_amount: number | null; total_revenue: number | null }
interface Sched { sale_id: string; month_index: number; period_start: string; period_end: string; principal_due: number; charge_due: number; total_due: number }
const FIX = JSON.parse(read('scripts/fixtures/smartphone-recovery-prod-2026-11-03.json')) as {
  plans: Plan[]; sales: Sale[]; schedules: Sched[]; legs: Leg[]; pledges: Array<{ user_id: string }>;
  map: unknown[]; integrity: unknown[]; ddl: Record<string, Array<{ c: string; t: string; d: string | null }>>;
  resolver_plan: Array<{ account_code: string; plan_id: string; net: number }>;
};

const PROD_MD5: Record<string, string> = {
  'public.create_ledger_transaction(jsonb, text, boolean)': '8e570ba579b151ac17788c0ee668a93b',
  'public.recover_smartphone_from_wallets()': 'c2c65f6994e6548f94c41346c6d08722',
  'public.apply_smartphone_roi_pledge(uuid, numeric, text)': 'b984f99c1808977646f88bda055619d5',
  'public.smartphone_reducing_schedule(numeric, integer, date)': 'ac1512654e75942c484476f638c6dca2',
  'public.sofp_ledger_legs(timestamp with time zone)': '843ccf477014f8c7a8e0b5c6f14a1ba0',
  'public.ledger_category_allowlist()': 'd1b408552ac7f96bb3b84a286261c7fd',
  'public.get_cfo_received_by_category_totals(date, date)': 'd1b7dd4113f0a861fe6da988a8e97008',
  'public.get_cfo_received_by_category_page(date, date, text, text, text, integer, integer)': 'af27c0bb9f0507dd12ef581817690f79',
  'public.get_cfo_received_agent_products_breakdown(date, date)': '9353e5d5458d62f6f2413e710134a85e',
};
const REPORT_SIGS = Object.keys(PROD_MD5).filter((k) => k.includes('received'));
const NEW_MD5 = {
  recover: '8e2ba4427f7d5555579c34bf96c95428',
  pledge: '74ae9dca248b4b92e6e81a3bd472d997',
  'public.get_cfo_received_by_category_totals(date, date)': 'ba864905b5bc7ff9165d47f9c946432a',
  'public.get_cfo_received_by_category_page(date, date, text, text, text, integer, integer)': '6e69a2f7eacc80fa6d87ae4d18a8f5a5',
  'public.get_cfo_received_agent_products_breakdown(date, date)': 'c79bcf09662300dc96ac2f89f5880179',
} as Record<string, string>;

const DEF_OK = /^(gen_random_uuid\(\)|now\(\)|true|false|-?\d+(\.\d+)?|'[^']*'::[\w ]+(\[\])?)$/;
const ddl = (t: string) => `create table public.${t} (${FIX.ddl[t].map((c) =>
  `"${c.c}" ${c.t}${c.d && DEF_OK.test(c.d) ? ` default ${c.d}` : ''}`).join(', ')});`;

const STANDINS = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create type public.solvency_bypass_reason as enum ('cfo_override');
${['general_ledger', 'ledger_account_map', 'ledger_integrity_config', 'merchandise_recovery_plans', 'merchandise_sales',
    'smartphone_repayment_schedules', 'merchandise_recovery_deductions', 'smartphone_roi_pledges', 'smartphone_roi_pledge_applications']
    .map(ddl).join('\n')}
create table public.profiles (id uuid primary key, is_test boolean default false, full_name text, phone text);
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select '00000000-0000-0000-0000-0000000000cf'::uuid $$;
create type public.app_role as enum ('cfo', 'ceo', 'super_admin');
create function public.has_role(p_user uuid, p_role public.app_role) returns boolean language sql stable as $$ select true $$;
create table public.notifications (id uuid default gen_random_uuid(), user_id uuid, title text, message text, type text, metadata jsonb, link_path text, created_at timestamptz default now());
create table public.system_events (id uuid default gen_random_uuid(), event_type text, user_id uuid, metadata jsonb, created_at timestamptz default now());
create table public.wallets (id uuid default gen_random_uuid(), user_id uuid unique, withdrawable_balance numeric default 0);
create table public.wallet_fresh_start_anchors (user_id uuid, anchor_at timestamptz);
create table public.wallet_routing_violations (user_id uuid, category text, direction text, amount numeric, recipient_type text, reason text, context jsonb);
create table public.treasury_controls (control_key text, enabled boolean);
create table public.ledger_mapped_balance_violations (transaction_group_id uuid primary key, mapped_debits numeric, mapped_credits numeric, residual numeric, source_table text, leg_shape text, detected_at timestamptz default now());
create table public.smartphone_catalog (brand text, model_name text);
create table public.test_avail (user_id uuid primary key, amt numeric);
-- money available to take: stand-ins for production's wallet projections
create function public.get_user_advance_reversal_available(p uuid) returns numeric language sql stable as $$ select coalesce((select amt from public.test_avail where user_id = p), 0) $$;
create function public.get_user_available_balance(p uuid) returns numeric language sql stable as $$ select coalesce((select amt from public.test_avail where user_id = p), 0) $$;
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

const BIG = 50_000_000;

async function build(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(STANDINS);
  await db.exec(PROD);
  await db.exec(SOFP);
  const load = async (t: string, rows: unknown[]) => {
    await db.query(`insert into public.${t} select * from json_populate_recordset(null::public.${t}, $1::json)`, [JSON.stringify(rows)]);
  };
  await load('ledger_account_map', FIX.map);
  await load('ledger_integrity_config', FIX.integrity);
  await load('merchandise_recovery_plans', FIX.plans);
  await load('merchandise_sales', FIX.sales);
  await load('smartphone_repayment_schedules', FIX.schedules);
  await load('smartphone_roi_pledges', FIX.pledges);
  await load('general_ledger', FIX.legs);
  const customers = [...new Set(FIX.plans.map((p) => p.customer_id))];
  for (const c of customers) {
    await db.query(`insert into public.profiles (id) values ($1)`, [c]);
    await db.query(`insert into public.wallets (user_id, withdrawable_balance) values ($1, $2)`, [c, BIG]);
    await db.query(`insert into public.test_avail values ($1, 0)`, [c]);
    // opening wallet money (wallet scope, explicit bucket) so the posting function's balance check passes
    await db.query(`insert into public.general_ledger (user_id, ledger_scope, direction, category, amount, wallet_bucket, classification, description, transaction_date, created_at)
      values ($1, 'wallet', 'cash_in', 'wallet_deposit', $2, 'withdrawable', 'production', 'test seed', '2026-01-01', '2026-01-01')`, [c, BIG]);
  }
  await db.exec(TRIGGERS);
  return db;
}

const num = (v: unknown) => Number(v);
async function rows<T = Record<string, unknown>>(db: PGlite, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}
async function fnMd5(db: PGlite, sig: string): Promise<string | null> {
  const r = await rows<{ m: string | null }>(db, `select (select md5(replace(prosrc, chr(13), '')) from pg_proc where oid = to_regprocedure($1)) m`, [sig]);
  return r[0].m;
}
/** Resolver balance by account for the groups of one plan, or all smartphone plans. */
async function resolverByPlan(db: PGlite): Promise<Map<string, number>> {
  const r = await rows<{ k: string; net: string }>(db, `
    select s.account_code || '|' || g.source_id k, sum(s.dr) - sum(s.cr) net
    from sofp_ledger_legs(now() + interval '1 day') s
    join (select distinct transaction_group_id gid, source_id from general_ledger where source_table = 'merchandise_recovery_plans') g
      on g.gid = s.transaction_group_id
    where s.account_code in ('A10', 'A12', 'A13', 'R1') group by 1`);
  return new Map(r.map((x) => [x.k, num(x.net)]));
}

/** The CFO "Money received" report for today (Kampala): totals by category, the agent products breakdown, the listed rows. */
async function received(db: PGlite) {
  const day = (await rows<{ d: string }>(db, `select ((now() at time zone 'Africa/Kampala')::date)::text d`))[0].d;
  const totals = await rows<{ category_key: string; amount: string }>(db, `select category_key, amount from get_cfo_received_by_category_totals($1::date, $1::date)`, [day]);
  const products = await rows<{ product_key: string; amount: string }>(db, `select product_key, amount from get_cfo_received_agent_products_breakdown($1::date, $1::date)`, [day]);
  const page = await rows<{ id: string }>(db, `select id from get_cfo_received_by_category_page($1::date, $1::date, null, null, null, 0, 1000)`, [day]);
  return {
    totals: Object.fromEntries(totals.map((x) => [x.category_key, num(x.amount)])) as Record<string, number>,
    products: Object.fromEntries(products.map((x) => [x.product_key, num(x.amount)])) as Record<string, number>,
    rows: page.length,
  };
}

// ---------------------------------------------------------------- independent calculation of the split
const ymdKampala = (ts: string) => new Date(new Date(ts).getTime() + 3 * 3600_000).toISOString().slice(0, 10);
function addMonths(ymd: string, m: number): string {
  const [y, mo, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, mo - 1 + m, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
}
const dayBefore = (ymd: string) => new Date(Date.parse(ymd) - 86400_000).toISOString().slice(0, 10);
function reducing(amount: number, months: number, start: string) {
  const per = Math.floor(amount / months);
  let open = amount;
  const out: Array<{ ps: string; pe: string; c: number; t: number; p: number }> = [];
  for (let m = 1; m <= months; m++) {
    const p = m === months ? open : per;
    const c = Math.round((open * 28) / 100);
    out.push({ ps: addMonths(start, m - 1), pe: dayBefore(addMonths(start, m)), c, t: p + c, p });
    open -= p;
  }
  return out;
}
function scheduleFor(plan: Plan) {
  const sale = FIX.sales.find((s) => s.id === plan.sale_id)!;
  const stored = FIX.schedules.filter((s) => s.sale_id === plan.sale_id).sort((a, b) => a.month_index - b.month_index)
    .map((s) => ({ ps: s.period_start, pe: s.period_end, c: num(s.charge_due), t: num(s.total_due), p: num(s.principal_due) }));
  if (stored.length && stored.reduce((a, s) => a + s.t, 0) === num(plan.original_amount)) return { rows: stored, basis: 'stored_schedule' };
  const base = num(sale.disbursed_amount) || num(sale.total_revenue);
  for (let m = 1; m <= 12; m++) {
    const r = reducing(base, m, plan.starts_on);
    if (r.reduce((a, s) => a + s.t, 0) === num(plan.original_amount)) return { rows: r, basis: `rebuilt_schedule_${m}m` };
  }
  throw new Error(`no schedule for ${plan.id}`);
}
/** Expected reclassification per historical A10 leg, oldest first (the migration's order). */
function expectedReclass() {
  const prior = new Map<string, { c: number; p: number }>();
  for (const l of FIX.legs) {
    if (l.ledger_scope === 'platform' && l.category === 'merchandise_recovery_repayment' && l.source_table === 'merchandise_recovery_plans') {
      const x = prior.get(l.source_id) ?? { c: 0, p: 0 };
      x.p += l.direction === 'cash_in' ? num(l.amount) : -num(l.amount);
      prior.set(l.source_id, x);
    }
  }
  const legs = FIX.legs.filter((l) => l.ledger_scope === 'platform' && l.category === 'agent_advance_repayment' && l.direction === 'cash_in'
    && l.source_table === 'merchandise_recovery_plans')
    .sort((a, b) => a.transaction_date.localeCompare(b.transaction_date) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  return legs.map((l) => {
    const plan = FIX.plans.find((p) => p.id === l.source_id)!;
    const { rows: sch, basis } = scheduleFor(plan);
    const day = ymdKampala(l.transaction_date);
    const row = sch.find((r) => day >= r.ps && day <= r.pe) ?? (day < sch[0].ps ? sch[0] : sch[sch.length - 1]);
    const C = sch.reduce((a, r) => a + r.c, 0);
    const P = sch.reduce((a, r) => a + r.p, 0);
    const pr = prior.get(plan.id) ?? { c: 0, p: 0 };
    const amount = num(l.amount);
    let charge = Math.min(Math.round((amount * row.c) / row.t), Math.max(C - pr.c, 0));
    let principal = amount - charge;
    const remP = Math.max(P - pr.p, 0);
    if (principal > remP) {
      const shift = Math.min(principal - remP, Math.max(C - pr.c - charge, 0));
      charge += shift; principal -= shift;
    }
    pr.c += charge; pr.p += principal; prior.set(plan.id, pr);
    return { leg: l.id, plan: plan.id, amount, principal, charge, basis };
  });
}

// ---------------------------------------------------------------- tests
let before: PGlite; // production as exported, then the OLD functions run
let after: PGlite;  // production as exported + the migration, then the NEW functions run
const EXPECTED = expectedReclass();
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

beforeAll(async () => {
  before = await build();
  after = await build();
}, 240_000);
afterAll(async () => { await before?.close(); await after?.close(); });

describe('replica of production (2026-11-03 19:57 UTC)', () => {
  it('runs production\'s own definitions', async () => {
    for (const [sig, m] of Object.entries(PROD_MD5)) expect(await fnMd5(before, sig), sig).toBe(m);
  });
  it('reproduces production\'s resolver balances for every smartphone plan (A10 / A12)', async () => {
    const got = await resolverByPlan(before);
    for (const r of FIX.resolver_plan) expect(got.get(`${r.account_code}|${r.plan_id}`), `${r.account_code} ${r.plan_id}`).toBeCloseTo(num(r.net), 2);
    const a10 = sum(FIX.resolver_plan.filter((r) => r.account_code === 'A10').map((r) => num(r.net)));
    expect(a10).toBe(-411046); // 82 recoveries credited to A10 so far
  });
});

describe('preflight', () => {
  it('refuses, changing nothing, when a recovery function is not the production definition', async () => {
    const db = await build();
    await db.exec(`create or replace function public.apply_smartphone_roi_pledge(p_user_id uuid, p_roi_amount numeric, p_reference text)
      returns jsonb language sql as $$ select '{}'::jsonb $$`);
    await expect(db.exec(MIGRATION)).rejects.toThrow(/preflight refused/);
    expect(await fnMd5(db, 'public.recover_smartphone_from_wallets()')).toBe(PROD_MD5['public.recover_smartphone_from_wallets()']);
    expect(await fnMd5(db, 'public._smartphone_recovery_split(uuid, numeric, date)')).toBeNull();
    expect((await rows(db, `select 1 from general_ledger where idempotency_key like 'smartphone_a10_to_a12_reclass:%'`)).length).toBe(0);
    await db.close();
  }, 240_000);
  it('refuses when a mapping is not as expected', async () => {
    const db = await build();
    await db.exec(`update ledger_account_map set account_code = 'A4' where ledger_scope = 'platform' and category = 'merchandise_recovery_repayment'`);
    await expect(db.exec(MIGRATION)).rejects.toThrow(/ledger_account_map/);
    await db.close();
  }, 240_000);
});

describe('migration: historical reclassification', () => {
  let legsBefore: number; let walletBefore: string;
  let resolverBefore: Map<string, number>; let reportBefore: Awaited<ReturnType<typeof received>>;
  beforeAll(async () => {
    legsBefore = num((await rows<{ n: string }>(after, `select count(*) n from general_ledger`))[0].n);
    walletBefore = JSON.stringify(await rows(after, `select * from general_ledger where ledger_scope = 'wallet' order by id`));
    resolverBefore = await resolverByPlan(after);
    reportBefore = await received(after);
    await after.exec(MIGRATION);
  }, 240_000);

  it('installs the new definitions', async () => {
    expect(await fnMd5(after, 'public.recover_smartphone_from_wallets()')).toBe(NEW_MD5.recover);
    expect(await fnMd5(after, 'public.apply_smartphone_roi_pledge(uuid, numeric, text)')).toBe(NEW_MD5.pledge);
    for (const sig of REPORT_SIGS) expect(await fnMd5(after, sig), sig).toBe(NEW_MD5[sig]);
  });

  it('the CFO Money received report does not show the reclassification as money received', async () => {
    expect(await received(after)).toEqual(reportBefore);
    // without the exclusion it would: the reclassification's A12 / R1 legs are platform cash_in dated today
    const legs = num((await rows<{ n: string }>(after, `select sum(amount) n from general_ledger where idempotency_key like 'smartphone_a10_to_a12_reclass:%' and direction = 'cash_in'`))[0].n);
    expect(legs).toBe(411046);
  });

  it('posts one new balanced platform-only group per historical A10 recovery, editing nothing', async () => {
    const g = await rows<{ gid: string; n: string; scopes: string[]; cin: string; cout: string }>(after, `
      select transaction_group_id gid, count(*) n, array_agg(distinct ledger_scope) scopes,
             sum(amount) filter (where direction = 'cash_in') cin, sum(amount) filter (where direction = 'cash_out') cout
      from general_ledger where idempotency_key like 'smartphone_a10_to_a12_reclass:%' group by 1`);
    expect(g.length).toBe(EXPECTED.length);
    expect(EXPECTED.length).toBe(82);
    for (const x of g) { expect(x.scopes).toEqual(['platform']); expect(num(x.cin)).toBe(num(x.cout)); }
    const total = num((await rows<{ n: string }>(after, `select count(*) n from general_ledger`))[0].n);
    expect(total - legsBefore).toBe(sum(g.map((x) => num(x.n))));
    // every original row still there, unchanged
    for (const l of FIX.legs) {
      const r = await rows<{ amount: string; category: string; direction: string }>(after, `select amount, category, direction from general_ledger where id = $1`, [l.id]);
      expect([num(r[0].amount), r[0].category, r[0].direction]).toEqual([num(l.amount), l.category, l.direction]);
    }
    expect(JSON.stringify(await rows(after, `select * from general_ledger where ledger_scope = 'wallet' order by id`))).toBe(walletBefore);
    expect((await rows(after, `select * from ledger_mapped_balance_violations`)).length).toBe(0);
  });

  it('splits each recovery exactly as the independent calculation (principal to A12, charge to R1)', async () => {
    for (const e of EXPECTED) {
      const r = await rows<{ category: string; direction: string; amount: string }>(after,
        `select category, direction, amount from general_ledger where idempotency_key = $1 order by category`, [`smartphone_a10_to_a12_reclass:${e.leg}`]);
      const get = (c: string) => num(r.find((x) => x.category === c)?.amount ?? 0);
      expect({ a10: get('agent_advance_repayment'), a12: get('merchandise_recovery_repayment'), r1: get('access_fee_collected') }, e.leg)
        .toEqual({ a10: e.amount, a12: e.principal, r1: e.charge });
      expect(r.find((x) => x.category === 'agent_advance_repayment')?.direction).toBe('cash_out');
    }
  });

  it('leaves nothing in A10 for smartphones; A12 falls by the principal, R1 rises by the charges (resolver)', async () => {
    const got = await resolverByPlan(after);
    for (const p of FIX.plans) {
      const e = EXPECTED.filter((x) => x.plan === p.id);
      expect(got.get(`A10|${p.id}`) ?? 0, `A10 ${p.id}`).toBeCloseTo(0, 2);
      expect(got.get(`A12|${p.id}`) ?? 0, `A12 ${p.id}`).toBeCloseTo((resolverBefore.get(`A12|${p.id}`) ?? 0) - sum(e.map((x) => x.principal)), 2);
      expect(got.get(`R1|${p.id}`) ?? 0, `R1 ${p.id}`).toBeCloseTo(-sum(e.map((x) => x.charge)), 2);
      expect(got.get(`A13|${p.id}`) ?? 0).toBe(0);
    }
    // the resolver puts every reclassification leg on its mapped account: no shape override, nothing one-sided
    const legs = await rows<{ acct: string; dr: string; cr: string; one: boolean }>(after, `
      select s.account_code acct, sum(s.dr) dr, sum(s.cr) cr, bool_or(s.group_one_sided) one
      from sofp_ledger_legs(now() + interval '1 day') s
      where s.transaction_group_id in (select transaction_group_id from general_ledger where idempotency_key like 'smartphone_a10_to_a12_reclass:%')
      group by 1 order by 1`);
    expect(legs.map((l) => l.acct)).toEqual(['A10', 'A12', 'R1']);
    const by = Object.fromEntries(legs.map((l) => [l.acct, l]));
    expect(num(by.A10.dr)).toBe(sum(EXPECTED.map((e) => e.amount)));
    expect(num(by.A12.cr)).toBe(sum(EXPECTED.map((e) => e.principal)));
    expect(num(by.R1.cr)).toBe(sum(EXPECTED.map((e) => e.charge)));
    expect(legs.some((l) => l.one)).toBe(false);
    // the report for the CFO: per plan and totals (printed in the test log)
    const perPlan = FIX.plans.map((p) => {
      const e = EXPECTED.filter((x) => x.plan === p.id);
      return { plan: p.id.slice(0, 8), basis: e[0]?.basis ?? '-', recoveries: e.length, a10: sum(e.map((x) => x.amount)),
        principal_a12: sum(e.map((x) => x.principal)), charge_r1: sum(e.map((x) => x.charge)) };
    });
    console.log(JSON.stringify({ perPlan, totals: { a10: sum(EXPECTED.map((e) => e.amount)), a12: sum(EXPECTED.map((e) => e.principal)), r1: sum(EXPECTED.map((e) => e.charge)) } }));
  });

  it('is idempotent: running the reclassification again posts nothing', async () => {
    const n0 = num((await rows<{ n: string }>(after, `select count(*) n from general_ledger`))[0].n);
    await after.exec(RECLASS_BLOCK);
    expect(num((await rows<{ n: string }>(after, `select count(*) n from general_ledger`))[0].n)).toBe(n0);
    await expect(after.exec(MIGRATION)).rejects.toThrow(/preflight refused/); // a second apply is refused outright
  });

  it('keeps the split helpers away from app users', async () => {
    for (const fn of ['_smartphone_recovery_split', '_smartphone_recovery_split_safe']) {
      for (const role of ['anon', 'authenticated']) {
        const r = await rows<{ ok: boolean }>(after, `select has_function_privilege($1, $2, 'EXECUTE') ok`, [role, `public.${fn}(uuid, numeric, date)`]);
        expect(r[0].ok, `${role} ${fn}`).toBe(false);
      }
    }
  });
});

/** What a run changed, without timestamps and ids, so the old and the new functions can be compared. */
async function effects(db: PGlite, since: string) {
  return {
    wallet: await rows(db, `select user_id, direction, category, amount, wallet_bucket, recipient_type, description, source_id
      from general_ledger where ledger_scope = 'wallet' and created_at >= $1 and description <> 'test seed' order by source_id, amount`, [since]),
    platform: await rows<{ source_id: string; category: string; direction: string; amount: string }>(db, `select source_id, category, direction, amount
      from general_ledger where ledger_scope = 'platform' and created_at >= $1 order by source_id, category`, [since]),
    plans: await rows(db, `select id, outstanding_balance, amount_recovered, due_balance, status, last_attempt_result, last_success_on,
      principal_recovered, fee_recovered from merchandise_recovery_plans order by id`),
    sales: await rows(db, `select id, amount_paid, amount_outstanding, payment_status from merchandise_sales order by id`),
    deductions: await rows(db, `select plan_id, customer_id, item_name, amount, withdrawable_before, outstanding_after
      from merchandise_recovery_deductions where created_at >= $1 order by plan_id, amount`, [since]),
    notifications: await rows(db, `select user_id, title, message, type, metadata - 'kampala_day' m from notifications where created_at >= $1 order by user_id`, [since]),
    events: await rows(db, `select event_type, user_id, metadata from system_events where created_at >= $1 order by user_id`, [since]),
    pledgeApps: await rows(db, `select user_id, plan_id, reference, roi_amount, pledged_amount, applied_amount, outstanding_after from smartphone_roi_pledge_applications order by reference`),
  };
}

describe('live recovery paths: same money, same rows, only the platform legs differ', () => {
  let old: Awaited<ReturnType<typeof effects>>; let neu: Awaited<ReturnType<typeof effects>>;
  beforeAll(async () => {
    const t0 = (await rows<{ t: string }>(before, `select now()::text t`))[0].t;
    const t1 = (await rows<{ t: string }>(after, `select now()::text t`))[0].t;
    for (const db of [before, after]) {
      // each customer has some money: some plans are collected in full, some partly, one not at all
      await db.exec(`update test_avail set amt = 0`);
      // production already collected today: put three days back in arrears, identically in both databases
      await db.exec(`update merchandise_recovery_plans set due_accrued_through = coalesce(due_accrued_through, starts_on) - 3`);
      const amts = [100_000, 2_500, 900, 40_000, 7_777, 15_000, 0, 60_000];
      const cust = [...new Set(FIX.plans.map((p) => p.customer_id))].sort();
      for (const [i, c] of cust.entries()) await db.query(`update test_avail set amt = $2 where user_id = $1`, [c, amts[i % amts.length]]);
      await db.query(`select public.recover_smartphone_from_wallets()`);
      // the monthly Returns pledge of the one production pledge holder
      await db.query(`update test_avail set amt = 30000 where user_id = $1`, [FIX.pledges[0].user_id]);
      await db.query(`select public.apply_smartphone_roi_pledge($1, 25000, 'TEST-ROI-1')`, [FIX.pledges[0].user_id]);
    }
    old = await effects(before, t0);
    neu = await effects(after, t1);
  }, 120_000);

  it('collects something (the comparison is not empty)', () => {
    expect(old.deductions.length).toBeGreaterThan(3);
    expect(old.pledgeApps.length).toBe(1);
  });
  it('takes the same money from the same wallets with the same wallet legs', () => {
    expect(neu.wallet).toEqual(old.wallet);
  });
  it('changes plans, sales, deductions, notifications, events and pledge applications identically', () => {
    expect(neu.plans).toEqual(old.plans);
    expect(neu.sales).toEqual(old.sales);
    expect(neu.deductions).toEqual(old.deductions);
    expect(neu.notifications).toEqual(old.notifications);
    expect(neu.events).toEqual(old.events);
    expect(neu.pledgeApps).toEqual(old.pledgeApps);
  });
  it('Money received report: same total; the charge shows under Revenue Collected instead of Agent Products', async () => {
    const ro = await received(before); const rn = await received(after);
    const tot = (r: typeof ro) => Object.values(r.totals).reduce((a, b) => a + b, 0);
    const charges = neu.platform.filter((l) => l.category === 'access_fee_collected').reduce((a, l) => a + num(l.amount), 0);
    expect(charges).toBeGreaterThan(0);
    expect(tot(rn)).toBe(tot(ro));
    expect(rn.totals.agent).toBe(ro.totals.agent - charges);
    expect(rn.totals.fees).toBe(ro.totals.fees + charges);
    expect(rn.products.smartphone).toBe(ro.products.smartphone - charges);
    expect(rn.rows).toBe(ro.rows + neu.platform.filter((l) => l.category === 'access_fee_collected').length); // one charge row per collection
  });
  it('old: every recovery to A10; new: none to A10, principal + charge = amount per plan', () => {
    expect(old.platform.every((l) => l.category === 'agent_advance_repayment')).toBe(true);
    expect(neu.platform.some((l) => l.category === 'agent_advance_repayment')).toBe(false);
    const by = (xs: typeof old.platform, cat?: string) => {
      const m = new Map<string, number>();
      for (const l of xs) if (!cat || l.category === cat) m.set(l.source_id, (m.get(l.source_id) ?? 0) + num(l.amount));
      return m;
    };
    const oldAmt = by(old.platform);
    const newAmt = by(neu.platform);
    expect([...newAmt.entries()].sort()).toEqual([...oldAmt.entries()].sort());
    const charge = by(neu.platform, 'access_fee_collected');
    expect([...charge.values()].some((v) => v > 0)).toBe(true);
    expect(neu.platform.every((l) => l.direction === 'cash_in')).toBe(true);
  });
});

describe('a plan paid off recognises exactly its principal and its charges', () => {
  it('in one payment and in many', async () => {
    for (const steps of [1, 7]) {
      const db = await build();
      await db.exec(MIGRATION);
      const plan = FIX.plans.find((p) => p.id.startsWith('9feb42a7'))!; // 1,500,000 + 2,730,000 charges, stored 12-month schedule
      const { rows: sch } = scheduleFor(plan);
      const P = sum(sch.map((r) => r.p)); const C = sum(sch.map((r) => r.c));
      // only this plan collects; nothing due-limited: a big due, a big daily cap
      await db.exec(`update merchandise_recovery_plans set phone_collection_enabled = (id = '${plan.id}'), due_balance = 1e12, daily_deduction_amount = 1e12`);
      const out = num((await rows<{ o: string }>(db, `select outstanding_balance o from merchandise_recovery_plans where id = $1`, [plan.id]))[0].o);
      const chunk = Math.ceil(out / steps);
      for (let i = 0; i < steps; i++) {
        await db.query(`update test_avail set amt = $2 where user_id = $1`, [plan.customer_id, chunk]);
        await db.query(`select public.recover_smartphone_from_wallets()`);
        // free the daily room for the next "day" and give the next run a new idempotency minute
        await db.exec(`update merchandise_recovery_deductions set created_at = created_at - interval '2 days'`);
        // test-only (production never edits the ledger): the job keys by the minute; make room for the next run's key
        await db.exec(`update general_ledger set idempotency_key = idempotency_key || ':${i}' where idempotency_key like 'phone_recover_v2_%' and idempotency_key not like '%:%'`);
      }
      const st = (await rows<{ o: string; s: string }>(db, `select outstanding_balance o, status s from merchandise_recovery_plans where id = $1`, [plan.id]))[0];
      expect([num(st.o), st.s]).toEqual([0, 'completed']);
      const t = (await rows<{ p: string; c: string; a: string }>(db, `
        select coalesce(sum(case when direction = 'cash_in' then amount else -amount end) filter (where category = 'merchandise_recovery_repayment'), 0) p,
               coalesce(sum(case when direction = 'cash_in' then amount else -amount end) filter (where category = 'access_fee_collected'), 0) c,
               coalesce(sum(case when direction = 'cash_out' then amount else -amount end) filter (where category = 'agent_advance_repayment'), 0) a
        from general_ledger where ledger_scope = 'platform' and source_id = $1`, [plan.id]))[0];
      // historical A10 recoveries were reclassified; with them the plan's whole principal and charges are recognised
      expect(num(t.a), `A10 ${steps}`).toBe(0);
      expect(num(t.p), `principal ${steps}`).toBe(P);
      expect(num(t.c), `charges ${steps}`).toBe(C);
      await db.close();
    }
  }, 480_000);
});

describe('a split that cannot be worked out never stops a collection', () => {
  it('posts the whole amount as principal (A12) and collects as before', async () => {
    const db = await build();
    await db.exec(MIGRATION);
    const plan = FIX.plans.find((p) => p.id.startsWith('1cab4fe8'))!;
    await db.exec(`update merchandise_recovery_plans set phone_collection_enabled = (id = '${plan.id}')`);
    // break the split for this plan only: an inconsistent schedule source makes the helper raise
    await db.exec(`create or replace function public._smartphone_recovery_split(p_plan_id uuid, p_amount numeric, p_on date)
      returns jsonb language plpgsql stable set search_path to 'public' as $f$ begin raise exception 'broken'; end $f$`);
    await db.query(`update test_avail set amt = 50000 where user_id = $1`, [plan.customer_id]);
    const r = await rows<{ j: { plans_collected: number } }>(db, `select public.recover_smartphone_from_wallets() j`);
    expect(r[0].j.plans_collected).toBe(1);
    const legs = await rows<{ category: string }>(db, `select category from general_ledger where ledger_scope = 'platform' and source_id = $1 and idempotency_key like 'phone_recover_v2_%' and created_at > now() - interval '1 minute'`, [plan.id]);
    expect(legs.map((l) => l.category)).toEqual(['merchandise_recovery_repayment']);
    await db.close();
  }, 240_000);
});

describe('rollback', () => {
  it('restores the production functions; the reclassification entries stay', async () => {
    const db = await build();
    await db.exec(MIGRATION);
    const n = num((await rows<{ n: string }>(db, `select count(*) n from general_ledger where idempotency_key like 'smartphone_a10_to_a12_reclass:%'`))[0].n);
    await db.exec(ROLLBACK);
    expect(await fnMd5(db, 'public.recover_smartphone_from_wallets()')).toBe(PROD_MD5['public.recover_smartphone_from_wallets()']);
    expect(await fnMd5(db, 'public.apply_smartphone_roi_pledge(uuid, numeric, text)')).toBe(PROD_MD5['public.apply_smartphone_roi_pledge(uuid, numeric, text)']);
    expect(await fnMd5(db, 'public._smartphone_recovery_split(uuid, numeric, date)')).toBeNull();
    for (const sig of REPORT_SIGS) expect(await fnMd5(db, sig), sig).toBe(PROD_MD5[sig]);
    expect(num((await rows<{ n: string }>(db, `select count(*) n from general_ledger where idempotency_key like 'smartphone_a10_to_a12_reclass:%'`))[0].n)).toBe(n);
    await db.close();
  }, 240_000);
});
