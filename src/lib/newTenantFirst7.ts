// Types and small pure helpers for the Agent Ops "First 7 Days" tab.
//
// The server decides everything that matters: which plans are new, what each day was due and paid, each day's state and each
// row's status (am_new_tenant_first7_v2 and am_new_tenant_first7_summary_v2). Nothing here recomputes a state or a status.
// What is here: Kampala dates and the date presets, reading and writing the URL, turning the rpc's loosely typed JSON into numbers,
// and ordering / filtering rows that the server already classified.

export type DayState = 'paid' | 'part' | 'missed' | 'not_due' | 'future';
export type RowStatus = 'on_track' | 'behind' | 'not_started' | 'too_early';
export type FrequencyFilter = 'all' | 'daily' | 'weekly';

export interface First7Row {
  rent_request_id: string;
  tenant_id: string | null;
  tenant_name: string | null;
  tenant_phone: string | null;
  agent_id: string | null;
  agent_name: string | null;
  landlord_paid_on: string;
  day1: string;
  frequency: 'daily' | 'weekly';
  daily_due: number;
  total_repayment: number;
  day_paid: number[];
  day_due: number[];
  day_state: DayState[];
  paid_7d: number;
  expected_to_date: number;
  first_paid_day: number | null;
  row_status: RowStatus;
}

export interface First7DaySummary {
  day: number;
  started: number;
  payers: number;
  paid_amount: number;
  due_amount: number;
  states: Record<DayState, number>;
}

export interface First7Summary {
  from: string;
  to: string;
  as_at: string;
  plans: number;
  daily_plans: number;
  weekly_plans: number;
  status: Record<RowStatus, number>;
  day1: { started: number; payers: number; pct: number | null };
  per_day: First7DaySummary[];
  collected: number;
  expected: number;
  collected_pct: number | null;
}

// ---------- dates (Kampala, yyyy-MM-dd) ----------

export const MAX_RANGE_DAYS = 31;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function kampalaToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kampala' }).format(now);
}

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

export function isIsoDate(s: string | null | undefined): s is string {
  return !!s && ISO.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && addDays(s, 0) === s;
}

export type PresetId = 'yesterday' | 'last7' | 'last30' | 'custom';

export const PRESETS: ReadonlyArray<{ id: Exclude<PresetId, 'custom'>; label: string }> = [
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'last7', label: 'Last 7 days' },
  { id: 'last30', label: 'Last 30 days' },
];

export function presetRange(id: Exclude<PresetId, 'custom'>, today: string): { from: string; to: string } {
  if (id === 'yesterday') return { from: addDays(today, -1), to: addDays(today, -1) };
  if (id === 'last7') return { from: addDays(today, -6), to: today };
  return { from: addDays(today, -29), to: today };
}

/** Which preset a range is, or 'custom'. */
export function presetOf(from: string, to: string, today: string): PresetId {
  for (const p of PRESETS) {
    const r = presetRange(p.id, today);
    if (r.from === from && r.to === to) return p.id;
  }
  return 'custom';
}

/** Keeps a custom range inside the server's limits: end not after today, start not after the end, at most 31 days. `moved` is the end the user changed. */
export function clampRange(from: string, to: string, today: string, moved: 'from' | 'to'): { from: string; to: string } {
  let f = from;
  let t = to;
  if (t > today) t = today;
  if (f > today) f = today;
  if (f > t) { if (moved === 'from') t = f; else f = t; }
  if (daysBetween(f, t) > MAX_RANGE_DAYS - 1) { if (moved === 'from') t = addDays(f, MAX_RANGE_DAYS - 1); else f = addDays(t, -(MAX_RANGE_DAYS - 1)); }
  return { from: f, to: t };
}

// ---------- the tab's state, kept in the URL ----------

export type CardFilter = 'all' | 'day1' | RowStatus;
export const CARD_FILTERS: ReadonlyArray<CardFilter> = ['all', 'day1', 'on_track', 'behind', 'not_started', 'too_early'];

export interface First7Params {
  from: string;
  to: string;
  freq: FrequencyFilter;
  q: string;
  card: CardFilter;
  /** 1 to 7: only plans that paid on that day; null = off */
  day: number | null;
  /** only this agent's Rent Plans (an agent id); null = everyone */
  agent: string | null;
}

export const URL_KEYS = ['f7from', 'f7to', 'f7freq', 'f7q', 'f7card', 'f7day', 'f7agent'] as const;

export function hasFirst7Params(sp: URLSearchParams): boolean {
  return URL_KEYS.some((k) => sp.has(k));
}

