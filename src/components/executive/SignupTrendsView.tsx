import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  format,
  startOfDay,
  endOfDay,
  subDays,
  differenceInCalendarDays,
} from 'date-fns';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import { UserCheck, UserPlus, Share2, TrendingUp, CalendarRange } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { KPICard } from './KPICard';
import { ExecutiveDataTable, Column } from './ExecutiveDataTable';

type RangePreset = 'last_7' | 'last_30' | 'last_90' | 'last_180' | 'custom';
type Granularity = 'day' | 'week' | 'month';

interface TrendsRPC {
  totals: { total: number; referred: number };
  buckets: { bucket: string; total: number; referred: number; organic: number }[];
  dow: { d: number; c: number }[];
  source_mix: { name: string; value: number }[];
  top_days: { day: string; c: number }[];
  recent: {
    id: string;
    full_name: string | null;
    phone: string | null;
    created_at: string;
    referrer_id: string | null;
    signup_source: string | null;
  }[];
}

function rangeBounds(preset: RangePreset, cs: string, ce: string) {
  const now = new Date();
  switch (preset) {
    case 'last_7':
      return { start: startOfDay(subDays(now, 6)), end: endOfDay(now) };
    case 'last_30':
      return { start: startOfDay(subDays(now, 29)), end: endOfDay(now) };
    case 'last_90':
      return { start: startOfDay(subDays(now, 89)), end: endOfDay(now) };
    case 'last_180':
      return { start: startOfDay(subDays(now, 179)), end: endOfDay(now) };
    case 'custom':
      return { start: startOfDay(new Date(cs)), end: endOfDay(new Date(ce)) };
  }
}

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SOURCE_COLORS = ['hsl(var(--primary))', 'hsl(var(--muted-foreground))', 'hsl(24 95% 53%)', 'hsl(142 71% 45%)', 'hsl(262 83% 58%)'];

