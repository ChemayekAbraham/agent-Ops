import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { fmt } from './format';
import type { FeedState, Row } from './useDeskFeed';
import { CALM, CAPSULE, FIGURE, FOCUS, LABEL, PANEL, statusDot, statusEdge, statusGlass, statusText, type Status } from './deskTheme';
import { DESKS } from './deskConfig';
import { CountUp } from './CountUp';
import { Skeleton } from './Skeleton';
import { useStageTrend, type StageTrend } from './deskBriefApi';

/** The first stage is intake — requests arriving — not a queue anyone works. */
export const INTAKE_ORD = '0';

/** Stages name a desk by its route slug; these are the ones that have a page. */
const DESK_PAGE = new Map(DESKS.filter((d) => d.id !== 'command').map((d) => [d.id, d.name]));

/** The desk that acts on a stage, by the name people use for it — never a slug. */
export function actingDesk(row: Row): string {
  return DESK_PAGE.get(String(row.desk)) ?? String(row.stage ?? 'the next desk');
}

/** The desk page a stage opens, or null when no desk owns it (intake). */
function stageRoute(row: Row): string | null {
  const desk = String(row.desk ?? '');
  return DESK_PAGE.has(desk) ? desk : null;
}

const num = (v: unknown): number | null =>
  v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v);
const rate = (v: unknown): string => {
  const n = num(v);
  return n === null ? '—' : n.toFixed(1);
};

/** Days to clear drives the colour. Thresholds are assumptions until the desk leads agree them. */
function stageStatus(row: Row): Status {
  if ((num(row.waiting) ?? 0) === 0) return 'ok';
  const d = num(row.days_to_clear);
  if (d === null) return 'bad';
  if (d > 2) return 'bad';
  if (d > 1) return 'warn';
  return 'ok';
}

/** Pipeline order: ord ascending, so Submitted leads and Landlord paid closes. */
export function ordered(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => {
    const na = num(a.ord);
    const nb = num(b.ord);
    if (na !== null && nb !== null) return na - nb;
    return String(a.ord ?? '').localeCompare(String(b.ord ?? ''));
  });
}

/** The stage that would take longest to clear. Nothing clearing at all outranks a slow queue. */
function bottleneckOf(rows: Row[]): Row | null {
  const waiting = rows.filter((r) => (num(r.waiting) ?? 0) > 0);
  if (waiting.length === 0) return null;
  return waiting.reduce((worst, r) => {
    const a = num(r.days_to_clear) ?? Number.POSITIVE_INFINITY;
    const b = num(worst.days_to_clear) ?? Number.POSITIVE_INFINITY;
    return a > b ? r : worst;
  });
}

/**
 * "N new requests a day come in; the slowest stage, Tenant Ops, clears M a day."
 *
 * N is intake — how fast work arrives — so it always comes from the Submitted
 * stage, never from whichever stage happens to be the bottleneck.
 */
function flowSentence(rows: Row[]): string | null {
  if (rows.length === 0) return null;
  const entry = rows.find((r) => String(r.ord) === INTAKE_ORD) ?? ordered(rows)[0];
  const neck = bottleneckOf(rows);
  if (!neck) return `${rate(entry?.per_day_7d)} new requests a day come in. Nothing is waiting at any desk.`;
  return `${rate(entry?.per_day_7d)} new requests a day come in; the slowest stage, ${String(
    neck.stage ?? 'the slowest stage',
  )}, clears ${rate(neck.per_day_7d)} a day.`;
}

/** Particle speed follows the stage's throughput. Nothing moving means no particles at all. */
function particleSeconds(perDay: unknown): number | null {
  const n = num(perDay);
  if (n === null || n <= 0) return null;
  return Math.min(9, Math.max(1.2, 45 / n));
}

function Connector({ seconds }: { seconds: number | null }) {
  return (
    <>
      <div
        className="relative hidden md:block h-[2px] w-8 shrink-0 self-center overflow-hidden rounded-full bg-[hsl(var(--primary)/0.25)]"
        aria-hidden
      >
        {seconds !== null &&
          [0, 1].map((i) => (
            <span
              key={i}
              className="desk-particle absolute top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-[hsl(var(--primary))]"
              style={{
                animationDuration: `${seconds}s`,
                animationDelay: `${(seconds / 2) * i}s`,
                boxShadow: '0 0 10px 3px hsl(var(--primary) / 0.85)',
              }}
            />
          ))}
      </div>
      <div className="md:hidden mx-auto h-4 w-[2px] shrink-0 rounded-full bg-[hsl(var(--primary)/0.25)]" aria-hidden />
    </>
  );
}

