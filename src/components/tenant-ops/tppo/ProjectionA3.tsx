import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { Skeleton } from '@/components/ui/skeleton';
import type { TppoGranularity } from './PeriodToggle';

interface ProjectionPeriod {
  period_index: number;
  period_start: string | null;
  period_end: string | null;
  label: string | null;
  projected_ugx: number | null;
}

interface ProjectionA3Report {
  granularity: string | null;
  as_at: string | null;
  snapshot_as_at: string | null;
  horizon: number | null;
  available: boolean;
  reason: string | null;
  periods: ProjectionPeriod[];
  total_ugx: number | null;
}

interface ProjectionA3Props {
  granularity: TppoGranularity;
  anchor: string;
}

const HORIZON_IN_WORDS: Record<TppoGranularity, string> = {
  day: 'next 7 days',
  week: 'next 4 weeks',
  month: 'next 3 months',
};

export function ProjectionA3({ granularity, anchor }: ProjectionA3Props) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['tppo-projection-zone-a', granularity, anchor],
    queryFn: async (): Promise<ProjectionA3Report> => {
      const { data: rpcData, error: rpcError } = await supabase.rpc('tppo_projection_zone_a', {
        p_granularity: granularity,
        p_as_at: anchor,
      });
      if (rpcError) throw rpcError;
      return (rpcData ?? {}) as unknown as ProjectionA3Report;
    },
  });

  const periods = data?.periods ?? [];
  const available = data?.available === true;
  const rowSum = periods.reduce((sum, period) => sum + (period.projected_ugx ?? 0), 0);

  return (
    <section aria-label="A3 projection" className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Projection
        </h3>
        <p className="text-xs text-muted-foreground">
          Read-only projection — no input, control or override
        </p>
      </div>

      {isLoading ? (
        <div className="mt-4 space-y-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : isError ? (
        <p className="mt-4 text-sm text-destructive">
          Could not load projection: {(error as Error)?.message ?? 'unknown error'}
        </p>
      ) : (
        <div className="mt-4 space-y-4">
          <div className="space-y-1">
            {available ? (
              <p className="text-3xl font-semibold tracking-tight tabular-nums">
                {formatUGX(rowSum)}
              </p>
            ) : (
              <p className="text-sm font-medium text-muted-foreground">
                {data?.reason ?? '—'}
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              {HORIZON_IN_WORDS[granularity]}
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th scope="col" className="py-2 pr-3 font-medium">Period</th>
                  <th scope="col" className="py-2 text-right font-medium">Projected</th>
                </tr>
              </thead>
              <tbody>
                {periods.map((period) => (
                  <tr key={period.period_index} className="border-b border-border/60">
                    <td className="py-2 pr-3 text-foreground">
                      {period.label ?? '—'}
                    </td>
                    <td className="py-2 text-right tabular-nums text-foreground">
                      {available && period.projected_ugx !== null && period.projected_ugx !== undefined
                        ? formatUGX(period.projected_ugx)
                        : '—'}
                    </td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className="py-2 pr-3">Total</td>
                  <td className="py-2 text-right tabular-nums">
                    {available ? formatUGX(rowSum) : '—'}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

export default ProjectionA3;
