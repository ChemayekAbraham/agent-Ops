import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { KPICard } from './KPICard';
import { DataCompletenessScorecard } from './DataCompletenessScorecard';
import { MonetizationFunnel } from './MonetizationFunnel';
import { RevenueMixDrivers } from './RevenueMixDrivers';
import { formatUGX } from '@/lib/rentCalculations';
import {
  DollarSign, TrendingUp, Banknote, Clock, Database, Activity,
  ShieldCheck, MapPin, FileText, Gauge, Layers, Coins, Users, PiggyBank,
} from 'lucide-react';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  BarChart, Bar, Legend,
} from 'recharts';
import { format } from 'date-fns';

/** Compact UGX for chart axes / dense KPIs */
const compact = (n: number) => {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return `${Math.round(n)}`;
};
const num = (n: number) => Number(n || 0).toLocaleString();

/**
 * CEO — Revenue & Growth
 *
 * Built around the founding vision: turn Africa's behaviour into DATA,
 * and DATA into FINANCIAL VALUE. The view is organised as a funnel:
 *   1. Financial Value   — what the platform monetises today
 *   2. The Data Asset    — the behavioural signal we capture
 *   3. Value from Data   — unit economics linking signal → money
 *   4. Growth Trajectory — the direction of travel
 */
export function CEORevenueGrowth() {
  // ---- 1. Revenue engine (ASC 606 fee ledger) ----
  // Server-side aggregation via RPC so totals are EXACT — the Data API caps
  // any row fetch at 1,000 rows, which silently under-counts once the ledger
  // grows past that. Never sum fee rows client-side for headline figures.
  const { data: feeLedger, isLoading: loadingFees } = useQuery({
    queryKey: ['ceo-rev-fee-ledger'],
    staleTime: 600000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_fee_revenue_summary', { p_months: 6 });
      if (error) throw error;
      const s = (data || {}) as any;
      return {
        billed: Number(s.billed || 0),
        recognized: Number(s.recognized || 0),
        deferred: Number(s.deferred || 0),
        rowCount: Number(s.row_count || 0),
        monthlyRaw: (s.monthly || []) as { month_start: string; access: number; platform: number; total: number }[],
      };
    },
  });

  // ---- Cash actually collected + facilitated economic activity (from ledger) ----
  const { data: ledgerRev, isLoading: loadingLedger } = useQuery({
    queryKey: ['ceo-rev-ledger-cash'],
    staleTime: 600000,
    queryFn: async () => {
      const grab = async (categories: string[]) => {
        const { data } = await supabase
          .from('general_ledger')
          .select('amount, category')
          .in('category', categories)
          .eq('direction', 'cash_in')
          .neq('classification', 'admin_correction')
          .limit(20000);
        return (data || []).reduce((s, r) => s + Number(r.amount || 0), 0);
      };
      const [feesCollected, commissionFacilitated, rentFacilitated] = await Promise.all([
        grab(['access_fee_collected', 'tenant_access_fee', 'registration_fee_collected']),
        grab(['agent_commission_earned', 'agent_commission']),
        grab(['rent_receivable_created']),
      ]);
      return { feesCollected, commissionFacilitated, rentFacilitated };
    },
  });

  // ---- 2. The data asset (behavioural signal) ----
  const { data: dataAsset, isLoading: loadingData } = useQuery({
    queryKey: ['ceo-rev-data-asset'],
    staleTime: 600000,
    queryFn: async () => {
      const head = async (table: string, mod?: (q: any) => any) => {
        let q = supabase.from(table as any).select('*', { count: 'exact', head: true });
        if (mod) q = mod(q);
        const { count } = await q;
        return count || 0;
      };
      const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
      const [
        totalUsers, trustScored, events30d, agentVisits, rentHistory, verifiedIds, rentRequests,
      ] = await Promise.all([
        head('profiles'),
        head('welile_trust_score_cache'),
        head('system_events', (q) => q.gte('created_at', since30)),
        head('agent_visits'),
        head('rent_history_records'),
        head('profiles', (q) => q.not('national_id', 'is', null)),
        head('rent_requests'),
      ]);
      return { totalUsers, trustScored, events30d, agentVisits, rentHistory, verifiedIds, rentRequests };
    },
  });

  // ---- 4. Monthly revenue growth (fees billed by month) ----
  // Derived from the same server-aggregated RPC (no client row cap).
  const monthly = (feeLedger?.monthlyRaw || []).map((m) => ({
    month: format(new Date(m.month_start), 'MMM'),
    access: Number(m.access || 0),
    platform: Number(m.platform || 0),
    total: Number(m.total || 0),
  }));

  const billed = feeLedger?.billed || 0;
  const totalUsers = dataAsset?.totalUsers || 0;
  const trustCoverage = totalUsers ? Math.round(((dataAsset?.trustScored || 0) / totalUsers) * 100) : 0;
  const idCoverage = totalUsers ? Math.round(((dataAsset?.verifiedIds || 0) / totalUsers) * 100) : 0;
  const arpu = totalUsers ? billed / totalUsers : 0;
  const revPerSignal = dataAsset?.events30d ? billed / dataAsset.events30d : 0;
  const revPerRent = dataAsset?.rentRequests ? billed / dataAsset.rentRequests : 0;

  return (
    <div className="space-y-6">
      {/* ============ 1. FINANCIAL VALUE ============ */}
      <section>
        <SectionHeader
          icon={DollarSign}
          title="Financial Value"
          subtitle="What the platform monetises today (ASC 606 recognised over the rent cycle)"
        />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
          <KPICard title="Revenue Billed" value={formatUGX(billed)} icon={Banknote} loading={loadingFees}
            color="bg-emerald-500/10 text-emerald-600" subtitle="Access + platform fees invoiced" />
          <KPICard title="Recognised Revenue" value={formatUGX(feeLedger?.recognized || 0)} icon={TrendingUp} loading={loadingFees}
            color="bg-green-500/10 text-green-600" subtitle="Earned to date" />
          <KPICard title="Deferred (Future)" value={formatUGX(feeLedger?.deferred || 0)} icon={Clock} loading={loadingFees}
            color="bg-amber-500/10 text-amber-600" subtitle="Contracted, not yet earned" />
          <KPICard title="Cash Fees Collected" value={formatUGX(ledgerRev?.feesCollected || 0)} icon={Coins} loading={loadingLedger}
            color="bg-teal-500/10 text-teal-600" subtitle="Actually banked" />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:gap-3 mt-2 sm:mt-3">
          <KPICard title="Rent Facilitated (GMV)" value={formatUGX(ledgerRev?.rentFacilitated || 0)} icon={PiggyBank} loading={loadingLedger}
            color="bg-blue-500/10 text-blue-600" subtitle="Economic activity we power" />
          <KPICard title="Agent Commission Paid" value={formatUGX(ledgerRev?.commissionFacilitated || 0)} icon={Users} loading={loadingLedger}
            color="bg-rose-500/10 text-rose-600" subtitle="Value returned to the field" />
        </div>
      </section>

      {/* ============ 2. THE DATA ASSET ============ */}
      <section>
        <SectionHeader
          icon={Database}
          title="The Data Asset"
          subtitle="Africa's rental behaviour, captured as structured, verifiable signal"
        />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
          <KPICard title="Behavioural Events (30d)" value={num(dataAsset?.events30d || 0)} icon={Activity} loading={loadingData}
            color="bg-primary/10 text-primary" subtitle="Observed actions turned to data" />
          <KPICard title="Trust-Scored Users" value={num(dataAsset?.trustScored || 0)} icon={Gauge} loading={loadingData}
            color="bg-violet-500/10 text-violet-600" subtitle={`${trustCoverage}% of user base`} />
          <KPICard title="GPS-Verified Visits" value={num(dataAsset?.agentVisits || 0)} icon={MapPin} loading={loadingData}
            color="bg-cyan-500/10 text-cyan-600" subtitle="Field-verified ground truth" />
          <KPICard title="Verified Identities" value={num(dataAsset?.verifiedIds || 0)} icon={ShieldCheck} loading={loadingData}
            color="bg-indigo-500/10 text-indigo-600" subtitle={`${idCoverage}% ID coverage`} />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:gap-3 mt-2 sm:mt-3">
          <KPICard title="Rent History Records" value={num(dataAsset?.rentHistory || 0)} icon={FileText} loading={loadingData}
            color="bg-orange-500/10 text-orange-600" subtitle="The proprietary credit dataset" />
          <KPICard title="Rent Journeys Tracked" value={num(dataAsset?.rentRequests || 0)} icon={Layers} loading={loadingData}
            color="bg-slate-500/10 text-muted-foreground" subtitle="End-to-end financed journeys" />
        </div>
        <div className="mt-2 sm:mt-3">
          <DataCompletenessScorecard />
        </div>
      </section>

      {/* ============ 3. VALUE FROM DATA (unit economics) ============ */}
      <section>
        <SectionHeader
          icon={Gauge}
          title="Value from Data"
          subtitle="How efficiently behavioural signal converts into money"
        />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
          <KPICard title="Revenue per User (ARPU)" value={formatUGX(arpu)} icon={DollarSign} loading={loadingFees || loadingData}
            color="bg-emerald-500/10 text-emerald-600" subtitle="Billed ÷ total users" />
          <KPICard title="Revenue per Rent Journey" value={formatUGX(revPerRent)} icon={TrendingUp} loading={loadingFees || loadingData}
            color="bg-green-500/10 text-green-600" subtitle="Monetisation per financed tenant" />
          <KPICard title="Revenue per Signal" value={formatUGX(revPerSignal)} icon={Activity} loading={loadingFees || loadingData}
            color="bg-primary/10 text-primary" subtitle="Billed ÷ 30-day events" />
          <KPICard title="Data Coverage" value={`${trustCoverage}%`} icon={Gauge} loading={loadingData}
            color="bg-violet-500/10 text-violet-600" subtitle="Users converted to scored data" />
        </div>
        <div className="mt-2 sm:mt-3">
          <MonetizationFunnel />
        </div>
      </section>

      {/* ============ 4. GROWTH TRAJECTORY ============ */}
      <section>
        <SectionHeader icon={TrendingUp} title="Growth Trajectory" subtitle="Revenue billed by month, split by stream" />
        <div className="mb-3 sm:mb-4">
          <RevenueMixDrivers />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
          <div className="rounded-2xl border border-border bg-card p-3 sm:p-4">
            <h4 className="text-sm font-semibold mb-3">Revenue Billed (6 months)</h4>
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={monthly || []}>
                <defs>
                  <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="month" className="text-xs" />
                <YAxis className="text-xs" tickFormatter={compact} width={44} />
                <Tooltip formatter={(v: number) => formatUGX(v)} />
                <Area type="monotone" dataKey="total" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#revGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="rounded-2xl border border-border bg-card p-3 sm:p-4">
            <h4 className="text-sm font-semibold mb-3">Revenue Mix by Stream</h4>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={monthly || []}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="month" className="text-xs" />
                <YAxis className="text-xs" tickFormatter={compact} width={44} />
                <Tooltip formatter={(v: number) => formatUGX(v)} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="access" name="Access fee" stackId="a" fill="hsl(var(--primary))" radius={[0, 0, 0, 0]} />
                <Bar dataKey="platform" name="Platform fee" stackId="a" fill="hsl(var(--primary)/0.45)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>
    </div>
  );
}

function SectionHeader({ icon: Icon, title, subtitle }: { icon: any; title: string; subtitle: string }) {
  return (
    <div className="flex items-start gap-2.5 mb-3">
      <div className="p-2 rounded-lg bg-primary/10 text-primary shrink-0">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <h3 className="text-base font-bold leading-tight">{title}</h3>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
    </div>
  );
}