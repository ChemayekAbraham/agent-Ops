import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { KPICard } from './KPICard';
import { ExecutiveDataTable, Column } from './ExecutiveDataTable';
import { TrendingUp, UserPlus, Target, Megaphone, BarChart3, Users, CalendarRange, Trophy, LogIn, ShieldCheck, ShieldAlert, UserX, X } from 'lucide-react';
import { ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { format, subMonths, startOfMonth, endOfMonth, eachMonthOfInterval, startOfDay, endOfDay, subDays, startOfYear } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SignupSourceFunnel } from './SignupSourceFunnel';
import { MerchandiseManager } from './MerchandiseManager';
import AdminRecruitmentCampaignsPage from '@/pages/AdminRecruitmentCampaignsPage';
import { GrowthMetricsView } from './GrowthMetricsView';
import { SignupTrendsView } from './SignupTrendsView';
import { ReferralPerformanceView } from './ReferralPerformanceView';
import { UserAnalyticsView } from './UserAnalyticsView';
import { InstallFunnelView } from './InstallFunnelView';
import { WebTrafficAnalyticsSection } from './WebTrafficAnalyticsSection';

type ReferralStatus = 'all' | 'pending' | 'completed';
type DatePreset = '6months' | 'today' | 'yesterday' | 'last_week' | 'last_30' | 'last_90' | 'mtd' | 'ytd' | 'custom';
type SignupSourceFilter = 'all' | 'referred' | 'organic';

function presetBounds(preset: DatePreset, customStart: Date, customEnd: Date): { start: Date; end: Date } {
  const now = new Date();
  switch (preset) {
    case 'today':
      return { start: startOfDay(now), end: endOfDay(now) };
    case 'yesterday': {
      const y = subDays(now, 1);
      return { start: startOfDay(y), end: endOfDay(y) };
    }
    case 'last_week':
      return { start: startOfDay(subDays(now, 6)), end: endOfDay(now) };
    case 'last_30':
      return { start: startOfDay(subDays(now, 29)), end: endOfDay(now) };
    case 'last_90':
      return { start: startOfDay(subDays(now, 89)), end: endOfDay(now) };
    case 'mtd':
      return { start: startOfMonth(now), end: endOfDay(now) };
    case 'ytd':
      return { start: startOfYear(now), end: endOfDay(now) };
    case 'custom':
      return { start: startOfDay(customStart), end: endOfDay(customEnd) };
    default:
      return { start: customStart, end: customEnd };
  }
}

export function CMODashboard({ activeTab }: { activeTab?: string } = {}) {
  if (activeTab === 'merchandise') {
    return <MerchandiseManager />;
  }
  if (activeTab === 'campaigns') {
    return <AdminRecruitmentCampaignsPage />;
  }
  if (activeTab === 'growth') {
    return <GrowthMetricsView />;
  }
  if (activeTab === 'signups') {
    return <SignupTrendsView />;
  }
  if (activeTab === 'referrals') {
    return <ReferralPerformanceView />;
  }
  if (activeTab === 'user-analytics') {
    return <UserAnalyticsView />;
  }
  if (activeTab === 'install-funnel') {
    return <InstallFunnelView />;
  }
  return <CMOMarketingDashboard />;
}

