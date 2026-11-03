import { Link } from 'react-router-dom';
import { fmt } from './format';
import type { Getter, Tile } from './deskConfig';
import { useStageFlow, type FeedState, type Row } from './useDeskFeed';
import { StageFlow } from './StageFlow';
import { TileGrid } from './Tiles';
import { Skeleton } from './Skeleton';
import { CALM, FOCUS, statusText, type Status } from './deskTheme';

const num = (v: unknown): number | null =>
  v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v);

type Blocker = { key: string; text: string; tone: Status; to?: string; rank: number };

/**
 * The ranked list of what is actually stopping money moving today.
 * Rank 0 is money that cannot move at all; then stages by how long they would take to clear.
 */
function buildBlockers(flow: Row[], kpis: Row[], care: Row[]): Blocker[] {
  const out: Blocker[] = [];

  const budget = kpis.find((r) => String(r.metric) === 'budget_today_ugx');
  if (num(budget?.value) === null) {
    const coo = flow.find((r) => String(r.ord) === '5');
    out.push({
      key: 'budget',
      rank: 0,
      tone: 'bad',
      to: '/desk/cfo',
      text: `CFO has not set today's float budget: ${fmt('int', coo?.waiting ?? 0)} requests worth ${fmt('ugx', coo?.waiting_ugx ?? 0)} are stopped at the COO step.`,
    });
  }

  flow
    .filter((r) => (num(r.waiting) ?? 0) > 0)
    .map((r) => {
      const days = num(r.days_to_clear);
      const stuck = days === null;
      return { r, days: stuck ? Number.POSITIVE_INFINITY : days, stuck };
    })
    .filter((x) => x.stuck || x.days > 1)
    .sort((a, b) => b.days - a.days)
    .slice(0, 3)
    .forEach(({ r, days, stuck }) => {
      out.push({
        key: `stage-${r.ord}`,
        rank: stuck ? 1 : 2,
        tone: stuck || days > 2 ? 'bad' : 'warn',
        to: undefined,
        text: stuck
          ? `${r.stage}: ${fmt('int', r.waiting)} waiting worth ${fmt('ugx', r.waiting_ugx)} and nothing cleared in 7 days — ${r.desk} acts next.`
          : `${r.stage}: ${fmt('int', r.waiting)} waiting worth ${fmt('ugx', r.waiting_ugx)}, clearing ${Number(r.per_day_7d).toFixed(1)} a day — ${days.toFixed(1)} days to clear, ${r.desk} acts next.`,
      });
    });

  const overdue = care.reduce((t, r) => t + (num(r.overdue) ?? 0), 0);
  if (overdue > 0) {
    out.push({
      key: 'care',
      rank: 3,
      tone: 'warn',
      to: '/desk/customer-care',
      text: `Customer Care: ${fmt('int', overdue)} concerns are past their due date.`,
    });
  }

  return out.sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key));
}

function Blockers({ items, loading, board, limit }: { items: Blocker[]; loading: boolean; board: boolean; limit?: number }) {
  const text = statusText(board);
  const shown = limit ? items.slice(0, limit) : items;
  return (
    <section className="rounded-lg border border-border bg-card p-4 sm:p-5 space-y-3 min-w-0">
      <h2 className={`${board ? 'text-lg' : 'text-base'} font-semibold text-foreground`}>Today&rsquo;s blockers</h2>

      {loading && (
        <div className="space-y-2" role="status" aria-label="Loading blockers">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      )}

      {!loading && shown.length === 0 && (
        <p className={`${board ? 'text-base' : 'text-sm'} text-muted-foreground`}>
          Nothing is blocked. Every stage is clearing inside a day — no action needed right now.
        </p>
      )}

      {!loading && shown.length > 0 && (
        <ol className="space-y-2.5">
          {shown.map((b, i) => {
            const line = (
              <>
                <span className={`mt-0.5 w-5 shrink-0 text-right tabular-nums font-semibold ${text[b.tone]}`}>{i + 1}</span>
                <span className={`${board ? 'text-base' : 'text-sm'} leading-snug text-foreground`}>{b.text}</span>
              </>
            );
            return (
              <li key={b.key}>
                {b.to ? (
                  <Link to={b.to} className={`flex gap-2.5 rounded-md -m-1 p-1 ${CALM} ${FOCUS} hover:bg-muted/50`}>
                    {line}
                  </Link>
                ) : (
                  <div className="flex gap-2.5">{line}</div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {limit && items.length > limit && (
        <p className="text-xs text-muted-foreground">{items.length - limit} more not shown.</p>
      )}
    </section>
  );
}

export function CommandCentre({
  feeds,
  board,
  tiles,
  g,
}: {
  feeds: Record<string, FeedState>;
  board: boolean;
  tiles: Tile[];
  g: Getter;
}) {
  const flow = useStageFlow();
  const kpis = feeds.coo_kpis?.rows ?? [];
  const care = feeds.cc_owners?.rows ?? [];
  const loading = flow.loading || Boolean(feeds.coo_kpis?.loading);
  const blockers = loading ? [] : buildBlockers(flow.rows, kpis, care);

  if (board) {
    // One screen, no scrolling: the flow on top, blockers and balance side by side under it.
    return (
      <div className="flex h-full min-h-0 flex-col gap-4">
        <div className="shrink-0">
          <StageFlow feed={flow} board />
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-5">
          <div className="min-h-0 overflow-hidden lg:col-span-2">
            <Blockers items={blockers} loading={loading} board limit={3} />
          </div>
          <div className="min-h-0 overflow-hidden lg:col-span-3">
            <TileGrid tiles={tiles} g={g} board />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <StageFlow feed={flow} board={false} />
      <Blockers items={blockers} loading={loading} board={false} />
    </div>
  );
}