/** A labelled row inside a capsule: name on the left, figure right-aligned. Labels are never shortened. */
function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 min-w-0">
      <span className={`${LABEL} truncate`}>{label}</span>
      <span className={`shrink-0 text-[13px] font-medium tabular-nums ${tone ?? 'text-[hsl(var(--desk-lavender))]'}`}>
        {value}
      </span>
    </div>
  );
}

/**
 * The 24-hour trend on a stage.
 *
 * Up means the queue grew, which is bad however fast the desk is working, so
 * up is red and down is green — the opposite of a revenue chart, and the
 * reason the direction is always spelled out in words for a screen reader.
 * No comparison point yet is its own state: no arrow, and a tooltip saying so,
 * rather than a misleading "no change".
 */
function Trend({ t, board }: { t: StageTrend | undefined; board: boolean }) {
  const size = board ? 'text-sm' : 'text-xs';

  if (!t || t.arrow === 'none' || t.change === null || t.change === undefined) {
    return (
      <span className={`${size} shrink-0 text-muted-foreground`} title="no 24h data yet">
        —<span className="sr-only">no 24 hour data yet</span>
      </span>
    );
  }

  if (t.arrow === 'flat' || t.change === 0) {
    return <span className={`${size} shrink-0 text-muted-foreground`}>no change</span>;
  }

  const up = t.arrow === 'up';
  const n = Math.abs(t.change);
  const Icon = up ? ArrowUp : ArrowDown;

  return (
    <span
      className={`${size} inline-flex shrink-0 items-center gap-0.5 font-medium tabular-nums ${
        up ? statusText.bad : statusText.ok
      }`}
      title={`${up ? 'More' : 'Fewer'} waiting than 24 hours ago`}
    >
      <Icon className={board ? 'h-4 w-4' : 'h-3.5 w-3.5'} aria-hidden />
      {up ? '+' : '−'}
      {fmt('int', n)}
      <span className="sr-only">{up ? ' more than 24 hours ago' : ' fewer than 24 hours ago'}</span>
    </span>
  );
}

function Capsule({ row, isNeck, board, trend }: { row: Row; isNeck: boolean; board: boolean; trend?: StageTrend }) {
  const intake = String(row.ord) === INTAKE_ORD;
  const state = stageStatus(row);
  const waiting = num(row.waiting) ?? 0;
  const route = stageRoute(row);
  const figure = board ? 'text-[52px] leading-none' : 'text-[40px] leading-none';

  const body = (
    <>
      <div className="flex items-start justify-between gap-2 min-w-0">
        <span className={`${board ? 'text-sm' : 'text-xs'} min-w-0 truncate font-semibold text-foreground`}>
          {String(row.stage ?? '—')}
        </span>
        {/* Intake has no queue to be late, so it carries no status dot. */}
        {!intake && <span className={`h-2 w-2 shrink-0 rounded-full mt-1 ${statusDot[state]}`} aria-hidden />}
      </div>

      {isNeck && (
        <span className={`desk-pill inline-flex w-fit items-center border px-2 py-0.5 text-[11px] font-semibold ${statusGlass.bad}`}>
          Bottleneck
        </span>
      )}

      {intake ? (
        <>
          <div className="flex items-baseline gap-2">
            <CountUp value={num(row.done_24h) ?? 0} format={(n) => fmt('int', n)} className={`${FIGURE} ${figure}`} />
            <span className={LABEL}>today</span>
          </div>
          <div className="space-y-1">
            <Metric label="Arriving" value={`${rate(row.per_day_7d)} a day`} />
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <CountUp value={waiting} format={(n) => fmt('int', n)} className={`${FIGURE} ${figure}`} />
            <span className={LABEL}>waiting</span>
            <Trend t={trend} board={board} />
          </div>
          <div className="space-y-1">
            <Metric label="UGX" value={fmt('ugx', row.waiting_ugx ?? 0)} />
            <Metric label="Cleared today" value={fmt('int', row.done_24h ?? 0)} />
            <Metric
              label="Days to clear"
              value={num(row.days_to_clear) === null ? (waiting > 0 ? 'Not clearing' : '—') : rate(row.days_to_clear)}
              tone={statusText[state]}
            />
          </div>
        </>
      )}
    </>
  );

  const shell = `${CAPSULE} flex min-w-0 flex-1 flex-col gap-2.5 ${board ? 'p-5' : 'p-4'} ${
    isNeck ? `desk-bottleneck ${statusEdge.bad}` : ''
  }`;

  return route ? (
    <Link
      to={`/desk/${route}`}
      className={`${shell} ${CALM} ${FOCUS} hover:bg-[var(--desk-surface-hover)]`}
      aria-label={`${String(row.stage)} — open the ${actingDesk(row)} desk`}
    >
      {body}
    </Link>
  ) : (
    <div className={shell}>{body}</div>
  );
}

