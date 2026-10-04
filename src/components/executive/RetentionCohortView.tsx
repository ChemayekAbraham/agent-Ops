import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { format, subWeeks, subDays, startOfDay, endOfDay } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Users2, Download } from 'lucide-react';

type Bucket = 'day' | 'week';
type WindowPreset = '4' | '8' | '12' | '24';

interface Row {
  cohort_date: string;
  cohort_size: number;
  period_number: number | null;
  active_users: number | null;
}

function heatColor(pct: number): string {
  // 0 → muted, 100 → primary. Alpha ramp.
  if (pct <= 0) return 'hsl(var(--muted))';
  const alpha = Math.min(1, 0.12 + (pct / 100) * 0.85);
  return `hsl(var(--primary) / ${alpha.toFixed(2)})`;
}

export function RetentionCohortView() {
  const [bucket, setBucket] = useState<Bucket>('week');
  const [windowPreset, setWindowPreset] = useState<WindowPreset>('8');
  const periods = parseInt(windowPreset, 10);

  const { start, end } = useMemo(() => {
    const now = new Date();
    if (bucket === 'week') {
      return { start: startOfDay(subWeeks(now, periods - 1)), end: endOfDay(now) };
    }
    return { start: startOfDay(subDays(now, periods - 1)), end: endOfDay(now) };
  }, [bucket, periods]);

  const { data, isLoading, error } = useQuery({
    queryKey: ['cohort-retention', bucket, periods],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_cohort_retention', {
        p_start: start.toISOString(),
        p_end: end.toISOString(),
        p_bucket: bucket,
        p_periods: periods,
      });
      if (error) throw error;
      return (data || []) as Row[];
    },
    staleTime: 300000,
  });

  // Pivot rows → cohort × period matrix
  const cohorts = useMemo(() => {
    if (!data) return [] as { date: string; size: number; cells: (number | null)[] }[];
    const map = new Map<string, { size: number; cells: (number | null)[] }>();
    for (const r of data) {
      if (!map.has(r.cohort_date)) {
        map.set(r.cohort_date, { size: r.cohort_size, cells: Array(periods + 1).fill(null) });
      }
      const c = map.get(r.cohort_date)!;
      c.size = r.cohort_size;
      if (r.period_number != null && r.period_number <= periods) {
        c.cells[r.period_number] = r.active_users ?? 0;
      }
    }
    return Array.from(map.entries())
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, v]) => ({ date, size: v.size, cells: v.cells }));
  }, [data, periods]);

  const avgByPeriod = useMemo(() => {
    const out: (number | null)[] = Array(periods + 1).fill(null);
    for (let p = 0; p <= periods; p++) {
      const rows = cohorts.filter((c) => c.cells[p] != null && c.size > 0);
      if (!rows.length) continue;
      const sum = rows.reduce((acc, c) => acc + ((c.cells[p]! / c.size) * 100), 0);
      out[p] = sum / rows.length;
    }
    return out;
  }, [cohorts, periods]);

  const handleCSV = () => {
    const header = ['cohort_date', 'cohort_size', ...Array.from({ length: periods + 1 }, (_, i) => `P${i}`)];
    const rows = cohorts.map((c) => [
      c.date, c.size,
      ...c.cells.map((v) => (v == null ? '' : v)),
    ]);
    const csv = [header, ...rows].map((r) => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `retention_${bucket}_${periods}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const periodLabel = (i: number) => (bucket === 'week' ? `W${i}` : `D${i}`);

  return (
    <div className="rounded-2xl border border-border bg-card p-3 sm:p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Users2 className="w-4 h-4 text-primary" />
          Retention Cohorts
          <span className="text-[10px] font-normal text-muted-foreground">
            % of a signup cohort that returned (successful login) in each following {bucket}
          </span>
        </h3>
        <Button size="sm" variant="outline" onClick={handleCSV} className="text-xs" disabled={!cohorts.length}>
          <Download className="w-3.5 h-3.5 mr-1" /> CSV
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        <div className="flex gap-1">
          {(['day', 'week'] as Bucket[]).map((b) => (
            <Button key={b} size="sm" variant={bucket === b ? 'secondary' : 'outline'}
              onClick={() => setBucket(b)} className="text-xs capitalize">
              {b === 'day' ? 'Daily' : 'Weekly'}
            </Button>
          ))}
        </div>
        <div className="flex gap-1">
          {(['4', '8', '12', '24'] as WindowPreset[]).map((w) => (
            <Button key={w} size="sm" variant={windowPreset === w ? 'secondary' : 'outline'}
              onClick={() => setWindowPreset(w)} className="text-xs">
              {w} {bucket === 'week' ? 'weeks' : 'days'}
            </Button>
          ))}
        </div>
      </div>

      {isLoading && <p className="text-xs text-muted-foreground">Computing cohorts…</p>}
      {error && <p className="text-xs text-destructive">Failed to load: {(error as Error).message}</p>}

      {!isLoading && cohorts.length > 0 && (
        <div className="overflow-x-auto">
          <table className="text-xs w-full border-collapse">
            <thead>
              <tr>
                <th className="text-left font-medium px-2 py-1.5 sticky left-0 bg-card">Cohort</th>
                <th className="text-right font-medium px-2 py-1.5">Users</th>
                {Array.from({ length: periods + 1 }, (_, i) => (
                  <th key={i} className="text-center font-medium px-2 py-1.5 min-w-[52px]">
                    {periodLabel(i)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cohorts.map((c) => (
                <tr key={c.date} className="border-t border-border/40">
                  <td className="px-2 py-1.5 font-medium sticky left-0 bg-card">
                    {format(new Date(c.date), bucket === 'week' ? "MMM d, ''yy" : 'MMM d')}
                  </td>
                  <td className="px-2 py-1.5 text-right text-muted-foreground">{c.size.toLocaleString()}</td>
                  {c.cells.map((v, i) => {
                    if (v == null || c.size === 0) {
                      return <td key={i} className="px-1 py-1"><div className="h-7 rounded bg-muted/30" /></td>;
                    }
                    const pct = (v / c.size) * 100;
                    return (
                      <td key={i} className="px-1 py-1">
                        <div
                          className="h-7 rounded flex items-center justify-center text-[10px] font-medium"
                          style={{ backgroundColor: heatColor(pct), color: pct > 45 ? 'white' : 'hsl(var(--foreground))' }}
                          title={`${v.toLocaleString()} of ${c.size.toLocaleString()} returned`}
                        >
                          {pct.toFixed(0)}%
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
              <tr className="border-t-2 border-border">
                <td className="px-2 py-1.5 font-semibold sticky left-0 bg-card">Average</td>
                <td className="px-2 py-1.5" />
                {avgByPeriod.map((v, i) => (
                  <td key={i} className="px-1 py-1">
                    {v == null ? (
                      <div className="h-7 rounded bg-muted/30" />
                    ) : (
                      <div
                        className="h-7 rounded flex items-center justify-center text-[10px] font-semibold"
                        style={{ backgroundColor: heatColor(v), color: v > 45 ? 'white' : 'hsl(var(--foreground))' }}
                      >
                        {v.toFixed(0)}%
                      </div>
                    )}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {!isLoading && cohorts.length === 0 && !error && (
        <p className="text-xs text-muted-foreground">No cohort data in this window.</p>
      )}

      <p className="text-[10px] text-muted-foreground">
        P0 = signup {bucket}. Returning user = a successful login recorded in that {bucket}.
      </p>
    </div>
  );
}