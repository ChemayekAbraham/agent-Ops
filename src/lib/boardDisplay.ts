export const BOARD_POLL_MS = 30_000;
export const BOARD_RETRY_MS = 60_000;
export const BOARD_STALE_MS = 120_000;
export const BOARD_IDLE_MS = 3_000;
export const BOARD_PULSE_MS = 800;
export const BOARD_PERIODS = ['today', '7d', '30d', '90d', 'all'] as const;
export type BoardPeriod = typeof BOARD_PERIODS[number];
export type BoardMetric = 'posted' | 'sold' | 'waiting';
export interface BoardTotal { n: number; ugx: number }
export interface BoardStage {
  ord: number; stage: string; desk: string; waiting: number | null; waiting_ugx: number | null;
  done_24h: number; done_7d: number; per_day_7d: number; days_to_clear: number | null; rejected_7d: number;
}
export interface BoardFeed {
  generated_at: string; display: { label: string };
  headline: Record<BoardPeriod, Record<BoardMetric, BoardTotal>>; stages: BoardStage[];
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
const nullableNumeric = (value: unknown) => value == null ? null : numeric(value);
/** Whitelist the aggregate contract; unrecognized fields never enter the display. */
export function readBoardFeed(value: unknown): BoardFeed {
  const raw = value as Record<string, any>;
  if (!raw || !Number.isFinite(Date.parse(raw.generated_at)) || !Array.isArray(raw.stages)) throw new Error('Display totals are unavailable.');
  const headline = {} as BoardFeed['headline'];
  for (const period of BOARD_PERIODS) {
    headline[period] = {} as Record<BoardMetric, BoardTotal>;
    for (const metric of ['posted', 'sold', 'waiting'] as const) {
      const total = raw.headline?.[period]?.[metric];
      headline[period][metric] = { n: numeric(total?.n), ugx: numeric(total?.ugx) };
    }
  }
  return { generated_at: raw.generated_at, display: { label: String(raw.display?.label ?? '') }, headline,
    stages: raw.stages.map((s: any) => ({ ord: numeric(s.ord), stage: String(s.stage), desk: String(s.desk ?? ''),
      waiting: nullableNumeric(s.waiting), waiting_ugx: nullableNumeric(s.waiting_ugx), done_24h: numeric(s.done_24h),
      done_7d: numeric(s.done_7d), per_day_7d: numeric(s.per_day_7d), days_to_clear: nullableNumeric(s.days_to_clear), rejected_7d: numeric(s.rejected_7d),
    })).sort((a: BoardStage, b: BoardStage) => a.ord - b.ord) };
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

/** Submitted has no queue of its own: its card shows only what came in over 24 hours. */
export function boardStageDoneOnly(stage: Pick<BoardStage, 'ord' | 'stage' | 'waiting'>): boolean {
  return stage.ord === 0 || /^submitted$/i.test(stage.stage.trim()) || stage.waiting == null;
}

/** "14:05:09" — the LIVE line's time, Kampala. */
export function boardUpdatedText(generatedAt: string): string {
  return `LIVE · updated ${kampalaClock(generatedAt)} Kampala`;
}
