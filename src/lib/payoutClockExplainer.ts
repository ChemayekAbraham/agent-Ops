/**
 * The one sentence shown on Agent Monitoring, the Tenant Operations Workspace and Weekly Performance,
 * so all three say the same thing about where repayments start counting.
 */
export const PAYOUT_CLOCK_EXPLAINER =
  "Repayments count from the day after the landlord's last payment. Plans whose landlord is not paid yet are listed separately.";

export interface ClockDriftStatus {
  run_date: string;
  run_at: string;
  plans_checked: number;
  /** Plans counted from a different start on the Workspace or Weekly Performance, not explained. */
  plans_differ: number;
  /** Plans that differ on purpose (a hand-set start kept by decision). */
  plans_explained: number;
  due_diff_ugx: number;
  arrears_diff_ugx: number;
}

export interface ClockDriftLine {
  agree: boolean;
  text: string;
}

const plans = (n: number) => `${n.toLocaleString('en-US')} plan${n === 1 ? '' : 's'}`;

/** "Pages agree" or "N plans differ", with when it was last checked. Null until a check has run. */
export function describeClockDrift(status: ClockDriftStatus | null | undefined): ClockDriftLine | null {
  if (!status) return null;
  const checked = `checked ${status.run_date}`;
  if (status.plans_differ > 0) {
    return { agree: false, text: `${plans(status.plans_differ)} ${status.plans_differ === 1 ? 'differs' : 'differ'} \u00b7 ${checked}` };
  }
  const kept = status.plans_explained > 0 ? ` \u00b7 ${status.plans_explained} hand-set start${status.plans_explained === 1 ? '' : 's'} kept` : '';
  return { agree: true, text: `Pages agree${kept} \u00b7 ${checked}` };
}
