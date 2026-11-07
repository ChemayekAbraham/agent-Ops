import type { ReactNode } from 'react';
import { FIGURE, LABEL, TILE, statusText, type Status } from '../deskTheme';
import { TrendArrow } from './TrendArrow';
import { stackLayout } from './layout';

/**
 * A figure tile, exactly as the command centre's balance strip draws one:
 * 18px corners, 16px padding, 8px between label, figure and the line under it,
 * and a 36px figure (44px on a board).
 *
 * A figure longer than 11 characters ("UGX 14,350,000") steps down one size
 * (28px, 36px on a board) so it stays whole in a four-across row; the command
 * centre writes money short ("UGX 14.4M") and never needs to. `tone` colours
 * the figure only when it is a status; `trend` adds the river's 24-hour arrow.
 */

export const TILE_FIGURE = { normal: 36, board: 44, longNormal: 28, longBoard: 36 } as const;
const LONG = 11;
/** Fallback sizes for a browser that cannot read the container-relative size. */
const SIZE_CLASS: Record<number, string> = { 28: 'text-[28px]', 36: 'text-[36px]', 44: 'text-[44px]' };

/**
 * The figure's CSS size: the command-centre size, shrunk only when the tile is
 * too narrow for the characters (two tiles across a phone). Uses the tile as a
 * container (`cqi`); a browser without container units keeps the class size.
 */
export function tileFigureCss(value: ReactNode, board: boolean): string {
  const px = tileFigureSize(value, board);
  const chars = typeof value === 'string' || typeof value === 'number' ? String(value).length : 0;
  if (chars === 0) return `${px}px`;
  // A tabular figure runs about 0.6em a character.
  return `min(${px}px, calc(100cqi / ${(chars * 0.6).toFixed(2)}))`;
}

export function tileFigureSize(value: ReactNode, board: boolean): number {
  const long = typeof value === 'string' && value.length > LONG;
  if (board) return long ? TILE_FIGURE.longBoard : TILE_FIGURE.board;
  return long ? TILE_FIGURE.longNormal : TILE_FIGURE.normal;
}

export function Tile({
  label,
  value,
  sub,
  tone,
  trend,
  trendUpIsGood,
  board,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Status;
  trend?: number | null;
  trendUpIsGood?: boolean;
  board: boolean;
}) {
  const size = tileFigureSize(value, board);
  return (
    <div className={TILE} style={{ ...stackLayout(8), padding: 'var(--desk-space-4, 16px)', containerType: 'inline-size' }}>
      <div className={LABEL}>{label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
        <div
          className={`${FIGURE} ${SIZE_CLASS[size] ?? ''} leading-none ${tone && tone !== 'idle' ? statusText[tone] : ''}`}
          style={{ fontSize: tileFigureCss(value, board), lineHeight: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}
          data-figure-size={size}
        >
          {value}
        </div>
        {trend !== undefined && <TrendArrow change={trend} board={board} upIsGood={trendUpIsGood} />}
      </div>
      {sub && (
        <div className={`${LABEL} truncate`} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {sub}
        </div>
      )}
    </div>
  );
}

/**
 * Tiles in the command centre's grid: 12px apart, up to `max` across on a wide
 * screen. `phone` is how many sit side by side at 375 px: 1 for long money
 * figures, 2 for counts.
 */
export function TileRow({ children, max = 4, phone = 2 }: { children: ReactNode; max?: 3 | 4 | 5 | 6; phone?: 1 | 2 }) {
  const cols =
    max === 6 ? 'sm:grid-cols-3 xl:grid-cols-6' : max === 5 ? 'sm:grid-cols-3 xl:grid-cols-5' : max === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2 xl:grid-cols-4';
  return (
    <div className={`grid ${phone === 1 ? 'grid-cols-1' : 'grid-cols-2'} ${cols}`} style={{ display: 'grid', gap: 'var(--desk-space-3, 12px)' }}>
      {children}
    </div>
  );
}
