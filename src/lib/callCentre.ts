/**
 * Call Centre domain logic — outcome mapping, KPI maths and roll-ups.
 *
 * React-free and Supabase-free so the rules stay unit-testable. The shapes here
 * are deliberately aligned with the `crm_call_sessions` telephony record
 * (status + hangup cause + duration) so wiring the real Africa's Talking voice
 * API later replaces the data source only, not this file.
 */

/** What actually happened on the line, as staff need to read it. */
export type CallOutcome = 'answered' | 'rejected' | 'not_reachable' | 'in_progress';

/** Whether this person had already been spoken to before the call. */
export type CallTemperature = 'cold' | 'warm';

/** Audience buckets the doughnut splits on. */
export type CalleeRole = 'tenant' | 'agent' | 'partner' | 'landlord' | 'employee';

export const CALLEE_ROLES: CalleeRole[] = ['tenant', 'agent', 'partner', 'landlord', 'employee'];

export const CALLEE_ROLE_LABEL: Record<CalleeRole, string> = {
  tenant: 'Tenants',
  agent: 'Agents',
  partner: 'Partners',
  landlord: 'Landlords',
  employee: 'Employees',
};

export const OUTCOME_LABEL: Record<CallOutcome, string> = {
  answered: 'Answered',
  rejected: 'Rejected',
  not_reachable: 'Not reachable',
  in_progress: 'In progress',
};

/**
 * One telephony attempt. Mirrors the columns the voice callback writes, so the
 * fixture layer and the eventual live query produce the same object.
 */
export interface CallRecord {
  id: string;
  /** The person on the far end. */
  calleeId: string;
  calleeName: string;
  calleePhone: string;
  calleeAvatarUrl: string | null;
  calleeRole: CalleeRole;
  location: string | null;
  /** Raw provider status, e.g. 'completed' | 'no_answer' | 'failed' | 'bridged'. */
  status: string;
  /** Raw provider hangup cause, e.g. 'USER_BUSY' | 'CALL_REJECTED' | 'NO_ANSWER'. */
  hangupCause: string | null;
  /** Seconds of connected talk time. Zero or null when never answered. */
  durationSeconds: number | null;
  /** ISO timestamp the call was placed. */
  calledAt: string;
  /** Who placed it. */
  staffId: string | null;
  staffName: string | null;
  /** Saved call summary, if staff wrote one. */
  summary: string | null;
}

/* ------------------------------------------------------------------ *
 * Provider status → outcome
 * ------------------------------------------------------------------ */

/** Provider statuses that mean the call has not settled yet. */
const LIVE_STATUSES = new Set(['initiating', 'queued', 'ringing', 'ringing_staff', 'bridged', 'in_progress']);

/** Hangup causes that mean a human actively refused the call. */
const REJECTED_CAUSES = new Set([
  'USER_BUSY',
  'CALL_REJECTED',
  'REJECTED',
  'BUSY',
  'DECLINED',
]);

/** Hangup causes that mean the handset could not be reached at all. */
const UNREACHABLE_CAUSES = new Set([
  'NO_ANSWER',
  'NO_USER_RESPONSE',
  'UNALLOCATED_NUMBER',
  'INVALID_NUMBER_FORMAT',
  'SUBSCRIBER_ABSENT',
  'NETWORK_OUT_OF_ORDER',
  'RECOVERY_ON_TIMER_EXPIRE',
  'ORIGINATOR_CANCEL',
]);

const norm = (v: string | null | undefined) => (v ?? '').trim().toUpperCase();

/**
 * Collapse a provider status + hangup cause into the outcome staff read.
 *
 * Talk time is the strongest signal available and is checked first: a provider
 * that reports a vague terminal status but a non-zero duration definitely
 * connected. Only when there is no talk time do we fall back to the hangup
 * cause, and finally to the status itself — so an unknown cause degrades to
 * "not reachable" rather than silently counting as answered.
 */
export function deriveOutcome(record: Pick<CallRecord, 'status' | 'hangupCause' | 'durationSeconds'>): CallOutcome {
  const status = (record.status ?? '').trim().toLowerCase();

  if (LIVE_STATUSES.has(status)) return 'in_progress';

  // Talk time proves a connection regardless of how the provider labelled it.
  if ((record.durationSeconds ?? 0) > 0) return 'answered';

  const cause = norm(record.hangupCause);
  if (REJECTED_CAUSES.has(cause)) return 'rejected';
  if (UNREACHABLE_CAUSES.has(cause)) return 'not_reachable';

  if (status === 'no_answer' || status === 'failed' || status === 'unreachable') return 'not_reachable';
  if (status === 'rejected' || status === 'busy') return 'rejected';

  // 'completed' with zero talk time and no usable cause never reached anyone.
  return 'not_reachable';
}

