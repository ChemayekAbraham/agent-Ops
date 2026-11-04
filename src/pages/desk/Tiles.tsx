import { pick, type Tile } from './deskConfig';
import { fmt } from './format';
import type { FeedState } from './useDeskFeed';
import { CountUp } from './CountUp';
import { FIGURE, LABEL, TILE, statusText } from './deskTheme';

/** What a KPI is holding up, and who has to move for it. Most tiles hold up nothing. */
export type Blocked = { ugx: number; who: string };

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

/**
 * The balance tiles. Shared by the desk pages and the command centre's balance strip.
 *
 * When one of them is holding money up, that tile is pulled to the front and
 * outlined: a figure that is merely interesting should never sit above the one
 * that is stopping a payment. Only the largest blocker is promoted — two
 * outlines would make neither of them mean anything.
 */
export function TileGrid({
  tiles,
  feeds,
  board,
  columns,
  blocked,
}: {
  tiles: Tile[];
  feeds: Record<string, FeedState>;
  board: boolean;
  columns?: string;
  /** Keyed by tile label. Absent or zero means this tile blocks nothing. */
  blocked?: Record<string, Blocked>;
}) {
  if (tiles.length === 0) return null;
  const grid = columns ?? (board ? 'grid-cols-3 xl:grid-cols-6' : 'grid-cols-2 md:grid-cols-3 xl:grid-cols-6');

  // The worst blocker leads. Everything else keeps the order it was given.
  const lead = Object.entries(blocked ?? {})
    .filter(([label, b]) => b && b.ugx > 0 && tiles.some((t) => t.label === label))
    .sort((a, b) => b[1].ugx - a[1].ugx)[0]?.[0];
  const ordered = lead
    ? [...tiles].sort((a, b) => (a.label === lead ? -1 : b.label === lead ? 1 : 0))
    : tiles;

  return (
    <div className={`grid gap-3 ${grid}`}>
      {ordered.map((t) => {
        const b = t.label === lead ? blocked?.[t.label] : undefined;
        return (
          <div
            key={t.label}
            className={`${TILE} p-4 space-y-2 min-w-0 ${b ? 'border-2 border-[hsl(var(--desk-bad))]' : ''}`}
          >
            <div className={LABEL}>{t.label}</div>
            <Figure feeds={feeds} tile={t} size={board ? 'text-[44px] leading-none' : 'text-[36px] leading-none'} />
            {b && (
              <div className={`text-xs font-medium leading-snug ${statusText.bad}`}>
                Blocks UGX {fmt('ugx', b.ugx)} — {b.who}
              </div>
            )}
            {t.sub && (
              <div className={`${LABEL} truncate`}>
                {t.sub.label}:{' '}
                <span className="tabular-nums text-[hsl(var(--desk-lavender))]">
                  {fmt(t.sub.fmt, pick(feeds[t.sub.feed]?.rows ?? [], t.sub))}
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
