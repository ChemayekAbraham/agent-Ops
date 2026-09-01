import { formatUGX } from '@/lib/rentCalculations';
import type { TppoZoneAReport } from '@/components/tenant-ops/tppo/tppoTypes';

interface HeadlineA1Props {
  report?: TppoZoneAReport | null;
}


/**
 * A1 · HEADLINE. Every figure is rendered as supplied by tppo_get_report_zone_a;
 * no rate, percentage or variance is computed here.
 */
export function HeadlineA1({ report }: HeadlineA1Props) {
  const collected = report?.collected_ugx ?? null;
  const collectedTotal = report?.collected_total_ugx ?? null;
  const arrearsRecovered = report?.arrears_recovered_ugx ?? null;
  const unallocated = report?.unallocated_ugx ?? null;
  const cohortCount = report?.cohort_plan_count ?? null;
  const arrearsCount = report?.arrears_plan_count ?? null;
  const scheduled = report?.scheduled_due_ugx ?? null;
  const rate = report?.collection_rate_pct ?? null;
  const threshold = report?.threshold_pct ?? null;
  const below = report?.below_threshold ?? null;
  const provisional = report?.provisional === true;

  const hasRate = rate !== null && rate !== undefined;
  const atOrAbove = hasRate && below === false;

  return (
    <section aria-label="A1 headline" className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-2xl font-semibold tabular-nums text-foreground">
          {collected === null ? '—' : formatUGX(collected)}
        </span>

        <span className="text-xl font-medium tabular-nums text-foreground">
          {hasRate ? `${rate.toFixed(1)}%` : '—'}
        </span>

        <span
          aria-hidden="true"
          className={
            'inline-block h-2.5 w-2.5 shrink-0 rounded-full ' +
            (!hasRate ? 'bg-muted-foreground' : atOrAbove ? 'bg-emerald-600' : 'bg-destructive')
          }
        />

        <span className="text-sm font-medium text-foreground">
          {!hasRate
            ? 'no rent scheduled in this period'
            : atOrAbove
              ? 'at or above threshold'
              : 'below threshold'}
        </span>
      </div>

      <div className="mt-2 space-y-1 text-sm text-muted-foreground">
        <p>
          {`of ${scheduled === null ? '—' : formatUGX(scheduled)} scheduled`}
          {provisional && (
            <span className="ml-2 text-foreground">provisional — period still open</span>
          )}
        </p>
        <p>{threshold === null ? 'threshold —' : `threshold ${threshold.toFixed(1)}%`}</p>
      </div>
    </section>
  );
}

export default HeadlineA1;