/* ------------------------------------------------------------------ *
 * Cold vs warm
 * ------------------------------------------------------------------ */

/**
 * Label each call cold or warm, oldest first.
 *
 * Warm means "we have actually spoken to this person before" — so only a prior
 * *answered* call warms them up. A string of unanswered attempts leaves the
 * next call just as cold as the first, which is what makes the cold/warm split
 * worth reporting at all.
 *
 * Input order does not matter; the function sorts chronologically itself.
 */
export function labelTemperatures(records: CallRecord[]): Map<string, CallTemperature> {
  const chronological = [...records].sort(
    (a, b) => new Date(a.calledAt).getTime() - new Date(b.calledAt).getTime(),
  );

  const spokenTo = new Set<string>();
  const out = new Map<string, CallTemperature>();

  for (const record of chronological) {
    out.set(record.id, spokenTo.has(record.calleeId) ? 'warm' : 'cold');
    if (deriveOutcome(record) === 'answered') spokenTo.add(record.calleeId);
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * KPIs
 * ------------------------------------------------------------------ */

export interface CallCentreKpis {
  totalCalls: number;
  coldCalls: number;
  warmCalls: number;
  answered: number;
  rejected: number;
  /** Rang out or unreachable — the "bounced" bucket. */
  notReachable: number;
  inProgress: number;
  /** Mean talk time over answered calls only, in seconds. Null when none answered. */
  averageTalkSeconds: number | null;
  /** Total connected talk time in seconds. */
  totalTalkSeconds: number;
  /** answered / settled calls, 0-100. Null when nothing has settled. */
  answerRate: number | null;
}

/**
 * Roll a set of calls up into the overview KPIs.
 *
 * Average talk time deliberately averages over **answered calls only**. A
 * rejected or unreachable call has zero duration, and letting those into the
 * denominator drags the average toward zero — it would report "average call
 * time" as a number no real call ever had.
 */
export function computeKpis(records: CallRecord[]): CallCentreKpis {
  const temperatures = labelTemperatures(records);

  let coldCalls = 0;
  let warmCalls = 0;
  let answered = 0;
  let rejected = 0;
  let notReachable = 0;
  let inProgress = 0;
  let totalTalkSeconds = 0;

  for (const record of records) {
    if (temperatures.get(record.id) === 'warm') warmCalls += 1;
    else coldCalls += 1;

    switch (deriveOutcome(record)) {
      case 'answered':
        answered += 1;
        totalTalkSeconds += Math.max(0, record.durationSeconds ?? 0);
        break;
      case 'rejected':
        rejected += 1;
        break;
      case 'not_reachable':
        notReachable += 1;
        break;
      case 'in_progress':
        inProgress += 1;
        break;
    }
  }

  const settled = answered + rejected + notReachable;

  return {
    totalCalls: records.length,
    coldCalls,
    warmCalls,
    answered,
    rejected,
    notReachable,
    inProgress,
    averageTalkSeconds: answered > 0 ? totalTalkSeconds / answered : null,
    totalTalkSeconds,
    answerRate: settled > 0 ? (answered / settled) * 100 : null,
  };
}

/* ------------------------------------------------------------------ *
 * Chart series
 * ------------------------------------------------------------------ */

export interface OutcomeTrendPoint {
  /** ISO date (YYYY-MM-DD) — the bucket key. */
  date: string;
  /** Short axis label, e.g. "12 Aug". */
  label: string;
  answered: number;
  rejected: number;
}

const DAY_MS = 86_400_000;

const isoDay = (d: Date) => {
  // Local-day bucketing: staff read "today" in their own timezone, not UTC.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const dayLabel = (d: Date) =>
  d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'Africa/Kampala' });

/**
 * Daily answered-vs-rejected counts over the trailing `days` window ending at
 * `endDate` (defaults to the newest call, so a fixture set is never rendered as
 * an empty chart).
 *
 * Every day in the window is emitted, including zero days — a line chart that
 * silently skips empty days compresses the x-axis and misreports the trend.
 */
export function buildOutcomeTrend(
  records: CallRecord[],
  options: { days?: number; endDate?: Date } = {},
): OutcomeTrendPoint[] {
  const days = Math.max(1, options.days ?? 14);

  const newest = records.reduce<number | null>((acc, r) => {
    const t = new Date(r.calledAt).getTime();
    if (Number.isNaN(t)) return acc;
    return acc === null || t > acc ? t : acc;
  }, null);

  const end = options.endDate ?? (newest !== null ? new Date(newest) : new Date());

  const buckets = new Map<string, { answered: number; rejected: number }>();
  for (let i = days - 1; i >= 0; i -= 1) {
    buckets.set(isoDay(new Date(end.getTime() - i * DAY_MS)), { answered: 0, rejected: 0 });
  }

  for (const record of records) {
    const at = new Date(record.calledAt);
    if (Number.isNaN(at.getTime())) continue;
    const bucket = buckets.get(isoDay(at));
    if (!bucket) continue;
    const outcome = deriveOutcome(record);
    if (outcome === 'answered') bucket.answered += 1;
    else if (outcome === 'rejected') bucket.rejected += 1;
  }

  return [...buckets.entries()].map(([date, counts]) => ({
    date,
    label: dayLabel(new Date(`${date}T12:00:00`)),
    ...counts,
  }));
}

export interface RoleShareSlice {
  role: CalleeRole;
  label: string;
  /** Distinct people reached out to in this bucket. */
  people: number;
  calls: number;
  /** Share of all people called, 0-100. */
  percent: number;
}

/**
 * Share of *people* called per audience, for the doughnut.
 *
 * Counts distinct people rather than calls, so one person rung five times does
 * not make their audience look five times bigger than it is. Empty buckets are
 * dropped — a zero-width slice is unreadable and unhoverable.
 */
export function buildRoleShare(records: CallRecord[]): RoleShareSlice[] {
  const byRole = new Map<CalleeRole, { people: Set<string>; calls: number }>();

  for (const record of records) {
    const entry = byRole.get(record.calleeRole) ?? { people: new Set<string>(), calls: 0 };
    entry.people.add(record.calleeId);
    entry.calls += 1;
    byRole.set(record.calleeRole, entry);
  }

  const totalPeople = [...byRole.values()].reduce((a, e) => a + e.people.size, 0);

  return CALLEE_ROLES
    .map((role) => {
      const entry = byRole.get(role);
      const people = entry?.people.size ?? 0;
      return {
        role,
        label: CALLEE_ROLE_LABEL[role],
        people,
        calls: entry?.calls ?? 0,
        percent: totalPeople > 0 ? (people / totalPeople) * 100 : 0,
      };
    })
    .filter((slice) => slice.people > 0)
    .sort((a, b) => b.people - a.people || a.label.localeCompare(b.label));
}

export interface MostCalledPerson {
  calleeId: string;
  name: string;
  phone: string;
  avatarUrl: string | null;
  role: CalleeRole;
  location: string | null;
  calls: number;
  answered: number;
  /** Newest call to this person in the window. */
  lastCalledAt: string;
  lastOutcome: CallOutcome;
}

/**
 * Busiest people in the given set, most-called first — the "recall them" list.
 *
 * `onDate` filters to a single local day when supplied; the overview asks for
 * "that day", but History reuses this over a wider window.
 */
export function buildMostCalled(
  records: CallRecord[],
  options: { onDate?: Date | string; limit?: number } = {},
): MostCalledPerson[] {
  const dayKey = options.onDate
    ? typeof options.onDate === 'string'
      ? options.onDate
      : isoDay(options.onDate)
    : null;

  const scoped = dayKey
    ? records.filter((r) => {
        const at = new Date(r.calledAt);
        return !Number.isNaN(at.getTime()) && isoDay(at) === dayKey;
      })
    : records;

  const byPerson = new Map<string, MostCalledPerson>();

  for (const record of scoped) {
    const outcome = deriveOutcome(record);
    const existing = byPerson.get(record.calleeId);

    if (!existing) {
      byPerson.set(record.calleeId, {
        calleeId: record.calleeId,
        name: record.calleeName,
        phone: record.calleePhone,
        avatarUrl: record.calleeAvatarUrl,
        role: record.calleeRole,
        location: record.location,
        calls: 1,
        answered: outcome === 'answered' ? 1 : 0,
        lastCalledAt: record.calledAt,
        lastOutcome: outcome,
      });
      continue;
    }

    existing.calls += 1;
    if (outcome === 'answered') existing.answered += 1;
    if (new Date(record.calledAt).getTime() > new Date(existing.lastCalledAt).getTime()) {
      existing.lastCalledAt = record.calledAt;
      existing.lastOutcome = outcome;
    }
  }

  const rows = [...byPerson.values()].sort(
    (a, b) =>
      b.calls - a.calls ||
      new Date(b.lastCalledAt).getTime() - new Date(a.lastCalledAt).getTime() ||
      a.name.localeCompare(b.name),
  );

  return options.limit ? rows.slice(0, options.limit) : rows;
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

/** `m:ss` for talk time, or `h:mm:ss` past an hour. Null renders as an em dash. */
export function formatTalkTime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Short local timestamp for table cells. */
export function formatCallStamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Africa/Kampala',
  });
}
