import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Bell, UserPlus, FileText, Banknote, Activity, TrendingUp, TrendingDown, Loader2, ChevronRight } from 'lucide-react';
import { BriefDrillDownModal, type DrillMetric } from './BriefDrillDownModal';
import { AgentDefinitionFunnel } from './AgentDefinitionFunnel';
import { ComprehensiveReportButton } from './ComprehensiveReportButton';


import {
  ResponsiveContainer,
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';
import { cn } from '@/lib/utils';
import { format, subDays, subHours, startOfDay, eachDayOfInterval, eachHourOfInterval, isAfter } from 'date-fns';

export type DateRange = '24h' | '7d' | '1m';

export interface AgentOpsHomeViewProps {
  range: DateRange;
  onRangeChange: (r: DateRange) => void;
  onOpenSection: (key: string) => void;
}

const RANGE_OPTIONS: { key: DateRange; label: string }[] = [
  { key: '24h', label: '24H' },
  { key: '7d', label: '7D' },
  { key: '1m', label: '1M' },
];

const COMMISSION_LEDGER_CATEGORIES = [
  'agent_commission_earned',
  'agent_commission',
  'agent_bonus',
  'agent_investment_commission',
  'proxy_investment_commission',
  'partner_commission',
];

const COMMISSION_CREDIT_DIRECTIONS = ['cash_in', 'credit'];

interface TimestampRow {
  created_at: string | null;
}

interface CommissionLedgerRow extends TimestampRow {
  transaction_date?: string | null;
  amount?: number | string | null;
}

function getRangeStart(range: DateRange): Date {
  switch (range) {
    case '24h':
      return subHours(new Date(), 24);
    case '7d':
      return subDays(new Date(), 7);
    case '1m':
      return subDays(new Date(), 30);
  }
}

function getPrevRangeStart(range: DateRange): Date {
  switch (range) {
    case '24h':
      return subHours(new Date(), 48);
    case '7d':
      return subDays(new Date(), 14);
    case '1m':
      return subDays(new Date(), 60);
  }
}

function bucketsForRange(range: DateRange): { date: Date; label: string }[] {
  const now = new Date();
  if (range === '24h') {
    const start = subHours(now, 23);
    return eachHourOfInterval({ start, end: now }).map((d) => ({
      date: d,
      label: format(d, 'HH:00'),
    }));
  }
  const days = range === '7d' ? 7 : 30;
  const start = subDays(startOfDay(now), days - 1);
  return eachDayOfInterval({ start, end: now }).map((d) => ({
    date: d,
    label: format(d, range === '7d' ? 'EEE' : 'd MMM'),
  }));
}

function bucketKey(d: Date, range: DateRange): string {
  if (range === '24h') return format(d, 'yyyy-MM-dd HH');
  return format(d, 'yyyy-MM-dd');
}

function fmtMoney(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString();
}

function pctChange(curr: number, prev: number): number {
  if (prev === 0) return curr > 0 ? 100 : 0;
  return ((curr - prev) / prev) * 100;
}

interface BriefCardProps {
  title: string;
  value: string | number;
  changePct: number;
  series: number[];
  icon: React.ComponentType<{ className?: string }>;
  loading?: boolean;
  onClick?: () => void;
  accent: 'primary' | 'emerald' | 'amber' | 'sky';
}

const ACCENT_MAP: Record<BriefCardProps['accent'], { bg: string; fg: string; stroke: string }> = {
  primary: { bg: 'bg-primary/10', fg: 'text-primary', stroke: 'hsl(var(--primary))' },
  emerald: { bg: 'bg-emerald-500/10', fg: 'text-emerald-600 dark:text-emerald-400', stroke: 'hsl(160 84% 39%)' },
  amber: { bg: 'bg-amber-500/10', fg: 'text-amber-600 dark:text-amber-400', stroke: 'hsl(38 92% 50%)' },
  sky: { bg: 'bg-sky-500/10', fg: 'text-sky-600 dark:text-sky-400', stroke: 'hsl(199 89% 48%)' },
};

function BriefCard({ title, value, changePct, series, icon: Icon, loading, onClick, accent }: BriefCardProps) {
  const colors = ACCENT_MAP[accent];
  const sparkData = series.map((v, i) => ({ x: i, y: v }));
  const isUp = changePct >= 0;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group text-left rounded-2xl border border-border/50 bg-card p-3 sm:p-4',
        'shadow-sm hover:shadow-md hover:border-primary/30 transition-all active:scale-[0.98] touch-manipulation',
        'flex flex-col gap-2 min-h-[128px]',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className={cn('h-8 w-8 rounded-xl flex items-center justify-center shrink-0', colors.bg)}>
          <Icon className={cn('h-4 w-4', colors.fg)} />
        </div>
        <Badge
          variant="secondary"
          className={cn(
            'h-5 gap-0.5 px-1.5 text-[10px] font-semibold',
            isUp
              ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30'
              : 'bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30',
          )}
        >
          {isUp ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
          {Math.abs(changePct).toFixed(0)}%
        </Badge>
      </div>
      <div className="min-w-0">
        <p className="text-[11px] font-medium text-muted-foreground line-clamp-1">{title}</p>
        <p className="text-xl sm:text-2xl font-bold text-foreground leading-tight tabular-nums">
          {loading ? <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /> : value}
        </p>
      </div>
      <div className="h-9 -mx-1 -mb-1">
        {sparkData.length > 1 && (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={sparkData} margin={{ top: 2, right: 2, bottom: 0, left: 2 }}>
              <defs>
                <linearGradient id={`spark-${title}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={colors.stroke} stopOpacity={0.4} />
                  <stop offset="100%" stopColor={colors.stroke} stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area
                type="monotone"
                dataKey="y"
                stroke={colors.stroke}
                strokeWidth={1.5}
                fill={`url(#spark-${title})`}
                isAnimationActive={false}
                dot={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </button>
  );
}

export function AgentOpsHomeView({ range, onRangeChange, onOpenSection }: AgentOpsHomeViewProps) {
  const queryClient = useQueryClient();
  const rangeStart = useMemo(() => getRangeStart(range).toISOString(), [range]);
  const prevRangeStart = useMemo(() => getPrevRangeStart(range).toISOString(), [range]);
  const [activeDrill, setActiveDrill] = useState<DrillMetric | null>(null);

  // Realtime: invalidate when underlying tables change
  useEffect(() => {
    const channel = supabase
      .channel('agent-ops-home-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'general_ledger' }, () => {
        queryClient.invalidateQueries({ queryKey: ['agent-ops-home'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rent_requests' }, () => {
        queryClient.invalidateQueries({ queryKey: ['agent-ops-home'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'user_roles' }, () => {
        queryClient.invalidateQueries({ queryKey: ['agent-ops-home'] });
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  const { data, isLoading } = useQuery({
    queryKey: ['agent-ops-home', range],
    queryFn: async () => {
      const [
        newAgentsCurr,
        newAgentsPrev,
        rentRequestsCurr,
        rentRequestsPrev,
        earningsCurr,
        earningsPrev,
      ] = await Promise.all([
        supabase.from('user_roles').select('user_id, created_at').eq('role', 'agent').gte('created_at', rangeStart),
        supabase
          .from('user_roles')
          .select('user_id', { count: 'exact', head: true })
          .eq('role', 'agent')
          .gte('created_at', prevRangeStart)
          .lt('created_at', rangeStart),
        supabase.from('rent_requests').select('id, agent_id, created_at').gte('created_at', rangeStart),
        supabase
          .from('rent_requests')
          .select('id, agent_id')
          .gte('created_at', prevRangeStart)
          .lt('created_at', rangeStart),
        // Source of truth: wallet-scoped general ledger commission credits.
        // `commission_accrual_ledger` and `agent_earnings` are legacy/accrual views and can lag real wallet earnings.
        supabase
          .from('general_ledger')
          .select('amount, created_at, transaction_date')
          .eq('ledger_scope', 'wallet')
          .in('category', COMMISSION_LEDGER_CATEGORIES)
          .in('direction', COMMISSION_CREDIT_DIRECTIONS)
          .gte('created_at', rangeStart),
        supabase
          .from('general_ledger')
          .select('amount')
          .eq('ledger_scope', 'wallet')
          .in('category', COMMISSION_LEDGER_CATEGORIES)
          .in('direction', COMMISSION_CREDIT_DIRECTIONS)
          .gte('created_at', prevRangeStart)
          .lt('created_at', rangeStart),
      ]);

      const currentCommissionRows = (earningsCurr.data ?? []) as CommissionLedgerRow[];
      const previousCommissionRows = (earningsPrev.data ?? []) as CommissionLedgerRow[];
      const newAgentsCurrCount = (newAgentsCurr.data ?? []).length;
      const earningsCurrTotal = currentCommissionRows.reduce((s, r) => s + Number(r.amount ?? 0), 0);
      const earningsPrevTotal = previousCommissionRows.reduce((s, r) => s + Number(r.amount ?? 0), 0);
      const rentCurrCount = (rentRequestsCurr.data ?? []).length;

      // Build buckets
      const buckets = bucketsForRange(range);
      const newAgentsByBucket = new Map(buckets.map((b) => [bucketKey(b.date, range), 0]));
      const rentByBucket = new Map(buckets.map((b) => [bucketKey(b.date, range), 0]));
      const earningsByBucket = new Map(buckets.map((b) => [bucketKey(b.date, range), 0]));
      const activeAgentsByBucket = new Map<string, Set<string>>(
        buckets.map((b) => [bucketKey(b.date, range), new Set<string>()]),
      );

      ((newAgentsCurr.data ?? []) as TimestampRow[]).forEach((r) => {
        const k = bucketKey(new Date(r.created_at), range);
        if (newAgentsByBucket.has(k)) newAgentsByBucket.set(k, (newAgentsByBucket.get(k) || 0) + 1);
      });
      ((rentRequestsCurr.data ?? []) as Array<TimestampRow & { agent_id?: string | null }>).forEach((r) => {
        const k = bucketKey(new Date(r.created_at!), range);
        if (rentByBucket.has(k)) rentByBucket.set(k, (rentByBucket.get(k) || 0) + 1);
        if (r.agent_id && activeAgentsByBucket.has(k)) activeAgentsByBucket.get(k)!.add(r.agent_id);
      });
      currentCommissionRows.forEach((r) => {
        const k = bucketKey(new Date(r.transaction_date || r.created_at), range);
        if (earningsByBucket.has(k))
          earningsByBucket.set(k, (earningsByBucket.get(k) || 0) + Number(r.amount ?? 0));
      });

      const trend = buckets.map((b) => {
        const k = bucketKey(b.date, range);
        return {
          label: b.label,
          agents: newAgentsByBucket.get(k) || 0,
          requests: rentByBucket.get(k) || 0,
          commission: earningsByBucket.get(k) || 0,
          activeAgents: activeAgentsByBucket.get(k)?.size || 0,
        };
      });

      // Total agents = operational agent universe (collected / collecting rent for a tenant).
      // Role rows are a signup artefact and must never be used as the agent count.
      const agentStats = await (supabase.rpc as any)('get_agent_ops_agent_stats', { p_days: 30 });
      const totalAgentCount = (agentStats.data?.total_agents as number) || 0;
      const activeCurrSet = new Set(
        ((rentRequestsCurr.data ?? []) as Array<{ agent_id?: string | null }>)
          .map((r) => r.agent_id)
          .filter((id): id is string => !!id),
      );
      const activePrevSet = new Set(
        ((rentRequestsPrev.data ?? []) as Array<{ agent_id?: string | null }>)
          .map((r) => r.agent_id)
          .filter((id): id is string => !!id),
      );
      const activeCount = activeCurrSet.size;
      const activePrevCount = activePrevSet.size;

      return {
        kpis: {
          newAgents: { value: newAgentsCurrCount, prev: newAgentsPrev.count || 0 },
          rentRequests: { value: rentCurrCount, prev: rentRequestsPrev.count || 0 },
          commission: { value: earningsCurrTotal, prev: earningsPrevTotal },
          activeAgents: { value: activeCount, prev: activePrevCount },
        },
        trend,
        activity: {
          active: activeCount,
          inactive: Math.max(0, totalAgentCount - activeCount),
        },
        totalAgentCount,
      };
    },
    staleTime: 60_000,
  });

  const cards: Array<Omit<BriefCardProps, 'series' | 'changePct'> & { rawValue: number; series: number[]; prev: number; drillKey: DrillMetric }> = [
    {
      title: 'New Agents Onboarded',
      value: data?.kpis.newAgents.value ?? 0,
      icon: UserPlus,
      accent: 'primary',
      loading: isLoading,
      onClick: () => setActiveDrill('new-agents'),
      drillKey: 'new-agents',
      rawValue: data?.kpis.newAgents.value ?? 0,
      prev: data?.kpis.newAgents.prev ?? 0,
      series: data?.trend.map((t) => t.agents) ?? [],
    },
    {
      title: 'Rent Requests',
      value: data?.kpis.rentRequests.value ?? 0,
      icon: FileText,
      accent: 'sky',
      loading: isLoading,
      onClick: () => setActiveDrill('rent-requests'),
      drillKey: 'rent-requests',
      rawValue: data?.kpis.rentRequests.value ?? 0,
      prev: data?.kpis.rentRequests.prev ?? 0,
      series: data?.trend.map((t) => t.requests) ?? [],
    },
    {
      title: 'Commission Earned (UGX)',
      value: fmtMoney(data?.kpis.commission.value ?? 0),
      icon: Banknote,
      accent: 'emerald',
      loading: isLoading,
      onClick: () => setActiveDrill('commission'),
      drillKey: 'commission',
      rawValue: data?.kpis.commission.value ?? 0,
      prev: data?.kpis.commission.prev ?? 0,
      series: data?.trend.map((t) => t.commission) ?? [],
    },
    {
      title: 'Active Agents',
      value: data?.kpis.activeAgents.value ?? 0,
      icon: Activity,
      accent: 'amber',
      loading: isLoading,
      onClick: () => setActiveDrill('active-agents'),
      drillKey: 'active-agents',
      rawValue: data?.kpis.activeAgents.value ?? 0,
      prev: data?.kpis.activeAgents.prev ?? 0,
      series: data?.trend.map((t) => t.activeAgents) ?? [],
    },
  ];

  return (
    <div className="space-y-4 pb-20 sm:pb-4">
      {/* Comprehensive report export — single centralised reporting period */}
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">Agent Operations Overview</h2>
          <p className="text-[11px] text-muted-foreground">Export the full board-grade operations report</p>
        </div>
        <ComprehensiveReportButton />
      </div>

      {/* Summary: Total Users → Agents → Active Agents + trend */}
      <AgentDefinitionFunnel range={range} />


      {/* Compact Active Users stat — share of the whole platform active in range */}
      <ActiveUsersStat range={range} />


      {/* Drill-down modal */}
      <BriefDrillDownModal
        open={activeDrill !== null}
        onOpenChange={(open) => {
          if (!open) setActiveDrill(null);
        }}
        metric={activeDrill}
        range={range}
        series={
          activeDrill
            ? cards.find((c) => c.drillKey === activeDrill)?.series ?? []
            : []
        }
        kpiValue={
          activeDrill ? cards.find((c) => c.drillKey === activeDrill)?.value ?? 0 : 0
        }
        changePct={
          activeDrill
            ? pctChange(
                cards.find((c) => c.drillKey === activeDrill)?.rawValue ?? 0,
                cards.find((c) => c.drillKey === activeDrill)?.prev ?? 0,
              )
            : 0
        }
        onOpenSection={onOpenSection}
      />
    </div>
  );
}

// Re-export helpers for tests if ever needed
export { fmtMoney, pctChange };

// silence unused import warning for isAfter (kept for future filtering use)
void isAfter;

/* ------------------------------------------------------------------
 * ActiveAgentsTrendChart
 * Compact time-series of active agents per bucket (hour for 24h, day
 * for 7d/30d). Pairs with the hero KPI so ops can see momentum, not
 * just the headline number.
 * ------------------------------------------------------------------ */
function ActiveAgentsTrendChart({
  data,
  range,
  loading,
}: {
  data: Array<{ label: string; activeAgents: number }>;
  range: DateRange;
  loading?: boolean;
}) {
  const total = data.reduce((s, d) => s + (d.activeAgents || 0), 0);
  const peak = data.reduce(
    (best, d) => (d.activeAgents > best.value ? { label: d.label, value: d.activeAgents } : best),
    { label: '—', value: 0 },
  );
  const granularity = range === '24h' ? 'per hour' : 'per day';

  return (
    <Card className="rounded-2xl border-border/50 p-3 sm:p-4">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">Active Agents Trend</h3>
          <p className="text-[11px] text-muted-foreground">
            Unique agents posting ≥1 tenant request · {granularity}
          </p>
        </div>
        {!loading && peak.value > 0 && (
          <Badge variant="outline" className="text-[10px] shrink-0">
            Peak {peak.value} · {peak.label}
          </Badge>
        )}
      </div>
      <div className="h-32 sm:h-36 -mx-2">
        {loading ? (
          <div className="h-full w-full flex items-center justify-center">
            <Loader2 className="h-5 w-5 text-muted-foreground animate-spin" />
          </div>
        ) : total === 0 ? (
          <div className="h-full w-full flex items-center justify-center">
            <p className="text-xs text-muted-foreground">No active agents in this window yet.</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="active-agents-trend-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(38 92% 50%)" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="hsl(38 92% 50%)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" width={28} allowDecimals={false} />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'hsl(var(--card))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: 12,
                  fontSize: 12,
                }}
                formatter={(v: number) => [v, 'Active agents']}
              />
              <Area
                type="monotone"
                dataKey="activeAgents"
                stroke="hsl(38 92% 50%)"
                strokeWidth={2}
                fill="url(#active-agents-trend-fill)"
                dot={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------
 * ActiveUsersStat
 * Compact KPI strip for "Active Users" — distinct people who took any
 * tracked action on the platform in the selected window. Shows the count,
 * the share of total users, and momentum vs the previous window.
 * Reuses the funnel RPC cache (same query key) so it adds no extra fetch.
 * ------------------------------------------------------------------ */
function ActiveUsersStat({ range }: { range: DateRange }) {
  const days = range === '24h' ? 1 : range === '7d' ? 7 : 30;
  const { data, isLoading } = useQuery({
    queryKey: ['agent-definition-funnel', days],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('get_agent_ops_agent_stats', { p_days: days });
      if (error) throw error;
      return data as {
        total_users: number;
        active_users: number;
        active_users_prev: number;
      };
    },
    staleTime: 60_000,
  });

  const totalUsers = data?.total_users ?? 0;
  const activeUsers = data?.active_users ?? 0;
  const prev = data?.active_users_prev ?? 0;
  const share = totalUsers > 0 ? Math.min(100, (activeUsers / totalUsers) * 100) : 0;
  const change = pctChange(activeUsers, prev);
  const isUp = change >= 0;
  const rangeLabel = range === '24h' ? 'last 24h' : range === '7d' ? 'last 7 days' : 'last 30 days';

  return (
    <div className="rounded-2xl border border-border/50 bg-card p-3 sm:p-4 shadow-sm">
      <div className="flex items-center gap-3">
        <span className="h-9 w-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
          <Activity className="h-5 w-5 text-primary" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium text-muted-foreground leading-tight">
            Active Users · {rangeLabel}
          </p>
          <div className="flex items-baseline gap-2 flex-wrap">
            {isLoading ? (
              <Loader2 className="h-5 w-5 text-muted-foreground animate-spin" />
            ) : (
              <span className="text-2xl font-bold tabular-nums text-foreground leading-none">
                {activeUsers.toLocaleString()}
              </span>
            )}
            {!isLoading && totalUsers > 0 && (
              <span className="text-xs font-medium text-muted-foreground">
                of {totalUsers.toLocaleString()} · {share.toFixed(1)}%
              </span>
            )}
          </div>
        </div>
        {!isLoading && (
          <Badge
            variant="secondary"
            className={cn(
              'h-6 gap-0.5 px-2 text-[11px] font-semibold shrink-0',
              isUp
                ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30'
                : 'bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30',
            )}
          >
            {isUp ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
            {Math.abs(change).toFixed(0)}%
          </Badge>
        )}
      </div>
      <div className="mt-2.5 h-1.5 rounded-full bg-muted overflow-hidden">
        <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${share}%` }} />
      </div>
    </div>
  );
}