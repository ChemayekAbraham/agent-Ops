// Types and small pure helpers for the Agent Ops "Metrics" tab.
//
// Every figure shown comes from the five agent_ops_metrics_* functions and is displayed exactly as returned: nothing here adds, subtracts,
// averages or ranks a number. What is here: the Kampala days sent to the server, turning rows into typed values (a missing figure reads
// as 0), the URL parameters (mfrom / mto / mscope / msort), the saved card order, the CSV rows and one plain line for an error.
import { kampalaOffsetYmd, kampalaTodayYmd } from '@/lib/kampalaDays';
import { networkStamp } from '@/lib/agentNetwork';

// ---------- typed rows ----------

export interface MetricsTotals {
  as_at: string;
  range_start: string;
  range_end: string;
  basis: string;
  agents_role: number;
  linked_subagents: number;
  qualifying_agents: number;
  listers_ever: number;
  listers_in_range: number;
  houses_listed: number;
  houses_verified: number;
  houses_pending: number;
  houses_rejected: number;
  houses_with_gps: number;
  listing_earned: number;
  listing_clawed_back: number;
  advances_given_count: number;
  advances_given_amount: number;
  advances_repaid: number;
  advances_outstanding: number;
  advances_overdue_count: number;
  advances_overdue_amount: number;
}

export interface MetricsAgent {
  agent_id: string;
  name: string;
  phone: string | null;
  main_agent_id: string | null;
  main_agent_name: string | null;
  houses_listed: number;
  houses_approved: number;
  houses_pending: number;
  houses_rejected: number;
  top_district: string | null;
  gps_share: number;
  listing_earned: number;
  clawed_back: number;
  net: number;
  advance_principal: number;
  advance_outstanding: number;
  advance_status: string | null;
  last_listing: string | null;
  total_matched: number;
}

export interface MetricsLocation {
  region: string | null;
  district: string | null;
  sub_county: string | null;
  houses_listed: number;
  houses_verified: number;
  houses_pending: number;
  houses_with_gps: number;
  agents: number;
}

export interface MetricsPin {
  listing_id: string;
  latitude: number;
  longitude: number;
  verified: boolean;
  status: string | null;
  region: string | null;
  district: string | null;
  agent_id: string;
  created_at: string;
}

export interface MetricsMainAgent {
  main_agent_id: string;
  name: string;
  phone: string | null;
  team_size: number;
  team_houses: number;
  team_earnings: number;
  team_advances_outstanding: number;
  total_matched: number;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string => (v == null ? '' : String(v));
const strOrNull = (v: unknown): string | null => (v == null || v === '' ? null : String(v));
const rows = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);
/** A table function can answer with one row in an array or as a single object. */
const first = (v: unknown): Obj => (Array.isArray(v) ? obj(v[0]) : obj(v));

export function normalizeTotals(raw: unknown): MetricsTotals {
  const r = first(raw);
  return {
    as_at: str(r.as_at), range_start: str(r.range_start), range_end: str(r.range_end), basis: str(r.basis),
    agents_role: num(r.agents_role), linked_subagents: num(r.linked_subagents), qualifying_agents: num(r.qualifying_agents),
    listers_ever: num(r.listers_ever), listers_in_range: num(r.listers_in_range),
    houses_listed: num(r.houses_listed), houses_verified: num(r.houses_verified), houses_pending: num(r.houses_pending),
    houses_rejected: num(r.houses_rejected), houses_with_gps: num(r.houses_with_gps),
    listing_earned: num(r.listing_earned), listing_clawed_back: num(r.listing_clawed_back),
    advances_given_count: num(r.advances_given_count), advances_given_amount: num(r.advances_given_amount),
    advances_repaid: num(r.advances_repaid), advances_outstanding: num(r.advances_outstanding),
    advances_overdue_count: num(r.advances_overdue_count), advances_overdue_amount: num(r.advances_overdue_amount),
  };
}

