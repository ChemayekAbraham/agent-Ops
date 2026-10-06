/** Wording, colours and number formatting for the Tenant Payment Behavior tab and its PDF. Display only. */
import { format, parseISO } from 'date-fns';
import { formatUGX } from '@/lib/rentCalculations';
import type {
  BehaviouralSegmentKey, LagBucketKey, PaymentBehaviorDimension, ShiftKey, WarningFlag,
} from '@/hooks/tenantOpsWorkspace/usePaymentBehavior';

export const SELF_COLOR = 'hsl(var(--primary))';
export const AGENT_COLOR = 'hsl(var(--info))';
export const MIXED_COLOR = 'hsl(var(--warning))';
export const NONE_COLOR = 'hsl(var(--muted-foreground))';
export const GOOD_COLOR = 'hsl(var(--success))';
export const BAD_COLOR = 'hsl(var(--destructive))';

export const TENANT_GROUP_LABEL: Record<string, string> = {
  self_only: 'Pay themselves only',
  mixed: 'Pay themselves and via agents',
  agent_only: 'Paid for by agents only',
  no_payment: 'Billed, nothing paid',
};

export const TENANT_GROUP_COLOR: Record<string, string> = {
  self_only: SELF_COLOR,
  mixed: MIXED_COLOR,
  agent_only: AGENT_COLOR,
  no_payment: NONE_COLOR,
};

export const BEHAVIOUR_SEGMENT_LABEL: Record<BehaviouralSegmentKey, string> = {
  self_reliant: 'Self-reliant',
  hybrid: 'Hybrid',
  agent_led_some_self: 'Agent-led, some self-pay',
  agent_dependent: 'Agent-dependent',
  no_payment: 'No payment',
};

export const BEHAVIOUR_SEGMENT_HINT: Record<BehaviouralSegmentKey, string> = {
  self_reliant: '80% or more of what they paid came from their own payments',
  hybrid: '20% to 80% of what they paid came from their own payments',
  agent_led_some_self: 'Under 20% self-paid, the rest through agents',
  agent_dependent: 'Every payment was made by an agent',
  no_payment: 'Billed in the period but nothing paid',
};

export const SHIFT_LABEL: Record<ShiftKey, string> = {
  moving_to_agents: 'Moving to agents',
  moving_to_self: 'Moving to self-pay',
  new_self_adopter: 'New self-payers',
};

export const SHIFT_HINT: Record<ShiftKey, string> = {
  moving_to_agents: 'Used to pay mostly themselves, now rely on agents (or stopped self-paying)',
  moving_to_self: 'Used to rely on agents, now pay a large share themselves',
  new_self_adopter: 'Paid only through agents before, now pay at least some themselves',
};

export const FLAG_LABEL: Record<WarningFlag, string> = {
  silent: 'Gone quiet',
  slipping: 'Slipping',
  behind: 'Behind',
  moving_to_agent: 'Moving to agents',
  refused_attempt: 'Self-pay refused',
};

export const FLAG_HINT: Record<WarningFlag, string> = {
  silent: 'No payment for longer than their usual gap (at least 3 days, 10 for weekly)',
  slipping: 'The last 7 days covered 30+ points less of the bill than the 7 days before',
  behind: '7 or more days behind on the oldest unpaid bill',
  moving_to_agent: 'Was paying mostly themselves, now 20% or less',
  refused_attempt: 'Tried to pay themselves in the last 14 days and was refused',
};

export const DIMENSION_LABEL: Record<PaymentBehaviorDimension, string> = {
  agent: 'Agent',
  region: 'Region',
  district: 'District',
  rent_band: 'Rent level',
  cadence: 'Payment frequency',
  cohort: 'Plan start month',
};

export const LAG_BUCKET_LABEL: Record<LagBucketKey, string> = {
  ahead: 'Ahead of the due day',
  same_day: 'On the due day',
  late_1_3: '1-3 days late',
  late_4_7: '4-7 days late',
  late_8_14: '8-14 days late',
  late_15_plus: '15+ days late',
};

export const LAG_BUCKET_COLOR: Record<LagBucketKey, string> = {
  ahead: 'hsl(var(--success))',
  same_day: 'hsl(var(--success) / 0.6)',
  late_1_3: 'hsl(var(--warning) / 0.7)',
  late_4_7: 'hsl(var(--warning))',
  late_8_14: 'hsl(var(--destructive) / 0.7)',
  late_15_plus: 'hsl(var(--destructive))',
};

export const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export const plural = (n: number | null | undefined, one: string, many?: string) => `${num(n)} ${Number(n) === 1 ? one : (many ?? `${one}s`)}`;
export const num = (n: number | null | undefined) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US'));
export const pct = (n: number | null | undefined, digits = 1) => (n === null || n === undefined ? '—' : `${Number(n).toFixed(digits)}%`);
export const ugx = (n: number | null | undefined) => (n === null || n === undefined ? '—' : formatUGX(Number(n)));
export const signedPp = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : `${n > 0 ? '+' : n < 0 ? '-' : ''}${Math.abs(n).toFixed(1)} pts`;

export const fmtDay = (iso: string | null | undefined) => (iso ? format(parseISO(iso), 'd MMM yyyy') : '—');
export const fmtDayShort = (iso: string) => format(parseISO(iso), 'd MMM');
export const fmtHour = (h: number | null | undefined) => {
  if (h === null || h === undefined) return '—';
  const whole = Math.floor(h);
  const suffix = whole >= 12 ? 'pm' : 'am';
  const twelve = whole % 12 === 0 ? 12 : whole % 12;
  return `${twelve}${suffix}`;
};

/** Compact UGX for chart axes only, e.g. 1,250,000 -> "1.3M". Exact UGX always appears in tooltips and tables. */
export const axisUgx = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n);

export const CONFIDENCE_LABEL: Record<string, string> = { low: 'Low confidence', moderate: 'Moderate confidence' };
