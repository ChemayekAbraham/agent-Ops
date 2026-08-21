import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { KPICard } from './KPICard';
import { Globe, Eye, Layers, Timer, MousePointerClick, Smartphone, MapPin, Link2, FileText } from 'lucide-react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { format, parseISO } from 'date-fns';

type DailyRow = {
  day: string;
  visitors: number;
  pageviews: number;
  pageviews_per_visit: number;
  session_duration_seconds: number;
  bounce_rate: number;
};

type BreakdownRow = {
  dimension: string;
  label: string;
  visitors: number;
  period_start: string;
  period_end: string;
};

function formatDuration(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function BreakdownList({
  title,
  icon: Icon,
  rows,
}: {
  title: string;
  icon: typeof Globe;
  rows: BreakdownRow[];
}) {
  const max = rows.reduce((m, r) => Math.max(m, r.visitors), 0) || 1;
  return (
    <div className="rounded-2xl border border-border bg-card p-3 sm:p-4">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-semibold flex items-center gap-2">
          <Icon className="w-4 h-4 text-primary" /> {title}
        </h4>
        <span className="text-xs text-muted-foreground">Visitors</span>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No data for this period.</p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r) => (
            <div key={r.label} className="relative flex items-center justify-between rounded-md px-2 py-1.5 overflow-hidden">
              <div
                className="absolute inset-y-0 left-0 bg-primary/15 rounded-md"
                style={{ width: `${Math.max(3, (r.visitors / max) * 100)}%` }}
                aria-hidden
              />
              <span className="relative text-xs font-medium truncate pr-2">{r.label}</span>
              <span className="relative text-xs tabular-nums text-muted-foreground">
                {r.visitors.toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function WebTrafficAnalyticsSection() {
  const { data, isLoading } = useQuery({
    queryKey: ['cmo-web-traffic-analytics'],
    queryFn: async () => {
      const [dailyRes, breakdownRes] = await Promise.all([
        supabase
          .from('web_analytics_daily')
          .select('day, visitors, pageviews, pageviews_per_visit, session_duration_seconds, bounce_rate')
          .order('day', { ascending: true }),
        supabase
          .from('web_analytics_breakdown')
          .select('dimension, label, visitors, period_start, period_end')
          .order('visitors', { ascending: false }),
      ]);
      if (dailyRes.error) throw dailyRes.error;
      if (breakdownRes.error) throw breakdownRes.error;
      return {
        daily: (dailyRes.data || []) as DailyRow[],
        breakdown: (breakdownRes.data || []) as BreakdownRow[],
      };
    },
    staleTime: 300000,
  });

  const daily = data?.daily || [];
  const breakdown = data?.breakdown || [];

  const totalVisitors = daily.reduce((s, d) => s + d.visitors, 0);
  const totalPageviews = daily.reduce((s, d) => s + d.pageviews, 0);
  const perVisit = totalVisitors ? totalPageviews / totalVisitors : 0;
  const avgDuration = daily.length
    ? daily.reduce((s, d) => s + Number(d.session_duration_seconds), 0) / daily.length
    : 0;
  const avgBounce = daily.length
    ? daily.reduce((s, d) => s + Number(d.bounce_rate), 0) / daily.length
    : 0;

  const chartData = daily.map((d) => ({
    day: format(parseISO(d.day), 'dd MMM'),
    visitors: d.visitors,
    pageviews: d.pageviews,
  }));

  const rangeLabel = daily.length
    ? `${format(parseISO(daily[0].day), 'dd MMM yyyy')} → ${format(parseISO(daily[daily.length - 1].day), 'dd MMM yyyy')}`
    : 'No data yet';

  const byDim = (dim: string) => breakdown.filter((b) => b.dimension === dim).slice(0, 10);

  return (
    <section className="space-y-3 sm:space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold flex items-center gap-2">
          <Globe className="w-4 h-4 text-primary" /> Web Traffic Analytics
        </h3>
        <span className="text-xs text-muted-foreground">{rangeLabel}</span>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-2 sm:gap-3">
        <KPICard title="Visitors" value={totalVisitors.toLocaleString()} icon={Globe} loading={isLoading} />
        <KPICard title="Page Views" value={totalPageviews.toLocaleString()} icon={Eye} loading={isLoading} color="bg-blue-500/10 text-blue-600" />
        <KPICard title="Views per Visit" value={perVisit.toFixed(2)} icon={Layers} loading={isLoading} color="bg-purple-500/10 text-purple-600" />
        <KPICard title="Visit Duration" value={formatDuration(avgDuration)} icon={Timer} loading={isLoading} color="bg-emerald-500/10 text-emerald-600" />
        <KPICard title="Bounce Rate" value={`${Math.round(avgBounce)}%`} icon={MousePointerClick} loading={isLoading} color="bg-amber-500/10 text-amber-600" />
      </div>

      <div className="rounded-2xl border border-border bg-card p-3 sm:p-4">
        <h4 className="text-sm font-semibold mb-3">Visitors &amp; Page Views</h4>
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis dataKey="day" className="text-xs" />
            <YAxis className="text-xs" />
            <Tooltip />
            <Area type="monotone" dataKey="pageviews" name="Page views" fill="hsl(var(--muted-foreground)/0.15)" stroke="hsl(var(--muted-foreground))" />
            <Area type="monotone" dataKey="visitors" name="Visitors" fill="hsl(var(--primary)/0.2)" stroke="hsl(var(--primary))" />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2 sm:gap-3">
        <BreakdownList title="Top Pages" icon={FileText} rows={byDim('page')} />
        <BreakdownList title="Traffic Sources" icon={Link2} rows={byDim('source')} />
        <BreakdownList title="Devices" icon={Smartphone} rows={byDim('device')} />
        <BreakdownList title="Countries" icon={MapPin} rows={byDim('country')} />
      </div>
    </section>
  );
}