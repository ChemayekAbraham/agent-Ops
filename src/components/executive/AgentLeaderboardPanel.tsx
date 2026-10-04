import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { KPICard } from './KPICard';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import {
  Users, UsersRound, TrendingUp, UserPlus, Trophy, Search, Crown, Medal, ShieldCheck, Clock,
  ChevronLeft, ChevronRight, FileDown, Loader2,
} from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { generateAgentGrowthReportPdf } from '@/lib/agentGrowthReportPdf';

type Period = 'daily' | 'weekly' | 'monthly' | 'yearly';

interface LeaderboardStats {
  period: Period;
  window_start: string;
  totals: {
    total_agents: number;
    total_subagents: number;
    verified_subagents: number;
    pending_subagents: number;
    new_agents: number;
    new_subagents: number;
    prev_agents: number;
    prev_subagents: number;
  };
  series: { bucket: string; agents: number; subagents: number }[];
  top_recruiters: { agent_id: string; name: string; avatar_url: string | null; phone: string | null; invited: number; verified: number }[];
  invitees: {
    id: string; sub_agent_id: string; parent_agent_id: string;
    sub_agent_name: string; sub_agent_phone: string | null; parent_name: string;
    status: string; created_at: string; verified_at: string | null;
  }[];
}

const PERIODS: { value: Period; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
];

const bucketLabel = (iso: string, period: Period) => {
  const d = new Date(iso);
  switch (period) {
    case 'daily': return format(d, 'd MMM');
    case 'weekly': return format(d, "'W'w");
    case 'monthly': return format(d, 'MMM yy');
    case 'yearly': return format(d, 'yyyy');
  }
};

const trendPct = (curr: number, prev: number) => {
  if (!prev) return curr > 0 ? 100 : 0;
  return Math.round(((curr - prev) / prev) * 100);
};

const statusStyles: Record<string, string> = {
  verified: 'bg-green-500/10 text-green-600 border-green-500/20',
  pending_acceptance: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
  expired: 'bg-muted text-muted-foreground border-border',
  rejected: 'bg-red-500/10 text-red-600 border-red-500/20',
};

const rankAccent = ['text-amber-500', 'text-muted-foreground', 'text-orange-600'];

