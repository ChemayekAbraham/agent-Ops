import { supabase } from '@/integrations/supabase/client';

/**
 * E58 funders board (COO request, 9 Nov 2026). Read/write wrappers for the
 * live funders_board_* / coo_demoted_board RPCs. The server decides every
 * number and permission; this file only calls and shapes.
 */

type RpcFn = (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
const rpc = supabase.rpc.bind(supabase) as unknown as RpcFn;

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(rec) : []);

export const ugx = (v: unknown) => `UGX ${Math.round(num(v)).toLocaleString('en-US')}`;

export type BoardKind = 'house_listing' | 'rent_request';

export interface FundersBoardHeadline {
  on: boolean;
  houses_waiting: number;
  amount_needed_ugx: number;
  avg_monthly_rent: number;
}

/** null when the call fails — callers keep their old source. */
export async function fetchFundersBoardHeadline(): Promise<FundersBoardHeadline | null> {
  try {
    const { data, error } = await rpc('funders_board_headline', {});
    if (error) return null;
    const r = rec(data);
    return {
      on: r.on === true,
      houses_waiting: num(r.houses_waiting),
      amount_needed_ugx: num(r.amount_needed_ugx),
      avg_monthly_rent: num(r.avg_monthly_rent),
    };
  } catch {
    return null;
  }
}

export async function fetchCanDemote(): Promise<boolean> {
  const { data, error } = await rpc('funders_board_can_demote', {});
  return !error && data === true;
}

export const DEMOTE_REASONS = [
  { code: 'FB_NOT_QUALIFIED', label: "Doesn't qualify" },
  { code: 'FB_PHOTOS_POOR', label: 'Photos not good enough' },
  { code: 'FB_DETAILS_WRONG', label: 'Details look wrong' },
  { code: 'FB_NOT_AVAILABLE', label: 'No longer available' },
  { code: 'FB_DUPLICATE', label: 'Listed twice' },
  { code: 'OTHER', label: 'Other' },
] as const;
export type DemoteReason = (typeof DEMOTE_REASONS)[number]['code'];

/** OTHER needs a 10+ character note. */
export function demoteNoteValid(code: DemoteReason, note: string): boolean {
  return code !== 'OTHER' || note.trim().length >= 10;
}

export interface DemoteResult {
  demoted_count: number;
  skipped: { kind: string; id: string; reason: string; message: string }[];
}

export async function demoteItems(items: { kind: BoardKind; id: string }[], reason: DemoteReason, note: string): Promise<DemoteResult> {
  const { data, error } = await rpc('funders_board_demote', {
    p_items: items.slice(0, 100),
    p_reason_code: reason,
    p_reason_text: note.trim() || null,
  });
  if (error) throw new Error(error.message || 'Could not demote.');
  const r = rec(data);
  return {
    demoted_count: num(r.demoted_count ?? arr(r.demoted).length),
    skipped: arr(r.skipped).map((s) => ({ kind: String(s.kind ?? ''), id: String(s.id ?? ''), reason: String(s.reason ?? ''), message: String(s.message ?? s.reason ?? '') })),
  };
}

export interface DemotedRow {
  id: string;
  kind: BoardKind;
  item_id: string;
  tag_label: string | null;
  title: string | null;
  place: string | null;
  amount: number | null;
  photo: string | null;
  reason_label: string | null;
  reason_text: string | null;
  demoted_by_name: string | null;
  demoted_staff_ref: string | null;
  demoted_position: string | null;
  days_waiting: number | null;
  level_label: string | null;
  level_by_name: string | null;
  level_staff_ref: string | null;
  level_at: string | null;
  current: string | null;
  moved_by_system: boolean;
}
export interface DemoteLevel { code: string; label: string; hint: string | null }
export interface CooDemotedBoard {
  can_decide: boolean;
  awaiting: DemotedRow[];
  decided: DemotedRow[];
  levels: Record<BoardKind, DemoteLevel[]>;
  counts: { awaiting: number; awaiting_ugx: number; decided_in_period: number };
}

