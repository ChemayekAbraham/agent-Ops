import { ArrowDown, ArrowRight, ArrowUp, Minus } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { Badge } from '@/components/ui/badge';
import type { TppoZoneAReport } from '@/components/tenant-ops/tppo/tppoTypes';

interface VarianceA2Props {
  report?: TppoZoneAReport | null;
  /** One period older than `report.prior` — same RPC, anchored a period earlier. */
  earlier?: TppoZoneAReport | null;
}

/**
 * basis_version lives in each snapshot's `basis` JSON. Periods computed before the
 * schedule correction carry 1 (or carry no basis at all), corrected ones carry 2.
 */
function basisVersionOf(source: unknown): number {
  const basis = (source as { basis?: unknown } | null | undefined)?.basis;
  const raw = (basis as { basis_version?: unknown } | null | undefined)?.basis_version;
  const parsed = typeof raw === 'string' ? Number(raw) : raw;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : 1;
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

function signedPct(value?: number | null): string {
  if (value === null || value === undefined) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${Math.abs(value).toFixed(1)}%`;
}

function signedClass(value?: number | null): string {
  if (value === null || value === undefined) return '';
  return value > 0 ? 'text-emerald-600' : value < 0 ? 'text-destructive' : '';
}

/**
 * A2 · VARIANCE ON PRIOR PERIOD. Scheduled/collected deltas come from the RPC.
 * The rate variance is computed here as the middle (prior) period rate minus the
 * earliest (earlier) period rate and expressed as a percentage change.
 */
function todayKampalaIso(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kampala' }).format(new Date());
}

export function VarianceA2({ report, earlier }: VarianceA2Props) {
  const priorRate = report?.prior?.collection_rate_pct;
  const earlierRate = earlier?.collection_rate_pct;
  const currentRate = report?.collection_rate_pct ?? null;

  // A period is closed once its end date is before today (Kampala), even if the
  // snapshot's `provisional` flag has not dropped yet. For a closed day the
  // variance is between that day and its previous day; for the present day the
  // existing prior-vs-earlier logic is preserved.
  const currentIsClosed =
    !!report?.period_end && report.period_end < todayKampalaIso();

  const rateDeltaPct = currentIsClosed
    ? currentRate != null && priorRate != null
      ? currentRate - priorRate
      : null
    : priorRate != null && earlierRate != null
      ? priorRate - earlierRate
      : null;

  const hasRateDelta = rateDeltaPct !== null && rateDeltaPct !== undefined;
  const direction = !hasRateDelta ? 'none' : rateDeltaPct! > 0 ? 'up' : rateDeltaPct! < 0 ? 'down' : 'flat';

  const DirectionIcon =
    direction === 'up' ? ArrowUp : direction === 'down' ? ArrowDown : Minus;

  const directionClass =
    direction === 'up'
      ? 'text-emerald-600'
      : direction === 'down'
        ? 'text-destructive'
        : 'text-muted-foreground';

  const comparisonTarget = currentIsClosed ? 'previous day' : 'earlier period';
  const directionLabel =
    direction === 'up'
      ? `up vs ${comparisonTarget}`
      : direction === 'down'
        ? `down vs ${comparisonTarget}`
        : direction === 'flat'
          ? `unchanged vs ${comparisonTarget}`
          : 'no comparison available';

  const currentLabel = periodLabel(report?.period_start, report?.period_end);
  const priorLabel = periodLabel(report?.prior?.period_start, report?.prior?.period_end);
  const earlierLabel = periodLabel(earlier?.period_start, earlier?.period_end);

  // Oldest closed period first, the still-counting current period last. The
  // labels come from the RPC, so this shuffles by itself as each day closes.
  const currentBasis = basisVersionOf(report);

  // "Still counting" only belongs on a period that has not closed yet. Once the
  // day is closed the RPC drops `provisional`, so the label disappears by itself.
  const currentStillCounting = report?.provisional === true && !currentIsClosed;

  // For a closed day the variance is between the day in question (current)
  // and its previous day (prior), so the 3rd date row (earlier) is omitted.
  const rows = (
    currentIsClosed
      ? [
          {
            key: 'prior',
            label: priorLabel,
            scheduled: report?.prior?.scheduled_due_ugx ?? null,
            collected: report?.prior?.collected_ugx ?? null,
            rate: report?.prior?.collection_rate_pct ?? null,
            arrearsTarget: report?.prior?.arrears_target_ugx ?? null,
            current: false,
            stillCounting: false,
            basisVersion: basisVersionOf(report?.prior),
          },
          {
            key: 'current',
            label: currentLabel,
            scheduled: report?.scheduled_due_ugx ?? null,
            collected: report?.collected_ugx ?? null,
            rate: report?.collection_rate_pct ?? null,
            arrearsTarget: report?.arrears_target_ugx ?? null,
            current: true,
            stillCounting: currentStillCounting,
            basisVersion: currentBasis,
          },
        ]
      : [
          {
            key: 'earlier',
            label: earlierLabel,
            scheduled: earlier?.scheduled_due_ugx ?? null,
            collected: earlier?.collected_ugx ?? null,
            rate: earlier?.collection_rate_pct ?? null,
            arrearsTarget: earlier?.arrears_target_ugx ?? null,
            current: false,
            stillCounting: false,
            basisVersion: basisVersionOf(earlier),
          },
          {
            key: 'prior',
            label: priorLabel,
            scheduled: report?.prior?.scheduled_due_ugx ?? null,
            collected: report?.prior?.collected_ugx ?? null,
            rate: report?.prior?.collection_rate_pct ?? null,
            arrearsTarget: report?.prior?.arrears_target_ugx ?? null,
            current: false,
            stillCounting: false,
            basisVersion: basisVersionOf(report?.prior),
          },
          {
            key: 'current',
            label: currentLabel,
            scheduled: report?.scheduled_due_ugx ?? null,
            collected: report?.collected_ugx ?? null,
            rate: report?.collection_rate_pct ?? null,
            arrearsTarget: report?.arrears_target_ugx ?? null,
            current: true,
            stillCounting: currentStillCounting,
            basisVersion: currentBasis,
          },
        ]
  ).map((row) => ({ ...row, differentBasis: row.basisVersion !== currentBasis }));

  const anyDifferentBasis = rows.some((row) => row.differentBasis);

  const money = (value: number | null) => (value === null ? '—' : formatUGX(value));

  const currentArrearsTarget = report?.arrears_target_ugx ?? null;
  const priorArrearsTarget = report?.prior?.arrears_target_ugx ?? null;
  const arrearsTargetDelta =
    currentArrearsTarget !== null && priorArrearsTarget !== null
      ? currentArrearsTarget - priorArrearsTarget
      : null;


  return (
    <section aria-label="A2 variance on prior period" className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Variance on prior period
      </h3>

      <div className={`mt-2 flex flex-wrap items-center gap-2 ${directionClass}`}>
        <DirectionIcon className="h-5 w-5 shrink-0" aria-hidden="true" />
        <span className="text-xl font-semibold tabular-nums font-mono">{signedPct(rateDeltaPct)}</span>
        <span className="text-sm font-medium">{directionLabel}</span>
      </div>

      <div className="mt-3 space-y-1">
        <p className="flex flex-wrap items-center gap-2 text-sm text-foreground">
          {currentIsClosed ? (
            <>
              <span>{priorLabel}</span>
              <span className="tabular-nums font-mono">{rateText(priorRate)}</span>
              <ArrowRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <span>{currentLabel}</span>
              <span className="tabular-nums font-mono">{rateText(currentRate)}</span>
            </>
          ) : (
            <>
              <span>{earlierLabel}</span>
              <span className="tabular-nums font-mono">{rateText(earlierRate)}</span>
              <ArrowRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <span>{priorLabel}</span>
              <span className="tabular-nums font-mono">{rateText(priorRate)}</span>
            </>
          )}
        </p>
        <p className="text-xs text-muted-foreground">each on its own period&apos;s schedule</p>
        {anyDifferentBasis && (
          <p className="text-xs text-muted-foreground">
            Periods marked different basis were computed before the schedule was corrected and are not comparable.
          </p>
        )}

      </div>

      {/* Mobile: the same rows stacked, so nothing is clipped at 360px. */}
      <div className="mt-4 space-y-3 sm:hidden">
        {rows.map((row) => (
          <div
            key={row.key}
            className={`rounded-md border p-3 ${
              row.current ? 'border-primary/30 bg-primary/5' : 'border-border/60'
            }`}
          >
            <p className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <span>{row.label}</span>
              {row.differentBasis && (
                <Badge variant="outline" className="text-[10px] font-medium normal-case">
                  different basis
                </Badge>
              )}
              {row.stillCounting && <span className="font-medium normal-case text-primary">still counting</span>}
            </p>
            <div className="mt-2 space-y-1 text-sm">
              <p className="flex items-baseline justify-between gap-3">
                <span className="text-muted-foreground">Scheduled due (own period)</span>
                <span className="shrink-0 tabular-nums font-mono">{money(row.scheduled)}</span>
              </p>
              <p className="flex items-baseline justify-between gap-3">
                <span className="text-muted-foreground">Collected</span>
                <span className="shrink-0 tabular-nums font-mono">{money(row.collected)}</span>
              </p>
              <p className="flex items-baseline justify-between gap-3">
                <span className="text-muted-foreground">Arrears target</span>
                <span className="shrink-0 tabular-nums font-mono">{money(row.arrearsTarget)}</span>
              </p>
              <p className="flex items-baseline justify-between gap-3">
                <span className="text-muted-foreground">Rate</span>
                <span className="shrink-0 tabular-nums font-mono">
                  {row.differentBasis ? '—' : rateText(row.rate)}
                </span>
              </p>
            </div>
          </div>
        ))}


        {(currentStillCounting || currentIsClosed) && (
          <div className="rounded-md border border-border p-3 font-medium">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Increase / decrease</p>
            <div className="mt-2 space-y-1 text-sm">
              <p className="flex items-baseline justify-between gap-3">
                <span className="text-muted-foreground">Scheduled due (own period)</span>
                <span className={`shrink-0 tabular-nums font-mono ${signedClass(report?.scheduled_delta_ugx)}`}>
                  {signedMoney(report?.scheduled_delta_ugx)}
                </span>
              </p>
              <p className="flex items-baseline justify-between gap-3">
                <span className="text-muted-foreground">Collected</span>
                <span className={`shrink-0 tabular-nums font-mono ${signedClass(report?.collected_delta_ugx)}`}>
                  {signedMoney(report?.collected_delta_ugx)}
                </span>
              </p>
              <p className="flex items-baseline justify-between gap-3">
                <span className="text-muted-foreground">Arrears target</span>
                <span className={`shrink-0 tabular-nums font-mono ${signedClass(arrearsTargetDelta)}`}>
                  {arrearsTargetDelta === null ? '—' : signedMoney(arrearsTargetDelta)}
                </span>
              </p>
              <p className="flex items-baseline justify-between gap-3">
                <span className="text-muted-foreground">Rate</span>
                <span
                  className={`shrink-0 tabular-nums font-mono ${
                    anyDifferentBasis ? 'text-muted-foreground' : signedClass(rateDeltaPct)
                  }`}
                >
                  {anyDifferentBasis ? '—' : signedPct(rateDeltaPct)}
                </span>
              </p>

            </div>
          </div>
        )}
      </div>

      <div className="mt-4 hidden overflow-x-auto sm:block">

        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="py-2 pr-3 font-medium">Period</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">Scheduled due (own period)</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">Collected</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">Arrears target</th>
              <th scope="col" className="py-2 text-right font-medium">Rate</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.key}
                className={`border-b border-border/60 ${row.current ? 'bg-primary/5' : ''}`}
              >
                <td className="py-2 pr-3">
                  <span className={row.current ? 'font-medium text-foreground' : ''}>{row.label}</span>
                  {row.differentBasis && (
                    <Badge variant="outline" className="ml-2 text-[10px] font-medium">
                      different basis
                    </Badge>
                  )}
                  {row.stillCounting && (
                    <span className="ml-2 text-xs text-primary">still counting</span>
                  )}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums font-mono">{money(row.scheduled)}</td>
                <td className="py-2 pr-3 text-right tabular-nums font-mono">{money(row.collected)}</td>
                <td className="py-2 pr-3 text-right tabular-nums font-mono">{money(row.arrearsTarget)}</td>
                <td className="py-2 text-right tabular-nums font-mono">
                  {row.differentBasis ? '—' : rateText(row.rate)}
                </td>
              </tr>
            ))}
            {(currentStillCounting || currentIsClosed) && (
              <tr className="font-medium">
                <td className="py-2 pr-3">Increase / decrease</td>
                <td className={`py-2 pr-3 text-right tabular-nums font-mono ${signedClass(report?.scheduled_delta_ugx)}`}>
                  {signedMoney(report?.scheduled_delta_ugx)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums font-mono text-muted-foreground">
                  —
                </td>
                <td className={`py-2 pr-3 text-right tabular-nums font-mono ${arrearsTargetDelta === null ? 'text-muted-foreground' : signedClass(arrearsTargetDelta)}`}>
                  {arrearsTargetDelta === null ? '—' : signedMoney(arrearsTargetDelta)}
                </td>
                <td
                  className={`py-2 text-right tabular-nums font-mono ${
                    anyDifferentBasis ? 'text-muted-foreground' : signedClass(rateDeltaPct)
                  }`}
                >
                  {anyDifferentBasis ? '—' : signedPct(rateDeltaPct)}
                </td>

              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default VarianceA2;
