import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { rpc } from './reviewApi';
import { fmt } from './format';
import { CALM, FOCUS, LABEL, PANEL, statusGlass, statusText, type Status } from './deskTheme';
import { Skeleton } from './Skeleton';
import { EmptyState, ErrorLine, LoadingRows, Sheet, moneyFull } from './ui';
import { waitedText } from './AwaitingRelease';

/**
 * "Tenants waiting for an agent" (E73): tenants who applied on their own (the
 * tenant app or the WhatsApp assistant) and still have no real agent. From
 * `pipeline_self_applied_queue(p_limit)`; Agent Ops assigns the agent from its
 * board's "Assign an agent" group.
 *
 * On the COO desk and Command Centre (with the push-queue cards) and on the
 * Agent Ops desk. A skeleton while loading, the server's words on a failure:
 * never a zero it has not been told. A desk the server does not show this to
 * (not authorized) simply has no card.
 */

export type SelfAppliedItem = {
  id?: string;
  short_id: string;
  tenant: string | null;
  tenant_phone: string | null;
  city: string | null;
  rent: number | null;
  via: string | null;
  hours_waiting: number | null;
};

export type SelfAppliedQueue = {
  count: number;
  ugx: number;
  oldest_hours: number | null;
  over_24h: number;
  over_72h: number;
  items: SelfAppliedItem[];
};

export const SELF_APPLIED_LIMIT = 100;

export function useSelfAppliedQueue(enabled = true) {
  return useQuery({
    queryKey: ['desk-feed', 'self-applied-queue', SELF_APPLIED_LIMIT],
    enabled,
    queryFn: async (): Promise<SelfAppliedQueue> => {
      const { data, error } = await rpc('pipeline_self_applied_queue', { p_limit: SELF_APPLIED_LIMIT });
      if (error) throw error;
      const d = (data ?? {}) as Partial<SelfAppliedQueue>;
      return {
        count: Number(d.count ?? 0),
        ugx: Number(d.ugx ?? 0),
        oldest_hours: d.oldest_hours === null || d.oldest_hours === undefined ? null : Number(d.oldest_hours),
        over_24h: Number(d.over_24h ?? 0),
        over_72h: Number(d.over_72h ?? 0),
        items: Array.isArray(d.items) ? d.items : [],
      };
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
  });
}

/** Red when anyone has waited over 72 h, amber over 24 h. */
export function queueTone(q: Pick<SelfAppliedQueue, 'count' | 'over_24h' | 'over_72h'>): Status {
  if (q.over_72h > 0) return 'bad';
  if (q.over_24h > 0) return 'warn';
  return q.count > 0 ? 'ok' : 'idle';
}

/** "4 waiting · oldest 30 h"; "0 waiting" when nobody is. */
export function queueLine(q: Pick<SelfAppliedQueue, 'count' | 'oldest_hours'>): string {
  if (q.count === 0 || q.oldest_hours === null) return `${fmt('int', q.count)} waiting`;
  return `${fmt('int', q.count)} waiting · oldest ${fmt('int', Math.round(q.oldest_hours))} h`;
}

const notAuthorized = (e: unknown) => {
  const x = e as { code?: string; message?: string } | null;
  return x?.code === '42501' || /not authori[sz]ed/i.test(String(x?.message ?? ''));
};

export function SelfAppliedCard({ board }: { board: boolean }) {
  const q = useSelfAppliedQueue();
  const [open, setOpen] = useState(false);
  const title = 'Tenants waiting for an agent';
  if (q.error && notAuthorized(q.error)) return null;
  const d = q.data;
  const tone = d ? queueTone(d) : 'idle';

  return (
    <section className={`${PANEL} scroll-mt-4 space-y-2 p-4 sm:p-5`} aria-label={title} data-self-applied>
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
            title="See each tenant"
          >
            {queueLine(d)}
            {d.over_24h > 0 && (
              <span className="block text-xs opacity-90">
                {fmt('int', d.over_24h)} over 24 h{d.over_72h > 0 ? ` · ${fmt('int', d.over_72h)} over 72 h` : ''}
              </span>
            )}
          </button>
          <p className={LABEL}>Applied without an agent. Agent Ops assigns the nearest eligible agent.</p>
        </>
      ) : null}

      {open && (
        <Sheet title={title} onClose={() => setOpen(false)}>
          <QueueList q={q} />
        </Sheet>
      )}
    </section>
  );
}

function QueueList({ q }: { q: ReturnType<typeof useSelfAppliedQueue> }) {
  if (q.isLoading) return <LoadingRows rows={4} height={40} label="Loading the tenants waiting" />;
  if (q.error) return <ErrorLine>{String((q.error as { message?: string }).message ?? q.error)}</ErrorLine>;
  const d = q.data;
  if (!d || d.items.length === 0) return <EmptyState>No tenant is waiting for an agent.</EmptyState>;
  return (
    <>
      <p className="text-sm text-foreground" style={{ margin: 0 }}>
        {queueLine(d)} · {moneyFull(d.ugx)}
      </p>
      <ul style={{ margin: 0, padding: 0, listStyle: 'none' }} aria-label="Tenants waiting for an agent">
        {d.items.map((it) => {
          const h = it.hours_waiting ?? 0;
          const t: Status = h > 72 ? 'bad' : h > 24 ? 'warn' : 'idle';
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
                {it.tenant_phone ? (
                  <a href={`tel:${it.tenant_phone}`} className={`font-mono underline-offset-2 hover:underline ${FOCUS}`}>
                    {it.tenant_phone}
                  </a>
                ) : (
                  'no number'
                )}
                {` · ${it.city ?? 'city not given'} · via ${it.via ?? '—'}`}
              </span>
              <span className={`text-sm tabular-nums ${statusText[t]}`} style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
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