const toRow = (r: Record<string, unknown>): DemotedRow => ({
  id: String(r.id ?? ''),
  kind: r.kind === 'house_listing' ? 'house_listing' : 'rent_request',
  item_id: String(r.item_id ?? ''),
  tag_label: (r.tag_label as string) ?? null,
  title: (r.title as string) ?? null,
  place: (r.place as string) ?? null,
  amount: r.amount == null ? null : num(r.amount),
  photo: (r.photo as string) ?? null,
  reason_label: (r.reason_label as string) ?? null,
  reason_text: (r.reason_text as string) ?? null,
  demoted_by_name: (r.demoted_by_name as string) ?? null,
  demoted_staff_ref: (r.demoted_staff_ref as string) ?? null,
  demoted_position: (r.demoted_position as string) ?? null,
  days_waiting: r.days_waiting == null ? null : num(r.days_waiting),
  level_label: (r.level_label as string) ?? null,
  level_by_name: (r.level_by_name as string) ?? null,
  level_staff_ref: (r.level_staff_ref as string) ?? null,
  level_at: (r.level_at as string) ?? null,
  current: (r.current as string) ?? null,
  moved_by_system: r.moved_by_system === true,
});

const toLevels = (v: unknown): DemoteLevel[] =>
  arr(v).map((l) => ({ code: String(l.code ?? ''), label: String(l.label ?? l.code ?? ''), hint: (l.hint as string) ?? null }));

export async function fetchCooDemotedBoard(days = 30): Promise<CooDemotedBoard> {
  const { data, error } = await rpc('coo_demoted_board', { p_days: days });
  if (error) throw new Error(error.message);
  const r = rec(data);
  const lv = rec(r.levels);
  const c = rec(r.counts);
  return {
    can_decide: r.can_decide === true,
    awaiting: arr(r.awaiting).map(toRow),
    decided: arr(r.decided).map(toRow),
    levels: { rent_request: toLevels(lv.rent_request), house_listing: toLevels(lv.house_listing) },
    counts: { awaiting: num(c.awaiting), awaiting_ugx: num(c.awaiting_ugx), decided_in_period: num(c.decided_in_period) },
  };
}

export async function decideLevel(demotionId: string, level: string, note: string) {
  const { data, error } = await rpc('funders_board_decide_level', { p_demotion_id: demotionId, p_level: level, p_note: note.trim() || null });
  if (error) throw new Error(error.message);
  return rec(data);
}

export interface FundersBoardCounter {
  houses_waiting: number; amount_needed_ugx: number; avg_monthly_rent: number;
  baseline_houses: number; baseline_amount_ugx: number;
  added_by_push: number; added_by_push_ugx: number;
  restored: number; restored_ugx: number;
  removed: number; removed_ugx: number;
  verified_on_board: number; verified_on_board_ugx: number;
  awaiting_level: number; awaiting_level_ugx: number;
}

export async function fetchFundersBoardCounter(): Promise<FundersBoardCounter> {
  const { data, error } = await rpc('funders_board_counter', {});
  if (error) throw new Error(error.message);
  const r = rec(data);
  const keys: (keyof FundersBoardCounter)[] = [
    'houses_waiting', 'amount_needed_ugx', 'avg_monthly_rent', 'baseline_houses', 'baseline_amount_ugx', 'added_by_push', 'added_by_push_ugx',
    'restored', 'restored_ugx', 'removed', 'removed_ugx', 'verified_on_board', 'verified_on_board_ugx', 'awaiting_level', 'awaiting_level_ugx',
  ];
  return Object.fromEntries(keys.map((k) => [k, num(r[k])])) as unknown as FundersBoardCounter;
}

export type CounterListKind = 'pushed' | 'restored' | 'removed';
export interface CounterListRow { event_id: string; tag_label: string | null; title: string | null; place: string | null; amount: number | null; by_name: string | null; staff_ref: string | null; at: string | null }

