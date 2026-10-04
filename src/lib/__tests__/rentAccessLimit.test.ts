import { describe, it, expect } from 'vitest';
import {
  calculateRentAccessLimit,
  RENT_ACCESS_PAID_INCREMENT_UGX,
  RENT_ACCESS_MISSED_DECREMENT_UGX,
  RENT_ACCESS_MAX_LIMIT_UGX,
} from '@/lib/rentAccessLimit';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Helper: build a repayment at UTC-midnight of `now - offsetDays`. */
function rep(now: Date, offsetDays: number, amount = 50_000) {
  const d = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
  ) - offsetDays * DAY_MS);
  return { amount, created_at: d.toISOString() };
}

const NOW = new Date('2026-06-01T12:00:00Z');

describe('calculateRentAccessLimit', () => {
  it('returns zero limit with no repayments', () => {
    const r = calculateRentAccessLimit(500_000, [], NOW);
    expect(r.limit).toBe(0);
    expect(r.paidDays).toBe(0);
    expect(r.missedDays).toBe(0);
    expect(r.trackedDays).toBe(0);
    expect(r.paymentsToday).toBe(0);
    expect(r.paidToday).toBe(false);
    expect(r.netAdjustmentPct).toBe(0);
    expect(r.tier).toBe('starter');
    expect(r.atMax).toBe(false);
  });

  it('counts a paid-only streak as +increment per day', () => {
    const reps = Array.from({ length: 5 }, (_, i) => rep(NOW, i));
    const r = calculateRentAccessLimit(500_000, reps, NOW);
    expect(r.paidDays).toBe(5);
    expect(r.missedDays).toBe(0);
    expect(r.trackedDays).toBe(5);
    expect(r.limit).toBe(5 * RENT_ACCESS_PAID_INCREMENT_UGX);
    expect(r.paidToday).toBe(true);
    expect(r.todayChange).toBe(RENT_ACCESS_PAID_INCREMENT_UGX);
    expect(r.paymentsToday).toBe(1);
  });

  it('collapses multiple same-day payments to a single on-time day', () => {
    const reps = [rep(NOW, 0, 10_000), rep(NOW, 0, 10_000), rep(NOW, 0, 10_000)];
    const r = calculateRentAccessLimit(500_000, reps, NOW);
    expect(r.paymentsToday).toBe(3);
    expect(r.paidDays).toBe(1);
    expect(r.trackedDays).toBe(1);
    expect(r.limit).toBe(RENT_ACCESS_PAID_INCREMENT_UGX);
  });

  it('clamps at 0 when missed days dominate', () => {
    // 1 paid day 20 days ago → tracked = 21, missed = 20.
    // raw = 10_000 − 20 × 7_000 = −130_000 → clamp 0.
    const reps = [rep(NOW, 20)];
    const r = calculateRentAccessLimit(500_000, reps, NOW);
    expect(r.paidDays).toBe(1);
    expect(r.trackedDays).toBe(21);
    expect(r.missedDays).toBe(20);
    expect(r.limit).toBe(0);
    expect(r.netAdjustmentPct).toBe(0);
    expect(r.tier).toBe('starter');
    expect(r.atMax).toBe(false);
    expect(r.todayChange).toBe(-RENT_ACCESS_MISSED_DECREMENT_UGX);
    expect(r.paidToday).toBe(false);
  });

  it('clamps at the max cap and flags atMax / elite tier', () => {
    // Way more paid days than needed to exceed the cap.
    const needed = Math.ceil(RENT_ACCESS_MAX_LIMIT_UGX / RENT_ACCESS_PAID_INCREMENT_UGX);
    const reps = Array.from({ length: needed + 50 }, (_, i) => rep(NOW, i));
    const r = calculateRentAccessLimit(500_000, reps, NOW);
    expect(r.limit).toBe(RENT_ACCESS_MAX_LIMIT_UGX);
    expect(r.atMax).toBe(true);
    expect(r.netAdjustmentPct).toBe(1);
    expect(r.tier).toBe('elite');
  });

  it('tiers map to progress thresholds (rising ≥ 5%, trusted ≥ 20%, elite ≥ 50%)', () => {
    const target = (pct: number) => {
      const limit = Math.floor(RENT_ACCESS_MAX_LIMIT_UGX * pct);
      const paidDays = Math.ceil(limit / RENT_ACCESS_PAID_INCREMENT_UGX);
      // Use a contiguous paid streak ending today so missedDays = 0.
      return Array.from({ length: paidDays }, (_, i) => rep(NOW, i));
    };

    const justUnderRising = calculateRentAccessLimit(0, target(0.04), NOW);
    expect(justUnderRising.tier).toBe('starter');

    const rising = calculateRentAccessLimit(0, target(0.06), NOW);
    expect(rising.tier).toBe('rising');

    const trusted = calculateRentAccessLimit(0, target(0.21), NOW);
    expect(trusted.tier).toBe('trusted');

    const elite = calculateRentAccessLimit(0, target(0.51), NOW);
    expect(elite.tier).toBe('elite');
  });

  it('netAdjustmentPct equals limit / maxLimit', () => {
    const reps = Array.from({ length: 10 }, (_, i) => rep(NOW, i));
    const r = calculateRentAccessLimit(500_000, reps, NOW);
    expect(r.limit).toBe(10 * RENT_ACCESS_PAID_INCREMENT_UGX);
    expect(r.netAdjustmentPct).toBeCloseTo(r.limit / RENT_ACCESS_MAX_LIMIT_UGX, 10);
  });

  it('honours runtime overrides for increment/decrement/cap', () => {
    const reps = [rep(NOW, 0), rep(NOW, 1), rep(NOW, 2)];
    const r = calculateRentAccessLimit(500_000, reps, NOW, {
      paidIncrementUgx: 1_000,
      missedDecrementUgx: 500,
      maxLimitUgx: 2_500,
    });
    // paidDays=3, missedDays=0, raw=3_000, clamped to cap 2_500.
    expect(r.limit).toBe(2_500);
    expect(r.atMax).toBe(true);
    expect(r.netAdjustmentPct).toBe(1);
    expect(r.todayChange).toBe(1_000);
  });

  it('ignores invalid / zero-amount repayments', () => {
    const reps = [
      { amount: 0, created_at: rep(NOW, 0).created_at },
      { amount: 10_000, created_at: 'not-a-date' },
      rep(NOW, 1, 10_000),
    ];
    const r = calculateRentAccessLimit(500_000, reps, NOW);
    expect(r.paidDays).toBe(1);
    expect(r.trackedDays).toBe(2); // yesterday → today
    expect(r.missedDays).toBe(1);
    expect(r.limit).toBe(
      Math.max(0, RENT_ACCESS_PAID_INCREMENT_UGX - RENT_ACCESS_MISSED_DECREMENT_UGX),
    );
  });

  it('handles null/undefined inputs gracefully', () => {
    const r = calculateRentAccessLimit(null, null, NOW);
    expect(r.limit).toBe(0);
    expect(r.base).toBe(0);
    expect(r.paidDays).toBe(0);
    expect(r.trackedDays).toBe(0);
  });
});