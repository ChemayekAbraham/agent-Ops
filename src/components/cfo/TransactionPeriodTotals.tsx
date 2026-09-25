import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { BarChart3, Loader2 } from 'lucide-react';
import { format, parseISO, startOfWeek } from 'date-fns';

/**
 * Transaction totals by period for the CFO dashboard.
 *
 * Reuses the same server-side aggregation the 7-day chart relies on
 * (`get_cfo_daily_cash_flow`) — the ledger produces thousands of legs per
 * day, so client-side reads would silently truncate at the Data API row cap.
 * Daily rows come back in Africa/Kampala calendar days and are rolled up
 * client-side into weekly (Monday-start) and monthly totals.
 *
 * Every ledger movement is double-entry, so Money In and Money Out mirror
 * each other per period; both are shown so the CFO sees the gross volume.
 */

interface DailyRow {
  day: string; // YYYY-MM-DD (Kampala)
  inflow: number;
  outflow: number;
}

type PeriodMode = 'daily' | 'weekly' | 'monthly';

interface PeriodBucket {
  key: string;
  label: string;
  inflow: number;
  outflow: number;
}

const DAILY_WINDOW = 90; // RPC hard cap
const DAILY_ROWS_SHOWN = 14;

const fmtUgx = (n: number) =>
  `${n < 0 ? '-' : ''}UGX ${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.abs(n))}`;

function weekStartKey(day: string) {
  // Monday-start week, computed from the Kampala day key.
  const d = parseISO(day);
  return format(startOfWeek(d, { weekStartsOn: 1 }), 'yyyy-MM-dd');
}

export function TransactionPeriodTotals() {
  const [mode, setMode] = useState<PeriodMode>('daily');

  const { data, isLoading, error } = useQuery<DailyRow[]>({
    queryKey: ['cfo-transaction-period-totals'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_cfo_daily_cash_flow', { p_days: DAILY_WINDOW });
      if (error) throw error;
      return ((data as any[]) || []).map((r) => ({
        day: String(r.day).slice(0, 10),
        inflow: Number(r.inflow) || 0,
        outflow: Number(r.outflow) || 0,
      }));
    },
    staleTime: 60_000,
  });

  const dailyRows = useMemo(() => {
    if (!data?.length) return [];
    return [...data].sort((a, b) => b.day.localeCompare(a.day));
  }, [data]);

  const buckets = useMemo((): PeriodBucket[] => {
    if (!dailyRows.length) return [];
    if (mode === 'daily') {
      return dailyRows.slice(0, DAILY_ROWS_SHOWN).map((r) => ({
        key: r.day,
        label: format(parseISO(r.day), 'EEE d MMM'),
        inflow: r.inflow,
        outflow: r.outflow,
      }));
    }
    const map = new Map<string, PeriodBucket>();
    for (const r of dailyRows) {
      let key: string;
      let label: string;
      if (mode === 'weekly') {
        key = weekStartKey(r.day);
        const end = format(new Date(parseISO(key).getTime() + 6 * 86_400_000), 'd MMM');
        label = `${format(parseISO(key), 'd MMM')} – ${end}`;
      } else {
        key = r.day.slice(0, 7);
        label = format(parseISO(`${key}-01`), 'MMMM yyyy');
      }
      const cur = map.get(key) ?? { key, label, inflow: 0, outflow: 0 };
      cur.inflow += r.inflow;
      cur.outflow += r.outflow;
      map.set(key, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.key.localeCompare(a.key));
  }, [dailyRows, mode]);

  const totalInflow = buckets.reduce((s, b) => s + b.inflow, 0);
  const totalOutflow = buckets.reduce((s, b) => s + b.outflow, 0);

  const totalLabel =
    mode === 'daily'
      ? `Total — last ${DAILY_ROWS_SHOWN} days`
      : mode === 'weekly'
      ? `Total — ${buckets.length} week${buckets.length === 1 ? '' : 's'}`
      : `Total — ${buckets.length} month${buckets.length === 1 ? '' : 's'}`;

  return (
    <Card className="rounded-2xl shadow-sm">
      <CardContent className="p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <p className="flex items-center gap-2.5 text-sm font-semibold tracking-tight">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <BarChart3 className="h-4 w-4 text-primary" />
            </span>
            Transactions — Daily, Weekly &amp; Monthly Totals
          </p>
          <div className="flex items-center rounded-full border bg-muted/40 p-0.5">
            {(['daily', 'weekly', 'monthly'] as PeriodMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                aria-pressed={mode === m}
                className={`rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors ${
                  mode === m
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading totals…
          </div>
        ) : error || !buckets.length ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            No transaction totals available for the last {DAILY_WINDOW} days.
          </div>
        ) : (
          <>
            <div className="rounded-lg border border-border overflow-hidden">
              <div className="max-h-[360px] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 sticky top-0">
                    <tr className="text-[11px] uppercase tracking-wider text-muted-foreground">
                      <th className="text-left px-3 py-2 font-semibold">{mode === 'daily' ? 'Day' : mode === 'weekly' ? 'Week' : 'Month'}</th>
                      <th className="text-right px-3 py-2 font-semibold text-emerald-700">Money In</th>
                      <th className="text-right px-3 py-2 font-semibold text-rose-700">Money Out</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {buckets.map((b) => (
                      <tr key={b.key} className="hover:bg-muted/30">
                        <td className="px-3 py-2 font-medium">{b.label}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-mono text-emerald-700">{fmtUgx(b.inflow)}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-mono text-rose-700">{fmtUgx(b.outflow)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-muted/30 font-semibold">
                    <tr>
                      <td className="px-3 py-2">{totalLabel}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-mono text-emerald-700">{fmtUgx(totalInflow)}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-mono text-rose-700">{fmtUgx(totalOutflow)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Uganda calendar days (EAT). Money In and Money Out mirror each other because every
              movement is recorded as a balanced double entry — together they show the gross volume
              of transactions for the period.
              {mode === 'daily' && dailyRows.length > DAILY_ROWS_SHOWN && (
                <> Showing the most recent {DAILY_ROWS_SHOWN} of {dailyRows.length} days.</>
              )}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
