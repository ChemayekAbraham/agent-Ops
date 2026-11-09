import { Segmented, moneyCard } from '../ui';
import { Skeleton } from '../Skeleton';
import { PERIODS, useFundersDashboard, type CountUgx, type Period } from './cfoApi';

const count = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });

function BigTile({ title, value, caption, board }: { title: string; value: CountUgx; caption: string; board: boolean }) {
  return (
    <article className="desk-tile" style={{ padding: 20, minWidth: 0 }} data-funders-headline-tile>
      <h3 className={`${board ? 'text-lg' : 'text-base'} font-semibold text-foreground`} style={{ margin: 0 }}>
        {title}
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
    </article>
  );
}

/** The Funders Dashboard headline row: the page's period toggle above posted / sold / waiting. Same query as the page. */
export function FundersHeadline({ board, period, onPeriodChange }: { board: boolean; period: Period; onPeriodChange: (p: Period) => void }) {
  const q = useFundersDashboard(period);
  const h = q.data?.headline;
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
            <BigTile board={board} title="Rent requests posted" value={h.posted} caption="From the COO to the funders' board" />
            <BigTile board={board} title="Rent requests sold" value={h.sold} caption="Funded by partners in the field" />
            <BigTile board={board} title="Waiting for funder" value={h.waiting} caption="Posted minus sold" />
          </>
        )}
      </div>
    </section>
  );
}
