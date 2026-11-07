import { useQuery } from '@tanstack/react-query';
import { fmt } from './format';
import { LABEL, PANEL, type Status } from './deskTheme';
import { Chip, EmptyState, ErrorLine, LoadingRows, Tile, TileRow } from './ui';
import { readableError, rpc } from './reviewApi';

/**
 * Partner Ops' "Funder board watch" — what the funders are doing with the
 * requests the COO pushed to their board. Read-only: Partner Ops no longer
 * attaches funders or forwards to a COO bucket.
 */

export type WatchRow = {
  id: string;
  req: string;
  tenant: string | null;
  rent: number | null;
  days_on_board: number | null;
  state: string | null;
  untouched_48h: boolean | null;
};

export type WatchCounts = {
  on_board?: number;
  held?: number;
  committed?: number;
  untouched_48h?: number;
  funded_by_funders_7d?: number;
};

export const WATCH_TILES: { key: keyof WatchCounts; label: string }[] = [
  { key: 'on_board', label: 'On the board' },
  { key: 'held', label: 'Held by a funder' },
  { key: 'committed', label: 'Committed' },
  { key: 'untouched_48h', label: 'Untouched 48 h' },
  { key: 'funded_by_funders_7d', label: 'Funded by funders, 7 days' },
];

/** Badge colour per state; unknown states stay neutral. */
export function stateTone(state: string | null | undefined): Status {
  const s = (state ?? '').toLowerCase();
  if (s.includes('commit') || s.includes('fund')) return 'ok';
  if (s.includes('held') || s.includes('hold')) return 'warn';
  return 'idle';
}

const plain = (s: string | null | undefined) => (s ? s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : '—');

export function usePartnerWatch(enabled = true) {
  return useQuery({
    queryKey: ['desk-feed', 'partner-watch'],
    enabled,
    queryFn: async (): Promise<{ rows: WatchRow[]; counts: WatchCounts }> => {
      const { data, error } = await rpc('partner_ops_watch', {});
      if (error) throw error;
      const d = (data ?? {}) as { rows?: WatchRow[]; counts?: WatchCounts };
      return { rows: Array.isArray(d.rows) ? d.rows : [], counts: d.counts ?? {} };
    },
    refetchInterval: 60_000,
    staleTime: 20_000,
    retry: 1,
  });
}

export function PartnerWatch({ board }: { board: boolean }) {
  const q = usePartnerWatch();
  if (q.isLoading) return <LoadingRows rows={4} height={36} label="Loading the funder board watch" />;
  if (q.error) return <ErrorLine>The funder board watch could not load: {readableError(q.error)}</ErrorLine>;
  const { rows, counts } = q.data ?? { rows: [], counts: {} };

  return (
    <div className="space-y-4">
      <TileRow max={5}>
        {WATCH_TILES.map((t) => (
          <Tile
            key={t.key}
            label={t.label}
            value={fmt('int', counts[t.key] ?? 0)}
            tone={t.key === 'untouched_48h' && Number(counts[t.key] ?? 0) > 0 ? 'warn' : undefined}
            board={board}
          />
        ))}
      </TileRow>

      <section className={`${PANEL} p-4 sm:p-5`}>
        {rows.length === 0 ? (
          <EmptyState>Nothing is on the funders&rsquo; board.</EmptyState>
        ) : (
          <ul>
            {rows.map((r) => (
              <li
                key={r.id}
                className={`flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-[var(--desk-line-color)] py-2 first:border-t-0 ${board ? 'text-base' : 'text-sm'}`}
              >
                <span className="font-medium text-foreground">{r.tenant ?? '—'}</span>
                <span className={`${LABEL} font-mono`}>{r.req}</span>
                <Chip tone={stateTone(r.state)}>{plain(r.state)}</Chip>
                {r.untouched_48h && (
                  <Chip tone="bad" strong>
                    Untouched 48 h
                  </Chip>
                )}
                <span className="ml-auto tabular-nums text-muted-foreground">{fmt('days', r.days_on_board)} d on board</span>
                <span className="tabular-nums text-foreground">UGX {fmt('ugxfull', r.rent)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
