/**
 * Employee Food Ordering — in-memory fixture backend.
 *
 * WHY THIS EXISTS
 * The two food migrations are NOT applied to production, so the food tables and
 * RPCs do not exist there. The UI must still be buildable and previewable, and
 * it must never depend on production food tables. This module answers the same
 * call surface as the real RPCs from memory, so the screens can be built and
 * demonstrated now and switched to the server by flipping one flag.
 *
 * THIS IS SCAFFOLDING, NOT A SECOND BACKEND.
 * - The server stays authoritative. Where a rule is mirrored here it is imported
 *   from ./foodService (FOOD_ALLOWED_TRANSITIONS, canStartPreparing) rather than
 *   restated, so the two cannot drift.
 * - It is deliberately generous about *errors* and strict about *money*: paying
 *   throws exactly as the server does, and nothing here reads or writes a
 *   wallet, a balance or a ledger entry. There is nothing to read — this store
 *   holds meals and orders and nothing else.
 *
 * PAYMENT AFTER DELIVERY, SAME AS PRODUCTION (CFO decision 2026-10-12)
 * `FULFILMENT_REQUIRES_PAYMENT` is false here and in Postgres: the kitchen
 * prepares and hands over unpaid orders, and payment_status stays
 * 'pending_payment' throughout. An order records the employee's chosen payment
 * mode (cash, wallet or mobile_money) and nothing more.
 *
 * A few orders are seeded with SIMULATED payment evidence so the "paid" badge
 * can be seen. These are unmistakable: their reference starts with `FO-SIM-`
 * and their transaction_group_id is the fixed sentinel SIMULATED_PAYMENT_TXN.
 * No wallet was read, nothing was settled and no ledger entry exists for them.
 * Nothing here can create a real payment; `food_pay_order` refuses.
 *
 * DEVELOPMENT ONLY. isFoodMockMode() is false in every production build, and
 * the seeded people are synthetic: no real account id or name appears here.
 */

import {
  FOOD_ALLOWED_TRANSITIONS,
  FOOD_CHECKOUT_DISABLED,
  FOOD_MAX_INSTRUCTIONS,
  FOOD_MAX_QTY_PER_LINE,
  FOOD_PAYMENT_MODES,
  canStartPreparing,
  FOOD_EXCEPTION_KINDS,
  FOOD_MAX_EXCEPTION_NOTE,
  FULFILMENT_REQUIRES_PAYMENT,
  SIMULATED_ORDER_PREFIX,
  SIMULATED_PAYMENT_TXN,
  foodKampalaNow as kampalaNow,
  foodToday,
  type FoodFulfilmentStatus,
  type FoodPaymentStatus,
} from './foodService';

// Re-exported for the tests that drive the fixture directly.
export {
  FULFILMENT_REQUIRES_PAYMENT, SIMULATED_ORDER_PREFIX, SIMULATED_PAYMENT_TXN,
  isSimulatedPayment, isFoodMockMode, foodToday,
} from './foodService';





function fail(message: string): never { throw new Error(message); }
const uid = () => crypto.randomUUID();

// ─────────────────────────── seeded people ───────────────────────────

// Synthetic ids and names only. Never seed a real account here. (The hook loads
// this module through a DEV-only dynamic import, so production bundles omit it.)
export const MOCK_COORDINATOR = 'c0000000-0000-4000-8000-00000000c00d';
export const MOCK_EMPLOYEE = '22222222-2222-4222-8222-222222222222';
const MOCK_COLLEAGUE = '33333333-3333-4333-8333-333333333333';

const PEOPLE: Record<string, string> = {
  [MOCK_COORDINATOR]: 'Demo Food Coordinator',
  [MOCK_EMPLOYEE]: 'You (demo employee)',
  [MOCK_COLLEAGUE]: 'Demo Colleague',
};

/**
 * Who the fixture treats as signed in. Set from the real session when there is
 * one; a signed-out preview falls back to the demo employee so the screens
 * still have somebody to be.
 */
let currentUser = MOCK_EMPLOYEE;
export function setFoodMockUser(id: string | null) { currentUser = id ?? MOCK_EMPLOYEE; }
export function getFoodMockUser() { return currentUser; }
/** Demo affordance: lets the preview switch between the two personas. */
export function actAsFoodCoordinator(on: boolean) { currentUser = on ? MOCK_COORDINATOR : MOCK_EMPLOYEE; }

// ─────────────────────────── store ───────────────────────────

interface Row { [k: string]: unknown }

const S = {
  categories: [] as Row[],
  meals: [] as Row[],
  periods: [] as Row[],
  closures: [] as Row[],
  menuItems: [] as Row[],
  orders: [] as Row[],
  orderItems: [] as Row[],
  events: [] as Row[],
  exceptions: [] as Row[],
  audit: [] as Row[],
  assignments: [] as Row[],
};

function audit(entity: string, entityId: string | null, action: string, reason?: string | null,
               before?: unknown, after?: unknown) {
  S.audit.unshift({
    id: uid(), entity, entity_id: entityId, action, before_val: before ?? null,
    after_val: after ?? null, reason: reason ?? null, actor_id: currentUser,
    created_at: new Date().toISOString(),
  });
}

function isCoordinator(id = currentUser) {
  return S.assignments.some((a) => a.coordinator_id === id && !a.revoked_at);
}
function isActiveCoordinator(id = currentUser) {
  return S.assignments.some(
    (a) => a.coordinator_id === id && !a.revoked_at && a.access_level === 'active');
}
function requireActiveCoordinator() {
  if (!isActiveCoordinator()) fail('Only the active Food Coordinator may do this');
  return currentUser;
}

// ─────────────────────────── seed ───────────────────────────

