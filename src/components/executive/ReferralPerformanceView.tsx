import { useMemo, useState } from 'react';
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
  referrer_id: string;
  signup_source: string | null;
}

interface ReferrerAggRow {
  referrer_id: string;
  full_name: string | null;
  phone: string | null;
  total: number;
  rate: number;
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

function bucketKey(d: Date, g: Granularity) {
  if (g === 'day') return format(d, 'yyyy-MM-dd');
  if (g === 'week') return format(startOfWeek(d, { weekStartsOn: 1 }), 'yyyy-MM-dd');
  return format(startOfMonth(d), 'yyyy-MM');
}

function bucketLabel(k: string, g: Granularity) {
  if (g === 'month') return format(new Date(k + '-01'), 'MMM yyyy');
  return format(new Date(k), g === 'week' ? "MMM d 'wk'" : 'MMM d');
}

export function ReferralPerformanceView() {
  const now = new Date();
  const [preset, setPreset] = useState<RangePreset>('last_30');
  const [customStart, setCustomStart] = useState(format(subDays(now, 29), 'yyyy-MM-dd'));
  const [customEnd, setCustomEnd] = useState(format(now, 'yyyy-MM-dd'));

  const { start, end } = rangeBounds(preset, customStart, customEnd);
  const spanDays = differenceInCalendarDays(end, start) + 1;
  const granularity: Granularity = spanDays <= 45 ? 'day' : spanDays <= 120 ? 'week' : 'month';

  // All referred signups in range (paginated; capped for safety)
  const { data: referrals, isLoading: loadingRefs } = useQuery({
    queryKey: ['referral-perf-rows', start.toISOString(), end.toISOString()],
    queryFn: async () => {
      const rows: ReferralRow[] = [];
      const pageSize = 1000;
      for (let from = 0; from < 20000; from += pageSize) {
        const { data, error } = await supabase
          .from('profiles')
          .select('id, full_name, phone, created_at, referrer_id, signup_source')
          .not('referrer_id', 'is', null)
          .gte('created_at', start.toISOString())
          .lte('created_at', end.toISOString())
          .order('created_at', { ascending: false })
          .range(from, from + pageSize - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        rows.push(...(data as unknown as ReferralRow[]));
        if (data.length < pageSize) break;
      }
      return rows;
    },
    staleTime: 60_000,
  });

  // Total signups in range (organic + referred) for conversion rate
  const { data: totalSignups } = useQuery({
    queryKey: ['referral-perf-total', start.toISOString(), end.toISOString()],
    queryFn: async () => {
      const { count, error } = await supabase
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', start.toISOString())
        .lte('created_at', end.toISOString());
      if (error) throw error;
      return count || 0;
    },
    staleTime: 60_000,
  });

  // Enrich top referrers with name/phone/role
  const topReferrerIds = useMemo(() => {
    if (!referrals) return [] as string[];
    const counts = new Map<string, number>();
    referrals.forEach((r) => counts.set(r.referrer_id, (counts.get(r.referrer_id) || 0) + 1));
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50)
      .map(([id]) => id);
  }, [referrals]);

  const { data: referrerProfiles } = useQuery({
    queryKey: ['referral-perf-referrers', topReferrerIds.join(',')],
    queryFn: async () => {
      if (topReferrerIds.length === 0) return [] as ReferrerAggRow[];
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, phone')
        .in('id', topReferrerIds);
      if (error) throw error;
      return data || [];
    },
    enabled: topReferrerIds.length > 0,
    staleTime: 60_000,
  });

  // Aggregations
  const {
    trendData,
    sourceMix,
    leaderboard,
    referredCount,
  } = useMemo(() => {
    const list = referrals || [];
    const referredCount = list.length;
    // Trend buckets
    const buckets = new Map<string, number>();
    if (granularity === 'day') {
      eachDayOfInterval({ start, end }).forEach((d) => buckets.set(bucketKey(d, 'day'), 0));
    } else if (granularity === 'week') {
      eachWeekOfInterval({ start, end }, { weekStartsOn: 1 }).forEach((d) => buckets.set(bucketKey(d, 'week'), 0));
    } else {
      eachMonthOfInterval({ start, end }).forEach((d) => buckets.set(bucketKey(d, 'month'), 0));
    }
    list.forEach((r) => {
      const k = bucketKey(new Date(r.created_at), granularity);
      buckets.set(k, (buckets.get(k) || 0) + 1);
    });
    const trendData = Array.from(buckets.entries()).map(([k, v]) => ({
      label: bucketLabel(k, granularity),
      count: v,
    }));

    // Source mix (signup_source)
    const sourceMap = new Map<string, number>();
    list.forEach((r) => {
      const s = r.signup_source || 'unknown';
      sourceMap.set(s, (sourceMap.get(s) || 0) + 1);
    });
    const sourceMix = Array.from(sourceMap.entries())
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count);

    // Leaderboard
    const byRef = new Map<string, { total: number }>();
    list.forEach((r) => {
      const cur = byRef.get(r.referrer_id) || { total: 0 };
      cur.total += 1;
      byRef.set(r.referrer_id, cur);
    });
    const nameById = new Map<string, { full_name: string | null; phone: string | null }>();
    (referrerProfiles || []).forEach((p: any) => nameById.set(p.id, p));
    const maxTotal = Math.max(1, ...Array.from(byRef.values()).map((v) => v.total));
    const leaderboard: ReferrerAggRow[] = Array.from(byRef.entries())
      .map(([id, v]) => ({
        referrer_id: id,
        full_name: nameById.get(id)?.full_name || null,
        phone: nameById.get(id)?.phone || null,
        total: v.total,
        rate: Math.round((v.total / maxTotal) * 100),
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 25);

    return { trendData, sourceMix, leaderboard, referredCount };
  }, [referrals, referrerProfiles, granularity, start, end]);

  const activeReferrerCount = useMemo(() => {
    if (!referrals) return 0;
    return new Set(referrals.map((r) => r.referrer_id)).size;
  }, [referrals]);

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
    { key: 'signup_source', label: 'Source', render: (_v, r) => <span className="text-xs">{r.signup_source || 'unknown'}</span> },
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
            <Input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">End</Label>
            <Input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} />
          </div>
          <div className="text-xs text-muted-foreground flex items-center gap-1">
            <CalendarRange className="h-3.5 w-3.5" /> {spanDays} day window · bucketed by {granularity}
          </div>
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPICard
          title="Referred signups"
          value={referredCount}
          icon={UserCheck}
          color="bg-primary/10 text-primary"
        />
        <KPICard
          title="Active referrers"
          value={activeReferrerCount}
          icon={Users}
          color="bg-purple-500/10 text-purple-600"
        />
        <KPICard
          title="Referral share"
          value={`${conversionPct}%`}
          subtitle={`${referredCount} of ${totalSignups ?? 0} signups`}
          icon={Percent}
          color="bg-amber-500/10 text-amber-600"
        />
        <KPICard
          title="Avg per referrer"
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
          data={(referrals || []).slice(0, 100)}
          columns={recentColumns}
          loading={loadingRefs}
          title="Recent referrals"
        />
      </div>
    </div>
  );
}

export default ReferralPerformanceView;