import { describe, it, expect } from 'vitest';
import { computeCashPosition } from './cashPosition';

describe('computeCashPosition', () => {
  it('2026-10-06 screenshot: negative Bayo balance no longer makes Can Use exceed Have', () => {
    const r = computeCashPosition({ moneyWeHave: 2_223_331_101, merchantFloat: 0, bayoMercyBalance: -3_278_358 });
    expect(r.moneyWeOwe).toBe(0);
    expect(r.moneyWeCanUse).toBe(2_223_331_101);
    expect(r.mercyFrontedPendingTopUp).toBe(3_278_358);
  });

  it('a fronted amount is not subtracted twice: it is already inside the float', () => {
    const r = computeCashPosition({ moneyWeHave: 100, merchantFloat: 40, bayoMercyBalance: -10 });
    expect(r.moneyWeOwe).toBe(40);
    expect(r.moneyWeCanUse).toBe(60);
  });

  it('positive Bayo balance is owed on top of merchant float', () => {
    const r = computeCashPosition({ moneyWeHave: 100, merchantFloat: 40, bayoMercyBalance: 15 });
    expect(r.moneyWeOwe).toBe(55);
    expect(r.moneyWeCanUse).toBe(45);
    expect(r.mercyFrontedPendingTopUp).toBe(0);
  });

  it('Money We Owe is never negative and Can Use stays within 0..Have', () => {
    for (const bayo of [-1e9, -1, 0, 1, 1e9]) {
      for (const float of [0, 5, 1e9]) {
        const r = computeCashPosition({ moneyWeHave: 50, merchantFloat: float, bayoMercyBalance: bayo });
        expect(r.moneyWeOwe).toBeGreaterThanOrEqual(0);
        expect(r.moneyWeCanUse).toBeGreaterThanOrEqual(0);
        expect(r.moneyWeCanUse).toBeLessThanOrEqual(50);
      }
    }
  });

  it('treats NaN inputs as 0 instead of propagating them to the cards', () => {
    const r = computeCashPosition({ moneyWeHave: 10, merchantFloat: NaN, bayoMercyBalance: NaN });
    expect(r).toEqual({ moneyWeOwe: 0, moneyWeCanUse: 10, bayoMercyOwed: 0, mercyFrontedPendingTopUp: 0 });
  });
});