/** Red, amber, green in one line, so nobody has to guess what a dot means. */
function Legend() {
  return (
    <p className={LABEL}>
      <span className={statusText.bad}>Red</span>: over 2 days to clear.{' '}
      <span className={statusText.warn}>Amber</span>: over 1 day. <span className={statusText.ok}>Green</span>: on time.
    </p>
  );
}

export function StageFlow({ feed, board, trends }: { feed: FeedState; board: boolean; trends?: boolean }) {
  const rows = ordered(feed.rows);
  const sentence = flowSentence(feed.rows);
  const neck = bottleneckOf(feed.rows);
  // Stage-flow `ord` and trend `stage_ord` are the same scale ('1' Service
  // Centre … '8' Landlord paid), so the two line up without a lookup table.
  const trend = useStageTrend(!!trends);

  if (feed.loading) {
    return (
      <section className="space-y-4" aria-busy>
        <Skeleton className={`${board ? 'h-10' : 'h-7'} w-full max-w-3xl`} />
        <div className="desk-river">
          {Array.from({ length: 9 }, (_, i) => (
            <div key={i} className="desk-river-unit">
              <Skeleton className={`w-full ${board ? 'h-60' : 'h-48'}`} />
            </div>
          ))}
        </div>
      </section>
    );
  }

  if (feed.error) {
    return (
      <section className={`${PANEL} p-5 space-y-1 ${statusEdge.bad}`} role="alert">
        <h2 className={`font-semibold ${statusText.bad}`}>The stage flow could not load</h2>
        <p className="text-sm text-muted-foreground">{feed.error}</p>
        <p className="text-sm text-muted-foreground">
          Use “Refresh now” above. If it keeps failing, tell the COO office — the desks below still work.
        </p>
      </section>
    );
  }

  // Where the river folds when the whole pipeline will not fit on one line:
  // after Partner Ops, so COO approval starts the second row.
  const foldAfter = rows.findIndex((r) => String(r.ord) === '5');

  return (
    <section className="space-y-4 min-w-0">
      <div className="space-y-1.5">
        <h2 className={`${board ? 'text-3xl' : 'text-lg sm:text-xl'} font-semibold leading-snug text-foreground max-w-5xl`}>
          {sentence ?? 'No stages are reporting yet.'}
        </h2>
        <Legend />
        <p className={LABEL}>
          Rates are 7-day averages. The thresholds are assumptions until the desk leads agree them.
        </p>
      </div>

      {/* The river, left to right. It folds into two rows on a laptop and stacks on a phone. */}
      <div className="desk-river">
        {rows.map((row, i) => (
          <Fragment key={String(row.ord ?? i)}>
            <div className="desk-river-unit">
              <Capsule
                row={row}
                isNeck={!!neck && String(neck.ord) === String(row.ord)}
                board={board}
                trend={trends ? trend.byOrd.get(String(row.ord)) : undefined}
              />
              {i < rows.length - 1 && <Connector seconds={particleSeconds(row.per_day_7d)} />}
            </div>
            {i === foldAfter && i < rows.length - 1 && <span className="desk-river-break" aria-hidden />}
          </Fragment>
        ))}
      </div>
    </section>
  );
}
