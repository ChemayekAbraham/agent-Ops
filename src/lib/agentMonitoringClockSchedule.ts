/**
 * Agent Monitoring on the landlord-payout clock.
 *
 * A Rent Plan's repayments are counted from the day AFTER the landlord was paid (the LAST
 * landlord payout), not from the stored `repayment_starts_on`. The database decides that day
 * (`am_plan_clock`) and the arrears on it (`am_plan_arrears`); this file only maps those rows
 * onto the same `PlanSchedule` shape the page already renders, so the schedule rules in
 * `agentMonitoringSchedule.ts` (daily vs weekly, weekly due day, covered-by-advance) stay the
 * single source of truth and are not duplicated or edited.
 *
 * Only plans whose bucket is `counting` or `outstanding_balance` have a clock to monitor.
 * `tenant_paying_no_landlord` and `awaiting_landlord` have no landlord payout yet, so
 * nothing is expected of them and they stay off the main Agent Monitoring figures.
 */
import { describePlanSchedule, type PlanSchedule, type SchedulePlanInput } from './agentMonitoringSchedule';

export type AmBucket =
  | 'counting'
  | 'tenant_paying_no_landlord'
  | 'awaiting_landlord'
  | 'outstanding_balance';

/** One row of `am_plan_clock`. */
export interface AmPlanClockRow {
  rent_request_id: string;
  bucket: AmBucket | string;
  landlord_paid_count: number;
  landlord_paid_total: number;
  landlord_paid_dates_estimated: number;
  first_landlord_paid_on: string | null;
  last_landlord_paid_on: string | null;
  clock_start: string | null;
  clock_end: string | null;
  current_start: string | null;
  shift_days: number | null;
}

/** One row of `am_plan_arrears`. */
export interface AmPlanArrearsRow {
  rent_request_id: string;
  bucket: AmBucket | string;
  cadence: 'daily' | 'weekly' | string;
  unit: 'day' | 'week' | string;
  clock_start: string | null;
  expected_to_date: number;
  paid_to_date: number;
  arrears: number;
  days_behind: number;
  days_ahead: number;
  periods_behind: number;
  periods_ahead: number;
}

/** Both server readings for one plan. */
export interface AmPlanClockReading {
  clock: AmPlanClockRow;
  arrears: AmPlanArrearsRow;
}

/** Buckets that feed the Agent Monitoring figures. */
export const MONITORED_BUCKETS: readonly string[] = ['counting', 'outstanding_balance'];

const num = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** True when the plan has a clock the page should count from. */
export function isMonitoredReading(reading: AmPlanClockReading | undefined): reading is AmPlanClockReading {
  return Boolean(reading && MONITORED_BUCKETS.includes(reading.clock.bucket) && reading.clock.clock_start);
}

/**
 * The plan's position against its own schedule on `referenceDay`, counted from the clock.
 *
 * `clock_start` replaces `repayment_starts_on` / `created_at`. Money and ageing (expected so
 * far, arrears, periods behind, periods ahead, paid ahead) are the server's `am_plan_arrears`
 * figures; the day-level reading (due on the day, covered by advance, weekly due day, next
 * due date) is derived from the same start and the same paid amount, so the two agree.
 * `outstandingPlan` stays on the plan's own `amount_repaid`, as before.
 */
export function describePlanScheduleFromClock(
  plan: SchedulePlanInput,
  reading: AmPlanClockReading,
  referenceDay: Date,
): PlanSchedule {
  const paid = num(reading.arrears.paid_to_date);
  const expected = num(reading.arrears.expected_to_date);
  const base = describePlanSchedule(
    { ...plan, repayment_starts_on: reading.clock.clock_start, amount_repaid: paid },
    referenceDay,
  );
  const total = num(plan.total_repayment);
  return {
    ...base,
    paidToDate: paid,
    scheduledToDate: expected,
    arrears: num(reading.arrears.arrears),
    periodsBehind: num(reading.arrears.periods_behind),
    periodsAhead: num(reading.arrears.periods_ahead),
    aheadAmount: Math.max(0, paid - expected),
    outstandingPlan: Math.max(0, total - num(plan.amount_repaid)),
  };
}

/** Stable signature of a list of plan ids, for the React Query key (the list itself is large). */
export function planIdsSignature(ids: readonly string[]): string {
  const sorted = [...ids].sort();
  let hash = 5381;
  for (const id of sorted) {
    for (let i = 0; i < id.length; i += 1) hash = ((hash * 33) ^ id.charCodeAt(i)) >>> 0;
  }
  return `${sorted.length}:${hash.toString(36)}`;
}
