import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  openGate, requireOrSkip, beginAs, expectRaiseDetail, setLockTimeout, assertNotLockTimeout,
  backendPid, waitUntilLockBlocked,
  ensureIdentity, ensureCoordinatorSeat, cancelRunOrders, assertCleanupSucceeded,
  unwindSessions, endPoolBounded, startDeadline, IDS, KAMPALA_DATE, RUN_ID, FIXTURE_MARK, type Gate, type Conn,
} from './foodDbTestGate';

/**
 * R3 - concurrent requests sharing an idempotency key.
 *
 * The replay read near the top of food_place_order takes no lock, so two
 * simultaneous submissions of the same key both miss it and both reach the
 * INSERT. idempotency_key is NOT NULL UNIQUE (M1:102), so one wins and the
 * loser raised a raw 23505 - precisely the double-submit the key exists to
 * absorb. The fix catches unique_violation around that one INSERT, re-reads,
 * re-checks ownership, and returns the winner as replayed:true.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT MAKES THESE TESTS DISCRIMINATING, and what made the previous ones not.
 *
 * food_place_order can produce the SAME observable response from two entirely
 * different places:
 *
 *   OLD PATH   M2:212-218  the unlocked replay read, which has always worked.
 *                          Returns replayed:true, and for a foreign owner
 *                          raises 'That order reference is already in use'.
 *   NEW PATH   M2:346-372  the unique_violation handler added by R3. Returns
 *                          replayed:true, and for a foreign owner raises the
 *                          IDENTICAL message.
 *
 * Response shape and error text therefore prove nothing about which ran. The
 * earlier version of this suite asserted only on those, and had no ordering
 * guarantee: it fired the second request and immediately committed the first.
 *
 * NOTE ON WHAT FOLLOWS: this is the reasoning that motivated the rewrite, not
 * an observed result. None of these tests has ever been executed. The
 * expectation was that the COMMIT - one small statement on an already-open
 * connection - would normally beat the second request's parse-and-plan, so the
 * loser's replay read would see the committed row and return via the OLD path,
 * making the suite pass against a database with no handler at all. That was
 * never demonstrated by a run; it is the hypothesis the design below removes
 * the possibility of, rather than a measurement.
 *
 * Two changes fix that, and neither weakens an assertion:
 *
 *   1. DIFFERENT MENU ITEMS. The two callers order different meals, so they
 *      share no food_menu_items row and take no common FOR NO KEY UPDATE
 *      (M2:245-253). The fixture period's max_qty_per_employee is NULL -
 *      asserted in beforeAll - so M2:282-320 is skipped and no advisory lock
 *      is taken either. The unique index on idempotency_key is then the ONLY
 *      object the two transactions can contend on.
 *
 *   2. A REAL BARRIER. The winner is not committed until the loser is observed
 *      blocked on a lock, waiting specifically on the winner's transaction id
 *      (waitUntilLockBlocked). A request that took the OLD path never blocks -
 *      it returns immediately - so observing the block proves the loser got
 *      past the replay read without finding a row, and that whatever it
 *      returns next came out of the guarded INSERT.
 *
 * Content is then checked against the winner's ACTUAL persisted order, not
 * just its id: the two meals are priced differently (1000 vs 2500), so a
 * response reporting the winner's total is distinguishable from one reporting
 * the loser's own basket.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ISOLATION - EXPECTED MECHANISM, NOT YET VERIFIED BY EXECUTION. At READ
 * COMMITTED the loser should block on the unique index until the winner
 * commits, its re-read then seeing the row. At REPEATABLE READ the loser's
 * snapshot predates that commit, so the re-read should find nothing and the
 * function should raise a retry error rather than invent a replay. Both are
 * asserted below.
 *
 * The REPEATABLE READ path rests on one link that source cannot settle: that a
 * plain INSERT colliding with a since-committed duplicate key raises 23505
 * there, reaching the handler, rather than a native 40001 at the index. The
 * mechanism says 23505 (unique checks use SnapshotDirty, and 40001-on-
 * concurrent-update comes only from the heap update/lock paths, which an index
 * insert never takes), but that remains UNVERIFIED - the RPC says the same of
 * itself at M2:345. The assertions are written so that either wrong outcome
 * FAILS LOUDLY; none of them can pass on an unexpected result.
 *
 * Orders created here are committed on purpose and are append-only, so they
 * are cancelled and labelled afterwards, never deleted. The menu fixtures are
 * deterministic and reused across runs rather than recreated.
 */

