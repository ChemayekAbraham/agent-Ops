import { useQuery } from '@tanstack/react-query';
import { fmt } from './format';
import { FIGURE, LABEL, PANEL, statusGlass, statusText, type Status } from './deskTheme';
import { Skeleton } from './Skeleton';
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
  if (q.isLoading) return <Skeleton className="h-40 w-full" />;
  if (q.error) return <p className={`text-sm ${statusText.bad}`} role="alert">The funder board watch could not load: {readableError(q.error)}</p>;
  const { rows, counts } = q.data ?? { rows: [], counts: {} };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        {WATCH_TILES.map((t) => (
          <div key={t.key} className="desk-tile space-y-1 p-3 sm:p-4">
            <div className={LABEL}>{t.label}</div>
            <div className={`${FIGURE} ${board ? 'text-3xl' : 'text-2xl'} ${t.key === 'untouched_48h' && Number(counts[t.key] ?? 0) > 0 ? statusText.warn : ''}`}>
              {fmt('int', counts[t.key] ?? 0)}
            </div>
          </div>
        ))}
      </div>

      <section className={`${PANEL} p-4 sm:p-5`}>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing is on the funders&rsquo; board.</p>
        ) : (
          <ul>
            {rows.map((r) => (
              <li
                key={r.id}
                className={`flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-[var(--desk-line-color)] py-2 first:border-t-0 ${board ? 'text-base' : 'text-sm'}`}
              >
                <span className="font-medium text-foreground">{r.tenant ?? '—'}</span>
                <span className={`${LABEL} font-mono`}>{r.req}</span>
                <span className={`desk-pill border px-2 py-0.5 text-[11px] ${statusGlass[stateTone(r.state)]}`}>{plain(r.state)}</span>
                {r.untouched_48h && (
                  <span className={`desk-pill border px-2 py-0.5 text-[11px] font-semibold ${statusGlass.bad}`}>Untouched 48 h</span>
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
