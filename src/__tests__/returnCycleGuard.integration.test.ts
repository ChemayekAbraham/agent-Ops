import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { reserveReturnCycle } from '../../supabase/functions/_shared/returnCycleGuard';

/**
 * Partner Return duplicate-payment guard — real database, real concurrent sessions.
 * Migration: supabase/migrations/20261024140000_return_cycle_guard.sql
 *
 * LOCAL THROWAWAY DATABASE ONLY. The gate below refuses to connect unless ALL of these hold:
 *   RETURN_CYCLE_DB_URL points at localhost / 127.0.0.1 / ::1
 *   the database name starts with "rcg_test"
 *   RETURN_CYCLE_TEST_ISOLATED_DB=1
 *   the database is EMPTY (no public.investor_portfolios) before the suite builds its own stand-in schema
 * It never calls a payment service. "Posting" here writes rows to the throwaway database's own stand-in ledger
 * (supabase/tests/return_cycle_guard/00_stub_schema.sql) so the suite can prove how many times money WOULD move.
 * The override tests stop at the reservation: no Return is ever posted under an override.
 *
 * Without the env vars every test skips; `npm run test:return-cycle-db` sets RETURN_CYCLE_DB_TESTS_REQUIRED=1 so a
 * closed gate fails instead of passing silently.
 *
 * Start state = production on 2026-10-24: the suite loads the verbatim production bodies of the two functions the
 * migration replaces (from the rollback file), seeds history under the OLD key scheme, then applies the migration
 * with its production-only precondition block removed (that block pins production function fingerprints, checked
 * separately below).
 */

const ROOT = resolve(__dirname, '..', '..');
const MIGRATION = readFileSync(resolve(ROOT, 'supabase/migrations/20261024140000_return_cycle_guard.sql'), 'utf8').replace(/\r\n/g, '\n');
const ROLLBACK = readFileSync(resolve(ROOT, 'supabase/rollbacks/20261024140000_return_cycle_guard.rollback.sql'), 'utf8').replace(/\r\n/g, '\n');
const STUB = readFileSync(resolve(ROOT, 'supabase/tests/return_cycle_guard/00_stub_schema.sql'), 'utf8').replace(/\r\n/g, '\n');
// The two production function bodies (2026-10-24) exactly as the rollback restores them.
const PROD_FUNCTIONS = ROLLBACK.slice(
  ROLLBACK.indexOf('CREATE OR REPLACE FUNCTION public.enforce_roi_cycle_once()'),
  ROLLBACK.indexOf('DROP FUNCTION IF EXISTS public.post_portfolio_roi_ledger(text, uuid, numeric, text, text, text, date, uuid);'));

const URL_ENV = process.env.RETURN_CYCLE_DB_URL ?? '';
const REQUIRED = process.env.RETURN_CYCLE_DB_TESTS_REQUIRED === '1';

