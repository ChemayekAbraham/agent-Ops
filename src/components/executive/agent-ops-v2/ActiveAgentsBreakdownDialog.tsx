import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { format, subDays, startOfDay } from 'date-fns';
import { Activity, TrendingUp, TrendingDown, Users, UserPlus } from 'lucide-react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';

// Same definition as the overview card: active = collected rent in the window
// (agent_collections, non-reversed), via get_agent_ops_overview. One call with a
// 7-day range returns both the current week and the previous week (the RPC's
// built-in previous-window), so the modal and the card can never disagree.

function fmtNum(n: number): string {
  return Number(n || 0).toLocaleString();
}

function pctDelta(curr: number, prev: number): number {
  if (!prev) return curr > 0 ? 100 : 0;
  return ((curr - prev) / prev) * 100;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ActiveAgentsBreakdownDialog({ open, onOpenChange }: Props) {
  const weekStart = useMemo(() => startOfDay(subDays(new Date(), 7)), []);
  const prevWeekStart = useMemo(() => startOfDay(subDays(new Date(), 14)), []);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['agent-ops-active-breakdown', weekStart.toISOString()],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_ops_overview' as any, {
        p_range_start: weekStart.toISOString(),
        p_range_end: new Date().toISOString(),
      });
      if (error) throw error;
      return data as unknown as {
        kpis: Record<string, number>;
        trend: Array<{ day: string; active_agents: number }>;
      };
    },
    staleTime: 60_000,
  });

  const k = data?.kpis || {};

  const currAgents = k.active_agents_curr || 0;
  const currSubs = k.active_subagents_curr || 0;
  const prevAgents = k.active_agents_prev || 0;
  const prevSubs = k.active_subagents_prev || 0;

  const currTotal = currAgents + currSubs;
  const prevTotal = prevAgents + prevSubs;
  const net = currTotal - prevTotal;
  const pct = pctDelta(currTotal, prevTotal);
  const up = net >= 0;

  const daily = (data?.trend || []).map((t) => ({
    label: format(new Date(t.day), 'EEE d'),
    active: t.active_agents,
  }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4 text-emerald-600" />
            Active Agents — Weekly Breakdown
          </DialogTitle>
          <DialogDescription className="text-xs">
            {format(weekStart, 'dd MMM')} → {format(new Date(), 'dd MMM yyyy')} compared with{' '}
            {format(prevWeekStart, 'dd MMM')} → {format(weekStart, 'dd MMM')}. Active = collected rent at least once in the week.
          </DialogDescription>
        </DialogHeader>

        {isError ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            Could not load the breakdown right now. Please try again.
          </p>
        ) : isLoading ? (
          <div className="space-y-3 py-2">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <div className="space-y-4">
            {/* Headline comparison */}
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-xl border border-border/50 bg-muted/30 p-3 text-center">
                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">This week</p>
                <p className="text-2xl font-bold tabular-nums text-foreground">{fmtNum(currTotal)}</p>
              </div>
              <div className="rounded-xl border border-border/50 bg-muted/30 p-3 text-center">
                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Last week</p>
                <p className="text-2xl font-bold tabular-nums text-foreground">{fmtNum(prevTotal)}</p>
              </div>
              <div className="rounded-xl border border-border/50 bg-muted/30 p-3 text-center flex flex-col items-center justify-center gap-1">
                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Change</p>
                <Badge
                  variant="secondary"
                  className={cn(
                    'gap-1 text-xs font-semibold',
                    up
                      ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30'
                      : 'bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30',
                  )}
                >
                  {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                  {up ? '+' : ''}{fmtNum(net)} ({Math.abs(pct).toFixed(1)}%)
                </Badge>
              </div>
            </div>

            {/* Agent vs sub-agent split */}
            <div className="rounded-xl border border-border/50 overflow-hidden">
              <div className="grid grid-cols-3 bg-muted/40 px-3 py-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                <span>Group</span>
                <span className="text-right">This week</span>
                <span className="text-right">Last week</span>
              </div>
              <div className="grid grid-cols-3 px-3 py-2.5 text-sm border-t border-border/40 items-center">
                <span className="flex items-center gap-1.5 text-foreground">
                  <Users className="h-3.5 w-3.5 text-muted-foreground" /> Agents
                </span>
                <span className="text-right font-semibold tabular-nums">{fmtNum(currAgents)}</span>
                <span className="text-right tabular-nums text-muted-foreground">{fmtNum(prevAgents)}</span>
              </div>
              <div className="grid grid-cols-3 px-3 py-2.5 text-sm border-t border-border/40 items-center">
                <span className="flex items-center gap-1.5 text-foreground">
                  <UserPlus className="h-3.5 w-3.5 text-muted-foreground" /> Sub-agents
                </span>
                <span className="text-right font-semibold tabular-nums">{fmtNum(currSubs)}</span>
                <span className="text-right tabular-nums text-muted-foreground">{fmtNum(prevSubs)}</span>
              </div>
            </div>

            {/* Daily active trend for the current week */}
            {daily.length > 0 && (
              <div>
                <p className="text-[11px] font-medium text-muted-foreground mb-1.5">Daily active agents — this week</p>
                <div className="h-36">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={daily} margin={{ top: 4, right: 4, bottom: 0, left: -18 }}>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                      <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                      <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                      <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                      <Bar dataKey="active" name="Active" fill="hsl(160 84% 39%)" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