const FIXTURE_PERIOD = `${FIXTURE_MARK} R3 PERIOD`;
/** Meal A is the pre-existing fixture row; B is the second, priced apart from
 *  it so a replayed total can be told from the loser's own basket total. */
const FIXTURE_MEAL_A = `${FIXTURE_MARK} R3 MEAL`;
const FIXTURE_MEAL_B = `${FIXTURE_MARK} R3 MEAL B`;
const PRICE_A = 1000;
const PRICE_B = 2500;

/**
 * TIMING HIERARCHY, and why each gap is the size it is.
 *
 *   BARRIER_MS (2s) < WAITER_LOCK_TIMEOUT_MS (5s) < RACE_TEST_TIMEOUT_MS (20s) <= hooks (30s)
 *
 * The barrier must give up BEFORE the waiter's lock_timeout, or it would fail a
 * session that is still legitimately queued. But that gap also has to cover the
 * winner's COMMIT round trip, which only begins once the barrier returns, while
 * the waiter's clock has been running since its INSERT started waiting. The
 * previous 1200/2000 split left roughly 800ms for that round trip, so on a slow
 * link a lock timeout became the NORMAL outcome - caught by assertNotLockTimeout,
 * but as a meaningless red. 2000/5000 leaves ~3s: a round-trip budget, not a race.
 */
const BARRIER_MS = 2000;
const WAITER_LOCK_TIMEOUT_MS = 5000;
/** Must exceed the barrier plus a full waiter lock_timeout plus the round trips,
 *  and stay under the 30s hook budget. */
const RACE_TEST_TIMEOUT_MS = 20_000;

/** postgres.js surfaces SQLSTATE on the error as `code`. */
type PgError = Error & { code?: string };
/** What the racing promises resolve to: the message plus its SQLSTATE. */
type PgOutcome = { message: string; code?: string };

let gate: Gate;
let menuItemA = '';
let menuItemB = '';

