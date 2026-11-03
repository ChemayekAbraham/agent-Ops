import { pick, type Tile } from './deskConfig';
import { fmt } from './format';
import type { FeedState } from './useDeskFeed';
import { CountUp } from './CountUp';
import { FIGURE, LABEL, TILE } from './deskTheme';

/** A tile value counts up only when it is really a number; "Not set" and "—" stay still. */
function Figure({ feeds, tile, size }: { feeds: Record<string, FeedState>; tile: Tile; size: string }) {
  const raw = pick(feeds[tile.feed]?.rows ?? [], tile);
  const n = Number(raw);
  const numeric = raw !== null && raw !== undefined && raw !== '' && Number.isFinite(n);
  const cls = `${FIGURE} ${size}`;
  return numeric ? (
    <CountUp value={n} format={(x) => fmt(tile.fmt, x)} className={cls} />
  ) : (
    <span className={cls}>{fmt(tile.fmt, raw)}</span>
  );
}

/** The balance tiles. Shared by the desk pages and the command centre's balance strip. */
export function TileGrid({
  tiles,
  feeds,
  board,
  columns,
}: {
  tiles: Tile[];
  feeds: Record<string, FeedState>;
  board: boolean;
  columns?: string;
}) {
  if (tiles.length === 0) return null;
  const grid = columns ?? (board ? 'grid-cols-3 xl:grid-cols-6' : 'grid-cols-2 md:grid-cols-3 xl:grid-cols-6');
  return (
    <div className={`grid gap-3 ${grid}`}>
      {tiles.map((t) => (
        <div key={t.label} className={`${TILE} p-4 space-y-2 min-w-0`}>
          <div className={LABEL}>{t.label}</div>
          <Figure feeds={feeds} tile={t} size={board ? 'text-[44px] leading-none' : 'text-[36px] leading-none'} />
          {t.sub && (
            <div className={`${LABEL} truncate`}>
              {t.sub.label}:{' '}
              <span className="tabular-nums text-[hsl(var(--desk-lavender))]">
                {fmt(t.sub.fmt, pick(feeds[t.sub.feed]?.rows ?? [], t.sub))}
              </span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
