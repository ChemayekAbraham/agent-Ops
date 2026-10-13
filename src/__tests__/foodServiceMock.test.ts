import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import {
  foodMockRpc, foodMockSelect, resetFoodMock, actAsFoodCoordinator, setFoodMockUser,
  foodToday, MOCK_EMPLOYEE, MOCK_COORDINATOR, isFoodMockMode,
  SIMULATED_ORDER_PREFIX, SIMULATED_PAYMENT_TXN, isSimulatedPayment,
} from '@/lib/foodService.mock';
import {
  foodErrorMessage, formatUgx, isFoodCheckoutDisabled,
  type FoodMenuDay, type FoodOrderDetail, type FoodCoordinatorOverview,
} from '@/lib/foodService';

/**
 * The fixture backend is what the UI is built against while the migrations are
 * unapplied, so it has to behave like the server or Gemini will build screens
 * for rules that do not exist.
 *
 * Each expectation below mirrors a case proven against the real RPCs in the
 * sandbox on 2026-10-09 (suites C, D, M, N, P and Q). If the two ever disagree,
 * the server is right and this file is the bug.
 */

async function menu(): Promise<FoodMenuDay> {
  return foodMockRpc<FoodMenuDay>('food_menu_for_day', {});
}

/**
 * The seeded Lunch period (limit 5 per person), which these tests were written
 * against. Every seeded period now takes orders all day, so "the first open
 * one" would be Breakfast (limit 2); pick Lunch by name.
 */
async function openPeriod() {
  const m = await menu();
  const p = m.periods.find((x) => x.name === 'Lunch' && x.ordering_open);
  if (!p) throw new Error('fixture has no open ordering window');
  return p;
}

// The fixture's service windows are wall-clock based (Breakfast 06:30-09:00,
// Lunch 08:00-23:59, Africa/Kampala). Without a fixed clock these tests passed
// or failed depending on the hour they ran (master register FM-35). Pin only
// Date, to a Kampala noon, so testing-library's own timers stay real.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T09:00:00Z'));   // 12:00 in Kampala
});
afterAll(() => { vi.useRealTimers(); });

beforeEach(() => {
  resetFoodMock();
  setFoodMockUser(MOCK_EMPLOYEE);
});

describe('the fixture menu', () => {
  it('reports checkout as disabled, like the server does', async () => {
    expect((await menu()).checkout_enabled).toBe(false);
  });

  it('serves today in Kampala and is open', async () => {
    const m = await menu();
    expect(m.service_date).toBe(foodToday());
    expect(m.closed).toBe(false);
  });

  it('groups meals under service periods with collection instructions', async () => {
    const p = await openPeriod();
    expect(p.meals.length).toBeGreaterThan(0);
    expect(p.collection_instructions).toBeTruthy();
  });

  it('exposes what a card needs: price, category and remaining servings', async () => {
    const meal = (await openPeriod()).meals[0];
    expect(meal.price_ugx).toBeGreaterThan(0);
    expect(meal.name).toBeTruthy();
    expect(meal).toHaveProperty('category');
    expect(meal).toHaveProperty('servings_remaining');
    expect(meal).toHaveProperty('image_path');
  });

  it('hides draft and archived meals from the menu', async () => {
    const names = (await menu()).periods.flatMap((p) => p.meals.map((m) => m.name));
    expect(names).not.toContain('Fish Fillet');          // draft
    expect(names).not.toContain('Katogo (retired)');     // archived
  });
});

describe('placing an order', () => {
  it('creates it UNPAID and never attaches a wallet transaction', async () => {
    const p = await openPeriod();
    const res = await foodMockRpc<{ payment_status: string; order_id: string }>(
      'food_place_order',
      { p_items: [{ menu_item_id: p.meals[0].menu_item_id, quantity: 1 }], p_payment_mode: 'cash', p_idempotency_key: 'k1' },
    );
    expect(res.payment_status).toBe('pending_payment');

    const mine = await foodMockSelect<FoodOrderDetail[]>('food_orders', { mineOnly: true });
    const placed = mine.find((o) => o.id === res.order_id)!;
    expect(placed.transaction_group_id).toBeNull();
    expect(placed.paid_at).toBeNull();
  });

  it('computes the total on the server side, not from the cart', async () => {
    const p = await openPeriod();
    const meal = p.meals[0];
    const res = await foodMockRpc<{ total_ugx: number }>('food_place_order', {
      p_items: [{ menu_item_id: meal.menu_item_id, quantity: 2 }], p_payment_mode: 'cash', p_idempotency_key: 'k2',
    });
    expect(res.total_ugx).toBe(meal.price_ugx * 2);
  });

  it('reserves the servings it sold', async () => {
    const before = (await openPeriod()).meals.find((m) => m.servings_remaining !== null)!;
    await foodMockRpc('food_place_order', {
      p_items: [{ menu_item_id: before.menu_item_id, quantity: 2 }], p_payment_mode: 'cash', p_idempotency_key: 'k3',
    });
    const after = (await openPeriod()).meals.find((m) => m.menu_item_id === before.menu_item_id)!;
    expect(after.servings_remaining).toBe((before.servings_remaining as number) - 2);
  });

  it('replays an idempotency key instead of ordering twice', async () => {
    const p = await openPeriod();
    const args = {
      p_items: [{ menu_item_id: p.meals[0].menu_item_id, quantity: 1 }], p_payment_mode: 'cash', p_idempotency_key: 'same',
    };
    const first = await foodMockRpc<{ order_id: string; replayed: boolean }>('food_place_order', args);
    const second = await foodMockRpc<{ order_id: string; replayed: boolean }>('food_place_order', args);

    expect(second.order_id).toBe(first.order_id);
    expect(second.replayed).toBe(true);
    const mine = await foodMockSelect<FoodOrderDetail[]>('food_orders', { mineOnly: true });
    expect(mine.filter((o) => o.id === first.order_id)).toHaveLength(1);
  });

  it('collapses two lines for the same meal into one', async () => {
    const p = await openPeriod();
    const id = p.meals[0].menu_item_id;
    const res = await foodMockRpc<{ order_id: string; total_ugx: number }>('food_place_order', {
      p_items: [{ menu_item_id: id, quantity: 1 }, { menu_item_id: id, quantity: 1 }],
      p_payment_mode: 'cash', p_idempotency_key: 'dup',
    });
    const mine = await foodMockSelect<FoodOrderDetail[]>('food_orders', { mineOnly: true });
    expect(mine.find((o) => o.id === res.order_id)!.items).toHaveLength(1);
    expect(res.total_ugx).toBe(p.meals[0].price_ugx * 2);
  });

  it('rejects an empty cart', async () => {
    await expect(foodMockRpc('food_place_order', { p_items: [], p_payment_mode: 'cash', p_idempotency_key: 'e' }))
      .rejects.toThrow(/empty/i);
  });

  it('rejects a quantity of zero', async () => {
    const p = await openPeriod();
    await expect(foodMockRpc('food_place_order', {
      p_items: [{ menu_item_id: p.meals[0].menu_item_id, quantity: 0 }], p_payment_mode: 'cash', p_idempotency_key: 'z',
    })).rejects.toThrow(/at least 1/i);
  });

  it('rejects a meal that is not on the menu', async () => {
    await expect(foodMockRpc('food_place_order', {
      p_items: [{ menu_item_id: crypto.randomUUID(), quantity: 1 }], p_payment_mode: 'cash', p_idempotency_key: 'g',
    })).rejects.toThrow(/no longer on the menu/i);
  });

  // The seeded Lunch cap is 5 and this employee already holds 2 servings from
  // seeded orders, so the cap has to count what they already have, not just the
  // cart in front of them.
  it('counts orders already held against the per-employee cap', async () => {
    const p = await openPeriod();
    await expect(foodMockRpc('food_place_order', {
      p_items: [{ menu_item_id: p.meals[0].menu_item_id, quantity: 4 }],
      p_payment_mode: 'cash', p_idempotency_key: 'cap-over',
    })).rejects.toThrow(/at most 5 item\(s\).*already have 2/i);
  });

  it('allows an order up to the cap and refuses the one after it', async () => {
    const p = await openPeriod();
    const id = p.meals[0].menu_item_id;
    await expect(foodMockRpc('food_place_order', {
      p_items: [{ menu_item_id: id, quantity: 3 }], p_payment_mode: 'cash', p_idempotency_key: 'cap-ok',
    })).resolves.toBeTruthy();
    await expect(foodMockRpc('food_place_order', {
      p_items: [{ menu_item_id: id, quantity: 1 }], p_payment_mode: 'cash', p_idempotency_key: 'cap-after',
    })).rejects.toThrow(/at most 5/i);
  });

  it('refuses to oversell the last servings', async () => {
    // a meal whose remaining stock is under the 20-per-line bound, so the
    // stock check (not the line limit) is what refuses the order
    const meal = (await openPeriod()).meals.find(
      (m) => m.servings_remaining !== null && (m.servings_remaining as number) < 20)!;
    expect(meal).toBeTruthy();
    await expect(foodMockRpc('food_place_order', {
      p_items: [{ menu_item_id: meal.menu_item_id, quantity: (meal.servings_remaining as number) + 1 }],
      p_payment_mode: 'cash', p_idempotency_key: 'over',
    })).rejects.toThrow(/not enough servings/i);
  });

  it('will not mix two service periods in one order', async () => {
    const m = await menu();
    const [a, b] = m.periods;
    await expect(foodMockRpc('food_place_order', {
      p_items: [
        { menu_item_id: a.meals[0].menu_item_id, quantity: 1 },
        { menu_item_id: b.meals[0].menu_item_id, quantity: 1 },
      ],
      p_payment_mode: 'cash', p_idempotency_key: 'mix',
    })).rejects.toThrow(/mix service periods/i);
  });
});

