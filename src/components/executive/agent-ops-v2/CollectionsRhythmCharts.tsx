import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format, parseISO, startOfDay, endOfDay } from 'date-fns';
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Cell,
} from 'recharts';
import { Clock } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatUGX } from '@/lib/rentCalculations';

interface Props {
  /** yyyy-MM-dd */
  from?: string;
  /** yyyy-MM-dd */
  to?: string;
}

const num = (v: any) => Number(v ?? 0);
const compact = (v: number) =>
  v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1_000 ? `${Math.round(v / 1_000)}K` : `${v}`;

const hourLabel = (h: number) => {
  const suffix = h < 12 ? 'AM' : 'PM';
  const base = h % 12 === 0 ? 12 : h % 12;
  return `${base} ${suffix}`;
};

function bucketLabel(bucketStr: string, bucket: string): string {
  if (bucket === 'hour') {
    const h = Number(bucketStr.slice(11, 13));
    return Number.isFinite(h) ? hourLabel(h) : bucketStr.slice(11, 16);
  }
  if (bucket === 'month') {
    const d = new Date(`${bucketStr.slice(0, 7)}-01T00:00:00`);
    return isNaN(d.getTime()) ? bucketStr : format(d, 'MMM yyyy');
  }
  const d = new Date(`${bucketStr.slice(0, 10)}T00:00:00`);
  return isNaN(d.getTime()) ? bucketStr : format(d, 'EEEE d MMM');
}

interface RhythmPayload {
  series: { bucket: string; collected: number }[];
  peak_hours: { hour: number; amount: number; count: number }[];
}

/**
 * Collections trend + peak payment hours. Presentation only — reads the same
 * read-only command-center RPC used elsewhere.
 */
export function CollectionsRhythmCharts({ from, to }: Props) {
  const { start, end, bucket } = useMemo(() => {
    const now = new Date();
    const s = from ? startOfDay(parseISO(from)) : startOfDay(now);
    const e = to ? endOfDay(parseISO(to)) : endOfDay(now);
    const days = Math.max(1, Math.round((e.getTime() - s.getTime()) / 86_400_000));
    return { start: s, end: e, bucket: days <= 1 ? 'hour' : days <= 62 ? 'day' : 'month' };
  }, [from, to]);

  const { data } = useQuery({
    queryKey: ['collections-rhythm', start.toISOString(), end.toISOString(), bucket],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_collections_command_center', {
        p_start: start.toISOString(),
        p_end: end.toISOString(),
        p_bucket: bucket,
      });
      if (error) throw error;
      return data as unknown as RhythmPayload;
    },
    staleTime: 60_000,
  });

  const series = (data?.series ?? []).map(s => ({
    label: bucketLabel(s.bucket, bucket),
    collected: num(s.collected),
  }));
  const peak = (data?.peak_hours ?? []).map(h => ({
    ...h, amount: num(h.amount), count: num(h.count), label: hourLabel(h.hour),
  }));
  const peakMax = Math.max(1, ...peak.map(p => p.amount));
  const topHour = peak.reduce((a, b) => (b.amount > (a?.amount ?? -1) ? b : a), peak[0]);

  return (
    <div className="space-y-4">
      {/* Trend */}
      <Card className="p-3">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">Collections trend</h3>
          <Badge variant="outline" className="text-[10px]">per {bucket}</Badge>
        </div>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series}>
              <defs>
                <linearGradient id="rhythmCollGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.5} />
                  <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
              <YAxis tickFormatter={compact} tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
              <Tooltip formatter={(v: any, n: any) => [formatUGX(Number(v)), n === 'collected' ? 'Collected' : n]} />
              <Area type="monotone" dataKey="collected" stroke="hsl(var(--primary))" fill="url(#rhythmCollGrad)" strokeWidth={2} name="Collected" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Card>

      {/* Peak hours */}
      <Card className="p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-amber-600" />
            <h3 className="text-sm font-semibold">Peak payment hours</h3>
          </div>
          {topHour && topHour.amount > 0 && (
            <Badge className="text-[10px] bg-amber-500/15 text-amber-700 border-amber-500/30">
              Peak {hourLabel(topHour.hour)} · {formatUGX(topHour.amount)}
            </Badge>
          )}
        </div>
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={peak}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="label" tick={{ fontSize: 9 }} interval={1} stroke="hsl(var(--muted-foreground))" />
              <YAxis tickFormatter={compact} tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
              <Tooltip formatter={(v: any) => formatUGX(Number(v))} labelFormatter={(l: any) => `${l} (EAT)`} />
              <Bar dataKey="amount" name="Collected" radius={[3, 3, 0, 0]}>
                {peak.map(p => (
                  <Cell key={p.hour} fill={p.amount >= peakMax * 0.75 ? 'hsl(38 92% 50%)' : 'hsl(var(--primary))'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <p className="text-[11px] text-muted-foreground mt-1">
          Hour of day when tenants' rent payments are recorded, in East Africa Time.
        </p>
      </Card>
    </div>
  );
}