export async function fetchCounterList(kind: CounterListKind, limit = 200): Promise<CounterListRow[]> {
  const { data, error } = await rpc('funders_board_counter_list', { p_kind: kind, p_limit: limit });
  if (error) throw new Error(error.message);
  return arr(data).map((r) => ({
    event_id: String(r.event_id ?? ''),
    tag_label: (r.tag_label as string) ?? null,
    title: (r.title as string) ?? null,
    place: (r.place as string) ?? null,
    amount: r.amount == null ? null : num(r.amount),
    by_name: (r.by_name as string) ?? null,
    staff_ref: (r.staff_ref as string) ?? null,
    at: (r.at as string) ?? null,
  }));
}

export const kampalaTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Kampala' }) : '—';

/* ═══════════════ E58 screens (funder cards, COO panel, CFO card) ═══════════════
 * Parsers that keep "unknown" apart from 0 (a loading or missing figure is a
 * dash, never a false zero), the reason chips in the ontology's words, and the
 * calls the screens make. Reuses fetchCanDemote, decideLevel and
 * CounterListKind from above.
 */

type RpcResult = { data: unknown; error: { message: string; code?: string } | null };
async function rpcData(fn: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const { data, error } = await (supabase.rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<RpcResult>)(fn, args);
  if (error) throw Object.assign(new Error(error.message || `${fn} failed`), { code: error.code });
  return data;
}
const fbNum = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const fbStr = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const fbObj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const fbArr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);

/** "UGX 1,250,000" — whole shillings with thousands separators; "—" when unknown. */
export function ugxFull(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : `UGX ${Math.round(Number(v)).toLocaleString('en-US')}`;
}
/** "1,234"; "—" when unknown. */
export function countFull(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : Math.round(Number(v)).toLocaleString('en-US');
}

export const FB_KEYS = {
  headline: ['funders-board', 'headline'] as const,
  canDemote: ['funders-board', 'can-demote'] as const,
  cooDemoted: (days: number) => ['desk-feed', 'funders-board', 'coo-demoted', days] as const,
  counter: ['desk-feed', 'funders-board', 'counter'] as const,
  counterList: (kind: CounterListKind) => ['desk-feed', 'funders-board', 'counter-list', kind] as const,
};

/* ───────────── headline (funders) ───────────── */

export type FbHeadline = { on: boolean; houses_waiting: number; amount_needed_ugx: number; avg_monthly_rent: number; last_change_at: string | null };

export function parseHeadline(v: unknown): FbHeadline {
  const d = fbObj(v);
  return {
    on: d.on === true,
    houses_waiting: fbNum(d.houses_waiting) ?? 0,
    amount_needed_ugx: fbNum(d.amount_needed_ugx) ?? 0,
    avg_monthly_rent: fbNum(d.avg_monthly_rent) ?? 0,
    last_change_at: fbStr(d.last_change_at),
  };
}
export const fetchHeadline = async () => parseHeadline(await rpcData('funders_board_headline'));

/* ───────────── demote (COO / CEO on the funder dashboard) ───────────── */

export type FbItemKind = 'house_listing' | 'rent_request';
export type FbItem = { kind: FbItemKind; id: string };

/** The reason chips, in order; FB_NOT_QUALIFIED is the default. Labels are the ontology's meanings. */
export const FB_REASONS: { code: string; label: string; needsText?: boolean }[] = [
  { code: 'FB_NOT_QUALIFIED', label: 'Does not qualify to be on the funders board' },
  { code: 'FB_PHOTOS_POOR', label: 'Photos not good enough to show funders' },
  { code: 'FB_DETAILS_WRONG', label: 'Rent, location or landlord details look wrong' },
  { code: 'FB_NOT_AVAILABLE', label: 'House no longer available or already occupied' },
  { code: 'FB_DUPLICATE', label: 'Same house listed more than once' },
  { code: 'OTHER', label: 'Other (explain)', needsText: true },
];
export const FB_DEFAULT_REASON = 'FB_NOT_QUALIFIED';
export const FB_OTHER_MIN = 10;

/** OTHER needs at least 10 characters of explanation; every other code is enough on its own. */
export function demoteReasonOk(code: string, text: string): boolean {
  return code !== 'OTHER' || text.trim().length >= FB_OTHER_MIN;
}