export function AgentLeaderboardPanel() {
  const [period, setPeriod] = useState<Period>('monthly');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 15;
  const [exporting, setExporting] = useState(false);
  const { toast } = useToast();

  const { data, isLoading } = useQuery({
    queryKey: ['agent-leaderboard-stats', period],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_leaderboard_stats', { p_period: period });
      if (error) throw error;
      return data as unknown as LeaderboardStats;
    },
    staleTime: 60_000,
  });

  const t = data?.totals;
  const chartData = useMemo(
    () => (data?.series || []).map((s) => ({ ...s, label: bucketLabel(s.bucket, period) })),
    [data?.series, period],
  );

  const invitees = useMemo(() => {
    const list = data?.invitees || [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((i) =>
      i.sub_agent_name?.toLowerCase().includes(q) ||
      i.parent_name?.toLowerCase().includes(q) ||
      i.sub_agent_phone?.toLowerCase().includes(q),
    );
  }, [data?.invitees, search]);

  // Reset to first page whenever the filter or period changes.
  useEffect(() => { setPage(1); }, [search, period]);

  const totalPages = Math.max(1, Math.ceil(invitees.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pagedInvitees = useMemo(
    () => invitees.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [invitees, currentPage],
  );
  const rangeStart = invitees.length === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(currentPage * PAGE_SIZE, invitees.length);

  // Label for the current selected period (Daily = today, etc.)
  const periodNoun =
    period === 'daily' ? 'today' :
    period === 'weekly' ? 'this week' :
    period === 'yearly' ? 'this year' : 'this month';
  // Trailing window shown by the growth chart
  const trendNoun =
    period === 'daily' ? '30d' :
    period === 'weekly' ? '12w' :
    period === 'yearly' ? '5y' : '12mo';

  const handleExportPdf = async () => {
    if (!data?.totals) return;
    setExporting(true);
    try {
      const periodLabel = PERIODS.find((p) => p.value === period)?.label ?? 'Monthly';
      const allInvitees = data.invitees || [];
      const inviteeStatus = {
        verified: allInvitees.filter((i) => i.status === 'verified').length,
        pending: allInvitees.filter((i) => i.status === 'pending_acceptance').length,
        expired: allInvitees.filter((i) => i.status === 'expired').length,
        rejected: allInvitees.filter((i) => i.status === 'rejected').length,
        total: allInvitees.length,
      };
      const blob = await generateAgentGrowthReportPdf({
        scopeLabel: `${periodLabel} · trailing ${trendNoun}`,
        periodNoun,
        totals: data.totals,
        series: chartData.map((s) => ({ label: s.label, agents: s.agents, subagents: s.subagents })),
        recruiters: (data.top_recruiters || []).map((r) => ({
          name: r.name, phone: r.phone, invited: r.invited, verified: r.verified,
        })),
        inviteeStatus,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const filename = `Welile_Agent_Growth_${periodLabel}_${format(new Date(), 'yyyy-MM-dd')}.pdf`;
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      // Bulk export of many recruiters' names/phones and agent-growth data
      // at once, not logged before this. Plain client-side insert so the
      // audit_logs IP-capture trigger sees the real browser IP directly.
      // Never blocks the actual download.
      (async () => {
        try {
          const { data: { user: actor } } = await supabase.auth.getUser();
          await supabase.from('audit_logs').insert({
            user_id: actor?.id ?? null,
            action_type: 'pdf_report_exported',
            table_name: 'export',
            record_id: null,
            metadata: { filename, recruiter_count: (data.top_recruiters || []).length },
          });
        } catch (e) {
          console.warn('[AgentLeaderboardPanel] audit log insert failed:', e);
        }
      })();
    } catch (err) {
      console.error('[AgentLeaderboardPanel] PDF export failed:', err);
      toast({ title: 'Export failed', description: 'Could not generate the growth report.', variant: 'destructive' });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Header + period filter */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="p-2 rounded-xl bg-amber-500/15 text-amber-500"><Trophy className="h-5 w-5" /></div>
          <div>
            <h3 className="text-base font-bold leading-tight">Agent Growth Leaderboard</h3>
            <p className="text-xs text-muted-foreground">Agents vs sub-agents recruitment & invitees</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ToggleGroup
            type="single"
            value={period}
            onValueChange={(v) => v && setPeriod(v as Period)}
            className="rounded-xl border border-border bg-card p-1"
          >
            {PERIODS.map((p) => (
              <ToggleGroupItem
                key={p.value}
                value={p.value}
                className="h-8 px-3 text-xs data-[state=on]:bg-primary data-[state=on]:text-primary-foreground rounded-lg"
              >
                {p.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Button
            onClick={handleExportPdf}
            disabled={exporting || isLoading || !data?.totals}
            size="sm"
            className="h-9 gap-1.5"
          >
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
            <span className="hidden sm:inline">Export PDF</span>
          </Button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPICard
          title="Total Agents" icon={Users} loading={isLoading}
          value={(t?.total_agents ?? 0).toLocaleString()}
          color="bg-primary/10 text-primary"
          subtitle={`${(t?.new_agents ?? 0).toLocaleString()} new ${periodNoun}`}
        />
        <KPICard
          title="Total Sub-Agents" icon={UsersRound} loading={isLoading}
          value={(t?.total_subagents ?? 0).toLocaleString()}
          color="bg-violet-500/10 text-violet-500"
          subtitle={`${(t?.verified_subagents ?? 0).toLocaleString()} verified · ${(t?.pending_subagents ?? 0)} pending`}
        />
        <KPICard
          title={`New Agents (${periodNoun})`} icon={UserPlus} loading={isLoading}
          value={(t?.new_agents ?? 0).toLocaleString()}
          color="bg-emerald-500/10 text-emerald-500"
          trend={t ? { value: trendPct(t.new_agents, t.prev_agents), label: 'vs prev' } : undefined}
        />
        <KPICard
          title={`New Sub-Agents (${periodNoun})`} icon={TrendingUp} loading={isLoading}
          value={(t?.new_subagents ?? 0).toLocaleString()}
          color="bg-amber-500/10 text-amber-500"
          trend={t ? { value: trendPct(t.new_subagents, t.prev_subagents), label: 'vs prev' } : undefined}
        />
      </div>

      {/* Growth chart */}
      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-semibold">Recruitment Growth · trailing {trendNoun}</h4>
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-primary" /> Agents</span>
            <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-violet-500" /> Sub-Agents</span>
          </div>
        </div>
        {isLoading ? (
          <div className="h-[280px] animate-pulse rounded-xl bg-muted/40" />
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={chartData} margin={{ top: 5, right: 8, left: -18, bottom: 0 }}>
              <defs>
                <linearGradient id="gradAgents" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                  <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gradSub" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(262 83% 58%)" stopOpacity={0.35} />
                  <stop offset="95%" stopColor="hsl(262 83% 58%)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} />
              <Tooltip
                contentStyle={{ borderRadius: 12, border: '1px solid hsl(var(--border))', background: 'hsl(var(--card))', fontSize: 12 }}
              />
              <Legend wrapperStyle={{ display: 'none' }} />
              <Area type="monotone" dataKey="agents" name="Agents" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#gradAgents)" />
              <Area type="monotone" dataKey="subagents" name="Sub-Agents" stroke="hsl(262 83% 58%)" strokeWidth={2} fill="url(#gradSub)" />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Top recruiters podium */}
      <div className="rounded-2xl border border-border bg-card p-4">
        <h4 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
          <Crown className="h-4 w-4 text-amber-500" /> Top Recruiters ({periodNoun})
        </h4>
        {isLoading ? (
          <div className="h-24 animate-pulse rounded-xl bg-muted/40" />
        ) : (data?.top_recruiters?.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">No recruitment activity in this period.</p>
        ) : (
          <div className="space-y-2">
            {data!.top_recruiters.map((r, i) => (
              <div key={r.agent_id} className="flex items-center gap-3 rounded-xl border border-border/60 bg-muted/20 p-2.5">
                <div className={cn('w-7 shrink-0 text-center font-bold text-sm', i < 3 ? rankAccent[i] : 'text-muted-foreground')}>
                  {i < 3 ? <Medal className="h-5 w-5 mx-auto" /> : `#${i + 1}`}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold truncate">{r.name}</p>
                  {r.phone && <p className="text-[11px] text-muted-foreground truncate">{r.phone}</p>}
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-bold">{r.invited.toLocaleString()}</p>
                  <p className="text-[10px] text-green-600">{r.verified} verified</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Invitees table */}
      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <h4 className="text-sm font-semibold flex items-center gap-1.5">
            <UsersRound className="h-4 w-4 text-violet-500" /> Invitees
            <Badge variant="outline" className="text-[10px]">{invitees.length}</Badge>
          </h4>
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search invitee, agent, phone…"
              className="h-9 pl-8 text-xs"
            />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground border-b border-border">
                <th className="py-2 pr-3 font-medium">Invitee</th>
                <th className="py-2 pr-3 font-medium">Invited by</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 pr-3 font-medium whitespace-nowrap">Joined</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i} className="border-b border-border/50">
                    <td colSpan={4} className="py-3"><div className="h-4 w-full animate-pulse rounded bg-muted/40" /></td>
                  </tr>
                ))
              ) : invitees.length === 0 ? (
                <tr><td colSpan={4} className="py-8 text-center text-muted-foreground">No invitees found for this period.</td></tr>
              ) : (
                pagedInvitees.map((inv) => (
                  <tr key={inv.id} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                    <td className="py-2.5 pr-3">
                      <p className="font-medium truncate max-w-[180px]">{inv.sub_agent_name}</p>
                      {inv.sub_agent_phone && <p className="text-[11px] text-muted-foreground">{inv.sub_agent_phone}</p>}
                    </td>
                    <td className="py-2.5 pr-3 text-muted-foreground truncate max-w-[160px]">{inv.parent_name}</td>
                    <td className="py-2.5 pr-3">
                      <Badge variant="outline" className={cn('text-[10px] gap-1 capitalize', statusStyles[inv.status] || statusStyles.expired)}>
                        {inv.status === 'verified' ? <ShieldCheck className="h-2.5 w-2.5" /> : <Clock className="h-2.5 w-2.5" />}
                        {inv.status.replace(/_/g, ' ')}
                      </Badge>
                    </td>
                    <td className="py-2.5 pr-3 whitespace-nowrap text-muted-foreground text-xs">
                      {format(new Date(inv.created_at), 'dd MMM yy')}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {/* Pagination — 15 per page */}
        {!isLoading && invitees.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 pt-3 mt-1 border-t border-border/60">
            <p className="text-[11px] text-muted-foreground">
              Showing <span className="font-medium text-foreground">{rangeStart}–{rangeEnd}</span> of{' '}
              <span className="font-medium text-foreground">{invitees.length}</span>
            </p>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={currentPage <= 1}
                className="inline-flex items-center gap-1 h-8 px-2.5 rounded-lg border border-border bg-card text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-muted/40 transition-colors"
              >
                <ChevronLeft className="h-3.5 w-3.5" /> Prev
              </button>
              <span className="text-xs text-muted-foreground px-1 tabular-nums">
                Page {currentPage} / {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage >= totalPages}
                className="inline-flex items-center gap-1 h-8 px-2.5 rounded-lg border border-border bg-card text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-muted/40 transition-colors"
              >
                Next <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default AgentLeaderboardPanel;
