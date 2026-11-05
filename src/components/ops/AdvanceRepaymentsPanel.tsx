import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  ResponsiveContainer, AreaChart, Area, LineChart, Line, BarChart, Bar,
  PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import {
  Banknote, TrendingDown, TrendingUp, Loader2, AlertTriangle,
  CircleDollarSign, Activity, History, ChevronRight, CalendarClock, Percent, Ban,
} from 'lucide-react';
import { CancelAdvanceDialog } from '@/components/cfo/CancelAdvanceDialog';
import {
  format, differenceInCalendarDays, subDays, eachDayOfInterval, startOfDay,
} from 'date-fns';

const num = (v: any) => Number(v ?? 0);

interface Advance {
  id: string;
  agent_id: string;
  principal: number;
  outstanding_balance: number;
  daily_rate: number;
  monthly_rate: number;
  cycle_days: number;
  issued_at: string;
  expires_at: string;
  status: string;
}

interface LedgerRow {
  advance_id: string;
  date: string;
  opening_balance: number;
  interest_accrued: number;
  amount_deducted: number;
  closing_balance: number;
  deduction_status: string;
}

const STATUS_TONE: Record<string, string> = {
  active: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/25',
  repaying: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/25',
  overdue: 'bg-rose-500/15 text-rose-700 dark:text-rose-400 border-rose-500/25',
  completed: 'bg-muted text-muted-foreground border-border',
};

const CHART_COLORS = ['#7c3aed', '#059669', '#f59e0b', '#ef4444', '#0ea5e9', '#ec4899'];

/* ---------------------------------------------------------------- */

