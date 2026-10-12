import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  openGate, requireOrSkip, beginAs, setLockTimeout, expectRaise, assertNotLockTimeout,
  ensureIdentity, ensureCoordinatorSeat, cancelRunOrders, assertCleanupSucceeded,
  unwindSessions, endPoolBounded, startDeadline, IDS, KAMPALA_DATE, RUN_ID, FIXTURE_MARK, type Gate, type Conn,
} from './foodDbTestGate';

/**
 * R2 - coordinator cancellation must release reserved stock exactly once.
 *
 * Before the fix, food_set_fulfilment allowed confirmed/preparing -> cancelled
 * but wrote only fulfilment_status. servings_reserved was never decremented
 * and stock_released was never set, so a coordinator-cancelled order held its
 * servings for the rest of the service day and the meal read as sold out
 * early. food_cancel_my_order already released stock; this path did not.
 *
 * Every assertion reads persisted state. A returned message is not evidence.
 *
 * ISOLATION: five of the six tests run wholly inside one transaction and roll
 * back, leaving nothing. The concurrency test must commit so a second session
 * can see the order; its orders are cancelled and labelled afterwards, never
 * deleted, because food_orders is append-only. See foodDbTestGate.
 */

const REF_PREFIX = `FO-R2-${RUN_ID}-`;
const SERVINGS_TOTAL = 10;
const QTY = 3;
/** Shared, reusable fixture names - carry the ownership marker, never deleted. */
export const SHARED_PERIOD = `${FIXTURE_MARK} R2 PERIOD`;
export const SHARED_MEAL = `${FIXTURE_MARK} R2 MEAL`;

let gate: Gate;

