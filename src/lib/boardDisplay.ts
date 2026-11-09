export const BOARD_POLL_MS = 30_000;
export const BOARD_RETRY_MS = 60_000;
export const BOARD_STALE_MS = 120_000;
export const BOARD_IDLE_MS = 3_000;
export const BOARD_PULSE_MS = 800;
export const BOARD_PERIODS = ['today', '7d', '30d', '90d', 'all'] as const;
export type BoardPeriod = typeof BOARD_PERIODS[number];
export type BoardMetric = 'posted' | 'sold' | 'waiting';
export interface BoardTotal { n: number; ugx: number }
export interface BoardFeed {
  generated_at: string; display: { label: string };
  headline: Record<BoardPeriod, Record<BoardMetric, BoardTotal>>;
}
export const BOARD_PERIOD_LABELS: Record<BoardPeriod, string> = { today: 'Today', '7d': '7 days', '30d': '30 days', '90d': '90 days', all: 'All time' };
/** The list panel closes itself after a minute with no touch, so the room is back on the tiles. */
export const BOARD_PANEL_IDLE_MS = 60_000;
/** The board's period choice, remembered per screen. */
export const BOARD_PERIOD_KEY = 'welile.board.period';
export function readBoardPeriod(storage: Pick<Storage, 'getItem'> | null | undefined): BoardPeriod {
  try {
    const v = storage?.getItem(BOARD_PERIOD_KEY);
    return (BOARD_PERIODS as readonly string[]).includes(v ?? '') ? (v as BoardPeriod) : 'today';
  } catch { return 'today'; }
}
export function storeBoardPeriod(storage: Pick<Storage, 'setItem'> | null | undefined, period: BoardPeriod) {
  try { storage?.setItem(BOARD_PERIOD_KEY, period); } catch { /* private mode or blocked storage: the choice just isn't remembered */ }
}
/** The boardroom screen answers on /b/:code and /board/:code (and /board?t=code). */
export function isBoardDisplayPath(path: string) { return /^\/(?:b|board)(?:\/[^/]+)?\/?$/.test(path); }
export function boardDisplayToken(path: string, search: string): string {
  const segment = path.match(/^\/(?:b|board)\/([^/]+)\/?$/)?.[1];
  try { return segment ? decodeURIComponent(segment) : new URLSearchParams(search).get('t') ?? ''; }
  catch { return ''; }
}
export function boardIsStale(lastGood: number | null, now: number) {
  return lastGood == null || now - lastGood > BOARD_STALE_MS;
}
export function boardMoney(value: number) {
  return `UGX ${new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value)}`;
}
export function kampalaClock(value: number | string) {
  return new Date(value).toLocaleTimeString('en-GB', { timeZone: 'Africa/Kampala', hour12: false });
}
const numeric = (value: unknown): number => {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) throw new Error('Display totals are unavailable.');
  return Number(value);
};
/** Whitelist the aggregate contract; unrecognized fields (stages included) never enter the display. */
export function readBoardFeed(value: unknown): BoardFeed {
  const raw = value as Record<string, any>;
  if (!raw || !Number.isFinite(Date.parse(raw.generated_at))) throw new Error('Display totals are unavailable.');
  const headline = {} as BoardFeed['headline'];
  for (const period of BOARD_PERIODS) {
    headline[period] = {} as Record<BoardMetric, BoardTotal>;
    for (const metric of ['posted', 'sold', 'waiting'] as const) {
      const total = raw.headline?.[period]?.[metric];
      headline[period][metric] = { n: numeric(total?.n), ugx: numeric(total?.ugx) };
    }
  }
  return { generated_at: raw.generated_at, display: { label: String(raw.display?.label ?? '') }, headline };
}
/**
 * The server refuses a link that is not valid, switched off or used off the
 * office network with SQLSTATE 28000. Those take the whole screen: old totals
 * must not stay up on a link that has been switched off. Anything else (the
 * network, a slow server) keeps the last totals on screen and turns the LIVE
 * line amber.
 */
export function isBoardLinkError(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '28000';
}


/** "14:05:09" — the LIVE line's time, Kampala. */
export function boardUpdatedText(generatedAt: string): string {
  return `LIVE · updated ${kampalaClock(generatedAt)} Kampala`;
}

/* ───────────── the list behind a tile (board_display_list) ───────────── */
export interface BoardListRow {
  ref: string; area: string | null; rent: number | null; posted_at: string | null;
  days_since_posted: number | null; status_label: string | null; money_released_at: string | null;
}
export interface BoardList { period: BoardPeriod; kind: BoardMetric; count: number; ugx: number; shown: number; rows: BoardListRow[] }
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
const maybeNumber = (v: unknown) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
/**
 * Whitelist the list contract: ref, area, rent, dates and status only. A name,
 * phone or id the server might add never reaches the screen.
 */
export function readBoardList(value: unknown, period: BoardPeriod, kind: BoardMetric): BoardList {
  const raw = (value ?? {}) as Record<string, any>;
  const rows: BoardListRow[] = (Array.isArray(raw.rows) ? raw.rows : []).map((r: Record<string, unknown>) => ({
    ref: String(r?.ref ?? '').slice(0, 8), area: text(r?.area), rent: maybeNumber(r?.rent), posted_at: text(r?.posted_at),
    days_since_posted: maybeNumber(r?.days_since_posted), status_label: text(r?.status_label), money_released_at: text(r?.money_released_at),
  }));
  return { period, kind, count: maybeNumber(raw.count) ?? rows.length, ugx: maybeNumber(raw.ugx) ?? 0, shown: maybeNumber(raw.shown) ?? rows.length, rows };
}
/** "9 Nov 2026" in Kampala; "—" with no date. */
export function kampalaDate(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return '—';
  return new Date(value).toLocaleDateString('en-GB', { timeZone: 'Africa/Kampala', day: 'numeric', month: 'short', year: 'numeric' });
}
/** "1 day", "3.5 days"; "—" when unknown. */
export function boardDays(value: number | null) {
  if (value == null) return '—';
  const n = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }).format(value);
  return `${n} ${n === '1' ? 'day' : 'days'}`;
}
