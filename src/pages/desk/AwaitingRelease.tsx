import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { rpc } from './reviewApi';
import { fmt } from './format';
import { CALM, FOCUS, LABEL, PANEL, statusGlass, statusText, type Status } from './deskTheme';
import { Skeleton } from './Skeleton';
import { EmptyState, ErrorLine, LoadingRows, Sheet, moneyFull } from './ui';

/**
 * "Selected · awaiting release" (E71): requests a funder has selected on the
 * funders' dashboard (the Booked tag) that are still waiting for their money
 * to be released. From `funders_selected_awaiting_release(p_limit)`; the
 * server says who releases it (`released_by`).
 *
 * Sits beside the "Funders board" card on the COO desk and the Command Centre.
 * Loading shows a skeleton and a failure says so: it never shows a zero it
 * has not been told.
 */

export type AwaitingItem = {
  id?: string;
  short_id: string;
  tenant: string | null;
  rent: number | null;
  funder: string | null;
  picked_at: string | null;
  hours_waiting: number | null;
  commitment_status: string | null;
};

export type AwaitingRelease = {
  count: number;
  ugx: number;
  oldest_hours: number | null;
  released_by: string | null;
  items: AwaitingItem[];
};

export const AWAITING_LIMIT = 100;

export function useAwaitingRelease(enabled = true) {
  return useQuery({
    queryKey: ['desk-feed', 'awaiting-release', AWAITING_LIMIT],
    enabled,
    queryFn: async (): Promise<AwaitingRelease> => {
      const { data, error } = await rpc('funders_selected_awaiting_release', { p_limit: AWAITING_LIMIT });
      if (error) throw error;
      const d = (data ?? {}) as Partial<AwaitingRelease>;
      return {
        count: Number(d.count ?? 0),
        ugx: Number(d.ugx ?? 0),
        oldest_hours: d.oldest_hours === null || d.oldest_hours === undefined ? null : Number(d.oldest_hours),
        released_by: d.released_by ?? null,
        items: Array.isArray(d.items) ? d.items : [],
      };
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
  });
}

/** Amber once the oldest selection has waited over a day, red over three days. */
export function releaseTone(hours: number | null | undefined): Status {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return 'idle';
  if (hours > 72) return 'bad';
  if (hours > 24) return 'warn';
  return 'ok';
}

/** "3 selected · UGX 2,100,000 · awaiting release". */
export function awaitingLine(d: Pick<AwaitingRelease, 'count' | 'ugx'>): string {
  return `${fmt('int', d.count)} selected · ${moneyFull(d.ugx)} · awaiting release`;
}

/** "5 h", "2 d 3 h". */
export function waitedText(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return '—';
  const h = Math.max(0, Math.round(hours));
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

export function AwaitingReleaseCard({ board }: { board: boolean }) {
  const q = useAwaitingRelease();
  const [open, setOpen] = useState(false);
  const d = q.data;
  const tone = releaseTone(d?.oldest_hours);
  const title = 'Selected · awaiting release';

  return (
    <section className={`${PANEL} scroll-mt-4 space-y-2 p-4 sm:p-5`} aria-label={title} data-awaiting-release>
      <h2 className={`${board ? 'text-lg' : 'text-base'} font-semibold text-foreground`}>{title}</h2>
      {q.isLoading ? (
        <Skeleton className="h-8 w-56" />
      ) : q.error ? (
        <ErrorLine>{String((q.error as { message?: string }).message ?? q.error)}</ErrorLine>
      ) : d ? (
        <>
          <button
            type="button"
            onClick={() => setOpen(true)}
            data-tone={tone}
            className={`w-full rounded-xl border px-3 py-2 text-left ${board ? 'text-lg' : 'text-base'} leading-snug ${CALM} ${FOCUS} ${statusGlass[tone]}`}
            title="See each selected request"
          >
            {awaitingLine(d)}
            {d.count > 0 && d.oldest_hours !== null && <span className="block text-xs opacity-90">Oldest waiting {waitedText(d.oldest_hours)}</span>}
          </button>
          {d.released_by && <p className={LABEL}>{d.released_by}</p>}
        </>
      ) : null}

      {open && (
        <Sheet title={title} onClose={() => setOpen(false)}>
          <AwaitingList q={q} />
        </Sheet>
      )}
    </section>
  );
}

function AwaitingList({ q }: { q: ReturnType<typeof useAwaitingRelease> }) {
  if (q.isLoading) return <LoadingRows rows={4} height={40} label="Loading the selected requests" />;
  if (q.error) return <ErrorLine>{String((q.error as { message?: string }).message ?? q.error)}</ErrorLine>;
  const d = q.data;
  if (!d || d.items.length === 0) return <EmptyState>Nothing selected is waiting for release.</EmptyState>;
  return (
    <>
      <p className="text-sm text-foreground" style={{ margin: 0 }}>
        {awaitingLine(d)}
      </p>
      {d.released_by && <p className={LABEL}>{d.released_by}</p>}
      <ul style={{ margin: 0, padding: 0, listStyle: 'none' }} aria-label="Selected, awaiting release">
        {d.items.map((it) => {
          const t = releaseTone(it.hours_waiting);
          return (
            <li
              key={it.id ?? it.short_id}
              data-item={it.short_id}
              className="border-t border-[var(--desk-line-color)] first:border-t-0"
              style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 4, padding: '10px 0' }}
            >
              <span className="font-medium text-foreground" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                {it.tenant ?? '—'}
              </span>
              <span className="tabular-nums text-foreground" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                {moneyFull(it.rent)}
              </span>
              <span className="text-sm text-muted-foreground" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                Funder: {it.funder ?? '—'}
                {it.commitment_status ? ` · ${it.commitment_status.replace(/_/g, ' ')}` : ''}
              </span>
              <span className={`text-sm tabular-nums ${statusText[t === 'idle' ? 'idle' : t]}`} style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                {waitedText(it.hours_waiting)}
              </span>
            </li>
          );
        })}
      </ul>
      {d.count > d.items.length && (
        <p className={LABEL}>
          Showing the oldest {fmt('int', d.items.length)} of {fmt('int', d.count)}.
        </p>
      )}
    </>
  );
}
