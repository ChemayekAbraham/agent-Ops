import { Link } from 'react-router-dom';
import { fmt } from './format';
import type { FeedState, Row } from './useDeskFeed';
import { CALM, FIGURE, FOCUS, PANEL, statusEdge, statusGlass, statusText, type Status } from './deskTheme';
import { CountUp } from './CountUp';
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
        className="relative hidden md:block h-[2px] w-8 shrink-0 self-center overflow-hidden rounded-full"
        style={{ background: 'linear-gradient(90deg, hsl(var(--primary)/0.12), hsl(var(--primary)/0.45), hsl(var(--primary)/0.12))' }}
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
                boxShadow: '0 0 8px 2px hsl(var(--primary) / 0.7)',
              }}
            />
          ))}
      </div>
      <div
        className="md:hidden mx-auto h-4 w-[2px] shrink-0 rounded-full"
        style={{ background: 'linear-gradient(180deg, hsl(var(--primary)/0.45), hsl(var(--primary)/0.12))' }}
        aria-hidden
      />
    </>
  );
}

function Metric({ label, value, tone, size }: { label: string; value: string; tone?: string; size: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 min-w-0">
      <span className={`${size} text-muted-foreground truncate`}>{label}</span>
      <span className={`${size} font-medium tabular-nums ${tone ?? 'text-[hsl(var(--desk-lavender))]'}`}>{value}</span>
    </div>
  );
}

function Capsule({ row, isNeck, board }: { row: Row; isNeck: boolean; board: boolean }) {
  const state = stageStatus(row);
  const waiting = num(row.waiting) ?? 0;
  const desk = STAGE_DESK[String(row.ord)];
  const meta = board ? 'text-xs' : 'text-[11px]';
  const figure = board ? 'text-[52px] leading-none' : 'text-[40px] leading-none';

  const body = (
    <>
      <div className="flex items-start justify-between gap-1.5 min-w-0">
        <span className={`${board ? 'text-sm' : 'text-xs'} font-semibold text-foreground leading-snug`}>
          {String(row.stage ?? '—')}
        </span>
        <span className={`h-2 w-2 shrink-0 rounded-full mt-1 ${statusText[state]} bg-current`} aria-hidden />
      </div>

      {isNeck && (
        <span className={`desk-pill inline-flex w-fit items-center border px-2 py-0.5 ${meta} font-semibold ${statusGlass.bad}`}>
          Bottleneck
        </span>
      )}

      <div className="flex items-baseline gap-1.5">
        <CountUp value={waiting} format={(n) => fmt('int', n)} className={`${FIGURE} ${figure}`} />
        <span className={`${meta} text-muted-foreground`}>waiting</span>
      </div>

      <div className="space-y-0.5">
        <Metric label="UGX" value={fmt('ugx', row.waiting_ugx ?? 0)} size={meta} />
        <Metric label="Cleared today" value={fmt('int', row.done_24h ?? 0)} size={meta} />
        <Metric
          label="Days to clear"
          value={num(row.days_to_clear) === null ? (waiting > 0 ? 'Not clearing' : '—') : rate(row.days_to_clear)}
          tone={statusText[state]}
          size={meta}
        />
      </div>
    </>
  );

  const shell = `${PANEL} flex flex-col gap-2 ${board ? 'p-4' : 'p-3'} min-w-0 ${
    isNeck ? `desk-bottleneck ${statusEdge.bad}` : ''
  }`;

  return desk ? (
    <Link
      to={`/desk/${desk}`}
      className={`${shell} ${CALM} ${FOCUS} hover:bg-white/10`}
      aria-label={`${String(row.stage)} — open the ${desk} desk`}
    >
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

  if (feed.loading) {
    return (
      <section className="space-y-3" aria-busy>
        <Skeleton className={`${board ? 'h-10' : 'h-7'} w-full max-w-3xl`} />
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-5 xl:grid-cols-9">
          {Array.from({ length: 9 }, (_, i) => (
            <Skeleton key={i} className={board ? 'h-60' : 'h-48'} />
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

  return (
    <section className="space-y-3 min-w-0">
      <div className="space-y-1">
        <h2 className={`${board ? 'text-3xl' : 'text-lg sm:text-xl'} font-semibold leading-snug text-foreground max-w-5xl`}>
          {sentence ?? 'No stages are reporting yet.'}
        </h2>
        <p className={`${board ? 'text-sm' : 'text-xs'} text-muted-foreground`}>
          Rates are 7-day averages. Rose is over 2 days to clear, amber over 1 — thresholds are assumptions until the
          desk leads agree them.
        </p>
      </div>

      {/* The river, left to right. On a phone it stacks. */}
      <div className="flex flex-col md:flex-row md:items-stretch">
        {rows.map((row, i) => (
          <div key={String(row.ord ?? i)} className="flex flex-col md:flex-row min-w-0 md:flex-1 md:items-stretch">
            <div className="min-w-0 md:flex-1">
              <Capsule row={row} isNeck={!!neck && String(neck.ord) === String(row.ord)} board={board} />
            </div>
            {i < rows.length - 1 && <Connector seconds={particleSeconds(row.per_day_7d)} />}
          </div>
        ))}
      </div>
    </section>
  );
}
