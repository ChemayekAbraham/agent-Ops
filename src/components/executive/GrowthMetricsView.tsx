import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { KPICard } from './KPICard';
import {
  TrendingUp,
  Users,
  UserPlus,
  Repeat,
  Share2,
  Activity,
  Percent,
  Sparkles,
  ArrowUpRight,
  ArrowDownRight,
} from 'lucide-react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import {
  format,
  subDays,
  subMonths,
  startOfDay,
  endOfDay,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  eachMonthOfInterval,
} from 'date-fns';
import { Button } from '@/components/ui/button';

type Range = '30d' | '90d' | '6m' | '12m';

const RANGE_OPTS: { value: Range; label: string }[] = [
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: '6m', label: 'Last 6 months' },
  { value: '12m', label: 'Last 12 months' },
];

function rangeBounds(r: Range): { start: Date; end: Date; granularity: 'day' | 'month' } {
  const now = new Date();
  switch (r) {
    case '30d':
      return { start: startOfDay(subDays(now, 29)), end: endOfDay(now), granularity: 'day' };
    case '90d':
      return { start: startOfDay(subDays(now, 89)), end: endOfDay(now), granularity: 'day' };
    case '6m':
      return { start: startOfMonth(subMonths(now, 5)), end: endOfMonth(now), granularity: 'month' };
    case '12m':
      return { start: startOfMonth(subMonths(now, 11)), end: endOfMonth(now), granularity: 'month' };
  }
}

const SOURCE_COLORS = [
  'hsl(var(--primary))',
  'hsl(24 95% 53%)',
  'hsl(142 71% 45%)',
  'hsl(262 83% 58%)',
  'hsl(46 96% 53%)',
  'hsl(199 89% 48%)',
  'hsl(340 82% 52%)',
];