export function readFirst7Params(sp: URLSearchParams, today: string): First7Params {
  const def = presetRange('yesterday', today);
  let from = sp.get('f7from');
  let to = sp.get('f7to');
  if (!isIsoDate(from) || !isIsoDate(to) || from > to || to > today || daysBetween(from, to) > MAX_RANGE_DAYS - 1) {
    from = def.from;
    to = def.to;
  }
  const f = sp.get('f7freq');
  const c = sp.get('f7card') as CardFilter | null;
  const d = Number(sp.get('f7day'));
  return {
    from,
    to,
    freq: f === 'daily' || f === 'weekly' ? f : 'all',
    q: (sp.get('f7q') ?? '').slice(0, 80),
    card: c && CARD_FILTERS.includes(c) ? c : 'all',
    day: Number.isInteger(d) && d >= 1 && d <= 7 ? d : null,
    agent: UUID.test(sp.get('f7agent') ?? '') ? (sp.get('f7agent') as string) : null,
  };
}

/** The URL for these params. Other parameters in `base` (for example `section`) are kept; defaults are left out. */
export function writeFirst7Params(base: URLSearchParams, p: First7Params, today: string): URLSearchParams {
  const next = new URLSearchParams(base);
  URL_KEYS.forEach((k) => next.delete(k));
  const def = presetRange('yesterday', today);
  if (p.from !== def.from || p.to !== def.to) { next.set('f7from', p.from); next.set('f7to', p.to); }
  if (p.freq !== 'all') next.set('f7freq', p.freq);
  if (p.q.trim()) next.set('f7q', p.q);
  if (p.card !== 'all') next.set('f7card', p.card);
  if (p.day !== null) next.set('f7day', String(p.day));
  if (p.agent) next.set('f7agent', p.agent);
  return next;
}

// ---------- the rpc's JSON ----------

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const nums = (v: unknown): number[] => (Array.isArray(v) ? v.map(num) : []);

export function normalizeRow(raw: Record<string, unknown>): First7Row {
  return {
    rent_request_id: String(raw.rent_request_id),
    tenant_id: (raw.tenant_id as string) ?? null,
    tenant_name: (raw.tenant_name as string) ?? null,
    tenant_phone: (raw.tenant_phone as string) ?? null,
    agent_id: (raw.agent_id as string) ?? null,
    agent_name: (raw.agent_name as string) ?? null,
    landlord_paid_on: String(raw.landlord_paid_on),
    day1: String(raw.day1),
    frequency: raw.frequency === 'weekly' ? 'weekly' : 'daily',
    daily_due: num(raw.daily_due),
    total_repayment: num(raw.total_repayment),
    day_paid: nums(raw.day_paid),
    day_due: nums(raw.day_due),
    day_state: (Array.isArray(raw.day_state) ? raw.day_state : []) as DayState[],
    paid_7d: num(raw.paid_7d),
    expected_to_date: num(raw.expected_to_date),
    first_paid_day: raw.first_paid_day == null ? null : num(raw.first_paid_day),
    row_status: raw.row_status as RowStatus,
  };
}

const EMPTY_STATES: Record<DayState, number> = { paid: 0, part: 0, missed: 0, not_due: 0, future: 0 };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});

export function normalizeSummary(raw: Obj | null): First7Summary {
  const r = obj(raw);
  const status = obj(r.status);
  const day1 = obj(r.day1);
  const pct = (v: unknown) => (v == null ? null : num(v));
  return {
    from: String(r.from ?? ''),
    to: String(r.to ?? ''),
    as_at: String(r.as_at ?? ''),
    plans: num(r.plans),
    daily_plans: num(r.daily_plans),
    weekly_plans: num(r.weekly_plans),
    status: { on_track: num(status.on_track), behind: num(status.behind), not_started: num(status.not_started), too_early: num(status.too_early) },
    day1: { started: num(day1.started), payers: num(day1.payers), pct: pct(day1.pct) },
    per_day: (Array.isArray(r.per_day) ? r.per_day : []).map((raw: unknown) => {
      const d = obj(raw);
      return {
        day: num(d.day),
        started: num(d.started),
        payers: num(d.payers),
        paid_amount: num(d.paid_amount),
        due_amount: num(d.due_amount),
        states: { ...EMPTY_STATES, ...Object.fromEntries(Object.entries(obj(d.states)).map(([k, v]) => [k, num(v)])) },
      };
    }),
    collected: num(r.collected),
    expected: num(r.expected),
    collected_pct: pct(r.collected_pct),
  };
}

/** One plain line for an error from the three functions. Never empty. */
export function first7ErrorMessage(raw: unknown): string {
  const e = raw as { message?: string; code?: string } | null;
  const text = String(e?.message ?? raw ?? '').trim();
  if (e?.code === '42501' || /not authorized|permission denied/i.test(text)) return 'You do not have access to Agent Monitoring.';
  if (text.includes('RANGE_TOO_LARGE')) return 'Pick a range of at most 31 days.';
  if (text.includes('RANGE_INVALID')) return 'The end date is before the start date.';
  if (text.includes('RANGE_REQUIRED')) return 'Pick a start and an end date.';
  return text.split('\n')[0].replace(/^[A-Z_]{4,}:\s*/, '').trim() || 'Something went wrong. Please try again.';
}

