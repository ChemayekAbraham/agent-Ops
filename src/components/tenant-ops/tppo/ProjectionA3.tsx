import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { TppoGranularity } from './PeriodToggle';

interface ProjectionPeriod {
  period_index: number;
  period_start: string | null;
  period_end: string | null;
  label: string | null;
  projected_ugx: number | null;
  plans: number | null;
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
  const [open, setOpen] = useState(false);
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
    <section aria-label="A3 projection" className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center justify-between gap-2 text-left"
      >
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Projection
        </h3>
        <div className="flex items-center gap-2">
          <p className="text-xs text-muted-foreground">
            Read-only — scheduled on the agreed plans, no input, control or override
          </p>
          <ChevronDown
            className={cn(
              'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-180',
            )}
            aria-hidden="true"
          />
        </div>
      </button>

      {open ? (
      isLoading ? (
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
              <p className="text-3xl font-semibold tracking-tight tabular-nums font-mono">
                {formatUGX(rowSum)}
              </p>
            ) : (
              <p className="text-sm font-medium text-muted-foreground">
                {data?.reason ?? '—'}
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              {HORIZON_IN_WORDS[granularity]} · scheduled on the agreed plans
            </p>
          </div>

          {/* Mobile: date and amount on one line per row, Total last and distinct. */}
          <div className="sm:hidden">
            <div className="divide-y divide-border/60">
              {periods.map((period) => (
                <div
                  key={period.period_index}
                  className="flex items-baseline justify-between gap-3 py-2 text-sm"
                >
                  <span className="text-foreground">{period.label ?? '—'}</span>
                  <div className="flex items-baseline gap-4">
                    <span className="shrink-0 tabular-nums font-mono text-muted-foreground">
                      {period.plans !== null && period.plans !== undefined ? period.plans : '—'}
                    </span>
                    <span className="shrink-0 tabular-nums font-mono text-foreground">
                      {available && period.projected_ugx !== null && period.projected_ugx !== undefined
                        ? formatUGX(period.projected_ugx)
                        : '—'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-2 flex items-baseline justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm font-semibold">
              <span>Total</span>
              <span className="shrink-0 tabular-nums font-mono">{available ? formatUGX(rowSum) : '—'}</span>
            </div>
          </div>

          <div className="hidden overflow-x-auto sm:block">

            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th scope="col" className="py-2 pr-3 font-medium">Period</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Plans</th>
                  <th scope="col" className="py-2 text-right font-medium">Projected</th>
                </tr>
              </thead>
              <tbody>
                {periods.map((period) => (
                  <tr key={period.period_index} className="border-b border-border/60">
                    <td className="py-2 pr-3 text-foreground">
                      {period.label ?? '—'}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums font-mono text-foreground">
                      {period.plans !== null && period.plans !== undefined ? period.plans : '—'}
                    </td>
                    <td className="py-2 text-right tabular-nums font-mono text-foreground">
                      {available && period.projected_ugx !== null && period.projected_ugx !== undefined
                        ? formatUGX(period.projected_ugx)
                        : '—'}
                    </td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className="py-2 pr-3">Total</td>
                  <td className="py-2 pr-3" />
                  <td className="py-2 text-right tabular-nums font-mono">
                    {available ? formatUGX(rowSum) : '—'}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
            What the agreed payment plans fall due on each of these days. A tenant whose repayment starts later contributes only from their first due date, and weekly or monthly plans appear on their due dates rather than spread across every day. This is scheduled rent, not a prediction of what will be collected.
          </p>
        </div>
      )
      ) : null}
    </section>
  );
}

export default ProjectionA3;