function gateReason(): string | null {
  if (!URL_ENV) return 'RETURN_CYCLE_DB_URL is not set';
  if (process.env.RETURN_CYCLE_TEST_ISOLATED_DB !== '1') return 'RETURN_CYCLE_TEST_ISOLATED_DB=1 is not set';
  let u: URL;
  try { u = new URL(URL_ENV); } catch { return 'RETURN_CYCLE_DB_URL is not a URL'; }
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname)) return `host ${u.hostname} is not local`;
  if (!u.pathname.replace(/^\//, '').startsWith('rcg_test')) return 'database name must start with rcg_test';
  return null;
}
const closed = gateReason();
if (closed && REQUIRED) throw new Error(`Return cycle DB tests required but gate closed: ${closed}`);
const d = closed ? describe.skip : describe;

type Sql = ReturnType<typeof postgres>;
let c1: Sql; let c2: Sql;

const ID = (n: number) => `0c0c0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CFO = ID(1), COO = ID(2), COO2 = ID(3), CFO2 = ID(4), PROXY = ID(5);
const PARTNER = (n: number) => ID(100 + n);
const PF = (n: number) => ID(200 + n);

let today = '';      // Kampala date in the database
let m1 = '';         // first day of last month
let m2 = '';         // first day of the month before

const addDays = (date: string, n: number) => { const t = new Date(`${date}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const day = (monthStart: string, dayOfMonth: number) => addDays(monthStart, dayOfMonth - 1);

async function asUser<T>(sql: Sql, uid: string | null, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    if (uid) await tx`select set_config('request.jwt.claim.sub', ${uid}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

async function errorOf(p: Promise<unknown>): Promise<{ code?: string; message: string } | null> {
  try { await p; return null; } catch (e) { const err = e as { code?: string; message: string }; return { code: err.code, message: err.message }; }
}

let refSeq = 0;
const ref = (prefix = 'PAY') => `${prefix}-T${Date.now().toString(36).toUpperCase()}${(refSeq++).toString(36).toUpperCase()}-AB12`;

/** A COO request for a portfolio Return payout (what COOPartnersPage.handlePay inserts). */
async function requestPayout(sql: Sql, o: { pf: string; partner: string; amount: number; actor?: string; metadata?: Record<string, unknown>; reference?: string; opType?: string; description?: string }) {
  return asUser(sql, o.actor ?? COO, async (tx) => {
    const rows = await tx`
      insert into public.pending_wallet_operations (user_id, amount, direction, category, source_table, source_id, reference_id,
        operation_type, description, status, metadata)
      values (${o.partner}, ${o.amount}, 'cash_in', 'roi_payout', 'investor_portfolios', ${o.pf}, ${o.reference ?? ref()},
        ${o.opType ?? 'roi_wallet_credit'}, ${o.description ?? 'ROI payout. Reason: credit acc'}, 'pending_coo_approval',
        ${tx.json((o.metadata ?? {}) as never)})
      returning id, metadata`;
    return rows[0] as { id: string; metadata: Record<string, unknown> };
  });
}

/** Adapter so the edge function's own decision helper runs against this database. */
function rpcAdapter(sql: Sql) {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn !== 'claim_return_cycle_for_operation') throw new Error(`unexpected rpc ${fn}`);
      try {
        const rows = await sql`select public.claim_return_cycle_for_operation(p_operation_id => ${args.p_operation_id as string}) as r`;
        return { data: rows[0].r, error: null };
      } catch (e) {
        const err = e as { code?: string; message: string };
        return { data: null, error: { code: err.code, message: err.message } };
      }
    },
  };
}

/**
 * Mirrors approve-wallet-operation for a Return payout, in the isolated database: reserve (the edge function's own
 * helper), then post_return_payout - one transaction that posts under the reservation key, marks the request approved
 * and moves next_roi_date. Only inserted=true would let the edge function continue to any further money step.
 */
async function approve(sql: Sql, opId: string, amountOverride?: number) {
  // COO approval step first (the CFO approval only picks up 'pending' / 'coo_approved' requests).
  await sql`update public.pending_wallet_operations set status = 'coo_approved' where id = ${opId} and status = 'pending_coo_approval'`;
  const decision = await reserveReturnCycle(rpcAdapter(sql), opId);
  if (decision.action !== 'post') return decision;
  const [op] = await sql`select * from public.pending_wallet_operations where id = ${opId}`;
  const amount = amountOverride ?? Number(op.amount);
  const r = await postReturnPayout(sql, opId, decision.ledgerKey, amount);
  if (r.inserted !== true) return { action: 'not_inserted' as const, result: r };
  return decision;
}

function payoutEntries(op: Record<string, any>, amount: number) {
  const recipient = op.target_wallet_user_id ?? op.user_id;
  return [
    { user_id: recipient, amount, direction: 'cash_in', category: 'roi_wallet_credit', ledger_scope: 'wallet',
      source_table: 'investor_portfolios', source_id: op.source_id, reference_id: op.reference_id, linked_party: op.user_id,
      description: op.description },
    { user_id: op.user_id, amount, direction: 'cash_out', category: 'roi_expense', ledger_scope: 'platform',
      source_table: 'investor_portfolios', source_id: op.source_id, description: 'Platform contra for roi_payout' },
  ];
}

async function postReturnPayout(sql: Sql, opId: string, key: string, amount: number) {
  const [op] = await sql`select * from public.pending_wallet_operations where id = ${opId}`;
  const rows = await sql`select public.post_return_payout(${opId}::uuid, ${sql.json(payoutEntries(op, amount) as never)}::jsonb,
                                                          ${key}, ${amount}, ${CFO}::uuid) as r`;
  return rows[0].r as { inserted?: boolean; reason?: string };
}

async function walletOf(sql: Sql, uid: string): Promise<number> {
  const r = await sql`select coalesce((select withdrawable from public.wallets where user_id = ${uid}), 0) as w`;
  return Number(r[0].w);
}
async function returnLegs(sql: Sql, pf: string) {
  return sql`select category, amount, idempotency_key from public.general_ledger
              where source_id = ${pf} and direction = 'cash_in' and category in ('roi_wallet_credit', 'roi_reinvestment')
              order by created_at`;
}

async function compound(sql: Sql, o: { pf: string; amount: number; cycleDate: string | null; reference?: string; actor?: string; legacy?: boolean }) {
  return asUser(sql, o.actor ?? COO, async (tx) => o.legacy
    ? tx`select public.post_portfolio_roi_ledger('compound', ${o.pf}::uuid, ${o.amount}, ${o.reference ?? ref('CMP')}, 'out', 'in') as g`
    : tx`select public.post_portfolio_roi_ledger('compound', ${o.pf}::uuid, ${o.amount}, ${o.reference ?? ref('CMP')}, 'out', 'in', ${o.cycleDate}::date) as g`);
}

async function backendPid(sql: Sql): Promise<number> { return Number((await sql`select pg_backend_pid() as p`)[0].p); }
async function waitUntilBlocked(observer: Sql, pid: number) {
  for (let i = 0; i < 200; i++) {
    const r = await observer`select wait_event_type from pg_stat_activity where pid = ${pid}`;
    if (r[0]?.wait_event_type === 'Lock') return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`session ${pid} never blocked on a lock`);
}

d('Partner Return cycle guard (isolated local database)', () => {
  beforeAll(async () => {
    c1 = postgres(URL_ENV, { max: 1, onnotice: () => {} });
    c2 = postgres(URL_ENV, { max: 1, onnotice: () => {} });
    const [{ exists }] = await c1`select to_regclass('public.investor_portfolios') is not null as exists`;
    if (exists) throw new Error('Refusing to run: this database is not empty (public.investor_portfolios exists). Use a fresh rcg_test_* database.');

    await c1.unsafe(STUB);
    // Production state on 2026-10-24: the replaced functions' verbatim bodies, and the existing request trigger.
    await c1.unsafe(PROD_FUNCTIONS);
    await c1.unsafe('CREATE TRIGGER trg_enforce_roi_cycle_once BEFORE INSERT ON public.pending_wallet_operations FOR EACH ROW EXECUTE FUNCTION public.enforce_roi_cycle_once();');

    const [t] = await c1`select (now() at time zone 'Africa/Kampala')::date::text as today,
                         (date_trunc('month', (now() at time zone 'Africa/Kampala')::date) - interval '1 month')::date::text as m1,
                         (date_trunc('month', (now() at time zone 'Africa/Kampala')::date) - interval '2 months')::date::text as m2`;
    today = t.today; m1 = t.m1; m2 = t.m2;
    if (m2 < '2026-08-01') throw new Error(`Test clock too early (${today}): fixtures need two whole months after 2026-08`);

    await c1`insert into public.user_roles values (${CFO}, 'cfo', true), (${CFO2}, 'cfo', true), (${COO}, 'coo', true), (${COO2}, 'coo', true)`;
    for (let n = 1; n <= 50; n++) {
      await c1`insert into public.investor_portfolios (id, investor_id, portfolio_code, investment_amount, roi_percentage, next_roi_date, payout_day)
               values (${PF(n)}, ${PARTNER(n)}, ${'WIP-T' + n}, 1000000, 20, ${day(m1, 10)}, 10)`;
    }
    // History under the OLD key scheme (before the migration): portfolio 20 was paid for last month's cycle with
    // roi-cycle-<pf>-<date>; portfolio 21 likewise, but that payout was later reversed.
    for (const [n, cancelled] of [[20, false], [21, true]] as const) {
      const r = ref();
      await c1`select public.create_ledger_transaction(${c1.json([
        { user_id: PARTNER(n), amount: 200000, direction: 'cash_in', category: 'roi_wallet_credit', ledger_scope: 'wallet',
          source_table: 'investor_portfolios', source_id: PF(n), reference_id: r },
        { user_id: PARTNER(n), amount: 200000, direction: 'cash_out', category: 'roi_expense', ledger_scope: 'platform',
          source_table: 'investor_portfolios', source_id: PF(n) },
      ] as never)}::jsonb, ${`roi-cycle-${PF(n)}-${day(m1, 10)}`}, false)`;
      await c1`set session_replication_role = replica`;
      await c1`insert into public.pending_wallet_operations (user_id, amount, direction, category, source_table, source_id, reference_id, status, metadata)
               values (${PARTNER(n)}, 200000, 'cash_in', 'roi_payout', 'investor_portfolios', ${PF(n)}, ${r},
                       ${cancelled ? 'cancelled' : 'approved'}, ${c1.json((cancelled ? { reversed_at: '2026-10-01T00:00:00Z' } : {}) as never)})`;
      await c1`set session_replication_role = origin`;
    }
    // Returns posted before the migration with NO cycle key, in last month: a null-key reinvestment (portfolio 25)
    // and a compound under the old portfolio-roi-ledger:<ref> key (portfolio 26).
    for (const [n, key] of [[25, null], [26, `portfolio-roi-ledger:CMP-OLD${Date.now().toString(36).toUpperCase()}-AB12`]] as const) {
      await c1`select public.create_ledger_transaction(${c1.json([
        { user_id: PARTNER(n), amount: 200000, direction: 'cash_out', category: 'roi_expense', ledger_scope: 'platform',
          source_table: 'investor_portfolios', source_id: PF(n), transaction_date: `${day(m1, 12)}T09:00:00+03:00` },
        { user_id: PARTNER(n), amount: 200000, direction: 'cash_in', category: 'roi_reinvestment', ledger_scope: 'platform',
          source_table: 'investor_portfolios', source_id: PF(n), linked_party: COO, transaction_date: `${day(m1, 12)}T09:00:00+03:00` },
      ] as never)}::jsonb, ${key}, false)`;
    }
    // A compound for last month's cycle posted LATE, on the 2nd of this month, with no cycle key (portfolio 40).
    await c1`select public.create_ledger_transaction(${c1.json([
      { user_id: PARTNER(40), amount: 200000, direction: 'cash_out', category: 'roi_expense', ledger_scope: 'platform',
        source_table: 'investor_portfolios', source_id: PF(40), transaction_date: `${addDays(m1, 40).slice(0, 8)}02T09:00:00+03:00` },
      { user_id: PARTNER(40), amount: 200000, direction: 'cash_in', category: 'roi_reinvestment', ledger_scope: 'platform',
        source_table: 'investor_portfolios', source_id: PF(40), linked_party: COO, transaction_date: `${addDays(m1, 40).slice(0, 8)}02T09:00:00+03:00` },
    ] as never)}::jsonb, null, false)`;
    // A request queued before the migration (no reservation yet), for portfolio 22.
    await requestPayout(c1, { pf: PF(22), partner: PARTNER(22), amount: 200000 });

    await c1.unsafe(MIGRATION.replace(/DO \$pre\$[\s\S]*?\$pre\$;/, '-- precondition removed for the isolated test database'));
  }, 120_000);

  afterAll(async () => { await c1?.end(); await c2?.end(); });

  it('starts from production: the rollback restores the exact bodies the migration precondition pins', async () => {
    const pinned = [...MIGRATION.matchAll(/IS DISTINCT FROM '([0-9a-f]{32})'/g)].map((m) => m[1]);
    expect(pinned).toContain('18ff622041302b9f25c9d174f8f819c5');
    expect(pinned).toContain('6313f826f8dc023c5b66a4c8bdcba6ff');
    const fresh = postgres(URL_ENV, { max: 1, onnotice: () => {} });
    try {
      await fresh.begin(async (tx) => {
        await tx.unsafe(ROLLBACK);
        const rows = await tx`select md5(replace(prosrc, chr(13), '')) as h from pg_proc
                               where oid in ('public.enforce_roi_cycle_once()'::regprocedure,
                                             'public.post_portfolio_roi_ledger(text,uuid,numeric,text,text,text)'::regprocedure)`;
        expect(rows.map((r) => r.h).sort()).toEqual(['18ff622041302b9f25c9d174f8f819c5', '6313f826f8dc023c5b66a4c8bdcba6ff']);
        await tx`select 1/0`; // roll the rollback back; this test only inspects
      }).catch((e) => { if (!/division by zero/.test(String(e))) throw e; });
    } finally { await fresh.end(); }
  });

  it('a normal payout reserves its month, posts once and moves the schedule', async () => {
    const op = await requestPayout(c1, { pf: PF(1), partner: PARTNER(1), amount: 200000 });
    expect(op.metadata.return_cycle_month).toBe(m1);
    const decision = await approve(c1, op.id);
    expect(decision.action).toBe('post');
    expect(await walletOf(c1, PARTNER(1))).toBe(200000);
    const legs = await returnLegs(c1, PF(1));
    expect(legs).toHaveLength(1);
    expect(legs[0].idempotency_key).toMatch(/^return-cycle:[0-9a-f-]{36}:cash$/);
  });

  it('refuses a second payout for the same month even after next_roi_date is edited (the 10 Sep / 11 Sep case)', async () => {
    const first = await requestPayout(c1, { pf: PF(2), partner: PARTNER(2), amount: 200000, description: 'PAYOUT....' });
    await approve(c1, first.id);
    // Staff move the date within the same month (and approval advanced it); request again with another description.
    await c1`update public.investor_portfolios set next_roi_date = ${day(m1, 11)} where id = ${PF(2)}`;
    const err = await errorOf(requestPayout(c1, { pf: PF(2), partner: PARTNER(2), amount: 200000, description: 'payout.....' }));
    expect(err?.code).toBe('23505');
    expect(err?.message).toMatch(/Duplicate Return blocked/);
    expect(await walletOf(c1, PARTNER(2))).toBe(200000);
    expect(await returnLegs(c1, PF(2))).toHaveLength(1);
  });

  it('refuses a second month reached by a date edit across the month boundary (too close to the paid cycle)', async () => {
    await c1`update public.investor_portfolios set next_roi_date = ${day(m1, 28)} where id = ${PF(3)}`;
    const first = await requestPayout(c1, { pf: PF(3), partner: PARTNER(3), amount: 200000 });
    await approve(c1, first.id);
    const nextMonthStart = addDays(day(m1, 1), 32).slice(0, 8) + '01';
    const err = await errorOf(requestPayout(c1, { pf: PF(3), partner: PARTNER(3), amount: 200000, metadata: { cycle_anchor: day(nextMonthStart, 2) } }));
    expect(err?.code).toBe('23514');
    expect(err?.message).toMatch(/too_close_to_another_cycle/);
    expect(await walletOf(c1, PARTNER(3))).toBe(200000);
  });

  it('retries: approving the same request twice posts once and reports the second as already posted', async () => {
    const op = await requestPayout(c1, { pf: PF(4), partner: PARTNER(4), amount: 200000 });
    const firstReservation = await c1`select public.claim_return_cycle_for_operation(${op.id}) as r`;
    const again = await c1`select public.claim_return_cycle_for_operation(${op.id}) as r`;
    expect(again[0].r.claim_id).toBe(firstReservation[0].r.claim_id);
    expect((await approve(c1, op.id)).action).toBe('post');
    // Reset the status the way a stuck retry might see it, and approve again.
    await c1`update public.pending_wallet_operations set status = 'coo_approved' where id = ${op.id}`;
    expect((await approve(c1, op.id)).action).toBe('already_posted');
    expect(await walletOf(c1, PARTNER(4))).toBe(200000);
    expect(await returnLegs(c1, PF(4))).toHaveLength(1);
  });

  it('concurrent requests for the same portfolio and month: exactly one wins, the other waits then is refused', async () => {
    const pid2 = await backendPid(c2);
    await c1`begin`;
    await c1`select set_config('request.jwt.claim.sub', ${COO}, true)`;
    await c1`insert into public.pending_wallet_operations (user_id, amount, direction, category, source_table, source_id, reference_id, operation_type, status)
             values (${PARTNER(5)}, 200000, 'cash_in', 'roi_payout', 'investor_portfolios', ${PF(5)}, ${ref()}, 'roi_wallet_credit', 'pending_coo_approval')`;
    const second = errorOf(requestPayout(c2, { pf: PF(5), partner: PARTNER(5), amount: 200000, actor: COO2 }));
    await waitUntilBlocked(c1, pid2);
    await c1`commit`;
    const err = await second;
    expect(err?.code).toBe('23505');
    const [{ n }] = await c1`select count(*)::int as n from public.portfolio_return_cycle_claims where portfolio_id = ${PF(5)} and status = 'active'`;
    expect(n).toBe(1);
  });

  it('concurrent requests: when the first rolls back, the waiting one goes through (no false block)', async () => {
    const pid2 = await backendPid(c2);
    await c1`begin`;
    await c1`select set_config('request.jwt.claim.sub', ${COO}, true)`;
    await c1`insert into public.pending_wallet_operations (user_id, amount, direction, category, source_table, source_id, reference_id, operation_type, status)
             values (${PARTNER(6)}, 200000, 'cash_in', 'roi_payout', 'investor_portfolios', ${PF(6)}, ${ref()}, 'roi_wallet_credit', 'pending_coo_approval')`;
    const second = requestPayout(c2, { pf: PF(6), partner: PARTNER(6), amount: 200000, actor: COO2 });
    await waitUntilBlocked(c1, pid2);
    await c1`rollback`;
    const op = await second;
    expect(op.metadata.return_cycle_claim_id).toBeTruthy();
  });

  it('concurrent approvals of two requests queued before the guard: exactly one is paid', async () => {
    // Two requests for one portfolio that predate the migration (inserted with triggers off, as the queue would hold them).
    await c1`set session_replication_role = replica`;
    const ops = await c1`insert into public.pending_wallet_operations (user_id, amount, direction, category, source_table, source_id, reference_id, operation_type, status)
                         values (${PARTNER(7)}, 200000, 'cash_in', 'roi_payout', 'investor_portfolios', ${PF(7)}, ${ref()}, 'roi_wallet_credit', 'coo_approved'),
                                (${PARTNER(7)}, 200000, 'cash_in', 'roi_payout', 'investor_portfolios', ${PF(7)}, ${ref()}, 'roi_wallet_credit', 'coo_approved')
                         returning id`;
    await c1`set session_replication_role = origin`;
    const pid2 = await backendPid(c2);
    await c1`begin`;
    const r1 = await c1`select public.claim_return_cycle_for_operation(${ops[0].id}) as r`;
    const second = errorOf(c2`select public.claim_return_cycle_for_operation(${ops[1].id})`);
    await waitUntilBlocked(c1, pid2);
    await c1`commit`;
    expect(r1[0].r.applies).toBe(true);
    expect((await second)?.code).toBe('23505');
    expect((await approve(c1, ops[0].id)).action).toBe('post');
    // After the first is paid the schedule has moved on; the second must not be paid as next month's Return either.
    const second2 = await approve(c2, ops[1].id);
    expect(second2.action).toBe('blocked');
    if (second2.action === 'blocked') expect(second2.duplicate).toBe(true);
    expect(await walletOf(c1, PARTNER(7))).toBe(200000);
  });

  it('concurrent compounds of the same cycle with different references: one reinvestment', async () => {
    const pid2 = await backendPid(c2);
    await c1`begin`;
    await c1`select set_config('request.jwt.claim.sub', ${COO}, true)`;
    await c1`select public.post_portfolio_roi_ledger('compound', ${PF(8)}::uuid, 200000, ${ref('CMP')}, 'out', 'in', ${day(m1, 10)}::date)`;
    const second = errorOf(compound(c2, { pf: PF(8), amount: 200000, cycleDate: day(m1, 10), actor: COO2 }));
    await waitUntilBlocked(c1, pid2);
    await c1`commit`;
    expect((await second)?.code).toBe('23505');
    const legs = await returnLegs(c1, PF(8));
    expect(legs).toHaveLength(1);
    expect(legs[0].idempotency_key).toMatch(/:reinvest$/);
  });

  it('a compound and a cash payout cannot both take the same month; a compound retry with the same reference posts nothing new', async () => {
    const r = ref('CMP');
    await compound(c1, { pf: PF(9), amount: 200000, cycleDate: day(m1, 10), reference: r });
    await compound(c1, { pf: PF(9), amount: 200000, cycleDate: day(m1, 10), reference: r });
    expect(await returnLegs(c1, PF(9))).toHaveLength(1);
    const err = await errorOf(requestPayout(c1, { pf: PF(9), partner: PARTNER(9), amount: 200000, metadata: { cycle_anchor: day(m1, 10) } }));
    expect(err?.code).toBe('23505');
  });

  it('the screens published before this change still compound the right month (date already moved forward)', async () => {
    await c1`update public.investor_portfolios set next_roi_date = ${addDays(day(m1, 10), 31).slice(0, 8) + '10'} where id = ${PF(10)}`;
    await compound(c1, { pf: PF(10), amount: 200000, cycleDate: null, legacy: true });
    const [{ cycle_month }] = await c1`select cycle_month::text from public.portfolio_return_cycle_claims where portfolio_id = ${PF(10)}`;
    expect(cycle_month).toBe(m1);
    const [{ investment_amount }] = await c1`select investment_amount::int from public.investor_portfolios where id = ${PF(10)}`;
    expect(investment_amount).toBe(1000000); // those screens add the principal themselves; the wrapper must not add it again
  });

  it('valid separate cycles go through, including a later catch-up for a missed month that does not move the schedule', async () => {
    await c1`update public.investor_portfolios set next_roi_date = ${day(m1, 10)} where id = ${PF(11)}`;
    const current = await requestPayout(c1, { pf: PF(11), partner: PARTNER(11), amount: 200000 });
    expect((await approve(c1, current.id)).action).toBe('post');
    const [{ next_roi_date: afterCurrent }] = await c1`select next_roi_date::text from public.investor_portfolios where id = ${PF(11)}`;
    const catchUp = await requestPayout(c1, { pf: PF(11), partner: PARTNER(11), amount: 200000, metadata: { cycle_anchor: day(m2, 10) } });
    const decision = await approve(c1, catchUp.id);
    expect(decision.action).toBe('post');
    if (decision.action === 'post') expect(decision.reservation.advance_next_roi_date).toBe(false);
    const [{ next_roi_date: afterCatchUp }] = await c1`select next_roi_date::text from public.investor_portfolios where id = ${PF(11)}`;
    expect(afterCatchUp).toBe(afterCurrent);
    expect(await walletOf(c1, PARTNER(11))).toBe(400000);
    const months = await c1`select cycle_month::text from public.portfolio_return_cycle_claims where portfolio_id = ${PF(11)} order by cycle_month`;
    expect(months.map((m) => m.cycle_month)).toEqual([m2, m1]);
  });

  it('history under the old key scheme counts as paid, unless that payout was reversed', async () => {
    const paid = await errorOf(requestPayout(c1, { pf: PF(20), partner: PARTNER(20), amount: 200000, metadata: { cycle_anchor: day(m1, 12) } }));
    expect(paid?.code).toBe('23505');
    expect(paid?.message).toMatch(/already_paid/);
    const reversed = await requestPayout(c1, { pf: PF(21), partner: PARTNER(21), amount: 200000, metadata: { cycle_anchor: day(m1, 12) } });
    expect(reversed.metadata.return_cycle_month).toBe(m1);
  });

  it('a request queued before the guard is reserved at approval and paid once', async () => {
    const [op] = await c1`select id from public.pending_wallet_operations where source_id = ${PF(22)}`;
    expect((await approve(c1, op.id)).action).toBe('post');
    expect(await walletOf(c1, PARTNER(22))).toBe(200000);
  });

  it('split: the retained part reserves the month, its cash portion joins it, a second split or payout is refused', async () => {
    const r = ref('SPL');
    await asUser(c1, COO, (tx) => tx`select public.post_portfolio_roi_ledger('split_keep_returns', ${PF(12)}::uuid, 150000, ${r}, 'out', 'in', ${day(m1, 10)}::date)`);
    const cash = await requestPayout(c1, { pf: PF(12), partner: PARTNER(12), amount: 50000, reference: r, opType: 'roi_split_cash' });
    const claims = await c1`select id, kind from public.portfolio_return_cycle_claims where portfolio_id = ${PF(12)}`;
    expect(claims).toHaveLength(1);
    expect(cash.metadata.return_cycle_claim_id).toBe(claims[0].id);
    expect((await approve(c1, cash.id)).action).toBe('post');
    expect(await walletOf(c1, PARTNER(12))).toBe(200000);
    const [{ total_roi_earned: t12, investment_amount: p12 }] = await c1`select total_roi_earned::int, investment_amount::int from public.investor_portfolios where id = ${PF(12)}`;
    expect(t12).toBe(150000);
    expect(p12).toBe(1000000);
    expect((await errorOf(asUser(c1, COO, (tx) => tx`select public.post_portfolio_roi_ledger('split_keep_returns', ${PF(12)}::uuid, 150000, ${ref('SPL')}, 'out', 'in', ${day(m1, 10)}::date)`)))?.code).toBe('23505');
    expect((await errorOf(requestPayout(c1, { pf: PF(12), partner: PARTNER(12), amount: 200000, metadata: { cycle_anchor: day(m1, 10) } })))?.code).toBe('23505');
    // A cash portion that names no split of its own is refused.
    expect((await errorOf(requestPayout(c1, { pf: PF(13), partner: PARTNER(13), amount: 50000, reference: ref('SPL'), opType: 'roi_split_cash' })))?.code).toBe('23514');
  });

  it('keeps the one-open-request rule', async () => {
    await requestPayout(c1, { pf: PF(18), partner: PARTNER(18), amount: 200000 });
    const err = await errorOf(requestPayout(c1, { pf: PF(18), partner: PARTNER(18), amount: 200000, metadata: { cycle_anchor: day(m2, 10) } }));
    expect(err?.message).toMatch(/already has a Return payout awaiting approval/);
  });

  it('ledger backstop: a portfolio Return without a valid reservation key is refused; other Returns are untouched', async () => {
    const leg = (pf: string, extra: Record<string, unknown> = {}) => [
      { user_id: PARTNER(14), amount: 1000, direction: 'cash_in', category: 'roi_wallet_credit', ledger_scope: 'wallet', source_table: 'investor_portfolios', source_id: pf, ...extra },
    ];
    const post = (entries: unknown, key: string | null) => c1`select public.create_ledger_transaction(${c1.json(entries as never)}::jsonb, ${key}, false)`;
    expect((await errorOf(post(leg(PF(14)), null)))?.code).toBe('23514');
    expect((await errorOf(post(leg(PF(14)), `roi-cycle-${PF(14)}-${day(m1, 10)}`)))?.code).toBe('23514');
    // Portfolio 18 holds a reservation whose request is still awaiting approval (nothing posted under it yet).
    const [{ id: otherClaim }] = await c1`select id from public.portfolio_return_cycle_claims where portfolio_id = ${PF(18)} and status = 'active'`;
    expect((await errorOf(post(leg(PF(14)), `return-cycle:${otherClaim}:cash`)))?.code).toBe('23514'); // another portfolio's reservation
    expect((await errorOf(post(leg(PF(18)), `return-cycle:${otherClaim}:retained`)))?.code).toBe('23514'); // a payout has no retained part
    // A key already used posts nothing at all (create_ledger_transaction returns the existing group).
    const [{ id: paidClaim }] = await c1`select id from public.portfolio_return_cycle_claims where portfolio_id = ${PF(1)} and claim_seq = 0`;
    const before = await returnLegs(c1, PF(1));
    expect(await errorOf(post(leg(PF(1)), `return-cycle:${paidClaim}:cash`))).toBeNull();
    expect(await returnLegs(c1, PF(1))).toHaveLength(before.length);
    // A Return credit from any other source is refused (no verified source): a CFO direct credit, no source at all,
    // or a rent-reward reinvestment with no reinvested payment record.
    expect((await errorOf(post([{ user_id: PARTNER(14), amount: 1000, direction: 'cash_in', category: 'roi_wallet_credit', ledger_scope: 'wallet', source_table: 'cfo_direct_credit' }], null)))?.code).toBe('23514');
    expect((await errorOf(post([{ user_id: PARTNER(14), amount: 1000, direction: 'cash_in', category: 'roi_wallet_credit', ledger_scope: 'wallet' }], null)))?.code).toBe('23514');
    expect((await errorOf(post([{ user_id: PARTNER(14), amount: 1000, direction: 'cash_in', category: 'roi_reinvestment', ledger_scope: 'platform', source_table: 'investor_portfolios', source_id: PF(14), linked_party: 'platform' }], null)))?.code).toBe('23514');
    expect(await returnLegs(c1, PF(14))).toHaveLength(0);
  });

  it('compound: the posting and the portfolio change happen together, and a retry changes nothing', async () => {
    const r = ref('CMP');
    await compound(c1, { pf: PF(27), amount: 200000, cycleDate: day(m1, 10), reference: r });
    const after1 = (await c1`select investment_amount::int as p, next_roi_date::text as d from public.investor_portfolios where id = ${PF(27)}`)[0];
    expect(after1.p).toBe(1200000);
    expect(after1.d).toBe(addDays(m1, 40).slice(0, 8) + '10'); // one month on from the compounded cycle (the 10th)
    await compound(c1, { pf: PF(27), amount: 200000, cycleDate: day(m1, 10), reference: r }); // retry, same reference
    const after2 = (await c1`select investment_amount::int as p, next_roi_date::text as d from public.investor_portfolios where id = ${PF(27)}`)[0];
    expect(after2).toEqual(after1);
    expect(await returnLegs(c1, PF(27))).toHaveLength(1);
  });

  it('compound: if the posting fails, nothing is left behind (no principal change, no reservation)', async () => {
    const before = (await c1`select investment_amount::int as p, next_roi_date::text as d from public.investor_portfolios where id = ${PF(28)}`)[0];
    // More than one cycle of Returns: refused (at reservation), so the whole call rolls back.
    const big = await errorOf(compound(c1, { pf: PF(28), amount: 999999, cycleDate: day(m1, 10) }));
    expect(big?.code).toBe('23514');
    expect(big?.message).toMatch(/amount_above_cycle_return/);
    const after = (await c1`select investment_amount::int as p, next_roi_date::text as d from public.investor_portfolios where id = ${PF(28)}`)[0];
    expect(after).toEqual(before);
    expect((await c1`select count(*)::int as n from public.portfolio_return_cycle_claims where portfolio_id = ${PF(28)}`)[0].n).toBe(0);
    expect(await returnLegs(c1, PF(28))).toHaveLength(0);
  });

  it('a concurrent compound and payout request for the same month: exactly one wins', async () => {
    const pid2 = await backendPid(c2);
    await c1`begin`;
    await c1`select set_config('request.jwt.claim.sub', ${COO}, true)`;
    await c1`select public.post_portfolio_roi_ledger('compound', ${PF(29)}::uuid, 200000, ${ref('CMP')}, 'out', 'in', ${day(m1, 10)}::date)`;
    const second = errorOf(requestPayout(c2, { pf: PF(29), partner: PARTNER(29), amount: 200000, actor: COO2, metadata: { cycle_anchor: day(m1, 10) } }));
    await waitUntilBlocked(c1, pid2);
    await c1`commit`;
    expect((await second)?.code).toBe('23505');
    expect(await returnLegs(c1, PF(29))).toHaveLength(1);
    expect(await walletOf(c1, PARTNER(29))).toBe(0);
  });

  it('historical Returns without a cycle key block their posting month (records only read, never changed)', async () => {
    const before = await c1`select count(*)::int as n from public.general_ledger`;
    for (const n of [25, 26]) {
      const err = await errorOf(requestPayout(c1, { pf: PF(n), partner: PARTNER(n), amount: 200000, metadata: { cycle_anchor: day(m1, 10) } }));
      expect(err?.code).toBe('23514');
      expect(err?.message).toMatch(/unkeyed_return_this_or_next_month/);
      expect((await errorOf(compound(c1, { pf: PF(n), amount: 200000, cycleDate: day(m1, 10) })))?.message).toMatch(/unkeyed_return_this_or_next_month/);
    }
    // They also block the month BEFORE their posting month (a late payment for it) ...
    expect((await errorOf(requestPayout(c1, { pf: PF(25), partner: PARTNER(25), amount: 200000, metadata: { cycle_anchor: day(m2, 10) } })))?.message)
      .toMatch(/unkeyed_return_this_or_next_month/);
    // ... but not the following month.
    const other = await requestPayout(c1, { pf: PF(25), partner: PARTNER(25), amount: 200000, metadata: { cycle_anchor: today } });
    expect(other.metadata.return_cycle_month).toBe(today.slice(0, 8) + '01');
    const after = await c1`select count(*)::int as n from public.general_ledger`;
    expect(after[0].n).toBe(before[0].n);
  });

  it('a correction_key alone no longer bypasses the guard', async () => {
    const err = await errorOf(requestPayout(c1, { pf: PF(1), partner: PARTNER(1), amount: 200000, metadata: { correction_key: 'restore-sep' } }));
    expect(err?.code).toBe('42501');
    expect(err?.message).toMatch(/needs a CFO-authorised override/);
  });

  it('refuses a cycle more than 7 days ahead and a month before reliable history, without an override', async () => {
    const ahead = await errorOf(requestPayout(c1, { pf: PF(15), partner: PARTNER(15), amount: 200000, metadata: { cycle_anchor: addDays(today, 30) } }));
    expect(ahead?.code).toBe('23514');
    expect(ahead?.message).toMatch(/not_yet_due/);
    const old = await errorOf(requestPayout(c1, { pf: PF(15), partner: PARTNER(15), amount: 200000, metadata: { cycle_anchor: '2026-07-07' } }));
    expect(old?.message).toMatch(/before_reliable_history/);
    expect(await walletOf(c1, PARTNER(15))).toBe(0);
  });

  it('rejecting an unpaid request frees its month; cancelling a paid one keeps it unless the payout was reversed', async () => {
    const op = await requestPayout(c1, { pf: PF(16), partner: PARTNER(16), amount: 200000 });
    await c1`update public.pending_wallet_operations set status = 'rejected' where id = ${op.id}`;
    const again = await requestPayout(c1, { pf: PF(16), partner: PARTNER(16), amount: 200000 });
    await approve(c1, again.id);
    await c1`update public.pending_wallet_operations set status = 'cancelled' where id = ${again.id}`;
    const [{ status: kept }] = await c1`select status from public.portfolio_return_cycle_claims where pending_operation_id = ${again.id}`;
    expect(kept).toBe('active');

    const op2 = await requestPayout(c1, { pf: PF(17), partner: PARTNER(17), amount: 200000 });
    await approve(c1, op2.id);
    // reverse-proxy-roi-approval posts a mirror under reverse-roi-approval-<id>, then cancels the request.
    await c1`select public.create_ledger_transaction(${c1.json([
      { user_id: PARTNER(17), amount: 200000, direction: 'cash_out', category: 'system_balance_correction', ledger_scope: 'wallet', source_table: 'pending_wallet_operations', source_id: op2.id },
      { user_id: PARTNER(17), amount: 200000, direction: 'cash_in', category: 'system_balance_correction', ledger_scope: 'platform', source_table: 'pending_wallet_operations', source_id: op2.id },
    ] as never)}::jsonb, ${`reverse-roi-approval-${op2.id}`}, true)`;
    await c1`update public.pending_wallet_operations set status = 'cancelled' where id = ${op2.id}`;
    const [{ status: released }] = await c1`select status from public.portfolio_return_cycle_claims where pending_operation_id = ${op2.id}`;
    expect(released).toBe('released');
    // After a reversal the month may be paid again, once: net one Return.
    await c1`update public.investor_portfolios set next_roi_date = ${day(m1, 10)} where id = ${PF(17)}`;
    const repay = await requestPayout(c1, { pf: PF(17), partner: PARTNER(17), amount: 200000 });
    expect((await approve(c1, repay.id)).action).toBe('post');
    expect(await walletOf(c1, PARTNER(17))).toBe(200000);
    expect((await errorOf(requestPayout(c1, { pf: PF(17), partner: PARTNER(17), amount: 200000, metadata: { cycle_anchor: day(m1, 10) } })))?.code).toBe('23505');
  });

  it('a Partner Return payout request must name its portfolio', async () => {
    const err = await errorOf(asUser(c1, COO, (tx) => tx`
      insert into public.pending_wallet_operations (user_id, amount, direction, category, source_table, source_id, reference_id, status)
      values (${PARTNER(24)}, 200000, 'cash_in', 'roi_payout', 'cfo_direct_credit', null, ${ref()}, 'pending_coo_approval')`));
    expect(err?.code).toBe('23514');
    expect(err?.message).toMatch(/must name its portfolio/);
  });

  it('a split that reinvests: the reinvested part and the cash portion share one month', async () => {
    const r = ref('SPL');
    await asUser(c1, COO, (tx) => tx`select public.post_portfolio_roi_ledger('split_reinvest', ${PF(23)}::uuid, 120000, ${r}, 'out', 'in', ${day(m1, 10)}::date)`);
    const cash = await requestPayout(c1, { pf: PF(23), partner: PARTNER(23), amount: 80000, reference: r, opType: 'roi_split_cash' });
    expect((await approve(c1, cash.id)).action).toBe('post');
    const legs = await returnLegs(c1, PF(23));
    expect(legs.map((l) => l.idempotency_key.split(':')[2]).sort()).toEqual(['cash', 'reinvest']);
    expect(await walletOf(c1, PARTNER(23))).toBe(80000);
    const [{ investment_amount: p23 }] = await c1`select investment_amount::int from public.investor_portfolios where id = ${PF(23)}`;
    expect(p23).toBe(1120000);
    expect((await errorOf(compound(c1, { pf: PF(23), amount: 200000, cycleDate: day(m1, 10) })))?.code).toBe('23505');
  });

  describe('CFO override (authorises only; no Return is posted under it in these tests)', () => {
    const authorise = (uid: string, pf: string, cycle: string, reason: string, requester: string = COO, max = 200000) =>
      asUser(c1, uid, (tx) => tx`select public.authorise_return_cycle_override(${pf}::uuid, ${cycle}::date, ${requester}::uuid, ${max}, ${reason}) as id`).then((r) => r[0].id as string);
    const REASON = 'Supporter was underpaid in the cycle; extra Return approved by CFO';

    it('only the CFO approver can authorise, with a reason of 20+ characters; authorising moves no money', async () => {
      expect((await errorOf(authorise(COO, PF(1), day(m1, 10), REASON)))?.code).toBe('42501');
      expect((await errorOf(authorise(CFO, PF(1), day(m1, 10), 'too short')))?.code).toBe('22023');
      const before = await c1`select count(*)::int as n, coalesce(sum(withdrawable), 0)::numeric as w from public.general_ledger, public.wallets`;
      const id = await authorise(CFO, PF(1), day(m1, 10), REASON);
      const after = await c1`select count(*)::int as n, coalesce(sum(withdrawable), 0)::numeric as w from public.general_ledger, public.wallets`;
      expect(after[0]).toEqual(before[0]);
      const audit = await c1`select action_type, reason from public.audit_logs where record_id = ${id}`;
      expect(audit[0].action_type).toBe('return_cycle_override_authorised');
      expect(audit[0].reason).toBe(REASON);
    });

    it('lets a different person reserve one extra request for that portfolio and month, once', async () => {
      const id = await authorise(CFO, PF(1), day(m1, 10), REASON);
      expect((await errorOf(requestPayout(c1, { pf: PF(1), partner: PARTNER(1), amount: 200000, actor: CFO, metadata: { cycle_anchor: day(m1, 10), override_id: id } })))?.code).toBe('42501');
      const op = await requestPayout(c1, { pf: PF(1), partner: PARTNER(1), amount: 200000, actor: COO, metadata: { cycle_anchor: day(m1, 10), override_id: id } });
      const [claim] = await c1`select claim_seq, override_id from public.portfolio_return_cycle_claims where id = ${op.metadata.return_cycle_claim_id as string}`;
      expect(claim.claim_seq).toBe(1);
      expect(claim.override_id).toBe(id);
      expect((await c1`select action_type from public.audit_logs where action_type = 'return_cycle_override_used' and record_id = ${op.metadata.return_cycle_claim_id as string}`)).toHaveLength(1);
      // Used once: a second request with the same override is refused.
      await c1`update public.pending_wallet_operations set status = 'rejected' where id = ${op.id}`;
      expect((await errorOf(requestPayout(c1, { pf: PF(1), partner: PARTNER(1), amount: 200000, actor: COO2, metadata: { cycle_anchor: day(m1, 10), override_id: id } })))?.code).toBe('42501');
      // Nothing was posted under the override.
      expect(await walletOf(c1, PARTNER(1))).toBe(200000);
    });

    it('names one requester: not the authoriser, must be Returns staff, and nobody else can use it', async () => {
      expect((await errorOf(authorise(CFO, PF(30), day(m1, 10), REASON, CFO)))?.code).toBe('42501');          // self
      expect((await errorOf(authorise(CFO, PF(30), day(m1, 10), REASON, PARTNER(30))))?.code).toBe('42501'); // not staff
      await requestPayout(c1, { pf: PF(30), partner: PARTNER(30), amount: 200000 });
      await c1`update public.pending_wallet_operations set status = 'approved' where source_id = ${PF(30)}`;
      const id = await authorise(CFO, PF(30), day(m1, 10), REASON, COO);
      // Another staff member (COO2) cannot use COO's override.
      expect((await errorOf(requestPayout(c1, { pf: PF(30), partner: PARTNER(30), amount: 200000, actor: COO2, metadata: { cycle_anchor: day(m1, 10), override_id: id } })))?.message)
        .toMatch(/authorised for another requester/);
      const [{ consumed_at }] = await c1`select consumed_at from public.portfolio_return_cycle_overrides where id = ${id}`;
      expect(consumed_at).toBeNull();
      // An override can never be used at approval (only when the request is made).
      await c1`set session_replication_role = replica`;
      const [legacy] = await c1`insert into public.pending_wallet_operations (user_id, amount, direction, category, source_table, source_id, reference_id, status, metadata)
        values (${PARTNER(30)}, 200000, 'cash_in', 'roi_payout', 'investor_portfolios', ${PF(30)}, ${ref()}, 'coo_approved', ${c1.json({ cycle_anchor: day(m1, 10), override_id: id } as never)}) returning id`;
      await c1`set session_replication_role = origin`;
      const decision = await approve(c1, legacy.id);
      expect(decision.action).toBe('blocked');
      expect(await walletOf(c1, PARTNER(30))).toBe(0);
    });

    it('refuses an override for another month, an expired or revoked one, and one that is not needed', async () => {
      const wrongMonth = await authorise(CFO, PF(2), day(m2, 10), REASON);
      expect((await errorOf(requestPayout(c1, { pf: PF(2), partner: PARTNER(2), amount: 200000, metadata: { cycle_anchor: day(m1, 10), override_id: wrongMonth } })))?.code).toBe('42501');

      const expired = await authorise(CFO, PF(2), day(m1, 10), REASON);
      await c1`update public.portfolio_return_cycle_overrides set expires_at = now() - interval '1 minute' where id = ${expired}`;
      expect((await errorOf(requestPayout(c1, { pf: PF(2), partner: PARTNER(2), amount: 200000, metadata: { cycle_anchor: day(m1, 10), override_id: expired } })))?.message).toMatch(/expired/);

      const revoked = await authorise(CFO, PF(2), day(m1, 10), REASON);
      expect((await errorOf(asUser(c1, COO, (tx) => tx`select public.revoke_return_cycle_override(${revoked}::uuid, 'not needed')`)))?.code).toBe('42501');
      await asUser(c1, CFO2, (tx) => tx`select public.revoke_return_cycle_override(${revoked}::uuid, 'not needed')`);
      expect((await errorOf(requestPayout(c1, { pf: PF(2), partner: PARTNER(2), amount: 200000, metadata: { cycle_anchor: day(m1, 10), override_id: revoked } })))?.message).toMatch(/revoked/);

      const unneeded = await authorise(CFO, PF(19), day(m1, 10), REASON);
      expect((await errorOf(requestPayout(c1, { pf: PF(19), partner: PARTNER(19), amount: 200000, metadata: { cycle_anchor: day(m1, 10), override_id: unneeded } })))?.message).toMatch(/No override is needed/);
      const [{ consumed_at }] = await c1`select consumed_at from public.portfolio_return_cycle_overrides where id = ${unneeded}`;
      expect(consumed_at).toBeNull();
    });
  });

  describe('independent-review findings (regressions)', () => {
    it('F1: two approvals of the SAME request at once - one posts, the other posts nothing and continues nowhere', async () => {
      const op = await requestPayout(c1, { pf: PF(33), partner: PARTNER(33), amount: 200000 });
      await c1`update public.pending_wallet_operations set status = 'coo_approved' where id = ${op.id}`;
      const d1 = await reserveReturnCycle(rpcAdapter(c1), op.id);
      const d2 = await reserveReturnCycle(rpcAdapter(c2), op.id);       // both pass the early check
      if (d1.action !== 'post' || d2.action !== 'post') throw new Error('expected both to reach posting');
      expect(d1.ledgerKey).toBe(d2.ledgerKey);
      const pid2 = await backendPid(c2);
      await c1`begin`;
      const first = await postReturnPayout(c1, op.id, d1.ledgerKey, 200000);   // holds the request row lock
      const second = postReturnPayout(c2, op.id, d2.ledgerKey, 200000);
      await waitUntilBlocked(c1, pid2);
      await c1`commit`;
      expect(first.inserted).toBe(true);
      expect(await second).toMatchObject({ inserted: false, reason: 'not_awaiting_approval' });
      expect(await walletOf(c1, PARTNER(33))).toBe(200000);
      expect(await returnLegs(c1, PF(33))).toHaveLength(1);
      // next_roi_date moved once, by the call that posted
      const [{ d }] = await c1`select next_roi_date::text as d from public.investor_portfolios where id = ${PF(33)}`;
      expect(d).toBe(addDays(m1, 40).slice(0, 8) + '10');
      const [{ status }] = await c1`select status from public.pending_wallet_operations where id = ${op.id}`;
      expect(status).toBe('approved');
    });

    it('F1: a retry after success posts nothing; an approval above one cycle\'s Return is refused', async () => {
      const op = await requestPayout(c1, { pf: PF(34), partner: PARTNER(34), amount: 200000 });
      await c1`update public.pending_wallet_operations set status = 'coo_approved' where id = ${op.id}`;
      const d = await reserveReturnCycle(rpcAdapter(c1), op.id);
      if (d.action !== 'post') throw new Error('expected post');
      expect((await errorOf(postReturnPayout(c1, op.id, d.ledgerKey, 250000)))?.code).toBe('23514'); // CFO amount above cap
      expect(await walletOf(c1, PARTNER(34))).toBe(0);
      expect((await postReturnPayout(c1, op.id, d.ledgerKey, 200000)).inserted).toBe(true);
      expect(await postReturnPayout(c1, op.id, d.ledgerKey, 200000)).toMatchObject({ inserted: false });
      expect(await walletOf(c1, PARTNER(34))).toBe(200000);
    });

    it('F2: an old browser tab cannot change principal, next date or total Returns; explicit edits and server postings still can', async () => {
      const asClient = (fn: (tx: postgres.TransactionSql) => Promise<unknown>) => c1.begin(async (tx) => {
        await tx`select set_config('request.jwt.claim.sub', ${COO}, true)`;
        await tx.unsafe('SET LOCAL ROLE authenticated');
        return fn(tx);
      });
      const read = async () => (await c1`select investment_amount::int as p, next_roi_date::text as d, total_roi_earned::int as t
                                          from public.investor_portfolios where id = ${PF(35)}`)[0];
      const before = await read();
      // old compound: principal + date in one client update -> refused, nothing changes
      expect((await errorOf(asClient((tx) => tx`update public.investor_portfolios set investment_amount = investment_amount + 200000,
                                                  next_roi_date = (next_roi_date + interval '1 month')::date where id = ${PF(35)}`)))?.code).toBe('42501');
      // old split: principal alone, or total Returns alone -> refused
      expect((await errorOf(asClient((tx) => tx`update public.investor_portfolios set investment_amount = investment_amount + 50000 where id = ${PF(35)}`)))?.code).toBe('42501');
      expect((await errorOf(asClient((tx) => tx`update public.investor_portfolios set total_roi_earned = coalesce(total_roi_earned, 0) + 50000 where id = ${PF(35)}`)))?.code).toBe('42501');
      expect(await read()).toEqual(before);
      // a date-only edit (payout day / next date management) is still allowed
      await asClient((tx) => tx`update public.investor_portfolios set next_roi_date = next_roi_date where id = ${PF(35)}`);
      // the updated compound screen goes through the RPC, which changes principal and date server-side
      await asClient((tx) => tx`select public.post_portfolio_roi_ledger('compound', ${PF(35)}::uuid, 200000, ${ref('CMP')}, 'out', 'in', ${day(m1, 10)}::date)`);
      expect((await read()).p).toBe(1200000);
      // an explicit admin edit carries a new token and is accepted
      await asClient((tx) => tx`update public.investor_portfolios set investment_amount = 1300000, return_fields_edit_token = gen_random_uuid() where id = ${PF(35)}`);
      expect((await read()).p).toBe(1300000);
    });

    it('F3: the supporter_platform_rewards route is closed; only verified sources may credit a Return', async () => {
      expect((await errorOf(asUser(c1, COO, (tx) => tx`
        insert into public.pending_wallet_operations (user_id, amount, direction, category, source_table, source_id, reference_id, status)
        values (${PARTNER(36)}, 200000, 'cash_in', 'supporter_platform_rewards', 'supporter_roi_payments', gen_random_uuid(), ${ref()}, 'coo_approved')`)))?.message)
        .toMatch(/must name its portfolio/);
      // An old unlinked request already in the queue cannot be reserved or posted.
      await c1`set session_replication_role = replica`;
      const [old] = await c1`insert into public.pending_wallet_operations (user_id, amount, direction, category, source_table, source_id, reference_id, status)
                              values (${PARTNER(36)}, 200000, 'cash_in', 'supporter_platform_rewards', 'supporter_roi_payments', gen_random_uuid(), ${ref()}, 'coo_approved') returning id`;
      await c1`set session_replication_role = origin`;
      expect((await errorOf(c1`select public.claim_return_cycle_for_operation(${old.id})`))?.code).toBe('23514');
      // Rent-facilitation reward: allowed only against a paid payment row, and not more often than rows exist.
      const rr = ID(900); const sup = PARTNER(36);
      const credit = () => c1`select public.create_ledger_transaction(${c1.json([
        { user_id: sup, amount: 67500, direction: 'cash_in', category: 'roi_wallet_credit', ledger_scope: 'wallet', source_table: 'supporter_roi_payments', source_id: rr },
        { user_id: sup, amount: 67500, direction: 'cash_out', category: 'roi_expense', ledger_scope: 'platform', source_table: 'supporter_roi_payments', source_id: rr },
      ] as never)}::jsonb, null, false)`;
      expect((await errorOf(credit()))?.code).toBe('23514');                       // no payment row yet
      await c1`insert into public.supporter_roi_payments (rent_request_id, supporter_id, roi_amount, payment_number, status) values (${rr}, ${sup}, 67500, 1, 'paid')`;
      expect(await errorOf(credit())).toBeNull();                                 // one paid row -> one credit
      expect((await errorOf(credit()))?.code).toBe('23514');                       // a second credit for the same row
      // Self-managed partner cycle: its own key and amount only.
      const [cy] = await c1`insert into public.partner_self_payout_cycles (partner_id, total_amount) values (${sup}, 90000) returning id`;
      const psm = (key: string, amt: number) => c1`select public.create_ledger_transaction(${c1.json([
        { user_id: sup, amount: amt, direction: 'cash_in', category: 'roi_wallet_credit', ledger_scope: 'wallet', source_table: 'partner_self_payout_cycles', source_id: cy.id },
        { user_id: sup, amount: amt, direction: 'cash_out', category: 'roi_expense', ledger_scope: 'platform', source_table: 'partner_self_payout_cycles', source_id: cy.id },
      ] as never)}::jsonb, ${key}, false)`;
      expect((await errorOf(psm(`psm-payout-${cy.id}`, 95000)))?.code).toBe('23514');
      expect((await errorOf(psm('psm-payout-other', 90000)))?.code).toBe('23514');
      expect(await errorOf(psm(`psm-payout-${cy.id}`, 90000))).toBeNull();
    });

    it('F4: a split\'s parts together can never exceed one cycle\'s Return', async () => {
      const r = ref('SPL');
      await asUser(c1, COO, (tx) => tx`select public.post_portfolio_roi_ledger('split_keep_returns', ${PF(37)}::uuid, 150000, ${r}, 'out', 'in', ${day(m1, 10)}::date)`);
      expect((await errorOf(requestPayout(c1, { pf: PF(37), partner: PARTNER(37), amount: 100000, reference: r, opType: 'roi_split_cash' })))?.message)
        .toMatch(/Split total would exceed/);
      const ok = await requestPayout(c1, { pf: PF(37), partner: PARTNER(37), amount: 50000, reference: r, opType: 'roi_split_cash' });
      // Even if the approval is asked for more than the request (CFO amount edit), the cap holds.
      await c1`update public.pending_wallet_operations set status = 'coo_approved' where id = ${ok.id}`;
      const d = await reserveReturnCycle(rpcAdapter(c1), ok.id);
      if (d.action !== 'post') throw new Error('expected post');
      expect((await errorOf(postReturnPayout(c1, ok.id, d.ledgerKey, 100000)))?.code).toBe('23514');
      // And the ledger itself refuses an over-cap leg under the claim, whoever posts it.
      expect((await errorOf(c1`select public.create_ledger_transaction(${c1.json([
        { user_id: PARTNER(37), amount: 100000, direction: 'cash_in', category: 'roi_wallet_credit', ledger_scope: 'wallet', source_table: 'investor_portfolios', source_id: PF(37) },
      ] as never)}::jsonb, ${d.ledgerKey}, false)`))?.code).toBe('23514');
      expect((await postReturnPayout(c1, ok.id, d.ledgerKey, 50000)).inserted).toBe(true);
      expect(await walletOf(c1, PARTNER(37))).toBe(200000);
      // A split_reinvest part above one cycle is refused by the RPC.
      expect((await errorOf(asUser(c1, COO, (tx) => tx`select public.post_portfolio_roi_ledger('split_reinvest', ${PF(38)}::uuid, 250000, ${ref('SPL')}, 'out', 'in', ${day(m1, 10)}::date)`)))?.message).toMatch(/amount_above_cycle_return/);
    });

    it('F4: an amount above one cycle needs a bounded override (<= 2x), used by its named requester only', async () => {
      expect((await errorOf(requestPayout(c1, { pf: PF(39), partner: PARTNER(39), amount: 300000 })))?.message).toMatch(/amount_above_cycle_return/);
      const REASON = 'Restoration of an underpaid cycle approved by the CFO';
      expect((await errorOf(asUser(c1, CFO, (tx) => tx`select public.authorise_return_cycle_override(${PF(39)}::uuid, ${day(m1, 10)}::date, ${COO}::uuid, 450000, ${REASON})`)))?.code).toBe('22023');
      const [{ id }] = await asUser(c1, CFO, (tx) => tx`select public.authorise_return_cycle_override(${PF(39)}::uuid, ${day(m1, 10)}::date, ${COO}::uuid, 300000, ${REASON}) as id`);
      const op = await requestPayout(c1, { pf: PF(39), partner: PARTNER(39), amount: 300000, actor: COO, metadata: { cycle_anchor: day(m1, 10), override_id: id } });
      const [claim] = await c1`select cycle_return_cap::int as cap, override_id from public.portfolio_return_cycle_claims where id = ${op.metadata.return_cycle_claim_id as string}`;
      expect(claim).toEqual({ cap: 300000, override_id: id });
      expect(await walletOf(c1, PARTNER(39))).toBe(0); // nothing is posted under the override in this test
    });

    it('catch-up gap: a Return posted late (next month) without a cycle key still protects its own month', async () => {
      const err = await errorOf(requestPayout(c1, { pf: PF(40), partner: PARTNER(40), amount: 200000, metadata: { cycle_anchor: day(m1, 10) } }));
      expect(err?.code).toBe('23514');
      expect(err?.message).toMatch(/unkeyed_return_this_or_next_month/);
    });

    it('override identity: service-role metadata cannot stand in for the named requester', async () => {
      const [{ id }] = await asUser(c1, CFO, (tx) => tx`select public.authorise_return_cycle_override(${PF(41)}::uuid, ${day(m1, 10)}::date, ${COO}::uuid, 200000, 'Missed cycle evidenced by proxy statement') as id`);
      await requestPayout(c1, { pf: PF(41), partner: PARTNER(41), amount: 200000 });
      await c1`update public.pending_wallet_operations set status = 'approved' where source_id = ${PF(41)}`;
      // No signed-in user (service role), claiming to be the requester through metadata.
      const err = await errorOf(c1`insert into public.pending_wallet_operations (user_id, amount, direction, category, source_table, source_id, reference_id, operation_type, status, metadata)
        values (${PARTNER(41)}, 200000, 'cash_in', 'roi_payout', 'investor_portfolios', ${PF(41)}, ${ref()}, 'roi_wallet_credit', 'pending_coo_approval',
                ${c1.json({ cycle_anchor: day(m1, 10), override_id: id, initiated_by: COO } as never)})`);
      expect(err?.code).toBe('42501');
      const [{ consumed_at }] = await c1`select consumed_at from public.portfolio_return_cycle_overrides where id = ${id}`;
      expect(consumed_at).toBeNull();
    });

    it('rollback gap: after the rollback, a month paid while the guard was live still cannot be requested again', async () => {
      // Everything happens in one transaction that is rolled back; the insert is expected to be refused.
      const err = await errorOf(c1.begin(async (tx) => {
        await tx.unsafe(ROLLBACK);
        await tx`select set_config('request.jwt.claim.sub', ${COO}, true)`;
        await tx`insert into public.pending_wallet_operations (user_id, amount, direction, category, source_table, source_id, reference_id, operation_type, status, metadata)
          values (${PARTNER(1)}, 200000, 'cash_in', 'roi_payout', 'investor_portfolios', ${PF(1)}, ${ref()}, 'roi_wallet_credit', 'pending_coo_approval',
                  ${tx.json({ cycle_anchor: day(m1, 10) } as never)})`;
      }));
      expect(err?.code).toBe('23505');
      expect(err?.message).toMatch(/recorded while the cycle guard was live/);
      // The rollback above was itself rolled back: the guard is still installed.
      expect((await c1`select to_regprocedure('public.claim_return_cycle_for_operation(uuid)') is not null as ok`)[0].ok).toBe(true);
    });
  });

  it('grants: nothing new is callable by anon, and only service_role can fetch a posting key', async () => {
    const can = async (role: string, sig: string) => (await c1`select has_function_privilege(${role}, ${sig}, 'EXECUTE') as ok`)[0].ok as boolean;
    for (const sig of ['public._claim_return_cycle(uuid,date,text,text,text,uuid,uuid,uuid,numeric)', 'public.claim_return_cycle_for_operation(uuid)',
      'public.authorise_return_cycle_override(uuid,date,uuid,numeric,text)', 'public.post_portfolio_roi_ledger(text,uuid,numeric,text,text,text,date,uuid)',
      'public.post_return_payout(uuid,jsonb,text,numeric,uuid,text,text)',
      'public._post_portfolio_roi_ledger_core(text,uuid,numeric,text,text,text,date,uuid,boolean)']) {
      expect(await can('anon', sig)).toBe(false);
    }
    expect(await can('authenticated', 'public._claim_return_cycle(uuid,date,text,text,text,uuid,uuid,uuid,numeric)')).toBe(false);
    expect(await can('authenticated', 'public.claim_return_cycle_for_operation(uuid)')).toBe(false);
    expect(await can('service_role', 'public.claim_return_cycle_for_operation(uuid)')).toBe(true);
    expect(await can('authenticated', 'public.authorise_return_cycle_override(uuid,date,uuid,numeric,text)')).toBe(true);
    expect(await can('authenticated', 'public.post_return_payout(uuid,jsonb,text,numeric,uuid,text,text)')).toBe(false);
    expect(await can('service_role', 'public.post_return_payout(uuid,jsonb,text,numeric,uuid,text,text)')).toBe(true);
    expect(await can('authenticated', 'public._post_portfolio_roi_ledger_core(text,uuid,numeric,text,text,text,date,uuid,boolean)')).toBe(false);
    const tbl = async (role: string, priv: string) => (await c1`select has_table_privilege(${role}, 'public.portfolio_return_cycle_claims', ${priv}) as ok`)[0].ok as boolean;
    expect(await tbl('authenticated', 'SELECT')).toBe(true);
    expect(await tbl('authenticated', 'INSERT')).toBe(false);
    expect(await tbl('anon', 'SELECT')).toBe(false);
  });

  it('the rollback restores the production functions and removes the guard (tables kept for audit)', async () => {
    await c1.begin(async (tx) => {
      await tx.unsafe(ROLLBACK);
      const [{ n }] = await tx`select count(*)::int as n from pg_trigger where tgname in ('trg_enforce_return_cycle_ledger_key', 'trg_release_return_cycle_claim', 'trg_guard_portfolio_return_fields')`;
      expect(n).toBe(0);
      expect((await tx`select count(*)::int as n from pg_trigger where tgname = 'trg_return_cycle_rollback_compat'`)[0].n).toBe(1);
      expect((await tx`select to_regprocedure('public.claim_return_cycle_for_operation(uuid)') as f`)[0].f).toBeNull();
      expect((await tx`select to_regclass('public.portfolio_return_cycle_claims') as t`)[0].t).not.toBeNull();
      await tx`select 1/0`;
    }).catch((e) => { if (!/division by zero/.test(String(e))) throw e; });
  });
});
