import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, Line, ComposedChart,
} from 'recharts';
import { CalendarClock, RefreshCw, History } from 'lucide-react';
import { format, parseISO } from 'date-fns';

/**
 * Day-by-day collections history, read from `tppo_period_snapshots`.
 *
 * The KPI strip above this panel answers "how are we doing over the window I
 * picked", computed live. This answers a different question — "what happened on
 * each day, and is the book growing" — and it must come from the frozen
 * snapshot rather than being recomputed, because a recomputed history silently
 * restates itself every time the underlying data is corrected.
 *
 * That is not hypothetical. On 25 September a correction removed 18,422,547 of
 * billing that was never owed. The snapshot for that day is frozen at the
 * figures as they stood, so the 10.4m step in the book is still visible and
 * still explicable. A live re-derivation would have quietly absorbed it.
 *
 * FOUR FIGURES, NEVER ONE RATIO. Total cash deliberately sits last and visually
 * apart: put it next to "Expected" at the same weight and people divide one by
 * the other, which reads roughly twice as good as reality because more than
 * half of a typical day's cash clears OLDER bills. The honest coverage number
 * is `paid against that day ÷ expected that day`.
 */

const RANGES = [
  { days: 7, label: '7 days' },
  { days: 14, label: '14 days' },
  { days: 30, label: '30 days' },
] as const;

interface SnapshotRow {
  period_start: string;
  scheduled_due_ugx: number | null;
  collected_ugx: number | null;
  arrears_recovered_ugx: number | null;
  collected_total_ugx: number | null;
  arrears_outstanding_ugx: number | null;
  plan_count: number | null;
  arrears_plan_count: number | null;
  provisional: boolean | null;
  frozen_at: string | null;
  computed_at: string | null;
}

const num = (v: unknown) => Number(v ?? 0) || 0;

export function CollectionsDailyHistory() {
  const [days, setDays] = useState<number>(14);

  const since = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString().slice(0, 10);
  }, [days]);

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['tppo-daily-history', since],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('tppo_period_snapshots')
        .select(
          'period_start, scheduled_due_ugx, collected_ugx, arrears_recovered_ugx, ' +
          'collected_total_ugx, arrears_outstanding_ugx, plan_count, arrears_plan_count, ' +
          'provisional, frozen_at, computed_at',
        )
        .eq('granularity', 'day')
        .gte('period_start', since)
        .order('period_start', { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as SnapshotRow[];
    },
    // The cron refreshes today's row every 15 minutes; anything tighter than
    // that polls for changes that cannot have happened yet.
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });

  // Stable identity: `data ?? []` allocates a fresh array on every render while
  // loading, which would re-run the chart memo each time.
  const rows = useMemo(() => data ?? [], [data]);

  const chart = useMemo(
    () =>
      [...rows]
        .reverse()
        .map(r => ({
          day: format(parseISO(r.period_start), 'dd MMM'),
          expected: num(r.scheduled_due_ugx),
          onSchedule: num(r.collected_ugx),
          arrears: num(r.arrears_recovered_ugx),
          book: num(r.arrears_outstanding_ugx),
        })),
    [rows],
  );

  return (
    <Card className="p-4 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 mr-auto">
          <History className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">Day by day</h3>
          {isFetching && <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />}
        </div>
        {RANGES.map(r => (
          <Button
            key={r.days}
            size="sm"
            variant={days === r.days ? 'default' : 'outline'}
            className="h-7 text-xs"
            onClick={() => setDays(r.days)}
          >
            {r.label}
          </Button>
        ))}
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => void refetch()}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Billed against paid, per day, from the frozen daily record. <strong>Coverage is
        &ldquo;paid against that day&rdquo; over &ldquo;expected&rdquo;</strong> — money clearing older bills is shown
        separately because counting it against today&rsquo;s target reads about twice as good as
        reality.
      </p>

      {error && (
        <p className="text-sm text-destructive">
          Could not load the history: {(error as Error).message}
        </p>
      )}

      {!error && !isLoading && rows.length === 0 && (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No days recorded yet in this range.
        </p>
      )}

      {chart.length > 0 && (
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chart} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="day" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `${Math.round(v / 1000)}k`} />
              <Tooltip
                formatter={(v: number, n: string) => [formatUGX(v), n]}
                contentStyle={{ fontSize: 12 }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="expected" name="Expected" fill="hsl(var(--muted-foreground))" fillOpacity={0.25} />
              <Bar dataKey="onSchedule" name="Paid against that day" fill="hsl(var(--primary))" />
              <Bar dataKey="arrears" name="Paid missed days" fill="hsl(var(--warning, 38 92% 50%))" />
              <Line type="monotone" dataKey="book" name="Arrears book" stroke="hsl(var(--destructive))" dot={false} strokeWidth={2} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="py-1.5 text-left font-medium">Day</th>
                <th className="py-1.5 text-right font-medium">Expected</th>
                <th className="py-1.5 text-right font-medium">Paid against that day</th>
                <th className="py-1.5 text-right font-medium">Paid missed days</th>
                <th className="py-1.5 text-right font-medium">Coverage</th>
                <th className="py-1.5 text-right font-medium text-muted-foreground/70">Total cash</th>
                <th className="py-1.5 text-right font-medium">Behind</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const expected = num(r.scheduled_due_ugx);
                const onSchedule = num(r.collected_ugx);
                const cover = expected > 0 ? Math.round((onSchedule / expected) * 1000) / 10 : null;
                return (
                  <tr key={r.period_start} className="border-b last:border-0">
                    <td className="py-1.5">
                      <span className="font-medium">{format(parseISO(r.period_start), 'EEE dd MMM')}</span>
                      {r.provisional && (
                        <Badge variant="outline" className="ml-1.5 px-1 py-0 text-[9px]">
                          <CalendarClock className="mr-0.5 h-2.5 w-2.5" />
                          today
                        </Badge>
                      )}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{formatUGX(expected)}</td>
                    <td className="py-1.5 text-right tabular-nums font-semibold">{formatUGX(onSchedule)}</td>
                    <td className="py-1.5 text-right tabular-nums text-warning">
                      {formatUGX(num(r.arrears_recovered_ugx))}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{cover === null ? '—' : `${cover}%`}</td>
                    {/* Muted and last, on purpose — see the note at the top of this file. */}
                    <td className="py-1.5 text-right tabular-nums text-muted-foreground/70">
                      {formatUGX(num(r.collected_total_ugx))}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{r.arrears_plan_count ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {rows[0]?.computed_at && (
        <p className="text-[10px] text-muted-foreground">
          Today refreshed {format(new Date(rows[0].computed_at), 'h:mm a')} · earlier days are frozen
          and will not change.
        </p>
      )}
    </Card>
  );
}

export default CollectionsDailyHistory;