describe('payment stays shut', () => {
  it('refuses with the marker the UI checks for', async () => {
    const err = await foodMockRpc('food_pay_order', { p_order_id: crypto.randomUUID() })
      .catch((e: Error) => e);
    expect(isFoodCheckoutDisabled(err)).toBe(true);
  });

  it('is the only thing blocked — ordering still works', async () => {
    const p = await openPeriod();
    await expect(foodMockRpc('food_place_order', {
      p_items: [{ menu_item_id: p.meals[0].menu_item_id, quantity: 1 }], p_payment_mode: 'cash', p_idempotency_key: 'ok',
    })).resolves.toBeTruthy();
  });
});

describe('withdrawing an order', () => {
  it('releases the servings back to the menu', async () => {
    const meal = (await openPeriod()).meals.find((m) => m.servings_remaining !== null)!;
    const before = meal.servings_remaining as number;
    const res = await foodMockRpc<{ order_id: string }>('food_place_order', {
      p_items: [{ menu_item_id: meal.menu_item_id, quantity: 2 }], p_payment_mode: 'cash', p_idempotency_key: 'c1',
    });
    await foodMockRpc('food_cancel_my_order', { p_order_id: res.order_id });
    const after = (await openPeriod()).meals.find((m) => m.menu_item_id === meal.menu_item_id)!;
    expect(after.servings_remaining).toBe(before);
  });

  it('cannot be done twice, and does not double-release stock', async () => {
    const meal = (await openPeriod()).meals.find((m) => m.servings_remaining !== null)!;
    const before = meal.servings_remaining as number;
    const res = await foodMockRpc<{ order_id: string }>('food_place_order', {
      p_items: [{ menu_item_id: meal.menu_item_id, quantity: 1 }], p_payment_mode: 'cash', p_idempotency_key: 'c2',
    });
    await foodMockRpc('food_cancel_my_order', { p_order_id: res.order_id });
    await expect(foodMockRpc('food_cancel_my_order', { p_order_id: res.order_id }))
      .rejects.toThrow(/already started/i);
    const after = (await openPeriod()).meals.find((m) => m.menu_item_id === meal.menu_item_id)!;
    expect(after.servings_remaining).toBe(before);
  });

  it('refuses someone else’s order', async () => {
    const all = await foodMockSelect<FoodOrderDetail[]>('food_orders', {});
    actAsFoodCoordinator(true);
    const colleagues = (await foodMockSelect<FoodOrderDetail[]>('food_orders', {}))
      .filter((o) => o.employee_id !== MOCK_COORDINATOR && o.employee_id !== MOCK_EMPLOYEE);
    setFoodMockUser(MOCK_EMPLOYEE);
    expect(all.length).toBeGreaterThanOrEqual(0);
    await expect(foodMockRpc('food_cancel_my_order', { p_order_id: colleagues[0].id }))
      .rejects.toThrow(/not your order/i);
  });
});

describe('permissions', () => {
  it('keeps an employee out of the coordinator overview', async () => {
    await expect(foodMockRpc('food_coordinator_overview', {})).rejects.toThrow(/Not authorised/i);
  });

  it('keeps an employee out of menu authoring', async () => {
    await expect(foodMockRpc('food_upsert_meal', { p_name: 'Rogue', p_price_ugx: 1 }))
      .rejects.toThrow(/active Food Coordinator/i);
  });

  it('shows an employee only their own orders', async () => {
    const mine = await foodMockSelect<FoodOrderDetail[]>('food_orders', { mineOnly: true });
    expect(mine.every((o) => o.employee_id === MOCK_EMPLOYEE)).toBe(true);
  });

  it('gives an employee no audit rows at all', async () => {
    expect(await foodMockSelect('food_audit', {})).toEqual([]);
  });

  it('lets the coordinator in', async () => {
    actAsFoodCoordinator(true);
    const o = await foodMockRpc<FoodCoordinatorOverview>('food_coordinator_overview', {});
    expect(o.checkout_enabled).toBe(false);
    expect(o.orders_today).toBeGreaterThan(0);
  });
});

