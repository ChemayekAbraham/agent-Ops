import { useCallback, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Segmented, moneyCard } from '../ui';
import { Skeleton } from '../Skeleton';
import { CALM, FOCUS } from '../deskTheme';
import { PERIODS, useFundersDashboard, type CountUgx, type Period } from './cfoApi';
import { HEADLINE_KINDS, type HeadlineKind } from './headlineListApi';
import { HeadlineListPanel } from './HeadlineListPanel';

const count = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });

/** A headline tile is a button: a tap opens the requests behind its number. */
function BigTile({ title, value, caption, board, onOpen }: { title: string; value: CountUgx; caption: string; board: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-label={`${title}: ${count.format(value.n)}, ${moneyCard(value.ugx)}. Show the list`}
      className={`desk-tile w-full cursor-pointer text-left ${CALM} ${FOCUS} hover:border-[hsl(var(--primary)/0.45)] hover:bg-[var(--desk-surface-hover)] active:scale-[0.98] active:bg-[hsl(var(--primary)/0.12)] motion-reduce:active:scale-100`}
      style={{ padding: 20, minWidth: 0, display: 'block', transitionProperty: 'background-color, border-color, transform' }}
      data-funders-headline-tile
    >
      <h3 className={`${board ? 'text-lg' : 'text-base'} font-semibold text-foreground`} style={{ margin: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        {title}
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      </h3>
      <p className="text-5xl sm:text-6xl font-bold tabular-nums leading-tight text-foreground" style={{ margin: '8px 0 0' }}>
        {count.format(value.n)}
      </p>
      <p className="text-xl font-semibold tabular-nums text-foreground" style={{ margin: '4px 0 0' }}>
        {moneyCard(value.ugx)}
      </p>
      <p className="text-xs text-muted-foreground" style={{ margin: '8px 0 0' }}>
        {caption}
      </p>
    </button>
  );
}

/** The Funders Dashboard headline row: the page's period toggle above posted / sold / waiting. Same query as the page. */
export function FundersHeadline({ board, period, onPeriodChange }: { board: boolean; period: Period; onPeriodChange: (p: Period) => void }) {
  const q = useFundersDashboard(period);
  const h = q.data?.headline;
  const [open, setOpen] = useState<HeadlineKind | null>(null);
  // Stable, so the panel's focus-on-open runs once, not on every refetch.
  const close = useCallback(() => setOpen(null), []);
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
        {q.isLoading || !h ? (
          q.isLoading ? (
            [0, 1, 2].map((i) => (
              <div key={i} role="status" aria-label="Loading the headline" style={{ height: 168 }}>
                <Skeleton className="h-full w-full" />
              </div>
            ))
          ) : null
        ) : (
          <>
            {HEADLINE_KINDS.map((k) => (
              <BigTile key={k.kind} board={board} title={k.title} value={h[k.kind]} caption={k.caption} onOpen={() => setOpen(k.kind)} />
            ))}
          </>
        )}
      </div>
      {/* The list uses the page's current period. */}
      {open && <HeadlineListPanel kind={open} period={period} onClose={close} />}
    </section>
  );
}
