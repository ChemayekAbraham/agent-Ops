import { describe, it, expect } from 'vitest';
import { classifyDailyRating, DAILY_RATING_THRESHOLDS } from '../useAgentCapacityMap';

/**
 * Boundary tests for the 5-tier daily rating classifier.
 *
 * Thresholds (inclusive lower bound):
 *   >= 75%   Very Good
 *   >= 50%   Good
 *   >= 15%   Fair
 *   >=  5%   Bad
 *   <  5%   Very Bad
 *
 * active_count <= 0 always yields 'Starter' regardless of pct.
 */
describe('classifyDailyRating - boundary thresholds', () => {
  const ACTIVE = 5; // any positive active tenant count

  it('returns Starter when active_count <= 0 (no active tenants)', () => {
    expect(classifyDailyRating(0, 0)).toBe('Starter');
    expect(classifyDailyRating(0, 1)).toBe('Starter');
    expect(classifyDailyRating(-1, 0.9)).toBe('Starter');
  });

  it('classifies exactly at 75% as Very Good', () => {
    expect(classifyDailyRating(ACTIVE, DAILY_RATING_THRESHOLDS.very_good)).toBe('Very Good');
    expect(classifyDailyRating(ACTIVE, 0.75)).toBe('Very Good');
  });

  it('classifies just below 75% as Good', () => {
    expect(classifyDailyRating(ACTIVE, 0.7499)).toBe('Good');
  });

  it('classifies exactly at 50% as Good', () => {
    expect(classifyDailyRating(ACTIVE, DAILY_RATING_THRESHOLDS.good)).toBe('Good');
    expect(classifyDailyRating(ACTIVE, 0.50)).toBe('Good');
  });

  it('classifies just below 50% as Fair', () => {
    expect(classifyDailyRating(ACTIVE, 0.4999)).toBe('Fair');
  });

  it('classifies exactly at 15% as Fair', () => {
    expect(classifyDailyRating(ACTIVE, DAILY_RATING_THRESHOLDS.fair)).toBe('Fair');
    expect(classifyDailyRating(ACTIVE, 0.15)).toBe('Fair');
  });

  it('classifies just below 15% as Bad', () => {
    expect(classifyDailyRating(ACTIVE, 0.1499)).toBe('Bad');
  });

  it('classifies exactly at 5% as Bad', () => {
    expect(classifyDailyRating(ACTIVE, DAILY_RATING_THRESHOLDS.bad)).toBe('Bad');
    expect(classifyDailyRating(ACTIVE, 0.05)).toBe('Bad');
  });

  it('classifies just below 5% as Very Bad', () => {
    expect(classifyDailyRating(ACTIVE, 0.0499)).toBe('Very Bad');
    expect(classifyDailyRating(ACTIVE, 0)).toBe('Very Bad');
  });

  it('handles expected_daily=0 case (pct computed as 0 upstream) as Very Bad', () => {
    // Upstream: when expected_daily is 0, effective_daily_pct is forced to 0.
    // With active tenants, that must classify as Very Bad (not Starter).
    const pctWhenExpectedDailyIsZero = 0;
    expect(classifyDailyRating(ACTIVE, pctWhenExpectedDailyIsZero)).toBe('Very Bad');
    expect(classifyDailyRating(1, pctWhenExpectedDailyIsZero)).toBe('Very Bad');
  });

  it('handles expected_daily=0 with no active tenants as Starter', () => {
    // No active tenants AND no expected daily: agent is a Starter.
    expect(classifyDailyRating(0, 0)).toBe('Starter');
  });

  it('caps at Very Good for over-performance (pct > 100%)', () => {
    expect(classifyDailyRating(ACTIVE, 1)).toBe('Very Good');
    expect(classifyDailyRating(ACTIVE, 2.5)).toBe('Very Good');
  });

  it('threshold constants match expected business values', () => {
    expect(DAILY_RATING_THRESHOLDS.very_good).toBe(0.75);
    expect(DAILY_RATING_THRESHOLDS.good).toBe(0.50);
    expect(DAILY_RATING_THRESHOLDS.fair).toBe(0.15);
    expect(DAILY_RATING_THRESHOLDS.bad).toBe(0.05);
  });
});