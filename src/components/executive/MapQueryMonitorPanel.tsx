import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Map, AlertTriangle, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface RegionRow {
  region: string;
  queries: number;
  cache_hits: number;
  failures: number;
  sessions: number;
  avg_query_ms: number | null;
  max_query_ms: number | null;
  avg_render_ms: number | null;
  max_render_ms: number | null;
  cache_reuse_rate: number | null;
  error_rate: number | null;
  houses_in_view_max: number;
  scan_capped: number;
  last_error: string | null;
}

interface MapMetrics {
  since: string;
  hours: number;
  overall: Omit<RegionRow, 'region' | 'houses_in_view_max' | 'scan_capped' | 'last_error'>;
  regions: RegionRow[];
}

const REGION_LABELS: Record<string, string> = {
  uganda: 'Uganda',
  'east-africa': 'East Africa',
  'central-africa': 'Central Africa',
  'west-africa': 'West Africa',
  'north-africa': 'North Africa',
  'southern-africa': 'Southern Africa',
  'outside-africa': 'Outside Africa',
  unknown: 'Unknown',
};

const ms = (value: number | null | undefined) => (value == null ? '—' : `${Number(value).toFixed(0)} ms`);
const pct = (value: number | null | undefined) =>
  value == null ? '—' : `${(Number(value) * 100).toFixed(1)}%`;

/** Latency thresholds mirror the load-test budget for viewport queries. */
const latencyTone = (value: number | null | undefined) =>
  value == null ? 'text-muted-foreground'
    : value > 800 ? 'text-destructive'
    : value > 300 ? 'text-amber-600 dark:text-amber-400'
    : 'text-emerald-600 dark:text-emerald-400';

const errorTone = (value: number | null | undefined) =>
  value == null ? 'text-muted-foreground'
    : value > 0.05 ? 'text-destructive'
    : value > 0.01 ? 'text-amber-600 dark:text-amber-400'
    : 'text-emerald-600 dark:text-emerald-400';

export function MapQueryMonitorPanel() {
  const [hours, setHours] = useState('24');

  const { data, isLoading, isError } = useQuery<MapMetrics | null>({
    queryKey: ['map-query-metrics', hours],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_map_query_metrics', { p_hours: Number(hours) });
      if (error) throw error;
      return (data as unknown as MapMetrics) ?? null;
    },
    staleTime: 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });

  const overall = data?.overall;
  const regions = data?.regions ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Map className="h-4 w-4 text-primary" aria-hidden />
            House map performance (Africa)
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Viewport query latency, clustering render time, cache reuse and error rate, by region.
          </p>
        </div>
        <Select value={hours} onValueChange={setHours}>
          <SelectTrigger className="h-9 w-[130px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1">Last hour</SelectItem>
            <SelectItem value="24">Last 24 hours</SelectItem>
            <SelectItem value="168">Last 7 days</SelectItem>
            <SelectItem value="720">Last 30 days</SelectItem>
          </SelectContent>
        </Select>
      </CardHeader>

      <CardContent className="space-y-4">
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading map metrics…
          </div>
        )}

        {isError && (
          <div className="flex items-center gap-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4" aria-hidden /> Could not load map metrics.
          </div>
        )}

        {overall && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Avg query latency" value={ms(overall.avg_query_ms)} tone={latencyTone(overall.avg_query_ms)} hint={`Worst ${ms(overall.max_query_ms)}`} />
            <Metric label="Avg clustering render" value={ms(overall.avg_render_ms)} tone={latencyTone(overall.avg_render_ms)} hint={`Worst ${ms(overall.max_render_ms)}`} />
            <Metric label="Cache reuse" value={pct(overall.cache_reuse_rate)} hint={`${overall.cache_hits.toLocaleString()} reused views`} />
            <Metric label="Error rate" value={pct(overall.error_rate)} tone={errorTone(overall.error_rate)} hint={`${overall.failures.toLocaleString()} failed of ${overall.queries.toLocaleString()}`} />
          </div>
        )}

        {overall && !overall.queries && !overall.cache_hits && (
          <p className="text-xs text-muted-foreground">
            No map activity recorded in this window yet.
          </p>
        )}

        {regions.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b">
                  <th className="py-2 text-left font-medium">Region</th>
                  <th className="py-2 text-right font-medium">Queries</th>
                  <th className="py-2 text-right font-medium">Avg / worst query</th>
                  <th className="py-2 text-right font-medium">Avg render</th>
                  <th className="py-2 text-right font-medium">Cache reuse</th>
                  <th className="py-2 text-right font-medium">Errors</th>
                  <th className="py-2 text-right font-medium">Busiest view</th>
                </tr>
              </thead>
              <tbody>
                {regions.map((row) => (
                  <tr key={row.region} className="border-b last:border-0">
                    <td className="py-2 font-medium text-foreground">
                      {REGION_LABELS[row.region] ?? row.region}
                      {row.scan_capped > 0 && (
                        <Badge variant="secondary" className="ml-2 text-[10px]">capped {row.scan_capped}</Badge>
                      )}
                    </td>
                    <td className="py-2 text-right">{row.queries.toLocaleString()}</td>
                    <td className={cn('py-2 text-right', latencyTone(row.avg_query_ms))}>
                      {ms(row.avg_query_ms)} / {ms(row.max_query_ms)}
                    </td>
                    <td className={cn('py-2 text-right', latencyTone(row.avg_render_ms))}>{ms(row.avg_render_ms)}</td>
                    <td className="py-2 text-right">{pct(row.cache_reuse_rate)}</td>
                    <td className={cn('py-2 text-right', errorTone(row.error_rate))}>
                      {pct(row.error_rate)}
                      {row.failures > 0 && <span className="ml-1 text-muted-foreground">({row.failures})</span>}
                    </td>
                    <td className="py-2 text-right">{row.houses_in_view_max.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {regions.some((r) => r.last_error) && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs">
            <p className="mb-1 font-semibold text-foreground">Latest failures</p>
            <ul className="space-y-1 text-muted-foreground">
              {regions.filter((r) => r.last_error).map((r) => (
                <li key={r.region}>
                  <span className="font-medium text-foreground">{REGION_LABELS[r.region] ?? r.region}:</span>{' '}
                  {r.last_error}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className="rounded-lg border bg-muted/30 p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('mt-1 text-lg font-semibold', tone ?? 'text-foreground')}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
