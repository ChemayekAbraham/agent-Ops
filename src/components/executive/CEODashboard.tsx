import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { KPICard } from './KPICard';
import { ExecutiveDataTable, Column } from './ExecutiveDataTable';
import { Users, Building2, Banknote, TrendingUp, Home, DollarSign, UserCheck, Shield } from 'lucide-react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, BarChart, Bar, LineChart, Line } from 'recharts';
import { format, subMonths, startOfMonth, startOfDay } from 'date-fns';
import { Activity, UserPlus, RefreshCw, Share2, ArrowRightLeft } from 'lucide-react';
import { TrustCoverageSection } from './TrustCoverageSection';
import { AgentAdvancesDailyReportCard } from './AgentAdvancesDailyReportCard';
import { AgentOpsLiveStatsCard } from './AgentOpsLiveStatsCard';
import { FunderEngagementPanel } from './FunderEngagementPanel';
import { FunderFunnelPanel } from './FunderFunnelPanel';
import { CeoSalaryAdvanceApprovals } from './CeoSalaryAdvanceApprovals';
import { CEOGrowthQuality } from './CEOGrowthQuality';


export function CEODashboard() {
  const [searchParams] = useSearchParams();
  const activeTab = searchParams.get('section') || '';
  const { data: profiles, isLoading: loadingProfiles } = useQuery({
    queryKey: ['exec-profiles-count'],
    queryFn: async () => {
      const { count } = await supabase.from('profiles').select('*', { count: 'exact', head: true });
      return count || 0;
    },
    staleTime: 600000,
  });

  const { data: landlords, isLoading: loadingLandlords } = useQuery({
    queryKey: ['exec-landlords-count'],
    queryFn: async () => {
      const { count } = await supabase.from('landlords').select('*', { count: 'exact', head: true });
      return count || 0;
    },
    staleTime: 600000,
  });

  const { data: rentStats, isLoading: loadingRent } = useQuery({
    queryKey: ['exec-rent-stats'],
    queryFn: async () => {
      const { data } = await supabase.from('rent_requests').select('id, status, rent_amount, amount_repaid, created_at').limit(200);
      const rows = data || [];
      const funded = rows.filter(r => ['funded', 'disbursed', 'repaying', 'fully_repaid'].includes(r.status)).length;
      const totalFinanced = rows.reduce((s, r) => s + (r.rent_amount || 0), 0);
      const totalRepaid = rows.reduce((s, r) => s + (r.amount_repaid || 0), 0);
      return { funded, totalFinanced, totalRepaid, rows };
    },
    staleTime: 600000,
  });

  const { data: investorCount } = useQuery({
    queryKey: ['exec-investors-count'],
    queryFn: async () => {
      const { count } = await supabase.from('investor_portfolios').select('*', { count: 'exact', head: true });
      return count || 0;
    },
    staleTime: 600000,
  });

  const { data: activeAgentCount } = useQuery({
    queryKey: ['exec-active-agents'],
    queryFn: async () => {
      const { count } = await supabase.from('agent_earnings').select('agent_id', { count: 'exact', head: true });
      return count || 0;
    },
    staleTime: 600000,
  });

  const { data: revenue } = useQuery({
    queryKey: ['exec-revenue'],
    queryFn: async () => {
      // Revenue = fees billed via the ASC 606 fee ledger (access + platform fees).
      // Uses the server-aggregated RPC — the Data API caps row fetches at 1,000,
      // which silently under-counts once the ledger grows past that.
      const { data, error } = await supabase.rpc('get_fee_revenue_summary', { p_months: 6 });
      if (error) throw error;
      return Number((data as any)?.billed || 0);
    },
    staleTime: 600000,
  });

  const { data: growthMetrics, isLoading: loadingGrowth } = useQuery({
    queryKey: ['exec-ceo-growth-metrics'],
    queryFn: async () => {
      // Try pre-computed daily stats first (instant, scales to 40M+)
      const { data: stats } = await supabase
        .from('daily_platform_stats')
        .select('*')
        .eq('stat_date', new Date().toISOString().split('T')[0])
        .maybeSingle();

      if (stats) {
        return {
          activeUsers: stats.active_users_30d,
          newUsersToday: stats.new_users_today,
          retention: Number(stats.retention_pct),
          referralPct: Number(stats.referral_pct),
          dailyTxn: Number(stats.daily_transaction_volume),
        };
      }

      // Fallback: use approximate count for total + exact counts for small queries
      const todayStart = startOfDay(new Date()).toISOString();
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();

      const [approxTotal, newTodayRes, activeRes, referralRes, txnRes] = await Promise.all([
        supabase.rpc('get_approximate_user_count'),
        supabase.from('profiles').select('*', { count: 'exact', head: true }).gte('created_at', todayStart),
        supabase.from('profiles').select('*', { count: 'exact', head: true }).gte('updated_at', thirtyDaysAgo),
        supabase.from('profiles').select('*', { count: 'exact', head: true }).not('referred_by', 'is', null),
        supabase.from('general_ledger').select('amount').gte('transaction_date', todayStart).limit(200),
      ]);

      const total = (approxTotal.data as number) || 1;
      const active = activeRes.count || 0;
      const retention = Math.round((active / total) * 100);
      const referralPct = Math.round(((referralRes.count || 0) / total) * 100);
      const dailyTxn = (txnRes.data || []).reduce((s: number, r: any) => s + (r.amount || 0), 0);

      return {
        activeUsers: active,
        newUsersToday: newTodayRes.count || 0,
        retention,
        referralPct,
        dailyTxn,
      };
    },
    staleTime: 600000,
  });

  const { data: monthlyGrowth } = useQuery({
    queryKey: ['exec-growth-chart'],
    queryFn: async () => {
      const months: { month: string; tenants: number; capital: number; repaid: number }[] = [];
      for (let i = 5; i >= 0; i--) {
        const start = startOfMonth(subMonths(new Date(), i));
        const end = startOfMonth(subMonths(new Date(), i - 1));
        const label = format(start, 'MMM');

        const { count: tCount } = await supabase.from('profiles').select('*', { count: 'exact', head: true })
          .gte('created_at', start.toISOString()).lt('created_at', end.toISOString());

        const { data: rents } = await supabase.from('rent_requests').select('rent_amount, amount_repaid')
          .gte('created_at', start.toISOString()).lt('created_at', end.toISOString()).limit(500);

        months.push({
          month: label,
          tenants: tCount || 0,
          capital: (rents || []).reduce((s, r) => s + (r.rent_amount || 0), 0),
          repaid: (rents || []).reduce((s, r) => s + (r.amount_repaid || 0), 0),
        });
      }
      return months;
    },
    staleTime: 600000,
  });

  const recentColumns: Column<any>[] = [
    { key: 'created_at', label: 'Date', render: (v) => v ? format(new Date(v as string), 'dd MMM yy') : '—' },
    { key: 'status', label: 'Status', render: (v) => (
      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-muted">{String(v)}</span>
    )},
    { key: 'rent_amount', label: 'Amount (UGX)', render: (v) => Number(v || 0).toLocaleString() },
    { key: 'amount_repaid', label: 'Repaid (UGX)', render: (v) => Number(v || 0).toLocaleString() },
  ];

  const fmt = (n: number) => {
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
    return n.toLocaleString();
  };

  const loading = loadingProfiles || loadingLandlords || loadingRent;

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Growth quality — the three lenses that lead revenue */}
      <CEOGrowthQuality />

      {/* Salary advances waiting on the CEO stage */}
      <CeoSalaryAdvanceApprovals />

      {/* Mission scoreboard — Trust Coverage */}
      <TrustCoverageSection />


      {/* Agent Advances daily report (live mirror of the 18:00 EAT email) */}
      <AgentAdvancesDailyReportCard />

      {/* Agent Ops live stats — mirror of the Agent Ops dashboard */}
      <AgentOpsLiveStatsCard />

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
        <KPICard title="Total Users" value={fmt(profiles || 0)} icon={Users} loading={loading} />
        <KPICard title="Tenants Funded" value={fmt(rentStats?.funded || 0)} icon={UserCheck} loading={loading} color="bg-green-500/10 text-green-600" />
        <KPICard title="Rent Financed" value={`${fmt(rentStats?.totalFinanced || 0)}`} icon={Banknote} loading={loading} color="bg-blue-500/10 text-blue-600" />
        <KPICard title="Total Landlords" value={fmt(landlords || 0)} icon={Home} loading={loading} color="bg-orange-500/10 text-orange-600" />
        <KPICard title="Partners/Investors" value={fmt(investorCount || 0)} icon={Shield} loading={loading} color="bg-purple-500/10 text-purple-600" />
        <KPICard title="Platform Revenue" value={`${fmt(revenue || 0)}`} icon={DollarSign} loading={loading} color="bg-emerald-500/10 text-emerald-600" />
        <KPICard title="Rent Repaid" value={`${fmt(rentStats?.totalRepaid || 0)}`} icon={TrendingUp} loading={loading} color="bg-teal-500/10 text-teal-600" />
      </div>

      {/* Funder engagement — repayment details opens */}
      <FunderEngagementPanel />

      {/* Funder funnel — view terms → select → lock → fund */}
      <FunderFunnelPanel />

      {/* Growth Metrics */}
      <div className="rounded-2xl border border-border bg-card p-3 sm:p-4">
        <h3 className="text-sm font-semibold mb-3">Growth Metrics</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 sm:gap-3">
          {[
            { label: 'Active Users', value: growthMetrics?.activeUsers ?? '—', icon: Activity, color: 'bg-primary/10 text-primary' },
            { label: 'New Users Today', value: growthMetrics?.newUsersToday ?? '—', icon: UserPlus, color: 'bg-green-500/10 text-green-600' },
            { label: 'Retention', value: growthMetrics ? `${growthMetrics.retention}%` : '—', icon: RefreshCw, color: 'bg-blue-500/10 text-blue-600' },
            { label: 'Referrals', value: growthMetrics ? `${growthMetrics.referralPct}%` : '—', icon: Share2, color: 'bg-purple-500/10 text-purple-600' },
            { label: 'Daily Transactions', value: growthMetrics ? fmt(growthMetrics.dailyTxn) : '—', icon: ArrowRightLeft, color: 'bg-orange-500/10 text-orange-600' },
          ].map((m) => (
            <div key={m.label} className="flex items-center gap-3 rounded-xl border border-border/60 bg-background p-3">
              <div className={`p-2 rounded-lg shrink-0 ${m.color}`}>
                <m.icon className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground truncate">{m.label}</p>
                {loadingGrowth ? (
                  <div className="h-5 w-12 bg-muted animate-pulse rounded mt-0.5" />
                ) : (
                  <p className="text-lg font-bold truncate">{m.value}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-4">
        <div className="rounded-2xl border border-border bg-card p-3 sm:p-4">
          <h3 className="text-sm font-semibold mb-3">Tenant Growth</h3>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={monthlyGrowth || []}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="month" className="text-xs" tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={12} />
              <YAxis className="text-xs" tick={{ fontSize: 10 }} width={40} tickFormatter={(v: number) => Math.abs(v)>=1e9?`${(v/1e9).toFixed(1)}B`:Math.abs(v)>=1e6?`${(v/1e6).toFixed(1)}M`:Math.abs(v)>=1e3?`${(v/1e3).toFixed(0)}K`:String(v)} />
              <Tooltip />
              <Area type="monotone" dataKey="tenants" fill="hsl(var(--primary)/0.2)" stroke="hsl(var(--primary))" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4">
          <h3 className="text-sm font-semibold mb-3">Capital Raised</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={monthlyGrowth || []}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="month" className="text-xs" tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={12} />
              <YAxis className="text-xs" tick={{ fontSize: 10 }} width={40} tickFormatter={(v: number) => Math.abs(v)>=1e9?`${(v/1e9).toFixed(1)}B`:Math.abs(v)>=1e6?`${(v/1e6).toFixed(1)}M`:Math.abs(v)>=1e3?`${(v/1e3).toFixed(0)}K`:String(v)} />
              <Tooltip />
              <Bar dataKey="capital" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4">
          <h3 className="text-sm font-semibold mb-3">Rent Repayment</h3>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={monthlyGrowth || []}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="month" className="text-xs" tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={12} />
              <YAxis className="text-xs" tick={{ fontSize: 10 }} width={40} tickFormatter={(v: number) => Math.abs(v)>=1e9?`${(v/1e9).toFixed(1)}B`:Math.abs(v)>=1e6?`${(v/1e6).toFixed(1)}M`:Math.abs(v)>=1e3?`${(v/1e3).toFixed(0)}K`:String(v)} />
              <Tooltip />
              <Line type="monotone" dataKey="repaid" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Recent Rent Requests Table */}
      <div>
        <h3 className="text-sm font-semibold mb-3">Recent Rent Requests</h3>
        <ExecutiveDataTable
          data={rentStats?.rows || []}
          columns={recentColumns}
          loading={loadingRent}
          title="Rent Requests"
          filters={[{
            key: 'status',
            label: 'Status',
            options: [
              { value: 'pending', label: 'Pending' },
              { value: 'funded', label: 'Funded' },
              { value: 'disbursed', label: 'Disbursed' },
              { value: 'repaying', label: 'Repaying' },
              { value: 'fully_repaid', label: 'Fully Repaid' },
            ],
          }]}
        />
      </div>
    </div>
  );
}
