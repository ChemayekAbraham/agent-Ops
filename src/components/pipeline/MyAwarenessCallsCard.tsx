import { useMemo } from 'react';
import { Loader2, PhoneCall } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useMyAwarenessLog, useMyAwarenessSummary } from '@/hooks/useMyAwarenessCalls';
import { SUBJECT_LABEL, callResultLabel, isNotAuthorizedError } from '@/lib/awarenessCallLabels';
import { awarenessWeekRange } from '@/lib/awarenessCallStatus';
import { count, kampalaDateTime, percent } from '@/lib/awarenessMonitoringLabels';

/**
 * "Your awareness calls": this week's own calls (Monday to today, Kampala days) with the answered share, the people reached and
 * the last few calls. Read-only. It sits at the top of the Service Centre queue and of the Agent Ops, Tenant Ops and Landlord Ops
 * pipeline screens. Someone who is not allowed to use the call log sees nothing; any other failure shows a short line with a retry.
 */
export function MyAwarenessCallsCard() {
  const { from, to } = useMemo(() => awarenessWeekRange(), []);
  const summary = useMyAwarenessSummary(from, to);
  const log = useMyAwarenessLog(from, to, 5);

  if (isNotAuthorizedError(summary.error) || isNotAuthorizedError(log.error)) return null;

  const failed = summary.isError || log.isError;
  const t = summary.data?.totals;
  const rows = log.data?.rows ?? [];
  const loading = summary.isLoading || log.isLoading;

  return (
    <section className="space-y-2.5 rounded-xl border border-border bg-card p-3" aria-label="Your awareness calls" data-testid="my-awareness-calls">
      <div className="flex items-center justify-between gap-2">
        <h4 className="flex items-center gap-1.5 text-sm font-semibold">
          <PhoneCall className="h-4 w-4 text-primary" />
          Your awareness calls
        </h4>
        <Badge variant="outline" className="text-[10px]">This week</Badge>
      </div>

      {failed ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs" data-testid="my-awareness-error">
          <span className="text-muted-foreground">Could not load your calls</span>
          <Button
            type="button" variant="outline" size="sm" className="h-8"
            disabled={summary.isFetching || log.isFetching}
            onClick={() => { void summary.refetch(); void log.refetch(); }}
          >
            {(summary.isFetching || log.isFetching) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Retry
          </Button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2" data-testid="my-awareness-stats">
            {[
              { label: 'Calls', value: count(t?.calls) },
              { label: 'Answered', value: percent(t?.answered_pct) },
              { label: 'People reached', value: count(t?.people_reached) },
            ].map((s) => (
              <div key={s.label} className="min-w-0 rounded-lg bg-muted/40 p-2">
                <p className="truncate text-[10px] text-muted-foreground">{s.label}</p>
                {loading ? <Skeleton className="mt-1 h-5 w-10" /> : <p className="text-base font-bold tabular-nums leading-tight">{s.value}</p>}
              </div>
            ))}
          </div>

          {!loading && rows.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="my-awareness-empty">You have not recorded an awareness call this week.</p>
          ) : (
            <ul className="space-y-1.5" data-testid="my-awareness-recent">
              {rows.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs">
                  <span className="min-w-0 truncate font-medium">{r.subject_name}</span>
                  <span className="text-muted-foreground">{SUBJECT_LABEL[r.subject_type]}</span>
                  <Badge variant={r.call_result === 'answered' ? 'secondary' : 'outline'} className="text-[10px]">{callResultLabel(r.call_result)}</Badge>
                  <span className="ml-auto text-[11px] text-muted-foreground">{kampalaDateTime(r.dial_started_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
