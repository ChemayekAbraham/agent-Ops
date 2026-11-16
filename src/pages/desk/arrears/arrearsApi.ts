import { useQuery } from '@tanstack/react-query';
import { rpc } from '../reviewApi';
import type { Status } from '../deskTheme';

/**
 * ARREARS-WATCH (E102): live plans whose collection on the watch day (daily
 * plans) or in the 7 days to it (weekly plans) is under half of what was due.
 * Agent Ops calls the agent, Tenant Ops the tenant; both see every party.
 *
 * Every count, total and order on these screens is the server's
 * (arrears_watch, arrears_watch_agents); the screen only shows them.
 */

export type Tier = 'new_slip' | 'new_plan' | 'behind' | 'silent';
/** The server's order: new slips first, silent last. */
export const TIERS: Tier[] = ['new_slip', 'new_plan', 'behind', 'silent'];
export const TIER_WORDS: Record<Tier, string> = { new_slip: 'New slip', new_plan: 'New plan', behind: 'Behind', silent: 'Silent' };
export const TIER_TONE: Record<Tier, Status> = { new_slip: 'bad', new_plan: 'warn', behind: 'warn', silent: 'bad' };
export const tierWords = (t: string) => TIER_WORDS[t as Tier] ?? t.replace(/_/g, ' ');
export const tierTone = (t: string): Status => TIER_TONE[t as Tier] ?? 'idle';

export type CallRecord = {
  party?: string | null;
  outcome: string;
  promised_date?: string | null;
  note?: string | null;
  at?: string | null;
  staff_ref?: string | null;
} | null;

export type Contact = { id?: string | null; name: string | null; phone?: string | null };
export type ArrearsRow = {
  rent_request_id: string;
  tier: string;
  frequency: string | null;
  daily_due: number | null;
  window_due: number | null;
  collected: number | null;
  pct: number | null;
  /** Week mode (E113): days in the week under half the daily due; null for weekly plans. */
  days_short?: number | null;
  arrears_to_date: number | null;
  last_paid_on: string | null;
  days_since_paid: number | null;
  plan_day: number | null;
  tenant: Contact;
  agent: Contact & { collection_pct?: number | null; eligible?: boolean | null };
  landlord: Contact & { caretaker_name?: string | null; caretaker_phone?: string | null; village?: string | null; district?: string | null };
  funder: Contact;
  tenant_ops_call: CallRecord;
  agent_ops_call: CallRecord;
};
export type ArrearsTotals = {
  plans: number;
  agents: number;
  due: number;
  collected: number;
  shortfall: number;
  arrears_to_date: number;
  new_slip: number;
  new_plan: number;
  behind: number;
  silent: number;
  tenant_called: number;
  agent_called: number;
};
export type ArrearsWatch = {
  day: string;
  /** Week mode: Monday … Sunday of the week read. */
  from?: string | null;
  to?: string | null;
  mode?: WatchMode;
  rule: string | null;
  tiers: Partial<Record<Tier, string>>;
  totals: ArrearsTotals | null;
  matching: number | null;
  rows: ArrearsRow[];
};

export type ArrearsAgent = {
  agent_id: string;
  name: string | null;
  phone: string | null;
  tenants_short: number;
  shortfall: number;
  arrears_to_date: number | null;
  new_slip: number;
  new_plan: number;
  behind: number;
  silent: number;
  collection_pct: number | null;
  eligible: boolean | null;
  agent_ops_call: CallRecord;
};
export type ArrearsAgents = { day: string; from?: string | null; to?: string | null; mode?: WatchMode; agents: ArrearsAgent[] };

/** "Yesterday" reads one day; "Last week" (E113) reads Monday to Sunday. */
export type WatchMode = 'day' | 'week';
export const MODE_WORDS: Record<WatchMode, string> = { day: 'Yesterday', week: 'Last week' };

/** Yesterday in Kampala, "YYYY-MM-DD": the server's own default watch day. */
export function yesterdayKampala(now: Date = new Date()): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kampala', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

