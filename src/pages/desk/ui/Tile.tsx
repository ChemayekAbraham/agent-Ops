import type { ReactNode } from 'react';
import { FIGURE, LABEL, TILE, statusText, type Status } from '../deskTheme';
import { TrendArrow } from './TrendArrow';
import { abbreviateMoney } from './format';
import { stackLayout } from './layout';

/**
 * A figure tile in the command centre's style, sized for any screen.
 *
 *   figure   clamp(22px, 5vw, 36px) — 44px tops on a board — and never wider
 *            than its tile (the tile is a size container, `cqi`)
 *   money    "UGX 14,350,000" shows as "UGX 14.4M"; the full figure stays in
 *            the tooltip and the accessible name
 *   padding  12px on a phone, rising to 20px from lg
 *
 * `tone` colours the figure only when it is a status; `trend` adds the river's
 * 24-hour arrow.
 */

export const TILE_FIGURE = { normal: 36, board: 44, min: 22 } as const;

/** Kept for callers that read the nominal size: the largest the figure can be. */
export function tileFigureSize(_value: ReactNode, board: boolean): number {
  return board ? TILE_FIGURE.board : TILE_FIGURE.normal;
}

/** The figure's CSS size: fluid with the viewport, capped by the tile's own width for the characters it holds. */
export function tileFigureCss(value: ReactNode, board: boolean): string {
  const fluid = board ? `clamp(28px, 4vw, ${TILE_FIGURE.board}px)` : `clamp(${TILE_FIGURE.min}px, 5vw, ${TILE_FIGURE.normal}px)`;
  const chars = typeof value === 'string' || typeof value === 'number' ? String(value).length : 0;
  if (chars === 0) return fluid;
  // A tabular figure runs about 0.6em a character.
  return `min(${fluid}, calc(100cqi / ${(chars * 0.6).toFixed(2)}))`;
}

/** Padding that is 12px at phone widths and 20px from lg (1024), without a media query. */
export const TILE_PAD = 'clamp(12px, calc(2.4vw - 4.6px), 20px)';

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
  const money = typeof value === 'string' ? abbreviateMoney(value) : { short: value, full: null };
  const shown = money.short;
  return (
    <div className={TILE} style={{ ...stackLayout(8), padding: TILE_PAD, containerType: 'inline-size', minWidth: 0 }}>
      <div className={LABEL}>{label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
        <div
          className={`${FIGURE} ${board ? 'text-[44px]' : 'text-[36px]'} leading-none ${tone && tone !== 'idle' ? statusText[tone] : ''}`}
          style={{ fontSize: tileFigureCss(shown, board), lineHeight: 1.32, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}
          data-figure-size={tileFigureSize(shown, board)}
          title={money.full ?? undefined}
          aria-label={money.full ?? undefined}
        >
          {shown}
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
 * Tiles in a grid that fits itself: as many 150px-or-wider columns as fit,
 * never fewer than two on a phone. `max` and `phone` are accepted for existing
 * callers and no longer needed.
 */
export function TileRow({ children }: { children: ReactNode; max?: 3 | 4 | 5 | 6; phone?: 1 | 2 }) {
  return (
    <div
      className="desk-tile-row"
      style={{
        display: 'grid',
        gap: 'var(--desk-space-3, 12px)',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(150px, calc((100% - 12px) / 2)), 1fr))',
        minWidth: 0,
      }}
    >
      {children}
    </div>
  );
}
