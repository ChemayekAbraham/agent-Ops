/** Plain-language labels and the one-line summary for a Rent Plan's latest follow-up. */
import { format, parseISO } from 'date-fns';
import type {
  ShortfallFollowupFilter, ShortfallFollowupLatest, ShortfallFollowupOutcome,
} from './useShortfallFollowups';

export const FOLLOWUP_OUTCOMES: { value: ShortfallFollowupOutcome; label: string; hint: string }[] = [
  { value: 'reached_will_pay', label: 'Reached, will pay', hint: 'Spoke to the tenant, who promised to pay' },
  { value: 'reached_refused', label: 'Reached, refused', hint: 'Spoke to the tenant, who will not pay' },
  { value: 'no_answer', label: 'No answer', hint: 'Called, nobody picked up' },
  { value: 'wrong_number', label: 'Wrong number', hint: 'The number is not the tenant’s' },
  { value: 'agent_informed', label: 'Agent informed', hint: 'Told the agent to follow up' },
];

/** Short phrase used inside the "Followed up 2h ago: ..." line. */
const OUTCOME_PHRASE: Record<ShortfallFollowupOutcome, string> = {
  reached_will_pay: 'will pay',
  reached_refused: 'refused',
  no_answer: 'no answer',
  wrong_number: 'wrong number',
  agent_informed: 'agent informed',
};

export const FOLLOWUP_FILTERS: { value: ShortfallFollowupFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'not_followed_up', label: 'Not followed up' },
  { value: 'promised', label: 'Promised to pay' },
  { value: 'promise_passed', label: 'Promise date passed' },
];

export const MIN_FOLLOWUP_NOTE = 10;

/** "just now", "5m ago", "2h ago", "3d ago", then a date for anything older than 30 days. */
export function timeAgoShort(iso: string, now: Date = new Date()): string {
  const then = parseISO(iso);
  const secs = Math.max(0, Math.floor((now.getTime() - then.getTime()) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days <= 30) return `${days}d ago`;
  return format(then, 'dd MMM yyyy');
}

export interface FollowupSummary {
  /** "Followed up 2h ago: will pay Fri 9 Oct" */
  line: string;
  /** True when the plan was promised a payment date that is already behind today. */
  promisePassed: boolean;
  note: string;
  by: string | null;
  count: number;
}

export function describeFollowup(f: ShortfallFollowupLatest, now: Date = new Date()): FollowupSummary {
  const promised = f.promised_date ? parseISO(f.promised_date) : null;
  const today = format(now, 'yyyy-MM-dd');
  const promisePassed = f.outcome === 'reached_will_pay' && !!f.promised_date && f.promised_date < today;
  const phrase = OUTCOME_PHRASE[f.outcome] ?? f.outcome;
  const when = promised ? ` ${format(promised, 'EEE d MMM')}` : '';
  return {
    line: `Followed up ${timeAgoShort(f.created_at, now)}: ${phrase}${when}`,
    promisePassed,
    note: f.note,
    by: f.actor_name,
    count: f.followup_count,
  };
}

export function outcomeLabel(outcome: string): string {
  return FOLLOWUP_OUTCOMES.find((o) => o.value === outcome)?.label ?? outcome;
}
