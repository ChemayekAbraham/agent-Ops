import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Users, UserCheck, Activity, Loader2, Info, Home, Banknote, UserX, Network, ChevronRight, Search } from 'lucide-react';
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import { cn } from '@/lib/utils';
import { format, parseISO } from 'date-fns';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { UserAvatar } from '@/components/UserAvatar';
import type { DateRange } from './AgentOpsHomeView';

interface AgentStats {
  total_users: number;
  total_agents: number;
  active_agents: number;
  inactive_agents: number;
  sub_agents: number;
  primary_agents: number;
  ever_collected: number;
  live_plan_agents: number;
  collected_in_window: number;
  operations: number;
  window_days: number;
  criteria: {
    collections: number;
    live_plans: number;
    sub_agents: number;
    primary_agents: number;
  };
  trend: Array<{ day: string; active_agents: number; operations: number }>;
}

type CriterionKey = 'collections' | 'live_plans' | 'sub_agents' | 'primary_agents';

interface CriterionUserRow {
  user_id: string;
  full_name: string | null;
  phone: string | null;
  avatar_url: string | null;
  cnt: number;
}

const CRITERIA_META: Record<CriterionKey, { label: string; icon: typeof Home; color: string }> = {
  collections: { label: 'Has collected rent for a tenant', icon: Banknote, color: 'hsl(var(--primary))' },
  live_plans: { label: 'Collecting on a live rent plan', icon: Activity, color: 'hsl(160 84% 39%)' },
  primary_agents: { label: 'Primary agent (no parent link)', icon: UserCheck, color: 'hsl(38 92% 50%)' },
  sub_agents: { label: 'Sub-agent (verified relationship)', icon: Network, color: 'hsl(280 65% 60%)' },
};

const CRITERIA_ORDER: CriterionKey[] = ['collections', 'live_plans', 'primary_agents', 'sub_agents'];

function rangeToDays(range: DateRange): number {
  if (range === '24h') return 1;
  if (range === '7d') return 7;
  return 30;
}

function pct(part: number, whole: number): number {
  if (!whole) return 0;
  return Math.min(100, (part / whole) * 100);
}

function fmt(n: number): string {
  return (n ?? 0).toLocaleString();
}