export const normalizeAgents = (raw: unknown): MetricsAgent[] => rows(raw).map((r) => ({
  agent_id: str(r.agent_id), name: str(r.name) || 'Unnamed agent', phone: strOrNull(r.phone),
  main_agent_id: strOrNull(r.main_agent_id), main_agent_name: strOrNull(r.main_agent_name),
  houses_listed: num(r.houses_listed), houses_approved: num(r.houses_approved), houses_pending: num(r.houses_pending), houses_rejected: num(r.houses_rejected),
  top_district: strOrNull(r.top_district), gps_share: num(r.gps_share),
  listing_earned: num(r.listing_earned), clawed_back: num(r.clawed_back), net: num(r.net),
  advance_principal: num(r.advance_principal), advance_outstanding: num(r.advance_outstanding), advance_status: strOrNull(r.advance_status),
  last_listing: strOrNull(r.last_listing), total_matched: num(r.total_matched),
}));

export const normalizeLocations = (raw: unknown): MetricsLocation[] => rows(raw).map((r) => ({
  region: strOrNull(r.region), district: strOrNull(r.district), sub_county: strOrNull(r.sub_county),
  houses_listed: num(r.houses_listed), houses_verified: num(r.houses_verified), houses_pending: num(r.houses_pending),
  houses_with_gps: num(r.houses_with_gps), agents: num(r.agents),
}));

export const normalizePins = (raw: unknown): MetricsPin[] => rows(raw)
  .map((r) => ({
    listing_id: str(r.listing_id), latitude: num(r.latitude), longitude: num(r.longitude), verified: r.verified === true,
    status: strOrNull(r.status), region: strOrNull(r.region), district: strOrNull(r.district), agent_id: str(r.agent_id), created_at: str(r.created_at),
  }))
  .filter((p) => p.listing_id !== '' && (p.latitude !== 0 || p.longitude !== 0));

export const normalizeMainAgents = (raw: unknown): MetricsMainAgent[] => rows(raw).map((r) => ({
  main_agent_id: str(r.main_agent_id), name: str(r.name) || 'Unnamed agent', phone: strOrNull(r.phone),
  team_size: num(r.team_size), team_houses: num(r.team_houses), team_earnings: num(r.team_earnings),
  team_advances_outstanding: num(r.team_advances_outstanding), total_matched: num(r.total_matched),
}));


// ---------- listing quality and risk (agent_ops_metrics_listing_quality / agent_ops_metrics_risk, both return jsonb) ----------

const numOrNull = (v: unknown): number | null => (v == null || v === '' ? null : num(v));

export interface QualityNetwork {
  as_at: string;
  range_start: string;
  range_end: string;
  basis: string;
  agents: number;
  houses_listed: number;
  houses_verified: number;
  houses_pending: number;
  houses_currently_rejected: number;
  rejection_events: number;
  occupied: number;
  empty: number;
  approval_rate: number | null;
  avg_days_to_verify: number | null;
  listing_earned: number;
  listing_earned_listers: number;
  earn_per_approved: number | null;
  waiting_total: number;
  oldest_waiting_days: number | null;
}

export interface QualityAgent {
  agent_id: string;
  name: string;
  phone: string | null;
  houses_listed: number;
  houses_verified: number;
  houses_pending: number;
  houses_currently_rejected: number;
  approval_rate: number | null;
  avg_days_to_verify: number | null;
  occupied: number;
  empty: number;
  listing_earned: number;
  earn_per_approved: number | null;
}

export interface WaitingRow {
  listing_id: string;
  agent_id: string;
  agent_name: string;
  phone: string | null;
  district: string | null;
  listed_at: string;
  days_waiting: number;
}

export interface ListingQuality { network: QualityNetwork; agents: QualityAgent[]; waiting: WaitingRow[] }

