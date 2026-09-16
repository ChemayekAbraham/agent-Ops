import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, Cell } from 'recharts';
import { formatUGX } from '@/lib/rentCalculations';
import { format, subDays, startOfDay, eachDayOfInterval } from 'date-fns';
import { TrendingUp } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

interface RepaymentTrendChartProps {
  dailyExpected: number; // total daily expected across all tenants
}

export function RepaymentTrendChart({ dailyExpected }: RepaymentTrendChartProps) {
  const today = new Date();
  const days = eachDayOfInterval({ start: subDays(today, 6), end: today });

  const { data: collections } = useQuery({
    queryKey: ['repayment-trend-7d'],
    queryFn: async () => {
      const startDate = format(subDays(today, 6), 'yyyy-MM-dd') + 'T00:00:00';
      const { data, error } = await supabase
        .from('agent_collections')
        .select('amount, created_at').is('reversed_at', null)
        .gte('created_at', startDate);
      if (error) throw error;
      return data || [];
    },
    staleTime: 120000,
  });

  const chartData = useMemo(() => {
    return days.map(day => {
      const dayStart = startOfDay(day);
      const collected = (collections || [])
        .filter(c => startOfDay(new Date(c.created_at)).getTime() === dayStart.getTime())
        .reduce((sum, c) => sum + Number(c.amount), 0);

      return {
        date: format(day, 'EEE'),
        fullDate: format(day, 'MMM d'),
        collected,
        expected: dailyExpected,
        gap: Math.max(0, dailyExpected - collected),
      };
    });
  }, [days, collections, dailyExpected]);

  return (
    <Card className="border shadow-sm">
      <CardHeader className="pb-2 px-3 sm:px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-primary" />
          Gross Repayment Trend (7 Days)
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