export type DemoteOutcome = {
  demoted: number;
  skipped: { kind: string | null; id: string | null; message: string }[];
  headline: FbHeadline | null;
};
export function parseDemoteResult(v: unknown): DemoteOutcome {
  const d = fbObj(v);
  const demotedArr = fbArr(d.demoted);
  return {
    demoted: fbNum(d.demoted_count) ?? demotedArr.length,
    skipped: fbArr(d.skipped).map((s) => ({ kind: fbStr(s.kind), id: fbStr(s.id), message: fbStr(s.message) ?? fbStr(s.reason) ?? 'Skipped' })),
    headline: d.headline ? parseHeadline(d.headline) : null,
  };
}
/** "3 demoted · 1 skipped". */
export const demoteSummary = (r: DemoteOutcome) => `${countFull(r.demoted)} demoted · ${countFull(r.skipped.length)} skipped`;

export async function demote(items: FbItem[], code: string, text: string): Promise<DemoteOutcome> {
  return parseDemoteResult(
    await rpcData('funders_board_demote', { p_items: items, p_reason_code: code, p_reason_text: text.trim() ? text.trim() : null }),
  );
}

/* ───────────── the COO desk panel ───────────── */

export type FbLevel = { code: string; label: string; hint: string | null };
export type FbDemotion = {
  id: string;
  kind: FbItemKind;
  item_id: string;
  short_id: string;
  tag: 'verified' | 'empty_house';
  tag_label: string;
  title: string;
  place: string | null;
  amount: number | null;
  status_before: string | null;
  reason_code: string | null;
  reason_label: string | null;
  reason_text: string | null;
  demoted_by_name: string | null;
  demoted_staff_ref: string | null;
  demoted_position: string | null;
  demoted_at: string | null;
  days_waiting: number | null;
  state: string;
  level: string | null;
  level_label: string | null;
  level_by_name: string | null;
  level_staff_ref: string | null;
  level_note: string | null;
  level_at: string | null;
  current: string | null;
  moved_by_system: boolean;
  photo: string | null;
};
export type CooDemoted = {
  can_decide: boolean;
  awaiting: FbDemotion[];
  decided: FbDemotion[];
  levels: Record<FbItemKind, FbLevel[]>;
  counts: { awaiting: number; awaiting_ugx: number; decided_in_period: number };
};

function parseDemotion(r: Record<string, unknown>): FbDemotion {
  const kind: FbItemKind = r.kind === 'house_listing' ? 'house_listing' : 'rent_request';
  const itemId = String(r.item_id ?? '');
  return {
    id: String(r.id ?? ''),
    kind,
    item_id: itemId,
    short_id: fbStr(r.short_id) ?? itemId.slice(0, 8),
    tag: r.tag === 'verified' ? 'verified' : 'empty_house',
    tag_label: fbStr(r.tag_label) ?? (r.tag === 'verified' ? 'Verified' : 'Empty house'),
    title: fbStr(r.title) ?? (kind === 'rent_request' ? 'Tenant' : 'House'),
    place: fbStr(r.place),
    amount: fbNum(r.amount),
    status_before: fbStr(r.status_before),
    reason_code: fbStr(r.reason_code),
    reason_label: fbStr(r.reason_label),
    reason_text: fbStr(r.reason_text),
    demoted_by_name: fbStr(r.demoted_by_name),
    demoted_staff_ref: fbStr(r.demoted_staff_ref),
    demoted_position: fbStr(r.demoted_position),
    demoted_at: fbStr(r.demoted_at),
    days_waiting: fbNum(r.days_waiting),
    state: fbStr(r.state) ?? 'awaiting_level',
    level: fbStr(r.level),
    level_label: fbStr(r.level_label),
    level_by_name: fbStr(r.level_by_name),
    level_staff_ref: fbStr(r.level_staff_ref),
    level_note: fbStr(r.level_note),
    level_at: fbStr(r.level_at),
    current: fbStr(r.current),
    moved_by_system: r.moved_by_system === true,
    photo: fbStr(r.photo),
  };
}
const parseLevels = (v: unknown): FbLevel[] => fbArr(v).map((l) => ({ code: String(l.code ?? ''), label: fbStr(l.label) ?? String(l.code ?? ''), hint: fbStr(l.hint) })).filter((l) => l.code);

