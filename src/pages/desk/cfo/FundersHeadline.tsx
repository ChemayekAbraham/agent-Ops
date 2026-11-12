import { useCallback, useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { ErrorLine, Segmented, moneyCard } from '../ui';
import { Skeleton } from '../Skeleton';
import { CALM, FOCUS } from '../deskTheme';
import { PERIODS, useFundersDashboard, type CountUgx, type Period } from './cfoApi';
import { HEADLINE_KINDS, type HeadlineKind } from './headlineListApi';
import { HeadlineListPanel } from './HeadlineListPanel';
import { ReleasesPanel } from './ReleasesPanel';
import { PERIOD_DAYS, useReleased, waitingFrom } from './releasesApi';
import { readableError } from '../reviewApi';

const count = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });

/** "7 days · released to an agent's landlord float in the last 7 days", plus how many are shown when the server caps the list. */
export function soldNote(period: Period, shown: number, total: number): string {
  const days = PERIOD_DAYS[period];
  const label = PERIODS.find((p) => p.value === period)?.label ?? period;
  const capped = shown < total ? ` · latest ${count.format(shown)} of ${count.format(total)} shown` : '';
  return `${label} · released to an agent's landlord float in the last ${days} day${days === 1 ? '' : 's'}${capped}`;
}

/** A headline tile is a button: a tap opens the requests behind its number. */
function BigTile({ title, value, caption, board, onOpen }: { title: string; value: CountUgx | null; caption: string; board: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!value}
      aria-haspopup="dialog"
      aria-label={value ? `${title}: ${count.format(value.n)}, ${moneyCard(value.ugx)}. Show the list` : `${title}: not available`}
      className={`desk-tile w-full cursor-pointer text-left ${CALM} ${FOCUS} hover:border-[hsl(var(--primary)/0.45)] hover:bg-[var(--desk-surface-hover)] active:scale-[0.98] active:bg-[hsl(var(--primary)/0.12)] motion-reduce:active:scale-100`}
      style={{ padding: 20, minWidth: 0, display: 'block', transitionProperty: 'background-color, border-color, transform' }}
      data-funders-headline-tile
    >
      <h3 className={`${board ? 'text-lg' : 'text-base'} font-semibold text-foreground`} style={{ margin: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        {title}
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      </h3>
      <p className="text-5xl sm:text-6xl font-bold tabular-nums leading-tight text-foreground" style={{ margin: '8px 0 0' }}>
        {value ? count.format(value.n) : '—'}
      </p>
      <p className="text-xl font-semibold tabular-nums text-foreground" style={{ margin: '4px 0 0' }}>
        {value ? moneyCard(value.ugx) : '—'}
      </p>
      <p className="text-xs text-muted-foreground" style={{ margin: '8px 0 0' }}>
        {caption}
      </p>
    </button>
  );
}

/**
 * The Funders Dashboard headline row: the page's period toggle above posted / sold / waiting.
 * Posted is the server's (funders_dashboard, same query as the page). Sold counts every funder
 * selection RELEASED to an agent's landlord float in the period (funded_money_flow(p_days).released,
 * p_days 1 / 7 / 30 / 90 / 365), not only landlord-paid ones. Waiting is posted minus released, so
 * the three add up.
 */
export function FundersHeadline({ board, period, onPeriodChange }: { board: boolean; period: Period; onPeriodChange: (p: Period) => void }) {
  const q = useFundersDashboard(period);
  const rel = useReleased(period);
  const h = q.data?.headline;
  const sold = rel.data?.released ?? null;
  const waiting = h && sold ? waitingFrom(h.posted, sold) : null;
  const releasedIds = useMemo(() => (rel.data?.items ?? []).map((i) => i.rent_request_id), [rel.data]);
  const value: Record<HeadlineKind, CountUgx | null> = { posted: h?.posted ?? null, sold, waiting };
  const [open, setOpen] = useState<HeadlineKind | null>(null);
  // Stable, so the panel's focus-on-open runs once, not on every refetch.
  const close = useCallback(() => setOpen(null), []);
  const loading = q.isLoading || rel.isLoading;
  return (
    <section className="space-y-3" aria-label="Rent requests headline">
      <Segmented
        ariaLabel="Period for the funded figures"
        size="md"
        options={PERIODS.map((p) => ({ value: p.value, label: p.label }))}
        value={period}
        onChange={(p) => p !== null && onPeriodChange(p)}
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {loading || !h ? (
          loading ? (
            [0, 1, 2].map((i) => (
              <div key={i} role="status" aria-label="Loading the headline" style={{ height: 168 }}>
                <Skeleton className="h-full w-full" />
              </div>
            ))
          ) : null
        ) : (
          <>
            {HEADLINE_KINDS.map((k) => (
              <BigTile key={k.kind} board={board} title={k.title} value={value[k.kind]} caption={k.caption} onOpen={() => setOpen(k.kind)} />
            ))}
          </>
        )}
      </div>
      {/* Sold and waiting need the releases; never a zero the server did not send. */}
      {rel.error && <ErrorLine>{readableError(rel.error)}</ErrorLine>}
      {/* The lists use the page's current period. */}
      {open === 'sold' && rel.data ? (
        <ReleasesPanel title="Rent requests sold" items={rel.data.items} note={soldNote(period, rel.data.items.length, rel.data.released.n)} onClose={close} />
      ) : open && open !== 'sold' ? (
        <HeadlineListPanel kind={open} period={period} onClose={close} excludeIds={open === 'waiting' ? releasedIds : undefined} />
      ) : null}
    </section>
  );
}