// ---------- ordering and filtering (the server has already classified every row) ----------

const STATUS_RANK: Record<RowStatus, number> = { behind: 0, not_started: 1, on_track: 2, too_early: 3 };

/** Behind and not-started plans first (the biggest gap first); then on track; then plans whose day 1 has not come. */
export function sortFirst7Rows(rows: First7Row[]): First7Row[] {
  const gap = (r: First7Row) => Math.max(0, r.expected_to_date - r.paid_7d);
  return [...rows].sort((a, b) =>
    STATUS_RANK[a.row_status] - STATUS_RANK[b.row_status]
    || gap(b) - gap(a)
    || (a.agent_name ?? '').localeCompare(b.agent_name ?? '')
    || (a.tenant_name ?? '').localeCompare(b.tenant_name ?? ''));
}

export function matchesCard(r: First7Row, card: CardFilter): boolean {
  if (card === 'all') return true;
  if (card === 'day1') return (r.day_paid[0] ?? 0) > 0;
  return r.row_status === card;
}

export function filterFirst7Rows(rows: First7Row[], p: Pick<First7Params, 'q' | 'card' | 'day'> & { agent?: string | null }): First7Row[] {
  const q = p.q.trim().toLowerCase();
  return rows.filter((r) => {
    if (p.agent && r.agent_id !== p.agent) return false;
    if (!matchesCard(r, p.card)) return false;
    if (p.day !== null && (r.day_paid[p.day - 1] ?? 0) <= 0) return false;
    if (!q) return true;
    return [r.agent_name, r.tenant_name, r.tenant_phone].some((v) => (v ?? '').toLowerCase().includes(q));
  });
}

export const STATUS_LABEL: Record<RowStatus, string> = {
  on_track: 'On track',
  behind: 'Behind',
  not_started: 'Not started',
  too_early: 'Too early',
};

export const DAY_STATE_LABEL: Record<DayState, string> = {
  paid: 'Paid',
  part: 'Part paid',
  missed: 'Missed',
  not_due: 'Not due',
  future: 'Not reached yet',
};

// ---------- one agent's seven days ----------

export interface AgentOnTrack {
  agent_id: string;
  agent_name: string | null;
  /** Rent Plans of this agent whose day 1 has begun (everything except "too early") */
  started: number;
  on_track: number;
  /** whole percent, or null when none has started */
  pct: number | null;
}

/** Counts the server's own row statuses for one agent. A status is never worked out here. */
export function agentOnTrack(rows: First7Row[], agentId: string): AgentOnTrack {
  const mine = rows.filter((r) => r.agent_id === agentId);
  const started = mine.filter((r) => r.row_status !== 'too_early').length;
  const onTrack = mine.filter((r) => r.row_status === 'on_track').length;
  return {
    agent_id: agentId,
    agent_name: mine.find((r) => r.agent_name)?.agent_name ?? null,
    started,
    on_track: onTrack,
    pct: started > 0 ? Math.round((100 * onTrack) / started) : null,
  };
}

// ---------- the payments behind a plan's seven days (am_new_tenant_first7_payments) ----------

export interface First7Payment {
  collection_id: string;
  collected_at: string;
  collected_day: string;
  day_number: number;
  amount: number;
  payment_method: string | null;
  collection_channel: string | null;
  agent_id: string | null;
  agent_name: string | null;
}

export function normalizePayment(raw: Record<string, unknown>): First7Payment {
  return {
    collection_id: String(raw.collection_id),
    collected_at: String(raw.collected_at),
    collected_day: String(raw.collected_day),
    day_number: num(raw.day_number),
    amount: num(raw.amount),
    payment_method: (raw.payment_method as string) ?? null,
    collection_channel: (raw.collection_channel as string) ?? null,
    agent_id: (raw.agent_id as string) ?? null,
    agent_name: (raw.agent_name as string) ?? null,
  };
}

/** Cash, Wallet or Self-pay. A tenant paying from their own number is Self-pay whatever the wallet was; everything else is told by the payment method. */
export function paymentMethodLabel(method: string | null | undefined, channel: string | null | undefined): string {
  if (channel === 'tenant_deposit_auto') return 'Self-pay';
  const m = (method ?? '').toLowerCase();
  if (m === 'cash') return 'Cash';
  if (m === 'in_app_wallet' || m === 'wallet') return 'Wallet';
  return m ? m.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : '—';
}

// ---------- Kampala time for the screen and the exports ----------

/** "15 Oct 2026, 14:32 EAT" */
export function kampalaStamp(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kampala', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${g('day')} ${g('month')} ${g('year')}, ${g('hour')}:${g('minute')} EAT`;
}

/** "14 Oct, 09:41" in Kampala time */
export function kampalaDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kampala', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${g('day')} ${g('month')}, ${g('hour')}:${g('minute')}`;
}
