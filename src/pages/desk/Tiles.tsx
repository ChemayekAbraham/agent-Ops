import type { Getter, Tile } from './deskConfig';

/** The balance tiles. Shared by the desk pages and the command centre. */
export function TileGrid({ tiles, g, board }: { tiles: Tile[]; g: Getter; board: boolean }) {
  if (tiles.length === 0) return null;
  return (
    <div className={`grid gap-3 ${board ? 'grid-cols-2 xl:grid-cols-4' : 'grid-cols-2 md:grid-cols-3 xl:grid-cols-4'}`}>
      {tiles.map((t) => (
        <div key={t.label} className="rounded-lg border border-border bg-card p-4 space-y-1.5 min-w-0">
          <div className={`${board ? 'text-sm' : 'text-xs'} text-muted-foreground leading-snug`}>{t.label}</div>
          <div className={`${board ? 'text-[32px] leading-none' : 'text-2xl leading-none'} font-semibold tabular-nums text-foreground`}>
            {g(t)}
          </div>
          {t.sub && (
            <div className={`${board ? 'text-xs' : 'text-[11px]'} text-muted-foreground truncate`}>
              {t.sub.label}: <span className="tabular-nums text-foreground">{g(t.sub)}</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
