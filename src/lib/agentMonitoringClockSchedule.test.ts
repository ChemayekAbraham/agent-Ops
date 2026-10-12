import { describe, it, expect } from 'vitest';
import {
  describePlanScheduleFromClock,
  isMonitoredReading,
  planIdsSignature,
  type AmPlanClockReading,
} from './agentMonitoringClockSchedule';
import { describePlanSchedule } from './agentMonitoringSchedule';

const plan = (over: Partial<Parameters<typeof describePlanSchedule>[0]> = {}) => ({
  daily_repayment: 10_000,
  total_repayment: 300_000,
  amount_repaid: 0,
  repayment_frequency: 'daily',
  repayment_starts_on: '2026-08-01', // the OLD start, must be ignored
  created_at: '2026-07-30T08:00:00Z',
  ...over,
});

const reading = (over: {
  bucket?: string;
  clock_start?: string | null;
  expected?: number;
  paid?: number;
  arrears?: number;
  periodsBehind?: number;
  periodsAhead?: number;
}): AmPlanClockReading => ({
  clock: {
    rent_request_id: 'p1', bucket: over.bucket ?? 'counting', landlord_paid_count: 1, landlord_paid_total: 1,
    landlord_paid_dates_estimated: 0, first_landlord_paid_on: null, last_landlord_paid_on: null,
    clock_start: over.clock_start === undefined ? '2026-09-06' : over.clock_start,
    clock_end: null, current_start: '2026-08-01', shift_days: null,
  },
  arrears: {
    rent_request_id: 'p1', bucket: over.bucket ?? 'counting', cadence: 'daily', unit: 'day',
    clock_start: over.clock_start === undefined ? '2026-09-06' : over.clock_start,
    expected_to_date: over.expected ?? 0, paid_to_date: over.paid ?? 0, arrears: over.arrears ?? 0,
    days_behind: over.periodsBehind ?? 0, days_ahead: over.periodsAhead ?? 0,
    periods_behind: over.periodsBehind ?? 0, periods_ahead: over.periodsAhead ?? 0,
  },
});

describe('describePlanScheduleFromClock', () => {
  it('counts from clock_start, not from repayment_starts_on', () => {
    // Day 5 of the clock (06 Sep -> 10 Sep): 5 instalments due, nothing paid.
    const s = describePlanScheduleFromClock(
      plan(),
      reading({ expected: 50_000, arrears: 50_000, periodsBehind: 4 }),
      new Date(2026, 8, 10),
    );
    expect(s.scheduledToDate).toBe(50_000);
    expect(s.arrears).toBe(50_000);
    expect(s.periodsBehind).toBe(4);
    expect(s.expectedOnDay).toBe(10_000); // due today, one instalment
    expect(s.dueState).toBe('due_today');
    // The old start (1 Aug) would have said 41 instalments were due.
    const old = describePlanSchedule(plan(), new Date(2026, 8, 10));
    expect(old.scheduledToDate).toBeGreaterThan(s.scheduledToDate);
  });

  it('is not due before the clock starts', () => {
    const s = describePlanScheduleFromClock(plan(), reading({}), new Date(2026, 8, 5));
    expect(s.scheduledToDate).toBe(0);
    expect(s.arrears).toBe(0);
    expect(s.dueOnDay).toBe(false);
    expect(s.expectedOnDay).toBe(0);
  });

  it('reports paid ahead from the server paid-to-date', () => {
    // 3 due, 8 paid: 5 ahead, covered by advance.
    const s = describePlanScheduleFromClock(
      plan(),
      reading({ expected: 30_000, paid: 80_000, periodsAhead: 5 }),
      new Date(2026, 8, 8),
    );
    expect(s.aheadAmount).toBe(50_000);
    expect(s.periodsAhead).toBe(5);
    expect(s.arrears).toBe(0);
    expect(s.coveredByAdvance).toBe(true);
    expect(s.expectedOnDay).toBe(0);
  });

  it('weekly plans are due on the clock start weekday, instalment = daily x 7', () => {
    const weekly = plan({ repayment_frequency: 'weekly' });
    const onDue = describePlanScheduleFromClock(
      weekly,
      reading({ expected: 70_000, arrears: 70_000 }),
      new Date(2026, 8, 6), // clock day 0
    );
    expect(onDue.weekly).toBe(true);
    expect(onDue.periodAmount).toBe(70_000);
    expect(onDue.expectedOnDay).toBe(70_000);
    const midWeek = describePlanScheduleFromClock(
      weekly,
      reading({ expected: 70_000, paid: 70_000 }),
      new Date(2026, 8, 9),
    );
    expect(midWeek.dueOnDay).toBe(false);
    expect(midWeek.nextDueDate).toBe('2026-09-13');
  });

  it('keeps outstandingPlan on the plan amount_repaid', () => {
    const s = describePlanScheduleFromClock(
      plan({ amount_repaid: 120_000 }),
      reading({ expected: 50_000, paid: 40_000, arrears: 10_000 }),
      new Date(2026, 8, 10),
    );
    expect(s.paidToDate).toBe(40_000);
    expect(s.outstandingPlan).toBe(180_000);
  });
});

describe('isMonitoredReading', () => {
  it('feeds only counting and outstanding_balance plans that have a clock', () => {
    expect(isMonitoredReading(reading({ bucket: 'counting' }))).toBe(true);
    expect(isMonitoredReading(reading({ bucket: 'outstanding_balance' }))).toBe(true);
    expect(isMonitoredReading(reading({ bucket: 'tenant_paying_no_landlord', clock_start: null }))).toBe(false);
    expect(isMonitoredReading(reading({ bucket: 'awaiting_landlord', clock_start: null }))).toBe(false);
    expect(isMonitoredReading(reading({ bucket: 'counting', clock_start: null }))).toBe(false);
    expect(isMonitoredReading(undefined)).toBe(false);
  });
});

describe('planIdsSignature', () => {
  it('ignores order and changes when the list changes', () => {
    expect(planIdsSignature(['a', 'b', 'c'])).toBe(planIdsSignature(['c', 'a', 'b']));
    expect(planIdsSignature(['a', 'b'])).not.toBe(planIdsSignature(['a', 'c']));
    expect(planIdsSignature(['a', 'b'])).not.toBe(planIdsSignature(['a', 'b', 'c']));
  });
});