describe('coordinator operations', () => {
  beforeEach(() => actAsFoodCoordinator(true));

  it('queues every live order still to prepare, paid or not', async () => {
    const rows = await foodMockRpc<Array<{ meal_name: string; total_quantity: number }>>(
      'food_preparation_list', {});
    const orders = await foodMockSelect<FoodOrderDetail[]>('food_orders', {});
    const expected = new Map<string, number>();
    for (const o of orders.filter((x) => x.service_date === foodToday()
      && ['confirmed', 'preparing'].includes(x.fulfilment_status))) {
      for (const i of o.items) expected.set(i.meal_name, (expected.get(i.meal_name) ?? 0) + i.quantity);
    }
    expect(new Map(rows.map((r) => [r.meal_name, r.total_quantity]))).toEqual(expected);
  });

  it('walks a paid order through the whole fulfilment chain', async () => {
    const orders = await foodMockSelect<FoodOrderDetail[]>('food_orders', {});
    const target = orders.find(
      (o) => o.fulfilment_status === 'confirmed' && o.payment_status === 'paid')!;

    await foodMockRpc('food_set_fulfilment', { p_order_id: target.id, p_to_status: 'preparing' });
    await foodMockRpc('food_set_fulfilment', { p_order_id: target.id, p_to_status: 'ready' });
    await foodMockRpc('food_set_fulfilment', { p_order_id: target.id, p_to_status: 'collected' });

    const after = (await foodMockSelect<FoodOrderDetail[]>('food_orders', {}))
      .find((o) => o.id === target.id)!;
    expect(after.fulfilment_status).toBe('collected');
  });

  it('prepares and delivers an order placed just now, which stays unpaid', async () => {
    setFoodMockUser(MOCK_EMPLOYEE);
    const p = await openPeriod();
    const res = await foodMockRpc<{ order_id: string }>('food_place_order', {
      p_items: [{ menu_item_id: p.meals[0].menu_item_id, quantity: 1 }], p_payment_mode: 'mobile_money', p_idempotency_key: 'unpaid',
    });
    actAsFoodCoordinator(true);
    for (const to of ['preparing', 'ready', 'delivered']) {
      await foodMockRpc('food_set_fulfilment', { p_order_id: res.order_id, p_to_status: to });
    }

    // payment is after delivery: handing the food over never marks it paid
    const after = (await foodMockSelect<FoodOrderDetail[]>('food_orders', {}))
      .find((o) => o.id === res.order_id)!;
    expect(after.fulfilment_status).toBe('delivered');
    expect(after.payment_status).toBe('pending_payment');
    expect(after.payment_mode).toBe('mobile_money');
    expect(after.transaction_group_id).toBeNull();
  });

  it('still refuses an invalid jump and a reopen', async () => {
    const orders = await foodMockSelect<FoodOrderDetail[]>('food_orders', {});
    const confirmed = orders.find(
      (o) => o.fulfilment_status === 'confirmed' && o.payment_status === 'paid')!;
    await expect(foodMockRpc('food_set_fulfilment', { p_order_id: confirmed.id, p_to_status: 'ready' }))
      .rejects.toThrow(/Invalid transition/i);

    const ready = orders.find((o) => o.fulfilment_status === 'ready')!;
    await foodMockRpc('food_set_fulfilment', { p_order_id: ready.id, p_to_status: 'collected' });
    await expect(foodMockRpc('food_set_fulfilment', { p_order_id: ready.id, p_to_status: 'preparing' }))
      .rejects.toThrow(/already collected/i);
  });

  it('reports payment-after-delivery and the unpaid count on the overview', async () => {
    const o = await foodMockRpc<FoodCoordinatorOverview>('food_coordinator_overview', {});
    expect(o.fulfilment_requires_payment).toBe(false);
    expect(o.unpaid_orders).toBeGreaterThan(0);
    expect(o.checkout_enabled).toBe(false);
  });

  it('records menu edits in the audit log', async () => {
    const before = (await foodMockSelect<unknown[]>('food_audit', { entity: 'meal' })).length;
    await foodMockRpc('food_upsert_meal', { p_name: 'Luwombo', p_price_ugx: 11000, p_reason: 'new dish' });
    const after = await foodMockSelect<Array<{ action: string }>>('food_audit', { entity: 'meal' });
    expect(after.length).toBe(before + 1);
    expect(after.some((r) => r.action === 'created')).toBe(true);
  });

  it('refuses a photo through food_upsert_meal, as the server does (P-2)', async () => {
    await expect(foodMockRpc('food_upsert_meal', { p_name: 'Rogue', p_price_ugx: 1, p_image_path: 'https://evil.example/x.png' }))
      .rejects.toThrow(/food_set_meal_image/);
    const meals = await foodMockSelect<Array<{ id: string; name: string; image_path: string | null }>>('food_meals', {});
    const withPhoto = meals.find((m) => m.image_path)!;
    await expect(foodMockRpc('food_upsert_meal', {
      p_meal_id: withPhoto.id, p_name: withPhoto.name, p_price_ugx: 1, p_image_path: 'data:image/png;base64,AAAA',
    })).rejects.toThrow(/food_set_meal_image/);
    // an ordinary edit keeps the photo it had
    await foodMockRpc('food_upsert_meal', { p_meal_id: withPhoto.id, p_name: withPhoto.name, p_price_ugx: 1 });
    const after = (await foodMockSelect<Array<{ id: string; image_path: string | null }>>('food_meals', {}))
      .find((m) => m.id === withPhoto.id)!;
    expect(after.image_path).toBe(withPhoto.image_path);
  });

  it('will not archive a category that still holds live meals', async () => {
    const cats = await foodMockSelect<Array<{ id: string; name: string }>>('food_categories', {});
    const main = cats.find((c) => c.name === 'Main Course')!;
    await expect(foodMockRpc('food_archive_category', { p_category_id: main.id }))
      .rejects.toThrow(/Move or archive/i);
  });

  it('will not close a day while orders are outstanding', async () => {
    await expect(foodMockRpc('food_set_closure', {
      p_closure_date: foodToday(), p_closed: true, p_reason: 'Trying to close early',
    })).rejects.toThrow(/outstanding/i);
  });

  it('needs a reason to close a day', async () => {
    await expect(foodMockRpc('food_set_closure', {
      p_closure_date: '2099-01-01', p_closed: true, p_reason: '',
    })).rejects.toThrow(/reason is required/i);
  });

  it('rejects a service period that closes before it opens', async () => {
    await expect(foodMockRpc('food_upsert_service_period', {
      p_name: 'Backwards', p_opens_at: '11:00', p_closes_at: '09:00',
    })).rejects.toThrow(/close after it opens/i);
  });
});

