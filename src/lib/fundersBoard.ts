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
