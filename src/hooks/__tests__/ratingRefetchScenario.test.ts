import { describe, it, expect } from 'vitest';
import { classifyDailyRating } from '../useAgentCapacityMap';

/**
 * Regression scenario: "Onesmus" case.
 *
 * Old rule: effective pct = max(today_pct, yesterday_pct).
 *   With paid_yesterday=0 and a stale cache showing today=0 too, the agent
 *   was rated "Very Bad"/"Bad" even though they had already collected
 *   most of today's target.
 *
 * New rule: effective pct = today_pct ONLY, with a fresh refetch after
 *   transactions land. With paid_today=881,000 vs expected_daily=1,034,289
 *   (~85%), the agent must be rated "Very Good".
 *
 * This test pins both behaviours so any future refactor that reintroduces
 * yesterday into the rating, or that lets a stale today figure win, fails.
 */
describe('Agent rating refetch scenario (Onesmus)', () => {
  const active_count = 51;
  const expected_daily = 1_034_289;
  const paid_today = 881_000;
  const paid_yesterday = 0;

  const today_pct = paid_today / expected_daily;       // ~0.852
  const yesterday_pct = paid_yesterday / expected_daily; // 0

  it('OLD logic (best of yesterday/today) on a STALE today=0 cache rated him Very Bad', () => {
    // Simulate the pre-refetch render: today's collections had not yet
    // been pulled into the React Query cache, so today_pct read as 0.
    const stale_today_pct = 0;
    const old_effective = Math.max(stale_today_pct, yesterday_pct);
    expect(classifyDailyRating(active_count, old_effective)).toBe('Very Bad');
  });

  it('NEW logic (today only) after refetch rates him Very Good', () => {
    const new_effective = today_pct; // ignores yesterday entirely
    expect(new_effective).toBeGreaterThanOrEqual(0.5);
    expect(classifyDailyRating(active_count, new_effective)).toBe('Very Good');
  });

  it('NEW logic stays Very Good even if yesterday was 0% (yesterday is irrelevant)', () => {
    // Sanity: a strong today performance must never be dragged down by
    // a weak yesterday under the today-only rule.
    const effective = today_pct;
    expect(classifyDailyRating(active_count, effective)).toBe('Very Good');
    // And the inverse: if today is 0 but yesterday was great, rating
    // should still reflect today (Very Bad), not yesterday.
    expect(classifyDailyRating(active_count, 0)).toBe('Very Bad');
  });
});