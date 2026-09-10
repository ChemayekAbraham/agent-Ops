import { formatUGX } from '@/lib/rentCalculations';
import type { TppoZoneAReport } from '@/components/tenant-ops/tppo/tppoTypes';

interface HeadlineA1Props {
  report?: TppoZoneAReport | null;
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
  const arrearsTarget = report?.arrears_target_ugx ?? null;
  const arrearsTargetCount = report?.arrears_target_plan_count ?? null;
  const arrearsOutstanding = report?.arrears_outstanding_ugx ?? null;
  const totalFieldTarget = report?.total_field_target_ugx ?? null;

  const rate = report?.collection_rate_pct ?? null;
  const threshold = report?.threshold_pct ?? null;
  const below = report?.below_threshold ?? null;
  const provisional = report?.provisional === true;

  const hasRate = rate !== null && rate !== undefined;
  const atOrAbove = hasRate && below === false;

  const priorRate = report?.prior?.collection_rate_pct ?? null;

  return (
    <section aria-label="A1 headline" className="rounded-xl border border-primary/25 bg-primary/5 p-4 shadow-sm">
      <p className="mb-2 flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <span>{periodLabel(report?.period_start, report?.period_end)}</span>
        {provisional && <span className="font-medium normal-case text-primary">still counting</span>}
      </p>

      <div className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-x-3 sm:gap-y-1">
        <span className="break-words text-xl font-semibold tabular-nums font-mono text-foreground sm:text-2xl">
          {collected === null ? '—' : formatUGX(collected)}
        </span>

        <span className="text-lg font-medium tabular-nums font-mono text-foreground sm:text-xl">
          {hasRate ? `${rate.toFixed(1)}%` : '—'}
        </span>

        <span className="flex items-center gap-2 sm:contents">
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

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 mt-3">
          <div className="rounded-md border px-3 py-2">
            <p className="text-[11px] text-muted-foreground">Due on agreed plans</p>
            <p className="text-sm font-semibold tabular-nums font-mono">
              {scheduled === null ? '—' : formatUGX(scheduled)}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {`${cohortCount ?? '—'} plans within term`}
            </p>
          </div>
          {arrearsTarget !== null && arrearsTarget !== undefined ? (
          <div className="rounded-md border px-3 py-2">
            <p className="text-[11px] text-muted-foreground">Arrears brought forward</p>
            <p className="text-sm font-semibold tabular-nums font-mono text-destructive">
              {formatUGX(arrearsTarget)}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {`${arrearsTargetCount ?? '—'} plans owing at the start of this period`}
            </p>
          </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              Arrears brought forward not recorded for this period
            </p>
          )}
        </div>

        <p className="text-xs">
          {`Due plus arrears brought forward — `}
          <span className="tabular-nums font-mono">
            {totalFieldTarget === null || totalFieldTarget === undefined ? '—' : formatUGX(totalFieldTarget)}
          </span>
        </p>
        {arrearsOutstanding !== null && arrearsOutstanding !== undefined && (
          <p className="text-[11px] text-muted-foreground">
            {`Arrears outstanding to date — `}
            <span className="tabular-nums font-mono">{formatUGX(arrearsOutstanding)}</span>
          </p>
        )}

        <p className="text-[11px] text-muted-foreground mt-2">
          Due on agreed plans is what each tenant's payment plan falls due in this period, at their own daily, weekly or monthly cadence. Arrears brought forward is what was already owed when the period opened. Arrears outstanding is what is owed now — if a tenant misses a payment today it lands here, and it becomes tomorrow's brought-forward figure.
        </p>

        <p>
          {threshold === null ? 'threshold —' : 'threshold '}
          {threshold !== null && (
            <span className="tabular-nums font-mono">{`${threshold.toFixed(1)}%`}</span>
          )}
        </p>
        {report?.prior?.period_start && (
          <p>
            {`last closed period ${periodLabel(report.prior.period_start, report.prior.period_end)} — `}
            <span className="tabular-nums font-mono text-foreground">
              {priorRate === null ? '—' : `${priorRate.toFixed(1)}%`}
            </span>
          </p>
        )}
      </div>


      <div className="mt-4 space-y-2 border-t border-border pt-3 text-sm text-muted-foreground sm:space-y-1">
        <p>
          <span className="block text-foreground sm:inline">total rent recovered this period</span>
          <span className="hidden sm:inline">{' — '}</span>
          <span className="block break-words tabular-nums font-mono sm:inline">
            {collectedTotal === null ? '—' : formatUGX(collectedTotal)}
          </span>
        </p>
        <p>
          <span className="block text-foreground sm:inline">of which counted in the rate</span>
          <span className="hidden sm:inline">{' — '}</span>
          <span className="block break-words sm:inline">
            <span className="tabular-nums font-mono">{collected === null ? '—' : formatUGX(collected)}</span>
            {cohortCount !== null && ` across ${cohortCount} funded tenancies within term`}
          </span>
        </p>
        <p>
          <span className="block text-foreground sm:inline">arrears recovered on completed terms</span>
          <span className="hidden sm:inline">{' — '}</span>
          <span className="block break-words sm:inline">
            <span className="tabular-nums font-mono">
              {arrearsRecovered === null ? '—' : formatUGX(arrearsRecovered)}
            </span>
            {arrearsCount !== null && ` across ${arrearsCount} funded tenancies past term`}
          </span>
        </p>
        {unallocated !== null && unallocated > 0 && (
          <p>
            <span className="block text-foreground sm:inline">unattributed</span>
            <span className="hidden sm:inline">{' — '}</span>
            <span className="block break-words sm:inline">
              <span className="tabular-nums font-mono">{formatUGX(unallocated)}</span>
              <span className="ml-1">not matched to a funded tenancy</span>
            </span>
          </p>
        )}

        <p className="pt-2 text-xs italic">
          Scheduled is the sum of instalments the agreed payment plans fall due in this period, on each plan's own cadence. A tenant onboarded today with repayment starting later contributes from their first due date onward, not before. Plans past their agreed end date schedule nothing further; recovery against them is reported beside the rate, not inside it. Once a day is closed its scheduled figure is fixed and does not move.
        </p>
      </div>
    </section>
  );
}

export default HeadlineA1;
