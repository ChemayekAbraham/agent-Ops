import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { roleToSlug } from '@/lib/roleRoutes';
import { supabase } from '@/integrations/supabase/client';
import { 
  Users, TrendingUp, Home, Banknote, ShieldCheck, UserPlus, 
  Building2, Clock, AlertTriangle, CheckCircle, ArrowLeft,
  Activity, Handshake, Loader2, SmartphoneNfc, UserCheck, User
} from 'lucide-react';
import { cn } from '@/lib/utils';
import ScreenLoader from '@/components/common/ScreenLoader';

import { formatUGX } from '@/lib/rentCalculations';
import { formatDistanceToNow } from 'date-fns';
import { COOWithdrawalApprovals } from '@/components/coo/COOWithdrawalApprovals';
import { COOPartnerWithdrawalApprovals } from '@/components/coo/COOPartnerWithdrawalApprovals';
import { COOROIApprovals } from '@/components/coo/COOROIApprovals';
import { CancelledProxyWithdrawals } from '@/components/coo/CancelledProxyWithdrawals';

type HealthStatus = 'green' | 'yellow' | 'red';

interface MetricTile {
  id: string;
  label: string;
  value: string | number;
  icon: typeof Users;
  status: HealthStatus;
  detail?: string;
  drilldownData?: { label: string; value: string | number }[];
  route?: string;
}

function getStatusColor(status: HealthStatus) {
  return {
    green: 'border-emerald-500/40 bg-emerald-500/8',
    yellow: 'border-amber-500/40 bg-amber-500/8',
    red: 'border-red-500/40 bg-red-500/8',
  }[status];
}

function getStatusIconColor(status: HealthStatus) {
  return {
    green: 'text-emerald-600',
    yellow: 'text-amber-600',
    red: 'text-red-600',
  }[status];
}

function getStatusBadge(status: HealthStatus) {
  if (status === 'red') return (
    <span className="text-[10px] font-black uppercase tracking-widest text-red-600 bg-red-500/15 px-2 py-0.5 rounded-full">
      ACTION REQUIRED
    </span>
  );
  if (status === 'yellow') return (
    <span className="text-[10px] font-bold uppercase tracking-widest text-amber-600 bg-amber-500/15 px-2 py-0.5 rounded-full">
      Monitor
    </span>
  );
  return (
    <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-600 bg-emerald-500/15 px-2 py-0.5 rounded-full">
      Healthy
    </span>
  );
}

function StatusDot({ status }: { status: HealthStatus }) {
  const colors = { green: 'bg-emerald-500', yellow: 'bg-amber-500', red: 'bg-red-500' };
  return (
    <div className="relative">
      <div className={cn('w-3 h-3 rounded-full', colors[status])} />
      {status === 'red' && <div className={cn('absolute inset-0 w-3 h-3 rounded-full animate-ping opacity-75', colors[status])} />}
    </div>
  );
}

function TileCard({ tile }: { tile: MetricTile }) {
  const navigate = useNavigate();
  return (
    <button
      onClick={() => tile.route && navigate(tile.route)}
      className={cn(
        'w-full text-left rounded-2xl border-2 p-4 transition-all active:scale-[0.97] hover:shadow-md',
        getStatusColor(tile.status)
      )}
    >
      <div className="flex items-start justify-between mb-3">
        <div className={cn('p-2 rounded-xl bg-background/60', getStatusIconColor(tile.status))}>
          <tile.icon className="h-5 w-5" />
        </div>
        <StatusDot status={tile.status} />
      </div>
      <p className="text-2xl font-black tracking-tight tabular-nums">{tile.value}</p>
      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mt-1">{tile.label}</p>
      {tile.status === 'red' && (
        <div className="mt-2">{getStatusBadge(tile.status)}</div>
      )}
    </button>
  );
}