let seeded = false;
function seed() {
  if (seeded) return;
  seeded = true;
  const today = foodToday();

  S.assignments.push({
    id: uid(), coordinator_id: MOCK_COORDINATOR, access_level: 'active', assigned_by: MOCK_COORDINATOR,
    assigned_at: new Date().toISOString(), revoked_at: null, revoked_by: null,
    handover_mode: null, reason: 'Initial Food Coordinator appointment',
  });

  const cat = (name: string, sort: number) => {
    const row = { id: uid(), name, sort_order: sort, archived_at: null };
    S.categories.push(row); return row.id as string;
  };
  const cMain = cat('Main Course', 10);
  const cSide = cat('Sides', 20);
  const cDrink = cat('Drinks', 30);

  const meal = (name: string, description: string, price: number, category: string,
                image: string | null, status = 'published') => {
    const row = {
      id: uid(), name, description, image_path: image, category_id: category,
      price_ugx: price, status, archived_at: null, created_by: MOCK_COORDINATOR,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    S.meals.push(row); return row.id as string;
  };
  const mMatoke = meal('Matoke with Beef Stew', 'Steamed green bananas with slow-cooked beef in groundnut sauce', 8000, cMain, '/house-listing-og.jpg');
  const mPilau = meal('Chicken Pilau', 'Spiced rice cooked with chicken, served with kachumbari', 9000, cMain, '/agent-hero.jpeg');
  const mPosho = meal('Posho and Beans', 'Maize meal with red kidney beans', 5000, cMain, null);
  const mRolex = meal('Chapati Rolex', 'Rolled chapati with eggs, tomato and onion', 4000, cMain, null);
  const mGnuts = meal('Steamed Greens', 'Nakati and dodo lightly steamed', 2500, cSide, null);
  const mSoda = meal('Bottled Soda', 'Assorted 300ml', 2000, cDrink, null);
  meal('Katogo (retired)', 'No longer served', 6000, cMain, null, 'archived');
  meal('Fish Fillet', 'Pending costing before it goes live', 12000, cMain, null, 'draft');

  const period = (name: string, opens: string, closes: string, instructions: string, max: number | null) => {
    const row = {
      id: uid(), name, ordering_opens_at: opens, ordering_closes_at: closes,
      collection_instructions: instructions, max_qty_per_employee: max, active: true,
    };
    S.periods.push(row); return row.id as string;
  };
  // Both periods take orders all day (CFO 2026-10-13: no stopping time).
  const pBreakfast = period('Breakfast', '00:00:00', '23:59:59', 'Collect at the canteen counter from 07:30.', 2);
  const pLunch = period('Lunch', '00:00:00', '23:59:59', 'Collect at the canteen counter from 12:30. Bring your staff card.', 5);

  const schedule = (mealId: string, periodId: string, price: number,
                    total: number | null, soldOut = false) => {
    const row = {
      id: uid(), service_date: today, period_id: periodId, meal_id: mealId,
      price_ugx: price, servings_total: total, servings_reserved: 0, sold_out: soldOut,
      published_at: new Date().toISOString(), created_by: MOCK_COORDINATOR,
    };
    S.menuItems.push(row); return row.id as string;
  };
  schedule(mRolex, pBreakfast, 4000, 30);
  schedule(mSoda, pBreakfast, 2000, null);
  const iMatoke = schedule(mMatoke, pLunch, 8000, 40);
  const iPilau = schedule(mPilau, pLunch, 9000, 25);
  const iPosho = schedule(mPosho, pLunch, 5000, 50);
  const iGnuts = schedule(mGnuts, pLunch, 2500, 12);
  schedule(mSoda, pLunch, 2000, null);

  // A couple of PAID orders so the preparation queue is not empty in the preview.
  // The live server cannot create these while payment is disabled.
  // `simulatedPaid` attaches FIXTURE payment evidence — see
  // SIMULATED_PAYMENT_TXN. It is not a payment and never touches money.
  const seedOrder = (employee: string, items: Array<[string, string, number, number]>,
                     fulfilment: FoodFulfilmentStatus, simulatedPaid = false,
                     paymentMode: 'cash' | 'wallet' | 'mobile_money' = 'cash') => {
    const id = uid();
    const total = items.reduce((t, [, , price, qty]) => t + price * qty, 0);
    S.orders.push({
      id,
      order_reference: (simulatedPaid ? SIMULATED_ORDER_PREFIX : 'FO-')
        + today.slice(2).replace(/-/g, '') + '-' + id.replace(/-/g, '').slice(0, 6).toUpperCase(),
      employee_id: employee, employee_name: PEOPLE[employee] ?? 'Employee',
      service_date: today, period_id: pLunch, total_ugx: total,
      payment_status: (simulatedPaid ? 'paid' : 'pending_payment') as FoodPaymentStatus,
      fulfilment_status: fulfilment,
      transaction_group_id: simulatedPaid ? SIMULATED_PAYMENT_TXN : null,
      idempotency_key: uid(), special_instructions: null, payment_mode: paymentMode,
      placed_at: new Date(Date.now() - 1000 * 60 * 90).toISOString(),
      paid_at: simulatedPaid ? new Date().toISOString() : null,
      cancelled_at: null, stock_released: false,
    });
    for (const [menuItemId, name, price, qty] of items) {
      S.orderItems.push({
        id: uid(), order_id: id, menu_item_id: menuItemId, meal_id: menuItemId,
        meal_name: name, meal_description: null, unit_price_ugx: price,
        quantity: qty, line_total_ugx: price * qty,
      });
      const mi = S.menuItems.find((m) => m.id === menuItemId);
      if (mi) mi.servings_reserved = (mi.servings_reserved as number) + qty;
    }
    S.events.push({
      id: uid(), order_id: id, event_type: 'placed', from_status: null,
      to_status: 'confirmed', note: 'Order placed', actor_id: employee,
      created_at: new Date(Date.now() - 1000 * 60 * 90).toISOString(),
    });
    return id;
  };
  // Two with SIMULATED payment evidence so the preparation queue and the
  // fulfilment controls are exercisable, and one genuinely unpaid so the
  // payment-first rule is visible on screen.
  seedOrder(MOCK_COLLEAGUE, [[iMatoke, 'Matoke with Beef Stew', 8000, 1]], 'confirmed', true);
  seedOrder(MOCK_COLLEAGUE, [[iPilau, 'Chicken Pilau', 9000, 2]], 'preparing', true);
  seedOrder(MOCK_EMPLOYEE, [[iPosho, 'Posho and Beans', 5000, 1]], 'ready', true, 'wallet');
  seedOrder(MOCK_EMPLOYEE, [[iGnuts, 'Steamed Greens', 2500, 1]], 'confirmed', false, 'mobile_money');

  S.exceptions.push({
    id: uid(), order_id: null, kind: 'STOCK_UNAVAILABLE',
    detail: { note: 'Greens ran short at 13:10; two orders were substituted.' },
    resolved_at: null, resolved_by: null, raised_by: MOCK_COORDINATOR, raised_via: 'coordinator',
    created_at: new Date().toISOString(),
  });

  audit('coordinator', MOCK_COORDINATOR, 'appointed', 'Initial Food Coordinator appointment');
}

// ─────────────────────────── helpers ───────────────────────────

function periodOpen(p: Row): boolean {
  const { time } = kampalaNow();
  return time >= String(p.ordering_opens_at) && time <= String(p.ordering_closes_at);
}
function remaining(mi: Row): number | null {
  return mi.servings_total === null ? null
    : (mi.servings_total as number) - (mi.servings_reserved as number);
}
function soldOut(mi: Row): boolean {
  const r = remaining(mi);
  return Boolean(mi.sold_out) || (r !== null && r <= 0);
}

/**
 * An order the kitchen still owes food for. Production counts only paid ones;
 * here payment is impossible, so every live order counts.
 */
function isOutstanding(o: Row): boolean {
  if (['cancelled', 'collected', 'delivered'].includes(String(o.fulfilment_status))) return false;
  return FULFILMENT_REQUIRES_PAYMENT ? o.payment_status === 'paid' : true;
}

/** An order the kitchen is allowed to work on. */
function isPreparable(o: Row): boolean {
  if (!['confirmed', 'preparing'].includes(String(o.fulfilment_status))) return false;
  return FULFILMENT_REQUIRES_PAYMENT ? o.payment_status === 'paid' : true;
}

// ─────────────────────────── RPC surface ───────────────────────────

type Args = Record<string, unknown>;

const RPC: Record<string, (a: Args) => unknown> = {
  // Mirrors food_coordinator_candidates(): active-coordinator only, id + name
  // only, never the caller. Enforcing the gate here too means the UI is tested
  // against the same refusal the live service gives.
  food_coordinator_candidates: () => {
    requireActiveCoordinator();
    return Object.entries(PEOPLE)
      .filter(([id]) => id !== currentUser)
      .map(([user_id, full_name]) => ({ user_id, full_name }))
      .sort((a, b) => a.full_name.localeCompare(b.full_name));
  },

  is_food_coordinator: (a) => isCoordinator((a._user_id as string) ?? currentUser),
  is_active_food_coordinator: (a) => isActiveCoordinator((a._user_id as string) ?? currentUser),

  food_menu_for_day: (a) => {
    const day = (a.p_service_date as string) ?? foodToday();
    return {
      service_date: day,
      closed: S.closures.some((c) => c.closure_date === day),
      checkout_enabled: false,
      payment_modes: [...FOOD_PAYMENT_MODES],
      max_qty_per_line: FOOD_MAX_QTY_PER_LINE,
      max_instructions_length: FOOD_MAX_INSTRUCTIONS,
      periods: S.periods.filter((p) => p.active).map((p) => ({
        period_id: p.id, name: p.name,
        ordering_opens_at: p.ordering_opens_at, ordering_closes_at: p.ordering_closes_at,
        ordering_open: periodOpen(p) && day === foodToday(),
        collection_instructions: p.collection_instructions,
        max_qty_per_employee: p.max_qty_per_employee,
        meals: S.menuItems
          .filter((mi) => mi.service_date === day && mi.period_id === p.id && mi.published_at
            && S.meals.find((x) => x.id === mi.meal_id)?.status === 'published')
          .map((mi) => {
            const m = S.meals.find((x) => x.id === mi.meal_id)!;
            const c = S.categories.find((x) => x.id === m.category_id);
            return {
              menu_item_id: mi.id, meal_id: m.id, name: m.name, description: m.description,
              image_path: m.image_path, category: c?.name ?? null, price_ugx: mi.price_ugx,
              servings_total: mi.servings_total, servings_remaining: remaining(mi),
              sold_out: soldOut(mi),
            };
          })
          .sort((x, y) => String(x.name).localeCompare(String(y.name))),
      })).sort((x, y) => String(x.ordering_opens_at).localeCompare(String(y.ordering_opens_at))),
    };
  },

  food_place_order: (a) => {
    const key = a.p_idempotency_key as string;
    const replay = S.orders.find((o) => o.idempotency_key === key);
    if (replay) {
      return { order_id: replay.id, order_reference: replay.order_reference,
        total_ugx: replay.total_ugx, payment_status: replay.payment_status,
        payment_mode: replay.payment_mode, replayed: true };
    }
    const notes = ((a.p_special_instructions as string | null) ?? '').trim() || null;
    if (notes && notes.length > FOOD_MAX_INSTRUCTIONS) {
      fail(`Special instructions can be at most ${FOOD_MAX_INSTRUCTIONS} characters`);
    }
    const raw = (a.p_items as Array<{ menu_item_id: string; quantity: number }>) ?? [];
    if (!raw.length) fail('Your order is empty');
    const mode = a.p_payment_mode as string | null | undefined;
    if (!mode || !(FOOD_PAYMENT_MODES as readonly string[]).includes(mode)) {
      fail('Choose how you will pay: cash, wallet or mobile money');
    }

    const basket = new Map<string, number>();
    for (const line of raw) {
      if (!line.quantity || line.quantity <= 0) fail('Every line needs a quantity of at least 1');
      basket.set(line.menu_item_id, (basket.get(line.menu_item_id) ?? 0) + line.quantity);
    }
    if ([...basket.values()].some((q) => q > FOOD_MAX_QTY_PER_LINE)) {
      fail(`You can order at most ${FOOD_MAX_QTY_PER_LINE} servings of one meal`);
    }

    let date: string | null = null; let period: string | null = null; let total = 0;
    const lines: Array<{ mi: Row; m: Row; qty: number }> = [];
    for (const [menuItemId, qty] of basket) {
      const mi = S.menuItems.find((x) => x.id === menuItemId);
      if (!mi) fail('One of the meals is no longer on the menu');
      const m = S.meals.find((x) => x.id === mi.meal_id)!;
      if (!mi.published_at || m.status !== 'published') fail(`Meal "${m.name}" is not available to order`);
      if (soldOut(mi)) fail(`Meal "${m.name}" is sold out`);
      if (date === null) { date = String(mi.service_date); period = String(mi.period_id); }
      if (mi.service_date !== date || mi.period_id !== period) {
        fail('An order cannot mix service periods or dates');
      }
      const left = remaining(mi);
      if (left !== null && qty > left) fail('Not enough servings left for that quantity');
      total += (mi.price_ugx as number) * qty;
      lines.push({ mi, m, qty });
    }

    if (S.closures.some((c) => c.closure_date === date)) fail(`Food service is closed on ${date}`);
    if (date !== foodToday()) fail('Orders can only be placed for today');
    const p = S.periods.find((x) => x.id === period);
    if (!p || !p.active || !periodOpen(p)) fail('Ordering for this service period is closed');

    const max = p.max_qty_per_employee as number | null;
    if (max !== null) {
      const already = S.orders
        .filter((o) => o.employee_id === currentUser && o.service_date === date
          && o.period_id === period && o.fulfilment_status !== 'cancelled')
        .reduce((t, o) => t + S.orderItems.filter((i) => i.order_id === o.id)
          .reduce((s, i) => s + (i.quantity as number), 0), 0);
      const asked = [...basket.values()].reduce((s, n) => s + n, 0);
      if (already + asked > max) {
        fail(`You can order at most ${max} item(s) for this service period, and you already have ${already}`);
      }
    }

    const id = uid();
    const ref = 'FO-' + foodToday().slice(2).replace(/-/g, '') + '-' +
      id.replace(/-/g, '').slice(0, 6).toUpperCase();
    // No payment. Nothing here reads or writes a wallet, balance or ledger entry.
    S.orders.unshift({
      id, order_reference: ref, employee_id: currentUser,
      employee_name: PEOPLE[currentUser] ?? 'Employee', service_date: date, period_id: period,
      total_ugx: total, payment_status: 'pending_payment', fulfilment_status: 'confirmed',
      transaction_group_id: null, idempotency_key: key,
      special_instructions: notes, payment_mode: mode,
      placed_at: new Date().toISOString(), paid_at: null, cancelled_at: null,
      stock_released: false,
    });
    for (const { mi, m, qty } of lines) {
      S.orderItems.push({
        id: uid(), order_id: id, menu_item_id: mi.id, meal_id: m.id, meal_name: m.name,
        meal_description: m.description, unit_price_ugx: mi.price_ugx, quantity: qty,
        line_total_ugx: (mi.price_ugx as number) * qty,
      });
      mi.servings_reserved = (mi.servings_reserved as number) + qty;
    }
    S.events.push({
      id: uid(), order_id: id, event_type: 'placed', from_status: null, to_status: 'confirmed',
      note: `Unpaid order placed; payment mode ${mode}, payable after delivery`,
      actor_id: currentUser, created_at: new Date().toISOString(),
    });
    return { order_id: id, order_reference: ref, total_ugx: total,
      payment_status: 'pending_payment', payment_mode: mode, replayed: false };
  },

  // Mirrors food_confirm_receipt (20261013128000): the ordering employee only,
  // after hand-over; the active coordinator is snapshotted as the payee.
  food_confirm_receipt: (a) => {
    const o = S.orders.find((x) => x.id === a.p_order_id);
    if (!o) fail('Order not found');
    if (o.employee_id !== currentUser) fail('Only the person who placed this order can confirm receiving it');
    if (o.received_at) return { status: 'already_confirmed', order_id: o.id, payee_id: o.payee_id,
      payee_name: o.payee_name, payee_wallet_id: o.payee_wallet_id ?? null, amount_due: o.total_ugx };
    if (!['delivered', 'collected'].includes(String(o.fulfilment_status))) fail('This order has not been handed over yet');
    const active = S.assignments.find((c) => !c.revoked_at && c.access_level === 'active');
    if (!active) fail('There is no active Food Coordinator to pay; try again later');
    o.received_at = new Date().toISOString();
    o.received_by = currentUser;
    o.payee_id = active.coordinator_id;
    // the fixture has no wallets: the name is recorded, the wallet id stays empty
    o.payee_name = PEOPLE[String(active.coordinator_id)] ?? 'Food Coordinator';
    o.payee_wallet_id = null;
    S.events.push({ id: uid(), order_id: o.id, event_type: 'receipt_confirmed', from_status: o.fulfilment_status,
      to_status: o.fulfilment_status, note: 'Employee confirmed receipt; payment now available', actor_id: currentUser,
      created_at: new Date().toISOString() });
    return { status: 'confirmed', order_id: o.id, payee_id: o.payee_id, payee_name: o.payee_name,
      payee_wallet_id: null, amount_due: o.total_ugx };
  },

  // The fixture has no wallets or ledger, so it can never take a payment. It
  // applies the same preconditions as the server, then refuses.
  // Every call carries the FOOD_CHECKOUT_DISABLED marker, whatever the order,
  // so no fixture path can ever look like a settled payment.
  // The fixture never takes a payment, so there is nothing to reconcile; the
  // same caller rule and cap as the server apply.
  food_reconcile_payments: (a) => {
    requireActiveCoordinator();
    const limit = a.p_limit === undefined ? 100 : Number(a.p_limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail('Batch size must be between 1 and 500');
    return { checked: 0, reversed: 0, limit, more_pending: false };
  },

  // Mirrors food_authorize_payment_retry's rules. The fixture never takes a
  // payment, so no order is ever reversed and this always refuses.
  food_authorize_payment_retry: (a) => {
    requireActiveCoordinator();
    if (typeof a.p_reason !== 'string' || a.p_reason.trim().length < 10) fail('Give a reason of at least 10 characters');
    const o = S.orders.find((x) => x.id === a.p_order_id);
    if (!o) fail('Order not found');
    if (o.employee_id === currentUser) fail('You cannot authorise a new payment attempt for your own order');
    fail(`Only an order whose payment was reversed can get a new payment attempt (this one is ${o.payment_status})`);
  },

  // REV-D1 / HND-D1 mirrors. The fixture never takes a payment, so nothing is
  // ever paid (to reverse) or blocked (to take over); the caller rules and
  // the mandatory reason are applied, then the state rule refuses.
  food_reverse_payment: () => {
    fail('Only an authorised finance reviewer can reverse a canteen payment');
  },
  food_resolve_blocked_payment: (a) => {
    requireActiveCoordinator();
    if (typeof a.p_reason !== 'string' || a.p_reason.trim().length < 10) fail('Give a reason of at least 10 characters');
    const o = S.orders.find((x) => x.id === a.p_order_id);
    if (!o) fail('Order not found');
    if (o.employee_id === currentUser) fail('You cannot take over the payment for your own order');
    fail('This order is not blocked on its payee');
  },

  food_pay_order: (a) => {
    const o = S.orders.find((x) => x.id === a.p_order_id);
    const why = !o ? 'order not found'
      : o.employee_id !== currentUser ? 'only the person who placed this order can pay for it'
      : !o.received_at ? 'confirm that you received your order before paying'
      : 'wallet payment is not available in the development fixture';
    fail(`${FOOD_CHECKOUT_DISABLED}: ${why}.`);
  },

  food_cancel_my_order: (a) => {
    const o = S.orders.find((x) => x.id === a.p_order_id);
    if (!o) fail('Order not found');
    if (o.employee_id !== currentUser) fail('That is not your order');
    if (o.fulfilment_status !== 'confirmed') fail('The kitchen has already started this order');
    if (o.payment_status === 'paid') fail('Paid orders are cancelled by the Food Coordinator');
    o.fulfilment_status = 'cancelled';
    o.cancelled_at = new Date().toISOString();
    if (!o.stock_released) {
      o.stock_released = true;
      for (const i of S.orderItems.filter((x) => x.order_id === o.id)) {
        const mi = S.menuItems.find((m) => m.id === i.menu_item_id);
        if (mi) mi.servings_reserved = Math.max(0, (mi.servings_reserved as number) - (i.quantity as number));
      }
    }
    S.events.push({
      id: uid(), order_id: o.id, event_type: 'cancelled', from_status: 'confirmed',
      to_status: 'cancelled', note: (a.p_reason as string) ?? 'Withdrawn by the employee',
      actor_id: currentUser, created_at: new Date().toISOString(),
    });
    return { order_id: o.id, status: 'cancelled' };
  },

  food_set_fulfilment: (a) => {
    requireActiveCoordinator();
    const o = S.orders.find((x) => x.id === a.p_order_id);
    if (!o) fail('Order not found');
    const from = o.fulfilment_status as FoodFulfilmentStatus;
    const to = a.p_to_status as FoodFulfilmentStatus;
    if (['collected', 'delivered', 'cancelled'].includes(from)) {
      fail(`Order is already ${from} and cannot be changed here`);
    }
    if (!FOOD_ALLOWED_TRANSITIONS[from]?.includes(to)) fail(`Invalid transition ${from} -> ${to}`);
    if (to === 'preparing' && !canStartPreparing(from, o.payment_status as FoodPaymentStatus,
        { requirePayment: FULFILMENT_REQUIRES_PAYMENT })) {
      fail('Unpaid orders cannot enter preparation');
    }
    // payment_status is never touched by a fulfilment change, in either
    // environment: the two statuses are independent by design
    o.fulfilment_status = to;
    S.events.push({
      id: uid(), order_id: o.id, event_type: 'fulfilment', from_status: from, to_status: to,
      note: (a.p_note as string) ?? null, actor_id: currentUser,
      created_at: new Date().toISOString(),
    });
    audit('order', String(o.id), `fulfilment_${to}`, (a.p_note as string) ?? null,
      { from }, { to });
    return { order_id: o.id, from, to };
  },

  food_coordinator_overview: (a) => {
    if (!isCoordinator()) fail('Not authorised to view Food Management');
    const day = (a.p_service_date as string) ?? foodToday();
    const of = (f: string) => S.orders.filter((o) => o.service_date === day && o.fulfilment_status === f).length;
    return {
      service_date: day, checkout_enabled: false,
      fulfilment_requires_payment: FULFILMENT_REQUIRES_PAYMENT,
      menu_published: S.menuItems.filter((m) => m.service_date === day && m.published_at).length,
      orders_today: S.orders.filter((o) => o.service_date === day).length,
      unpaid_orders: S.orders.filter((o) => o.service_date === day
        && o.payment_status === 'pending_payment' && o.fulfilment_status !== 'cancelled').length,
      unpaid_handed_over: S.orders.filter((o) => o.service_date === day
        && o.payment_status === 'pending_payment'
        && ['collected', 'delivered'].includes(String(o.fulfilment_status))).length,
      by_payment_mode: S.orders
        .filter((o) => o.service_date === day && o.fulfilment_status !== 'cancelled' && o.payment_mode)
        .reduce<Record<string, number>>((t, o) => {
          const k = String(o.payment_mode); t[k] = (t[k] ?? 0) + 1; return t;
        }, {}),
      awaiting_prep: S.orders.filter((o) => o.service_date === day
        && isPreparable(o) && o.fulfilment_status === 'confirmed').length,
      preparing: of('preparing'), ready: of('ready'), cancelled: of('cancelled'),
      completed: S.orders.filter((o) => o.service_date === day
        && ['collected', 'delivered'].includes(String(o.fulfilment_status))).length,
      open_exceptions: S.exceptions.filter((e) => !e.resolved_at).length,
      // zero here, and it should be: nothing in this store is ever paid
      paid_order_total_ugx: S.orders.filter((o) => o.service_date === day && o.payment_status === 'paid')
        .reduce((t, o) => t + (o.total_ugx as number), 0),
    };
  },

  // Mirrors food_people_names(): coordinator only; names of food participants.
  food_people_names: (a) => {
    if (!isCoordinator()) fail('Not authorised');
    const ids = (a.p_ids as string[] | null) ?? [];
    return ids.filter((id) => PEOPLE[id]).map((id) => ({ user_id: id, full_name: PEOPLE[id] }));
  },

  food_preparation_list: (a) => {
    if (!isCoordinator()) fail('Not authorised');
    const day = (a.p_service_date as string) ?? foodToday();
    const period = a.p_period_id as string | null;
    const rows = new Map<string, { total: number; orders: Set<string> }>();
    for (const o of S.orders) {
      if (o.service_date !== day) continue;
      if (!isPreparable(o)) continue;
      if (period && o.period_id !== period) continue;
      for (const i of S.orderItems.filter((x) => x.order_id === o.id)) {
        const r = rows.get(String(i.meal_name)) ?? { total: 0, orders: new Set<string>() };
        r.total += i.quantity as number; r.orders.add(String(o.id));
        rows.set(String(i.meal_name), r);
      }
    }
    return [...rows.entries()]
      .map(([meal_name, r]) => ({ meal_name, total_quantity: r.total, order_count: r.orders.size }))
      .sort((a1, b1) => b1.total_quantity - a1.total_quantity);
  },

  food_upsert_meal: (a) => {
    const actor = requireActiveCoordinator();
    // mirrors 20261013120001: photos only through food_set_meal_image
    if (a.p_image_path !== undefined && a.p_image_path !== null) {
      fail('Meal photos are set with food_set_meal_image, not here');
    }
    const name = String(a.p_name ?? '').trim();
    if (!name) fail('Meal name is required');
    const price = Number(a.p_price_ugx);
    if (!(price >= 0)) fail('Price must be zero or more');
    if (!a.p_meal_id) {
      const row = {
        id: uid(), name, description: a.p_description ?? null, image_path: null,
        category_id: a.p_category_id ?? null, price_ugx: price, status: 'draft',
        archived_at: null, created_by: actor, created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      S.meals.push(row);
      audit('meal', row.id, 'created', a.p_reason as string, null, { name, price_ugx: price });
      return row.id;
    }
    const m = S.meals.find((x) => x.id === a.p_meal_id);
    if (!m) fail('Meal not found');
    if (m.status === 'archived') fail('Archived meals cannot be edited');
    const before = { ...m };
    Object.assign(m, {
      name, description: a.p_description ?? null, category_id: a.p_category_id ?? null,
      price_ugx: price,
      updated_at: new Date().toISOString(),
    });
    audit('meal', String(m.id), 'updated', a.p_reason as string, before, { ...m });
    return m.id;
  },

  food_set_meal_status: (a) => {
    requireActiveCoordinator();
    const status = String(a.p_status);
    if (!['draft', 'published', 'archived'].includes(status)) fail(`Unknown meal status ${status}`);
    const m = S.meals.find((x) => x.id === a.p_meal_id);
    if (!m) fail('Meal not found');
    const before = { ...m };
    m.status = status;
    m.archived_at = status === 'archived' ? new Date().toISOString() : null;
    audit('meal', String(m.id), `status_${status}`, a.p_reason as string, before, { ...m });
  },

  // Mirrors food_set_meal_image(): active coordinator only, not on an archived
  // meal, NULL removes the photo, every change audited. The fixture stores a
  // local preview URL in place of a storage object name.
  food_set_meal_image: (a) => {
    requireActiveCoordinator();
    const m = S.meals.find((x) => x.id === a.p_meal_id);
    if (!m) fail('Meal not found');
    if (m.status === 'archived') fail('Archived meals cannot be edited');
    const path = (a.p_image_path as string | null) || null;
    const before = { ...m };
    m.image_path = path;
    audit('meal', String(m.id), path ? 'photo_set' : 'photo_removed', a.p_reason as string, before, { ...m });
    return { meal_id: m.id, image_path: path };
  },

  food_schedule_meal: (a) => {
    const actor = requireActiveCoordinator();
    const day = String(a.p_service_date);
    if (day < foodToday()) fail('Cannot schedule a meal in the past');
    if (S.closures.some((c) => c.closure_date === day)) fail(`Service is closed on ${day}`);
    const total = a.p_servings_total === null || a.p_servings_total === undefined
      ? null : Number(a.p_servings_total);
    if (total !== null && total < 0) fail('Servings cannot be negative');

    const existing = S.menuItems.find((mi) => mi.service_date === day
      && mi.period_id === a.p_period_id && mi.meal_id === a.p_meal_id);
    if (existing && total !== null && (existing.servings_reserved as number) > total) {
      fail('Cannot set the serving cap below the quantity already ordered');
    }
    const m = S.meals.find((x) => x.id === a.p_meal_id && x.status === 'published');
    if (!m) fail('Meal not found or not published');
    const price = a.p_price_ugx === null || a.p_price_ugx === undefined
      ? (m.price_ugx as number) : Number(a.p_price_ugx);

    if (existing) {
      existing.price_ugx = price;
      existing.servings_total = total;
      existing.published_at = a.p_publish ? (existing.published_at ?? new Date().toISOString()) : null;
      audit('menu_item', String(existing.id),
        a.p_publish ? 'scheduled_published' : 'scheduled_draft', null, null,
        { service_date: day, price_ugx: price, servings_total: total });
      return existing.id;
    }
    const row = {
      id: uid(), service_date: day, period_id: a.p_period_id, meal_id: a.p_meal_id,
      price_ugx: price, servings_total: total, servings_reserved: 0, sold_out: false,
      published_at: a.p_publish ? new Date().toISOString() : null, created_by: actor,
    };
    S.menuItems.push(row);
    audit('menu_item', row.id, a.p_publish ? 'scheduled_published' : 'scheduled_draft', null,
      null, { service_date: day, price_ugx: price, servings_total: total });
    return row.id;
  },

  food_set_sold_out: (a) => {
    requireActiveCoordinator();
    const mi = S.menuItems.find((x) => x.id === a.p_menu_item_id);
    if (!mi) fail('Menu item not found');
    mi.sold_out = Boolean(a.p_sold_out);
    audit('menu_item', String(mi.id), a.p_sold_out ? 'sold_out' : 'available', a.p_reason as string);
  },

  // Mirrors food_can_use_canteen(): every fixture identity is staff.
  food_can_use_canteen: () => true,

  // Mirrors food_raise_exception(): the active coordinator logs one with or
  // without an order; an employee reports on their OWN order, one open report
  // per order. Operational only — no status or money effect.
  food_raise_exception: (a) => {
    const kind = a.p_kind as string;
    if (!(FOOD_EXCEPTION_KINDS as readonly string[]).includes(kind)) fail('Unknown exception kind');
    const note = String(a.p_note ?? '').trim();
    if (!note) fail('Describe the problem');
    if (note.length > FOOD_MAX_EXCEPTION_NOTE) fail(`The description can be at most ${FOOD_MAX_EXCEPTION_NOTE} characters`);
    const orderId = (a.p_order_id as string | null) ?? null;
    const order = orderId ? S.orders.find((o) => o.id === orderId) : null;
    if (orderId && !order) fail('Order not found');
    const coord = isActiveCoordinator();
    if (!coord) {
      if (!orderId) fail('Choose the order the problem is about');
      if (order!.employee_id !== currentUser) fail('You can only report a problem with your own order');
      if (S.exceptions.some((e) => e.order_id === orderId && e.raised_by === currentUser
          && e.raised_via === 'employee' && !e.resolved_at)) {
        fail('You already have an open report on this order');
      }
    }
    const row = {
      id: uid(), order_id: orderId, kind, detail: { note }, resolved_at: null, resolved_by: null,
      resolution_reason: null, raised_by: currentUser, raised_via: coord ? 'coordinator' : 'employee',
      created_at: new Date().toISOString(),
    };
    S.exceptions.push(row);
    audit('exception', String(row.id), 'raised', note, null, { ...row });
    if (!coord) {
      S.events.push({
        id: uid(), order_id: orderId, event_type: 'problem_reported', from_status: null,
        to_status: null, note: kind, actor_id: currentUser, created_at: new Date().toISOString(),
      });
    }
    return { exception_id: row.id, kind, order_id: orderId, raised_via: row.raised_via };
  },

  // Mirrors food_resolve_exception(): active coordinator only, mandatory
  // trimmed reason, evidence preserved, no re-resolution, append-only audit.
  food_resolve_exception: (a) => {
    const actor = requireActiveCoordinator();
    const reason = String(a.p_reason ?? '').trim();
    if (!reason) fail('A resolution reason is required');
    if (!a.p_exception_id) fail('An exception id is required');
    const e = S.exceptions.find((x) => x.id === a.p_exception_id);
    if (!e) fail('That food exception does not exist');
    if (e.resolved_at) fail('That exception was already resolved');

    const before = { ...e };
    e.resolved_at = new Date().toISOString();
    e.resolved_by = actor;
    e.resolution_reason = reason;
    // `kind` and `detail` are untouched: the original evidence survives.
    audit('exception', String(e.id), 'resolved', reason, before, { ...e });
    return {
      exception_id: e.id, resolved_by: actor,
      resolved_at: e.resolved_at, reason,
    };
  },

  food_upsert_category: (a) => {
    requireActiveCoordinator();
    const name = String(a.p_name ?? '').trim();
    if (!name) fail('Category name is required');
    if (!a.p_category_id) {
      const row = { id: uid(), name, sort_order: Number(a.p_sort_order ?? 100), archived_at: null };
      S.categories.push(row);
      audit('category', row.id, 'created', a.p_reason as string, null, { name });
      return row.id;
    }
    const c = S.categories.find((x) => x.id === a.p_category_id);
    if (!c) fail('Category not found');
    const before = { ...c };
    c.name = name;
    c.sort_order = Number(a.p_sort_order ?? c.sort_order);
    audit('category', String(c.id), 'updated', a.p_reason as string, before, { ...c });
    return c.id;
  },

  food_archive_category: (a) => {
    requireActiveCoordinator();
    const live = S.meals.filter((m) => m.category_id === a.p_category_id && m.status !== 'archived').length;
    if (live > 0) fail(`Move or archive the ${live} meal(s) in this category first`);
    const c = S.categories.find((x) => x.id === a.p_category_id);
    if (!c) fail('Category not found');
    c.archived_at = new Date().toISOString();
    audit('category', String(c.id), 'archived', a.p_reason as string);
  },

  food_upsert_service_period: (a) => {
    requireActiveCoordinator();
    const name = String(a.p_name ?? '').trim();
    if (!name) fail('Period name is required');
    const opens = String(a.p_opens_at ?? ''); const closes = String(a.p_closes_at ?? '');
    if (!opens || !closes || closes <= opens) fail('Ordering must close after it opens');
    const max = a.p_max_qty_per_employee === null || a.p_max_qty_per_employee === undefined
      ? null : Number(a.p_max_qty_per_employee);
    if (max !== null && max <= 0) fail('The per-employee limit must be at least 1');

    if (!a.p_period_id) {
      const row = {
        id: uid(), name, ordering_opens_at: opens, ordering_closes_at: closes,
        collection_instructions: a.p_collection_instructions ?? null,
        max_qty_per_employee: max, active: a.p_active ?? true,
      };
      S.periods.push(row);
      audit('period', row.id, 'created', a.p_reason as string, null, { name, opens, closes });
      return row.id;
    }
    const p = S.periods.find((x) => x.id === a.p_period_id);
    if (!p) fail('Service period not found');
    const before = { ...p };
    Object.assign(p, {
      name, ordering_opens_at: opens, ordering_closes_at: closes,
      collection_instructions: a.p_collection_instructions ?? null,
      max_qty_per_employee: max, active: a.p_active ?? p.active,
    });
    audit('period', String(p.id), 'updated', a.p_reason as string, before, { ...p });
    return p.id;
  },

  food_set_closure: (a) => {
    requireActiveCoordinator();
    const day = String(a.p_closure_date);
    if (a.p_closed) {
      const reason = String(a.p_reason ?? '').trim();
      if (!reason) fail('A reason is required to close a service day');
      const outstanding = S.orders.filter((o) => o.service_date === day && isOutstanding(o)).length;
      if (outstanding > 0) {
        fail(`Cannot close ${day}: ${outstanding} order(s) are still outstanding`);
      }
      const existing = S.closures.find((c) => c.closure_date === day);
      if (existing) existing.reason = reason;
      else S.closures.push({ closure_date: day, reason, created_at: new Date().toISOString() });
      audit('closure', null, 'closed', reason, null, { date: day });
    } else {
      S.closures = S.closures.filter((c) => c.closure_date !== day);
      audit('closure', null, 'reopened', a.p_reason as string, null, { date: day });
    }
  },

  food_transfer_coordinator: (a) => {
    const actor = requireActiveCoordinator();
    const mode = String(a.p_mode);
    if (!['full_transfer', 'transfer_with_backup'].includes(mode)) {
      fail('Handover mode must be full_transfer or transfer_with_backup');
    }
    const reason = String(a.p_reason ?? '');
    if (reason.trim().length < 10) fail('A reason of at least 10 characters is required');
    const to = String(a.p_to_user_id);
    if (to === actor) fail('Cannot hand over to yourself');
    const name = PEOPLE[to];
    if (!name) fail('Incoming coordinator account could not be verified');

    const now = new Date().toISOString();
    for (const x of S.assignments) {
      if (!x.revoked_at && (x.coordinator_id === actor || x.coordinator_id === to)) {
        x.revoked_at = now; x.revoked_by = actor;
        if (x.coordinator_id === actor) { x.handover_mode = mode; x.reason = reason; }
        else x.reason = 'Superseded by handover';
      }
    }
    S.assignments.push({
      id: uid(), coordinator_id: to, access_level: 'active', assigned_by: actor,
      assigned_at: now, revoked_at: null, revoked_by: null, handover_mode: mode, reason,
    });
    if (mode === 'transfer_with_backup') {
      S.assignments.push({
        id: uid(), coordinator_id: actor, access_level: 'backup', assigned_by: actor,
        assigned_at: now, revoked_at: null, revoked_by: null, handover_mode: mode,
        reason: 'Retained read-only backup access',
      });
    }
    audit('coordinator', to, `handover_${mode}`, reason, { from: actor }, { to, mode });
    return { status: 'transferred', from: actor, to, to_name: name, mode };
  },
};

/** Answers an RPC from the fixture store. Rejects to mirror a server error. */
export async function foodMockRpc<T>(fn: string, args: Args = {}): Promise<T> {
  seed();
  const impl = RPC[fn];
  if (!impl) throw new Error(`Fixture backend has no implementation for ${fn}`);
  // a touch of latency so loading states are actually visible while building
  await new Promise((r) => setTimeout(r, 120));
  return impl(args) as T;
}

/** Answers the direct table reads the hooks make, with the same RLS shape. */
export async function foodMockSelect<T>(
  table: string,
  opts: { serviceDate?: string; mineOnly?: boolean; entity?: string; entityId?: string;
          includeArchived?: boolean; includeInactive?: boolean } = {},
): Promise<T> {
  seed();
  await new Promise((r) => setTimeout(r, 120));
  const coordinator = isCoordinator();

  switch (table) {
    case 'food_orders': {
      let rows = S.orders;
      // mirrors the RLS policy: employees see only their own
      if (opts.mineOnly || !coordinator) rows = rows.filter((o) => o.employee_id === currentUser);
      if (opts.serviceDate) rows = rows.filter((o) => o.service_date === opts.serviceDate);
      return rows.map((o) => ({ ...o, items: S.orderItems.filter((i) => i.order_id === o.id) })) as T;
    }
    case 'food_order_events':
      return (opts.entityId
        ? S.events.filter((e) => e.order_id === opts.entityId)
        : S.events) as T;
    case 'food_audit': {
      if (!coordinator) return [] as unknown as T;
      let rows = S.audit;
      if (opts.entity) rows = rows.filter((r) => r.entity === opts.entity);
      if (opts.entityId) rows = rows.filter((r) => r.entity_id === opts.entityId);
      return rows as T;
    }
    case 'food_categories':
      return S.categories.filter((c) => opts.includeArchived || !c.archived_at) as T;
    case 'food_meals':
      return (coordinator ? S.meals : S.meals.filter((m) => m.status === 'published')) as T;
    case 'food_service_periods':
      return S.periods.filter((p) => opts.includeInactive || p.active) as T;
    case 'food_service_closures':
      return S.closures as T;
    case 'food_exceptions':
      // RLS: the coordinator reads all; an employee reads the reports they raised
      return (coordinator ? S.exceptions
        : S.exceptions.filter((e) => e.raised_by === currentUser)) as T;
    case 'food_coordinator_assignments':
      return (coordinator
        ? S.assignments.map((x) => ({ ...x, coordinator_name: PEOPLE[String(x.coordinator_id)] ?? 'Unknown' }))
        : []) as T;
    default:
      throw new Error(`Fixture backend has no table ${table}`);
  }
}

/** Preview helper: wipes the store so a demo can be replayed from scratch. */
export function resetFoodMock() {
  seeded = false;
  S.categories = []; S.meals = []; S.periods = []; S.closures = []; S.menuItems = [];
  S.orders = []; S.orderItems = []; S.events = []; S.exceptions = []; S.audit = [];
  S.assignments = [];
  currentUser = MOCK_EMPLOYEE;
}
