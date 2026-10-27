import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  format,
  startOfDay,
  endOfDay,
  subDays,
  eachDayOfInterval,
  eachWeekOfInterval,
  eachMonthOfInterval,
  startOfWeek,
  startOfMonth,
  differenceInCalendarDays,
} from 'date-fns';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import { Share2, Users, Trophy, Percent, CalendarRange, UserCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { KPICard } from './KPICard';
import { ExecutiveDataTable, Column } from './ExecutiveDataTable';

type RangePreset = 'last_7' | 'last_30' | 'last_90' | 'last_180' | 'custom';
type Granularity = 'day' | 'week' | 'month';

interface ReferralRow {
  id: string;
  full_name: string | null;
  phone: string | null;
  created_at: string;
  signup_source: string | null;
}

interface ReferrerAggRow {
  referrer_id: string;
  full_name: string | null;
  phone: string | null;
  total: number;
  rate: number;
}

/** What get_referral_performance_summary returns: everything is aggregated in the database. */
interface PerfSummary {
  total_signups: number;
  excluded_referred: number;
  referred: number;
  active_referrers: number;
  trend: { bucket: string; count: number }[];
  sources: { source: string; count: number }[];
  top_referrers: { referrer_id: string; full_name: string | null; phone: string | null; total: number }[];
  recent: ReferralRow[];
}

/** Parses 'YYYY-MM-DD' as a LOCAL date; null when empty or invalid (a cleared date input). */
function parseLocalDate(value: string): Date | null {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 'funder-onboarding' -> 'Funder onboarding'. */
const humanize = (v: string) => {
  const t = v.replace(/[-_]+/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : v;
};

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
      return {
        start: startOfDay(parseLocalDate(cs) ?? subDays(now, 29)),
        end: endOfDay(parseLocalDate(ce) ?? now),
      };
  }
}

function bucketKey(d: Date, g: Granularity) {
  if (g === 'day') return format(d, 'yyyy-MM-dd');
  if (g === 'week') return format(startOfWeek(d, { weekStartsOn: 1 }), 'yyyy-MM-dd');
  return format(startOfMonth(d), 'yyyy-MM');
}

function bucketLabel(k: string, g: Granularity) {
  if (g === 'month') return format(new Date(`${k}-01T00:00:00`), 'MMM yyyy');
  return format(new Date(`${k}T00:00:00`), g === 'week' ? "MMM d 'wk'" : 'MMM d');
}

export function ReferralPerformanceView() {
  const now = new Date();
  const [preset, setPreset] = useState<RangePreset>('last_30');
  const [customStart, setCustomStart] = useState(format(subDays(now, 29), 'yyyy-MM-dd'));
  const [customEnd, setCustomEnd] = useState(format(now, 'yyyy-MM-dd'));

  const { start, end } = rangeBounds(preset, customStart, customEnd);
  // Changing one end past the other moves the other end too. A cleared input is ignored (it crashed the page).
  const changeCustomStart = (v: string) => { if (!v) return; setCustomStart(v); if (v > customEnd) setCustomEnd(v); };
  const changeCustomEnd = (v: string) => { if (!v) return; setCustomEnd(v); if (v < customStart) setCustomStart(v); };
  const spanDays = differenceInCalendarDays(end, start) + 1;
  const granularity: Granularity = spanDays <= 45 ? 'day' : spanDays <= 120 ? 'week' : 'month';

  // One server call returns only what the page shows (totals, trend buckets, source mix, top 25
  // referrers with names, 100 most recent). It used to download every referred signup in the range
  // (about 11 MB on 180 days) and count them in the browser. Suspected fake accounts (no phone and
  // never signed in) and deleted accounts are left out.
  const rangeKey = `${format(start, 'yyyy-MM-dd')}_${format(end, 'yyyy-MM-dd')}_${granularity}`;
  const { data: perf, isLoading: loadingRefs, isError } = useQuery({
    queryKey: ['referral-perf-summary', rangeKey],
    queryFn: async () => {
      // The function is newer than the generated database types, so call it through a narrow cast.
      const rpc = supabase as unknown as {
        rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: Error | null }>;
      };
      const { data, error } = await rpc.rpc('get_referral_performance_summary', {
        p_start: start.toISOString(),
        p_end: end.toISOString(),
        p_granularity: granularity,
      });
      if (error) throw error;
      return data as PerfSummary;
    },
    staleTime: 60_000,
  });
  const totalSignups = perf?.total_signups;
  const excludedReferred = perf?.excluded_referred ?? 0;
  const referredCount = perf?.referred ?? 0;
  const activeReferrerCount = perf?.active_referrers ?? 0;
  const recent = perf?.recent ?? [];

  // Fill empty buckets with zero so quiet days/weeks/months still show on the chart.
  const trendData = (() => {
    const counts = new Map<string, number>((perf?.trend ?? []).map((t) => [granularity === 'month' ? t.bucket.slice(0, 7) : t.bucket, t.count]));
    const keys: string[] =
      granularity === 'day'
        ? eachDayOfInterval({ start, end }).map((d) => bucketKey(d, 'day'))
        : granularity === 'week'
          ? eachWeekOfInterval({ start, end }, { weekStartsOn: 1 }).map((d) => bucketKey(d, 'week'))
          : eachMonthOfInterval({ start, end }).map((d) => bucketKey(d, 'month'));
    return keys.map((k) => ({ label: bucketLabel(k, granularity), count: counts.get(k) ?? 0 }));
  })();

  const sourceMix = (perf?.sources ?? []).map((x) => ({ source: humanize(x.source), count: x.count }));

  const maxTotal = Math.max(1, ...(perf?.top_referrers ?? []).map((r) => r.total));
  const leaderboard: ReferrerAggRow[] = (perf?.top_referrers ?? []).map((r) => ({
    ...r,
    rate: Math.round((r.total / maxTotal) * 100),
  }));

  const conversionPct = totalSignups && totalSignups > 0
    ? Math.round((referredCount / totalSignups) * 100)
    : 0;
  const avgPerReferrer = activeReferrerCount > 0
    ? (referredCount / activeReferrerCount).toFixed(1)
    : '0';

  const leaderboardColumns: Column<ReferrerAggRow>[] = [
    {
      key: 'full_name',
      label: 'Referrer',
      render: (_v, r) => (
        <div>
          <div className="font-medium text-sm">{r.full_name || 'Unknown user'}</div>
          <div className="text-xs text-muted-foreground">{r.phone || '—'}</div>
        </div>
      ),
    },
    { key: 'phone', label: 'Phone', render: (_v, r) => <span className="text-xs">{r.phone || '—'}</span> },
    { key: 'total', label: 'Referred', render: (_v, r) => <span className="font-semibold">{r.total}</span> },
    {
      key: 'rate',
      label: 'Share of top',
      render: (_v, r) => <span className="text-xs">{r.rate}%</span>,
    },
  ];

  const recentColumns: Column<ReferralRow>[] = [
    {
      key: 'full_name',
      label: 'New user',
      render: (_v, r) => (
        <div>
          <div className="font-medium text-sm">{r.full_name || 'Unknown'}</div>
          <div className="text-xs text-muted-foreground">{r.phone || '—'}</div>
        </div>
      ),
    },
    { key: 'signup_source', label: 'Source', render: (_v, r) => <span className="text-xs">{r.signup_source ? humanize(r.signup_source) : 'Unknown'}</span> },
    {
      key: 'created_at',
      label: 'Signed up',
      render: (_v, r) => <span className="text-xs">{format(new Date(r.created_at), 'MMM d, HH:mm')}</span>,
    },
  ];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold flex items-center gap-2">
            <Share2 className="h-5 w-5 text-primary" /> Referral Performance
          </h2>
          <p className="text-xs text-muted-foreground">
            Who is bringing new users in, how well they convert, and which channels perform.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(['last_7', 'last_30', 'last_90', 'last_180', 'custom'] as RangePreset[]).map((p) => (
            <Button
              key={p}
              size="sm"
              variant={preset === p ? 'default' : 'outline'}
              aria-pressed={preset === p}
              onClick={() => setPreset(p)}
            >
              {p === 'last_7' ? '7d' : p === 'last_30' ? '30d' : p === 'last_90' ? '90d' : p === 'last_180' ? '180d' : 'Custom'}
            </Button>
          ))}
        </div>
      </div>

      {preset === 'custom' && (
        <div className="flex flex-wrap items-end gap-2 rounded-lg border bg-card p-3">
          <div>
            <Label className="text-xs">Start</Label>
            <Input type="date" value={customStart} max={format(now, 'yyyy-MM-dd')} onChange={(e) => changeCustomStart(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">End</Label>
            <Input type="date" value={customEnd} max={format(now, 'yyyy-MM-dd')} onChange={(e) => changeCustomEnd(e.target.value)} />
          </div>
          <div className="text-xs text-muted-foreground flex items-center gap-1">
            <CalendarRange className="h-3.5 w-3.5" /> {spanDays} day window · bucketed by {granularity}
          </div>
        </div>
      )}

      {isError && (
        <p className="text-xs text-red-500">
          Some figures could not be loaded, so zeros below may be missing data. Please refresh and try again.
        </p>
      )}

      {excludedReferred > 0 && (
        <p className="text-xs text-muted-foreground">
          {excludedReferred.toLocaleString()} suspected fake referred accounts (no phone number and never signed in) are left out of these figures.
        </p>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPICard
          title="Referred signups"
          loading={loadingRefs}
          value={referredCount}
          icon={UserCheck}
          color="bg-primary/10 text-primary"
        />
        <KPICard
          title="Active referrers"
          loading={loadingRefs}
          value={activeReferrerCount}
          icon={Users}
          color="bg-purple-500/10 text-purple-600"
        />
        <KPICard
          title="Referral share"
          loading={loadingRefs}
          value={`${conversionPct}%`}
          subtitle={`${referredCount} of ${totalSignups ?? 0} signups`}
          icon={Percent}
          color="bg-amber-500/10 text-amber-600"
        />
        <KPICard
          title="Avg per referrer"
          loading={loadingRefs}
          value={avgPerReferrer}
          subtitle="Signups / active referrer"
          icon={Trophy}
          color="bg-green-500/10 text-green-600"
        />
      </div>

      {/* Trend */}
      <div className="rounded-lg border bg-card p-4">
        <h3 className="text-sm font-semibold mb-3">Referred signups over time</h3>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={trendData}>
              <defs>
                <linearGradient id="refGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--muted))" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip />
              <Area
                type="monotone"
                dataKey="count"
                stroke="hsl(var(--primary))"
                fill="url(#refGrad)"
                name="Referred"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Source mix */}
      <div className="grid grid-cols-1 gap-4">
        <div className="rounded-lg border bg-card p-4">
          <h3 className="text-sm font-semibold mb-3">Signup source mix</h3>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={sourceMix} layout="vertical" margin={{ left: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--muted))" />
                <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                <YAxis type="category" dataKey="source" tick={{ fontSize: 11 }} width={110} />
                <Tooltip />
                <Bar dataKey="count" fill="hsl(var(--primary))" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Leaderboard */}
      <div className="rounded-lg border bg-card p-4">
        <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Trophy className="h-4 w-4 text-amber-500" /> Top referrers
        </h3>
        <ExecutiveDataTable
          data={leaderboard}
          columns={leaderboardColumns}
          loading={loadingRefs}
          title="Top referrers"
        />
      </div>

      {/* Recent referrals */}
      <div className="rounded-lg border bg-card p-4">
        <h3 className="text-sm font-semibold mb-3">Recent referred signups</h3>
        <ExecutiveDataTable
          data={recent}
          columns={recentColumns}
          loading={loadingRefs}
          title="Recent referrals"
        />
      </div>
    </div>
  );
}

export default ReferralPerformanceView;