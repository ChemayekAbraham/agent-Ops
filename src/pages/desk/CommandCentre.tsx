import { useState } from 'react';
import { Link } from 'react-router-dom';
import { decisionTone, fmt, type Tone } from './format';
import type { Tile } from './deskConfig';
import { useStageFlow, type FeedState, type Row } from './useDeskFeed';
import { StageFlow, actingDesk } from './StageFlow';
import { TileGrid } from './Tiles';
import { Skeleton, SkeletonTiles } from './Skeleton';
import { CALM, FOCUS, LABEL, PANEL, statusDot, statusText, type Status } from './deskTheme';
import { TodayByDesk, WentAgainstTheSystem, WhyRequestsBounce } from './PipelineCards';
import { MorningBrief } from './MorningBrief';
import { BudgetRoomCard } from './BudgetRoomCard';
import { useMorningBrief } from './deskBriefApi';
import type { Blocked } from './Tiles';
import { CommandAdditionCards, MoneyLine } from './CommandAdditions';

/** The tile that carries today's money blocker. Matched by label, as the grid is. */
const BUDGET_TILE = 'Daily float budget';

/**
 * What is holding money up right now, by tile.
 *
 * One rule today: the COO step cannot move without a CFO budget. With no daily
 * budget set, everything waiting at that step is blocked; with one set, only
 * the part that will not fit in the room left. Other tiles report figures, not
 * blockages, so they stay at zero.
 */
function blockedByTile(kpis: Row[], pipeline: Row[], roomUgx: number | null): Record<string, Blocked> {
  const cooRow = pipeline.find((r) => String(r.ord) === '5');
  const cooUgx = num(cooRow?.ugx) ?? 0;
  if (cooUgx <= 0) return {};

  const budgetToday = kpis.find((r) => String(r.metric) === 'budget_today_ugx');
  const budgetSet = budgetToday !== undefined && num(budgetToday.value) !== null;

  if (!budgetSet) return { [BUDGET_TILE]: { ugx: cooUgx, who: "CFO sets today's budget" } };

  const over = cooUgx - (roomUgx ?? 0);
  return over > 0 ? { [BUDGET_TILE]: { ugx: over, who: "CFO raises today's budget" } } : {};
}

const num = (v: unknown): number | null =>
  v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v);

const TONE_STATUS: Record<Tone, Status> = { go: 'ok', wait: 'warn', stop: 'bad', plain: 'idle' };

type Blocker = { key: string; text: string; tone: Status; to?: string; rank: number };

/**
 * The ranked list of what is actually stopping money moving today.
 * Rank 0 is money that cannot move at all; then stages by how long they would take to clear.
 */