export function AdvanceRepaymentsPanel() {
  const [selected, setSelected] = useState<Advance | null>(null);
  const [scope, setScope] = useState<'active' | 'all'>('active');
  const queryClient = useQueryClient();

  useEffect(() => {
    const handler = () => {
      queryClient.invalidateQueries({ queryKey: ['advance-repayments-advances'] });
      queryClient.invalidateQueries({ queryKey: ['advance-repayments-ledger'] });
    };
    window.addEventListener('advance-repayments-refresh', handler);
    return () => window.removeEventListener('advance-repayments-refresh', handler);
  }, [queryClient]);

  const { data: advances, isLoading: advLoading } = useQuery({
    queryKey: ['advance-repayments-advances'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_advances')
        .select('id, agent_id, principal, outstanding_balance, daily_rate, monthly_rate, cycle_days, issued_at, expires_at, status')
        .order('issued_at', { ascending: false });
      if (error) throw error;
      return (data || []) as Advance[];
    },
    staleTime: 60_000,
  });

  const { data: ledger, isLoading: ledLoading } = useQuery({
    queryKey: ['advance-repayments-ledger'],
    queryFn: async () => {
      const since = format(subDays(new Date(), 90), 'yyyy-MM-dd');
      const { data, error } = await supabase
        .from('agent_advance_ledger')
        .select('advance_id, date, opening_balance, interest_accrued, amount_deducted, closing_balance, deduction_status')
        .gte('date', since)
        .order('date', { ascending: true });
      if (error) throw error;
      return (data || []) as LedgerRow[];
    },
    staleTime: 60_000,
  });

  const agentIds = useMemo(
    () => [...new Set((advances || []).map((a) => a.agent_id))],
    [advances],
  );
  const { data: names } = useQuery({
    queryKey: ['advance-repayments-names', agentIds.sort().join(',')],
    queryFn: async () => {
      if (!agentIds.length) return {};
      const map: Record<string, string> = {};
      const BATCH = 50;
      for (let i = 0; i < agentIds.length; i += BATCH) {
        const { data } = await supabase.from('profiles')
          .select('id, full_name').in('id', agentIds.slice(i, i + BATCH));
        (data || []).forEach((p: any) => { map[p.id] = p.full_name; });
      }
      return map;
    },
    enabled: agentIds.length > 0,
    staleTime: 300_000,
  });
  const nameOf = (id: string) => names?.[id] || id.slice(0, 8) + '…';

  const loading = advLoading || ledLoading;

  /* ---- KPIs ---- */
  const stats = useMemo(() => {
    const all = advances || [];
    const activeList = all.filter((a) => a.status === 'active' || a.status === 'overdue');
    const outstanding = activeList.reduce((s, a) => s + num(a.outstanding_balance), 0);
    const overdue = all.filter((a) => a.status === 'overdue');
    const overdueOutstanding = overdue.reduce((s, a) => s + num(a.outstanding_balance), 0);
    const principalActive = activeList.reduce((s, a) => s + num(a.principal), 0);

    const last30 = subDays(startOfDay(new Date()), 30).getTime();
    const last7 = subDays(startOfDay(new Date()), 7).getTime();
    let repaid30 = 0, repaid7 = 0, interest30 = 0, daysWithRepay = 0;
    const seenDays = new Set<string>();
    (ledger || []).forEach((l) => {
      const t = new Date(l.date).getTime();
      if (t >= last30) {
        repaid30 += num(l.amount_deducted);
        interest30 += num(l.interest_accrued);
        if (num(l.amount_deducted) > 0) seenDays.add(l.date);
      }
      if (t >= last7) repaid7 += num(l.amount_deducted);
    });
    daysWithRepay = seenDays.size;
    const avgDaily = daysWithRepay ? repaid30 / daysWithRepay : 0;

    return {
      activeCount: activeList.length,
      outstanding,
      overdueCount: overdue.length,
      overdueOutstanding,
      principalActive,
      repaid30,
      repaid7,
      interest30,
      avgDaily,
    };
  }, [advances, ledger]);

  /* ---- Daily repayment trend (last 60 days) ---- */
  const dailyTrend = useMemo(() => {
    const days = eachDayOfInterval({ start: subDays(new Date(), 59), end: new Date() });
    const byDay: Record<string, { repaid: number; interest: number }> = {};
    (ledger || []).forEach((l) => {
      const key = l.date;
      if (!byDay[key]) byDay[key] = { repaid: 0, interest: 0 };
      byDay[key].repaid += num(l.amount_deducted);
      byDay[key].interest += num(l.interest_accrued);
    });
    return days.map((d) => {
      const key = format(d, 'yyyy-MM-dd');
      return {
        date: format(d, 'MMM d'),
        Repaid: Math.round(byDay[key]?.repaid || 0),
        Interest: Math.round(byDay[key]?.interest || 0),
      };
    });
  }, [ledger]);

  /* ---- Outstanding by active advance (top 8) ---- */
  const outstandingByAdvance = useMemo(() => {
    return (advances || [])
      .filter((a) => a.status === 'active' || a.status === 'overdue')
      .sort((a, b) => num(b.outstanding_balance) - num(a.outstanding_balance))
      .slice(0, 8)
      .map((a) => ({
        name: nameOf(a.agent_id).split(' ')[0],
        Outstanding: Math.round(num(a.outstanding_balance)),
        overdue: a.status === 'overdue',
      }));
  }, [advances, names]);

  /* ---- Status distribution ---- */
  const statusDist = useMemo(() => {
    const counts: Record<string, number> = {};
    (advances || []).forEach((a) => { counts[a.status] = (counts[a.status] || 0) + 1; });
    return Object.entries(counts).map(([name, value]) => ({ name, value }));
  }, [advances]);

  const list = useMemo(() => {
    const all = advances || [];
    const filtered = scope === 'active'
      ? all.filter((a) => a.status === 'active' || a.status === 'overdue')
      : all;
    return filtered.sort((a, b) => num(b.outstanding_balance) - num(a.outstanding_balance));
  }, [advances, scope]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-2 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
        <span className="text-xs font-medium">Loading repayment analytics...</span>
      </div>
    );
  }

  const kpiItems = [
    {
      title: 'Active advances',
      value: String(stats.activeCount),
      sub: `Principal ${formatUGX(stats.principalActive)}`,
      icon: Activity,
      tone: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 ring-violet-500/20',
      accent: 'from-violet-500/80 via-violet-500/40 to-transparent',
    },
    {
      title: 'Outstanding (active)',
      value: formatUGX(stats.outstanding),
      sub: 'Current book balance',
      icon: CircleDollarSign,
      tone: 'bg-sky-500/10 text-sky-600 dark:text-sky-400 ring-sky-500/20',
      accent: 'from-sky-500/80 via-sky-500/40 to-transparent',
    },
    {
      title: 'Repaid (30d)',
      value: formatUGX(stats.repaid30),
      sub: 'Rolling 30-day collections',
      icon: TrendingDown,
      tone: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 ring-emerald-500/20',
      accent: 'from-emerald-500/80 via-emerald-500/40 to-transparent',
    },
    {
      title: 'Repaid (7d)',
      value: formatUGX(stats.repaid7),
      sub: 'Last 7 days recovered',
      icon: TrendingDown,
      tone: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 ring-emerald-500/20',
      accent: 'from-emerald-500/80 via-emerald-500/40 to-transparent',
    },
    {
      title: 'Avg daily repayment',
      value: formatUGX(stats.avgDaily),
      sub: 'On active collection days',
      icon: Banknote,
      tone: 'bg-teal-500/10 text-teal-600 dark:text-teal-400 ring-teal-500/20',
      accent: 'from-teal-500/80 via-teal-500/40 to-transparent',
    },
    {
      title: 'Access charges (30d)',
      value: formatUGX(stats.interest30),
      sub: 'Accrued over last 30 days',
      icon: Percent,
      tone: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 ring-amber-500/20',
      accent: 'from-amber-500/80 via-amber-500/40 to-transparent',
    },
    {
      title: 'Overdue advances',
      value: String(stats.overdueCount),
      sub: 'Past scheduled expiry',
      icon: AlertTriangle,
      tone: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 ring-rose-500/20',
      accent: 'from-rose-500/80 via-rose-500/40 to-transparent',
    },
    {
      title: 'Overdue outstanding',
      value: formatUGX(stats.overdueOutstanding),
      sub: 'At-risk balance exposure',
      icon: AlertTriangle,
      tone: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 ring-rose-500/20',
      accent: 'from-rose-500/80 via-rose-500/40 to-transparent',
    },
  ];

  return (
    <div className="space-y-6">
      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        {kpiItems.map((k) => (
          <Card key={k.title} className="relative overflow-hidden rounded-xl border-border/80 bg-card shadow-2xs transition-all hover:shadow-md">
            <div className={` inset-x-0 top-0 h-1 bg-gradient-to-r ${k.accent}`} />
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-2 mb-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground leading-tight">
                  {k.title}
                </span>
                <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ring-1 ${k.tone}`}>
                  <k.icon className="h-3.5 w-3.5" />
                </span>
              </div>
              <p className="text-lg sm:text-xl font-bold tracking-tight tabular-nums text-foreground truncate">
                {k.value}
              </p>
              <p className="text-[11px] text-muted-foreground mt-1 truncate">{k.sub}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Daily repayment trend */}
      <Card className="rounded-xl border-border/80 shadow-2xs">
        <CardHeader className="pb-3 border-b border-border/50">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <TrendingUp className="h-3.5 w-3.5" />
              </span>
              <div>
                <span>Repayment trend (last 60 days)</span>
                <p className="text-[11px] font-normal text-muted-foreground">
                  Daily principal &amp; fee deductions versus daily accrued access charges
                </p>
              </div>
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent className="pt-4">
          <ResponsiveContainer width="100%" height={250}>
            <AreaChart data={dailyTrend} margin={{ left: -10, right: 8, top: 6 }}>
              <defs>
                <linearGradient id="rep" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#7c3aed" stopOpacity={0.45} />
                  <stop offset="95%" stopColor="#7c3aed" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="intr" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.35} />
                  <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} interval={9} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
              <Tooltip formatter={(v: any) => formatUGX(Number(v))} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Area type="monotone" dataKey="Repaid" stroke="#7c3aed" fill="url(#rep)" strokeWidth={2} />
              <Area type="monotone" dataKey="Interest" name="Accrued Charges" stroke="#f59e0b" fill="url(#intr)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* Outstanding by advance */}
        <Card className="rounded-xl border-border/80 shadow-2xs">
          <CardHeader className="pb-3 border-b border-border/50">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Banknote className="h-3.5 w-3.5" />
              </span>
              <div>
                <span>Top outstanding balances</span>
                <p className="text-[11px] font-normal text-muted-foreground">Highest active &amp; overdue exposures by agent</p>
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <ResponsiveContainer width="100%" height={230}>
              <BarChart data={outstandingByAdvance} margin={{ left: -6, right: 8 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
                <Tooltip formatter={(v: any) => formatUGX(Number(v))} />
                <Bar dataKey="Outstanding" radius={[5, 5, 0, 0]}>
                  {outstandingByAdvance.map((e, i) => (
                    <Cell key={i} fill={e.overdue ? '#ef4444' : '#7c3aed'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Status distribution */}
        <Card className="rounded-xl border-border/80 shadow-2xs">
          <CardHeader className="pb-3 border-b border-border/50">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Activity className="h-3.5 w-3.5" />
              </span>
              <div>
                <span>Advances by status</span>
                <p className="text-[11px] font-normal text-muted-foreground">Portfolio composition across lifecycle stages</p>
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <ResponsiveContainer width="100%" height={230}>
              <PieChart>
                <Pie data={statusDist} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={48} outerRadius={82} paddingAngle={2} label={(e: any) => `${e.name} (${e.value})`} labelLine={false} fontSize={10}>
                  {statusDist.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Per-advance list */}
      <Card className="rounded-xl border-border/80 shadow-2xs">
        <CardHeader className="pb-3 border-b border-border/50 flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <History className="h-3.5 w-3.5" />
            </span>
            <div>
              <span>Advance repayment tracker</span>
              <p className="text-[11px] font-normal text-muted-foreground">Click any advance to inspect its 90-day ledger history</p>
            </div>
          </CardTitle>
          <div className="flex gap-1.5 bg-muted/60 p-1 rounded-lg">
            <Button size="sm" variant={scope === 'active' ? 'default' : 'ghost'} className="h-7 text-xs px-3 rounded-md" onClick={() => setScope('active')}>Active</Button>
            <Button size="sm" variant={scope === 'all' ? 'default' : 'ghost'} className="h-7 text-xs px-3 rounded-md" onClick={() => setScope('all')}>All</Button>
          </div>
        </CardHeader>
        <CardContent className="pt-4">
          {list.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border/70 bg-muted/15 py-10 text-center">
              <p className="text-xs text-muted-foreground">No advances in this view.</p>
            </div>
          ) : (
            <div className="grid gap-2.5 sm:grid-cols-2">
              {list.map((a) => {
                const repaid = Math.max(0, num(a.principal) - num(a.outstanding_balance));
                const pct = num(a.principal) > 0 ? Math.min(100, (repaid / num(a.principal)) * 100) : 0;
                const daysLeft = differenceInCalendarDays(new Date(a.expires_at), new Date());
                return (
                  <button
                    key={a.id}
                    onClick={() => setSelected(a)}
                    className="group w-full text-left rounded-xl border border-border/80 bg-card p-3.5 hover:border-primary/40 hover:shadow-xs transition-all"
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-foreground truncate group-hover:text-primary transition-colors">
                          {nameOf(a.agent_id)}
                        </p>
                        <p className="text-[11px] text-muted-foreground flex items-center gap-1 mt-0.5">
                          <CalendarClock className="h-3 w-3 shrink-0" />
                          {a.status === 'completed'
                            ? `Issued ${format(new Date(a.issued_at), 'MMM d')}`
                            : daysLeft >= 0 ? `${daysLeft}d left` : `${Math.abs(daysLeft)}d overdue`}
                        </p>
                      </div>
                      <Badge variant="outline" className={`text-[10px] px-2 py-0.5 h-5 font-semibold capitalize ${STATUS_TONE[a.status] || 'bg-muted'}`}>
                        {a.status}
                      </Badge>
                      <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:translate-x-0.5 transition-transform shrink-0" />
                    </div>
                    <div className="mt-3">
                      <div className="flex justify-between text-[11px] mb-1.5">
                        <span className="text-muted-foreground tabular-nums">Repaid {formatUGX(repaid)}</span>
                        <span className="font-semibold tabular-nums text-foreground">{pct.toFixed(0)}%</span>
                      </div>
                      <Progress value={pct} className="h-1.5" />
                      <div className="flex justify-between text-[11px] text-muted-foreground mt-2 pt-2 border-t border-border/50">
                        <span className="tabular-nums">Principal {formatUGX(num(a.principal))}</span>
                        <span className="font-bold tabular-nums text-foreground">Outstanding {formatUGX(num(a.outstanding_balance))}</span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <RepaymentDetailDialog
        advance={selected}
        ledger={ledger || []}
        agentName={selected ? nameOf(selected.agent_id) : ''}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

/* ---------------------------------------------------------------- */

function RepaymentDetailDialog({
  advance, ledger, agentName, onClose,
}: {
  advance: Advance | null;
  ledger: LedgerRow[];
  agentName: string;
  onClose: () => void;
}) {
  const [cancelOpen, setCancelOpen] = useState(false);
  const rows = useMemo(() => {
    if (!advance) return [];
    return ledger
      .filter((l) => l.advance_id === advance.id)
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  }, [advance, ledger]);

  const chartData = rows.map((r) => ({
    date: format(new Date(r.date), 'MMM d'),
    Balance: Math.round(num(r.closing_balance)),
    Deducted: Math.round(num(r.amount_deducted)),
  }));

  const totalRepaid = rows.reduce((s, r) => s + num(r.amount_deducted), 0);
  const totalInterest = rows.reduce((s, r) => s + num(r.interest_accrued), 0);

  const isActive = advance && (advance.status === 'active' || advance.status === 'overdue');
  const advanceForCancel = advance ? { ...advance, profiles: { full_name: agentName } } : null;

  return (
    <Dialog open={!!advance} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <History className="h-4 w-4 text-primary" /> {agentName} — repayment history
          </DialogTitle>
        </DialogHeader>

        {advance && (
          <div className="space-y-4">
            {isActive && (
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 text-xs text-destructive border-destructive/30 hover:bg-destructive/10"
                  onClick={() => setCancelOpen(true)}
                >
                  <Ban className="h-3.5 w-3.5" /> Cancel advance
                </Button>
              </div>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              <MiniStat label="Principal" value={formatUGX(num(advance.principal))} />
              <MiniStat label="Outstanding" value={formatUGX(num(advance.outstanding_balance))} />
              <MiniStat label="Repaid" value={formatUGX(totalRepaid)} />
              <MiniStat label="Access Charges (90d)" value={formatUGX(totalInterest)} />
            </div>

            {chartData.length > 0 ? (
              <>
                <div className="rounded-xl border border-border/70 bg-muted/15 p-3.5">
                  <p className="text-xs font-semibold mb-2">Balance drawdown</p>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={chartData} margin={{ left: -8, right: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                      <XAxis dataKey="date" tick={{ fontSize: 10 }} interval={Math.max(0, Math.floor(chartData.length / 8))} />
                      <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
                      <Tooltip formatter={(v: any) => formatUGX(Number(v))} />
                      <Line type="monotone" dataKey="Balance" stroke="#7c3aed" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>

                <div className="rounded-xl border border-border/70 bg-muted/15 p-3.5">
                  <p className="text-xs font-semibold mb-2">Daily deductions</p>
                  <ResponsiveContainer width="100%" height={160}>
                    <BarChart data={chartData} margin={{ left: -8, right: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                      <XAxis dataKey="date" tick={{ fontSize: 10 }} interval={Math.max(0, Math.floor(chartData.length / 8))} />
                      <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
                      <Tooltip formatter={(v: any) => formatUGX(Number(v))} />
                      <Bar dataKey="Deducted" fill="#059669" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                <div>
                  <p className="text-xs font-semibold mb-2">Ledger history</p>
                  <div className="rounded-xl border border-border/80 overflow-hidden">
                    <table className="w-full text-[11px]">
                      <thead className="bg-muted/50">
                        <tr className="text-left">
                          <th className="p-2.5 font-semibold">Date</th>
                          <th className="p-2.5 font-semibold text-right">Opening</th>
                          <th className="p-2.5 font-semibold text-right">Charges</th>
                          <th className="p-2.5 font-semibold text-right">Deducted</th>
                          <th className="p-2.5 font-semibold text-right">Closing</th>
                          <th className="p-2.5 font-semibold">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...rows].reverse().map((r, i) => (
                          <tr key={i} className="border-t border-border/60 hover:bg-muted/20">
                            <td className="p-2.5 whitespace-nowrap tabular-nums">{format(new Date(r.date), 'MMM d')}</td>
                            <td className="p-2.5 text-right tabular-nums">{formatUGX(num(r.opening_balance))}</td>
                            <td className="p-2.5 text-right tabular-nums text-amber-600 dark:text-amber-400">{formatUGX(num(r.interest_accrued))}</td>
                            <td className="p-2.5 text-right tabular-nums text-emerald-600 dark:text-emerald-400 font-semibold">{formatUGX(num(r.amount_deducted))}</td>
                            <td className="p-2.5 text-right tabular-nums font-medium">{formatUGX(num(r.closing_balance))}</td>
                            <td className="p-2.5">
                              <Badge className={`text-[9px] px-1.5 py-0 h-4 border-0 capitalize ${
                                r.deduction_status === 'full' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                                : r.deduction_status === 'partial' ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
                                : 'bg-muted text-muted-foreground'}`}>
                                {r.deduction_status}
                              </Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            ) : (
              <div className="rounded-xl border border-dashed border-border/70 bg-muted/15 py-8 text-center">
                <p className="text-xs text-muted-foreground">
                  No repayment ledger activity recorded in the last 90 days.
                </p>
              </div>
            )}
          </div>
        )}

        <CancelAdvanceDialog
          advance={advanceForCancel}
          open={cancelOpen}
          onOpenChange={setCancelOpen}
          onSuccess={() => {
            setCancelOpen(false);
            onClose();
            // Refetch handled by outer react-query invalidation on next open;
            // trigger a soft reload of the advances query by dispatching event.
            window.dispatchEvent(new CustomEvent('advance-repayments-refresh'));
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/80 bg-muted/30 p-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="text-sm font-bold tabular-nums text-foreground truncate mt-0.5">{value}</p>
    </div>
  );
}