export function normalizeQuality(raw: unknown): ListingQuality {
  const r = obj(Array.isArray(raw) ? raw[0] : raw);
  const n = obj(r.network);
  return {
    network: {
      as_at: str(n.as_at), range_start: str(n.range_start), range_end: str(n.range_end), basis: str(n.basis), agents: num(n.agents),
      houses_listed: num(n.houses_listed), houses_verified: num(n.houses_verified), houses_pending: num(n.houses_pending),
      houses_currently_rejected: num(n.houses_currently_rejected), rejection_events: num(n.rejection_events),
      occupied: num(n.occupied), empty: num(n.empty), approval_rate: numOrNull(n.approval_rate), avg_days_to_verify: numOrNull(n.avg_days_to_verify),
      listing_earned: num(n.listing_earned), listing_earned_listers: num(n.listing_earned_listers), earn_per_approved: numOrNull(n.earn_per_approved),
      waiting_total: num(n.waiting_total), oldest_waiting_days: numOrNull(n.oldest_waiting_days),
    },
    agents: rows(r.agents).map((a) => ({
      agent_id: str(a.agent_id), name: str(a.name) || 'Unnamed agent', phone: strOrNull(a.phone),
      houses_listed: num(a.houses_listed), houses_verified: num(a.houses_verified), houses_pending: num(a.houses_pending),
      houses_currently_rejected: num(a.houses_currently_rejected), approval_rate: numOrNull(a.approval_rate), avg_days_to_verify: numOrNull(a.avg_days_to_verify),
      occupied: num(a.occupied), empty: num(a.empty), listing_earned: num(a.listing_earned), earn_per_approved: numOrNull(a.earn_per_approved),
    })),
    waiting: rows(r.waiting).map((w) => ({
      listing_id: str(w.listing_id), agent_id: str(w.agent_id), agent_name: str(w.agent_name) || 'Unnamed agent', phone: strOrNull(w.phone),
      district: strOrNull(w.district), listed_at: str(w.listed_at), days_waiting: num(w.days_waiting),
    })),
  };
}

export type RiskFlag = 'no_earnings' | 'high' | 'watch' | 'ok';
const FLAGS: readonly RiskFlag[] = ['no_earnings', 'high', 'watch', 'ok'];
export const RISK_FLAG_LABEL: Record<RiskFlag, string> = {
  no_earnings: 'No listing earnings',
  high: 'High (3x or more)',
  watch: 'Watch (1x to 3x)',
  ok: 'Low (under 1x)',
};

export interface RiskSummary {
  as_at: string;
  range_start: string;
  range_end: string;
  inactive_window_start: string;
  basis: string;
  advance_no_listing_count: number;
  advance_no_listing_amount: number;
  owing_agents: number;
  owing_amount: number;
  flag_no_earnings: number;
  flag_high: number;
  flag_watch: number;
  flag_ok: number;
  inactive_listers_count: number;
  never_listed_subagents_count: number;
  main_agents_owing_count: number;
  main_agents_owing_amount: number;
}
export interface RiskPerson { agent_id: string; name: string; phone: string | null }
export interface AdvanceNoListing extends RiskPerson { advance_outstanding: number; last_listing: string | null }
export interface AdvanceVsEarnings extends RiskPerson { advance_outstanding: number; listing_earned: number; ratio: number | null; flag: RiskFlag }
export interface InactiveLister extends RiskPerson { last_listing: string | null; days_inactive: number; houses_listed_ever: number }
export interface NeverListedSubagent extends RiskPerson { main_agent_id: string | null; main_agent_name: string | null; linked_on: string | null }
export interface TeamOwes { main_agent_id: string; name: string; phone: string | null; team_size: number; team_houses: number; team_earnings: number; team_advances_outstanding: number }
export interface MetricsRisk {
  summary: RiskSummary;
  advance_no_listing: AdvanceNoListing[];
  advance_vs_earnings: AdvanceVsEarnings[];
  inactive_listers: InactiveLister[];
  never_listed_subagents: NeverListedSubagent[];
  main_agents_by_advance: TeamOwes[];
}

const person = (r: Obj): RiskPerson => ({ agent_id: str(r.agent_id), name: str(r.name) || 'Unnamed agent', phone: strOrNull(r.phone) });

