import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { KPICard } from '@/components/executive/KPICard';
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
  active: 'bg-emerald-100 text-emerald-700',
  repaying: 'bg-emerald-100 text-emerald-700',
  overdue: 'bg-rose-100 text-rose-700',
  completed: 'bg-muted text-muted-foreground',
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
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPICard title="Active advances" value={String(stats.activeCount)} icon={Activity} color="bg-purple-100 text-purple-700" />
        <KPICard title="Outstanding (active)" value={formatUGX(stats.outstanding)} icon={CircleDollarSign} color="bg-blue-100 text-blue-700" />
        <KPICard title="Repaid (30d)" value={formatUGX(stats.repaid30)} icon={TrendingDown} color="bg-emerald-100 text-emerald-700" />
        <KPICard title="Repaid (7d)" value={formatUGX(stats.repaid7)} icon={TrendingDown} color="bg-emerald-100 text-emerald-700" />
        <KPICard title="Avg daily repayment" value={formatUGX(stats.avgDaily)} icon={Banknote} color="bg-teal-100 text-teal-700" />
        <KPICard title="Interest accrued (30d)" value={formatUGX(stats.interest30)} icon={Percent} color="bg-amber-100 text-amber-700" />
        <KPICard title="Overdue advances" value={String(stats.overdueCount)} icon={AlertTriangle} color="bg-rose-100 text-rose-700" />
        <KPICard title="Overdue outstanding" value={formatUGX(stats.overdueOutstanding)} icon={AlertTriangle} color="bg-rose-100 text-rose-700" />
      </div>

      {/* Daily repayment trend */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-primary" /> Repayment trend (last 60 days)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={dailyTrend} margin={{ left: -10, right: 8, top: 4 }}>
              <defs>
                <linearGradient id="rep" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#7c3aed" stopOpacity={0.5} />
                  <stop offset="95%" stopColor="#7c3aed" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="intr" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} interval={9} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
              <Tooltip formatter={(v: any) => formatUGX(Number(v))} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Area type="monotone" dataKey="Repaid" stroke="#7c3aed" fill="url(#rep)" strokeWidth={2} />
              <Area type="monotone" dataKey="Interest" stroke="#f59e0b" fill="url(#intr)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* Outstanding by advance */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Banknote className="h-4 w-4 text-primary" /> Top outstanding balances
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={230}>
              <BarChart data={outstandingByAdvance} margin={{ left: -6, right: 8 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
                <Tooltip formatter={(v: any) => formatUGX(Number(v))} />
                <Bar dataKey="Outstanding" radius={[4, 4, 0, 0]}>
                  {outstandingByAdvance.map((e, i) => (
                    <Cell key={i} fill={e.overdue ? '#ef4444' : '#7c3aed'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Status distribution */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Activity className="h-4 w-4 text-primary" /> Advances by status
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={230}>
              <PieChart>
                <Pie data={statusDist} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label={(e: any) => `${e.name} (${e.value})`} labelLine={false} fontSize={10}>
                  {statusDist.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Per-advance list */}
      <Card>
        <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm flex items-center gap-2">
            <History className="h-4 w-4 text-primary" /> Advance repayment tracker
          </CardTitle>
          <div className="flex gap-1">
            <Button size="sm" variant={scope === 'active' ? 'default' : 'outline'} className="h-7 text-xs" onClick={() => setScope('active')}>Active</Button>
            <Button size="sm" variant={scope === 'all' ? 'default' : 'outline'} className="h-7 text-xs" onClick={() => setScope('all')}>All</Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {list.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-6">No advances in this view.</p>
          )}
          {list.map((a) => {
            const repaid = Math.max(0, num(a.principal) - num(a.outstanding_balance));
            const pct = num(a.principal) > 0 ? Math.min(100, (repaid / num(a.principal)) * 100) : 0;
            const daysLeft = differenceInCalendarDays(new Date(a.expires_at), new Date());
            return (
              <button
                key={a.id}
                onClick={() => setSelected(a)}
                className="w-full text-left rounded-xl border border-border bg-card p-3 hover:border-primary/40 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold truncate">{nameOf(a.agent_id)}</p>
                    <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                      <CalendarClock className="h-3 w-3" />
                      {a.status === 'completed'
                        ? `Issued ${format(new Date(a.issued_at), 'MMM d')}`
                        : daysLeft >= 0 ? `${daysLeft}d left` : `${Math.abs(daysLeft)}d overdue`}
                    </p>
                  </div>
                  <Badge className={`text-[9px] px-1.5 py-0 h-4 font-bold border-0 ${STATUS_TONE[a.status] || 'bg-muted'}`}>
                    {a.status}
                  </Badge>
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                </div>
                <div className="mt-2">
                  <div className="flex justify-between text-[11px] mb-1">
                    <span className="text-muted-foreground">Repaid {formatUGX(repaid)}</span>
                    <span className="font-semibold">{pct.toFixed(0)}%</span>
                  </div>
                  <Progress value={pct} className="h-1.5" />
                  <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
                    <span>Principal {formatUGX(num(a.principal))}</span>
                    <span className="font-bold text-foreground">Outstanding {formatUGX(num(a.outstanding_balance))}</span>
                  </div>
                </div>
              </button>
            );
          })}
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
                  className="gap-1 text-destructive border-destructive/30 hover:bg-destructive/10"
                  onClick={() => setCancelOpen(true)}
                >
                  <Ban className="h-3.5 w-3.5" /> Cancel advance
                </Button>
              </div>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <MiniStat label="Principal" value={formatUGX(num(advance.principal))} />
              <MiniStat label="Outstanding" value={formatUGX(num(advance.outstanding_balance))} />
              <MiniStat label="Repaid" value={formatUGX(totalRepaid)} />
              <MiniStat label="Interest (90d)" value={formatUGX(totalInterest)} />
            </div>

            {chartData.length > 0 ? (
              <>
                <div>
                  <p className="text-xs font-semibold mb-1">Balance drawdown</p>
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

                <div>
                  <p className="text-xs font-semibold mb-1">Daily deductions</p>
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
                  <p className="text-xs font-semibold mb-1">Ledger history</p>
                  <div className="rounded-lg border border-border overflow-hidden">
                    <table className="w-full text-[11px]">
                      <thead className="bg-muted/60">
                        <tr className="text-left">
                          <th className="p-2 font-semibold">Date</th>
                          <th className="p-2 font-semibold text-right">Opening</th>
                          <th className="p-2 font-semibold text-right">Interest</th>
                          <th className="p-2 font-semibold text-right">Deducted</th>
                          <th className="p-2 font-semibold text-right">Closing</th>
                          <th className="p-2 font-semibold">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...rows].reverse().map((r, i) => (
                          <tr key={i} className="border-t border-border">
                            <td className="p-2 whitespace-nowrap">{format(new Date(r.date), 'MMM d')}</td>
                            <td className="p-2 text-right">{formatUGX(num(r.opening_balance))}</td>
                            <td className="p-2 text-right text-amber-600">{formatUGX(num(r.interest_accrued))}</td>
                            <td className="p-2 text-right text-emerald-600 font-semibold">{formatUGX(num(r.amount_deducted))}</td>
                            <td className="p-2 text-right">{formatUGX(num(r.closing_balance))}</td>
                            <td className="p-2">
                              <Badge className={`text-[8px] px-1 py-0 h-4 border-0 ${
                                r.deduction_status === 'full' ? 'bg-emerald-100 text-emerald-700'
                                : r.deduction_status === 'partial' ? 'bg-amber-100 text-amber-700'
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
              <p className="text-xs text-muted-foreground text-center py-6">
                No repayment ledger activity recorded in the last 90 days.
              </p>
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
    <div className="rounded-lg border border-border bg-muted/40 p-2">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="text-sm font-bold truncate">{value}</p>
    </div>
  );
}