beforeAll(async () => {
  gate = await openGate();
  if (!gate.canRun) return;
  await ensureIdentity(gate.sql!, IDS.COORD, 'COORDINATOR');
  await ensureIdentity(gate.sql!, IDS.EMP_A, 'EMPLOYEE A');
  await ensureIdentity(gate.sql!, IDS.EMP_B, 'EMPLOYEE B');
  // The canteen admits enabled employees only (master register FM-15), so the
  // two ordering identities need the role. Idempotent; never deleted.
  for (const id of [IDS.EMP_A, IDS.EMP_B]) {
    await gate.sql!`
      insert into public.user_roles (user_id, role, enabled)
      select ${id}, 'employee', true
       where not exists (select 1 from public.user_roles
                          where user_id = ${id} and role = 'employee')`;
  }
  await ensureCoordinatorSeat(gate.sql!, IDS.COORD);

  // Deterministic, reusable fixture. food_meals is append-only so it is never
  // deleted; creating it idempotently keeps the residue at two rows forever
  // rather than two per run. The whole fixture is built in one transaction so
  // a partial failure leaves nothing behind.
  await gate.sql!.begin(async (tx) => {
    await tx`insert into public.food_service_periods
        (name, ordering_opens_at, ordering_closes_at, max_qty_per_employee, active)
      values (${FIXTURE_PERIOD}, '00:00', '23:59:59', null, true)
      on conflict (name) do nothing`;
    for (const [name, price] of [[FIXTURE_MEAL_A, PRICE_A], [FIXTURE_MEAL_B, PRICE_B]] as const) {
      await tx`insert into public.food_meals (name, price_ugx, status, created_by)
        select ${name}, ${price}, 'published', ${IDS.COORD}
         where not exists (select 1 from public.food_meals where name = ${name})`;
      // One menu item per Kampala business date, so a run on a new day re-seeds
      // rather than reusing a stale date that food_place_order would reject.
      await tx.unsafe(`
        insert into public.food_menu_items
          (service_date, period_id, meal_id, price_ugx, servings_total, servings_reserved, published_at, created_by)
        select ${KAMPALA_DATE}, p.id, m.id, $4::numeric, 100000, 0, now(), $1::uuid
          from public.food_service_periods p, public.food_meals m
         where p.name = $2 and m.name = $3
        on conflict (service_date, period_id, meal_id) do nothing`,
        [IDS.COORD, FIXTURE_PERIOD, name, price]);
    }
  });

  const found = await gate.sql!.unsafe(`
    select m.name, mi.id from public.food_menu_items mi
      join public.food_service_periods p on p.id = mi.period_id
      join public.food_meals m on m.id = mi.meal_id
     where p.name = $1 and m.name in ($2, $3) and mi.service_date = ${KAMPALA_DATE}`,
    [FIXTURE_PERIOD, FIXTURE_MEAL_A, FIXTURE_MEAL_B]) as unknown as { name: string; id: string }[];
  menuItemA = found.find((r) => r.name === FIXTURE_MEAL_A)?.id ?? '';
  menuItemB = found.find((r) => r.name === FIXTURE_MEAL_B)?.id ?? '';

  // THE TESTS' CENTRAL PREMISE, ASSERTED RATHER THAN ASSUMED. If these two
  // resolved to the same row, or the period carried a per-employee cap, the
  // callers would contend on a menu row or on the advisory lock at M2:308 and
  // the barrier below would be observing the wrong wait.
  if (!menuItemA || !menuItemB || menuItemA === menuItemB) {
    throw new Error(`the R3 fixture needs two distinct menu items; got A=${menuItemA} B=${menuItemB}`);
  }
  const [period] = await gate.sql!<{ max_qty_per_employee: number | null }[]>`
    select max_qty_per_employee from public.food_service_periods where name = ${FIXTURE_PERIOD}`;
  if (period?.max_qty_per_employee !== null) {
    throw new Error(
      `the R3 fixture period must have max_qty_per_employee NULL so food_place_order skips the ` +
      `per-employee advisory lock; found ${period?.max_qty_per_employee}. The unique index would ` +
      `no longer be the only point of contention and the barrier would prove nothing.`);
  }
// Explicit: vitest's default hookTimeout is 10s and this hook makes many round
// trips. A hook timeout here leaves `gate` unassigned, so every test in the file
// then fails for a reason unrelated to the code under test.
}, 30_000);

afterAll(async () => {
  // EXPLICIT HOOK BUDGET. vitest's default hookTimeout is 10_000ms, which the
  // previous per-step bounds could consume exactly (5s cleanup + 5s shutdown),
  // losing the failure report in the very case the bounds existed for. 30s is
  // the OUTER safety budget, not an allowance per operation: cleanup draws on
  // a single 20s deadline and shutdown takes at most 5s, leaving headroom so
  // assertCleanupSucceeded is reached with time to spare.
  const failures: string[] = [];
  if (gate?.sql) {
    const deadline = startDeadline(20_000);
    try {
      failures.push(...await cancelRunOrders(gate.sql, { keyPrefix: `idem-${RUN_ID}-` }, deadline));
    } catch (e) {
      failures.push(`cancelRunOrders: ${(e as Error)?.message ?? String(e)}`);
    }
    // Attempted even if cleanup failed or timed out. Guarded like the step
    // above so a throw here cannot discard what cleanup already recorded.
    try {
      failures.push(...await endPoolBounded(gate.sql, 5));
    } catch (e) {
      failures.push(`pool shutdown: ${(e as Error)?.message ?? String(e)}`);
    }
  }
  assertCleanupSucceeded(failures, RUN_ID);
}, 30_000);

const items = (menuItemId: string) => JSON.stringify([{ menu_item_id: menuItemId, quantity: 1 }]);

function place(c: Conn, key: string, menuItemId: string) {
  return c<{ r: Record<string, unknown> }[]>`
    select public.food_place_order(${items(menuItemId)}::text::jsonb, ${key}, 'cash', null) as r`;
}

async function orderCount(key: string): Promise<number> {
  const [{ n }] = await gate.sql!<{ n: number }[]>`
    select count(*)::int as n from public.food_orders where idempotency_key = ${key}`;
  return n;
}

