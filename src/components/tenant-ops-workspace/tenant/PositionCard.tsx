/**
 * Presentation only — every figure comes from tops_plan_position /
 * tops_plan_schedule_ledger already computed; no arithmetic here beyond
 * formatting, a sign check, and finding the latest settled_by date (a plain
 * comparison over already-provided date strings, not a money computation).
 */
import { useMemo } from 'react';
import { AlertTriangle, Info, TrendingDown, TrendingUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatUGX } from '@/lib/rentCalculations';
import { usePlanPosition } from '@/hooks/tenantOpsWorkspace/usePlanPosition';
import { usePlanScheduleLedger } from '@/hooks/tenantOpsWorkspace/usePlanScheduleLedger';

const dayLabel = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

function basisCaption(basis: string, asAt: string): string {
  const parts = basis
    .split(';')
    .filter(Boolean)
    .map((p) => p.replace(/_/g, ' '))
    .join(' · ');
  return `Every figure here: ${parts} — as at ${dayLabel(asAt)}`;
}

export interface PositionCardProps {
  rentRequestId: string;
  /** ISO date to view the position as at; omit for today (Kampala). */
  asAt?: string;
  /** Where "View the cadence remediation list" links — that list itself is a later prompt's job. */
  cadenceRemediationHref?: string;
}

export default function PositionCard({
  rentRequestId,
  asAt,
  cadenceRemediationHref = '/tenant-ops/workspace?section=tenants',
}: PositionCardProps) {
  const { data: position, isLoading, error } = usePlanPosition(rentRequestId, asAt);
  const { data: ledger } = usePlanScheduleLedger(rentRequestId);

  const lastPaymentDate = useMemo(() => {
    if (!ledger) return null;
    let latest: string | null = null;
    for (const row of ledger) {
      for (const settlement of row.settled_by ?? []) {
        if (!latest || settlement.date > latest) latest = settlement.date;
      }
    }
    return latest;
  }, [ledger]);

  if (isLoading) {
    return (
      <Card className="border shadow-sm">
        <CardContent className="py-8 text-center text-sm text-muted-foreground">Loading plan position…</CardContent>
      </Card>
    );
  }

  if (error || !position) {
    return (
      <Card className="border shadow-sm">
        <CardContent className="py-8 text-center text-sm text-destructive">Could not load this plan's position.</CardContent>
      </Card>
    );
  }

  // cadence_source = unknown: never a number — just the notice and a way out.
  if (position.cadence_source === 'unknown') {
    return (
      <Card className="border shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Plan position</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-3 rounded-lg border border-dashed p-4">
            <Info className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
            <div className="space-y-1">
              <p className="text-sm font-medium">This plan's schedule cannot be computed yet</p>
              <p className="text-xs text-muted-foreground">
                Its repayment cadence has not been explicitly confirmed, so no position, catch-up or arrears figure
                can be shown for it.
              </p>
              <a
                href={cadenceRemediationHref}
                className="inline-block text-xs font-medium text-primary underline underline-offset-2"
              >
                View the cadence remediation list
              </a>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const terms = position.terms;
  const isExpired = position.term_expired === true;
  const isAhead = !isExpired && (position.position_ugx ?? 0) > 0;
  const isBehind = !isExpired && (position.position_ugx ?? 0) < 0;

  return (
    <Card className="border shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          {isExpired ? (
            <>
              <AlertTriangle className="h-4 w-4 text-destructive" /> Term expired
            </>
          ) : isBehind ? (
            <>
              <TrendingDown className="h-4 w-4 text-destructive" />
              Behind by {formatUGX(Math.abs(position.position_ugx ?? 0))}
            </>
          ) : isAhead ? (
            <>
              <TrendingUp className="h-4 w-4 text-success" />
              Ahead by {formatUGX(position.position_ugx ?? 0)}
            </>
          ) : (
            'On track'
          )}
        </CardTitle>
        {!isExpired && (
          <p className="text-xs text-muted-foreground">
            {position.periods_due ?? 0} period{(position.periods_due ?? 0) === 1 ? '' : 's'} due
            {(position.days_past_due ?? 0) > 0
              ? ` · ${position.days_past_due} day${position.days_past_due === 1 ? '' : 's'} past due`
              : ''}
          </p>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Plan</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
            <div>
              <span className="text-muted-foreground">Total</span>
              <p className="font-medium tabular-nums">{terms ? formatUGX(terms.total_repayment) : '—'}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Duration</span>
              <p className="font-medium">{terms ? `${terms.duration_days} days` : '—'}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Cadence</span>
              <p className="font-medium capitalize">{position.cadence}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Clock start</span>
              <p className="font-medium">{dayLabel(position.clock_start)}</p>
            </div>
          </div>
          <p className="mt-1 text-xs">
            <span className="text-muted-foreground">Term end:</span>{' '}
            <span className="font-medium">{dayLabel(position.term_end_date)}</span>
          </p>
        </div>

        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Progress</p>
          <p className="text-xs">
            <span className="font-medium tabular-nums">{formatUGX(position.paid_to_date_ugx ?? 0)}</span>
            <span className="text-muted-foreground"> of {terms ? formatUGX(terms.total_repayment) : '—'} paid</span>
          </p>
          <p className="text-xs text-muted-foreground">
            Outstanding:{' '}
            <span className="font-medium tabular-nums text-foreground">
              {formatUGX(position.outstanding_ugx ?? 0)}
            </span>
          </p>
        </div>

        {isExpired ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
            <p className="text-xs font-semibold text-destructive">
              Outstanding due now: {formatUGX(position.outstanding_ugx ?? 0)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              This plan's term has ended — an overdue regime applies. No catch-up figure or penalty is calculated
              here.
            </p>
          </div>
        ) : isAhead ? (
          <div className="rounded-lg border border-success/30 bg-success/5 p-3">
            <p className="text-xs font-semibold text-success">
              {position.days_ahead ?? 0} day{(position.days_ahead ?? 0) === 1 ? '' : 's'} of cover banked
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              This tenant is ahead of schedule — no collection prompt or chase action applies.
            </p>
          </div>
        ) : isBehind && position.catch_up_daily_ugx != null ? (
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              To get back on track
            </p>
            <p className="text-xs">
              Pay <span className="font-semibold tabular-nums">{formatUGX(Math.abs(position.position_ugx ?? 0))}</span>{' '}
              now, or
            </p>
            <p className="text-xs">
              <span className="font-semibold tabular-nums">{formatUGX(position.catch_up_daily_ugx)}</span>
              <span className="text-muted-foreground">/day to term end</span>
              {terms && (
                <span className="text-muted-foreground"> (was {formatUGX(terms.daily_repayment)}/day)</span>
              )}
            </p>
          </div>
        ) : null}

        <p className="text-xs text-muted-foreground">
          Last payment:{' '}
          <span className="font-medium text-foreground">
            {lastPaymentDate ? dayLabel(lastPaymentDate) : 'None recorded'}
          </span>
        </p>

        <p className="border-t pt-2 text-[11px] text-muted-foreground">
          {basisCaption(position.basis, position.as_at)}
        </p>
      </CardContent>
    </Card>
  );
}
