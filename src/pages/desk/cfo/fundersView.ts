import { clockTime } from '../deskPrefs';
import type { FundersRow } from './cfoApi';

export type Rank = 'grade' | 'oldest';

/** Ascending by the server's rank; a row with no rank goes last, in the order it came. */
export function sortRows(rows: FundersRow[], rank: Rank): FundersRow[] {
  const key = rank === 'grade' ? 'rank_grade' : 'rank_oldest';
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
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

/** Welile may fund a row only when the server allows it and no funder holds it. */
export function canFundRow(row: Pick<FundersRow, 'held'>, canFundWelile: boolean): boolean {
  return canFundWelile && !row.held;
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
