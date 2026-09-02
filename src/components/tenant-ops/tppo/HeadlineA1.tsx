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
      <div className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-x-3 sm:gap-y-1">
        <span className="break-words text-2xl font-semibold tabular-nums text-foreground">
          {collected === null ? '—' : formatUGX(collected)}
        </span>

        <span className="text-xl font-medium tabular-nums text-foreground">
          {hasRate ? `${rate.toFixed(1)}%` : '—'}
        </span>

        <span className="flex items-center gap-2">
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

      <div className="mt-4 space-y-1 border-t border-border pt-3 text-sm text-muted-foreground">
        <p>
          <span className="text-foreground">total rent recovered this period</span>
          {' — '}
          {collectedTotal === null ? '—' : formatUGX(collectedTotal)}
        </p>
        <p>
          <span className="text-foreground">of which counted in the rate</span>
          {' — '}
          {collected === null ? '—' : formatUGX(collected)}
          {cohortCount !== null && ` across ${cohortCount} funded tenancies within term`}
        </p>
        <p>
          <span className="text-foreground">arrears recovered on completed terms</span>
          {' — '}
          {arrearsRecovered === null ? '—' : formatUGX(arrearsRecovered)}
          {arrearsCount !== null && ` across ${arrearsCount} funded tenancies past term`}
        </p>
        {unallocated !== null && unallocated > 0 && (
          <p>
            <span className="text-foreground">unattributed</span>
            {' — '}
            {formatUGX(unallocated)}
            <span className="ml-1">not matched to a funded tenancy</span>
          </p>
        )}
        <p className="pt-2 text-xs italic">
          The headline rate is measured only on rent scheduled and recovered within term; arrears
          recovery is reported beside it, not inside it.
        </p>
      </div>
    </section>
  );
}

export default HeadlineA1;