describe('coordinator handover', () => {
  beforeEach(() => actAsFoodCoordinator(true));

  it('refuses a self-transfer and a thin reason', async () => {
    await expect(foodMockRpc('food_transfer_coordinator', {
      p_to_user_id: MOCK_COORDINATOR, p_mode: 'full_transfer', p_reason: 'handing to myself please',
    })).rejects.toThrow(/yourself/i);
    await expect(foodMockRpc('food_transfer_coordinator', {
      p_to_user_id: MOCK_EMPLOYEE, p_mode: 'full_transfer', p_reason: 'short',
    })).rejects.toThrow(/at least 10/i);
  });

  it('refuses an account it cannot verify', async () => {
    await expect(foodMockRpc('food_transfer_coordinator', {
      p_to_user_id: crypto.randomUUID(), p_mode: 'full_transfer', p_reason: 'transferring to a stranger',
    })).rejects.toThrow(/could not be verified/i);
  });

  it('transfers, leaves the outgoing holder read-only, and audits it', async () => {
    const res = await foodMockRpc<{ status: string }>('food_transfer_coordinator', {
      p_to_user_id: MOCK_EMPLOYEE, p_mode: 'transfer_with_backup',
      p_reason: 'The coordinator is on leave for two weeks',
    });
    expect(res.status).toBe('transferred');

    expect(await foodMockRpc('is_active_food_coordinator', { _user_id: MOCK_EMPLOYEE })).toBe(true);
    expect(await foodMockRpc('is_active_food_coordinator', { _user_id: MOCK_COORDINATOR })).toBe(false);
    expect(await foodMockRpc('is_food_coordinator', { _user_id: MOCK_COORDINATOR })).toBe(true);

    setFoodMockUser(MOCK_EMPLOYEE);
    const trail = await foodMockSelect<Array<{ action: string }>>('food_audit', { entity: 'coordinator' });
    expect(trail.some((r) => r.action === 'handover_transfer_with_backup')).toBe(true);
  });

  it('keeps exactly one active coordinator afterwards', async () => {
    await foodMockRpc('food_transfer_coordinator', {
      p_to_user_id: MOCK_EMPLOYEE, p_mode: 'full_transfer', p_reason: 'Permanent handover of the role',
    });
    setFoodMockUser(MOCK_EMPLOYEE);
    const rows = await foodMockSelect<Array<{ access_level: string; revoked_at: string | null }>>(
      'food_coordinator_assignments', {});
    expect(rows.filter((a) => !a.revoked_at && a.access_level === 'active')).toHaveLength(1);
  });

  it('retains the outgoing assignment rather than deleting it', async () => {
    await foodMockRpc('food_transfer_coordinator', {
      p_to_user_id: MOCK_EMPLOYEE, p_mode: 'full_transfer', p_reason: 'Permanent handover of the role',
    });
    setFoodMockUser(MOCK_EMPLOYEE);
    const rows = await foodMockSelect<Array<{ coordinator_id: string }>>(
      'food_coordinator_assignments', {});
    expect(rows.filter((a) => a.coordinator_id === MOCK_COORDINATOR).length).toBeGreaterThan(0);
  });
});

describe('foodErrorMessage', () => {
  it('explains the disabled payment in plain words', () => {
    const msg = foodErrorMessage(new Error('FOOD_CHECKOUT_DISABLED: paying for a meal is not enabled yet.'));
    expect(msg).toMatch(/not switched on yet/i);
    expect(msg).not.toMatch(/FOOD_CHECKOUT_DISABLED/);
  });

  it('rewrites the permission errors', () => {
    expect(foodErrorMessage(new Error('Only the active Food Coordinator may do this')))
      .toBe('Only the active Food Coordinator can do that.');
    expect(foodErrorMessage(new Error('Not authorised to view Food Management')))
      .toBe('You do not have access to Food Management.');
  });

  it('strips driver noise but keeps the server sentence', () => {
    expect(foodErrorMessage(new Error('ERROR: Meal "Pilau" is sold out (SQLSTATE 22023)')))
      .toBe('Meal "Pilau" is sold out');
  });

  it('passes a already-clean message straight through', () => {
    expect(foodErrorMessage(new Error('Your order is empty'))).toBe('Your order is empty');
  });

  it('has something to say about a non-Error', () => {
    expect(foodErrorMessage(null)).toMatch(/went wrong/i);
    expect(foodErrorMessage(new Error(''))).toMatch(/went wrong/i);
  });
});

describe('formatUgx', () => {
  it('formats with thousands separators and no decimals', () => {
    expect(formatUgx(8000)).toBe('UGX 8,000');
    expect(formatUgx('17000')).toBe('UGX 17,000');
  });

  it('treats nothing as zero rather than NaN', () => {
    expect(formatUgx(null)).toBe('UGX 0');
    expect(formatUgx(undefined)).toBe('UGX 0');
  });
});

describe('nothing is ever settled in the fixture', () => {
  it('marks every seeded "paid" order as simulated, unmistakably', async () => {
    actAsFoodCoordinator(true);
    const all = await foodMockSelect<FoodOrderDetail[]>('food_orders', {});
    const paid = all.filter((o) => o.payment_status === 'paid');
    expect(paid.length).toBeGreaterThan(0);
    // every one is identifiable as fixture evidence, by reference AND by txn id
    expect(paid.every((o) => o.order_reference.startsWith(SIMULATED_ORDER_PREFIX))).toBe(true);
    expect(paid.every((o) => o.transaction_group_id === SIMULATED_PAYMENT_TXN)).toBe(true);
    expect(paid.every(isSimulatedPayment)).toBe(true);
  });

  it('never turns a genuinely unpaid order into a paid one', async () => {
    actAsFoodCoordinator(true);
    const before = await foodMockSelect<FoodOrderDetail[]>('food_orders', {});
    const unpaid = before.filter((o) => o.payment_status === 'pending_payment').map((o) => o.id);
    expect(unpaid.length).toBeGreaterThan(0);

    // drive a paid order the whole way; the unpaid ones must be untouched
    const target = before.find(
      (o) => o.fulfilment_status === 'confirmed' && o.payment_status === 'paid')!;
    for (const to of ['preparing', 'ready', 'delivered']) {
      await foodMockRpc('food_set_fulfilment', { p_order_id: target.id, p_to_status: to });
    }
    const after = await foodMockSelect<FoodOrderDetail[]>('food_orders', {});
    for (const id of unpaid) {
      const o = after.find((x) => x.id === id)!;
      expect(o.payment_status).toBe('pending_payment');
      expect(o.transaction_group_id).toBeNull();
    }
  });

  it('keeps paying switched off even though fulfilment is relaxed', async () => {
    const err = await foodMockRpc('food_pay_order', { p_order_id: crypto.randomUUID() })
      .catch((e: Error) => e);
    expect(isFoodCheckoutDisabled(err)).toBe(true);
  });
});