export function SignupTrendsView() {
  const now = new Date();
  const [preset, setPreset] = useState<RangePreset>('last_30');
  const [customStart, setCustomStart] = useState(format(subDays(now, 29), 'yyyy-MM-dd'));
  const [customEnd, setCustomEnd] = useState(format(now, 'yyyy-MM-dd'));

  const { start, end } = rangeBounds(preset, customStart, customEnd);
  const spanDays = differenceInCalendarDays(end, start) + 1;
  const granularity: Granularity = spanDays <= 45 ? 'day' : spanDays <= 120 ? 'week' : 'month';

  const prevStart = new Date(start.getTime() - spanDays * 86400000);
  const prevEnd = new Date(start.getTime() - 1);

  // Single server-side aggregation RPC — no client-side row pagination.
  const { data: trends, isLoading } = useQuery({
    queryKey: ['signup-trends-rpc', start.toISOString(), end.toISOString(), granularity],
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<TrendsRPC> => {
      const { data, error } = await supabase.rpc('get_signup_trends', {
        p_start: start.toISOString(),
        p_end: end.toISOString(),
        p_granularity: granularity,
      });
      if (error) throw error;
      return data as unknown as TrendsRPC;
    },
  });

  const { data: prevCount } = useQuery({
    queryKey: ['signup-trends-prev-total', prevStart.toISOString(), prevEnd.toISOString()],
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<number> => {
      const { data, error } = await supabase.rpc('get_signup_totals_range', {
        p_start: prevStart.toISOString(),
        p_end: prevEnd.toISOString(),
      });
      if (error) throw error;
      return (data as { total?: number } | null)?.total ?? 0;
    },
  });

  const totalSignups = trends?.totals?.total ?? 0;
  const referred = trends?.totals?.referred ?? 0;
  const organic = Math.max(0, totalSignups - referred);
  const referralShare = totalSignups > 0 ? Math.round((referred / totalSignups) * 100) : 0;
  const growthPct = (prevCount || 0) > 0 ? Math.round(((totalSignups - (prevCount || 0)) / (prevCount || 0)) * 100) : 0;
  const avgPerDay = spanDays > 0 ? Math.round(totalSignups / spanDays) : 0;

  const labelFor = (iso: string) => {
    const d = new Date(iso);
    if (granularity === 'month') return format(d, 'MMM yyyy');
    return format(d, 'MMM d');
  };

  const trend = (trends?.buckets ?? []).map((b) => ({
    key: b.bucket,
    label: labelFor(b.bucket),
    total: b.total,
    referred: b.referred,
    organic: b.organic,
  }));

  const dow = (() => {
    const counts = Array(7).fill(0);
    for (const r of trends?.dow ?? []) counts[r.d] = r.c;
    return counts.map((v, i) => ({ day: DOW_LABELS[i], signups: v }));
  })();

  const sourceMix = (trends?.source_mix ?? []).map((s) => ({ name: s.name, value: s.value }));

  const topDays = (trends?.top_days ?? []).map((t) => ({
    date: t.day,
    signups: t.c,
    label: format(new Date(t.day), 'EEE, MMM d'),
  }));

  const recent = (trends?.recent ?? []).map((r) => ({
    id: r.id,
    when: format(new Date(r.created_at), 'MMM d, HH:mm'),
    name: r.full_name || '—',
    phone: r.phone || '—',
    source: r.referrer_id ? 'Referral' : r.signup_source ? r.signup_source : 'Direct',
  }));

  const recentColumns: Column<(typeof recent)[number]>[] = [
    { key: 'when', label: 'When' },
    { key: 'name', label: 'Name' },
    { key: 'phone', label: 'Phone' },
    {
      key: 'source',
      label: 'Source',
      render: (v) => {
        const isRef = String(v) === 'Referral';
        return (
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${
              isRef ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
            }`}
          >
            {String(v)}
          </span>
        );
      },
    },
  ];

  const topDaysColumns: Column<(typeof topDays)[number]>[] = [
    { key: 'label', label: 'Day' },
    { key: 'signups', label: 'Signups', render: (v) => <span className="font-semibold">{v as number}</span> },
  ];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="p-2.5 rounded-xl bg-primary/10 text-primary">
          <UserCheck className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-bold">Signup Trends</h2>
          <p className="text-xs text-muted-foreground">
            {format(start, 'MMM d, yyyy')} → {format(end, 'MMM d, yyyy')} · {granularity} view
          </p>
        </div>
      </div>

      {/* Range selector */}
      <div className="rounded-2xl border border-border bg-card p-3 sm:p-4 space-y-3">
        <div className="flex items-center gap-2">
          <CalendarRange className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Date range</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {(
            [
              { v: 'last_7', l: '7 days' },
              { v: 'last_30', l: '30 days' },
              { v: 'last_90', l: '90 days' },
              { v: 'last_180', l: '180 days' },
              { v: 'custom', l: 'Custom' },
            ] as { v: RangePreset; l: string }[]
          ).map((opt) => (
            <Button
              key={opt.v}
              size="sm"
              variant={preset === opt.v ? 'default' : 'outline'}
              onClick={() => setPreset(opt.v)}
            >
              {opt.l}
            </Button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Start</Label>
              <Input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">End</Label>
              <Input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} />
            </div>
          </div>
        )}
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
        <KPICard
          title="Signups"
          value={totalSignups.toLocaleString()}
          icon={UserPlus}
          loading={isLoading}
          trend={prevCount !== undefined ? { value: growthPct, label: 'vs prev period' } : undefined}
        />
        <KPICard
          title="Avg / day"
          value={avgPerDay.toLocaleString()}
          icon={TrendingUp}
          color="bg-green-500/10 text-green-600"
          loading={isLoading}
        />
        <KPICard
          title="Referred"
          value={referred.toLocaleString()}
          icon={Share2}
          color="bg-purple-500/10 text-purple-600"
          loading={isLoading}
          subtitle={`${referralShare}% share`}
        />
        <KPICard
          title="Organic"
          value={organic.toLocaleString()}
          icon={UserCheck}
          color="bg-orange-500/10 text-orange-600"
          loading={isLoading}
          subtitle={`${100 - referralShare}% share`}
        />
      </div>

      {/* Main trend chart */}
      <div className="rounded-2xl border border-border bg-card p-3 sm:p-4">
        <div className="flex items-center justify-between mb-3 gap-2">
          <h3 className="text-sm font-semibold">Signups over time</h3>
        </div>
        {trend.length === 0 ? (
          <p className="text-xs text-muted-foreground py-12 text-center">No signups in this range.</p>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={trend}>
              <defs>
                <linearGradient id="referredG" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.7} />
                  <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.05} />
                </linearGradient>
                <linearGradient id="organicG" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(var(--muted-foreground))" stopOpacity={0.5} />
                  <stop offset="100%" stopColor="hsl(var(--muted-foreground))" stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="label" className="text-[10px]" />
              <YAxis allowDecimals={false} className="text-[10px]" />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Area
                type="monotone"
                stackId="1"
                dataKey="organic"
                name="Organic"
                stroke="hsl(var(--muted-foreground))"
                fill="url(#organicG)"
              />
              <Area
                type="monotone"
                stackId="1"
                dataKey="referred"
                name="Referred"
                stroke="hsl(var(--primary))"
                fill="url(#referredG)"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Day-of-week + source pie */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
        <div className="rounded-2xl border border-border bg-card p-3 sm:p-4">
          <h3 className="text-sm font-semibold mb-3">Signups by day of week</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={dow}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="day" className="text-[10px]" />
              <YAxis allowDecimals={false} className="text-[10px]" />
              <Tooltip />
              <Bar dataKey="signups" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="rounded-2xl border border-border bg-card p-3 sm:p-4">
          <h3 className="text-sm font-semibold mb-3">Source mix</h3>
          {sourceMix.length === 0 ? (
            <p className="text-xs text-muted-foreground py-12 text-center">No data.</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={sourceMix} dataKey="value" nameKey="name" innerRadius={50} outerRadius={85} paddingAngle={2}>
                  {sourceMix.map((_, i) => (
                    <Cell key={i} fill={SOURCE_COLORS[i % SOURCE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Top days + recent signups */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
        <div className="rounded-2xl border border-border bg-card p-3 sm:p-4">
          <h3 className="text-sm font-semibold mb-3">Top acquisition days</h3>
          <ExecutiveDataTable data={topDays} columns={topDaysColumns} loading={isLoading} />
        </div>
        <div className="rounded-2xl border border-border bg-card p-3 sm:p-4">
          <h3 className="text-sm font-semibold mb-3">Recent signups</h3>
          <ExecutiveDataTable data={recent} columns={recentColumns} loading={isLoading} />
        </div>
      </div>
    </div>
  );
}