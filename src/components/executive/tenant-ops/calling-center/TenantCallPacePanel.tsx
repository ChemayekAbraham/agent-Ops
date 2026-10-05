/**
 * "On-time payoff" — additive panel for the Calling Center caller view.
 *
 * Adds the two pacing figures that exist nowhere else in the app: days left
 * in the plan, and the amount per remaining day (or per remaining week, for
 * weekly tenants) needed to finish on time. Both come from `cc_plan_pace()`,
 * a read over `v_rent_plan_schedule` — no new business rule.
 *
 * Purely additive: renders nothing while loading data it doesn't have yet,
 * and nothing at all when there is no live plan to pace (same silent-hide
 * behaviour as the rest of this dialog). It does not touch
 * TenantCallContextPanel or any other existing panel, data or layout.
 */
import { Gauge } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { formatUGX } from '@/lib/rentCalculations';
import { useCcSubjectSnapshot } from '@/hooks/useCcSubjectSnapshot';
import { useCcPlanPace } from '@/hooks/useCcPlanPace';
import { StatGrid, StatTile, DrawerSection } from '@/components/ops/calling/CallDrawerUi';

const dayLabel = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
  });
};

export function TenantCallPacePanel({ subjectId }: { subjectId: string | null }) {
  const snapshotQ = useCcSubjectSnapshot('tenant', subjectId);
  const snap = snapshotQ.data ?? null;
  const paceQ = useCcPlanPace(snap?.rent_request_id ?? null);
  const pace = paceQ.data ?? null;

  if (snapshotQ.isLoading || (snap && paceQ.isLoading)) {
    return (
      <DrawerSection title="On-time payoff" icon={Gauge} className="mt-1">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      </DrawerSection>
    );
  }

  if (!snap || !pace) return null;

  const weekly = snap.is_weekly;
  const onPace = pace.days_remaining > 0;

  return (
    <DrawerSection title="On-time payoff" icon={Gauge} className="mt-1">
      {onPace ? (
        <StatGrid>
          <StatTile label="Days remaining" value={`${pace.days_remaining}d`} />
          <StatTile label="Plan ends" value={dayLabel(pace.term_end)} />
          {weekly ? (
            <StatTile
              label="Needed per week to finish on time"
              value={pace.amount_per_remaining_day != null ? formatUGX(pace.amount_per_remaining_day * 7) : '—'}
            />
          ) : (
            <StatTile
              label="Needed per day to finish on time"
              value={pace.amount_per_remaining_day != null ? formatUGX(pace.amount_per_remaining_day) : '—'}
            />
          )}
        </StatGrid>
      ) : (
        <p className="rounded-xl border border-destructive/25 bg-destructive/10 px-2.5 py-2 text-[11px] leading-relaxed text-destructive">
          <span className="font-bold">Plan term ended {dayLabel(pace.term_end)}.</span>{' '}
          {formatUGX(pace.outstanding)} still outstanding — see the arrears figures above.
        </p>
      )}
    </DrawerSection>
  );
}