export function normalizeRisk(raw: unknown): MetricsRisk {
  const r = obj(Array.isArray(raw) ? raw[0] : raw);
  const s = obj(r.summary);
  return {
    summary: {
      as_at: str(s.as_at), range_start: str(s.range_start), range_end: str(s.range_end), inactive_window_start: str(s.inactive_window_start), basis: str(s.basis),
      advance_no_listing_count: num(s.advance_no_listing_count), advance_no_listing_amount: num(s.advance_no_listing_amount),
      owing_agents: num(s.owing_agents), owing_amount: num(s.owing_amount),
      flag_no_earnings: num(s.flag_no_earnings), flag_high: num(s.flag_high), flag_watch: num(s.flag_watch), flag_ok: num(s.flag_ok),
      inactive_listers_count: num(s.inactive_listers_count), never_listed_subagents_count: num(s.never_listed_subagents_count),
      main_agents_owing_count: num(s.main_agents_owing_count), main_agents_owing_amount: num(s.main_agents_owing_amount),
    },
    advance_no_listing: rows(r.advance_no_listing).map((x) => ({ ...person(x), advance_outstanding: num(x.advance_outstanding), last_listing: strOrNull(x.last_listing) })),
    advance_vs_earnings: rows(r.advance_vs_earnings).map((x) => ({
      ...person(x), advance_outstanding: num(x.advance_outstanding), listing_earned: num(x.listing_earned), ratio: numOrNull(x.ratio),
      flag: (FLAGS as readonly string[]).includes(str(x.flag)) ? (str(x.flag) as RiskFlag) : 'ok',
    })),
    inactive_listers: rows(r.inactive_listers).map((x) => ({ ...person(x), last_listing: strOrNull(x.last_listing), days_inactive: num(x.days_inactive), houses_listed_ever: num(x.houses_listed_ever) })),
    never_listed_subagents: rows(r.never_listed_subagents).map((x) => ({ ...person(x), main_agent_id: strOrNull(x.main_agent_id), main_agent_name: strOrNull(x.main_agent_name), linked_on: strOrNull(x.linked_on) })),
    main_agents_by_advance: rows(r.main_agents_by_advance).map((x) => ({
      main_agent_id: str(x.main_agent_id), name: str(x.name) || 'Unnamed agent', phone: strOrNull(x.phone), team_size: num(x.team_size), team_houses: num(x.team_houses),
      team_earnings: num(x.team_earnings), team_advances_outstanding: num(x.team_advances_outstanding),
    })),
  };
}

// ---------- dates ----------

export type MetricsPreset = 'today' | 'last7' | 'last30' | 'month' | 'custom';
export const METRICS_PRESETS: ReadonlyArray<{ id: Exclude<MetricsPreset, 'custom'>; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'last7', label: 'Last 7 days' },
  { id: 'last30', label: 'Last 30 days' },
  { id: 'month', label: 'This month' },
];

/** Kampala days for a preset; the end is always Kampala today. */
export function metricsPresetRange(id: Exclude<MetricsPreset, 'custom'>, today: string = kampalaTodayYmd()): { from: string; to: string } {
  if (id === 'today') return { from: today, to: today };
  if (id === 'last7') return { from: kampalaOffsetYmd(-6), to: today };
  if (id === 'month') return { from: `${today.slice(0, 8)}01`, to: today };
  return { from: kampalaOffsetYmd(-29), to: today };
}

export function metricsPresetOf(from: string, to: string, today: string = kampalaTodayYmd()): MetricsPreset {
  for (const p of METRICS_PRESETS) {
    const r = metricsPresetRange(p.id, today);
    if (r.from === from && r.to === to) return p.id;
  }
  return 'custom';
}

// ---------- URL: ?metrics=1&mfrom=&mto=&mscope=&msort= ----------

export type MetricsScope = 'qualifying' | 'linked' | 'all';
export const METRICS_SCOPES: ReadonlyArray<{ id: MetricsScope; label: string }> = [
  { id: 'qualifying', label: 'Qualifying agents' },
  { id: 'linked', label: 'Linked sub-agents and main agents' },
  { id: 'all', label: 'Everyone with activity' },
];

