import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { PeriodToggle, type TppoGranularity } from '@/components/tenant-ops/tppo/PeriodToggle';
import { HeadlineA1 } from '@/components/tenant-ops/tppo/HeadlineA1';
import { VarianceA2 } from '@/components/tenant-ops/tppo/VarianceA2';
import { ProjectionA3 } from '@/components/tenant-ops/tppo/ProjectionA3';

interface ZoneAReport {
  period_start: string | null;
  period_end: string | null;
  granularity: string | null;
  collected_ugx: number | null;
  scheduled_due_ugx: number | null;
  provisional: boolean | null;
  collection_rate_pct: number | null;
  threshold_pct: number | null;
  below_threshold: boolean | null;
  report_id: string | null;
  status: string | null;
}

/** Kampala-local anchor date (YYYY-MM-DD) for today. */
function kampalaToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Kampala',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** "Monday 01 September 2026" for a plain YYYY-MM-DD string. */
function periodInWords(
  granularity: TppoGranularity,
  periodStart: string | null,
  periodEnd: string | null,
): string {
  if (!periodStart) return '—';
  const longDate = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Intl.DateTimeFormat('en-GB', {
      weekday: 'long',
      day: '2-digit',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(y, m - 1, d)));
  };
  if (granularity === 'day' || !periodEnd) return longDate(periodStart);
  return `${longDate(periodStart)} to ${longDate(periodEnd)}`;
}

const ZONE_PLACEHOLDERS: { id: string; title: string }[] = [];

export default function PortfolioPerformanceReport() {
  // Each period state holds its own record: the query key is the sole carrier of
  // state, so nothing (figure, text or draft) crosses between Daily/Weekly/Monthly.
  const [granularity, setGranularity] = useState<TppoGranularity>('day');
  const anchor = kampalaToday();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['tppo-report-zone-a', granularity, anchor],
    queryFn: async (): Promise<ZoneAReport> => {
      const { data: rpcData, error: rpcError } = await supabase.rpc('tppo_get_report_zone_a', {
        p_granularity: granularity,
        p_anchor: anchor,
      });
      if (rpcError) throw rpcError;
      return (rpcData ?? {}) as unknown as ZoneAReport;
    },
  });

  const verdict =
    data?.below_threshold === null || data?.below_threshold === undefined
      ? '—'
      : data.below_threshold
        ? 'BELOW THRESHOLD'
        : 'ON THRESHOLD';

  const status = data?.status === 'submitted' ? 'Submitted' : 'Draft';

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-8">
      <PeriodToggle value={granularity} onChange={setGranularity} />

      <Card>
        <CardHeader className="space-y-2">
          <CardTitle className="text-xl font-semibold tracking-wide">
            PERFORMANCE REPORT
          </CardTitle>
          {isLoading ? (
            <Skeleton className="h-5 w-72" />
          ) : (
            <div className="space-y-1 text-sm">
              <p className="text-foreground">
                {periodInWords(granularity, data?.period_start ?? null, data?.period_end ?? null)}
              </p>
              <p className="font-medium text-foreground">{verdict}</p>
              <p className="text-muted-foreground">{status}</p>
            </div>
          )}
          {isError && (
            <p className="text-sm text-destructive">
              Could not load this period: {(error as Error)?.message ?? 'unknown error'}
            </p>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          <HeadlineA1 report={data} />
          <VarianceA2 report={data} />
          {ZONE_PLACEHOLDERS.map((zone) => (
            <div
              key={zone.id}
              className="flex min-h-24 items-center justify-center rounded-lg border border-dashed border-border bg-muted/30 text-sm font-medium text-muted-foreground"
            >
              {zone.title}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
