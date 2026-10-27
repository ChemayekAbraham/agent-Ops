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

/** 'funder-onboarding' / 'tenant_ops' -> 'Funder onboarding' / 'Tenant ops'. */
const humanize = (v: string) => {
  const t = v.replace(/[-_]+/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : v;
};

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

  // The days actually shown. Query keys use this so a range refreshes after midnight instead of
  // serving yesterday's cached window.
  const rangeKey = `${range}_${format(start, 'yyyy-MM-dd')}_${format(end, 'yyyy-MM-dd')}`;

  // ── 1. Signup trend (daily or monthly buckets) ──
  // One server call (live accounts only, Kampala days) instead of two requests per day/month; the
  // 90-day view used to fire ~180 sequential requests and counted deleted bot accounts.
  const { data: signupTrend, isLoading: loadingTrend, isError: trendError } = useQuery({
    queryKey: ['growth-signup-trend-v2', rangeKey],
    queryFn: async () => {
      const [{ data, error }, { count: before, error: beforeError }] = await Promise.all([
        supabase.rpc('get_daily_signups', { p_start: start.toISOString(), p_end: end.toISOString() }),
        // Users who already existed when the range began: the starting point of the cumulative curve.
        supabase.from('profiles').select('id', { count: 'exact', head: true })
          .is('deleted_at', null).lt('created_at', start.toISOString()),
      ]);
      if (error) throw error;
      if (beforeError) throw beforeError;

      const keyOf = (d: Date) => format(d, granularity === 'day' ? 'yyyy-MM-dd' : 'yyyy-MM');
      const buckets = granularity === 'day'
        ? eachDayOfInterval({ start, end })
        : eachMonthOfInterval({ start, end });
      const sums = new Map<string, { signups: number; referred: number }>();
      buckets.forEach((b) => sums.set(keyOf(b), { signups: 0, referred: 0 }));
      for (const r of data || []) {
        const day = String(r.day).slice(0, 10);
        const cur = sums.get(granularity === 'day' ? day : day.slice(0, 7));
        if (!cur) continue;
        cur.signups += Number(r.signups) || 0;
        cur.referred += Number(r.referred) || 0;
      }

      let cumulative = before || 0;
      return buckets.map((b) => {
        const v = sums.get(keyOf(b))!;
        cumulative += v.signups;
        return {
          label: format(b, granularity === 'day' ? 'dd MMM' : 'MMM yy'),
          signups: v.signups,
          referred: v.referred,
          organic: Math.max(0, v.signups - v.referred),
          cumulative,
        };
      });
    },
    staleTime: 300000,
  });

  // ── 2+3. Platform snapshot and source mix: two role-gated server functions ──
  // (daily_platform_stats stopped updating in April 2026 and is not readable by CMO.)
  // The snapshot does not depend on the range, so it is fetched once and kept for 5 minutes:
  // clicking a range button only refetches the signups and the (cheap) source mix. Previously one
  // function recomputed everything, ~1 s, on every click.
  type GrowthSnapshot = {
    total_users: number; total_users_prev: number; new_users_today: number;
    referral_pct: number | null; referral_pct_prev: number | null;
    active_users_30d: number; retention_pct: number | null;
    users_by_role: Record<string, number>; computed_at: string;
  };
  // The functions are newer than the generated database types, so call them through a narrow cast.
  const rpc = supabase as unknown as {
    rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: Error | null }>;
  };
  const { data: live, isLoading: loadingSnap, isError: snapError } = useQuery({
    queryKey: ['growth-snapshot'],
    queryFn: async () => {
      const { data, error } = await rpc.rpc('get_growth_snapshot_live');
      if (error) throw error;
      return data as GrowthSnapshot;
    },
    staleTime: 300000,
  });
  const { data: sourcesData, isLoading: loadingSources, isError: sourcesError } = useQuery({
    queryKey: ['growth-sources', rangeKey],
    queryFn: async () => {
      const { data, error } = await rpc.rpc('get_growth_sources_live', {
        p_start: start.toISOString(),
        p_end: end.toISOString(),
      });
      if (error) throw error;
      return (data ?? []) as { name: string; value: number }[];
    },
    staleTime: 300000,
  });
  const sourceBreakdown = (sourcesData ?? []).map((x) => ({ ...x, name: humanize(x.name) }));

  const roleData = useMemo(() => {
    const raw = live?.users_by_role;
    if (!raw || typeof raw !== 'object') return [];
    return Object.entries(raw as Record<string, number>)
      .map(([name, value]) => ({ name: humanize(name), value: Number(value) || 0 }))
      .filter((r) => r.value > 0)
      .sort((a, b) => b.value - a.value);
  }, [live]);

  // ── Derived deltas ──
  const totalUsers = Number(live?.total_users ?? 0);
  const totalUsersPrev = Number(live?.total_users_prev ?? 0);
  const active30 = Number(live?.active_users_30d ?? 0);
  // Sign-in history keeps only the latest sign-in, so a 30-days-ago active/retention figure cannot
  // be rebuilt. Those two cards therefore show no trend rather than a made-up "0%".
  const retention = Number(live?.retention_pct ?? 0);
  const referralPct = Number(live?.referral_pct ?? 0);
  const referralPctPrev = Number(live?.referral_pct_prev ?? 0);
  const newToday = Number(live?.new_users_today ?? 0);

  const pct = (curr: number, prev: number) =>
    prev <= 0 ? (curr > 0 ? 100 : 0) : Math.round(((curr - prev) / prev) * 100);

  const usersGrowth = pct(totalUsers, totalUsersPrev);
  const referralPctDelta = Math.round((referralPct - referralPctPrev) * 10) / 10;

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
              aria-pressed={range === opt.value}
              onClick={() => setRange(opt.value)}
              className="text-xs"
            >
              {opt.label}
            </Button>
          ))}
        </div>
      </div>

      {(trendError || snapError || sourcesError) && (
        <p className="text-xs text-red-500">
          Some figures could not be loaded, so zeros below may be missing data. Please refresh and try again.
        </p>
      )}

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
          subtitle="signed in within 30 days"
        />
        <KPICard
          title="Retention"
          value={`${retention}%`}
          icon={Repeat}
          loading={loadingSnap}
          color="bg-blue-500/10 text-blue-600"
          subtitle="joined 30+ days ago, still signing in"
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
        {loadingTrend ? (
          <div className="h-[240px] flex items-center justify-center text-xs text-muted-foreground">Loading…</div>
        ) : (
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
        )}
      </div>

      {/* Referred vs organic + source pie */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-4">
        <div className="rounded-2xl border border-border bg-card p-3 sm:p-4 lg:col-span-2">
          <h3 className="text-sm font-semibold mb-3">Referred vs organic signups</h3>
          {loadingTrend ? (
          <div className="h-[240px] flex items-center justify-center text-xs text-muted-foreground">Loading…</div>
        ) : (
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
        )}
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
            {loadingSnap ? 'Loading…' : 'No role snapshot available.'}
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
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-3 text-xs">
        <InsightCard
          label="Total user growth"
          delta={usersGrowth}
          suffix="%"
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