describe('successor lookup for the handover', () => {
  it('refuses an ordinary employee', async () => {
    await expect(foodMockRpc('food_coordinator_candidates', {}))
      .rejects.toThrow(/active Food Coordinator/i);
  });

  it('serves the active coordinator', async () => {
    actAsFoodCoordinator(true);
    const rows = await foodMockRpc<Array<{ user_id: string; full_name: string }>>(
      'food_coordinator_candidates', {});
    expect(rows.length).toBeGreaterThan(0);
  });

  it('never offers the coordinator themselves', async () => {
    actAsFoodCoordinator(true);
    const rows = await foodMockRpc<Array<{ user_id: string }>>('food_coordinator_candidates', {});
    expect(rows.some((r) => r.user_id === MOCK_COORDINATOR)).toBe(false);
  });

  it('exposes only an id and a name, nothing else about the person', async () => {
    actAsFoodCoordinator(true);
    const rows = await foodMockRpc<Array<Record<string, unknown>>>(
      'food_coordinator_candidates', {});
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['full_name', 'user_id']);
    }
  });

  it('returns somebody the handover will actually accept', async () => {
    actAsFoodCoordinator(true);
    const rows = await foodMockRpc<Array<{ user_id: string }>>('food_coordinator_candidates', {});
    await expect(foodMockRpc('food_transfer_coordinator', {
      p_to_user_id: rows[0].user_id, p_mode: 'full_transfer',
      p_reason: 'Chosen from the successor list',
    })).resolves.toBeTruthy();
  });

  it('stops serving the list once the role has moved on', async () => {
    actAsFoodCoordinator(true);
    await foodMockRpc('food_transfer_coordinator', {
      p_to_user_id: MOCK_EMPLOYEE, p_mode: 'full_transfer',
      p_reason: 'Handing the role over permanently',
    });
    // the outgoing coordinator is no longer active, so cannot enumerate staff
    await expect(foodMockRpc('food_coordinator_candidates', {}))
      .rejects.toThrow(/active Food Coordinator/i);
  });
});

describe('no unintended payment path', () => {
  /**
   * The point of this block is not any single call — it is that after driving
   * every mutating operation the feature exposes, nothing anywhere has become
   * paid and no transaction has been attached. If someone later adds a path
   * that settles an order, this fails.
   */
  it('stays unpaid after every mutating operation in the feature', async () => {
    actAsFoodCoordinator(true);
    const today = foodToday();

    const cat = await foodMockRpc<string>('food_upsert_category', { p_name: 'Trial', p_sort_order: 5 });
    const meal = await foodMockRpc<string>('food_upsert_meal', {
      p_name: 'Trial dish', p_price_ugx: 1234, p_category_id: cat });
    await foodMockRpc('food_set_meal_status', { p_meal_id: meal, p_status: 'published' });
    const period = await foodMockRpc<string>('food_upsert_service_period', {
      p_name: 'Trial window', p_opens_at: '00:00', p_closes_at: '23:59', p_max_qty_per_employee: 5 });
    const item = await foodMockRpc<string>('food_schedule_meal', {
      p_service_date: today, p_period_id: period, p_meal_id: meal,
      p_servings_total: 10, p_publish: true });
    await foodMockRpc('food_set_sold_out', { p_menu_item_id: item, p_sold_out: false });

    setFoodMockUser(MOCK_EMPLOYEE);
    const order = await foodMockRpc<{ order_id: string }>('food_place_order', {
      p_items: [{ menu_item_id: item, quantity: 1 }], p_payment_mode: 'cash', p_idempotency_key: 'invariant-1' });

    actAsFoodCoordinator(true);
    // the kitchen works the unpaid order all the way to handover
    for (const to of ['preparing', 'ready', 'collected']) {
      await foodMockRpc('food_set_fulfilment', { p_order_id: order.order_id, p_to_status: to });
    }
    await foodMockRpc('food_set_closure', {
      p_closure_date: '2099-06-01', p_closed: true, p_reason: 'Trial closure' });

    // nothing in that sequence turned a genuine order into a paid one
    const all = await foodMockSelect<FoodOrderDetail[]>('food_orders', {});
    const genuine = all.filter((o) => !isSimulatedPayment(o));
    expect(genuine.length).toBeGreaterThan(0);
    expect(genuine.every((o) => o.payment_status === 'pending_payment')).toBe(true);
    expect(genuine.every((o) => o.transaction_group_id === null)).toBe(true);
    expect(genuine.every((o) => o.paid_at === null)).toBe(true);
  });

  it('refuses the one call that would settle an order', async () => {
    const all = await foodMockSelect<FoodOrderDetail[]>('food_orders', { mineOnly: true });
    const err = await foodMockRpc('food_pay_order', { p_order_id: all[0]?.id ?? crypto.randomUUID() })
      .catch((e: Error) => e);
    expect(isFoodCheckoutDisabled(err)).toBe(true);
  });

  it('has no wallet, balance or ledger call to make at all', async () => {
    // Any name in this list would be a way out of the feature and into money.
    for (const fn of ['food_credit_wallet', 'food_post_ledger', 'food_debit_wallet',
                      'create_ledger_transaction', 'cfo_direct_credit']) {
      await expect(foodMockRpc(fn, {})).rejects.toThrow(/no implementation for/i);
    }
  });

  it('attributes every shilling of "paid value" to simulated evidence', async () => {
    actAsFoodCoordinator(true);
    const o = await foodMockRpc<FoodCoordinatorOverview>('food_coordinator_overview', {});
    const all = await foodMockSelect<FoodOrderDetail[]>('food_orders', {});
    const simulatedTotal = all
      .filter((x) => x.payment_status === 'paid' && isSimulatedPayment(x))
      .reduce((t, x) => t + Number(x.total_ugx), 0);

    // the figure exists, and none of it came from a real payment
    expect(o.paid_order_total_ugx).toBe(simulatedTotal);
    expect(all.filter((x) => x.payment_status === 'paid' && !isSimulatedPayment(x))).toHaveLength(0);
    expect(o.checkout_enabled).toBe(false);
  });
});