function buildBlockers(flow: Row[], kpis: Row[], care: Row[]): Blocker[] {
  const out: Blocker[] = [];

  const budget = kpis.find((r) => String(r.metric) === 'budget_today_ugx');
  if (num(budget?.value) === null) {
    const coo = flow.find((r) => String(r.ord) === '6');
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
        text: stuck
          ? `${r.stage}: ${fmt('int', r.waiting)} waiting worth ${fmt('ugx', r.waiting_ugx)} and nothing cleared in 7 days — ${actingDesk(r)} acts next.`
          : `${r.stage}: ${fmt('int', r.waiting)} waiting worth ${fmt('ugx', r.waiting_ugx)}, clearing ${Number(r.per_day_7d).toFixed(1)} a day — ${days.toFixed(1)} days to clear, ${actingDesk(r)} acts next.`,
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

function Panel({ title, board, children }: { title: string; board: boolean; children: React.ReactNode }) {
  return (
    <section className={`${PANEL} flex min-h-0 flex-col gap-3.5 p-5`}>
      <h2 className={`${board ? 'text-lg' : 'text-base'} shrink-0 font-semibold text-foreground`}>{title}</h2>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </section>
  );
}

/** The three that matter today, with the rest a click away. */
const BLOCKER_LIMIT = 3;

function Blockers({ items, loading, board }: { items: Blocker[]; loading: boolean; board: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const hidden = Math.max(0, items.length - BLOCKER_LIMIT);
  const shown = expanded ? items : items.slice(0, BLOCKER_LIMIT);

  return (
    <Panel title="Today&rsquo;s blockers" board={board}>
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
        <ol className="space-y-3">
          {shown.map((b) => {
            const line = (
              <>
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${statusDot[b.tone]}`} aria-hidden />
                <span className={`${board ? 'text-base' : 'text-sm'} leading-snug text-foreground`}>{b.text}</span>
              </>
            );
            return (
              <li key={b.key}>
                {b.to ? (
                  <Link to={b.to} className={`flex gap-2.5 rounded-lg -m-1 p-1 ${CALM} ${FOCUS} hover:bg-[var(--desk-surface-hover)]`}>
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

      {!loading && hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className={`${LABEL} mt-1 w-fit rounded underline underline-offset-4 ${CALM} ${FOCUS} hover:text-foreground`}
        >
          {expanded ? 'Show fewer' : `+${hidden} more`}
        </button>
      )}
    </Panel>
  );
}

function MoneyOut({ feed, board, limit }: { feed: FeedState; board: boolean; limit?: number }) {
  const rows = feed.rows;
  const shown = limit ? rows.slice(0, limit) : rows;
  const max = Math.max(1, ...rows.map((r) => num(r.ugx) ?? 0));

  return (
    <Panel title="Money out" board={board}>
      {feed.loading && (
        <div className="space-y-3" role="status" aria-label="Loading payment gaps">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-5/6" />
        </div>
      )}

      {!feed.loading && feed.error && (
        <div role="alert" className="space-y-1">
          <p className={`font-medium ${statusText.bad}`}>Could not load the payment gaps</p>
          <p className="text-sm text-muted-foreground">{feed.error}</p>
          <p className="text-sm text-muted-foreground">Use “Refresh now” above; tell the COO office if it keeps failing.</p>
        </div>
      )}

      {!feed.loading && !feed.error && rows.length === 0 && (
        <p className={`${board ? 'text-base' : 'text-sm'} text-muted-foreground`}>
          No payment gaps. Every funded request has reached the landlord with evidence.
        </p>
      )}

      {!feed.loading && !feed.error && shown.length > 0 && (
        <ul className="space-y-3">
          {shown.map((r, i) => {
            const ugx = num(r.ugx) ?? 0;
            const tone = TONE_STATUS[decisionTone(r.next_step)];
            return (
              <li key={String(r.ord ?? i)} className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className={`${board ? 'text-base' : 'text-sm'} truncate text-foreground`}>{String(r.gap ?? '—')}</span>
                  <span className={`${board ? 'text-base' : 'text-sm'} shrink-0 tabular-nums text-foreground`}>
                    {fmt('ugx', ugx)}
                  </span>
                </div>
                <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--desk-surface-hover)]" aria-hidden>
                  <div
                    className="h-full rounded-full bg-[hsl(var(--primary))]"
                    style={{ width: `${Math.max(2, Math.round((ugx / max) * 100))}%` }}
                  />
                </div>
                <div className={`${LABEL} flex flex-wrap items-baseline justify-between gap-x-3`}>
                  <span className="truncate">
                    {fmt('int', r.n)} waiting · oldest {fmt('days', r.oldest_days)} days · {String(r.owner ?? '—')}
                  </span>
                  <span className={statusText[tone]}>{String(r.next_step ?? '')}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {limit && rows.length > limit && (
        <Link
          to="/desk/coo"
          className={`mt-2 inline-block rounded text-xs font-medium text-[hsl(var(--desk-lavender))] underline underline-offset-4 ${FOCUS}`}
        >
          See all {fmt('int', rows.length)} gaps on the COO desk
        </Link>
      )}
    </Panel>
  );
}

export function CommandCentre({
  feeds,
  board,
  tiles,
  pipelineCards,
}: {
  feeds: Record<string, FeedState>;
  board: boolean;
  tiles: Tile[];
  /** The E26 cards — today by desk, overrides, and why requests bounce. Off with the flag. */
  pipelineCards?: boolean;
}) {
  const flow = useStageFlow();
  const kpis = feeds.coo_kpis?.rows ?? [];
  const care = feeds.cc_owners?.rows ?? [];
  const gaps = feeds.payment_gaps ?? { rows: [], loading: true, error: null, updatedAt: 0 };
  const loading = flow.loading || Boolean(feeds.coo_kpis?.loading);
  const blockers = loading ? [] : buildBlockers(flow.rows, kpis, care);

  // The brief also carries the budget room, so the blocker figure and the
  // budget-room card are always the same number read the same way.
  const brief = useMorningBrief(!!pipelineCards);
  const roomUgx = brief.data?.budget_room?.room_ugx ?? null;
  const budgetTodayRow = kpis.find((r) => String(r.metric) === 'budget_today_ugx');
  const budgetSetToday = feeds.coo_kpis?.loading
    ? null
    : budgetTodayRow !== undefined && num(budgetTodayRow.value) !== null;

  const blocked = pipelineCards && !loading ? blockedByTile(kpis, feeds.pipeline?.rows ?? [], roomUgx) : undefined;

  // The balance strip is the six business-health figures; the COO desk keeps the full set.
  const strip = tiles.slice(0, 6);
  const stripLoading = Boolean(feeds.coo_kpis?.loading);

  // The money blocker sits on the budget tile; the money line links here.
  const balance = (
    <div id="money-blocker" className="scroll-mt-4">
      {stripLoading ? (
        <SkeletonTiles count={6} board={board} />
      ) : (
        <TileGrid
          tiles={strip}
          feeds={feeds}
          board={board}
          columns="grid-cols-2 sm:grid-cols-3 xl:grid-cols-6"
          blocked={blocked}
        />
      )}
    </div>
  );
  const moneyLine = pipelineCards ? <MoneyLine kpis={feeds.coo_kpis} gaps={gaps} board={board} /> : null;

  if (board) {
    // One screen, no scrolling: strip, then the river, then the panels. Each
    // panel scrolls inside itself, so the wall display never grows a scrollbar.
    return (
      <div className="flex h-full min-h-0 flex-col gap-6">
        {pipelineCards && (
          <div className="grid shrink-0 grid-cols-1 gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <MorningBrief board enabled />
            </div>
            <BudgetRoomCard board enabled budgetSetToday={budgetSetToday} />
          </div>
        )}
        {moneyLine && <div className="shrink-0">{moneyLine}</div>}
        <div className="shrink-0">{balance}</div>
        <div className="shrink-0">
          <StageFlow feed={flow} board trends={pipelineCards} />
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 lg:grid-cols-3">
          <Blockers items={blockers} loading={loading} board />
          <MoneyOut feed={gaps} board limit={3} />
          {pipelineCards && <TodayByDesk board enabled />}
        </div>
        {pipelineCards && (
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 lg:grid-cols-2">
            <WentAgainstTheSystem board enabled />
            <WhyRequestsBounce board enabled />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {pipelineCards && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <MorningBrief board={false} enabled />
          </div>
          <BudgetRoomCard board={false} enabled budgetSetToday={budgetSetToday} />
        </div>
      )}
      {moneyLine}
      {balance}
      <StageFlow feed={flow} board={false} trends={pipelineCards} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Blockers items={blockers} loading={loading} board={false} />
        <MoneyOut feed={gaps} board={false} />
      </div>
      {pipelineCards && (
        <>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <TodayByDesk board={false} enabled />
            <WentAgainstTheSystem board={false} enabled />
          </div>
          <WhyRequestsBounce board={false} enabled />
          <CommandAdditionCards board={false} gaps={gaps} enabled />
        </>
      )}
    </div>
  );
}