async function servingsReserved(menuItemId: string): Promise<number> {
  const [{ servings_reserved: n }] = await gate.sql!<{ servings_reserved: number }[]>`
    select servings_reserved from public.food_menu_items where id = ${menuItemId}`;
  return Number(n);
}

/**
 * Holds until the loser is blocked on the winner's transaction, and proves it
 * is blocked on the right thing. 'transactionid' is the wait an inserter takes
 * when it collides with an UNCOMMITTED duplicate key: it queues on the other
 * transaction's id until that transaction ends. Any other wait event would
 * mean the two sessions found something else to contend on, which would
 * invalidate the conclusion rather than merely delay it.
 */
async function barrierOnUniqueIndex(loserPid: number, winnerPid: number): Promise<void> {
  const blocked = await waitUntilLockBlocked(gate.sql!, loserPid, BARRIER_MS);
  expect(blocked.waitEvent).toBe('transactionid');
  // EXACTLY the winner, not merely including it. `toContain` would still pass
  // with a third session also blocking the loser, and the exclusion argument
  // above - that the unique index is the only thing these two can contend on -
  // would quietly stop holding.
  expect(blocked.blockedBy).toEqual([winnerPid]);
}

describe('R3 - concurrent idempotency replay', () => {
  it('the loser blocks on the unique index and replays the winner from the guarded INSERT', async (ctx) => {
    if (!requireOrSkip(gate, () => ctx.skip())) return;
    const key = `idem-${RUN_ID}-race`;
    const reservedBefore = await servingsReserved(menuItemB);
    const c1 = await gate.sql!.reserve();
    const c2 = await gate.sql!.reserve();
    let second: Promise<unknown> | null = null;
    try {
      await beginAs(c1, IDS.EMP_A);
      await beginAs(c2, IDS.EMP_A);
      // Bounds the waiter so teardown can never block indefinitely (M1), and
      // stays above BARRIER_MS so the barrier observes the wait before the
      // waiter gives up on it.
      await setLockTimeout(c2, WAITER_LOCK_TIMEOUT_MS);
      const pid1 = await backendPid(c1);
      const pid2 = await backendPid(c2);

      // c1 takes meal A and holds the uncommitted idempotency_key entry.
      const [first] = await place(c1, key, menuItemA);
      const winner = first.r as Record<string, unknown>;
      expect(winner.replayed).toBe(false);
      expect(Number(winner.total_ugx)).toBe(PRICE_A);

      // c2 takes meal B: no shared menu row, no advisory lock, so the unique
      // index on idempotency_key is the only thing it can block on.
      second = place(c2, key, menuItemB).then(([r]) => r.r).catch((e: Error) => ({ error: e.message }));

      // DO NOT COMMIT UNTIL THE LOSER IS DEMONSTRABLY STUCK. This is what
      // makes the result attributable to the handler rather than to the
      // unlocked replay read.
      await barrierOnUniqueIndex(pid2, pid1);

      await c1`commit`;
      const loser = await second as Record<string, unknown>;
      assertNotLockTimeout(loser, 'R3 concurrent same-key');

      // No raw unique violation reached the caller.
      expect(loser.error).toBeUndefined();
      expect(JSON.stringify(loser)).not.toMatch(/duplicate key|23505|idempotency_key/i);

      // The replay reports the WINNER, by id, reference and total.
      expect(loser.replayed).toBe(true);
      expect(loser.order_id).toBe(winner.order_id);
      expect(loser.order_reference).toBe(winner.order_reference);
      expect(Number(loser.total_ugx)).toBe(PRICE_A);
      // Not the loser's own basket, which would have cost PRICE_B.
      expect(Number(loser.total_ugx)).not.toBe(PRICE_B);

      // And the response matches what was actually persisted, not just itself.
      const lines = await gate.sql!<{ menu_item_id: string; quantity: number; line_total_ugx: string }[]>`
        select menu_item_id, quantity, line_total_ugx
          from public.food_order_items where order_id = ${winner.order_id as string}`;
      expect(lines).toHaveLength(1);
      expect(lines[0].menu_item_id).toBe(menuItemA);
      expect(Number(lines[0].quantity)).toBe(1);
      expect(Number(lines[0].line_total_ugx)).toBe(PRICE_A);

      // Runs on the pool, so it sees COMMITTED state only. It confirms the
      // winner is the sole order under this key - which the UNIQUE constraint
      // already guarantees - and says nothing about the loser.
      expect(await orderCount(key)).toBe(1);

      // THE LOSER DID NO WORK, probed on c2's OWN connection - the only place
      // its uncommitted writes are visible. c2's transaction is still open and
      // healthy here, because the RPC returned rather than raised. A pool query
      // would show the committed value and would therefore pass even if the
      // loser HAD reserved servings; this read would not.
      const [{ servings_reserved: bOnLoser }] = await c2<{ servings_reserved: number }[]>`
        select servings_reserved from public.food_menu_items where id = ${menuItemB}`;
      expect(Number(bOnLoser)).toBe(reservedBefore);
    } finally {
      // c1 is the lock holder, c2 the waiter: the helper rolls c1 back first
      // so c2's pending statement can finish instead of blocking the unwind.
      await unwindSessions([{ conn: c1 }, { conn: c2, pending: second }]);
    }
  }, RACE_TEST_TIMEOUT_MS);

  it('a different employee colliding on the same key is refused by the handler, not handed the order', async (ctx) => {
    if (!requireOrSkip(gate, () => ctx.skip())) return;
    const key = `idem-${RUN_ID}-owner`;
    const c1 = await gate.sql!.reserve();
    const c2 = await gate.sql!.reserve();
    let second: Promise<unknown> | null = null;
    try {
      await beginAs(c1, IDS.EMP_A);
      await beginAs(c2, IDS.EMP_B);           // different owner
      await setLockTimeout(c2, WAITER_LOCK_TIMEOUT_MS);
      const pid1 = await backendPid(c1);
      const pid2 = await backendPid(c2);

      await place(c1, key, menuItemA);
      second = place(c2, key, menuItemB)
        .then(() => ({ message: 'succeeded', code: undefined as string | undefined }))
        .catch((e: PgError) => ({ message: e.message, code: e.code }));

      // The barrier is what attributes the refusal below to the handler's
      // ownership re-check (M2:366) rather than the replay read's (M2:214).
      // The two raise the identical message, so nothing else could.
      await barrierOnUniqueIndex(pid2, pid1);

      await c1`commit`;
      const outcome = await second as PgOutcome;
      assertNotLockTimeout(outcome, 'R3 different-owner collision');

      // The established business error - never another employee's order, and
      // never a raw constraint violation leaking to the caller.
      //
      // SQLSTATE IS ASSERTED ALONGSIDE THE MESSAGE. The code pins the error
      // class even if the wording is later edited - a realistic event under
      // this project's mandatory-terminology rule - while the message pins
      // which branch raised it. M2:367 raises this one with ERRCODE 22023.
      expect(outcome.message).not.toBe('succeeded');
      expect(outcome.code).toBe('22023');
      expect(outcome.message).toMatch(/That order reference is already in use/);
      expect(outcome.message).not.toMatch(/duplicate key|23505/i);

      expect(await orderCount(key)).toBe(1);
      const [row] = await gate.sql!<{ employee_id: string }[]>`
        select employee_id from public.food_orders where idempotency_key = ${key}`;
      expect(row.employee_id).toBe(IDS.EMP_A);
    } finally {
      // c1 is the lock holder, c2 the waiter: the helper rolls c1 back first
      // so c2's pending statement can finish instead of blocking the unwind.
      await unwindSessions([{ conn: c1 }, { conn: c2, pending: second }]);
    }
  }, RACE_TEST_TIMEOUT_MS);

  it('under REPEATABLE READ the loser gets the handler\'s retry error, not a fabricated replay', async (ctx) => {
    if (!requireOrSkip(gate, () => ctx.skip())) return;
    const key = `idem-${RUN_ID}-rr`;
    const c1 = await gate.sql!.reserve();
    const c2 = await gate.sql!.reserve();
    let second: Promise<unknown> | null = null;
    try {
      await beginAs(c1, IDS.EMP_A);
      await c2`begin isolation level repeatable read`;
      await c2`select set_config('request.jwt.claims', ${JSON.stringify({ sub: IDS.EMP_A, role: 'authenticated' })}, true)`;
      await setLockTimeout(c2, WAITER_LOCK_TIMEOUT_MS);
      await c2`select 1`;                 // pin c2's snapshot before c1 commits
      const pid1 = await backendPid(c1);
      const pid2 = await backendPid(c2);

      await place(c1, key, menuItemA);
      second = place(c2, key, menuItemB)
        .then(() => ({ message: 'succeeded', code: undefined as string | undefined }))
        .catch((e: PgError) => ({ message: e.message, code: e.code }));

      // WHY THE SEPARATE MEALS MATTER MOST HERE - expected mechanism, not an
      // observed run. With both callers on the SAME meal, c2 would block on
      // that shared row and PostgreSQL would be expected to raise its own
      // 'could not serialize access due to concurrent update' at M2:253, well
      // before the INSERT; the handler's IF NOT FOUND branch would never be
      // reached, and the old assertion would have accepted the native error as
      // if it had been. Separate meals remove that path. This has not been
      // verified by execution - see the disclaimer on the assertions below.
      await barrierOnUniqueIndex(pid2, pid1);

      await c1`commit`;
      const outcome = await second as PgOutcome;
      assertNotLockTimeout(outcome, 'R3 repeatable read');

      // The winner is invisible to c2's pinned snapshot, so the handler's
      // re-read finds nothing and raises its OWN retry error (M2:359) rather
      // than inventing a replay.
      //
      // SQLSTATE ALONE IS DELIBERATELY NOT ENOUGH HERE: PostgreSQL's native
      // serialization failure is ALSO 40001. The code pins the class, the
      // message pins the branch. The native error is a FAILURE, because it
      // would mean the guarded INSERT was never reached at all.
      expect(outcome.message).not.toBe('succeeded');
      expect(outcome.code).toBe('40001');
      expect(outcome.message).toMatch(/another request was in flight/i);
      expect(outcome.message).not.toMatch(/could not serialize access due to concurrent update/i);

      expect(await orderCount(key)).toBe(1);
      // NO SERVINGS PROBE HERE, deliberately. c2's transaction is ABORTED by
      // the raise above, so any read on it returns 25P02; and a pool query
      // sees only committed state, which cannot say what the loser did. Test 1
      // carries that claim, where c2's transaction is still usable.
    } finally {
      // c1 is the lock holder, c2 the waiter: the helper rolls c1 back first
      // so c2's pending statement can finish instead of blocking the unwind.
      await unwindSessions([{ conn: c1 }, { conn: c2, pending: second }]);
    }
  }, RACE_TEST_TIMEOUT_MS);

  it('an unrelated error is not swallowed by the unique_violation handler', async (ctx) => {
    if (!requireOrSkip(gate, () => ctx.skip())) return;
    const c = await gate.sql!.reserve();
    try {
      await beginAs(c, IDS.EMP_A);
      // Unknown menu item: a P0002 raised at M2:243, well before the guarded
      // INSERT.
      //
      // WHAT THIS SHOWS, AND WHAT IT DOES NOT. It shows an unrelated failure
      // still reaches the caller and creates nothing. It does NOT test the
      // handler's SCOPE, and an earlier comment here wrongly claimed it did:
      // the handler catches `unique_violation` only (M2:351), so a P0002
      // propagates whether the block wraps one INSERT or the entire body. The
      // test passes identically against both scopings. Scope is in fact not
      // testable from outside, because no other statement in the function
      // carries a unique constraint - so do not cite this as that coverage.
      const raised = await expectRaiseDetail(c, () =>
        c`select public.food_place_order(
             ${items(IDS.NO_PROFILE)}::text::jsonb,
             ${`idem-${RUN_ID}-unrelated`}, 'cash', null)`);
      // SQLSTATE and message, as in tests 2 and 3. P0002 is what M2:243 raises
      // for an unknown menu item - read from the RPC, not assumed. It carries
      // no claim about the handler.
      expect(raised.code).toBe('P0002');
      expect(raised.message).toMatch(/no longer on the menu/i);

      // The transaction survived the raise, so this check can actually run:
      // nothing was created.
      expect(await orderCount(`idem-${RUN_ID}-unrelated`)).toBe(0);
    } finally { await unwindSessions([{ conn: c }]); }
  }, RACE_TEST_TIMEOUT_MS);
});
