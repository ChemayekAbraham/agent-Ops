import { Activity } from 'lucide-react';
import { useAgentReport } from '@/hooks/useAgentOpsReports';
import { kampalaOffsetYmd, kampalaTodayYmd } from '@/lib/kampalaDays';
import { formatUGX } from '@/lib/rentCalculations';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

/** Read-only standing from the same report used by Agent Operations. */
export function AgentApplicationPerformance({ agentId }: { agentId: string }) {
  const { data, isLoading, isError, refetch } = useAgentReport(agentId, {
    from: kampalaOffsetYmd(-29),
    to: kampalaTodayYmd(),
  });
  const kpis = data?.kpis;

  return (
    <section aria-label="Agent performance" className="space-y-3 border-y border-border py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Activity className="h-4 w-4 text-primary" /> Agent performance
        </h3>
        <span className="text-xs text-muted-foreground">Last 30 days</span>
      </div>
      {isLoading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3" aria-label="Loading agent performance">
          {Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-12" />)}
        </div>
      ) : isError ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p role="alert" className="text-xs text-muted-foreground">Agent performance could not be loaded.</p>
          <Button size="sm" variant="outline" onClick={() => void refetch()}>Retry</Button>
        </div>
      ) : !kpis ? (
        <p className="text-xs text-muted-foreground">No performance report available.</p>
      ) : (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3">
          {[
            ['Expected collections', formatUGX(kpis.expected_window)],
            ['Collected', formatUGX(kpis.collected_window)],
            ['Collection rate', kpis.window_rate == null ? '—' : `${Math.round(kpis.window_rate)}%`],
            ['Payments recorded', String(kpis.payments_window)],
            ['Tenants repaying now', String(kpis.active_repaying)],
            ['Outstanding now', formatUGX(kpis.outstanding)],
          ].map(([label, value]) => (
            <div key={label} className="min-w-0 space-y-1">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="break-words text-sm font-semibold tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}