export const METRICS_SORTS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'houses_listed', label: 'Houses listed' },
  { id: 'houses_approved', label: 'Houses verified' },
  { id: 'listing_earned', label: 'Listing earnings' },
  { id: 'net', label: 'Net listing earnings' },
  { id: 'advance_outstanding', label: 'Advance outstanding' },
  { id: 'last_listing', label: 'Last listing' },
  { id: 'name', label: 'Name' },
];
export const DEFAULT_METRICS_SORT = 'houses_listed';
export const METRICS_PAGE_SIZE = 50;

export interface MetricsParams { from: string; to: string; scope: MetricsScope; sort: string }
const M_KEYS = ['metrics', 'mfrom', 'mto', 'mscope', 'msort'] as const;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (v: string | null): v is string => !!v && ISO.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

/** A sort key is "<column>" or "<column>:asc|desc"; anything else is dropped (the server refuses what is not on its list). */
export function validSort(v: string | null | undefined): string {
  const [col, dir] = String(v ?? '').toLowerCase().split(':');
  if (!METRICS_SORTS.some((s) => s.id === col)) return DEFAULT_METRICS_SORT;
  return dir === 'asc' || dir === 'desc' ? `${col}:${dir}` : col;
}

export function hasMetricsParams(sp: URLSearchParams): boolean {
  return M_KEYS.some((k) => sp.has(k));
}

/** The range, scope and sort from the URL. A bad or future day falls back to the last 30 days; the end is never after today. */
export function readMetricsParams(sp: URLSearchParams, today: string = kampalaTodayYmd()): MetricsParams {
  const def = metricsPresetRange('last30', today);
  let from = sp.get('mfrom');
  let to = sp.get('mto');
  if (!validDay(from) || !validDay(to) || from > to) { from = def.from; to = def.to; }
  if (to > today) to = today;
  if (from > to) from = to;
  const s = sp.get('mscope');
  const scope: MetricsScope = s === 'linked' || s === 'all' ? s : 'qualifying';
  return { from, to, scope, sort: validSort(sp.get('msort')) };
}

/** The URL for these params; other parameters (tab, section, net*, f7*) are kept untouched. */
export function writeMetricsParams(base: URLSearchParams, p: MetricsParams): URLSearchParams {
  const next = new URLSearchParams(base);
  M_KEYS.forEach((k) => next.delete(k));
  next.set('metrics', '1');
  next.set('mfrom', p.from);
  next.set('mto', p.to);
  if (p.scope !== 'qualifying') next.set('mscope', p.scope);
  if (p.sort !== DEFAULT_METRICS_SORT) next.set('msort', p.sort);
  return next;
}

export function clearMetricsParams(base: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(base);
  M_KEYS.forEach((k) => next.delete(k));
  return next;
}

// ---------- card order (per user, in the browser only) ----------

export const CARD_IDS = ['headline', 'listings', 'earnings', 'agents', 'locations', 'main-agents', 'advances', 'risk', 'activity'] as const;
export type CardId = (typeof CARD_IDS)[number];
export const CARD_TITLES: Record<CardId, string> = {
  headline: 'Headline',
  listings: 'Listings',
  earnings: 'Listing earnings',
  agents: 'Agents',
  locations: 'Locations',
  'main-agents': 'Main agents',
  advances: 'Advances',
  risk: 'Risk',
  activity: 'Activity',
};

export const orderKey = (userId: string | null | undefined) => `agentOpsMetricsOrder:${userId || 'anonymous'}`;

/** A saved order made whole: unknown ids and repeats are dropped, cards that were added since are appended in their default place. */
export function mergeOrder(saved: unknown): CardId[] {
  const out: CardId[] = [];
  if (Array.isArray(saved)) {
    for (const id of saved) if ((CARD_IDS as readonly string[]).includes(id as string) && !out.includes(id as CardId)) out.push(id as CardId);
  }
  for (const id of CARD_IDS) if (!out.includes(id)) out.push(id);
  return out;
}