function CMOMarketingDashboard() {
  const now = new Date();
  const [startMonth, setStartMonth] = useState(format(subMonths(now, 5), 'yyyy-MM'));
  const [endMonth, setEndMonth] = useState(format(now, 'yyyy-MM'));
  const [referralStatus, setReferralStatus] = useState<ReferralStatus>('all');
  const [datePreset, setDatePreset] = useState<DatePreset>('6months');
  const [customStartDate, setCustomStartDate] = useState(format(subDays(now, 29), 'yyyy-MM-dd'));
  const [customEndDate, setCustomEndDate] = useState(format(now, 'yyyy-MM-dd'));
  const [signupSource, setSignupSource] = useState<SignupSourceFilter>('all');

  const monthlyStart = startOfMonth(new Date(startMonth + '-01'));
  const monthlyEnd = endOfMonth(new Date(endMonth + '-01'));
  const customStart = new Date(customStartDate);
  const customEnd = new Date(customEndDate);
  const { start, end } = datePreset === '6months'
    ? { start: monthlyStart, end: monthlyEnd }
    : presetBounds(datePreset, customStart, customEnd);
  const months = eachMonthOfInterval({ start: monthlyStart, end: monthlyEnd });

  // Apply signup source filter to a referrals query
  const applySource = (q: any) => {
    if (signupSource === 'referred') return q.not('referrer_id', 'is', null);
    if (signupSource === 'organic') return q.is('referrer_id', null);
    return q;
  };

  const { data: signupTrend, isLoading } = useQuery({
    queryKey: ['exec-signup-trend', startMonth, endMonth, signupSource],
    queryFn: async () => {
      const results = [];
      for (const m of months) {
        const s = startOfMonth(m);
        const e = endOfMonth(m);
        let q = supabase.from('profiles').select('*', { count: 'exact', head: true })
          .gte('created_at', s.toISOString()).lte('created_at', e.toISOString());
        if (signupSource === 'referred') q = q.not('referrer_id', 'is', null);
        if (signupSource === 'organic') q = q.is('referrer_id', null);
        const { count } = await q;
        results.push({ month: format(s, 'MMM yyyy'), signups: count || 0 });
      }
      return results;
    },
    staleTime: 600000,
  });

  const { data: referralStats } = useQuery({
    queryKey: ['exec-referral-stats', startMonth, endMonth, datePreset, customStartDate, customEndDate],
    queryFn: async () => {
      const rangeFilter = (q: any) =>
        q.gte('created_at', start.toISOString()).lte('created_at', end.toISOString());

      const { count: totalReferrals } = await rangeFilter(
        supabase.from('referrals').select('*', { count: 'exact', head: true })
      );

      const { count: pendingReferrals } = await rangeFilter(
        supabase.from('referrals').select('*', { count: 'exact', head: true }).eq('credited', false)
      );

      const { count: completedReferrals } = await rangeFilter(
        supabase.from('referrals').select('*', { count: 'exact', head: true }).eq('credited', true)
      );

      const byMonth: Record<string, { total: number; pending: number; completed: number }> = {};
      for (const m of months) {
        const s = startOfMonth(m);
        const e = endOfMonth(m);
        const monthQ = (q: any) =>
          q.gte('created_at', s.toISOString()).lte('created_at', e.toISOString());

        const [{ count: total }, { count: pending }, { count: completed }] = await Promise.all([
          monthQ(supabase.from('referrals').select('*', { count: 'exact', head: true })),
          monthQ(supabase.from('referrals').select('*', { count: 'exact', head: true }).eq('credited', false)),
          monthQ(supabase.from('referrals').select('*', { count: 'exact', head: true }).eq('credited', true)),
        ]);

        byMonth[format(s, 'MMM yyyy')] = {
          total: total || 0,
          pending: pending || 0,
          completed: completed || 0,
        };
      }

      return {
        totalReferrals: totalReferrals || 0,
        pendingReferrals: pendingReferrals || 0,
        completedReferrals: completedReferrals || 0,
        byMonth,
      };
    },
    staleTime: 600000,
  });

  const { data: totalUsers } = useQuery({
    queryKey: ['exec-total-users-cmo', datePreset, startMonth, endMonth, customStartDate, customEndDate, signupSource],
    queryFn: async () => {
      let q = supabase.from('profiles').select('*', { count: 'exact', head: true })
        .gte('created_at', start.toISOString()).lte('created_at', end.toISOString());
      if (signupSource === 'referred') q = q.not('referrer_id', 'is', null);
      if (signupSource === 'organic') q = q.is('referrer_id', null);
      const { count } = await q;
      return count || 0;
    },
    staleTime: 600000,
  });

  // Login / authentication metrics (sourced from the OTP login audit, the active login channel)
  const { data: loginStats } = useQuery({
    queryKey: ['exec-login-stats', startMonth, endMonth, datePreset, customStartDate, customEndDate],
    queryFn: async () => {
      const rangeFilter = (q: any) =>
        q.gte('created_at', start.toISOString()).lte('created_at', end.toISOString());

      const counter = (outcome?: string) => {
        let q = supabase.from('otp_login_audit').select('*', { count: 'exact', head: true });
        if (outcome) q = q.eq('outcome', outcome);
        return rangeFilter(q);
      };

      const [{ count: attempts }, { count: success }, { count: failed }, { count: noAccount }] = await Promise.all([
        counter(),
        counter('success'),
        counter('failed'),
        counter('no_account'),
      ]);

      const byMonth: Record<string, { attempts: number; success: number; failed: number }> = {};
      for (const m of months) {
        const s = startOfMonth(m);
        const e = endOfMonth(m);
        const monthQ = (outcome?: string) => {
          let q = supabase.from('otp_login_audit').select('*', { count: 'exact', head: true });
          if (outcome) q = q.eq('outcome', outcome);
          return q.gte('created_at', s.toISOString()).lte('created_at', e.toISOString());
        };
        const [{ count: a }, { count: ok }, { count: f }] = await Promise.all([
          monthQ(),
          monthQ('success'),
          monthQ('failed'),
        ]);
        byMonth[format(s, 'MMM yyyy')] = { attempts: a || 0, success: ok || 0, failed: f || 0 };
      }

      return {
        attempts: attempts || 0,
        success: success || 0,
        failed: failed || 0,
        noAccount: noAccount || 0,
        byMonth,
      };
    },
    staleTime: 600000,
  });

  const totalSignups = (signupTrend || []).reduce((s, m) => s + m.signups, 0);
  const lastMonth = signupTrend?.[signupTrend.length - 1]?.signups || 0;
  const prevMonth = signupTrend?.[signupTrend.length - 2]?.signups || 1;
  const growthRate = prevMonth > 0 ? Math.round(((lastMonth - prevMonth) / prevMonth) * 100) : 0;

  const referralData = signupTrend?.map(m => ({
    ...m,
    referrals: referralStats?.byMonth[m.month]?.total || 0,
    pending: referralStats?.byMonth[m.month]?.pending || 0,
    completed: referralStats?.byMonth[m.month]?.completed || 0,
  })) || [];

  const loginTrend = months.map(m => {
    const key = format(startOfMonth(m), 'MMM yyyy');
    const v = loginStats?.byMonth[key];
    return { month: key, success: v?.success || 0, failed: v?.failed || 0 };
  });

  const loginSuccessRate = loginStats && loginStats.attempts > 0
    ? Math.round((loginStats.success / loginStats.attempts) * 100)
    : 0;

  const referralTotalForStatus =
    referralStatus === 'pending'
      ? referralStats?.pendingReferrals || 0
      : referralStatus === 'completed'
        ? referralStats?.completedReferrals || 0
        : referralStats?.totalReferrals || 0;

  const recentReferralsColumns: Column<any>[] = [
    { key: 'created_at', label: 'Date', render: (v) => v ? format(new Date(v as string), 'dd MMM yy') : '—' },
    { key: 'referred_name', label: 'Referred User' },
    { key: 'referrer_name', label: 'Referrer' },
    {
      key: 'credited',
      label: 'Status',
      render: (v) =>
        v ? (
          <span className="inline-flex items-center rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-600">Completed</span>
        ) : (
          <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600">Pending</span>
        ),
    },
  ];

  const { data: recentReferrals, isLoading: loadingReferrals } = useQuery({
    queryKey: ['exec-recent-referrals', startMonth, endMonth, referralStatus, datePreset],
    queryFn: async () => {
      let q = supabase
        .from('referrals')
        .select('id, referred_id, referrer_id, credited, created_at')
        .gte('created_at', start.toISOString())
        .lte('created_at', end.toISOString())
        .order('created_at', { ascending: false })
        .limit(200);

      if (referralStatus === 'pending') q = q.eq('credited', false);
      if (referralStatus === 'completed') q = q.eq('credited', true);

      const { data: refRows } = await q;
      if (!refRows || refRows.length === 0) return [];

      const userIds = [...new Set([...refRows.map(r => r.referred_id), ...refRows.map(r => r.referrer_id)])];
      const { data: profilesData } = await supabase
        .from('profiles')
        .select('id, full_name, phone')
        .in('id', userIds);

      const profileMap = new Map((profilesData || []).map(p => [p.id, p]));

      return refRows.map(r => ({
        id: r.id,
        created_at: r.created_at,
        credited: r.credited,
        referred_name: profileMap.get(r.referred_id)?.full_name || profileMap.get(r.referred_id)?.phone || 'Unknown',
        referrer_name: profileMap.get(r.referrer_id)?.full_name || profileMap.get(r.referrer_id)?.phone || 'Unknown',
      }));
    },
    staleTime: 600000,
  });

  const { data: topReferrers, isLoading: loadingTopReferrers } = useQuery({
    queryKey: ['exec-top-referrers', startMonth, endMonth, referralStatus, datePreset],
    queryFn: async () => {
      let q = supabase
        .from('referrals')
        .select('referrer_id, credited')
        .gte('created_at', start.toISOString())
        .lte('created_at', end.toISOString());

      if (referralStatus === 'pending') q = q.eq('credited', false);
      if (referralStatus === 'completed') q = q.eq('credited', true);

      const { data: refRows } = await q;
      if (!refRows || refRows.length === 0) return [];

      const counts: Record<string, { total: number; pending: number; completed: number }> = {};
      refRows.forEach((r) => {
        const c = counts[r.referrer_id] || { total: 0, pending: 0, completed: 0 };
        c.total += 1;
        if (r.credited) c.completed += 1;
        else c.pending += 1;
        counts[r.referrer_id] = c;
      });

      const sortKey = referralStatus === 'pending' ? 'pending' : referralStatus === 'completed' ? 'completed' : 'total';
      const sorted = Object.entries(counts)
        .sort((a, b) => b[1][sortKey as keyof typeof b[1]] - a[1][sortKey as keyof typeof a[1]])
        .slice(0, 20);

      const referrerIds = sorted.map(([id]) => id);
      const { data: profilesData } = await supabase
        .from('profiles')
        .select('id, full_name, phone')
        .in('id', referrerIds);

      const profileMap = new Map((profilesData || []).map((p) => [p.id, p]));

      return sorted.map(([id, c], idx) => ({
        rank: idx + 1,
        referrer_id: id,
        name: profileMap.get(id)?.full_name || profileMap.get(id)?.phone || 'Unknown',
        referrals: c.total,
        pending: c.pending,
        completed: c.completed,
      }));
    },
    staleTime: 600000,
  });

  const statusOptions: { label: string; value: ReferralStatus }[] = [
    { label: 'All', value: 'all' },
    { label: 'Pending', value: 'pending' },
    { label: 'Completed', value: 'completed' },
  ];

  const dateFilterOptions: { label: string; value: DatePreset }[] = [
    { label: '6 Months', value: '6months' },
    { label: 'Today', value: 'today' },
    { label: 'Yesterday', value: 'yesterday' },
    { label: 'Last 7d', value: 'last_week' },
    { label: 'Last 30d', value: 'last_30' },
    { label: 'Last 90d', value: 'last_90' },
    { label: 'MTD', value: 'mtd' },
    { label: 'YTD', value: 'ytd' },
    { label: 'Custom', value: 'custom' },
  ];

  const sourceOptions: { label: string; value: SignupSourceFilter }[] = [
    { label: 'All Sources', value: 'all' },
    { label: 'Referred', value: 'referred' },
    { label: 'Organic', value: 'organic' },
  ];

  const activeFilterCount =
    (datePreset !== '6months' ? 1 : 0) +
    (referralStatus !== 'all' ? 1 : 0) +
    (signupSource !== 'all' ? 1 : 0);

  const resetFilters = () => {
    const n = new Date();
    setStartMonth(format(subMonths(n, 5), 'yyyy-MM'));
    setEndMonth(format(n, 'yyyy-MM'));
    setDatePreset('6months');
    setReferralStatus('all');
    setSignupSource('all');
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="rounded-2xl border border-border bg-card p-3 sm:p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <CalendarRange className="w-4 h-4 text-primary" /> Filters
            {activeFilterCount > 0 && (
              <span className="text-xs font-normal text-muted-foreground">({activeFilterCount} active)</span>
            )}
          </h3>
          {activeFilterCount > 0 && (
            <Button variant="ghost" size="sm" onClick={resetFilters} className="text-xs h-7">
              <X className="w-3 h-3 mr-1" /> Reset
            </Button>
          )}
        </div>

        <div>
          <Label className="text-xs text-muted-foreground">Date range</Label>
          <div className="flex flex-wrap gap-2 mt-1">
            {dateFilterOptions.map((opt) => (
              <Button
                key={opt.value}
                size="sm"
                variant={datePreset === opt.value ? 'secondary' : 'outline'}
                onClick={() => setDatePreset(opt.value)}
                className="text-xs"
              >
                {opt.label}
              </Button>
            ))}
          </div>
        </div>

        {datePreset === 'custom' && (
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="custom-start" className="text-xs">From date</Label>
              <Input
                id="custom-start"
                type="date"
                value={customStartDate}
                max={customEndDate}
                onChange={(e) => setCustomStartDate(e.target.value)}
                className="w-44"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="custom-end" className="text-xs">To date</Label>
              <Input
                id="custom-end"
                type="date"
                value={customEndDate}
                min={customStartDate}
                onChange={(e) => setCustomEndDate(e.target.value)}
                className="w-44"
              />
            </div>
          </div>
        )}

        {datePreset === '6months' && (
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="start-month" className="text-xs">From month</Label>
              <Input
                id="start-month"
                type="month"
                value={startMonth}
                onChange={(e) => { if (e.target.value <= endMonth) setStartMonth(e.target.value); }}
                className="w-40"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="end-month" className="text-xs">To month</Label>
              <Input
                id="end-month"
                type="month"
                value={endMonth}
                onChange={(e) => { if (e.target.value >= startMonth) setEndMonth(e.target.value); }}
                className="w-40"
              />
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-4">
          <div>
            <Label className="text-xs text-muted-foreground">Referral status</Label>
            <div className="flex flex-wrap gap-2 mt-1">
              {statusOptions.map((opt) => (
                <Button
                  key={opt.value}
                  size="sm"
                  variant={referralStatus === opt.value ? 'default' : 'outline'}
                  onClick={() => setReferralStatus(opt.value)}
                  className="text-xs"
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Signup source</Label>
            <div className="flex flex-wrap gap-2 mt-1">
              {sourceOptions.map((opt) => (
                <Button
                  key={opt.value}
                  size="sm"
                  variant={signupSource === opt.value ? 'default' : 'outline'}
                  onClick={() => setSignupSource(opt.value)}
                  className="text-xs"
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          Showing {format(start, 'dd MMM yyyy')} → {format(end, 'dd MMM yyyy')}
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
        <KPICard title={datePreset === '6months' ? 'Total Users' : 'New Users (range)'} value={(totalUsers || 0).toLocaleString()} icon={Users} loading={isLoading} />
        <KPICard title="Monthly Signups" value={lastMonth} icon={UserPlus} loading={isLoading} color="bg-green-500/10 text-green-600" trend={{ value: growthRate, label: 'vs prev month' }} />
        <KPICard
          title={referralStatus === 'all' ? 'Referral Signups' : referralStatus === 'pending' ? 'Pending Referrals' : 'Completed Referrals'}
          value={referralTotalForStatus}
          icon={Megaphone}
          color="bg-purple-500/10 text-purple-600"
        />
        <KPICard title="Conversion Rate" value={totalUsers ? `${Math.round((referralStats?.totalReferrals || 0) / totalUsers * 100)}%` : '0%'} icon={Target} color="bg-orange-500/10 text-orange-600" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-2 sm:gap-3">
        <KPICard title="Total Referrals" value={referralStats?.totalReferrals || 0} icon={Megaphone} color="bg-purple-500/10 text-purple-600" />
        <KPICard title="Pending Referrals" value={referralStats?.pendingReferrals || 0} icon={TrendingUp} color="bg-amber-500/10 text-amber-600" />
        <KPICard title="Completed Referrals" value={referralStats?.completedReferrals || 0} icon={BarChart3} color="bg-green-500/10 text-green-600" />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
        <KPICard title="Successful Logins" value={(loginStats?.success || 0).toLocaleString()} icon={LogIn} color="bg-green-500/10 text-green-600" />
        <KPICard title="Login Success Rate" value={`${loginSuccessRate}%`} icon={ShieldCheck} color="bg-emerald-500/10 text-emerald-600" />
        <KPICard title="Failed Logins" value={(loginStats?.failed || 0).toLocaleString()} icon={ShieldAlert} color="bg-red-500/10 text-red-600" />
        <KPICard title="No-Account Attempts" value={(loginStats?.noAccount || 0).toLocaleString()} icon={UserX} color="bg-amber-500/10 text-amber-600" />
      </div>

      <WebTrafficAnalyticsSection />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
        <div className="rounded-2xl border border-border bg-card p-3 sm:p-4">
          <h3 className="text-sm font-semibold mb-3">Signup Growth</h3>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={signupTrend || []}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="month" className="text-xs" />
              <YAxis className="text-xs" />
              <Tooltip />
              <Area type="monotone" dataKey="signups" fill="hsl(var(--primary)/0.2)" stroke="hsl(var(--primary))" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="rounded-2xl border border-border bg-card p-3 sm:p-4">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <LogIn className="w-4 h-4 text-primary" />
            Login Activity
          </h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={loginTrend}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="month" className="text-xs" />
              <YAxis className="text-xs" />
              <Tooltip />
              <Legend />
              <Bar dataKey="success" fill="#22c55e" radius={[4, 4, 0, 0]} name="Successful" />
              <Bar dataKey="failed" fill="#ef4444" radius={[4, 4, 0, 0]} name="Failed" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <SignupSourceFunnel start={start} end={end} />

      <div className="grid grid-cols-1 gap-3 sm:gap-4">
        <div className="rounded-2xl border border-border bg-card p-3 sm:p-4">
          <h3 className="text-sm font-semibold mb-3">Referral Performance</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={referralData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="month" className="text-xs" />
              <YAxis className="text-xs" />
              <Tooltip />
              <Legend />
              <Bar dataKey="pending" fill="#f59e0b" radius={[4, 4, 0, 0]} name="Pending" />
              <Bar dataKey="completed" fill="#22c55e" radius={[4, 4, 0, 0]} name="Completed" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
        <div className="rounded-2xl border border-border bg-card p-3 sm:p-4">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <Trophy className="w-4 h-4 text-amber-500" />
            Top Referrers
            <span className="ml-auto text-xs font-normal text-muted-foreground capitalize">{referralStatus}</span>
          </h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={topReferrers || []} layout="vertical" margin={{ left: 16, right: 16 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis type="number" className="text-xs" />
              <YAxis dataKey="name" type="category" width={100} className="text-xs" tickFormatter={(v: string) => (v.length > 14 ? v.slice(0, 14) + '...' : v)} />
              <Tooltip />
              <Bar dataKey={referralStatus === 'pending' ? 'pending' : referralStatus === 'completed' ? 'completed' : 'referrals'} fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="rounded-2xl border border-border bg-card p-3 sm:p-4">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <Trophy className="w-4 h-4 text-amber-500" />
            Referrer Leaderboard
          </h3>
          <ExecutiveDataTable
            data={topReferrers || []}
            columns={[
              { key: 'rank', label: 'Rank', render: (v) => <span className="font-bold text-muted-foreground">#{v}</span> },
              { key: 'name', label: 'Referrer' },
              { key: 'referrals', label: 'Total', render: (v) => <span className="font-semibold">{v}</span> },
              { key: 'pending', label: 'Pending', render: (v) => <span className="text-amber-600 font-medium">{v}</span> },
              { key: 'completed', label: 'Completed', render: (v) => <span className="text-green-600 font-medium">{v}</span> },
            ]}
            loading={loadingTopReferrers}
            title="Top Referrers"
          />
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold mb-3">Recent Referrals</h3>
        <ExecutiveDataTable
          data={recentReferrals || []}
          columns={recentReferralsColumns}
          loading={loadingReferrals}
          title="Referrals"
        />
      </div>
    </div>
  );
}