describe('resolving a food exception', () => {
  async function anOpenException() {
    const rows = await foodMockSelect<Array<{ id: string; resolved_at: string | null }>>(
      'food_exceptions', {});
    return rows.find((e) => !e.resolved_at)!;
  }

  it('is refused for an ordinary employee', async () => {
    const open = await (async () => { actAsFoodCoordinator(true); const e = await anOpenException();
      setFoodMockUser(MOCK_EMPLOYEE); return e; })();
    await expect(foodMockRpc('food_resolve_exception', {
      p_exception_id: open.id, p_reason: 'I would like this closed' }))
      .rejects.toThrow(/active Food Coordinator/i);
  });

  it('is refused for a backup holder, who is not the active coordinator', async () => {
    actAsFoodCoordinator(true);
    const open = await anOpenException();
    await foodMockRpc('food_transfer_coordinator', {
      p_to_user_id: MOCK_EMPLOYEE, p_mode: 'transfer_with_backup',
      p_reason: 'Outgoing coordinator keeps read-only backup access' });
    setFoodMockUser(MOCK_COORDINATOR); // now backup, not active
    await expect(foodMockRpc('food_resolve_exception', {
      p_exception_id: open.id, p_reason: 'Closing it on my way out' }))
      .rejects.toThrow(/active Food Coordinator/i);
  });

  it('requires a reason', async () => {
    actAsFoodCoordinator(true);
    const open = await anOpenException();
    await expect(foodMockRpc('food_resolve_exception', {
      p_exception_id: open.id, p_reason: '' })).rejects.toThrow(/reason is required/i);
  });

  it('does not accept whitespace as a reason', async () => {
    actAsFoodCoordinator(true);
    const open = await anOpenException();
    await expect(foodMockRpc('food_resolve_exception', {
      p_exception_id: open.id, p_reason: '   \t  ' })).rejects.toThrow(/reason is required/i);
  });

  it('rejects an unknown exception id', async () => {
    actAsFoodCoordinator(true);
    await expect(foodMockRpc('food_resolve_exception', {
      p_exception_id: crypto.randomUUID(), p_reason: 'Closing a ghost' }))
      .rejects.toThrow(/does not exist/i);
  });

  it('rejects a missing exception id', async () => {
    actAsFoodCoordinator(true);
    await expect(foodMockRpc('food_resolve_exception', {
      p_exception_id: null, p_reason: 'No id supplied' }))
      .rejects.toThrow(/exception id is required/i);
  });

  it('resolves, recording who, when and why', async () => {
    actAsFoodCoordinator(true);
    const open = await anOpenException();
    const res = await foodMockRpc<{ resolved_by: string; reason: string; resolved_at: string }>(
      'food_resolve_exception',
      { p_exception_id: open.id, p_reason: '  Substituted two portions  ' });

    expect(res.resolved_by).toBe(MOCK_COORDINATOR);
    expect(res.reason).toBe('Substituted two portions'); // trimmed
    expect(res.resolved_at).toBeTruthy();

    const after = (await foodMockSelect<Array<Record<string, unknown>>>('food_exceptions', {}))
      .find((e) => e.id === open.id)!;
    expect(after.resolved_at).toBeTruthy();
    expect(after.resolved_by).toBe(MOCK_COORDINATOR);
    expect(after.resolution_reason).toBe('Substituted two portions');
  });

  it('preserves the original evidence', async () => {
    actAsFoodCoordinator(true);
    const before = (await foodMockSelect<Array<Record<string, unknown>>>('food_exceptions', {}))
      .find((e) => !e.resolved_at)!;
    const kind = before.kind;
    const detail = JSON.stringify(before.detail);

    await foodMockRpc('food_resolve_exception', {
      p_exception_id: before.id, p_reason: 'Dealt with at the counter' });

    const after = (await foodMockSelect<Array<Record<string, unknown>>>('food_exceptions', {}))
      .find((e) => e.id === before.id)!;
    expect(after.kind).toBe(kind);
    expect(JSON.stringify(after.detail)).toBe(detail);
  });

  it('never resolves the same exception twice', async () => {
    actAsFoodCoordinator(true);
    const open = await anOpenException();
    await foodMockRpc('food_resolve_exception', {
      p_exception_id: open.id, p_reason: 'First resolution, the real one' });
    await expect(foodMockRpc('food_resolve_exception', {
      p_exception_id: open.id, p_reason: 'Second attempt, must not win' }))
      .rejects.toThrow(/already resolved/i);

    const after = (await foodMockSelect<Array<Record<string, unknown>>>('food_exceptions', {}))
      .find((e) => e.id === open.id)!;
    // the first resolver's words survive
    expect(after.resolution_reason).toBe('First resolution, the real one');
  });

  it('writes an append-only audit entry carrying the before and after state', async () => {
    actAsFoodCoordinator(true);
    const open = await anOpenException();
    await foodMockRpc('food_resolve_exception', {
      p_exception_id: open.id, p_reason: 'Replaced the shortfall portions' });

    const trail = await foodMockSelect<Array<Record<string, unknown>>>(
      'food_audit', { entity: 'exception', entityId: open.id });
    expect(trail).toHaveLength(1);
    const row = trail[0] as {
      action: string; reason: string; actor_id: string;
      before_val: Record<string, unknown>; after_val: Record<string, unknown>;
    };
    expect(row.action).toBe('resolved');
    expect(row.reason).toBe('Replaced the shortfall portions');
    expect(row.actor_id).toBe(MOCK_COORDINATOR);
    expect(row.before_val.resolved_at).toBeNull();
    expect(row.after_val.resolved_at).toBeTruthy();
  });

  it('touches no payment, wallet or ledger state', async () => {
    actAsFoodCoordinator(true);
    const ordersBefore = JSON.stringify(
      await foodMockSelect<FoodOrderDetail[]>('food_orders', {}));
    const open = await anOpenException();
    await foodMockRpc('food_resolve_exception', {
      p_exception_id: open.id, p_reason: 'Nothing financial about this' });
    const ordersAfter = JSON.stringify(
      await foodMockSelect<FoodOrderDetail[]>('food_orders', {}));
    expect(ordersAfter).toBe(ordersBefore);
  });
});