export function parseCooDemoted(v: unknown): CooDemoted {
  const d = fbObj(v);
  const lv = fbObj(d.levels);
  const c = fbObj(d.counts);
  return {
    can_decide: d.can_decide === true,
    awaiting: fbArr(d.awaiting).map(parseDemotion),
    decided: fbArr(d.decided).map(parseDemotion),
    levels: { rent_request: parseLevels(lv.rent_request), house_listing: parseLevels(lv.house_listing) },
    counts: { awaiting: fbNum(c.awaiting) ?? 0, awaiting_ugx: fbNum(c.awaiting_ugx) ?? 0, decided_in_period: fbNum(c.decided_in_period) ?? 0 },
  };
}
export const fetchCooDemoted = async (days = 30) => parseCooDemoted(await rpcData('coo_demoted_board', { p_days: days }));

/** The rent requests that wait for a level: the graded queue shows them but never pushes them. */
export const awaitingRentRequestIds = (b: CooDemoted | undefined): Set<string> =>
  new Set((b?.awaiting ?? []).filter((d) => d.kind === 'rent_request').map((d) => d.item_id));


/** "Agnes Namata · EMP-014 · COO". */
export function demotedByText(d: Pick<FbDemotion, 'demoted_by_name' | 'demoted_staff_ref' | 'demoted_position'>): string {
  return [d.demoted_by_name ?? 'Unknown', d.demoted_staff_ref, d.demoted_position ? d.demoted_position.toUpperCase() : null].filter(Boolean).join(' · ');
}
/** The reason in plain words: the explanation when there is one, else the code's meaning. */
export const demotionReason = (d: Pick<FbDemotion, 'reason_text' | 'reason_label' | 'reason_code'>) =>
  d.reason_text ?? d.reason_label ?? d.reason_code ?? 'No reason given';

/* ───────────── the CFO card ───────────── */

export type FbCounter = {
  houses_waiting: number;
  amount_needed_ugx: number;
  avg_monthly_rent: number;
  baseline_houses: number;
  baseline_amount_ugx: number;
  frozen_at: string | null;
  added_by_push: number;
  added_by_push_ugx: number;
  restored: number;
  restored_ugx: number;
  removed: number;
  removed_ugx: number;
  awaiting_level: number;
  awaiting_level_ugx: number;
  verified_on_board: number;
  verified_on_board_ugx: number;
  last_change_at: string | null;
  switch_on: boolean;
};
export function parseCounter(v: unknown): FbCounter {
  const d = fbObj(v);
  const n = (k: string) => fbNum(d[k]) ?? 0;
  return {
    houses_waiting: n('houses_waiting'),
    amount_needed_ugx: n('amount_needed_ugx'),
    avg_monthly_rent: n('avg_monthly_rent'),
    baseline_houses: n('baseline_houses'),
    baseline_amount_ugx: n('baseline_amount_ugx'),
    frozen_at: fbStr(d.frozen_at),
    added_by_push: n('added_by_push'),
    added_by_push_ugx: n('added_by_push_ugx'),
    restored: n('restored'),
    restored_ugx: n('restored_ugx'),
    removed: n('removed'),
    removed_ugx: n('removed_ugx'),
    awaiting_level: n('awaiting_level'),
    awaiting_level_ugx: n('awaiting_level_ugx'),
    verified_on_board: n('verified_on_board'),
    verified_on_board_ugx: n('verified_on_board_ugx'),
    last_change_at: fbStr(d.last_change_at),
    switch_on: d.switch_on === true,
  };
}
export const fetchCounter = async () => parseCounter(await rpcData('funders_board_counter'));