export function AgentDefinitionFunnel({ range }: { range: DateRange }) {
  const days = rangeToDays(range);
  const [drill, setDrill] = useState<CriterionKey | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['agent-definition-funnel', days],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('get_agent_ops_agent_stats', { p_days: days });
      if (error) throw error;
      return data as AgentStats;
    },
    staleTime: 60_000,
  });

  const totalUsers = data?.total_users ?? 0;
  const totalAgents = data?.total_agents ?? 0;
  const activeAgents = data?.active_agents ?? 0;
  const inactiveAgents = data?.inactive_agents ?? Math.max(0, totalAgents - activeAgents);
  const subAgents = data?.sub_agents ?? 0;
  const primaryAgents = data?.primary_agents ?? 0;

  const trend = useMemo(
    () =>
      (data?.trend ?? []).map((t) => ({
        label: (() => {
          try {
            return format(parseISO(t.day), days <= 7 ? 'EEE' : 'd MMM');
          } catch {
            return t.day;
          }
        })(),
        active: t.active_agents,
        operations: t.operations,
      })),
    [data?.trend, days],
  );

  const pieData = useMemo(
    () =>
      CRITERIA_ORDER.map((key) => ({
        key,
        name: CRITERIA_META[key].label,
        value: data?.criteria?.[key] ?? 0,
        color: CRITERIA_META[key].color,
      })),
    [data?.criteria],
  );
  const pieTotal = pieData.reduce((s, d) => s + d.value, 0);

  const funnelSteps = [
    {
      key: 'users',
      label: 'Total Users',
      value: totalUsers,
      sub: 'Everyone on the platform',
      icon: Users,
      accent: 'text-sky-600 dark:text-sky-400',
      bg: 'bg-sky-500/10',
      barBg: 'bg-sky-500',
      shareOf: null as number | null,
      of: '',
    },
    {
      key: 'agents',
      label: 'Total Agents',
      value: totalAgents,
      sub: 'Collected or collecting rent for a tenant',
      icon: UserCheck,
      accent: 'text-primary',
      bg: 'bg-primary/10',
      barBg: 'bg-primary',
      shareOf: pct(totalAgents, totalUsers),
      of: 'users',
    },
    {
      key: 'active',
      label: 'Active Agents',
      value: activeAgents,
      sub: 'Live rent plan or collected in last 30d',
      icon: Activity,
      accent: 'text-emerald-600 dark:text-emerald-400',
      bg: 'bg-emerald-500/10',
      barBg: 'bg-emerald-500',
      shareOf: pct(activeAgents, totalAgents),
      of: 'agents',
    },
    {
      key: 'inactive',
      label: 'Inactive Agents',
      value: inactiveAgents,
      sub: 'No live plan and no collection in 30d',
      icon: UserX,
      accent: 'text-amber-600 dark:text-amber-400',
      bg: 'bg-amber-500/10',
      barBg: 'bg-amber-500',
      shareOf: pct(inactiveAgents, totalAgents),
      of: 'agents',
    },
  ];

  return (
    <Card className="rounded-2xl border-border/50 p-3 sm:p-4">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
            Who is an Agent?
            <Info className="h-3.5 w-3.5 text-muted-foreground" />
          </h3>
          <p className="text-[11px] text-muted-foreground">
            An agent is a person who has collected rent for a tenant, or is collecting/repaying on a live rent plan —
            not a person holding the agent role. {fmt(primaryAgents)} primary · {fmt(subAgents)} sub-agents.
          </p>
        </div>
        <Badge variant="outline" className="text-[10px] gap-1 shrink-0">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
          Live
        </Badge>
      </div>

      {/* Funnel + trend side by side on desktop */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 sm:gap-4 items-stretch">
        {/* Funnel */}
        <div className="flex flex-col gap-2.5">
          {funnelSteps.map((step) => {
            const Icon = step.icon;
            const width = step.key === 'users' ? 100 : step.shareOf ?? 0;
            return (
              <div key={step.key} className="rounded-xl border border-border/50 bg-card/60 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={cn('h-8 w-8 rounded-lg flex items-center justify-center shrink-0', step.bg)}>
                      <Icon className={cn('h-4 w-4', step.accent)} />
                    </span>
                    <div className="min-w-0">
                      <p className="text-[11px] font-medium text-muted-foreground leading-tight">{step.label}</p>
                      <p className="text-[10px] text-muted-foreground/70 leading-tight truncate">{step.sub}</p>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xl font-bold tabular-nums text-foreground leading-none">
                      {isLoading ? <Loader2 className="h-4 w-4 animate-spin inline" /> : fmt(step.value)}
                    </p>
                    {step.shareOf !== null && !isLoading && (
                      <p className="text-[10px] font-semibold text-muted-foreground">
                        {step.shareOf.toFixed(step.shareOf < 1 ? 2 : 1)}%
                        <span className="text-muted-foreground/60"> of {step.of}</span>
                      </p>
                    )}
                  </div>
                </div>
                <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
                  <div className={cn('h-full rounded-full transition-all', step.barBg)} style={{ width: `${width}%` }} />
                </div>
              </div>
            );
          })}
        </div>

        {/* Trend of active agents & operations */}
        <div className="flex flex-col">
          <p className="text-[11px] font-medium text-muted-foreground mb-1">
            Active agents & operations trend
          </p>
          <div className="h-52 xl:flex-1 xl:min-h-[220px] -mx-2">
            {isLoading ? (
              <div className="h-full w-full flex items-center justify-center">
                <Loader2 className="h-5 w-5 text-muted-foreground animate-spin" />
              </div>
            ) : trend.every((t) => t.active === 0 && t.operations === 0) ? (
              <div className="h-full w-full flex items-center justify-center">
                <p className="text-xs text-muted-foreground">No agent operations in this window yet.</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={trend} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="funnel-active-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(38 92% 50%)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="hsl(38 92% 50%)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" width={30} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: 12,
                      fontSize: 12,
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="operations" name="Operations" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} barSize={14} />
                  <Area
                    type="monotone"
                    dataKey="active"
                    name="Active agents"
                    stroke="hsl(38 92% 50%)"
                    strokeWidth={2}
                    fill="url(#funnel-active-fill)"
                    dot={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      {/* Criteria pie + clickable legend */}
      <div className="mt-4 pt-3 border-t border-border/50">
        <p className="text-[11px] font-medium text-muted-foreground mb-2">
          How agents qualify — tap any slice to view those users
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-center">
          <div className="h-48">
            {isLoading ? (
              <div className="h-full w-full flex items-center justify-center">
                <Loader2 className="h-5 w-5 text-muted-foreground animate-spin" />
              </div>
            ) : pieTotal === 0 ? (
              <div className="h-full w-full flex items-center justify-center">
                <p className="text-xs text-muted-foreground">No qualifying agents yet.</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    dataKey="value"
                    nameKey="name"
                    innerRadius="52%"
                    outerRadius="85%"
                    paddingAngle={2}
                    onClick={(_, idx) => setDrill(pieData[idx]?.key ?? null)}
                    className="cursor-pointer focus:outline-none"
                  >
                    {pieData.map((d) => (
                      <Cell key={d.key} fill={d.color} className="cursor-pointer focus:outline-none" />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: 12,
                      fontSize: 12,
                    }}
                    formatter={(v: number, n: string) => [`${fmt(v)} agents`, n]}
                  />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            {pieData.map((d) => {
              const Icon = CRITERIA_META[d.key].icon;
              return (
                <button
                  key={d.key}
                  type="button"
                  onClick={() => setDrill(d.key)}
                  className="group flex items-center justify-between gap-2 rounded-lg border border-border/50 bg-card/60 px-2.5 py-2 text-left hover:border-primary/40 hover:bg-muted/50 transition-colors"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="h-6 w-6 rounded-md flex items-center justify-center shrink-0" style={{ backgroundColor: `${d.color}22` }}>
                      <Icon className="h-3.5 w-3.5" style={{ color: d.color }} />
                    </span>
                    <span className="text-xs font-medium text-foreground truncate">{d.name}</span>
                  </span>
                  <span className="flex items-center gap-1.5 shrink-0">
                    <span className="text-sm font-bold tabular-nums text-foreground">{fmt(d.value)}</span>
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground group-hover:text-primary" />
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <CriterionUsersDialog criterion={drill} onOpenChange={(open) => !open && setDrill(null)} />
    </Card>
  );
}

function CriterionUsersDialog({
  criterion,
  onOpenChange,
}: {
  criterion: CriterionKey | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [search, setSearch] = useState('');

  const { data, isLoading } = useQuery({
    enabled: !!criterion,
    queryKey: ['agent-criteria-users', criterion],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('get_agent_ops_criteria_users', { p_criterion: criterion });
      if (error) throw error;
      return (data ?? []) as CriterionUserRow[];
    },
    staleTime: 60_000,
  });

  const meta = criterion ? CRITERIA_META[criterion] : null;
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return data ?? [];
    return (data ?? []).filter(
      (r) => (r.full_name || '').toLowerCase().includes(term) || (r.phone || '').toLowerCase().includes(term),
    );
  }, [data, search]);

  return (
    <Dialog open={!!criterion} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            {meta && <meta.icon className="h-4 w-4 text-primary" />}
            {meta?.label ?? 'Users'}
            {data && <Badge variant="secondary" className="ml-1">{data.length}</Badge>}
          </DialogTitle>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or phone…"
            className="pl-8 h-9"
          />
        </div>

        <div className="flex-1 overflow-y-auto -mx-1 px-1 space-y-1.5 mt-1">
          {isLoading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground py-10">No users found.</p>
          ) : (
            filtered.map((r) => (
              <div
                key={r.user_id}
                className="flex items-center gap-3 rounded-xl border border-border/50 bg-card p-2.5"
              >
                <UserAvatar avatarUrl={r.avatar_url} fullName={r.full_name ?? undefined} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground truncate">{r.full_name || 'Unnamed user'}</p>
                  <p className="text-xs text-muted-foreground truncate">{r.phone || '—'}</p>
                </div>
                <Badge variant="outline" className="tabular-nums shrink-0">
                  {fmt(r.cnt)}×
                </Badge>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