describe('two submissions racing the same per-period cap', () => {
  /**
   * The real protection lives in SQL: food_place_order takes
   * pg_advisory_xact_lock(hashtext('food_place_order_cap'),
   * hashtext(employee||':'||period)) before counting what the employee already
   * holds, so two carts that share no meal still serialise.
   *
   * BE CLEAR ABOUT WHAT THIS FILE CAN PROVE. The fixture is single-threaded and
   * each RPC body runs to completion without yielding, so it CANNOT reproduce
   * the interleaving that the lock defends against — these tests would pass
   * even against the unfixed SQL. They are here to pin the behaviour the cap is
   * required to have, and to catch a regression that breaks it outright. The
   * cross-session proof has to come from two independent database sessions.
   */

  it('refuses the second of two carts that would jointly exceed the cap', async () => {
    const p = await openPeriod();                 // seeded cap is 5
    const [a, b] = p.meals;                       // two DIFFERENT meals: no shared lock
    expect(a.menu_item_id).not.toBe(b.menu_item_id);

    // the employee already holds 2 from seeding, so 3 more is the limit
    const first = foodMockRpc('food_place_order', {
      p_items: [{ menu_item_id: a.menu_item_id, quantity: 2 }], p_payment_mode: 'cash', p_idempotency_key: 'race-1' });
    const second = foodMockRpc('food_place_order', {
      p_items: [{ menu_item_id: b.menu_item_id, quantity: 2 }], p_payment_mode: 'cash', p_idempotency_key: 'race-2' });

    const results = await Promise.allSettled([first, second]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');

    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(String((failed[0] as PromiseRejectedResult).reason)).toMatch(/at most 5/i);
  });

  it('never lets the total held exceed the configured cap', async () => {
    const p = await openPeriod();
    const [a, b] = p.meals;
    await Promise.allSettled([
      foodMockRpc('food_place_order', {
        p_items: [{ menu_item_id: a.menu_item_id, quantity: 2 }], p_payment_mode: 'cash', p_idempotency_key: 'race-3' }),
      foodMockRpc('food_place_order', {
        p_items: [{ menu_item_id: b.menu_item_id, quantity: 2 }], p_payment_mode: 'cash', p_idempotency_key: 'race-4' }),
    ]);

    const mine = await foodMockSelect<FoodOrderDetail[]>('food_orders', { mineOnly: true });
    const held = mine
      .filter((o) => o.period_id === p.period_id && o.fulfilment_status !== 'cancelled')
      .reduce((t, o) => t + o.items.reduce((s, i) => s + i.quantity, 0), 0);

    expect(held).toBeLessThanOrEqual(p.max_qty_per_employee as number);
  });

  it('does not serialise a different employee against the same period', async () => {
    const p = await openPeriod();
    const meal = p.meals[0].menu_item_id;

    setFoodMockUser(MOCK_EMPLOYEE);
    const mine = foodMockRpc('food_place_order', {
      p_items: [{ menu_item_id: meal, quantity: 1 }], p_payment_mode: 'cash', p_idempotency_key: 'race-5' });
    await expect(mine).resolves.toBeTruthy();

    // a different person's allowance is their own, untouched by the above
    setFoodMockUser(MOCK_COORDINATOR);
    await expect(foodMockRpc('food_place_order', {
      p_items: [{ menu_item_id: meal, quantity: 1 }], p_payment_mode: 'cash', p_idempotency_key: 'race-6' }))
      .resolves.toBeTruthy();
  });

  it('leaves no oversold stock or orphaned reservation behind', async () => {
    const before = (await openPeriod()).meals.find((m) => m.servings_remaining !== null)!;
    const [a, b] = (await openPeriod()).meals;

    await Promise.allSettled([
      foodMockRpc('food_place_order', {
        p_items: [{ menu_item_id: a.menu_item_id, quantity: 2 }], p_payment_mode: 'cash', p_idempotency_key: 'race-7' }),
      foodMockRpc('food_place_order', {
        p_items: [{ menu_item_id: b.menu_item_id, quantity: 2 }], p_payment_mode: 'cash', p_idempotency_key: 'race-8' }),
    ]);

    // whatever was reserved is backed by an order line; nothing is stranded
    const after = (await openPeriod()).meals;
    for (const m of after) {
      if (m.servings_total === null) continue;
      expect(m.servings_remaining as number).toBeGreaterThanOrEqual(0);
      expect(m.servings_remaining as number).toBeLessThanOrEqual(m.servings_total as number);
    }
    expect(before).toBeTruthy();
  });
});

describe('fixture mode is development-only and opt-in (FM-01)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is off when the flag is absent, so a default build uses the real service', () => {
    vi.stubEnv('VITE_FOOD_SERVICE_MOCK', '');
    expect(isFoodMockMode()).toBe(false);
  });

  it('is off for any value other than "true"', () => {
    vi.stubEnv('VITE_FOOD_SERVICE_MOCK', 'false');
    expect(isFoodMockMode()).toBe(false);
    vi.stubEnv('VITE_FOOD_SERVICE_MOCK', '1');
    expect(isFoodMockMode()).toBe(false);
  });

  it('is off in a production build even when the flag is set', () => {
    vi.stubEnv('VITE_FOOD_SERVICE_MOCK', 'true');
    vi.stubEnv('DEV', false);
    expect(isFoodMockMode()).toBe(false);
  });

  it('is on only for a development build that opts in', () => {
    vi.stubEnv('VITE_FOOD_SERVICE_MOCK', 'true');
    vi.stubEnv('DEV', true);
    expect(isFoodMockMode()).toBe(true);
  });

  it('seeds no real account id (FM-04)', () => {
    expect(MOCK_COORDINATOR).not.toBe('29a0cfa8-1eaf-453c-874c-0fc72fa4f74b');
  });
});

describe('payment mode and bounds (D1, D3)', () => {
  beforeEach(() => { resetFoodMock(); setFoodMockUser(MOCK_EMPLOYEE); });

  it('requires a known payment mode and records it without paying', async () => {
    const p = await openPeriod();
    const items = [{ menu_item_id: p.meals[0].menu_item_id, quantity: 1 }];
    await expect(foodMockRpc('food_place_order', { p_items: items, p_idempotency_key: 'm0' }))
      .rejects.toThrow(/how you will pay/i);
    await expect(foodMockRpc('food_place_order', {
      p_items: items, p_idempotency_key: 'm1', p_payment_mode: 'card' })).rejects.toThrow(/how you will pay/i);
    const res = await foodMockRpc<{ order_id: string; payment_mode: string; payment_status: string }>(
      'food_place_order', { p_items: items, p_idempotency_key: 'm2', p_payment_mode: 'wallet' });
    expect(res.payment_mode).toBe('wallet');
    expect(res.payment_status).toBe('pending_payment');
  });

  it('refuses more than 20 of one meal and over-long instructions', async () => {
    const p = await openPeriod();
    const id = p.meals[0].menu_item_id;
    await expect(foodMockRpc('food_place_order', {
      p_items: [{ menu_item_id: id, quantity: 21 }], p_idempotency_key: 'b1', p_payment_mode: 'cash',
    })).rejects.toThrow(/at most 20/i);
    await expect(foodMockRpc('food_place_order', {
      p_items: [{ menu_item_id: id, quantity: 1 }], p_idempotency_key: 'b2', p_payment_mode: 'cash',
      p_special_instructions: 'x'.repeat(501),
    })).rejects.toThrow(/500 characters/i);
  });
});