export function readOrder(userId: string | null | undefined, storage: Pick<Storage, 'getItem'> | null = safeStorage()): CardId[] {
  try {
    const raw = storage?.getItem(orderKey(userId));
    return mergeOrder(raw ? JSON.parse(raw) : null);
  } catch {
    return mergeOrder(null);
  }
}

export function writeOrder(userId: string | null | undefined, order: CardId[], storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try { storage?.setItem(orderKey(userId), JSON.stringify(order)); } catch { /* private mode or full: the order just isn't kept */ }
}

export function clearOrder(userId: string | null | undefined, storage: Pick<Storage, 'removeItem'> | null = safeStorage()): void {
  try { storage?.removeItem(orderKey(userId)); } catch { /* ignore */ }
}

function safeStorage(): Storage | null {
  try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
}

/** The order after moving the card at `index` by `delta` places (clamped); the same array when nothing moves. */
export function moveCard(order: CardId[], index: number, delta: -1 | 1): CardId[] {
  const to = index + delta;
  if (index < 0 || index >= order.length || to < 0 || to >= order.length) return order;
  const next = [...order];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

/** The order after dropping the card `id` where the card `onto` is. */
export function dropCard(order: CardId[], id: CardId, onto: CardId): CardId[] {
  const from = order.indexOf(id);
  const to = order.indexOf(onto);
  if (from < 0 || to < 0 || from === to) return order;
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

// ---------- map box ----------

/** Most pins asked for at once: the server's own ceiling (agent_ops_metrics_pins clamps p_limit to 2000). */
export const MAP_PIN_LIMIT = 2000;

/** Uganda, used before the map has been moved. */
export const UGANDA_BOX = { minLat: -1.5, minLng: 29.5, maxLat: 4.3, maxLng: 35.1 } as const;

// ---------- messages, stamps, CSV ----------

/** "15 Oct 2026, 14:32 EAT" */
export const metricsStamp = (when: number | Date = new Date()) => networkStamp(typeof when === 'number' ? new Date(when) : when);

/** One plain line for an error from the functions. Never empty. */
export function metricsErrorMessage(raw: unknown): string {
  const text = String((raw as { message?: string } | null)?.message ?? raw ?? '').trim();
  if (text.includes('not authorized') || (raw as { code?: string } | null)?.code === '42501') return 'You do not have access to the Agent Ops metrics.';
  if (text.includes('RANGE_INVALID')) return 'The end date is before the start date. Pick the dates again.';
  if (text.includes('RANGE_REQUIRED')) return 'Pick a start and an end date.';
  if (/JWT|auth/i.test(text) && /expired|invalid/i.test(text)) return 'Your session expired. Sign in again and retry.';
  return text ? `Could not load these figures: ${text}` : 'Could not load these figures. Try again.';
}

export const metricsRangeLine = (from: string, to: string) => (from === to ? from : `${from} to ${to}`);

export function metricsPreamble(title: string, from: string, to: string, basis: string, now: Date = new Date()): (string | number)[][] {
  return [
    ['Agent Ops metrics', title],
    ['Dates (Kampala days)', metricsRangeLine(from, to)],
    ['Basis', basis],
    ['Generated', metricsStamp(now)],
  ];
}

export const metricsCsvName = (slug: string, from: string, to: string) => `agent-ops-metrics-${slug}-${from}-to-${to}.csv`;

export const AGENT_CSV_HEADERS = [
  'Agent', 'Phone', 'Main agent', 'Houses listed', 'Houses verified', 'Houses pending', 'Houses rejected', 'Top district', 'GPS share (%)',
  'Listing earnings (UGX)', 'Clawed back (UGX)', 'Net (UGX)', 'Advance principal (UGX)', 'Advance outstanding (UGX)', 'Advance status', 'Last listing',
];
export const agentCsvRow = (a: MetricsAgent): (string | number)[] => [
  a.name, a.phone ?? '', a.main_agent_name ?? '', a.houses_listed, a.houses_approved, a.houses_pending, a.houses_rejected, a.top_district ?? '', a.gps_share,
  a.listing_earned, a.clawed_back, a.net, a.advance_principal, a.advance_outstanding, a.advance_status ?? '', a.last_listing ?? '',
];

export const LOCATION_CSV_HEADERS = ['Region', 'District', 'Sub-county', 'Houses listed', 'Houses verified', 'Houses pending', 'Houses with GPS', 'Agents'];
export const locationCsvRow = (l: MetricsLocation): (string | number)[] => [
  l.region ?? '', l.district ?? '', l.sub_county ?? '', l.houses_listed, l.houses_verified, l.houses_pending, l.houses_with_gps, l.agents,
];

export const MAIN_CSV_HEADERS = ['Main agent', 'Phone', 'Team size', 'Team houses', 'Team listing earnings (UGX)', 'Team advances outstanding (UGX)'];
export const mainAgentCsvRow = (m: MetricsMainAgent): (string | number)[] => [
  m.name, m.phone ?? '', m.team_size, m.team_houses, m.team_earnings, m.team_advances_outstanding,
];

/** Label for a location row at the level asked for. */
export function locationLabel(l: MetricsLocation, level: 'region' | 'district' | 'sub_county'): string {
  if (level === 'region') return l.region || 'No region recorded';
  if (level === 'district') return l.district || 'No district recorded';
  return [l.sub_county, l.district].filter(Boolean).join(', ') || 'No sub-county recorded';
}

export const WAITING_CSV_HEADERS = ['Agent', 'Phone', 'District', 'Listed on', 'Days waiting'];
export const waitingCsvRow = (w: WaitingRow): (string | number)[] => [w.agent_name, w.phone ?? '', w.district ?? '', w.listed_at, w.days_waiting];

export const RISK_CSV_HEADERS = ['List', 'Agent', 'Phone', 'Advance outstanding (UGX)', 'Listing earnings (UGX)', 'Ratio', 'Flag', 'Last listing', 'Days inactive', 'Main agent'];
export function riskCsvRows(d: MetricsRisk): (string | number)[][] {
  return [
    ...d.advance_no_listing.map((x) => ['Advance with no listing', x.name, x.phone ?? '', x.advance_outstanding, '', '', '', x.last_listing ?? '', '', ''] as (string | number)[]),
    ...d.advance_vs_earnings.map((x) => ['Advance against listing earnings', x.name, x.phone ?? '', x.advance_outstanding, x.listing_earned, x.ratio ?? '', RISK_FLAG_LABEL[x.flag], '', '', ''] as (string | number)[]),
  ];
}

export const ACTIVITY_CSV_HEADERS = ['List', 'Agent', 'Phone', 'Last listing', 'Days inactive', 'Houses listed ever', 'Main agent', 'Linked on'];
export function activityCsvRows(d: MetricsRisk): (string | number)[][] {
  return [
    ...d.inactive_listers.map((x) => ['Inactive lister', x.name, x.phone ?? '', x.last_listing ?? '', x.days_inactive, x.houses_listed_ever, '', ''] as (string | number)[]),
    ...d.never_listed_subagents.map((x) => ['Never listed', x.name, x.phone ?? '', '', '', '', x.main_agent_name ?? '', x.linked_on ?? ''] as (string | number)[]),
  ];
}

export const TOP_EARNER_CSV_HEADERS = ['Agent', 'Phone', 'Listing earnings (UGX)', 'Clawed back (UGX)', 'Net (UGX)', 'Houses listed', 'Houses verified'];
export const topEarnerCsvRow = (a: MetricsAgent): (string | number)[] => [a.name, a.phone ?? '', a.listing_earned, a.clawed_back, a.net, a.houses_listed, a.houses_approved];

export const TEAM_OWES_CSV_HEADERS = ['Main agent', 'Phone', 'Team size', 'Team houses', 'Team listing earnings (UGX)', 'Team advances outstanding (UGX)'];
export const teamOwesCsvRow = (m: TeamOwes): (string | number)[] => [m.name, m.phone ?? '', m.team_size, m.team_houses, m.team_earnings, m.team_advances_outstanding];
