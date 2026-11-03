import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { fmt } from './format';
import type { FeedState, Row } from './useDeskFeed';
import { CALM, FOCUS, statusEdge, statusFill, statusText, type Status } from './deskTheme';
import { Skeleton } from './Skeleton';

/** Which desk each stage belongs to, and the order work flows in. */
const STAGE_DESK: Record<string, string> = {
  '0a': 'coo',
  '0b': 'service-centre',
  '1': 'agent-ops',
  '2': 'tenant-ops',
  '3': 'landlord-ops',
  '4': 'partner-ops',
  '5': 'coo',
  '6': 'cfo',
  '7': 'cfo',
};
const ORDER = ['0a', '0b', '1', '2', '3', '4', '5', '6', '7'];

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

/** Sort into pipeline order, keeping any stage the function adds later at the end. */
function ordered(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => {
    const ia = ORDER.indexOf(String(a.ord));
    const ib = ORDER.indexOf(String(b.ord));
    return (ia === -1 ? ORDER.length : ia) - (ib === -1 ? ORDER.length : ib);
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

/** "N new requests a day come in; the slowest desk clears M a day." */
function flowSentence(rows: Row[]): string | null {
  if (rows.length === 0) return null;
  const entry = rows.find((r) => String(r.ord) === '0b') ?? ordered(rows)[0];
  const neck = bottleneckOf(rows);
  if (!neck) return `${rate(entry?.per_day_7d)} new requests a day come in. Nothing is waiting at any desk.`;
  const where = String(neck.desk ?? neck.stage ?? 'the slowest desk');
  return `${rate(entry?.per_day_7d)} new requests a day come in; the slowest desk, ${where}, clears ${rate(neck.per_day_7d)} a day.`;
}

function Metric({ label, value, tone, size }: { label: string; value: string; tone?: string; size: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 min-w-0">
      <span className={`${size} text-muted-foreground truncate`}>{label}</span>
      <span className={`${size} font-medium tabular-nums ${tone ?? 'text-foreground'}`}>{value}</span>
    </div>
  );
}

function Stage({
  row,
  max,
  isNeck,
  board,
}: {
  row: Row;
  max: number;
  isNeck: boolean;
  board: boolean;
}) {
  const state = stageStatus(row);
  const text = statusText(board);
  const fill = statusFill(board);
  const edge = statusEdge(board);
  const waiting = num(row.waiting) ?? 0;
  const pct = max > 0 ? Math.max(waiting > 0 ? 6 : 2, Math.round((waiting / max) * 100)) : 2;
  const desk = STAGE_DESK[String(row.ord)];

  const name = board ? 'text-sm' : 'text-xs';
  const value = board ? 'text-[40px] leading-none' : 'text-2xl leading-none';
  const meta = board ? 'text-xs' : 'text-[11px]';
  const track = board ? 'h-24' : 'h-14';

  const body = (
    <>
      <div className="flex items-start justify-between gap-1.5 min-w-0">
        <span className={`${name} font-semibold text-foreground leading-snug`}>{String(row.stage ?? '—')}</span>
        <span className={`h-2 w-2 shrink-0 rounded-full mt-1 ${fill[state]}`} aria-hidden />
      </div>

      {isNeck && (
        <span className={`inline-flex w-fit items-center rounded border px-1.5 py-0.5 ${meta} font-semibold ${edge.bad} ${text.bad}`}>
          Bottleneck
        </span>
      )}

      {/* Volume: the bar follows the number waiting. Upright on a wide screen, flat on a phone. */}
      <div className={`hidden md:flex ${track} items-end`} aria-hidden>
        <div className="w-full rounded-sm bg-muted" style={{ height: '100%' }}>
          <div className={`w-full rounded-sm ${fill[state]}`} style={{ height: `${pct}%`, marginTop: `${100 - pct}%` }} />
        </div>
      </div>
      <div className="md:hidden h-2 w-full rounded-sm bg-muted" aria-hidden>
        <div className={`h-full rounded-sm ${fill[state]}`} style={{ width: `${pct}%` }} />
      </div>

      <div className="flex items-baseline gap-1.5">
        <span className={`${value} font-semibold tabular-nums text-foreground`}>{fmt('int', waiting)}</span>
        <span className={`${meta} text-muted-foreground`}>waiting</span>
      </div>

      <div className="space-y-0.5">
        <Metric label="UGX" value={fmt('ugx', row.waiting_ugx ?? 0)} size={meta} />
        <Metric label="Cleared today" value={fmt('int', row.done_24h ?? 0)} size={meta} />
        <Metric label="Per day" value={rate(row.per_day_7d)} size={meta} />
        <Metric
          label="Days to clear"
          value={num(row.days_to_clear) === null ? (waiting > 0 ? 'Not clearing' : '—') : rate(row.days_to_clear)}
          tone={text[state]}
          size={meta}
        />
      </div>
    </>
  );

  const shell = `flex flex-col gap-2 rounded-lg border bg-card ${board ? 'p-4' : 'p-3'} min-w-0 ${edge[state]}`;

  return desk ? (
    <Link to={`/desk/${desk}`} className={`${shell} ${CALM} ${FOCUS} hover:bg-muted/40`} aria-label={`${String(row.stage)} — open the ${desk} desk`}>
      {body}
    </Link>
  ) : (
    <div className={shell}>{body}</div>
  );
}

export function StageFlow({ feed, board }: { feed: FeedState; board: boolean }) {
  const rows = ordered(feed.rows);
  const sentence = flowSentence(feed.rows);
  const neck = bottleneckOf(feed.rows);
  const max = Math.max(1, ...rows.map((r) => num(r.waiting) ?? 0));

  if (feed.loading) {
    return (
      <section className="space-y-3" aria-busy>
        <Skeleton className={`${board ? 'h-9' : 'h-6'} w-full max-w-3xl`} />
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-5 xl:grid-cols-9">
          {Array.from({ length: 9 }, (_, i) => (
            <Skeleton key={i} className={board ? 'h-72' : 'h-52'} />
          ))}
        </div>
      </section>
    );
  }

  if (feed.error) {
    return (
      <section className={`rounded-lg border bg-card p-5 space-y-1 ${statusEdge(board).bad}`} role="alert">
        <h2 className={`font-semibold ${statusText(board).bad}`}>The stage flow could not load</h2>
        <p className="text-sm text-muted-foreground">{feed.error}</p>
        <p className="text-sm text-muted-foreground">
          Use “Refresh now” above. If it keeps failing, tell the COO office — the desks below still work.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-3 min-w-0">
      <div className="space-y-1">
        <h2 className={`${board ? 'text-3xl' : 'text-lg sm:text-xl'} font-semibold leading-snug text-foreground max-w-5xl`}>
          {sentence ?? 'No stages are reporting yet.'}
        </h2>
        <p className={`${board ? 'text-sm' : 'text-xs'} text-muted-foreground`}>
          Rates are 7-day averages. Red is over 2 days to clear, amber over 1 — thresholds are assumptions until the desk
          leads agree them.
        </p>
      </div>

      {/* The pipeline, left to right. On a phone it stacks. */}
      <div className="flex flex-col gap-2 md:flex-row md:items-stretch md:gap-0 md:overflow-x-auto md:pb-1">
        {rows.map((row, i) => (
          <div key={String(row.ord ?? i)} className="flex min-w-0 md:flex-1 md:items-center">
            <div className="min-w-0 flex-1 md:min-w-[138px]">
              <Stage row={row} max={max} isNeck={!!neck && String(neck.ord) === String(row.ord)} board={board} />
            </div>
            {i < rows.length - 1 && (
              <ChevronRight className="hidden md:block h-4 w-4 shrink-0 text-muted-foreground/50 mx-0.5" aria-hidden />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
