import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatUGX } from '@/lib/rentCalculations';
import { format, subDays } from 'date-fns';
import { Scale, TrendingUp, TrendingDown, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { PhonePlatformReconciliationCard } from './PhonePlatformReconciliationCard';

export function ReconciliationDashboard() {
  const { data, isLoading } = useQuery({
    queryKey: ['reconciliation-7d'],
    queryFn: async () => {
      const since = subDays(new Date(), 7).toISOString();
      // Paginate to bypass 1000-row limit
      const allLedger: any[] = [];
      let offset = 0;
      let hasMore = true;
      while (hasMore) {
        const { data: page } = await supabase
          .from('general_ledger')
          .select('amount, direction, transaction_date, ledger_scope')
          .gte('transaction_date', since)
          .order('transaction_date', { ascending: true })
          .range(offset, offset + 999);
        if (page && page.length > 0) {
          allLedger.push(...page);
          offset += 1000;
          hasMore = page.length === 1000;
        } else {
          hasMore = false;
        }
      }
      const ledger = allLedger;

      if (!ledger) return { days: [], totals: { cashIn: 0, cashOut: 0, net: 0 }, discrepancies: [] };

      // Group by day
      const dayMap = new Map<string, { cashIn: number; cashOut: number; count: number }>();
      let totalIn = 0, totalOut = 0;

      for (const tx of ledger) {
        const day = tx.transaction_date.split('T')[0];
        const entry = dayMap.get(day) || { cashIn: 0, cashOut: 0, count: 0 };
        if (tx.direction === 'cash_in') {
          entry.cashIn += tx.amount;
          totalIn += tx.amount;
        } else {
          entry.cashOut += tx.amount;
          totalOut += tx.amount;
        }
        entry.count++;
        dayMap.set(day, entry);
      }

      const days = Array.from(dayMap.entries()).map(([date, vals]) => ({
        date: format(new Date(date), 'MMM d'),
        rawDate: date,
        cashIn: vals.cashIn,
        cashOut: vals.cashOut,
        net: vals.cashIn - vals.cashOut,
        count: vals.count,
      }));

      // Flag discrepancies: days where outflow > inflow by more than 20%
      const discrepancies = days.filter(d => d.cashOut > d.cashIn * 1.2 && d.cashOut > 100000);

      return {
        days,
        totals: { cashIn: totalIn, cashOut: totalOut, net: totalIn - totalOut },
        discrepancies,
      };
    },
    staleTime: 60000,
  });

  const isHealthy = (data?.totals.net ?? 0) >= 0;

  return (
    <div className="space-y-3 sm:space-y-4">
      {/* Phone Money vs Platform Money — full per-channel breakdown */}
      <PhonePlatformReconciliationCard />

      {/* Summary Cards */}
      <div className="grid grid-cols-3 gap-1 sm:gap-2">
        <Card className="border-emerald-500/20">
          <CardContent className="p-2 sm:p-3">
            <div className="flex items-center gap-1 sm:gap-2 mb-0.5 sm:mb-1">
              <TrendingUp className="h-3 sm:h-3.5 w-3 sm:w-3.5 text-emerald-600 shrink-0" />
              <span className="text-[9px] sm:text-[11px] text-muted-foreground font-medium truncate">Cash In</span>
            </div>
            <p className="text-sm sm:text-lg font-black text-emerald-600 tabular-nums truncate">
              {isLoading ? '—' : formatUGX(data?.totals.cashIn || 0)}
            </p>
          </CardContent>
        </Card>
        <Card className="border-destructive/20">
          <CardContent className="p-2 sm:p-3">
            <div className="flex items-center gap-1 sm:gap-2 mb-0.5 sm:mb-1">
              <TrendingDown className="h-3 sm:h-3.5 w-3 sm:w-3.5 text-destructive shrink-0" />
              <span className="text-[9px] sm:text-[11px] text-muted-foreground font-medium truncate">Cash Out</span>
            </div>
            <p className="text-sm sm:text-lg font-black text-destructive tabular-nums truncate">
              {isLoading ? '—' : formatUGX(data?.totals.cashOut || 0)}
            </p>
          </CardContent>
        </Card>
        <Card className={isHealthy ? 'border-emerald-500/20' : 'border-destructive/20'}>
          <CardContent className="p-2 sm:p-3">
            <div className="flex items-center gap-1 sm:gap-2 mb-0.5 sm:mb-1">
              {isHealthy ? <CheckCircle2 className="h-3 sm:h-3.5 w-3 sm:w-3.5 text-emerald-600 shrink-0" /> : <AlertTriangle className="h-3 sm:h-3.5 w-3 sm:w-3.5 text-destructive shrink-0" />}
              <span className="text-[9px] sm:text-[11px] text-muted-foreground font-medium truncate">Net</span>
            </div>
            <p className={`text-sm sm:text-lg font-black tabular-nums truncate ${isHealthy ? 'text-emerald-600' : 'text-destructive'}`}>
              {isLoading ? '—' : `${isHealthy ? '+' : ''}${formatUGX(data?.totals.net || 0)}`}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Waterfall Chart */}
      <Card>
        <CardHeader className="pb-2 px-3 sm:px-6">
          <CardTitle className="text-xs sm:text-sm flex items-center gap-2">
            <Scale className="h-3.5 sm:h-4 w-3.5 sm:w-4 text-primary" /> Daily Cash Flow (7d)
          </CardTitle>
        </CardHeader>
        <CardContent className="px-1 sm:px-6">
          <div className="h-[180px] sm:h-[220px]">
            {data?.days.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.days} barGap={1}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.1} />
                  <XAxis dataKey="date" tick={{ fontSize: 9 }} interval={0} />
                  <YAxis tick={{ fontSize: 9 }} tickFormatter={v => `${(v / 1000000).toFixed(1)}M`} width={35} />
                  <Tooltip
                    formatter={(value: number) => formatUGX(value)}
                    labelStyle={{ fontSize: 11 }}
                    contentStyle={{ fontSize: 11 }}
                  />
                  <Bar dataKey="cashIn" name="In" fill="hsl(var(--chart-2))" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="cashOut" name="Out" fill="hsl(var(--destructive))" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-xs sm:text-sm text-muted-foreground">
                {isLoading ? 'Loading chart…' : 'No data for the last 7 days'}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Discrepancy Alerts */}
      {data?.discrepancies && data.discrepancies.length > 0 && (
        <Card className="border-amber-500/30">
          <CardHeader className="pb-2 px-3 sm:px-6">
            <CardTitle className="text-xs sm:text-sm flex items-center gap-2 text-amber-600">
              <AlertTriangle className="h-3.5 w-3.5" /> Discrepancies
            </CardTitle>
          </CardHeader>
          <CardContent className="px-3 sm:px-6">
            <div className="space-y-2">
              {data.discrepancies.map(d => (
                <div key={d.rawDate} className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 p-2 rounded-lg bg-amber-500/5 border border-amber-500/20">
                  <div>
                    <p className="text-xs sm:text-sm font-medium">{d.date}</p>
                    <p className="text-[10px] sm:text-[11px] text-muted-foreground">{d.count} transactions</p>
                  </div>
                  <div className="sm:text-right">
                    <p className="text-xs sm:text-sm text-destructive font-semibold">
                      Outflow exceeds by {formatUGX(d.cashOut - d.cashIn)}
                    </p>
                    <Badge variant="outline" className="text-[9px] sm:text-[10px]">Review</Badge>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
