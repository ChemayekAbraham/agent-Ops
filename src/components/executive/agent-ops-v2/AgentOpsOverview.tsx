import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { format, subDays, startOfDay, endOfDay, startOfMonth, startOfYear, addDays } from 'date-fns';
import {
  ResponsiveContainer, AreaChart, Area,
  XAxis, YAxis,
  CartesianGrid, Tooltip, Legend,
} from 'recharts';
import {
  Users, UserPlus, Activity, FileText, Home, Wallet, Banknote, TrendingDown,
  TrendingUp, ArrowRight, Coins, Hourglass, Receipt, Trophy,
  RefreshCw,
} from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';


import { AgentRentCapacityPanel } from '../AgentRentCapacityPanel';
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
  subtitle?: string;
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

  return (
    <div className="space-y-4">
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
          value={fmtNum((k.active_agents_curr || 0) + (k.active_subagents_curr || 0))}
          delta={pctDelta(
            (k.active_agents_curr || 0) + (k.active_subagents_curr || 0),
            (k.active_agents_prev || 0) + (k.active_subagents_prev || 0)
          )}
          subtitle={`${fmtNum(k.active_agents_curr || 0)} agents · ${fmtNum(k.active_subagents_curr || 0)} sub-agents active`}
          icon={Activity}
          accent="bg-emerald-600"
          spark={trendData.map((t) => t.activeAgents)}
          onClick={() => onOpenSection('directory')}
          loading={isLoading}
        />
        <KpiTile
          title="Inactive Agents"
          value={fmtNum(
            ((k.total_agents || 0) + (k.total_subagents || 0)) -
            ((k.active_agents_curr || 0) + (k.active_subagents_curr || 0))
          )}
          delta={pctDelta(
            ((k.total_agents || 0) + (k.total_subagents || 0)) -
            ((k.active_agents_curr || 0) + (k.active_subagents_curr || 0)),
            ((k.total_agents_prev || 0) + (k.total_subagents_prev || 0)) -
            ((k.active_agents_prev || 0) + (k.active_subagents_prev || 0))
          )}
          subtitle={`${fmtNum((k.total_agents || 0) - (k.active_agents_curr || 0))} agents · ${fmtNum((k.total_subagents || 0) - (k.active_subagents_curr || 0))} sub-agents inactive`}
          icon={UserPlus}
          accent="bg-slate-500"
          onClick={() => onOpenSection('directory')}
          loading={isLoading}
        />
      </div>


      {/* Row A2 — money KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-3">
        <KpiTile
          title="Total Collected"
          value={fmtMoney(k.collections_curr || 0)}
          delta={pctDelta(k.collections_curr || 0, k.collections_prev || 0)}
          subtitle={
            preset === 'today'
              ? `${fmtMoney(k.collections_today || 0)} today`
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
          value={fmtMoney(k.pending_collections || 0)}
          subtitle="Outstanding on live rent plans"
          icon={Hourglass}
          accent="bg-rose-600"
          spark={trendData.map((t) => t.pending)}
          onClick={() => onOpenSection('allocation-report')}
          loading={isLoading}
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

      {/* Highest pending collections */}
      <TopPendingAgents onViewAll={() => onOpenSection('pipeline')} />

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

    </div>
  );
}

// ---------- Latest rent requests ----------

function LatestRentRequests({ onViewAll }: { onViewAll: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['agent-ops-latest-rent-requests'],
    queryFn: async () => {
      const { data } = await supabase
        .from('rent_requests')
        .select('id, agent_id, tenant_id, rent_amount, status, created_at')
        .order('created_at', { ascending: false })
        .limit(5);
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

  const statusTone = (s: string) =>
    ['rejected', 'deleted_by_agent'].includes(s) ? 'destructive'
      : ['repaying', 'funded', 'disbursed', 'approved'].includes(s) ? 'default'
      : 'outline';

  const formatStatus = (s: string) =>
    s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  const formatFullUGX = (n: number) => `UGX ${Math.round(n || 0).toLocaleString('en-UG')}`;

  return (
    <Card className="rounded-2xl border-border/50 p-3 sm:p-4 w-full">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold">Latest Rent Requests</h3>
          <p className="text-[11px] text-muted-foreground">The five most recent submissions</p>
        </div>
        <Button size="sm" variant="outline" onClick={onViewAll} className="gap-1">
          View all <ArrowRight className="h-3.5 w-3.5" />
        </Button>
      </div>
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
    </Card>
  );
}

// ---------- Top performers (agents + sub-agents) ----------

function TopPendingAgents({ onViewAll }: { onViewAll: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['agent-ops-top-pending-agents'],
    queryFn: async () => {
      const { data: rents } = await supabase
        .from('rent_requests')
        .select('agent_id, total_repayment, amount_repaid, daily_repayment, status, agent_payment_status')
        .in('status', ['funded', 'repaying'])
        .limit(5000);
      if (!rents || rents.length === 0) return [];
      const agg = new Map<string, { pending: number; tenants: number; daily: number }>();
      for (const r of rents as any[]) {
        if (!r.agent_id) continue;
        if ((r.agent_payment_status || 'paying') === 'not_paying') continue;
        const pending = Math.max(0, Number(r.total_repayment || 0) - Number(r.amount_repaid || 0));
        if (pending <= 0) continue;
        const cur = agg.get(r.agent_id) || { pending: 0, tenants: 0, daily: 0 };
        cur.pending += pending;
        cur.tenants += 1;
        cur.daily += Number(r.daily_repayment || 0);
        agg.set(r.agent_id, cur);
      }
      const top = Array.from(agg.entries())
        .sort((a, b) => b[1].pending - a[1].pending)
        .slice(0, 5);
      if (top.length === 0) return [];
      const { data: profs } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', top.map(([id]) => id));
      const pm = new Map((profs || []).map((p: any) => [p.id, p.full_name]));
      return top.map(([id, v]) => ({ agent_id: id, name: pm.get(id) || '—', ...v }));
    },
    staleTime: 60_000,
  });

  return (
    <Card className="rounded-2xl border-border/50 p-3 sm:p-4 w-full">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h3 className="text-sm font-semibold">Highest Pending Collections</h3>
          <p className="text-[11px] text-muted-foreground">Top 5 agents by outstanding tenant repayments</p>
        </div>
        <Button size="sm" variant="outline" onClick={onViewAll} className="gap-1">
          View all <ArrowRight className="h-3.5 w-3.5" />
        </Button>
      </div>
      {isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : !data || data.length === 0 ? (
        <p className="text-xs text-muted-foreground p-4 text-center">No pending repayments.</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">#</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead className="hidden sm:table-cell text-right">Tenants</TableHead>
                <TableHead className="hidden md:table-cell text-right">Daily due</TableHead>
                <TableHead className="text-right">Pending</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((r: any, i: number) => (
                <TableRow key={r.agent_id}>
                  <TableCell className="text-xs font-bold text-muted-foreground tabular-nums">{i + 1}</TableCell>
                  <TableCell className="font-medium max-w-[160px] truncate">{r.name}</TableCell>
                  <TableCell className="hidden sm:table-cell text-right tabular-nums text-xs">{fmtNum(r.tenants)}</TableCell>
                  <TableCell className="hidden md:table-cell text-right tabular-nums text-xs text-muted-foreground">{fmtMoney(r.daily)}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums text-xs text-red-600 dark:text-red-400">
                    {fmtMoney(r.pending)}
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