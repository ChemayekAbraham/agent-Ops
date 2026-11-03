import { Link } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { fmt } from './format';
import type { FeedState, Row } from './useDeskFeed';

/** The pipeline stages that have a desk behind them, in the order work flows. */
const CARDS: { ord: string; label: string; desk: string }[] = [
  { ord: '0b', label: 'Service Centre', desk: 'service-centre' },
  { ord: '1', label: 'Agent Ops', desk: 'agent-ops' },
  { ord: '2', label: 'Tenant Ops', desk: 'tenant-ops' },
  { ord: '3', label: 'Landlord Ops', desk: 'landlord-ops' },
  { ord: '4', label: 'Partner Ops', desk: 'partner-ops' },
  { ord: '5', label: 'COO approval', desk: 'coo' },
  { ord: '6', label: 'CFO funding', desk: 'cfo' },
  { ord: '7', label: 'Landlord payment', desk: 'cfo' },
];

const num = (v: unknown): number | null =>
  v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v);

type Health = 'red' | 'amber' | 'green' | 'none';

/** Thresholds are assumptions until the desk leads agree them. */
function health(row: Row | undefined): Health {
  if (!row) return 'none';
  if ((num(row.n) ?? 0) === 0) return 'green';
  const oldest = num(row.oldest_days);
  const median = num(row.median_days);
  if (oldest !== null && oldest > 2) return 'red';
  if (median !== null && median > 1) return 'amber';
  return 'green';
}

const dotClass: Record<Health, string> = {
  red: 'bg-red-600',
  amber: 'bg-amber-500',
  green: 'bg-emerald-600',
  none: 'bg-muted-foreground/40',
};
const edgeClass: Record<Health, string> = {
  red: 'border-red-600/40',
  amber: 'border-amber-600/40',
  green: 'border-emerald-600/30',
  none: 'border-border',
};

/** Short sentences, each naming the desk that has to act. */
function blockerLines(pipeline: Row[], kpis: Row[]): string[] {
  const out: string[] = [];
  const budgetRow = kpis.find((r) => String(r.metric) === 'budget_today_ugx');
  if (num(budgetRow?.value) === null) {
    const coo = pipeline.find((r) => String(r.ord) === '5');
    out.push(
      `CFO has not set today's float budget: ${fmt('int', coo?.n ?? 0)} requests worth ${fmt('ugx', coo?.ugx ?? 0)} are stopped at the COO step.`,
    );
  }
  pipeline
    .filter((r) => String(r.ord) !== '0a' && (num(r.n) ?? 0) > 0 && num(r.oldest_days) !== null)
    .sort((a, b) => (num(b.oldest_days) ?? 0) - (num(a.oldest_days) ?? 0))
    .slice(0, 3)
    .forEach((r) => {
      out.push(
        `${r.stage ?? 'A stage'}: the oldest has waited ${fmt('days', r.oldest_days)} days — ${fmt('int', r.n)} waiting worth ${fmt('ugx', r.ugx)}, ${r.desk ?? 'the desk'} acts next.`,
      );
    });
  return out;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-sm font-medium tabular-nums text-foreground truncate">{value}</div>
    </div>
  );
}

export function CommandCentre({ feeds }: { feeds: Record<string, FeedState> }) {
  const pipeline = feeds.pipeline?.rows ?? [];
  const kpis = feeds.coo_kpis?.rows ?? [];
  const care = feeds.cc_owners?.rows ?? [];
  const loading = Boolean(feeds.pipeline?.loading || feeds.coo_kpis?.loading);
  const byOrd = new Map(pipeline.map((r) => [String(r.ord), r]));
  const held = byOrd.get('0a');
  const lines = loading ? [] : blockerLines(pipeline, kpis);

  const careOpen = care.reduce((t, r) => t + (num(r.open_concerns) ?? 0), 0);
  const careOverdue = care.reduce((t, r) => t + (num(r.overdue) ?? 0), 0);
  const careOldest = care.reduce((t, r) => Math.max(t, num(r.oldest_days) ?? 0), 0);
  const careHealth: Health =
    feeds.cc_owners?.loading || care.length === 0
      ? 'none'
      : careOldest > 2
        ? 'red'
        : careOverdue > 0
          ? 'amber'
          : 'green';

  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-border bg-card p-4 sm:p-5 space-y-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-hidden />
          <h2 className="text-base font-semibold text-foreground">Today&rsquo;s blockers</h2>
        </div>
        {loading && <p className="text-sm text-muted-foreground">Loading live data.</p>}
        {!loading && lines.length === 0 && (
          <p className="text-sm text-muted-foreground">Nothing is blocked. Every stage is inside its waiting time.</p>
        )}
        {!loading && lines.length > 0 && (
          <ul className="space-y-2">
            {lines.map((line) => (
              <li key={line} className="flex gap-2 text-sm leading-snug text-foreground">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          The held August 2026 batch is listed with the desks below, not here.
        </p>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 className="text-base font-semibold text-foreground">Every desk right now</h2>
          <p className="text-xs text-muted-foreground max-w-xl">
            Red is an oldest wait over 2 days, amber a median over 1 day. Both thresholds are assumptions until the desk
            leads agree them.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {CARDS.map((card) => {
            const row = byOrd.get(card.ord);
            const state: Health = loading ? 'none' : health(row);
            return (
              <Link
                key={card.ord}
                to={`/desk/${card.desk}`}
                className={`block rounded-lg border bg-card p-4 space-y-3 transition-colors hover:bg-muted/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${edgeClass[state]}`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass[state]}`} aria-hidden />
                  <span className="text-sm font-semibold text-foreground truncate">{card.label}</span>
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-semibold tabular-nums text-foreground">{fmt('int', row?.n ?? 0)}</span>
                  <span className="text-xs text-muted-foreground">waiting</span>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <Stat label="UGX" value={fmt('ugx', row?.ugx ?? 0)} />
                  <Stat label="Median days" value={fmt('days', row?.median_days)} />
                  <Stat label="Oldest days" value={fmt('days', row?.oldest_days)} />
                </div>
              </Link>
            );
          })}

          <Link
            to="/desk/customer-care"
            className={`block rounded-lg border bg-card p-4 space-y-3 transition-colors hover:bg-muted/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${edgeClass[careHealth]}`}
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass[careHealth]}`} aria-hidden />
              <span className="text-sm font-semibold text-foreground truncate">Customer Care</span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-semibold tabular-nums text-foreground">{fmt('int', careOpen)}</span>
              <span className="text-xs text-muted-foreground">open concerns</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Overdue" value={fmt('int', careOverdue)} />
              <Stat label="Oldest days" value={care.length ? fmt('days', careOldest) : '—'} />
              <Stat label="Owners" value={fmt('int', care.length)} />
            </div>
          </Link>

          {held && (
            <div className="rounded-lg border border-dashed border-border bg-muted/30 p-4 space-y-3">
              <div className="flex items-center gap-2 min-w-0">
                <span className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/40" aria-hidden />
                <span className="text-sm font-semibold text-muted-foreground truncate">Held for COO decision</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-semibold tabular-nums text-muted-foreground">{fmt('int', held.n)}</span>
                <span className="text-xs text-muted-foreground">August 2026 batch</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Stat label="UGX" value={fmt('ugx', held.ugx)} />
                <Stat label="Median days" value={fmt('days', held.median_days)} />
                <Stat label="Oldest days" value={fmt('days', held.oldest_days)} />
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
