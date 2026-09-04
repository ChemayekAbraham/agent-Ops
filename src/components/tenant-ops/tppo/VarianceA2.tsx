import { ArrowDown, ArrowRight, ArrowUp, Minus } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import type { TppoZoneAReport } from '@/components/tenant-ops/tppo/tppoTypes';

interface VarianceA2Props {
  report?: TppoZoneAReport | null;
  /** One period older than `report.prior` — same RPC, anchored a period earlier. */
  earlier?: TppoZoneAReport | null;
}

function shortDate(iso?: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

function periodLabel(start?: string | null, end?: string | null): string {
  if (!start) return '—';
  if (!end || end === start) return shortDate(start);
  return `${shortDate(start)} – ${shortDate(end)}`;
}

function rateText(value?: number | null): string {
  return value === null || value === undefined ? '—' : `${value.toFixed(1)}%`;
}

function signedMoney(value?: number | null): string {
  if (value === null || value === undefined) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${formatUGX(Math.abs(value))}`;
}

function signedPp(value?: number | null): string {
  if (value === null || value === undefined) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${Math.abs(value).toFixed(1)} pp`;
}

/**
 * A2 · VARIANCE ON PRIOR PERIOD. Every figure — including the variance itself —
 * is taken straight from tppo_get_report_zone_a. Nothing is computed here.
 */
export function VarianceA2({ report, earlier }: VarianceA2Props) {
  const variance = report?.rate_variance_pp ?? null;
  const hasVariance = variance !== null && variance !== undefined;
  const direction = !hasVariance ? 'none' : variance > 0 ? 'up' : variance < 0 ? 'down' : 'flat';

  const DirectionIcon =
    direction === 'up' ? ArrowUp : direction === 'down' ? ArrowDown : Minus;

  const directionClass =
    direction === 'up'
      ? 'text-emerald-600'
      : direction === 'down'
        ? 'text-destructive'
        : 'text-muted-foreground';

  const directionLabel =
    direction === 'up'
      ? 'up on prior period'
      : direction === 'down'
        ? 'down on prior period'
        : direction === 'flat'
          ? 'unchanged on prior period'
          : 'no comparison available';

  const currentLabel = periodLabel(report?.period_start, report?.period_end);
  const priorLabel = periodLabel(report?.prior?.period_start, report?.prior?.period_end);

  return (
    <section aria-label="A2 variance on prior period" className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Variance on prior period
      </h3>

      <div className={`mt-2 flex flex-wrap items-center gap-2 ${directionClass}`}>
        <DirectionIcon className="h-5 w-5 shrink-0" aria-hidden="true" />
        <span className="text-xl font-semibold tabular-nums">{signedPp(variance)}</span>
        <span className="text-sm font-medium">{directionLabel}</span>
      </div>

      <div className="mt-3 space-y-1">
        <p className="flex flex-wrap items-center gap-2 text-sm text-foreground">
          <span>{priorLabel}</span>
          <span className="tabular-nums">{rateText(report?.prior?.collection_rate_pct)}</span>
          <ArrowRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <span>{currentLabel}</span>
          <span className="tabular-nums">{rateText(report?.collection_rate_pct)}</span>
        </p>
        <p className="text-xs text-muted-foreground">each on its own period&apos;s schedule</p>
      </div>

      {/* Mobile: the same three rows stacked, so nothing is clipped at 360px. */}
      <div className="mt-4 space-y-3 sm:hidden">
        <div className="rounded-md border border-border/60 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{priorLabel}</p>
          <div className="mt-2 space-y-1 text-sm">
            <p className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground">Scheduled due (own period)</span>
              <span className="shrink-0 tabular-nums">
                {report?.prior?.scheduled_due_ugx === null || report?.prior?.scheduled_due_ugx === undefined
                  ? '—'
                  : formatUGX(report.prior.scheduled_due_ugx)}
              </span>
            </p>
            <p className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground">Collected</span>
              <span className="shrink-0 tabular-nums">
                {report?.prior?.collected_ugx === null || report?.prior?.collected_ugx === undefined
                  ? '—'
                  : formatUGX(report.prior.collected_ugx)}
              </span>
            </p>
            <p className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground">Rate</span>
              <span className="shrink-0 tabular-nums">{rateText(report?.prior?.collection_rate_pct)}</span>
            </p>
          </div>
        </div>

        <div className="rounded-md border border-border/60 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{currentLabel}</p>
          <div className="mt-2 space-y-1 text-sm">
            <p className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground">Scheduled due (own period)</span>
              <span className="shrink-0 tabular-nums">
                {report?.scheduled_due_ugx === null || report?.scheduled_due_ugx === undefined
                  ? '—'
                  : formatUGX(report.scheduled_due_ugx)}
              </span>
            </p>
            <p className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground">Collected</span>
              <span className="shrink-0 tabular-nums">
                {report?.collected_ugx === null || report?.collected_ugx === undefined
                  ? '—'
                  : formatUGX(report.collected_ugx)}
              </span>
            </p>
            <p className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground">Rate</span>
              <span className="shrink-0 tabular-nums">{rateText(report?.collection_rate_pct)}</span>
            </p>
          </div>
        </div>

        <div className="rounded-md border border-border p-3 font-medium">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Increase / decrease</p>
          <div className="mt-2 space-y-1 text-sm">
            <p className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground">Scheduled due (own period)</span>
              <span className="shrink-0 tabular-nums">{signedMoney(report?.scheduled_delta_ugx)}</span>
            </p>
            <p className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground">Collected</span>
              <span className="shrink-0 tabular-nums">{signedMoney(report?.collected_delta_ugx)}</span>
            </p>
            <p className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground">Rate</span>
              <span className="shrink-0 tabular-nums">{signedPp(variance)}</span>
            </p>
          </div>
        </div>
      </div>

      <div className="mt-4 hidden overflow-x-auto sm:block">

        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="py-2 pr-3 font-medium">Period</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">Scheduled due (own period)</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">Collected</th>
              <th scope="col" className="py-2 text-right font-medium">Rate</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border/60">
              <td className="py-2 pr-3">{priorLabel}</td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {report?.prior?.scheduled_due_ugx === null || report?.prior?.scheduled_due_ugx === undefined
                  ? '—'
                  : formatUGX(report.prior.scheduled_due_ugx)}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {report?.prior?.collected_ugx === null || report?.prior?.collected_ugx === undefined
                  ? '—'
                  : formatUGX(report.prior.collected_ugx)}
              </td>
              <td className="py-2 text-right tabular-nums">{rateText(report?.prior?.collection_rate_pct)}</td>
            </tr>
            <tr className="border-b border-border/60">
              <td className="py-2 pr-3">{currentLabel}</td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {report?.scheduled_due_ugx === null || report?.scheduled_due_ugx === undefined
                  ? '—'
                  : formatUGX(report.scheduled_due_ugx)}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {report?.collected_ugx === null || report?.collected_ugx === undefined
                  ? '—'
                  : formatUGX(report.collected_ugx)}
              </td>
              <td className="py-2 text-right tabular-nums">{rateText(report?.collection_rate_pct)}</td>
            </tr>
            <tr className="font-medium">
              <td className="py-2 pr-3">Increase / decrease</td>
              <td className="py-2 pr-3 text-right tabular-nums">{signedMoney(report?.scheduled_delta_ugx)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{signedMoney(report?.collected_delta_ugx)}</td>
              <td className="py-2 text-right tabular-nums">{signedPp(variance)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default VarianceA2;
