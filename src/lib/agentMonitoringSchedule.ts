/**
 * Payment-schedule awareness for Tenant Ops → Agent Monitoring.
 *
 * This mirrors the rules already enforced by `v_agent_daily_eligibility`
 * (see mem://business-model/weekly-plans-daily-eligibility):
 *   - a plan's period is DAILY unless `repayment_frequency = 'weekly'`;
 *   - a weekly plan is due on the weekday derived from `repayment_starts_on`
 *     (start + 7k), and only re-enters the daily picture when its week lapsed
 *     unpaid;
 *   - a weekly obligation is the stored `daily_repayment` x 7.
 *
 * It invents no new payment rule: arrears and ahead-coverage are derived from
 * the plan's own scheduled amount and its existing cumulative `amount_repaid`,
 * with payments clearing outstanding periods first and any surplus covering
 * future periods (the same order the repayment engine applies).
 */

export interface SchedulePlanInput {
  daily_repayment: number | null;
  total_repayment: number | null;
  amount_repaid: number | null;
  repayment_frequency: string | null;
  repayment_starts_on: string | null;
  created_at: string;
}

export interface PlanSchedule {
  /** True when the plan repays weekly. */
  weekly: boolean;
  /** 'day' | 'week' — the unit every count below is expressed in. */
  unit: 'day' | 'week';
  /** UGX due per scheduled period (weekly = daily x 7). */
  periodAmount: number;
  /** UGX the schedule says should have been paid by the reference day. */
  scheduledToDate: number;
  /** Cumulative UGX repaid on the plan. */
  paidToDate: number;
  /** UGX still owed for periods already due (payments clear these first). */
  arrears: number;
  /** Whole periods behind, excluding the current period. */
  periodsBehind: number;
  /** UGX paid beyond every period due so far. */
  aheadAmount: number;
  /** Whole future periods already covered by the surplus. */
  periodsAhead: number;
  /** The schedule places an obligation on the reference day. */
  dueOnDay: boolean;
  /** Due, but already settled by earlier over-payment. */
  coveredByAdvance: boolean;
  /** UGX genuinely expected from this tenant on the reference day. */
  expectedOnDay: number;
  /** Next scheduled payment date (ISO yyyy-MM-dd) for weekly plans. */
  nextDueDate: string | null;
  /**
   * How the reference day reads for this plan:
   *  - 'due_today'     money is expected from the tenant today;
   *  - 'due_this_week' weekly plan whose instalment day has not arrived yet;
   *  - 'covered'       due, but already settled by earlier over-payment;
   *  - 'not_due'       the schedule places nothing on this day.
   */
  dueState: 'due_today' | 'due_this_week' | 'covered' | 'not_due';
  /** Whole days from the reference day to `nextDueDate` (weekly plans only). */
  daysToNextDue: number | null;
  /** Remaining balance on the whole rent plan. */
  outstandingPlan: number;
}

const DAY_MS = 86_400_000;

const toNumber = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** Midnight-anchored local date from a yyyy-MM-dd string. */
function fromIsoDate(iso: string): Date {
  const [year, month, day] = iso.slice(0, 10).split('-').map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

function toIsoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function diffDays(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / DAY_MS);
}

export function isWeeklyPlan(plan: Pick<SchedulePlanInput, 'repayment_frequency'>): boolean {
  return String(plan.repayment_frequency || 'daily').toLowerCase() === 'weekly';
}

/**
 * Position of one rent plan against its own schedule on `referenceDay`.
 */
export function describePlanSchedule(plan: SchedulePlanInput, referenceDay: Date): PlanSchedule {
  const weekly = isWeeklyPlan(plan);
  const daily = toNumber(plan.daily_repayment);
  const periodAmount = weekly ? daily * 7 : daily;
  const total = toNumber(plan.total_repayment);
  const paidToDate = toNumber(plan.amount_repaid);
  const outstandingPlan = Math.max(0, total - paidToDate);

  const startIso = plan.repayment_starts_on || plan.created_at.slice(0, 10);
  const start = fromIsoDate(startIso);
  const day = fromIsoDate(toIsoDate(referenceDay));
  const elapsed = diffDays(day, start);

  const totalPeriods = periodAmount > 0 ? Math.ceil(total / periodAmount) : 0;

  let periodsDue = 0;
  if (elapsed >= 0) periodsDue = weekly ? Math.floor(elapsed / 7) + 1 : elapsed + 1;
  if (totalPeriods > 0) periodsDue = Math.min(periodsDue, totalPeriods);

  const scheduledToDate = Math.min(total > 0 ? total : periodAmount * periodsDue, periodAmount * periodsDue);
  const arrears = Math.max(0, scheduledToDate - paidToDate);
  const aheadAmount = Math.max(0, paidToDate - scheduledToDate);
  const periodsBehind = periodAmount > 0 ? Math.max(0, Math.ceil(arrears / periodAmount) - 1) : 0;
  const periodsAhead = periodAmount > 0 ? Math.floor(aheadAmount / periodAmount) : 0;

  // Weekly plans only carry an obligation on their scheduled weekday; a lapsed
  // week (arrears outstanding) keeps them due until it is cleared.
  const onScheduledDay = elapsed >= 0 && (weekly ? elapsed % 7 === 0 : true);
  const dueOnDay = periodsDue > 0 && (onScheduledDay || arrears > 0);
  const coveredByAdvance = dueOnDay && arrears === 0;
  const expectedOnDay = dueOnDay && arrears > 0 ? Math.min(periodAmount, arrears) : 0;

  let nextDueDate: string | null = null;
  if (weekly) {
    if (elapsed < 0) nextDueDate = toIsoDate(start);
    else {
      const weeks = Math.floor(elapsed / 7) + (elapsed % 7 === 0 && arrears > 0 ? 0 : 1);
      nextDueDate = toIsoDate(new Date(start.getTime() + weeks * 7 * DAY_MS));
    }
  }

  const daysToNextDue = nextDueDate ? diffDays(fromIsoDate(nextDueDate), day) : null;

  // A weekly tenant whose instalment day has not arrived yet reads as owing this
  // week, not today. Nothing about the arrears arithmetic changes: the moment the
  // instalment day arrives the plan is due today and any shortfall counts from it.
  const dueState: PlanSchedule['dueState'] = expectedOnDay > 0
    ? 'due_today'
    : coveredByAdvance
      ? 'covered'
      : weekly && periodsDue > 0 && arrears === 0 && !onScheduledDay && aheadAmount < periodAmount
        ? 'due_this_week'
        : 'not_due';

  return {
    weekly,
    unit: weekly ? 'week' : 'day',
    periodAmount,
    scheduledToDate,
    paidToDate,
    arrears,
    periodsBehind,
    aheadAmount,
    periodsAhead,
    dueOnDay,
    coveredByAdvance,
    expectedOnDay,
    nextDueDate,
    dueState,
    daysToNextDue,
    outstandingPlan,
  };
}

export type AgentScheduleStatus = 'full' | 'partial' | 'critical' | 'none';

/**
 * Agent status that understands the schedule: an agent whose tenants were not
 * due today is never Critical — there was nothing to collect.
 */
export function scheduleAwareStatus(expected: number, collected: number): AgentScheduleStatus {
  if (expected <= 0) return 'none';
  if (collected >= expected) return 'full';
  if (collected > 0) return 'partial';
  return 'critical';
}