export default function COODashboard() {
  const { user, role, roles, loading } = useAuth();
  const navigate = useNavigate();
  const [metrics, setMetrics] = useState<MetricTile[]>([]);
  const [guidance, setGuidance] = useState<{ message: string; level: HealthStatus }[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!loading && !user) {
      navigate('/auth');
      return;
    }
    if (!loading && user && !roles.includes('manager')) {
      navigate(roleToSlug(role));
      return;
    }
    if (user && roles.includes('manager')) fetchMetrics();
  }, [user, loading, roles]);

  async function fetchMetrics() {
    setIsLoading(true);
    try {
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

      // Parallel queries
      const [
        activeUsersRes,
        earningAgentsRes,
        tenantsWithBalancesRes,
        newRentRequestsRes,
        newRentRequestsWeekRes,
        recentRentDetailsRes,
        activeSupportersRes,
        newSupporterReqRes,
        activeLandlordsRes,
        pipelineLandlordsRes,
        expectedRepaymentsRes,
      ] = await Promise.all([
        // 1. Active users (last 7 days) — exact count is fine here
        supabase.from('profiles').select('id', { count: 'exact', head: true })
          .gte('last_active_at', sevenDaysAgo),
        // 2. Active earning agents — need distinct agent_ids
        supabase.from('agent_earnings').select('agent_id')
          .gte('created_at', sevenDaysAgo),
        // 3. Active tenants with balances — fetch per-tenant figures so we can
        // dedupe by tenant and only count those with a NET positive balance
        // (matches the detail view's source of truth exactly).
        supabase.from('rent_requests').select('tenant_id, total_repayment, amount_repaid')
          .in('status', ['funded', 'approved']),
        // 4. New rent requests today
        supabase.from('rent_requests').select('id', { count: 'exact', head: true })
          .gte('created_at', today),
        // 4b. New rent requests this week
        supabase.from('rent_requests').select('id', { count: 'exact', head: true })
          .gte('created_at', sevenDaysAgo),
        // 4c. Recent rent request details for drilldown
        supabase.from('rent_requests')
          .select('id, rent_amount, duration_days, daily_repayment, total_repayment, access_fee, request_fee, created_at, tenant_id, agent_id, tenant_no_smartphone, status')
          .in('status', ['pending', 'approved'])
          .order('created_at', { ascending: false })
          .limit(20),
        // 5. All supporters (by role) — total partner count
        supabase.from('user_roles').select('user_id')
          .eq('role', 'supporter')
          .or('enabled.is.null,enabled.eq.true'),
        // 6. New supporter requests this week
        supabase.from('user_roles').select('id', { count: 'exact', head: true })
          .eq('role', 'supporter')
          .gte('created_at', sevenDaysAgo),
        // 7. Active landlords — need distinct landlord_ids
        supabase.from('rent_requests').select('landlord_id')
          .in('status', ['funded', 'disbursed'])
          .gte('funded_at', thirtyDaysAgo),
        // 8. Landlords in pipeline
        supabase.from('landlords').select('id', { count: 'exact', head: true })
          .eq('verified', false),
        // 9. Expected repayments
        supabase.from('rent_requests').select('total_repayment, amount_repaid')
          .in('status', ['funded', 'approved']),
      ]);

      const activeUsers = activeUsersRes.count || 0;
      // Distinct counts for agents, supporters, landlords
      const activeAgents = new Set((earningAgentsRes.data || []).map(r => r.agent_id)).size;
      // Dedupe by tenant and count only tenants whose aggregate outstanding > 0
      // so this KPI equals the deduped/filtered detail table (no raw-row inflation).
      const tenantBalanceAgg = new Map<string, number>();
      ((tenantsWithBalancesRes.data as any[]) || []).forEach((r) => {
        if (!r.tenant_id) return;
        const prev = tenantBalanceAgg.get(r.tenant_id) || 0;
        tenantBalanceAgg.set(r.tenant_id, prev + ((r.total_repayment || 0) - (r.amount_repaid || 0)));
      });
      const tenantsWithBalances = Array.from(tenantBalanceAgg.values()).filter((v) => v > 0).length;
      const newRentToday = newRentRequestsRes.count || 0;
      const newRentWeek = newRentRequestsWeekRes.count || 0;
      const activeSupporters = (activeSupportersRes.data || []).length;
      const newSupporterReq = newSupporterReqRes.count || 0;
      const activeLandlords = new Set((activeLandlordsRes.data || []).map(r => r.landlord_id)).size;
      const pipelineLandlords = pipelineLandlordsRes.count || 0;

      // Resolve profile names for recent rent requests
      const recentRequests = recentRentDetailsRes.data || [];
      const allProfileIds = [...new Set(recentRequests.flatMap(r => [r.tenant_id, r.agent_id].filter(Boolean)))] as string[];
      let profileMap = new Map<string, string>();
      if (allProfileIds.length > 0) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', allProfileIds);
        profileMap = new Map((profiles || []).map(p => [p.id, p.full_name]));
      }

      // Build rent request drilldown items
      const totalPendingAmount = recentRequests.filter(r => r.status === 'pending').reduce((s, r) => s + (r.rent_amount || 0), 0);
      const rentDrilldown: { label: string; value: string | number }[] = [
        { label: 'Today', value: newRentToday },
        { label: 'This week', value: newRentWeek },
        { label: 'Total Pending Amount', value: formatUGX(totalPendingAmount) },
        { label: '───── Recent Requests ─────', value: '' },
        ...recentRequests.slice(0, 10).map(r => {
          const tenantName = profileMap.get(r.tenant_id) || 'Unknown';
          const agentName = r.agent_id ? profileMap.get(r.agent_id) : null;
          const postedBy = r.agent_id && r.agent_id !== r.tenant_id
            ? `👤 Agent: ${agentName || 'Unknown'}`
            : '📱 Self-posted';
          const noPhone = r.tenant_no_smartphone ? ' 🚫📱' : '';
          return {
            label: `${tenantName}${noPhone} — ${postedBy}`,
            value: formatUGX(r.rent_amount),
          };
        }),
      ];

      // Calculate coverage
      const repaymentData = expectedRepaymentsRes.data || [];
      const totalExpected = repaymentData.reduce((sum, r) => sum + ((r.total_repayment || 0) - (r.amount_repaid || 0)), 0);
      
      // Coverage ratio (simplified: expected repayments vs active obligations)
      let coverageStatus: HealthStatus = 'green';
      let coverageLabel = 'Safe';
      if (totalExpected > 0) {
        if (tenantsWithBalances > 100) { coverageStatus = 'yellow'; coverageLabel = 'Tight'; }
        if (tenantsWithBalances > 500) { coverageStatus = 'red'; coverageLabel = 'Dangerous'; }
      }

      const tiles: MetricTile[] = [
        {
          id: 'active-users',
          label: 'Active Users (7d)',
          value: activeUsers,
          icon: Users,
          status: activeUsers > 10 ? 'green' : activeUsers > 0 ? 'yellow' : 'red',
          detail: `${activeUsers} users active in the last 7 days`,
          route: '/coo/active-users',
        },
        {
          id: 'earning-agents',
          label: 'Earning Agents (7d)',
          value: activeAgents,
          icon: TrendingUp,
          status: activeAgents > 5 ? 'green' : activeAgents > 0 ? 'yellow' : 'red',
          detail: `${activeAgents} agents earned in the last 7 days`,
          route: '/coo/earning-agents',
        },
        {
          id: 'active-tenants',
          label: 'Tenants With Balances',
          value: tenantsWithBalances,
          icon: Home,
          status: tenantsWithBalances > 0 ? 'green' : 'yellow',
          detail: `${tenantsWithBalances} active rent obligations`,
          route: '/coo/tenants-balances',
        },
        {
          id: 'new-rent',
          label: 'New Rent Requests',
          value: `${newRentToday} / ${newRentWeek}`,
          icon: Banknote,
          status: newRentWeek > 0 ? 'green' : 'yellow',
          detail: `${newRentToday} today, ${newRentWeek} this week. Total pending: ${formatUGX(totalPendingAmount)}`,
          drilldownData: rentDrilldown,
          route: '/coo/rent-requests',
        },
        {
          id: 'active-partners',
          label: 'Active Partners',
          value: activeSupporters,
          icon: Handshake,
          status: activeSupporters > 3 ? 'green' : activeSupporters > 0 ? 'yellow' : 'red',
          detail: `${activeSupporters} partners with active funding`,
          route: '/coo/active-partners',
        },
        {
          id: 'new-partner-requests',
          label: 'New Partner Requests',
          value: newSupporterReq,
          icon: UserPlus,
          status: newSupporterReq > 0 ? 'green' : 'yellow',
          detail: `${newSupporterReq} new partner signups this week`,
          route: '/coo/partner-requests',
        },
        {
          id: 'active-landlords',
          label: 'Active Landlords',
          value: activeLandlords,
          icon: Building2,
          status: activeLandlords > 3 ? 'green' : activeLandlords > 0 ? 'yellow' : 'red',
          detail: `${activeLandlords} landlords received payments in last 30 days`,
          route: '/coo/active-landlords',
        },
        {
          id: 'pipeline-landlords',
          label: 'Landlords in Pipeline',
          value: pipelineLandlords,
          icon: Clock,
          status: pipelineLandlords > 0 ? 'green' : 'yellow',
          detail: `${pipelineLandlords} landlords pending verification`,
          route: '/coo/pipeline-landlords',
        },
        {
          id: 'rent-coverage',
          label: 'Rent Coverage',
          value: coverageLabel,
          icon: ShieldCheck,
          status: coverageStatus,
          detail: coverageStatus === 'green' 
            ? 'Repayment capacity is healthy relative to obligations.' 
            : coverageStatus === 'yellow'
              ? 'Growth pressure detected. Monitor closely.'
              : 'Pause new rent approvals. Fix cash flow.',
          route: '/coo/rent-coverage',
        },
      ];

      setMetrics(tiles);

      // Generate guidance messages
      const msgs: { message: string; level: HealthStatus }[] = [];
      if (coverageStatus === 'red') {
        msgs.push({ message: '🚨 Pause new rent approvals. Fix cash flow.', level: 'red' });
      }
      if (coverageStatus === 'yellow' && newRentWeek > 5) {
        msgs.push({ message: '⚠️ Growth pressure detected. Monitor closely.', level: 'yellow' });
      }
      if (activeAgents === 0) {
        msgs.push({ message: '⚠️ No agents earning. Operational issue suspected. Investigate.', level: 'yellow' });
      }
      if (activeLandlords === 0 && pipelineLandlords === 0) {
        msgs.push({ message: '⚠️ Landlord pipeline empty. Investigate.', level: 'yellow' });
      }
      if (msgs.length === 0) {
        msgs.push({ message: '✅ All systems operational. Safe to grow.', level: 'green' });
      }
      setGuidance(msgs);
    } catch (err) {
      console.error('[COO Dashboard] Error:', err);
    } finally {
      setIsLoading(false);
    }
  }

  if (isLoading) {
    return (
      <ScreenLoader label="Loading COO Dashboard..." />
    );
  }

  return (
    <div className="min-h-screen bg-background pb-24 lg:pb-8 lg:max-w-6xl lg:mx-auto">
      {/* Header */}
      <div className="sticky top-0 z-40 bg-background/95 backdrop-blur-lg border-b border-border">
        <div className="flex items-center gap-3 p-4">
          <button onClick={() => navigate(roleToSlug(role))} className="p-2 -ml-2 rounded-xl hover:bg-muted active:scale-95">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="flex-1">
            <h1 className="text-lg font-black tracking-tight">COO Dashboard</h1>
            <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-semibold">
              Operations Health • {new Date().toLocaleDateString('en-UG', { day: 'numeric', month: 'short', year: 'numeric' })}
            </p>
          </div>
          <button onClick={fetchMetrics} className="p-2 rounded-xl hover:bg-muted active:scale-95">
            <Activity className="h-5 w-5 text-muted-foreground" />
          </button>
        </div>
      </div>

      {/* Guidance Alerts */}
      <div className="px-4 pt-4 space-y-2">
        {guidance.map((g, i) => (
          <div key={i} className={cn(
            'rounded-xl border-2 px-4 py-3 text-sm font-semibold',
            g.level === 'red' && 'border-red-500/40 bg-red-500/8 text-red-700 dark:text-red-400',
            g.level === 'yellow' && 'border-amber-500/40 bg-amber-500/8 text-amber-700 dark:text-amber-400',
            g.level === 'green' && 'border-emerald-500/40 bg-emerald-500/8 text-emerald-700 dark:text-emerald-400',
          )}>
            {g.message}
          </div>
        ))}
      </div>

      {/* Metric Tiles Grid */}
      <div className="px-4 pt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 lg:gap-4">
        {metrics.map(tile => (
          <TileCard key={tile.id} tile={tile} />
        ))}
      </div>

      {/* COO Withdrawal Approvals */}
      <div className="px-4 pt-4">
        <COOWithdrawalApprovals />
      </div>
      <div className="px-4 pt-4">
        <COOPartnerWithdrawalApprovals />
      </div>

      {/* COO ROI Return Approvals */}
      <div className="px-4 pt-4">
        <COOROIApprovals />
      </div>
      <div className="px-4 pt-4">
        <CancelledProxyWithdrawals />
      </div>
    </div>
  );
}
