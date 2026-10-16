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

export const CARD_IDS = ['headline', 'listings', 'earnings', 'agents', 'locations', 'main-agents', 'advances', 'activity'] as const;
export type CardId = (typeof CARD_IDS)[number];
export const CARD_TITLES: Record<CardId, string> = {
  headline: 'Headline',
  listings: 'Listings',
  earnings: 'Listing earnings',
  agents: 'Agents',
  locations: 'Locations',
  'main-agents': 'Main agents',
  advances: 'Advances',
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