beforeAll(async () => {
  gate = await openGate();
  if (!gate.canRun) return;
  await ensureIdentity(gate.sql!, IDS.COORD, 'COORDINATOR');
  await ensureIdentity(gate.sql!, IDS.EMP_A, 'EMPLOYEE A');
  await ensureCoordinatorSeat(gate.sql!, IDS.COORD);

  // Reusable period/meal/menu-item, one row each, created idempotently in one
  // transaction. food_meals is append-only, so creating a fresh meal per run
  // would leave an undeletable row behind every time.
  await gate.sql!.begin(async (tx) => {
    await tx`insert into public.food_service_periods
        (name, ordering_opens_at, ordering_closes_at, max_qty_per_employee, active)
      values (${SHARED_PERIOD}, '00:00', '23:59:59', null, true)
      on conflict (name) do nothing`;
    await tx`insert into public.food_meals (name, price_ugx, status, created_by)
      select ${SHARED_MEAL}, 1000, 'published', ${IDS.COORD}
       where not exists (select 1 from public.food_meals where name = ${SHARED_MEAL})`;
    await tx.unsafe(`
      insert into public.food_menu_items
        (service_date, period_id, meal_id, price_ugx, servings_total, servings_reserved, published_at, created_by)
      select ${KAMPALA_DATE}, p.id, m.id, 1000, 100000, 0, now(), $1
        from public.food_service_periods p, public.food_meals m
       where p.name = $2 and m.name = $3
      on conflict (service_date, period_id, meal_id) do nothing`,
      [IDS.COORD, SHARED_PERIOD, SHARED_MEAL]);
  });
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
      failures.push(...await cancelRunOrders(gate.sql, { refPrefix: REF_PREFIX }, deadline));
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

/** Seeds a published menu item and one confirmed order, in the caller's
 *  transaction. Uses the Kampala business date, as food_place_order does. */
async function seedOrder(c: Conn, ref: string) {
  const [{ id: periodId }] = await c<{ id: string }[]>`
    insert into public.food_service_periods (name, ordering_opens_at, ordering_closes_at, max_qty_per_employee, active)
    values (${'R2-' + ref}, '00:00', '23:59:59', null, true) returning id`;
  const [{ id: mealId }] = await c<{ id: string }[]>`
    insert into public.food_meals (name, price_ugx, status, created_by)
    values (${'R2 meal ' + ref}, 1000, 'published', ${IDS.COORD}) returning id`;
  const [{ id: menuItemId }] = await c.unsafe(`
    insert into public.food_menu_items
      (service_date, period_id, meal_id, price_ugx, servings_total, servings_reserved, published_at, created_by)
    values (${KAMPALA_DATE}, $1, $2, 1000, ${SERVINGS_TOTAL}, ${QTY}, now(), $3)
    returning id`, [periodId, mealId, IDS.COORD]) as unknown as { id: string }[];
  const [{ id: orderId }] = await c.unsafe(`
    insert into public.food_orders
      (order_reference, employee_id, service_date, period_id, total_ugx,
       payment_status, fulfilment_status, idempotency_key, payment_mode)
    values ($1, $2, ${KAMPALA_DATE}, $3, ${1000 * QTY},
            'pending_payment', 'confirmed', $4, 'cash')
    returning id`, [ref, IDS.EMP_A, periodId, `idem-${ref}`]) as unknown as { id: string }[];
  await c`insert into public.food_order_items
      (order_id, menu_item_id, meal_id, meal_name, unit_price_ugx, quantity, line_total_ugx)
    values (${orderId}, ${menuItemId}, ${mealId}, ${'R2 meal'}, 1000, ${QTY}, ${1000 * QTY})`;
  return { orderId, menuItemId };
}

/**
 * Committed fixture for the race test. Reuses the shared, date-scoped menu
 * item so repeated runs add no further append-only meals; only the order and
 * its events remain, which is unavoidable and by design.
 */
async function seedCommittedOrder(c: Conn, ref: string) {
  const [mi] = await c.unsafe(`
    select mi.id, mi.period_id, mi.meal_id, mi.servings_reserved
      from public.food_menu_items mi
      join public.food_service_periods p on p.id = mi.period_id
      join public.food_meals m on m.id = mi.meal_id
     where p.name = $1 and m.name = $2 and mi.service_date = ${KAMPALA_DATE}`,
    [SHARED_PERIOD, SHARED_MEAL]) as unknown as
    { id: string; period_id: string; meal_id: string; servings_reserved: number }[];
  if (!mi) throw new Error('shared R2 menu fixture missing; beforeAll did not complete');

  const baseline = mi.servings_reserved;
  const [{ id: orderId }] = await c.unsafe(`
    insert into public.food_orders
      (order_reference, employee_id, service_date, period_id, total_ugx,
       payment_status, fulfilment_status, idempotency_key, payment_mode)
    values ($1, $2, ${KAMPALA_DATE}, $3, ${1000 * QTY},
            'pending_payment', 'confirmed', $4, 'cash')
    returning id`, [ref, IDS.EMP_A, mi.period_id, `idem-${ref}`]) as unknown as { id: string }[];
  await c`insert into public.food_order_items
      (order_id, menu_item_id, meal_id, meal_name, unit_price_ugx, quantity, line_total_ugx)
    values (${orderId}, ${mi.id}, ${mi.meal_id}, ${SHARED_MEAL}, 1000, ${QTY}, ${1000 * QTY})`;
  await c`update public.food_menu_items
             set servings_reserved = servings_reserved + ${QTY} where id = ${mi.id}`;
  return { orderId, menuItemId: mi.id, baseline };
}

async function reserved(c: Conn, menuItemId: string): Promise<number> {
  const [{ r }] = await c<{ r: number }[]>`
    select servings_reserved as r from public.food_menu_items where id = ${menuItemId}`;
  return r;
}

async function orderState(c: Conn, orderId: string) {
  const [row] = await c<{ fulfilment_status: string; stock_released: boolean; cancelled_at: string | null }[]>`
    select fulfilment_status, stock_released, cancelled_at
      from public.food_orders where id = ${orderId}`;
  return row;
}

describe('R2 - cancellation releases reserved stock exactly once', () => {
  it('confirmed -> cancelled releases the reservation once', async (ctx) => {
    if (!requireOrSkip(gate, () => ctx.skip())) return;
    const c = await gate.sql!.reserve();
    try {
      await beginAs(c, IDS.COORD);
      const { orderId, menuItemId } = await seedOrder(c, `${REF_PREFIX}A`);
      expect(await reserved(c, menuItemId)).toBe(QTY);

      await c`select public.food_set_fulfilment(${orderId}, 'cancelled', 'R2 test')`;

      expect(await reserved(c, menuItemId)).toBe(0);
      const s = await orderState(c, orderId);
      expect(s.fulfilment_status).toBe('cancelled');
      expect(s.stock_released).toBe(true);
      expect(s.cancelled_at).not.toBeNull();
    } finally { await unwindSessions([{ conn: c }]); }
  });

  it('preparing -> cancelled releases the reservation once', async (ctx) => {
    if (!requireOrSkip(gate, () => ctx.skip())) return;
    const c = await gate.sql!.reserve();
    try {
      await beginAs(c, IDS.COORD);
      const { orderId, menuItemId } = await seedOrder(c, `${REF_PREFIX}B`);
      // Reached by direct UPDATE: the RPC requires payment_status='paid' to
      // enter preparing, which checkout cannot grant while food_pay_order is
      // disabled. The cancel path under test does not read payment_status.
      await c`update public.food_orders set fulfilment_status='preparing' where id=${orderId}`;

      await c`select public.food_set_fulfilment(${orderId}, 'cancelled', 'R2 test')`;

      expect(await reserved(c, menuItemId)).toBe(0);
      expect((await orderState(c, orderId)).stock_released).toBe(true);
    } finally { await unwindSessions([{ conn: c }]); }
  });

  it('a second cancellation cannot release stock twice', async (ctx) => {
    if (!requireOrSkip(gate, () => ctx.skip())) return;
    const c = await gate.sql!.reserve();
    try {
      await beginAs(c, IDS.COORD);
      const { orderId, menuItemId } = await seedOrder(c, `${REF_PREFIX}C`);
      await c`select public.food_set_fulfilment(${orderId}, 'cancelled', 'first')`;
      expect(await reserved(c, menuItemId)).toBe(0);

      // Savepoint-bracketed so the transaction survives the expected raise and
      // the stock assertion below can actually run.
      const msg = await expectRaise(c, () =>
        c`select public.food_set_fulfilment(${orderId}, 'cancelled', 'second')`);
      expect(msg).toMatch(/already cancelled|cannot be changed/i);

      expect(await reserved(c, menuItemId)).toBe(0);   // not -3
    } finally { await unwindSessions([{ conn: c }]); }
  });

  it('two independent sessions cancelling concurrently release stock only once', async (ctx) => {
    if (!requireOrSkip(gate, () => ctx.skip())) return;
    const setup = await gate.sql!.reserve();
    let orderId = '', menuItemId = '', baseline = 0;
    try {
      // Committed on purpose: both racing sessions must see the same order.
      // Uses the SHARED reusable menu item rather than a per-run meal, so
      // repeated runs do not add an undeletable food_meals row each time.
      // The reservation is added here and released by the cancel under test,
      // so servings_reserved must return to its starting value.
      await beginAs(setup, IDS.COORD);
      const seeded = await seedCommittedOrder(setup, `${REF_PREFIX}D`);
      orderId = seeded.orderId; menuItemId = seeded.menuItemId; baseline = seeded.baseline;
      await setup`commit`;
    } finally {
      // H2: previously `setup.release()` with no rollback. seedCommittedOrder
      // can throw on its fixture guard or either insert, and the commit itself
      // can throw - any of which would return a connection holding an open or
      // aborted transaction, and the food_orders / food_menu_items row locks,
      // straight to the pool. Unwound through the helper so the rollback is
      // attempted, the release always happens exactly once, and either failure
      // is recorded rather than discarded.
      //
      // If the commit SUCCEEDED, the rollback is a no-op warning the driver
      // discards and the fixture persists as intended. Nothing after the
      // commit can fail, so there is no partially-committed state to repair:
      // either the order exists (and afterAll cancels it through the
      // production RPC, scoped to this run's reference) or nothing does.
      await unwindSessions([{ conn: setup }]);
    }

    const c1 = await gate.sql!.reserve();
    const c2 = await gate.sql!.reserve();
    let second: Promise<string> | null = null;
    try {
      await beginAs(c1, IDS.COORD);
      await beginAs(c2, IDS.COORD);
      // Bounded on BOTH sides: either session may be the one that queues.
      await setLockTimeout(c1, 2000);
      await setLockTimeout(c2, 2000);

      // c1 holds the row lock taken by food_set_fulfilment's SELECT ... FOR
      // UPDATE; c2 must queue behind it rather than proceed in parallel.
      await c1`select public.food_set_fulfilment(${orderId}, 'cancelled', 'session 1')`;

      second = c2`select public.food_set_fulfilment(${orderId}, 'cancelled', 'session 2')`
        .then(() => 'succeeded')
        .catch((e: Error) => e.message);

      await c1`commit`;
      const outcome = await second;
      assertNotLockTimeout(outcome, 'R2 concurrent cancellation');

      // The terminal-state refusal once c1 committed. Never a second release.
      // A 55P03 lock timeout would satisfy every assertion below without
      // proving anything, so it is rejected above rather than accepted here.
      expect(outcome).not.toBe('succeeded');

      const [{ r }] = await gate.sql!<{ r: number }[]>`
        select servings_reserved as r from public.food_menu_items where id = ${menuItemId}`;
      expect(r).toBe(baseline);          // released exactly once - not twice, not never
      const [{ n }] = await gate.sql!<{ n: number }[]>`
        select count(*)::int as n from public.food_order_events
         where order_id = ${orderId} and to_status = 'cancelled'`;
      expect(n).toBe(1);
    } finally {
      // Both sessions, on every path, after the racing promise has settled.
      // afterAll cancels and labels this run's orders; the order, its events
      // and the meal are append-only and stay, by design.
      // c1 holds the row lock; c2's `second` may be queued behind it. Passing
      // `pending` with its OWN connection lets the helper roll c1 back first
      // and free the lock, rather than waiting on c2 forever.
      await unwindSessions([{ conn: c1 }, { conn: c2, pending: second }]);
    }
  // Explicit: ~25 round trips AND a deliberate wait on up to a full lock_timeout of
  // contention. Vitest's 5s default can be exceeded on a non-local database, which
  // would destroy R2's only concurrency evidence and leave this finally running
  // alongside afterAll.
  }, 15_000);

  it('an invalid transition changes neither status nor stock', async (ctx) => {
    if (!requireOrSkip(gate, () => ctx.skip())) return;
    const c = await gate.sql!.reserve();
    try {
      await beginAs(c, IDS.COORD);
      const { orderId, menuItemId } = await seedOrder(c, `${REF_PREFIX}E`);

      const msg = await expectRaise(c, () =>
        c`select public.food_set_fulfilment(${orderId}, 'collected', 'invalid')`);
      expect(msg).toMatch(/Invalid transition/i);

      expect(await reserved(c, menuItemId)).toBe(QTY);
      const s = await orderState(c, orderId);
      expect(s.fulfilment_status).toBe('confirmed');
      expect(s.stock_released).toBe(false);
    } finally { await unwindSessions([{ conn: c }]); }
  });

  it('a failed cancellation leaves no partial stock or status update', async (ctx) => {
    if (!requireOrSkip(gate, () => ctx.skip())) return;
    const c = await gate.sql!.reserve();
    try {
      await beginAs(c, IDS.COORD);
      const { orderId, menuItemId } = await seedOrder(c, `${REF_PREFIX}F`);

      const msg = await expectRaise(c, () =>
        c`select public.food_set_fulfilment(${orderId}, 'delivered', 'invalid')`);
      expect(msg).toMatch(/Invalid transition/i);

      expect(await reserved(c, menuItemId)).toBe(QTY);
      expect((await orderState(c, orderId)).fulfilment_status).toBe('confirmed');
    } finally { await unwindSessions([{ conn: c }]); }
  });
});
