import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatUGX } from '@/lib/rentCalculations';
import {
  Users, UserCheck, Activity, UserPlus, FileText, Banknote,
  Target, TrendingUp, TrendingDown, Loader2, Home, ScrollText, Network,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const COMMISSION_LEDGER_CATEGORIES = [
  'agent_commission_earned',
  'agent_commission',
  'agent_bonus',
  'agent_investment_commission',
  'proxy_investment_commission',
  'partner_commission',
];
const COMMISSION_CREDIT_DIRECTIONS = ['cash_in', 'credit'];

function monthStart(offset = 0): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function pct(n: number): string { return `${(n || 0).toFixed(1)}%`; }
function growth(curr: number, prev: number): number {
  if (prev <= 0) return curr > 0 ? 100 : 0;
  return ((curr - prev) / prev) * 100;
}

interface Stat {
  label: string;
  value: string;
  sub?: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  bg: string;
  changePct?: number;
}

/**
 * CEO dashboard summary card that mirrors the live values shown across the
 * Agent Ops dashboard (funnel + 24h brief + monthly advance KPIs).
 */
export function AgentOpsLiveStatsCard() {
  const { data, isLoading } = useQuery({
    queryKey: ['ceo-agent-ops-live-stats'],
    staleTime: 60_000,
    refetchOnMount: 'always',
    queryFn: async () => {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const startISO = todayStart.toISOString();

      const [funnelRes, monthlyRes, newAgentsRes, rentReqRes, commissionRes] = await Promise.all([
        (supabase.rpc as any)('get_agent_ops_agent_stats', { p_days: 1 }),
        (supabase.rpc as any)('get_agent_ops_monthly_kpis', { _month: monthStart(0) }),
        supabase.from('user_roles').select('user_id', { count: 'exact', head: true })
          .eq('role', 'agent').gte('created_at', startISO),
        supabase.from('rent_requests').select('id', { count: 'exact', head: true })
          .gte('created_at', startISO),
        supabase.from('general_ledger').select('amount')
          .eq('ledger_scope', 'wallet')
          .in('category', COMMISSION_LEDGER_CATEGORIES)
          .in('direction', COMMISSION_CREDIT_DIRECTIONS)
          .gte('created_at', startISO),
      ]);

      const funnel = (funnelRes.data ?? {}) as any;
      const monthly = (monthlyRes.data ?? {}) as any;
      const commissionToday = ((commissionRes.data ?? []) as any[])
        .reduce((s, r) => s + Number(r.amount ?? 0), 0);

      return {
        totalUsers: Number(funnel.total_users ?? 0),
        totalAgents: Number(funnel.total_agents ?? 0),
        activeAgents: Number(funnel.active_agents ?? 0),
        criteria: {
          houses: Number(funnel?.criteria?.house_listings ?? 0),
          notes: Number(funnel?.criteria?.promissory_notes ?? 0),
          subagents: Number(funnel?.criteria?.subagents ?? 0),
        },
        newAgentsToday: newAgentsRes.count ?? 0,
        rentRequestsToday: rentReqRes.count ?? 0,
        commissionToday,
        monthly: {
          volume: Number(monthly.volume_month ?? 0),
          volumePrev: Number(monthly.volume_prev ?? 0),
          newAgents: Number(monthly.new_adv_agents_month ?? 0),
          newAgentsPrev: Number(monthly.new_adv_agents_prev ?? 0),
          advAgents: Number(monthly.adv_agents_current ?? 0),
          totalAgents: Number(monthly.total_agents ?? 0),
          principal: Number(monthly.principal_total ?? 0),
          outstanding: Number(monthly.outstanding_total ?? 0),
          deliveries: Number(monthly.deliveries_month ?? 0),
        },
      };
    },
  });

  const funnelAgentsPct = data && data.totalUsers > 0 ? (data.totalAgents / data.totalUsers) * 100 : 0;
  const funnelActivePct = data && data.totalAgents > 0 ? (data.activeAgents / data.totalAgents) * 100 : 0;
  const trackingShare = data && data.monthly.totalAgents > 0
    ? (data.monthly.advAgents / data.monthly.totalAgents) * 100 : 0;
  const repayRate = data && data.monthly.principal > 0
    ? ((data.monthly.principal - data.monthly.outstanding) / data.monthly.principal) * 100 : 0;

  const funnelStats: Stat[] = data ? [
    { label: 'Total Users', value: data.totalUsers.toLocaleString(), icon: Users, color: 'text-sky-600 dark:text-sky-400', bg: 'bg-sky-500/10' },
    { label: 'Agents', value: data.totalAgents.toLocaleString(), sub: `${pct(funnelAgentsPct)} of users`, icon: UserCheck, color: 'text-primary', bg: 'bg-primary/10' },
    { label: 'Active (24h)', value: data.activeAgents.toLocaleString(), sub: `${pct(funnelActivePct)} of agents`, icon: Activity, color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-500/10' },
  ] : [];

  const briefStats: Stat[] = data ? [
    { label: 'New Agents Today', value: data.newAgentsToday.toLocaleString(), icon: UserPlus, color: 'text-primary', bg: 'bg-primary/10' },
    { label: 'Rent Requests Today', value: data.rentRequestsToday.toLocaleString(), icon: FileText, color: 'text-sky-600 dark:text-sky-400', bg: 'bg-sky-500/10' },
    { label: 'Commission Today', value: formatUGX(data.commissionToday), icon: Banknote, color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-500/10' },
  ] : [];

  const monthlyStats: Stat[] = data ? [
    {
      label: 'Advance Volume (MTD)', value: formatUGX(data.monthly.volume),
      sub: `vs ${formatUGX(data.monthly.volumePrev)} last mo.`,
      icon: Banknote, color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-500/10',
      changePct: growth(data.monthly.volume, data.monthly.volumePrev),
    },
    {
      label: 'New Advance Agents', value: data.monthly.newAgents.toLocaleString(),
      sub: `vs ${data.monthly.newAgentsPrev} last mo.`,
      icon: UserPlus, color: 'text-sky-600 dark:text-sky-400', bg: 'bg-sky-500/10',
      changePct: growth(data.monthly.newAgents, data.monthly.newAgentsPrev),
    },
    {
      label: 'Tracking Share', value: pct(trackingShare),
      sub: `goal 30%`,
      icon: Target, color: 'text-primary', bg: 'bg-primary/10',
    },
    {
      label: 'Repayment Rate', value: pct(repayRate),
      sub: `${formatUGX(Math.max(data.monthly.principal - data.monthly.outstanding, 0))} of ${formatUGX(data.monthly.principal)}`,
      icon: TrendingUp, color: repayRate >= 70 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400', bg: repayRate >= 70 ? 'bg-emerald-500/10' : 'bg-amber-500/10',
    },
  ] : [];

  const criteriaChips = data ? [
    { icon: Home, label: 'Houses listed', value: data.criteria.houses },
    { icon: ScrollText, label: 'Promissory notes', value: data.criteria.notes },
    { icon: Network, label: 'Sub-agents', value: data.criteria.subagents },
  ] : [];

  const renderStat = (s: Stat) => {
    const up = (s.changePct ?? 0) >= 0;
    return (
      <div key={s.label} className="flex items-center gap-3 rounded-xl border border-border/60 bg-background p-3">
        <div className={cn('p-2 rounded-lg shrink-0', s.bg)}>
          <s.icon className={cn('h-4 w-4', s.color)} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] text-muted-foreground truncate">{s.label}</p>
          <div className="flex items-baseline gap-1.5 flex-wrap">
            <p className="text-base sm:text-lg font-bold truncate tabular-nums">{s.value}</p>
            {s.changePct !== undefined && (
              <span className={cn('inline-flex items-center gap-0.5 text-[10px] font-semibold',
                up ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
                {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                {Math.abs(s.changePct).toFixed(0)}%
              </span>
            )}
          </div>
          {s.sub && <p className="text-[10px] text-muted-foreground truncate">{s.sub}</p>}
        </div>
      </div>
    );
  };

  return (
    <Card className="border-primary/20">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-3">
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Users className="h-5 w-5" />
          </div>
          <div>
            <CardTitle className="text-base">Agent Ops — Live Stats</CardTitle>
            <p className="text-xs text-muted-foreground">Mirror of the Agent Ops dashboard</p>
          </div>
        </div>
        <Badge variant="outline" className="text-[10px] gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" /> Live
        </Badge>
      </CardHeader>
      <CardContent className="space-y-5">
        {isLoading || !data ? (
          <div className="py-10 flex items-center justify-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Funnel — who is an agent</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {funnelStats.map(renderStat)}
              </div>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {criteriaChips.map((c) => (
                  <Badge key={c.label} variant="outline" className="text-[10px] gap-1">
                    <c.icon className="h-3 w-3" /> {c.label}: <span className="tabular-nums font-semibold">{c.value.toLocaleString()}</span>
                  </Badge>
                ))}
              </div>
            </div>

            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Today's brief</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {briefStats.map(renderStat)}
              </div>
            </div>

            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Monthly advance KPIs</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
                {monthlyStats.map(renderStat)}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default AgentOpsLiveStatsCard;