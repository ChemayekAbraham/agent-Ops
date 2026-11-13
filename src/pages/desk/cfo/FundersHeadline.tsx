import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { ErrorLine, Segmented, moneyCard } from '../ui';
import { Skeleton } from '../Skeleton';
import { CALM, FOCUS, statusText } from '../deskTheme';
import { releaseTone, waitedText } from '../AwaitingRelease';
import { PERIODS, useFundersDashboard, type CountUgx, type Period } from './cfoApi';
import { HEADLINE_KINDS, type HeadlineKind } from './headlineListApi';
import { HeadlineListPanel } from './HeadlineListPanel';
import { ReleasesPanel } from './ReleasesPanel';
import { PERIOD_DAYS, isSold, useReleased, waitingFrom, type SelectedWaiting } from './releasesApi';
import { readableError } from '../reviewApi';

const count = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });

const capped = (shown: number, total: number) => (shown < total ? ` · latest ${count.format(shown)} of ${count.format(total)} shown` : '');

/** "7 days · landlord paid, OTP confirmed", plus how many are shown when the server caps the list. */
export function soldNote(period: Period, shown: number, total: number): string {
  const days = PERIOD_DAYS[period];
  const label = PERIODS.find((p) => p.value === period)?.label ?? period;
  return `${label} · landlord paid, OTP confirmed, in the last ${days} day${days === 1 ? '' : 's'}${capped(shown, total)}`;
}

/** "Right now, whatever the period · funder selected, landlord not yet paid". */
export function selectedNote(shown: number, total: number): string {
  return `Right now, whatever the period · funder selected, landlord not yet paid${capped(shown, total)}`;
}

/** "oldest 30 h": amber past 24 h, red past 72 h. */
export function OldestLine({ w, board }: { w: SelectedWaiting; board: boolean }) {
  if (w.n <= 0 || w.oldestHours === null) return null;
  const tone = releaseTone(w.oldestHours);
  return (
    <span className={`${board ? 'text-base' : 'text-sm'} font-semibold ${statusText[tone]}`} data-oldest={tone} style={{ display: 'block' }}>
      oldest {waitedText(w.oldestHours)}
    </span>
  );
}

/** A headline tile is a button: a tap opens the requests behind its number. */
function BigTile({
  title,
  value,
  caption,
  board,
  onOpen,
  extra,
}: {
  title: string;
  value: CountUgx | null;
  caption: string;
  board: boolean;
  onOpen: () => void;
  extra?: ReactNode;
}) {
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
      {extra}
      <p className="text-xs text-muted-foreground" style={{ margin: '8px 0 0' }}>
        {caption}
      </p>
    </button>
  );
}

/**
 * The Funders Dashboard headline row (boardroom screen 1): the page's period toggle above
 * posted / sold / selected, waiting / waiting for funder.
 *   Posted    the server's (funders_dashboard, same query as the page).
 *   Sold      landlord PAID, OTP confirmed, by payment time in the period (E93:
 *             funded_money_flow(p_days).sold, p_days 1 / 7 / 30 / 90 / 365).
 *   Selected, waiting   a funder selected it, the landlord is not yet paid, right now
 *             (selected_waiting), with the oldest wait (amber past 24 h, red past 72 h).
 *   Waiting for funder  posted minus (sold + selected, waiting), never below zero.
 */
export function FundersHeadline({ board, period, onPeriodChange }: { board: boolean; period: Period; onPeriodChange: (p: Period) => void }) {
  const q = useFundersDashboard(period);
  const rel = useReleased(period);
  const h = q.data?.headline;
  const sold = rel.data?.sold ?? null;
  const selected = rel.data?.selectedWaiting ?? null;
  const waiting = h && sold && selected ? waitingFrom(h.posted, sold, selected) : null;
  const soldItems = useMemo(() => (rel.data?.items ?? []).filter(isSold), [rel.data]);
  const selectedItems = useMemo(() => (rel.data?.items ?? []).filter((i) => !isSold(i)), [rel.data]);
  const takenIds = useMemo(() => (rel.data?.items ?? []).map((i) => i.rent_request_id), [rel.data]);
  const value: Record<HeadlineKind, CountUgx | null> = { posted: h?.posted ?? null, sold, selected, waiting };
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
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {loading || !h ? (
          loading ? (
            [0, 1, 2, 3].map((i) => (
              <div key={i} role="status" aria-label="Loading the headline" style={{ height: 168 }}>
                <Skeleton className="h-full w-full" />
              </div>
            ))
          ) : null
        ) : (
          <>
            {HEADLINE_KINDS.map((k) => (
              <BigTile
                key={k.kind}
                board={board}
                title={k.title}
                value={value[k.kind]}
                caption={k.caption}
                onOpen={() => setOpen(k.kind)}
                extra={k.kind === 'selected' && selected ? <OldestLine w={selected} board={board} /> : undefined}
              />
            ))}
          </>
        )}
      </div>
      {/* Sold, selected and waiting need funded_money_flow; never a zero the server did not send. */}
      {rel.error && <ErrorLine>{readableError(rel.error)}</ErrorLine>}
      {/* The lists use the page's current period. */}
      {open === 'sold' && rel.data ? (
        <ReleasesPanel title="Rent requests sold" items={soldItems} note={soldNote(period, soldItems.length, rel.data.sold.n)} onClose={close} />
      ) : open === 'selected' && rel.data ? (
        <ReleasesPanel title="Selected, waiting" items={selectedItems} note={selectedNote(selectedItems.length, rel.data.selectedWaiting.n)} onClose={close} />
      ) : open === 'posted' || open === 'waiting' ? (
        <HeadlineListPanel kind={open} period={period} onClose={close} excludeIds={open === 'waiting' ? takenIds : undefined} />
      ) : null}
    </section>
  );
}
