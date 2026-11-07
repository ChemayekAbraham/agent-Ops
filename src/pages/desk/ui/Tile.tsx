import type { ReactNode } from 'react';
import { FIGURE, LABEL, TILE, statusText, type Status } from '../deskTheme';
import { stackLayout } from './layout';

/**
 * A figure tile: label, one big figure, an optional line under it. `tone`
 * colours the figure only, and only when it is a status (amber when
 * something is untouched, say).
 */
export function Tile({
  label,
  value,
  sub,
  tone,
  board,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Status;
  board: boolean;
}) {
  return (
    <div className={TILE} style={{ ...stackLayout(8), padding: 16 }}>
      <div className={LABEL}>{label}</div>
      <div
        className={`${FIGURE} ${board ? 'text-[36px]' : 'text-[28px]'} leading-none ${tone && tone !== 'idle' ? statusText[tone] : ''}`}
        style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
      >
        {value}
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
 * Tiles in a responsive grid, up to `max` across on a wide screen. `phone` is
 * how many sit side by side at 375 px: 1 for long money figures, 2 for counts.
 */
export function TileRow({ children, max = 4, phone = 2 }: { children: ReactNode; max?: 3 | 4 | 5; phone?: 1 | 2 }) {
  const cols = max === 5 ? 'sm:grid-cols-3 xl:grid-cols-5' : max === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2 xl:grid-cols-4';
  return (
    <div className={`grid ${phone === 1 ? 'grid-cols-1' : 'grid-cols-2'} ${cols}`} style={{ display: 'grid', gap: 12 }}>
      {children}
    </div>
  );
}