describe('raising exceptions mirrors the server (FM-21)', () => {
  beforeEach(() => { resetFoodMock(); setFoodMockUser(MOCK_EMPLOYEE); });

  it('an employee reports only on their own order, once while open', async () => {
    const mine = (await foodMockSelect<FoodOrderDetail[]>('food_orders', { mineOnly: true }))[0];
    await expect(foodMockRpc('food_raise_exception', { p_kind: 'OTHER', p_note: 'x' }))
      .rejects.toThrow(/choose the order/i);
    await foodMockRpc('food_raise_exception', { p_kind: 'OTHER', p_note: 'cold', p_order_id: mine.id });
    await expect(foodMockRpc('food_raise_exception', { p_kind: 'OTHER', p_note: 'again', p_order_id: mine.id }))
      .rejects.toThrow(/already have an open report/i);
    actAsFoodCoordinator(true);
    const theirs = (await foodMockSelect<FoodOrderDetail[]>('food_orders', {}))
      .find((o) => o.employee_id !== MOCK_EMPLOYEE)!;
    setFoodMockUser(MOCK_EMPLOYEE);
    await expect(foodMockRpc('food_raise_exception', { p_kind: 'OTHER', p_note: 'x', p_order_id: theirs.id }))
      .rejects.toThrow(/own order/i);
  });

  it('refuses unknown kinds and blank or long descriptions', async () => {
    actAsFoodCoordinator(true);
    await expect(foodMockRpc('food_raise_exception', { p_kind: 'refund', p_note: 'x' })).rejects.toThrow(/unknown/i);
    await expect(foodMockRpc('food_raise_exception', { p_kind: 'OTHER', p_note: '  ' })).rejects.toThrow(/describe/i);
    await expect(foodMockRpc('food_raise_exception', { p_kind: 'OTHER', p_note: 'x'.repeat(501) }))
      .rejects.toThrow(/500/);
  });

  it('never changes an order status or payment status', async () => {
    const mine = (await foodMockSelect<FoodOrderDetail[]>('food_orders', { mineOnly: true }))[0];
    await foodMockRpc('food_raise_exception', { p_kind: 'QUALITY_ISSUE', p_note: 'cold', p_order_id: mine.id });
    const after = (await foodMockSelect<FoodOrderDetail[]>('food_orders', { mineOnly: true }))
      .find((o) => o.id === mine.id)!;
    expect(after.fulfilment_status).toBe(mine.fulfilment_status);
    expect(after.payment_status).toBe(mine.payment_status);
  });
});

describe('the fixture accepts exactly the nine approved kinds', () => {
  beforeEach(() => { resetFoodMock(); actAsFoodCoordinator(true); });

  it.each([
    'MISSING_ITEM', 'WRONG_ITEM', 'QUALITY_ISSUE', 'LATE_DELIVERY', 'NOT_DELIVERED',
    'DAMAGED_ORDER', 'STOCK_UNAVAILABLE', 'ORDER_ERROR', 'OTHER',
  ])('accepts %s', async (kind) => {
    const r = await foodMockRpc<{ kind: string }>('food_raise_exception', { p_kind: kind, p_note: 'x' });
    expect(r.kind).toBe(kind);
  });

  it.each(['stock_shortfall', 'missing_item', 'REFUND'])('refuses %s', async (kind) => {
    await expect(foodMockRpc('food_raise_exception', { p_kind: kind, p_note: 'x' })).rejects.toThrow(/unknown/i);
  });
});

describe('receipt confirmation and payment in the fixture (20261013128000)', () => {
  async function deliveredOrder(key: string) {
    setFoodMockUser(MOCK_EMPLOYEE);
    const p = await openPeriod();
    const res = await foodMockRpc<{ order_id: string }>('food_place_order', {
      p_items: [{ menu_item_id: p.meals[0].menu_item_id, quantity: 1 }], p_payment_mode: 'wallet', p_idempotency_key: key,
    });
    actAsFoodCoordinator(true);
    for (const to of ['preparing', 'ready', 'delivered']) {
      await foodMockRpc('food_set_fulfilment', { p_order_id: res.order_id, p_to_status: to });
    }
    setFoodMockUser(MOCK_EMPLOYEE);
    return res.order_id;
  }

  it('receipt cannot be confirmed before hand-over, nor by someone else', async () => {
    setFoodMockUser(MOCK_EMPLOYEE);
    const p = await openPeriod();
    const res = await foodMockRpc<{ order_id: string }>('food_place_order', {
      p_items: [{ menu_item_id: p.meals[0].menu_item_id, quantity: 1 }], p_payment_mode: 'wallet', p_idempotency_key: 'rcpt-early',
    });
    await expect(foodMockRpc('food_confirm_receipt', { p_order_id: res.order_id })).rejects.toThrow(/not been handed over/i);
    const id = await deliveredOrder('rcpt-other');
    actAsFoodCoordinator(true);
    await expect(foodMockRpc('food_confirm_receipt', { p_order_id: id })).rejects.toThrow(/only the person who placed/i);
  });

  it('the employee confirms receipt; the active coordinator is the payee; confirming again changes nothing', async () => {
    const id = await deliveredOrder('rcpt-ok');
    const first = await foodMockRpc<{ status: string; payee_id: string }>('food_confirm_receipt', { p_order_id: id });
    expect(first.status).toBe('confirmed');
    expect(first.payee_id).toBe(MOCK_COORDINATOR);
    const again = await foodMockRpc<{ status: string }>('food_confirm_receipt', { p_order_id: id });
    expect(again.status).toBe('already_confirmed');
  });

  it('payment is unavailable before receipt and is never taken by the fixture', async () => {
    const id = await deliveredOrder('pay-fixture');
    await expect(foodMockRpc('food_pay_order', { p_order_id: id })).rejects.toThrow(/confirm that you received/i);
    await foodMockRpc('food_confirm_receipt', { p_order_id: id });
    await expect(foodMockRpc('food_pay_order', { p_order_id: id })).rejects.toThrow(/not available in the development fixture/i);
    const after = (await foodMockSelect<FoodOrderDetail[]>('food_orders', {})).find((o) => o.id === id)!;
    expect(after.payment_status).toBe('pending_payment');
    expect(after.transaction_group_id ?? null).toBeNull();
  });
});
