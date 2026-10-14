import { describe, it, expect } from 'vitest';
import {
  FOOD_ALLOWED_TRANSITIONS,
  FOOD_CHECKOUT_DISABLED,
  isFoodCheckoutDisabled,
  nextFoodStatuses,
  canStartPreparing,
  type FoodFulfilmentStatus,
} from '@/lib/foodService';

/**
 * These pin the client's copy of the fulfilment rules to the server's.
 *
 * `food_set_fulfilment` is the only way an order changes state, and it decides
 * with a CASE expression in 20261009130001_food_service_operations_rpcs.sql.
 * The map here exists so the UI can grey out buttons rather than let the
 * coordinator click into a guaranteed error — which means the two can drift.
 * Each case below was executed against the real function in the sandbox on
 * 2026-10-09 (suite D), so these are recorded server behaviour, not a guess.
 *
 * They do NOT cover the RPC calls themselves; those need the migration applied.
 */

const TERMINAL: FoodFulfilmentStatus[] = ['collected', 'delivered', 'cancelled'];

describe('FOOD_ALLOWED_TRANSITIONS', () => {
  it('matches the server: confirmed may only prepare or cancel', () => {
    expect(FOOD_ALLOWED_TRANSITIONS.confirmed).toEqual(['preparing', 'cancelled']);
  });

  it('matches the server: preparing may only become ready or cancel', () => {
    expect(FOOD_ALLOWED_TRANSITIONS.preparing).toEqual(['ready', 'cancelled']);
  });

  it('matches the server: ready may only be collected or delivered', () => {
    expect(FOOD_ALLOWED_TRANSITIONS.ready).toEqual(['collected', 'delivered']);
  });

  it.each(TERMINAL)('treats %s as terminal', (status) => {
    expect(FOOD_ALLOWED_TRANSITIONS[status]).toEqual([]);
  });

  it('never lets confirmed skip straight to ready', () => {
    // server case D2: raises 22023
    expect(FOOD_ALLOWED_TRANSITIONS.confirmed).not.toContain('ready');
  });

  it('never allows a terminal order to reopen', () => {
    // server case D4: raises 22023
    for (const s of TERMINAL) {
      expect(FOOD_ALLOWED_TRANSITIONS[s]).toHaveLength(0);
    }
  });

  it('cannot reach cancelled once the food is ready', () => {
    expect(FOOD_ALLOWED_TRANSITIONS.ready).not.toContain('cancelled');
  });

  it('covers every fulfilment status exactly once', () => {
    expect(Object.keys(FOOD_ALLOWED_TRANSITIONS).sort()).toEqual(
      ['cancelled', 'collected', 'confirmed', 'delivered', 'preparing', 'ready'],
    );
  });

  it('only ever points at statuses that exist', () => {
    const known = new Set(Object.keys(FOOD_ALLOWED_TRANSITIONS));
    for (const targets of Object.values(FOOD_ALLOWED_TRANSITIONS)) {
      for (const t of targets) expect(known.has(t)).toBe(true);
    }
  });
});

describe('isFoodCheckoutDisabled', () => {
  it('recognises the error the server actually raises', () => {
    // verbatim prefix from food_place_order (sandbox case C1, SQLSTATE 0A000)
    const err = new Error(
      'FOOD_CHECKOUT_DISABLED: wallet checkout is not enabled. Pending CFO approval ' +
      'of the meal-payment accounting treatment and a ledger category.',
    );
    expect(isFoodCheckoutDisabled(err)).toBe(true);
  });

  it('recognises it when supabase prefixes the message', () => {
    expect(isFoodCheckoutDisabled(new Error(`db error: ${FOOD_CHECKOUT_DISABLED}: ...`))).toBe(true);
  });

  it('does not swallow an unrelated failure', () => {
    expect(isFoodCheckoutDisabled(new Error('Only the active Food Coordinator may do this')))
      .toBe(false);
  });

  it('is safe on non-Error values', () => {
    expect(isFoodCheckoutDisabled(null)).toBe(false);
    expect(isFoodCheckoutDisabled(undefined)).toBe(false);
    expect(isFoodCheckoutDisabled('FOOD_CHECKOUT_DISABLED')).toBe(false);
  });
});