export type CounterListItem = {
  event_id: string;
  kind: FbItemKind;
  item_id: string;
  short_id: string;
  tag_label: string;
  title: string;
  place: string | null;
  amount: number | null;
  by_name: string | null;
  staff_ref: string | null;
  note: string | null;
  at: string | null;
};
export function parseCounterList(v: unknown): CounterListItem[] {
  return fbArr(v).map((r) => {
    const itemId = String(r.item_id ?? '');
    return {
      event_id: String(r.event_id ?? itemId),
      kind: r.kind === 'house_listing' ? 'house_listing' : 'rent_request',
      item_id: itemId,
      short_id: fbStr(r.short_id) ?? itemId.slice(0, 8),
      tag_label: fbStr(r.tag_label) ?? 'Empty house',
      title: fbStr(r.title) ?? 'House',
      place: fbStr(r.place),
      amount: fbNum(r.amount),
      by_name: fbStr(r.by_name),
      staff_ref: fbStr(r.staff_ref),
      note: fbStr(r.note),
      at: fbStr(r.at),
    };
  });
}
export const fetchCounterListItems = async (kind: CounterListKind) => parseCounterList(await rpcData('funders_board_counter_list', { p_kind: kind }));

/** "9 Nov 2026" in Kampala; "—" with no date. */
export function kampalaDay(iso: string | null | undefined): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Kampala' });
}

/* ───────────── E72b funders board groups (funders_board_items, FB-STAY / FB-ORDER) ───────────── */

export {
  BOARD_GROUPS,
  BOARD_TAG_COLOR,
  BOARD_TAG_LABEL,
  BOARD_TAG_ORDER,
  type BoardRequestTag,
  type BoardTag,
} from './fundersBoardTags';
import type { BoardRequestTag } from './fundersBoardTags';

const REQUEST_TAGS = new Set<BoardRequestTag>(['verified', 'booked', 'funded', 'pending_verification']);

/** One rent request on the funders board. Only Verified (and not held) can be funded; the rest are view only. */
export interface BoardItem {
  id: string;
  tag: BoardRequestTag;
  selectable: boolean;
  held: boolean;
  tenantFirstName: string | null;
  houseCategory: string | null;
  city: string | null;
  mainPhoto: string | null;
  rentAmount: number;
  durationDays: number | null;
  lat: number | null;
  lng: number | null;
  /** When it went on the board (or was booked/funded): the server's order inside a group. */
  sortAt: string | null;
}

export interface BoardItemsCounts {
  verified: number;
  verified_ugx: number;
  booked: number;
  funded: number;
  pending_verification: number;
  pending_verification_ugx: number;
  ready_total: number;
  ready_total_ugx: number;
}

export interface BoardItems {
  items: BoardItem[];
  counts: BoardItemsCounts;
}

const optNum = (v: unknown) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const optStr = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);

export function parseBoardItems(data: unknown): BoardItems {
  const r = rec(data);
  const c = rec(r.counts);
  const items: BoardItem[] = [];
  for (const x of arr(r.items)) {
    const tag = String(x.tag ?? '') as BoardRequestTag;
    if (x.kind !== 'rent_request' || !x.id || !REQUEST_TAGS.has(tag)) continue;
    items.push({
      id: String(x.id),
      tag,
      selectable: x.selectable === true,
      held: x.held === true,
      tenantFirstName: optStr(x.tenant_first_name),
      houseCategory: optStr(x.house_category),
      city: optStr(x.city),
      mainPhoto: optStr(x.main_photo),
      rentAmount: num(x.rent_amount),
      durationDays: optNum(x.duration_days),
      lat: optNum(x.lat),
      lng: optNum(x.lng),
      sortAt: optStr(x.sort_at),
    });
  }
  const counts: BoardItemsCounts = {
    verified: num(c.verified),
    verified_ugx: num(c.verified_ugx),
    booked: num(c.booked),
    funded: num(c.funded),
    pending_verification: num(c.pending_verification),
    pending_verification_ugx: num(c.pending_verification_ugx),
    ready_total: num(c.ready_total),
    ready_total_ugx: num(c.ready_total_ugx),
  };
  return { items, counts };
}

/** Every rent request on the funders board, all four tags, sorted by group (no p_tag). */
export async function fetchBoardItems(): Promise<BoardItems> {
  const { data, error } = await rpc('funders_board_items', { p_limit: 1000 });
  if (error) throw new Error(error.message || 'The funders board could not be loaded.');
  return parseBoardItems(data);
}
