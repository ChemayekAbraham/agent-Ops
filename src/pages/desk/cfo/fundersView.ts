import { clockTime } from '../deskPrefs';
import type { FundersDashboard, FundersRow } from './cfoApi';

/**
 * Unsold this long and Partner Ops follows it up (rule PO-7D). It used to mean
 * "Welile funds it" (PO-2, retired with E60: Welile funds only through its own
 * funder account, by selecting on the funders' dashboard).
 */
export const UNSOLD_FOLLOW_UP_DAYS = 7;
export const UNSOLD_7D_LABEL = 'Unsold 7+ days · Partner Ops follow-up';

export function isUnsold7d(row: Pick<FundersRow, 'days_on_board'>): boolean {
  return Number(row.days_on_board ?? 0) >= UNSOLD_FOLLOW_UP_DAYS;
}

/**
 * The Funded tile's line: who brought the money. Officers' funders and self
 * sign-ups when the server splits them; the older "Funders" total otherwise.
 */
export function fundedSplitText(f: FundersDashboard['funded']): string {
  const n = (v: number) => Math.round(v).toLocaleString('en');
  if (f.by_officers || f.by_self) {
    return `${n(f.n)} requests · Officers' funders ${n(f.by_officers?.n ?? 0)} · Self ${n(f.by_self?.n ?? 0)} · Welile ${n(f.by_welile.n)}`;
  }
  return `${n(f.n)} requests · Funders ${n(f.by_funders.n)} · Welile ${n(f.by_welile.n)}`;
}

export type Rank = 'grade' | 'oldest';

/**
 * Rows unsold 7+ days (Partner Ops follow-up) first; within each group ascending by the
 * server's rank, and a row with no rank goes last, in the order it came.
 */
export function sortRows(rows: FundersRow[], rank: Rank): FundersRow[] {
  const key = rank === 'grade' ? 'rank_grade' : 'rank_oldest';
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const due = Number(isUnsold7d(b.r)) - Number(isUnsold7d(a.r));
      if (due !== 0) return due;
      const x = a.r[key];
      const y = b.r[key];
      const xn = x === null || x === undefined;
      const yn = y === null || y === undefined;
      if (xn && yn) return a.i - b.i;
      if (xn) return 1;
      if (yn) return -1;
      return Number(x) - Number(y) || a.i - b.i;
    })
    .map(({ r }) => r);
}

/** "Held until 14:05", Kampala time. Null when the row is not held. */
export function heldLabel(row: Pick<FundersRow, 'held' | 'hold_expires_at'>): string | null {
  if (!row.held) return null;
  const ms = row.hold_expires_at ? Date.parse(row.hold_expires_at) : NaN;
  return Number.isFinite(ms) ? `Held until ${clockTime(ms)}` : 'Held';
}

export const ugx = (v: number | null | undefined) =>
  v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : `UGX ${Math.round(Number(v)).toLocaleString('en')}`;

export const rating = (v: number | null | undefined) =>
  v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : String(Math.round(Number(v) * 10) / 10);

/**
 * The desk's lead, from funders_dashboard itself so it matches the tiles and
 * the list: "11 on the funders' board, worth UGX 31,450,000 · 3 held by funders".
 * Not the old pipeline feed, which still counted a request a funder had claimed.
 */
export function fundersLead(d: Pick<FundersDashboard, 'fund_today' | 'held_by_funders'>): string {
  const n = Math.round(Number(d.fund_today.n ?? 0)).toLocaleString('en');
  const held = Math.round(Number(d.held_by_funders.n ?? 0));
  return `${n} on the funders' board, worth ${ugx(d.fund_today.ugx)}${held > 0 ? ` · ${held.toLocaleString('en')} held by funders` : ''}`;
}
