import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { format, subDays, startOfDay, endOfDay, startOfMonth, startOfYear, addDays } from 'date-fns';
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar,
  XAxis, YAxis,
  CartesianGrid, Tooltip, Legend,
} from 'recharts';
import {
  Users, UserPlus, Activity, FileText, Home, Wallet, Banknote, TrendingDown,
  TrendingUp, ArrowRight, Coins, Hourglass, Receipt, Trophy,
  RefreshCw, Search,
} from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';


import { AgentRentCapacityPanel } from '../AgentRentCapacityPanel';
import { ActiveAgentsBreakdownDialog } from './ActiveAgentsBreakdownDialog';
import type { DateRange } from 'react-day-picker';
import { OpsDateRangeFilter, resolveRange, rangePhrase, type PresetKey } from '@/components/executive/shared/OpsDateRangeFilter';




// KPIs aggregate the selected date range. The trend chart always uses the last
// 30 days so spark lines have enough daily buckets.
const DAILY_TREND_DAYS = 30;

function fmtMoney(n: number): string {
  if (n >= 1e9) return `UGX ${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `UGX ${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `UGX ${(n / 1e3).toFixed(1)}K`;
  return `UGX ${Math.round(n).toLocaleString()}`;
}

function fmtNum(n: number): string {
  return Number(n || 0).toLocaleString();
}

function pctDelta(curr: number, prev: number): number {
  if (!prev) return curr > 0 ? 100 : 0;
  return ((curr - prev) / prev) * 100;
}

interface KpiTileProps {
  title: string;
  value: string;
  delta?: number;
  icon: React.ComponentType<{ className?: string }>;
  accent: string;
  spark?: number[];
  onClick?: () => void;
  loading?: boolean;
  subtitle?: ReactNode;
}

function KpiTile({ title, value, delta, icon: Icon, accent, onClick, loading, subtitle }: KpiTileProps) {
  const up = (delta ?? 0) >= 0;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group text-left rounded-2xl border border-border/50 bg-card p-3 sm:p-4',
        'shadow-sm hover:shadow-md hover:border-primary/30 transition-all active:scale-[0.98]',
        'flex flex-col gap-1.5 min-h-[104px]',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className={cn('h-8 w-8 rounded-xl flex items-center justify-center shrink-0', accent)}>
          <Icon className="h-4 w-4 text-white" />
        </div>
        {typeof delta === 'number' && !loading && (
          <Badge
            variant="secondary"
            className={cn(
              'h-5 gap-0.5 px-1.5 text-[10px] font-semibold',
              up
                ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30'
                : 'bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30',
            )}
          >
            {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
            {Math.abs(delta).toFixed(0)}%
          </Badge>
        )}
      </div>
      <p className="text-[11px] font-medium text-muted-foreground line-clamp-1">{title}</p>
      {loading ? (
        <Skeleton className="h-6 w-20" />
      ) : (
        <p className="text-lg sm:text-xl font-bold text-foreground leading-tight tabular-nums">{value}</p>
      )}
      {subtitle && !loading && (
        <p className="text-[10px] text-muted-foreground line-clamp-1 tabular-nums">{subtitle}</p>
      )}
    </button>
  );
}

interface OverviewPayload {
  kpis: Record<string, number>;
  trend: Array<{ day: string; agents: number; requests: number; collections: number; commission: number; active_agents: number; expected?: number; pending?: number }>;
  top_performers?: Array<{
    user_id: string; name: string; phone: string | null; category: 'Agent' | 'Sub-Agent';
    collected: number; collections: number; commission: number;
  }>;
  generated_at: string;
}

export interface AgentOpsOverviewProps {
  onOpenSection: (key: string) => void;
}

export function AgentOpsOverview({ onOpenSection }: AgentOpsOverviewProps) {
  const qc = useQueryClient();
  const [preset, setPreset] = useState<PresetKey>('today');
  const [activeBreakdownOpen, setActiveBreakdownOpen] = useState(false);
  const [custom, setCustom] = useState<DateRange | undefined>();
  const { start, end } = useMemo(() => resolveRange(preset, custom), [preset, custom]);
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const phrase = useMemo(() => rangePhrase(preset, start, end), [preset, start, end]);

  // 30-day trend window stays independent of the selected preset so the spark
  // lines and trend chart always have enough daily buckets.
  const trendStart = useMemo(() => startOfDay(subDays(new Date(), DAILY_TREND_DAYS)).toISOString(), []);

  useEffect(() => {
    const ch = supabase
      .channel('agent-ops-overview')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'general_ledger' }, () => qc.invalidateQueries({ queryKey: ['agent-ops-overview'] }))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rent_requests' }, () => qc.invalidateQueries({ queryKey: ['agent-ops-overview'] }))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_collections' }, () => qc.invalidateQueries({ queryKey: ['agent-ops-overview'] }))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'house_listings' }, () => qc.invalidateQueries({ queryKey: ['agent-ops-overview'] }))
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [qc]);

  const { data, isLoading } = useQuery({
    queryKey: ['agent-ops-overview', 'daily', startIso, endIso],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_ops_overview' as any, {
        p_range_start: startIso,
        p_range_end: endIso,
      });
      if (error) throw error;
      return data as unknown as OverviewPayload;
    },
    staleTime: 60_000,
  });

  // Active agents, counted as two disjoint groups: primary agents (who collected
  // themselves OR whose sub-agents collected) and sub-agents who collected. The
  // overview RPC's active_agents_curr counts every collector including
  // sub-agents, so adding it to active_subagents_curr double-counted them and
  // left team-only primary agents out.
  const { data: activeBreakdown } = useQuery({
    queryKey: ['agent-ops-overview', 'active-breakdown', startIso, endIso],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_active_breakdown' as any, {
        p_range_start: startIso,
        p_range_end: endIso,
      });
      if (error) throw error;
      return data as unknown as {
        agents_curr: number; agents_prev: number;
        subagents_curr: number; subagents_prev: number;
        total_curr: number; total_prev: number;
      };
    },
    staleTime: 60_000,
  });

  // Daily series for the charts — same RPC, daily buckets over the last 30 days.
  const { data: trendPayload } = useQuery({
    queryKey: ['agent-ops-overview', 'daily-trend', trendStart, endIso],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_ops_overview' as any, {
        p_range_start: trendStart,
        p_range_end: endIso,
      });
      if (error) throw error;
      return data as unknown as OverviewPayload;
    },
    staleTime: 60_000,
  });

  // Range-scoped expected vs collected (same source as the Collections Command
  // Center) so "Pending Collections" moves with the selected window instead of
  // showing the whole-book outstanding figure.
  const { data: windowTotals, isLoading: windowLoading } = useQuery({
    queryKey: ['agent-ops-overview', 'window-pending', startIso, endIso],
    queryFn: async () => {
      // `get_agent_collections_coverage` rather than the Command Center,
      // because only it splits the cash. The Command Center returns a single
      // `collected`, which is ALL cash in the door including arrears — and a
      // tenant clearing an old debt is not progress against today's bill. That
      // figure routinely exceeds `expected_due` several times over, so
      // `expected - collected` clamped to zero and Pending Collections read
      // 0 on a day with 4.2M genuinely outstanding.
      const { data, error } = await supabase.rpc('get_agent_collections_coverage', {
        p_start: startIso,
        p_end: endIso,
      });
      if (error) throw error;
      const t = ((data as any)?.totals ?? data ?? {}) as Record<string, unknown>;
      // CAPPED, not the uncapped on-schedule figure. Uncapped lets one tenant
      // clearing arrears cover a tenant who paid nothing: on 2026-09-16 it read
      // 18.2M against a 6.08M bill, so `expected - collected` went negative and
      // clamped to zero. Capped answers "did today's tenants meet today's
      // obligation" — 1.8M collected, 4.3M genuinely still outstanding.
      return {
        expected: Number(t.expected_due || 0),
        collected: Number(t.collected_on_schedule_capped ?? t.collected_on_schedule ?? 0),
        pending: Number(t.pending_capped ?? 0),
        arrears: Number(t.collected_arrears || 0),
        totalCash: Number(t.collected_total || 0),
      };
    },
    staleTime: 60_000,
  });

  const k = data?.kpis || ({} as Record<string, number>);
  const trend = trendPayload?.trend || data?.trend || [];

  const trendData = trend.map((t) => ({
    label: format(new Date(t.day), 'd MMM'),
    agents: t.agents,
    requests: t.requests,
    activeAgents: t.active_agents,
    collections: t.collections,
    commission: t.commission,
    collected: t.collections,
    pending: Number(t.pending || 0),
  }));

  const { data: rentRequestCount } = useQuery({
    queryKey: ['agent-ops-rent-request-count'],
    queryFn: async () => {
      const { count, error } = await supabase
        .from('rent_requests')
        .select('*', { count: 'exact', head: true });
      if (error) throw error;
      return count ?? 0;
    },
    staleTime: 60_000,
  });

  return (
    <div className="space-y-4">
      {/* Prominent Rent Requests action — first thing an ops manager sees */}
      <button
        type="button"
        onClick={() => onOpenSection('pipeline')}
        className="group w-full flex items-center gap-3 sm:gap-4 p-3.5 sm:p-5 rounded-2xl border border-primary/40 bg-primary/10 hover:bg-primary/15 active:scale-[0.98] transition-all touch-manipulation text-left relative overflow-hidden min-h-[72px]"
      >
        <div className="p-2 sm:p-3 rounded-xl bg-primary text-primary-foreground shrink-0 shadow-sm">
          <FileText className="h-5 w-5 sm:h-6 sm:w-6" strokeWidth={2.2} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-bold text-sm sm:text-base text-foreground truncate">Rent Requests</p>
            {rentRequestCount === undefined ? (
              <Skeleton className="h-5 w-12 rounded-full" />
            ) : rentRequestCount > 0 ? (
              <Badge className="bg-primary text-primary-foreground text-[10px] px-2 py-0.5 hover:bg-primary">
                {rentRequestCount.toLocaleString()} total
              </Badge>
            ) : (
              <Badge variant="secondary" className="text-[10px] px-2 py-0.5">
                No requests
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 truncate">
            Review and manage all posted rent requests
          </p>
        </div>
        <span className="text-sm font-semibold text-primary shrink-0 flex items-center gap-1">
          Open
          <ArrowRight className="h-4 w-4 group-hover:translate-x-0.5 transition-transform" />
        </span>
      </button>

      {/* Header + date preset filter bar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-foreground">Agent Operations Overview</h2>
          <p className="text-xs text-muted-foreground">
            {format(start, 'dd MMM yyyy')} → {format(end, 'dd MMM yyyy')} · daily aggregates across all agents.
          </p>
        </div>
        <OpsDateRangeFilter
          preset={preset}
          custom={custom}
          onPresetChange={setPreset}
          onCustomChange={setCustom}
        />
      </div>


      {/* Row A — network KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2 sm:gap-3">
        <KpiTile
          title="Total Agents"
          value={fmtNum((k.total_agents || 0) + (k.total_subagents || 0))}
          delta={pctDelta(
            (k.total_agents || 0) + (k.total_subagents || 0),
            (k.total_agents_prev || 0) + (k.total_subagents_prev || 0)
          )}
          subtitle={`+${fmtNum((k.new_agents_curr || 0) + (k.new_subagents_curr || 0))} new ${phrase}`}
          icon={Users}
          accent="bg-primary"
          onClick={() => onOpenSection('directory')}
          loading={isLoading}
        />
        <KpiTile
          title="Active Agents"
          value={fmtNum(activeCurrTotal)}
          delta={pctDelta(activeCurrTotal, activePrevTotal)}
          subtitle={`${fmtNum(activeCurrAgents)} agents · ${fmtNum(activeCurrSubs)} sub-agents active`}
          icon={Activity}
          accent="bg-emerald-600"
          spark={trendData.map((t) => t.activeAgents)}
          onClick={() => setActiveBreakdownOpen(true)}
          loading={isLoading}
        />
        <KpiTile
          title="Inactive Agents"
          value={fmtNum(Math.max(
            ((k.total_agents || 0) + (k.total_subagents || 0)) - activeCurrTotal, 0
          ))}
          delta={pctDelta(
            Math.max(((k.total_agents || 0) + (k.total_subagents || 0)) - activeCurrTotal, 0),
            Math.max(((k.total_agents_prev || 0) + (k.total_subagents_prev || 0)) - activePrevTotal, 0)
          )}
          subtitle={`${fmtNum(Math.max((k.total_subagents || 0) - activeCurrSubs, 0))} sub-agents inactive`}
          icon={UserPlus}
          accent="bg-slate-500"
          onClick={() => onOpenSection('directory')}
          loading={isLoading}
        />
      </div>


      {/* Row A2 — money KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-3">
        <KpiTile
          // Collected means collected against the bill only. Arrears — cash
          // clearing earlier days — are deliberately NOT shown here: mixing them
          // in made this tile irreconcilable with Expected and Pending beside it.
          // collected + pending == expected, always.
          title="Total Collected"
          value={fmtMoney(windowTotals ? (windowTotals.collected || 0) : (k.collections_curr || 0))}
          delta={pctDelta(k.collections_curr || 0, k.collections_prev || 0)}
          subtitle={
            windowTotals
              ? `of ${fmtMoney(windowTotals.expected || 0)} expected ${phrase}`
              : `Collected ${phrase}`
          }
          icon={Wallet}
          accent="bg-emerald-700"
          spark={trendData.map((t) => t.collected)}
          onClick={() => onOpenSection('daily-collections-report')}
          loading={isLoading}
        />
        <KpiTile
          title="Pending Collections"
          value={fmtMoney(
            windowTotals?.pending ??
              Math.max(0, (windowTotals?.expected || 0) - (windowTotals?.collected || 0)),
          )}
          subtitle={
            <>
              Unpaid of{' '}
              <span className="font-semibold text-foreground">
                {fmtMoney(windowTotals?.expected || 0)}
              </span>{' '}
              expected {phrase}
            </>
          }
          icon={Hourglass}
          accent="bg-rose-600"
          spark={trendData.map((t) => t.pending)}
          onClick={() => onOpenSection('allocation-report')}
          loading={isLoading || windowLoading}
        />
        <KpiTile
          title="Total Collections"
          value={fmtNum(k.collections_count_curr || 0)}
          delta={pctDelta(k.collections_count_curr || 0, k.collections_count_prev || 0)}
          subtitle={
            preset === 'today'
              ? `${fmtNum(k.collections_today_count || 0)} today`
              : `${fmtNum(k.collections_count_curr || 0)} ${phrase}`
          }
          icon={Receipt}
          accent="bg-teal-600"
          onClick={() => onOpenSection('daily-collections-report')}
          loading={isLoading}
        />
        <KpiTile
          title="Commissions Paid Out"
          value={fmtMoney(k.commission_curr || 0)}
          delta={pctDelta(k.commission_curr || 0, k.commission_prev || 0)}
          icon={Coins}
          accent="bg-fuchsia-600"
          spark={trendData.map((t) => t.commission)}
          subtitle={`Paid out ${phrase}`}
          onClick={() => onOpenSection('earnings')}
          loading={isLoading}
        />
      </div>

      {/* Rent collections — pending vs collected */}
      <Card className="rounded-2xl border-border/50 p-3 sm:p-4 w-full">
        <div className="flex items-start justify-between mb-2">
          <div>
            <h3 className="text-sm font-semibold">Rent Collections</h3>
            <p className="text-[11px] text-muted-foreground">Daily collected (green) vs still pending (red), UGX — last 30 days</p>
          </div>
        </div>
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={trendData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="collectedFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(160 84% 39%)" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="hsl(160 84% 39%)" stopOpacity={0.02} />
                </linearGradient>
                <linearGradient id="pendingFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(0 84% 60%)" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="hsl(0 84% 60%)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => v >= 1e6 ? `${(v/1e6).toFixed(1)}M` : v >= 1e3 ? `${(v/1e3).toFixed(0)}K` : v} />
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} formatter={(v: number) => fmtMoney(v)} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Area type="monotone" dataKey="pending" name="Pending" stroke="hsl(0 84% 60%)" strokeWidth={2} fill="url(#pendingFill)" dot={false} />
              <Area type="monotone" dataKey="collected" name="Collected" stroke="hsl(160 84% 39%)" strokeWidth={2} fill="url(#collectedFill)" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Card>

      {/* Latest rent requests */}
      <LatestRentRequests onViewAll={() => onOpenSection('pipeline')} />

      {/* Partial vs full collections */}
      <PartialCollectionsOverview />

      {/* Top performers */}
      <TopPerformers rows={data?.top_performers || []} loading={isLoading} phrase={phrase} />

      {/* Row B — trend charts */}
      <div className="grid grid-cols-1 gap-3">
        <Card className="rounded-2xl border-border/50 p-3 sm:p-4">
          <div className="flex items-start justify-between mb-2">
            <div>
              <h3 className="text-sm font-semibold">Agent Activity</h3>
              <p className="text-[11px] text-muted-foreground">Daily new / active agents & rent requests — last 30 days</p>
            </div>
          </div>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trendData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Area type="monotone" dataKey="activeAgents" name="Active" stroke="hsl(160 84% 39%)" fill="hsl(160 84% 39%)" fillOpacity={0.2} />
                <Area type="monotone" dataKey="agents" name="New" stroke="hsl(199 89% 48%)" fill="hsl(199 89% 48%)" fillOpacity={0.2} />
                <Area type="monotone" dataKey="requests" name="Requests" stroke="hsl(var(--primary))" fill="hsl(var(--primary))" fillOpacity={0.2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      {/* Agent performance for rent collection */}
      <AgentRentCapacityPanel defaultLimit={25} />

      <ActiveAgentsBreakdownDialog open={activeBreakdownOpen} onOpenChange={setActiveBreakdownOpen} />

    </div>
  );
}

// ---------- Latest rent requests ----------

type SortOption = 'newest' | 'oldest' | 'amount-high' | 'amount-low' | 'tenant-az' | 'agent-az';

const DEFAULT_STATUS = 'pending';
const DEFAULT_DATE = '30';
const DEFAULT_SORT: SortOption = 'newest';

function LatestRentRequests({ onViewAll }: { onViewAll: () => void }) {
  // Draft = what's on the controls; applied = what's currently driving the list.
  const [draftStatus, setDraftStatus] = useState(DEFAULT_STATUS);
  const [draftDate, setDraftDate] = useState(DEFAULT_DATE);
  const [draftSearch, setDraftSearch] = useState('');
  const [draftSort, setDraftSort] = useState<SortOption>(DEFAULT_SORT);

  const [appliedStatus, setAppliedStatus] = useState(DEFAULT_STATUS);
  const [appliedDate, setAppliedDate] = useState(DEFAULT_DATE);
  const [appliedSearch, setAppliedSearch] = useState('');
  const [appliedSort, setAppliedSort] = useState<SortOption>(DEFAULT_SORT);

  const hasDraftChanges =
    draftStatus !== appliedStatus ||
    draftDate !== appliedDate ||
    draftSearch !== appliedSearch ||
    draftSort !== appliedSort;

  const { data: rawRows, isLoading } = useQuery({
    queryKey: ['agent-ops-latest-rent-requests', appliedStatus, appliedDate],
    queryFn: async () => {
      let query = supabase
        .from('rent_requests')
        .select('id, agent_id, tenant_id, rent_amount, status, created_at')
        .order('created_at', { ascending: false });
      if (appliedStatus !== 'all') query = query.eq('status', appliedStatus);
      if (appliedDate !== 'all') {
        query = query.gte('created_at', subDays(new Date(), Number(appliedDate)).toISOString());
      }
      const { data } = await query.limit(50);
      if (!data || data.length === 0) return [];
      const agentIds = Array.from(new Set(data.map((r: any) => r.agent_id).filter(Boolean)));
      const { data: links } = agentIds.length
        ? await supabase
            .from('agent_subagents')
            .select('sub_agent_id, parent_agent_id, status')
            .in('sub_agent_id', agentIds)
            .in('status', ['verified', 'accepted', 'active'])
        : { data: [] as any[] };
      const parentMap = new Map((links || []).map((l: any) => [l.sub_agent_id, l.parent_agent_id]));
      const ids = Array.from(new Set([
        ...data.flatMap((r: any) => [r.agent_id, r.tenant_id]),
        ...parentMap.values(),
      ].filter(Boolean)));
      const { data: profs } = await supabase.from('profiles').select('id, full_name').in('id', ids);
      const pm = new Map((profs || []).map((p: any) => [p.id, p.full_name]));
      return data.map((r: any) => ({
        ...r,
        agent_name: pm.get(r.agent_id) || '—',
        parent_agent_name: parentMap.has(r.agent_id)
          ? (pm.get(parentMap.get(r.agent_id)) || '—')
          : null,
        tenant_name: pm.get(r.tenant_id) || '—',
      }));

    },
    staleTime: 60_000,
  });

  const normalizedSearch = appliedSearch.trim().toLowerCase();

  const data = useMemo(() => {
    let rows = (rawRows || []).slice();
    if (normalizedSearch) {
      rows = rows.filter((r: any) =>
        (r.tenant_name || '').toLowerCase().includes(normalizedSearch) ||
        (r.agent_name || '').toLowerCase().includes(normalizedSearch) ||
        (r.parent_agent_name || '').toLowerCase().includes(normalizedSearch) ||
        String(r.rent_amount || '').includes(normalizedSearch)
      );
    }
    rows.sort((a: any, b: any) => {
      switch (appliedSort) {
        case 'oldest':
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        case 'amount-high':
          return Number(b.rent_amount || 0) - Number(a.rent_amount || 0);
        case 'amount-low':
          return Number(a.rent_amount || 0) - Number(b.rent_amount || 0);
        case 'tenant-az':
          return (a.tenant_name || '').localeCompare(b.tenant_name || '');
        case 'agent-az':
          return (a.agent_name || '').localeCompare(b.agent_name || '');
        case 'newest':
        default:
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }
    });
    return rows.slice(0, 10);
  }, [rawRows, normalizedSearch, appliedSort]);

  const handleApply = () => {
    setAppliedStatus(draftStatus);
    setAppliedDate(draftDate);
    setAppliedSearch(draftSearch);
    setAppliedSort(draftSort);
  };

  const handleReset = () => {
    setDraftStatus(DEFAULT_STATUS);
    setDraftDate(DEFAULT_DATE);
    setDraftSearch('');
    setDraftSort(DEFAULT_SORT);
    setAppliedStatus(DEFAULT_STATUS);
    setAppliedDate(DEFAULT_DATE);
    setAppliedSearch('');
    setAppliedSort(DEFAULT_SORT);
  };

  const statusTone = (s: string) =>
    ['rejected', 'deleted_by_agent'].includes(s) ? 'destructive'
      : ['repaying', 'funded', 'disbursed', 'approved'].includes(s) ? 'default'
      : 'outline';

  const formatStatus = (s: string) =>
    s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  const formatFullUGX = (n: number) => `UGX ${Math.round(n || 0).toLocaleString('en-UG')}`;

  return (
    <Card className="rounded-2xl border-border/50 w-full overflow-hidden">
      <div className="sticky top-0 z-10 bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80 border-b border-border/40 p-3 sm:p-4 pb-2.5 sm:pb-3">
        <div className="flex items-center justify-between gap-2 mb-3">
          <div>
            <h3 className="text-sm font-semibold">Latest Rent Requests</h3>
            <p className="text-[11px] text-muted-foreground">Quickly narrow the requests needing attention</p>
          </div>
          <Button size="sm" variant="outline" onClick={onViewAll} className="gap-1">
            View all <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="mb-2 grid grid-cols-2 gap-2">
          <Select value={draftStatus} onValueChange={setDraftStatus}>
            <SelectTrigger className="h-11 text-sm" aria-label="Filter rent requests by status">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="agent_ops_approved">Agent Ops approved</SelectItem>
              <SelectItem value="tenant_ops_approved">Tenant Ops approved</SelectItem>
              <SelectItem value="landlord_ops_approved">Landlord Ops approved</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
              <SelectItem value="all">All statuses</SelectItem>
            </SelectContent>
          </Select>
          <Select value={draftDate} onValueChange={setDraftDate}>
            <SelectTrigger className="h-11 text-sm" aria-label="Filter rent requests by date">
              <SelectValue placeholder="Date" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">Today</SelectItem>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="all">Any date</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="mb-2 grid grid-cols-[1fr_auto] gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              value={draftSearch}
              onChange={(e) => setDraftSearch(e.target.value)}
              placeholder="Search tenant or agent..."
              className="h-11 w-full rounded-md border border-input bg-background px-3 pl-9 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-label="Search rent requests by tenant or agent"
            />
          </div>
          <Select value={draftSort} onValueChange={(v) => setDraftSort(v as SortOption)}>
            <SelectTrigger className="h-11 text-sm min-w-[7.5rem]" aria-label="Sort rent requests">
              <SelectValue placeholder="Sort" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest first</SelectItem>
              <SelectItem value="oldest">Oldest first</SelectItem>
              <SelectItem value="amount-high">Amount: high</SelectItem>
              <SelectItem value="amount-low">Amount: low</SelectItem>
              <SelectItem value="tenant-az">Tenant A–Z</SelectItem>
              <SelectItem value="agent-az">Agent A–Z</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-10 text-xs"
            onClick={handleReset}
          >
            Reset
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-10 text-xs"
            onClick={handleApply}
            disabled={!hasDraftChanges}
          >
            Apply
          </Button>
        </div>
      </div>
      <div className="p-3 sm:p-4 pt-2.5 sm:pt-3">
      {isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : !data || data.length === 0 ? (
        <p className="text-xs text-muted-foreground p-4 text-center">No rent requests yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-[11px]">Date</TableHead>
                <TableHead className="text-[11px]">Tenant</TableHead>
                <TableHead className="hidden sm:table-cell text-[11px]">Agent</TableHead>
                <TableHead className="text-[11px]">Status</TableHead>
                <TableHead className="text-right text-[11px]">Rent</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((r: any) => (
                <TableRow key={r.id}>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                    {format(new Date(r.created_at), 'd MMM HH:mm')}
                  </TableCell>
                  <TableCell className="font-medium max-w-[140px] truncate">{r.tenant_name}</TableCell>
                  <TableCell className="hidden sm:table-cell max-w-[180px] text-muted-foreground">
                    <span className="block truncate font-semibold text-foreground">{r.agent_name}</span>
                    {r.parent_agent_name && (
                      <span className="block truncate text-[10px] text-muted-foreground/80">
                        Parent: {r.parent_agent_name}
                      </span>
                    )}
                  </TableCell>

                  <TableCell>
                    <Badge variant={statusTone(r.status) as any} className="text-[10px] whitespace-nowrap capitalize">
                      {formatStatus(r.status)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-bold tabular-nums text-sm text-emerald-600">
                    {formatFullUGX(Number(r.rent_amount || 0))}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
    </Card>
  );
}

// ---------- Top performers (agents + sub-agents) ----------

function PartialCollectionsOverview() {
  const DAYS = 14;
  const { data, isLoading } = useQuery({
    queryKey: ['agent-ops-partial-vs-full', DAYS],
    staleTime: 60_000,
    queryFn: async () => {
      const { data: result, error } = await supabase.rpc('get_agent_collection_quality', {
        p_days: DAYS,
      });
      if (error) throw error;

      const payload = (result ?? {}) as {
        series?: Array<{ label: string; full: number; partial: number; missed: number; shortfall: number }>;
        full?: number;
        partial?: number;
        missed?: number;
        shortfall?: number;
      };

      return {
        series: payload.series ?? [],
        full: Number(payload.full || 0),
        partial: Number(payload.partial || 0),
        missed: Number(payload.missed || 0),
        shortfall: Number(payload.shortfall || 0),
      };
    },
  });

  const total = (data?.full || 0) + (data?.partial || 0) + (data?.missed || 0);
  const partialPct = total ? Math.round(((data?.partial || 0) / total) * 100) : 0;
  const missedPct = total ? Math.round(((data?.missed || 0) / total) * 100) : 0;

  return (
    <Card className="rounded-2xl border-border/50 p-3 sm:p-4 w-full">
      <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
        <div>
          <h3 className="text-sm font-semibold">Collection Quality Overview</h3>
          <p className="text-[11px] text-muted-foreground">
            Full, partial and missed expected payments · last {DAYS} days
          </p>
        </div>
        {!isLoading && total > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
            <span className="text-emerald-600 dark:text-emerald-400 font-semibold">{fmtNum(data?.full || 0)} full</span>
            <span className="text-amber-500 dark:text-amber-400 font-semibold">{fmtNum(data?.partial || 0)} partial ({partialPct}%)</span>
            <span className="text-red-500 dark:text-red-400 font-semibold">{fmtNum(data?.missed || 0)} missed ({missedPct}%)</span>
            <span className="text-rose-600 dark:text-rose-400 font-semibold">Short {fmtMoney(data?.shortfall || 0)}</span>
          </div>
        )}
      </div>
      {isLoading ? (
        <Skeleton className="h-56 w-full" />
      ) : !data || total === 0 ? (
        <p className="text-xs text-muted-foreground p-4 text-center">No collections or expected payments recorded in the last {DAYS} days.</p>
      ) : (
        <div className="h-56 sm:h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.series} barCategoryGap="20%">
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
              <Tooltip
                contentStyle={{ fontSize: 12, borderRadius: 8 }}
                formatter={(v: number, name: string) => [fmtNum(v), name]}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="full" stackId="c" name="Full payment" fill="#22c55e" radius={[0, 0, 0, 0]} />
              <Bar dataKey="partial" stackId="c" name="Partial payment" fill="#f59e0b" radius={[0, 0, 0, 0]} />
              <Bar dataKey="missed" stackId="c" name="Missed payment" fill="#ef4444" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

function TopPerformers({
  rows,
  loading,
  phrase,
}: {
  rows: NonNullable<OverviewPayload['top_performers']>;
  loading?: boolean;
  phrase: string;
}) {
  return (
    <Card className="rounded-2xl border-border/50 p-3 sm:p-4 w-full">
      <div className="flex items-center gap-2 mb-2">
        <Trophy className="h-4 w-4 text-amber-500" />
        <div>
          <h3 className="text-sm font-semibold">Top Performers</h3>
          <p className="text-[11px] text-muted-foreground">Agents and sub-agents by rent collected {phrase}</p>
        </div>
      </div>
      {loading ? (
        <Skeleton className="h-32 w-full" />
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground p-4 text-center">No collections recorded {phrase}.</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">#</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="hidden sm:table-cell text-right">Collections</TableHead>
                <TableHead className="text-right">Collected</TableHead>
                <TableHead className="hidden md:table-cell text-right">Commission</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={r.user_id}>
                  <TableCell className="text-xs font-bold text-muted-foreground tabular-nums">{i + 1}</TableCell>
                  <TableCell className="font-medium max-w-[160px] truncate">{r.name}</TableCell>
                  <TableCell>
                    <Badge
                      variant="secondary"
                      className={cn(
                        'text-[10px]',
                        r.category === 'Sub-Agent'
                          ? 'bg-sky-500/15 text-sky-700 dark:text-sky-400 border-sky-500/30'
                          : 'bg-primary/10 text-primary border-primary/30',
                      )}
                    >
                      {r.category}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell text-right tabular-nums text-xs">
                    {fmtNum(Number(r.collections || 0))}
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums text-xs">
                    {fmtMoney(Number(r.collected || 0))}
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-right tabular-nums text-xs text-muted-foreground">
                    {fmtMoney(Number(r.commission || 0))}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Card>
  );
}

// ---------- Sub-preview tables ----------

function TopAgentsPreview({ onOpen }: { onOpen: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['agent-ops-top-agents-strict'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_ops_top_agents' as any, { p_days: 30, p_limit: 10 });
      if (error) throw error;
      return (data as any[]) || [];
    },
    staleTime: 300_000,
  });
  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (!data || data.length === 0) return <p className="text-xs text-muted-foreground p-4 text-center">No commission data in the last 30 days.</p>;
  return (
    <div className="space-y-1">
      {data.map((row: any, i: number) => (
        <div key={row.user_id} className="flex items-center gap-2 py-1.5 border-b border-border/40 last:border-0">
          <span className="w-5 text-xs font-bold text-muted-foreground tabular-nums">{i + 1}</span>
          <span className="flex-1 text-sm truncate">
            {row.name || String(row.user_id).slice(0, 8)}
            <span className="ml-1.5 text-[10px] text-muted-foreground">{row.category}</span>
          </span>
          <span className="text-xs text-muted-foreground truncate hidden sm:inline">{row.phone || ''}</span>
          <span className="text-sm font-semibold tabular-nums">{fmtMoney(Number(row.total || 0))}</span>
        </div>
      ))}
      <button onClick={onOpen} className="w-full text-xs text-primary hover:underline flex items-center justify-center gap-1 pt-2">
        Open leaderboard <ArrowRight className="h-3 w-3" />
      </button>
    </div>
  );
}

function RecentRequestsPreview({ onOpen }: { onOpen: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['agent-ops-recent-requests'],
    queryFn: async () => {
      const { data } = await supabase
        .from('rent_requests')
        .select('id, agent_id, amount_requested, status, created_at, tenant_id')
        .order('created_at', { ascending: false })
        .limit(10);
      if (!data || data.length === 0) return [];
      const ids = Array.from(new Set(data.flatMap((r: any) => [r.agent_id, r.tenant_id]).filter(Boolean)));
      const { data: profs } = await supabase.from('profiles').select('id, full_name').in('id', ids);
      const pm = new Map((profs || []).map((p: any) => [p.id, p.full_name]));
      return data.map((r: any) => ({ ...r, agent_name: pm.get(r.agent_id) || '—', tenant_name: pm.get(r.tenant_id) || '—' }));
    },
    staleTime: 60_000,
  });
  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (!data || data.length === 0) return <p className="text-xs text-muted-foreground p-4 text-center">No recent rent requests.</p>;
  return (
    <div className="space-y-1">
      {data.map((r: any) => (
        <div key={r.id} className="flex items-center gap-2 py-1.5 border-b border-border/40 last:border-0 text-sm">
          <span className="text-xs text-muted-foreground w-16">{format(new Date(r.created_at), 'd MMM HH:mm')}</span>
          <span className="flex-1 truncate">{r.tenant_name} <span className="text-muted-foreground">← {r.agent_name}</span></span>
          <Badge variant="outline" className="text-[10px]">{r.status}</Badge>
          <span className="font-semibold tabular-nums text-xs">{fmtMoney(r.amount_requested || 0)}</span>
        </div>
      ))}
      <button onClick={onOpen} className="w-full text-xs text-primary hover:underline flex items-center justify-center gap-1 pt-2">
        Open pipeline <ArrowRight className="h-3 w-3" />
      </button>
    </div>
  );
}

function RecentVerificationsPreview() {
  const { data, isLoading } = useQuery({
    queryKey: ['agent-ops-recent-verifs'],
    queryFn: async () => {
      const { data } = await supabase
        .from('house_listings')
        .select('id, agent_id, verified_at, region, monthly_rent')
        .eq('verified', true)
        .not('verified_at', 'is', null)
        .order('verified_at', { ascending: false })
        .limit(10);
      if (!data || data.length === 0) return [];
      const ids = Array.from(new Set(data.map((r: any) => r.agent_id).filter(Boolean)));
      const { data: profs } = await supabase.from('profiles').select('id, full_name').in('id', ids);
      const pm = new Map((profs || []).map((p: any) => [p.id, p.full_name]));
      return data.map((r: any) => ({ ...r, agent_name: pm.get(r.agent_id) || '—' }));
    },
    staleTime: 60_000,
  });
  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (!data || data.length === 0) return <p className="text-xs text-muted-foreground p-4 text-center">No recent verifications.</p>;
  return (
    <div className="space-y-1">
      {data.map((r: any) => (
        <div key={r.id} className="flex items-center gap-2 py-1.5 border-b border-border/40 last:border-0 text-sm">
          <span className="text-xs text-muted-foreground w-16">{format(new Date(r.verified_at), 'd MMM HH:mm')}</span>
          <span className="flex-1 truncate">{r.region || '—'} <span className="text-muted-foreground">by {r.agent_name}</span></span>
          <span className="font-semibold tabular-nums text-xs">{fmtMoney(r.monthly_rent || 0)}</span>
        </div>
      ))}
    </div>
  );
}

export function AtRiskAgentsPreview({ onOpen }: { onOpen?: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['agent-ops-at-risk'],
    queryFn: async () => {
      const { data } = await supabase
        .from('agent_advances')
        .select('agent_id, outstanding_balance, arrears_balance, status')
        .in('status', ['active', 'overdue'])
        .or('status.eq.overdue,arrears_balance.gt.0')
        .order('arrears_balance', { ascending: false })
        .limit(10);
      if (!data || data.length === 0) return [];
      const ids = Array.from(new Set(data.map((r: any) => r.agent_id).filter(Boolean)));
      const { data: profs } = await supabase.from('profiles').select('id, full_name, phone').in('id', ids);
      const pm = new Map((profs || []).map((p: any) => [p.id, p]));
      return data.map((r: any) => ({ ...r, profile: pm.get(r.agent_id) }));
    },
    staleTime: 60_000,
  });
  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (!data || data.length === 0) return <p className="text-xs text-muted-foreground p-4 text-center">No agents at risk. 🎉</p>;
  return (
    <div className="space-y-1">
      {data.map((r: any) => (
        <div key={r.agent_id} className="flex items-center gap-2 py-1.5 border-b border-border/40 last:border-0 text-sm">
          <span className="flex-1 truncate">{r.profile?.full_name || r.agent_id.slice(0, 8)}</span>
          <Badge variant={r.status === 'overdue' ? 'destructive' : 'outline'} className="text-[10px]">{r.status}</Badge>
          <span className="text-xs text-muted-foreground tabular-nums">Arrears: {fmtMoney(r.arrears_balance || 0)}</span>
          <span className="font-semibold tabular-nums text-xs">{fmtMoney(r.outstanding_balance || 0)}</span>
        </div>
      ))}
      {onOpen && (
        <button onClick={onOpen} className="w-full text-xs text-primary hover:underline flex items-center justify-center gap-1 pt-2">
          Open repayments monitor <ArrowRight className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}