export function GrowthMetricsView() {
  const [range, setRange] = useState<Range>('90d');
  const { start, end, granularity } = useMemo(() => rangeBounds(range), [range]);

  // ── 1. Signup trend (daily or monthly buckets) ──
  const { data: signupTrend, isLoading: loadingTrend } = useQuery({
    queryKey: ['growth-signup-trend', range],
    queryFn: async () => {
      const buckets = granularity === 'day'
        ? eachDayOfInterval({ start, end })
        : eachMonthOfInterval({ start, end });

      const rows = [] as { label: string; signups: number; referred: number; organic: number }[];
      let cumulative = 0;
      const withCumulative: { label: string; signups: number; referred: number; organic: number; cumulative: number }[] = [];

      for (const b of buckets) {
        const s = granularity === 'day' ? startOfDay(b) : startOfMonth(b);
        const e = granularity === 'day' ? endOfDay(b) : endOfMonth(b);

        const [{ count: total }, { count: referred }] = await Promise.all([
          supabase
            .from('profiles')
            .select('*', { count: 'exact', head: true })
            .gte('created_at', s.toISOString())
            .lte('created_at', e.toISOString()),
          supabase
            .from('profiles')
            .select('*', { count: 'exact', head: true })
            .gte('created_at', s.toISOString())
            .lte('created_at', e.toISOString())
            .not('referrer_id', 'is', null),
        ]);

        const signups = total || 0;
        const ref = referred || 0;
        cumulative += signups;
        withCumulative.push({
          label: format(s, granularity === 'day' ? 'dd MMM' : 'MMM yy'),
          signups,
          referred: ref,
          organic: Math.max(0, signups - ref),
          cumulative,
        });
      }
      return withCumulative;
    },
    staleTime: 300000,
  });

  // ── 2+3+4. Live KPIs, source mix and roles from one role-gated server function ──
  // (daily_platform_stats stopped updating in April 2026 and is not readable by CMO.)
  const { data: live, isLoading: loadingLive } = useQuery({
    queryKey: ['growth-live', range],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('get_growth_metrics_live', {
        p_start: start.toISOString(),
        p_end: end.toISOString(),
      });
      if (error) throw error;
      return data as any;
    },
    staleTime: 300000,
  });
  const loadingSnap = loadingLive;
  const loadingSources = loadingLive;
  const sourceBreakdown = (live?.sources ?? []) as { name: string; value: number }[];

  const roleData = useMemo(() => {
    const raw = live?.users_by_role;
    if (!raw || typeof raw !== 'object') return [];
    return Object.entries(raw as Record<string, number>)
      .map(([name, value]) => ({ name, value: Number(value) || 0 }))
      .filter((r) => r.value > 0)
      .sort((a, b) => b.value - a.value);
  }, [live]);

  // ── Derived deltas ──
  const totalUsers = Number(live?.total_users ?? 0);
  const totalUsersPrev = Number(live?.total_users_prev ?? 0);
  const active30 = Number(live?.active_users_30d ?? 0);
  // Sign-in history keeps only the latest sign-in, so a 30-days-ago active figure cannot be rebuilt.
  const active30Prev = active30;
  const retention = Number(live?.retention_pct ?? 0);
  const retentionPrev = retention;
  const referralPct = Number(live?.referral_pct ?? 0);
  const referralPctPrev = Number(live?.referral_pct_prev ?? 0);
  const newToday = Number(live?.new_users_today ?? 0);

  const pct = (curr: number, prev: number) =>
    prev <= 0 ? (curr > 0 ? 100 : 0) : Math.round(((curr - prev) / prev) * 100);

  const usersGrowth = pct(totalUsers, totalUsersPrev);
  const activeGrowth = pct(active30, active30Prev);
  const retentionDelta = Math.round(retention - retentionPrev);
  const referralPctDelta = Math.round(referralPct - referralPctPrev);

  const rangeSignups = (signupTrend || []).reduce((s, r) => s + r.signups, 0);
  const rangeReferred = (signupTrend || []).reduce((s, r) => s + r.referred, 0);
  const referralShare = rangeSignups > 0 ? Math.round((rangeReferred / rangeSignups) * 100) : 0;

  // Peak day / month
  const peak = (signupTrend || []).reduce(
    (best, r) => (r.signups > best.signups ? r : best),
    { label: '—', signups: 0, referred: 0, organic: 0, cumulative: 0 },
  );

  return (
    <div className="space-y-4">
      {/* Header + range selector */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-primary" />
            Growth Metrics
          </h2>
          <p className="text-xs text-muted-foreground">
            User acquisition, retention and referral contribution across the platform.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {RANGE_OPTS.map((opt) => (
            <Button
              key={opt.value}
              size="sm"
              variant={range === opt.value ? 'default' : 'outline'}
              onClick={() => setRange(opt.value)}
              className="text-xs"
            >
              {opt.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Row 1: platform-wide KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
        <KPICard
          title="Total Users"
          value={totalUsers.toLocaleString()}
          icon={Users}
          loading={loadingSnap}
          trend={{ value: usersGrowth, label: 'vs 30d ago' }}
        />
        <KPICard
          title="Active (30d)"
          value={active30.toLocaleString()}
          icon={Activity}
          loading={loadingSnap}
          color="bg-green-500/10 text-green-600"
          trend={{ value: activeGrowth, label: 'vs 30d ago' }}
        />
        <KPICard
          title="Retention"
          value={`${retention}%`}
          icon={Repeat}
          loading={loadingSnap}
          color="bg-blue-500/10 text-blue-600"
          trend={{ value: retentionDelta, label: 'pts vs 30d ago' }}
        />
        <KPICard
          title="Referral Share"
          value={`${referralPct}%`}
          icon={Share2}
          loading={loadingSnap}
          color="bg-purple-500/10 text-purple-600"
          trend={{ value: referralPctDelta, label: 'pts vs 30d ago' }}
        />
      </div>

      {/* Row 2: range-scoped KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
        <KPICard
          title="Signups in range"
          value={rangeSignups.toLocaleString()}
          icon={UserPlus}
          loading={loadingTrend}
          color="bg-emerald-500/10 text-emerald-600"
        />
        <KPICard
          title="Referred in range"
          value={rangeReferred.toLocaleString()}
          icon={Share2}
          loading={loadingTrend}
          color="bg-purple-500/10 text-purple-600"
        />
        <KPICard
          title="Referral contribution"
          value={`${referralShare}%`}
          icon={Percent}
          loading={loadingTrend}
          color="bg-amber-500/10 text-amber-600"
        />
        <KPICard
          title="New today"
          value={newToday.toLocaleString()}
          icon={Sparkles}
          loading={loadingSnap}
          color="bg-orange-500/10 text-orange-600"
        />
      </div>

      {/* Cumulative growth curve */}
      <div className="rounded-2xl border border-border bg-card p-3 sm:p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">Cumulative user base</h3>
          <span className="text-xs text-muted-foreground">
            Peak {granularity === 'day' ? 'day' : 'month'}:{' '}
            <span className="font-medium text-foreground">{peak.label}</span>
            {' · '}
            {peak.signups.toLocaleString()} signups
          </span>
        </div>
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={signupTrend || []}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis dataKey="label" className="text-xs" tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={12} />
            <YAxis className="text-xs" tick={{ fontSize: 10 }} width={40} tickFormatter={(v: number) => Math.abs(v)>=1e9?`${(v/1e9).toFixed(1)}B`:Math.abs(v)>=1e6?`${(v/1e6).toFixed(1)}M`:Math.abs(v)>=1e3?`${(v/1e3).toFixed(0)}K`:String(v)} />
            <Tooltip />
            <Area
              type="monotone"
              dataKey="cumulative"
              name="Cumulative signups"
              fill="hsl(var(--primary) / 0.2)"
              stroke="hsl(var(--primary))"
              strokeWidth={2}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Referred vs organic + source pie */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-4">
        <div className="rounded-2xl border border-border bg-card p-3 sm:p-4 lg:col-span-2">
          <h3 className="text-sm font-semibold mb-3">Referred vs organic signups</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={signupTrend || []}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="label" className="text-xs" tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={12} />
              <YAxis className="text-xs" tick={{ fontSize: 10 }} width={40} tickFormatter={(v: number) => Math.abs(v)>=1e9?`${(v/1e9).toFixed(1)}B`:Math.abs(v)>=1e6?`${(v/1e6).toFixed(1)}M`:Math.abs(v)>=1e3?`${(v/1e3).toFixed(0)}K`:String(v)} />
              <Tooltip />
              <Legend iconSize={8} wrapperStyle={{ fontSize: 11 }} />
              <Bar
                dataKey="referred"
                stackId="a"
                name="Referred"
                fill="hsl(262 83% 58%)"
                radius={[0, 0, 0, 0]}
              />
              <Bar
                dataKey="organic"
                stackId="a"
                name="Organic"
                fill="hsl(var(--primary))"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="rounded-2xl border border-border bg-card p-3 sm:p-4">
          <h3 className="text-sm font-semibold mb-3">Signup source mix</h3>
          {loadingSources ? (
            <div className="h-[240px] flex items-center justify-center text-xs text-muted-foreground">
              Loading…
            </div>
          ) : (sourceBreakdown || []).length === 0 ? (
            <div className="h-[240px] flex items-center justify-center text-xs text-muted-foreground">
              No signups in this range.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie
                  data={sourceBreakdown || []}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={45}
                  outerRadius={80}
                  paddingAngle={2}
                >
                  {(sourceBreakdown || []).map((_, i) => (
                    <Cell key={i} fill={SOURCE_COLORS[i % SOURCE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip />
                <Legend
                  layout="horizontal"
                  align="center"
                  verticalAlign="bottom"
                  iconSize={8}
                  wrapperStyle={{ fontSize: 11 }}
                />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Users by role */}
      <div className="rounded-2xl border border-border bg-card p-3 sm:p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">Users by role (current)</h3>
          <span className="text-xs text-muted-foreground">
            Live {live?.computed_at ? format(new Date(live.computed_at), 'dd MMM yyyy, HH:mm') : '—'}
          </span>
        </div>
        {roleData.length === 0 ? (
          <div className="h-[200px] flex items-center justify-center text-xs text-muted-foreground">
            No role snapshot available.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={Math.max(220, roleData.length * 30)}>
            <BarChart data={roleData} layout="vertical" margin={{ left: 4, right: 12 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis type="number" className="text-xs" tick={{ fontSize: 10 }} />
              <YAxis dataKey="name" type="category" width={84} tick={{ fontSize: 10 }} className="text-xs" />
              <Tooltip />
              <Bar dataKey="value" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Insight strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3 text-xs">
        <InsightCard
          label="Total user growth"
          delta={usersGrowth}
          suffix="%"
          hint="vs 30 days ago"
        />
        <InsightCard
          label="Active-user growth"
          delta={activeGrowth}
          suffix="%"
          hint="30-day cohort"
        />
        <InsightCard
          label="Retention shift"
          delta={retentionDelta}
          suffix=" pts"
          hint="vs 30 days ago"
        />
        <InsightCard
          label="Referral share shift"
          delta={referralPctDelta}
          suffix=" pts"
          hint="vs 30 days ago"
        />
      </div>
    </div>
  );
}

function InsightCard({
  label,
  delta,
  suffix,
  hint,
}: {
  label: string;
  delta: number;
  suffix: string;
  hint: string;
}) {
  const positive = delta >= 0;
  const Icon = positive ? ArrowUpRight : ArrowDownRight;
  return (
    <div className="rounded-xl border border-border bg-card p-3 flex items-center gap-3">
      <div
        className={`w-8 h-8 rounded-lg flex items-center justify-center ${
          positive ? 'bg-green-500/10 text-green-600' : 'bg-red-500/10 text-red-600'
        }`}
      >
        <Icon className="w-4 h-4" />
      </div>
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground truncate">{label}</div>
        <div className="flex items-baseline gap-1">
          <span className={`font-semibold text-sm ${positive ? 'text-green-600' : 'text-red-600'}`}>
            {positive ? '+' : ''}
            {delta}
            {suffix}
          </span>
          <span className="text-[10px] text-muted-foreground truncate">{hint}</span>
        </div>
      </div>
    </div>
  );
}

export default GrowthMetricsView;