const kampalaToday = (now: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kampala', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
/** ISO weekday in Kampala: Monday 1 … Sunday 7. */
export function kampalaIsoDow(now: Date = new Date()): number {
  const d = new Date(`${kampalaToday(now)}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}
/** The most recent Sunday before today in Kampala, the server's own default week end (today − ISO weekday). */
export function lastSundayKampala(now: Date = new Date()): string {
  const d = new Date(`${kampalaToday(now)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - kampalaIsoDow(now));
  return d.toISOString().slice(0, 10);
}
/** Mondays open on last week; other days on yesterday. */
export const defaultWatchMode = (now: Date = new Date()): WatchMode => (kampalaIsoDow(now) === 1 ? 'week' : 'day');

/** "missed 3 of 7 days", for daily plans in week mode; nothing for weekly plans or without the figure. */
export function daysShortText(row: Pick<ArrearsRow, 'days_short' | 'frequency'>): string | null {
  if (row.days_short === null || row.days_short === undefined) return null;
  if (String(row.frequency ?? '').toLowerCase() === 'weekly') return null;
  return `missed ${row.days_short} of 7 days`;
}

/** The day a call belongs to: the watch day, or in week mode the week's `to`. */
export const callDay = (mode: WatchMode, day: string, data?: { to?: string | null } | null) => (mode === 'week' ? (data?.to ?? day) : day);

export const ARREARS_KEY = ['desk-feed', 'arrears'] as const;

/**
 * `day` is the watch day in day mode, the week's Sunday (p_week_end) in week
 * mode. Week mode reads arrears_watch_week; the payload carries from / to.
 */
export function useArrearsWatch(p: { day: string; mode?: WatchMode; tier?: Tier | null; search?: string; limit: number; offset?: number; enabled?: boolean }) {
  const mode = p.mode ?? 'day';
  return useQuery({
    queryKey: [...ARREARS_KEY, 'watch', mode, p.day, p.tier ?? null, p.search ?? '', p.limit, p.offset ?? 0],
    enabled: p.enabled ?? true,
    queryFn: async (): Promise<ArrearsWatch> => {
      const common = {
        p_tier: p.tier ?? null,
        p_search: p.search?.trim() ? p.search.trim() : null,
        p_limit: p.limit,
        p_offset: p.offset ?? 0,
      };
      const { data, error } = mode === 'week' ? await rpc('arrears_watch_week', { p_week_end: p.day, ...common }) : await rpc('arrears_watch', { p_day: p.day, ...common });
      if (error) throw error;
      const d = (data ?? {}) as Partial<ArrearsWatch>;
      return {
        day: String(d.day ?? p.day),
        from: d.from ?? null,
        to: d.to ?? null,
        mode,
        rule: d.rule ?? null,
        tiers: d.tiers ?? {},
        totals: d.totals ?? null,
        matching: d.matching ?? null,
        rows: Array.isArray(d.rows) ? d.rows : [],
      };
    },
    staleTime: 30_000,
    retry: 1,
  });
}

/** The Command Centre's tile: only the totals (p_limit 1, so one row comes back with them). */
export function useArrearsTotals() {
  return useQuery({
    queryKey: [...ARREARS_KEY, 'totals'],
    queryFn: async () => {
      const { data, error } = await rpc('arrears_watch', { p_limit: 1 });
      if (error) throw error;
      const d = (data ?? {}) as Partial<ArrearsWatch>;
      return { day: d.day ?? null, totals: d.totals ?? null };
    },
    staleTime: 60_000,
    retry: 1,
  });
}

export function useArrearsAgents(day: string, mode: WatchMode = 'day') {
  return useQuery({
    queryKey: [...ARREARS_KEY, 'agents', mode, day],
    queryFn: async (): Promise<ArrearsAgents> => {
      const { data, error } = mode === 'week' ? await rpc('arrears_watch_week_agents', { p_week_end: day }) : await rpc('arrears_watch_agents', { p_day: day });
      if (error) throw error;
      const d = (data ?? {}) as Partial<ArrearsAgents>;
      return { day: String(d.day ?? day), from: d.from ?? null, to: d.to ?? null, mode, agents: Array.isArray(d.agents) ? d.agents : [] };
    },
    staleTime: 30_000,
    retry: 1,
  });
}

/* ───────────── Log call ───────────── */

export type Party = 'tenant' | 'agent' | 'landlord' | 'funder';
export const PARTY_WORDS: Record<Party, string> = { tenant: 'Tenant', agent: 'Agent', landlord: 'Landlord', funder: 'Funder' };

export type Outcome = 'will_pay_today' | 'promised_date' | 'paid_already' | 'no_answer' | 'switched_off' | 'wrong_number' | 'refused' | 'dispute' | 'other';
export const OUTCOMES: { key: Outcome; label: string }[] = [
  { key: 'will_pay_today', label: 'Will pay today' },
  { key: 'promised_date', label: 'Promised a date' },
  { key: 'paid_already', label: 'Paid already' },
  { key: 'no_answer', label: 'No answer' },
  { key: 'switched_off', label: 'Phone switched off' },
  { key: 'wrong_number', label: 'Wrong number' },
  { key: 'refused', label: 'Refused' },
  { key: 'dispute', label: 'Dispute' },
  { key: 'other', label: 'Other' },
];
export const outcomeWords = (o: string | null | undefined) => OUTCOMES.find((x) => x.key === o)?.label ?? (o ? o.replace(/_/g, ' ') : '—');
export const NEEDS_NOTE: readonly Outcome[] = ['refused', 'dispute', 'other'];
export const needsDate = (o: Outcome | '') => o === 'promised_date';
export const needsNote = (o: Outcome | '') => o !== '' && NEEDS_NOTE.includes(o);

/** The server's codes, in plain words. */
export const CALL_ERROR_WORDS: Record<string, string> = {
  STAFF_ID_REQUIRED: 'Your staff ID is not on file, so the call cannot be recorded. Ask HR to add your staff ID.',
  PROMISE_DATE_REQUIRED: 'Enter the date they promised to pay.',
  NOTE_REQUIRED: 'Write a note saying what happened.',
  CALL_TARGET_REQUIRED: 'Pick the tenant plan or the agent this call was about.',
  DESK_NOT_YOURS: 'This desk is not one of yours, so the call cannot be recorded here.',
  ARREARS_WATCH_DENIED: 'Only Agent Ops, Tenant Ops, the COO and the CEO can record arrears calls.',
  PLAN_NOT_FOUND: 'That plan could not be found.',
};

/**
 * A server refusal in plain words: a known CODE gets its sentence; an unknown
 * "CODE: words" gets the server's words; anything else is shown as it came.
 */
export function plainError(e: unknown, words: Record<string, string> = CALL_ERROR_WORDS): string {
  const msg = String((e as { message?: string } | null)?.message ?? e ?? 'Something went wrong.');
  const m = /^([A-Z][A-Z0-9_]+)(?::\s*(.*))?$/s.exec(msg.trim());
  if (!m) return msg;
  if (words[m[1]]) return words[m[1]];
  return m[2]?.trim() ? m[2].trim() : msg;
}

/** What the form checks before it asks the server (the server checks the same). */
export function validateCall(v: { outcome: Outcome | ''; note: string; promisedDate: string }): string | null {
  if (!v.outcome) return 'Pick what happened on the call.';
  if (needsDate(v.outcome) && !v.promisedDate) return CALL_ERROR_WORDS.PROMISE_DATE_REQUIRED;
  if (needsNote(v.outcome) && !v.note.trim()) return CALL_ERROR_WORDS.NOTE_REQUIRED;
  return null;
}

export type CallInput = {
  party: Party;
  outcome: Outcome;
  rentRequestId?: string | null;
  agentId?: string | null;
  note?: string;
  promisedDate?: string;
  promisedAmount?: string;
  desk: 'agent-ops' | 'tenant-ops';
  day?: string;
};

export async function logArrearsCall(c: CallInput): Promise<{ ok: boolean; message?: string }> {
  const amount = c.promisedAmount?.trim() ? Number(c.promisedAmount.replace(/[, ]/g, '')) : null;
  const args: Record<string, unknown> = {
    p_party: c.party,
    p_outcome: c.outcome,
    p_note: c.note?.trim() ? c.note.trim() : null,
    p_promised_date: c.outcome === 'promised_date' && c.promisedDate ? c.promisedDate : null,
    p_promised_amount: c.outcome === 'promised_date' && amount !== null && Number.isFinite(amount) ? amount : null,
    p_desk: c.desk,
  };
  if (c.rentRequestId) args.p_rent_request_id = c.rentRequestId;
  if (c.agentId) args.p_agent_id = c.agentId;
  // The call belongs to the watch day on screen (the server's default is yesterday too).
  if (c.day) args.p_day = c.day;
  const { error } = await rpc('arrears_log_call', args);
  if (error) return { ok: false, message: plainError(error) };
  return { ok: true };
}

/* ───────────── phones ───────────── */

export const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, '')}`;
/** wa.me wants the number in full: Uganda's 07… becomes 2567…. */
export function waHref(phone: string, text?: string): string {
  let d = phone.replace(/\D/g, '');
  if (d.startsWith('0')) d = `256${d.slice(1)}`;
  else if (d.length === 9) d = `256${d}`;
  return `https://wa.me/${d}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}
export const smsHref = (phone: string, text: string) => `sms:${phone.replace(/[^\d+]/g, '')}?body=${encodeURIComponent(text)}`;