describe('canStartPreparing', () => {
  it('does not wait for payment: payment is made after delivery (CFO 2026-10-12)', () => {
    // food_set_fulfilment no longer reads payment_status
    expect(canStartPreparing('confirmed', 'pending_payment')).toBe(true);
    expect(canStartPreparing('confirmed', 'paid')).toBe(true);
  });

  it('refuses once the order has moved past confirmed', () => {
    expect(canStartPreparing('preparing', 'paid')).toBe(false);
    expect(canStartPreparing('ready', 'paid')).toBe(false);
    expect(canStartPreparing('collected', 'paid')).toBe(false);
  });

  it.each(['payment_failed', 'refund_pending', 'refunded'] as const)(
    'decides a %s order on its fulfilment state alone', (payment) => {
      expect(canStartPreparing('confirmed', payment)).toBe(true);
      expect(canStartPreparing('ready', payment)).toBe(false);
    });
});

describe('nextFoodStatuses', () => {
  it('returns the allowed targets', () => {
    expect(nextFoodStatuses('preparing')).toEqual(['ready', 'cancelled']);
  });

  it('returns an empty list for a terminal order', () => {
    expect(nextFoodStatuses('collected')).toEqual([]);
  });

  it('is safe for an unexpected status from the server', () => {
    expect(nextFoodStatuses('nonsense' as FoodFulfilmentStatus)).toEqual([]);
  });
});

describe('canStartPreparing honours the environment rule', () => {
  it('does not require payment by default — payment is after delivery', () => {
    expect(canStartPreparing('confirmed', 'pending_payment')).toBe(true);
  });

  it('can still express a payment-first rule explicitly', () => {
    expect(canStartPreparing('confirmed', 'pending_payment', { requirePayment: true })).toBe(false);
    expect(canStartPreparing('confirmed', 'paid', { requirePayment: true })).toBe(true);
  });

  it('allows an unpaid order only when payment is explicitly not required', () => {
    expect(canStartPreparing('confirmed', 'pending_payment', { requirePayment: false })).toBe(true);
  });

  it('never lets the relaxation bypass the transition rules', () => {
    // relaxing payment does not make an illegal transition legal
    expect(canStartPreparing('ready', 'pending_payment', { requirePayment: false })).toBe(false);
    expect(canStartPreparing('collected', 'paid', { requirePayment: false })).toBe(false);
    expect(canStartPreparing('cancelled', 'paid', { requirePayment: false })).toBe(false);
  });
});

describe('food exception kinds — the nine approved codes', () => {
  it('are exactly the approved set, in order', async () => {
    const { FOOD_EXCEPTION_KINDS, FOOD_EXCEPTION_KIND_LABEL } = await import('@/lib/foodService');
    expect([...FOOD_EXCEPTION_KINDS]).toEqual([
      'MISSING_ITEM', 'WRONG_ITEM', 'QUALITY_ISSUE', 'LATE_DELIVERY', 'NOT_DELIVERED',
      'DAMAGED_ORDER', 'STOCK_UNAVAILABLE', 'ORDER_ERROR', 'OTHER',
    ]);
    // every kind has a human label, and nothing else does
    expect(Object.keys(FOOD_EXCEPTION_KIND_LABEL).sort()).toEqual([...FOOD_EXCEPTION_KINDS].sort());
    for (const k of FOOD_EXCEPTION_KINDS) expect(FOOD_EXCEPTION_KIND_LABEL[k].length).toBeGreaterThan(0);
  });
});

import { isFoodAllDayWindow, FOOD_ALL_DAY_OPENS, FOOD_ALL_DAY_CLOSES } from '@/lib/foodService';

describe('all-day ordering window', () => {
  it('the all-day constants satisfy the server rule (closing after opening)', () => {
    expect(FOOD_ALL_DAY_CLOSES > FOOD_ALL_DAY_OPENS).toBe(true);
    expect(isFoodAllDayWindow(FOOD_ALL_DAY_OPENS, FOOD_ALL_DAY_CLOSES)).toBe(true);
  });
  it('recognises all-day windows at minute precision, and only those', () => {
    expect(isFoodAllDayWindow('00:00', '23:59')).toBe(true);
    expect(isFoodAllDayWindow('06:30:00', '09:00:00')).toBe(false);
    expect(isFoodAllDayWindow('00:00:00', '22:00:00')).toBe(false);
  });
});
