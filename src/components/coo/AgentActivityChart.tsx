import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, BarChart3 } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { format, subDays, subMonths, startOfDay, eachDayOfInterval, eachWeekOfInterval, eachMonthOfInterval, startOfWeek, startOfMonth } from 'date-fns';

type TimeRange = '7d' | '30d' | '90d' | '6m' | '1y';

const RANGES: Record<TimeRange, { label: string; days: number }> = {
  '7d': { label: 'Last 7 days', days: 7 },
  '30d': { label: 'Last 30 days', days: 30 },
  '90d': { label: 'Last 90 days', days: 90 },
  '6m': { label: 'Last 6 months', days: 180 },
  '1y': { label: 'Last year', days: 365 },
};

export function AgentActivityChart() {
  const [range, setRange] = useState<TimeRange>('30d');

  const startDate = useMemo(() => {
    const d = RANGES[range].days;
    return startOfDay(d <= 180 ? subDays(new Date(), d) : subMonths(new Date(), 12));
  }, [range]);

  const { data: rawData, isLoading } = useQuery({
    queryKey: ['agent-activity-chart', range],
    queryFn: async () => {
      const iso = startDate.toISOString();

      const [registrations, earnings, collections] = await Promise.all([
        supabase
          .from('user_roles')
          .select('created_at')
          .eq('role', 'agent')
          .gte('created_at', iso)
          .order('created_at', { ascending: true }),
        supabase
          .from('agent_earnings')
          .select('created_at, amount')
          .gte('created_at', iso)
          .order('created_at', { ascending: true }),
        supabase
          .from('general_ledger')
          .select('transaction_date, amount')
          .or('and(category.eq.tenant_repayment,direction.eq.cash_in),'
            + 'and(category.eq.tenant_repayment_collected,direction.eq.cash_out)')
          .in('classification', ['production', 'legacy_real'])
          .gte('transaction_date', iso)
          .order('transaction_date', { ascending: true })
          .limit(500),
      ]);

      return {
        registrations: registrations.data || [],
        earnings: earnings.data || [],
        collections: collections.data || [],
      };
    },
  });

  const chartData = useMemo(() => {
    if (!rawData) return [];

    const now = new Date();
    const days = RANGES[range].days;

    let intervals: Date[];
    let formatKey: (d: Date) => string;
    let formatLabel: (d: Date) => string;

    if (days <= 30) {
      intervals = eachDayOfInterval({ start: startDate, end: now });
      formatKey = (d) => format(d, 'yyyy-MM-dd');
      formatLabel = (d) => format(d, 'dd MMM');
    } else if (days <= 90) {
      intervals = eachWeekOfInterval({ start: startDate, end: now });
      formatKey = (d) => format(startOfWeek(d), 'yyyy-MM-dd');
      formatLabel = (d) => format(d, 'dd MMM');
    } else {
      intervals = eachMonthOfInterval({ start: startDate, end: now });
      formatKey = (d) => format(startOfMonth(d), 'yyyy-MM');
      formatLabel = (d) => format(d, 'MMM yy');
    }

    const buckets = new Map<string, { label: string; registrations: number; earnings: number; collections: number }>();
    intervals.forEach((d) => {
      const key = formatKey(d);
      if (!buckets.has(key)) {
        buckets.set(key, { label: formatLabel(d), registrations: 0, earnings: 0, collections: 0 });
      }
    });

    const bucketFor = (dateStr: string) => {
      const d = new Date(dateStr);
      if (days <= 30) return format(d, 'yyyy-MM-dd');
      if (days <= 90) return format(startOfWeek(d), 'yyyy-MM-dd');
      return format(startOfMonth(d), 'yyyy-MM');
    };

    rawData.registrations.forEach((r) => {
      const k = bucketFor(r.created_at);
      const b = buckets.get(k);
      if (b) b.registrations++;
    });
    rawData.earnings.forEach((r) => {
      const k = bucketFor(r.created_at);
      const b = buckets.get(k);
      if (b) b.earnings += Number(r.amount) || 0;
    });
    rawData.collections.forEach((r) => {
      const k = bucketFor(r.transaction_date);
      const b = buckets.get(k);
      if (b) b.collections += Number(r.amount) || 0;
    });

    return Array.from(buckets.values());
  }, [rawData, range, startDate]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-sm flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-primary" />
            Agent Activity Over Time
          </CardTitle>
          <Select value={range} onValueChange={(v) => setRange(v as TimeRange)}>
            <SelectTrigger className="w-[150px] h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(RANGES).map(([k, v]) => (
                <SelectItem key={k} value={k}>{v.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : chartData.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground py-12">No activity data for this period</p>
        ) : (
          <div className="h-[280px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} className="text-muted-foreground" />
                <YAxis yAxisId="left" tick={{ fontSize: 11 }} className="text-muted-foreground" />
                <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} className="text-muted-foreground" />
                <Tooltip
                  contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid hsl(var(--border))' }}
                  formatter={(value: number, name: string) => {
                    if (name === 'New Agents') return [value, 'New Agents'];
                    return [`UGX ${value.toLocaleString()}`, name];
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar yAxisId="left" dataKey="registrations" name="New Agents" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
                <Bar yAxisId="right" dataKey="earnings" name="Earnings" fill="hsl(var(--success))" radius={[3, 3, 0, 0]} />
                <Bar yAxisId="right" dataKey="collections" name="Collections" fill="hsl(var(--warning))" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
