// Types and small pure helpers for the Agent Ops "Agent Network" tab.
//
// Everything shown comes from one server function, get_agent_ops_network_overview. The tab shows its figures exactly as returned: nothing here
// adds, averages, ranks or re-derives a number. What is here: the Kampala days sent to the server, turning the rpc's JSON into a typed value
// (a missing figure reads as 0 / an empty list so a zero payload renders), and one plain line for an error.
import { format } from 'date-fns';
import { kampalaOffsetYmd, kampalaTodayYmd } from '@/lib/kampalaDays';

export interface NetworkCounts {
  agents: number;
  with_service_centres: number;
  with_bikes: number;
  with_smartphone_plan: number;
  with_smartphone_tenants: number;
  with_subagents: number;
  posted_requests: number;
  approved_agents: number;
}

export interface NetworkApproved {
  agents: number;
  requests: number;
  amount: number;
  receivables_outstanding: number;
}

export interface NetworkBikes { agents: number; leases: number; amount_outstanding: number }

/** The headline totals of tops_smartphone_usage, as it returns them (platform-wide tenant figures, not per agent). */
export const SMARTPHONE_KEYS = [
  'tenants', 'recorded_smartphone', 'recorded_without', 'confirmed_smartphone', 'confirmed_feature_phone', 'device_unknown',
  'joined', 'joined_recorded_smartphone', 'checks', 'checks_smartphone', 'checks_feature_phone', 'seen_on_phone',
] as const;
export type SmartphoneKey = (typeof SMARTPHONE_KEYS)[number];
export interface SmartphoneUsage { from_day: string; to_day: string; as_of: string; totals: Record<SmartphoneKey, number> }

interface RankedBase {
  agent_id: string;
  name: string;
  phone: string | null;
}
export interface PortfolioRow extends RankedBase { portfolio: number; plans: number }
export interface CollectionRateRow extends RankedBase { collected: number; expected: number; rate_pct: number }
export interface DefaultRateRow extends RankedBase { outstanding: number; defaulted: number; default_rate_pct: number; plans: number }

export interface AgentNetworkOverview {
  range: { start: string; end: string; min_expected: number };
  counts: NetworkCounts;
  approved: NetworkApproved;
  bikes: NetworkBikes;
  smartphone_usage: SmartphoneUsage;
  top_portfolios: PortfolioRow[];
  top_collection_rate: CollectionRateRow[];
  default_rate_ascending: DefaultRateRow[];
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);
const base = (r: Obj): RankedBase => ({
  agent_id: String(r.agent_id ?? ''),
  name: String(r.name ?? 'Unnamed agent'),
  phone: r.phone == null || r.phone === '' ? null : String(r.phone),
});

/** The server's answer as a typed value. A figure that is missing reads as 0 and a missing list as empty. */
export function normalizeNetworkOverview(raw: unknown): AgentNetworkOverview {
  const r = obj(raw);
  const c = obj(r.counts);
  const a = obj(r.approved);
  const range = obj(r.range);
  const bikes = obj(r.bikes);
  const phone = obj(r.smartphone_usage);
  return {
    range: { start: String(range.start ?? ''), end: String(range.end ?? ''), min_expected: num(range.min_expected) },
    counts: {
      agents: num(c.agents),
      with_service_centres: num(c.with_service_centres),
      with_bikes: num(c.with_bikes),
      with_smartphone_plan: num(c.with_smartphone_plan),
      with_smartphone_tenants: num(c.with_smartphone_tenants),
      with_subagents: num(c.with_subagents),
      posted_requests: num(c.posted_requests),
      approved_agents: num(c.approved_agents),
    },
    approved: { agents: num(a.agents), requests: num(a.requests), amount: num(a.amount), receivables_outstanding: num(a.receivables_outstanding) },
    bikes: { agents: num(bikes.agents), leases: num(bikes.leases), amount_outstanding: num(bikes.amount_outstanding) },
    smartphone_usage: {
      from_day: String(phone.from_day ?? ''), to_day: String(phone.to_day ?? ''), as_of: String(phone.as_of ?? ''),
      totals: Object.fromEntries(SMARTPHONE_KEYS.map((k) => [k, num(phone[k])])) as Record<SmartphoneKey, number>,
    },
    top_portfolios: list(r.top_portfolios).map((x) => ({ ...base(x), portfolio: num(x.portfolio), plans: num(x.plans) })),
    top_collection_rate: list(r.top_collection_rate).map((x) => ({ ...base(x), collected: num(x.collected), expected: num(x.expected), rate_pct: num(x.rate_pct) })),
    default_rate_ascending: list(r.default_rate_ascending).map((x) => ({
      ...base(x), outstanding: num(x.outstanding), defaulted: num(x.defaulted), default_rate_pct: num(x.default_rate_pct), plans: num(x.plans),
    })),
  };
}

/**
 * The Kampala days to ask for. The page's range picker gives calendar days; the day the picker shows is the day sent. The end is never
 * later than Kampala today (the server refuses a future day) and the start is never after the end.
 */
export function networkRangeParams(start: Date, end: Date, today: string = kampalaTodayYmd()): { p_start: string; p_end: string } {
  const e = format(end, 'yyyy-MM-dd');
  const s = format(start, 'yyyy-MM-dd');
  const pEnd = e > today ? today : e;
  const pStart = s > pEnd ? pEnd : s;
  return { p_start: pStart, p_end: pEnd };
}

