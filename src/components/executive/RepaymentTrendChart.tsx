import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, Cell } from 'recharts';
import { formatUGX } from '@/lib/rentCalculations';
import { format, subDays, eachDayOfInterval } from 'date-fns';
import { TrendingUp } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

interface RepaymentTrendChartProps {
  dailyExpected: number; // fallback only: used if the pinned bill is unavailable
}

interface TrendDay {
  day: string;
  expected: number;
  collected: number;
  collected_total: number;
}

export function RepaymentTrendChart({ dailyExpected }: RepaymentTrendChartProps) {
  const today = new Date();
  const days = eachDayOfInterval({ start: subDays(today, 6), end: today });

  // Same reading as the Tenant Ops "collected vs expected" card: expected comes
  // from the pinned daily bill (`agent_expected_day_plans`) and collected is the
  // on-schedule cash capped at what each billed plan owed for that day.
  const { data: trend } = useQuery({
    queryKey: ['repayment-trend-7d-pinned'],
    queryFn: async (): Promise<TrendDay[]> => {
      const { data, error } = await supabase.rpc('ops_repayment_trend_daily' as any, { p_days: 7 });
      if (error) throw error;
      const rows = ((data as any)?.days ?? []) as Record<string, unknown>[];
      return rows.map((r) => ({
        day: String(r.day),
        expected: Number(r.expected ?? 0),
        collected: Number(r.collected ?? 0),
        collected_total: Number(r.collected_total ?? 0),
      }));
    },
    staleTime: 120000,
  });

  const chartData = useMemo(() => {
    const byDay = new Map((trend || []).map((t) => [t.day, t]));
    return days.map(day => {
      const key = format(day, 'yyyy-MM-dd');
      const row = byDay.get(key);
      const collected = row?.collected ?? 0;
      const expected = row?.expected ?? (trend ? 0 : dailyExpected);

      return {
        date: format(day, 'EEE'),
        fullDate: format(day, 'MMM d'),
        collected,
        expected,
        gap: Math.max(0, expected - collected),
      };
    });
  }, [days, trend, dailyExpected]);


  return (
    <Card className="border shadow-sm">
      <CardHeader className="pb-2 px-3 sm:px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-primary" />
          Collected vs Expected (7 Days)
        </CardTitle>
      </CardHeader>
      <CardContent className="px-2 sm:px-4 pb-3">
        <div className="h-[220px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} barGap={2} barCategoryGap="20%">
              <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} className="fill-muted-foreground" />
              <YAxis
                tick={{ fontSize: 10 }}
                className="fill-muted-foreground"
                tickFormatter={(v) => v >= 1000000 ? `${(v / 1000000).toFixed(1)}M` : v >= 1000 ? `${(v / 1000).toFixed(0)}K` : String(v)}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'hsl(var(--card))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: '8px',
                  fontSize: '12px',
                }}
                formatter={(value: number, name: string) => [
                  formatUGX(value),
                  name === 'collected' ? 'Collected' : 'Expected'
                ]}
                labelFormatter={(label, payload) => payload?.[0]?.payload?.fullDate || label}
              />
              <Legend
                formatter={(value) => value === 'collected' ? 'Collected' : 'Expected'}
                wrapperStyle={{ fontSize: '11px' }}
              />
              <Bar dataKey="expected" radius={[4, 4, 0, 0]} opacity={0.3} fill="hsl(var(--muted-foreground))" />
              <Bar dataKey="collected" radius={[4, 4, 0, 0]}>
                {chartData.map((entry, index) => (
                  <Cell
                    key={index}
                    fill={entry.collected >= entry.expected
                      ? 'hsl(var(--success))'
                      : entry.collected >= entry.expected * 0.5
                        ? 'hsl(var(--warning))'
                        : 'hsl(var(--destructive))'
                    }
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        {/* Summary row */}
        <div className="flex justify-between items-center mt-2 px-1 text-xs text-muted-foreground">
          <span>
            7-day total: <strong className="text-foreground">{formatUGX(chartData.reduce((s, d) => s + d.collected, 0))}</strong>
          </span>
          <span>
            Expected: <strong className="text-foreground">{formatUGX(chartData.reduce((s, d) => s + d.expected, 0))}</strong>
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