/** One plain line for an error from the function. Never empty. */
export function networkErrorMessage(raw: unknown): string {
  const text = String((raw as { message?: string } | null)?.message ?? raw ?? '').trim();
  if (text.includes('auth_required')) return 'Your session expired. Sign in again and retry.';
  if (text.includes('not_authorized') || (raw as { code?: string } | null)?.code === '42501') return 'You do not have access to the Agent Network figures.';
  if (text.includes('RANGE_FUTURE')) return 'Pick a range that ends today or earlier.';
  if (text.includes('RANGE_INVALID')) return 'The end date is before the start date.';
  if (text.includes('RANGE_REQUIRED')) return 'Pick a start and an end date.';
  return text.split('\n')[0].replace(/^[A-Z_]{4,}:\s*/, '').trim() || 'Something went wrong. Please try again.';
}

// ---------- the minimum, the range presets and the URL (?net=1&netfrom=&netto=&netmin=) ----------

export const MIN_OPTIONS = [0, 50000, 100000, 500000] as const;
export const DEFAULT_MIN = 50000;

export type NetPreset = 'today' | 'last7' | 'last30' | 'month' | 'custom';
export const NET_PRESETS: ReadonlyArray<{ id: Exclude<NetPreset, 'custom'>; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'last7', label: 'Last 7 days' },
  { id: 'last30', label: 'Last 30 days' },
  { id: 'month', label: 'This month' },
];

/** Kampala days for a preset; the end is always Kampala today. */
export function netPresetRange(id: Exclude<NetPreset, 'custom'>, today: string = kampalaTodayYmd()): { from: string; to: string } {
  if (id === 'today') return { from: today, to: today };
  if (id === 'last7') return { from: kampalaOffsetYmd(-6), to: today };
  if (id === 'month') return { from: `${today.slice(0, 8)}01`, to: today };
  return { from: kampalaOffsetYmd(-29), to: today };
}

export function netPresetOf(from: string, to: string, today: string = kampalaTodayYmd()): NetPreset {
  for (const p of NET_PRESETS) {
    const r = netPresetRange(p.id, today);
    if (r.from === from && r.to === to) return p.id;
  }
  return 'custom';
}

export interface NetworkParams { from: string; to: string; min: number }
const NET_KEYS = ['net', 'netfrom', 'netto', 'netmin'] as const;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (v: string | null): v is string => !!v && ISO.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

export function hasNetworkParams(sp: URLSearchParams): boolean {
  return NET_KEYS.some((k) => sp.has(k));
}

/** The range and minimum from the URL. A bad or future day falls back to the last 30 days; the end is never after today. */
export function readNetworkParams(sp: URLSearchParams, today: string = kampalaTodayYmd()): NetworkParams {
  const def = netPresetRange('last30', today);
  let from = sp.get('netfrom');
  let to = sp.get('netto');
  if (!validDay(from) || !validDay(to) || from > to) { from = def.from; to = def.to; }
  if (to > today) to = today;
  if (from > to) from = to;
  const m = Number(sp.get('netmin'));
  return { from, to, min: (MIN_OPTIONS as readonly number[]).includes(m) && sp.has('netmin') ? m : DEFAULT_MIN };
}

/** The URL for these params; other parameters (tab, section, f7*) are kept untouched. */
export function writeNetworkParams(base: URLSearchParams, p: NetworkParams): URLSearchParams {
  const next = new URLSearchParams(base);
  NET_KEYS.forEach((k) => next.delete(k));
  next.set('net', '1');
  next.set('netfrom', p.from);
  next.set('netto', p.to);
  if (p.min !== DEFAULT_MIN) next.set('netmin', String(p.min));
  return next;
}

export function clearNetworkParams(base: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(base);
  NET_KEYS.forEach((k) => next.delete(k));
  return next;
}

// ---------- CSV of a ranked table: values exactly as returned ----------

export type RankedKind = 'portfolios' | 'collection' | 'default';
export const RANKED_TITLE: Record<RankedKind, string> = {
  portfolios: 'Biggest portfolios',
  collection: 'Best collection rate',
  default: 'Default rate (lowest first)',
};

/** "15 Oct 2026, 14:32 EAT" */
export function networkStamp(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kampala', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
  const g = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
  return `${g('day')} ${g('month')} ${g('year')}, ${g('hour')}:${g('minute')} EAT`;
}

export function buildRankedCsv(kind: RankedKind, d: AgentNetworkOverview, now: Date = new Date()) {
  const preamble: string[][] = [
    [`Agent Network: ${RANKED_TITLE[kind]}`],
    ['Kampala days', d.range.start === d.range.end ? d.range.start : `${d.range.start} to ${d.range.end}`],
    ['Minimum (UGX)', String(d.range.min_expected)],
    ['Generated (Kampala time)', networkStamp(now)],
    ['Amounts', 'UGX'],
  ];
  if (kind === 'portfolios') {
    return { filename: `agent-network-portfolios-${d.range.start}_${d.range.end}.csv`, preamble, headers: ['Rank', 'Agent', 'Phone', 'Rent Plans', 'Portfolio (UGX)'],
      rows: d.top_portfolios.map((r, i) => [i + 1, r.name, r.phone ?? '', r.plans, r.portfolio]) };
  }
  if (kind === 'collection') {
    return { filename: `agent-network-collection-rate-${d.range.start}_${d.range.end}.csv`, preamble, headers: ['Rank', 'Agent', 'Phone', 'Collected (UGX)', 'Expected (UGX)', 'Rate (%)'],
      rows: d.top_collection_rate.map((r, i) => [i + 1, r.name, r.phone ?? '', r.collected, r.expected, r.rate_pct]) };
  }
  return { filename: `agent-network-default-rate-${d.range.start}_${d.range.end}.csv`, preamble, headers: ['Rank', 'Agent', 'Phone', 'Rent Plans', 'Outstanding (UGX)', 'Defaulted (UGX)', 'Default rate (%)'],
    rows: d.default_rate_ascending.map((r, i) => [i + 1, r.name, r.phone ?? '', r.plans, r.outstanding, r.defaulted, r.default_rate_pct]) };
}
