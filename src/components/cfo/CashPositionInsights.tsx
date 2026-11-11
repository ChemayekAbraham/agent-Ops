import { useState } from 'react';
import { cfoReportRetry } from '@/hooks/cfoReportRetry';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from 'recharts';
import {
  LineChart as LineIcon, Lightbulb, Zap, ChevronRight, FileText, Scale, Download, ShieldCheck,
  TrendingUp, TrendingDown, AlertTriangle, Info, ArrowUpRight, ArrowDownLeft
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CashPositionAccounts } from './CashPositionAccounts';
import { CashPositionBreakdowns } from './CashPositionBreakdowns';
import { CashPositionDownloadReports } from './CashPositionDownloadReports';
import type { ActualMoneyHeld } from '@/hooks/useActualMoneyHeld';
import type { PhoneMoneyLine } from '@/components/financial-ops/PhoneMoneyStatementSheet';

const fmt = (n: number) => `UGX ${Math.round(n).toLocaleString()}`;
const axisShort = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(a % 1e6 === 0 ? 0 : 1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(Math.round(n));
};
const kampalaToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kampala' }).format(new Date());

interface Props {
  receivablesReady?: boolean;
  moneyReady?: boolean;
  totalReceivables: number;
  receivablesCategories: Array<{ key: string; label: string; outstanding: number }>;
  moneyWeHave: number;
  moneyWeCanUse: number;
  moneyWeOwe: number;
  bankReconciled?: boolean;
  onNavigate?: (section: string) => void;
  accountMoney?: ActualMoneyHeld;
  accountUpdatedAt?: number;
  onSelectAccount?: (line: PhoneMoneyLine) => void;
}

function Head({ icon, title, sub, right }: { icon: React.ReactNode; title: string; sub?: string; right?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 pb-2.5 mb-3.5">
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="h-7 w-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
          {icon}
        </span>
        <div className="min-w-0">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-foreground truncate">{title}</h2>
          {sub && <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{sub}</p>}
        </div>
      </div>
      {right}
    </div>
  );
}

export function CashPositionInsights({
  totalReceivables,
  receivablesCategories,
  moneyWeHave,
  moneyWeCanUse,
  moneyWeOwe,
  bankReconciled,
  onNavigate,
  receivablesReady = true,
  moneyReady = true,
  accountMoney,
  accountUpdatedAt = 0,
  onSelectAccount,
}: Props) {
  const [days, setDays] = useState(30);
  const [reportsOpen, setReportsOpen] = useState(false);

  const flow = useQuery({
    queryKey: ['cfo-cash-flow-trend', days],
    queryFn: async () => {
      // Real money received / paid out on the Treasury card basis (moves between cash accounts cancel);
      // accounting corrections come back separately and are not shown as money received or paid.
      const { data, error } = await supabase.rpc('get_cfo_daily_cash_movement', { p_days: days });
      if (error) throw error;
      return ((data as Array<Record<string, unknown>>) || []).map((r) => {
        const inflow = Number(r.inflow) || 0;
        const outflow = Number(r.outflow) || 0;
        const corrections = Number(r.corrections) || 0;
        const dayLabel = new Date(`${String(r.day).slice(0, 10)}T00:00:00`)
          .toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        return { label: dayLabel, inflow, outflow, net: inflow - outflow, corrections };
      });
    },
    staleTime: 60_000,
  });

  const rp = useQuery({
    queryKey: ['cfo-cash-position-payables-by-source-v2'],
    retry: cfoReportRetry,
    queryFn: async () => {
      const today = kampalaToday();
      const to = new Date();
      to.setDate(to.getDate() + 30);
      const toKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kampala' }).format(to);
      const callRpc = supabase.rpc as unknown as (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: Error | null }>;
      const [{ data, error }, { data: src, error: e2 }] = await Promise.all([
        callRpc('get_payables_due_range', { p_from: today, p_to: toKey }),
        callRpc('get_payables_by_source', { p_from: today, p_to: toKey }),
      ]);
      if (error) throw error;
      if (e2) throw e2;
      const d = (data || {}) as Record<string, unknown>;
      const top = ((src as Array<Record<string, unknown>>) || []).slice(0, 5).map((r) => ({
        id: String(r.source),
        name: String(r.source),
        amount: Number(r.amount || 0),
        due_date: (r.due_date as string | null) ?? null,
        count: Number(r.count || 0),
      }));
      const all = { length: ((src as Array<Record<string, unknown>>) || []).reduce((n, r) => n + Number(r.count || 0), 0) };
      return {
        outstanding: Number(d.outstanding || 0),
        dueInRange: Number(d.due_in_range || 0),
        count: all.length,
        top,
      };
    },
    staleTime: 300_000,
    gcTime: 600_000,
    refetchOnWindowFocus: false,
  });

  const series = flow.data ?? [];
  const half = Math.floor(series.length / 2);
  const recentIn = series.slice(half).reduce((s, d) => s + d.inflow, 0);
  const priorIn = series.slice(0, half).reduce((s, d) => s + d.inflow, 0);
  const inChange = priorIn > 0 ? ((recentIn - priorIn) / priorIn) * 100 : null;
  const netAll = series.reduce((s, d) => s + d.net, 0);
  const totalInflow = series.reduce((s, d) => s + d.inflow, 0);
  const totalOutflow = series.reduce((s, d) => s + d.outflow, 0);
  const totalCorrections = series.reduce((s, d) => s + d.corrections, 0);

  const insights = [
    inChange !== null && {
      icon: inChange >= 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />,
      tone: inChange >= 0 ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
      title: `Money received is ${inChange >= 0 ? 'up' : 'down'} ${Math.abs(inChange).toFixed(0)}%`,
      sub: `${fmt(recentIn)} vs ${fmt(priorIn)} in the previous ${series.length - half} days`,
      go: 'cash-position',
    },
    {
      icon: <AlertTriangle className="h-4 w-4" />,
      tone: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
      title: 'Payables due soon',
      sub: `${rp.data?.count ?? 0} items due in 30 days, totalling ${fmt(rp.data?.dueInRange ?? 0)}`,
      go: 'withdrawals',
    },
    {
      icon: <Info className="h-4 w-4" />,
      tone: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
      title: `Net cash movement ${netAll >= 0 ? 'positive' : 'negative'}`,
      sub: `${netAll >= 0 ? '+' : ''}${fmt(netAll)} ${days === 1 ? 'today' : `over the last ${days} days`}`,
      go: 'cash-position',
    },
  ].filter(Boolean) as Array<{ icon: React.ReactNode; tone: string; title: string; sub: string; go: string }>;

  const actions: Array<{ icon: React.ReactNode; title: string; sub: string; go?: string; onClick?: () => void }> = [
    { icon: <FileText className="h-4 w-4" />, title: 'View Detailed Reports', sub: 'Financial, collections, payables & more', go: 'statements' },
    { icon: <Scale className="h-4 w-4" />, title: 'Reconcile Accounts', sub: 'Check balances and resolve discrepancies', go: 'reconciliation' },
    { icon: <Download className="h-4 w-4" />, title: 'Money Reports', sub: 'Payout & received reports with breakdown', onClick: () => setReportsOpen(true) },
    { icon: <ShieldCheck className="h-4 w-4" />, title: 'Audit Log', sub: 'View recent approvals history', go: 'approval-audit' },
  ];

  return (
    <div className="cash-insights-layout space-y-5">
      {/* Treasury & Banking Accounts */}
      {onSelectAccount && (
        <CashPositionAccounts
          money={accountMoney}
          updatedAt={accountUpdatedAt}
          onSelect={onSelectAccount}
        />
      )}

      {/* Row 1: Flow Trend Chart & Breakdowns */}
      <div className="cash-analysis-primary space-y-5">
        <Card className="cash-flow-chart rounded-xl border border-border/80 bg-card shadow-xs min-w-0">
          <CardContent className="p-4">
            <Head
              icon={<LineIcon className="h-4 w-4" />}
              title="Cash Flow & Net Movement"
              sub="Money received, money paid out and net liquidity velocity"
              right={
                <select
                  value={days}
                  onChange={(e) => setDays(Number(e.target.value))}
                  className="h-8 rounded-lg border border-border/80 bg-muted/40 px-3 text-xs font-medium text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary cursor-pointer shadow-2xs"
                >
                  <option value={1}>Today</option>
                  <option value={7}>Last 7 days</option>
                  <option value={30}>Last 30 days</option>
                  <option value={90}>Last 90 days</option>
                </select>
              }
            />

            <div className="h-72 w-full pt-1">
              {flow.isLoading ? (
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                  Loading flow trend…
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart
                    data={series}
                    margin={{ left: 0, right: 8, top: 4, bottom: 4 }}
                    barCategoryGap="22%"
                    barGap={4}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                      minTickGap={24}
                      tickLine={false}
                      axisLine={{ stroke: 'hsl(var(--border))' }}
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                      width={48}
                      tickFormatter={axisShort}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip formatter={(v: number) => fmt(v)} cursor={{ fill: 'hsl(var(--muted) / 0.4)' }} />
                    <Legend
                      verticalAlign="top"
                      align="right"
                      iconType="circle"
                      iconSize={8}
                      wrapperStyle={{ fontSize: 11, paddingBottom: 10 }}
                    />
                    <Bar
                      dataKey="inflow"
                      name="Money Received"
                      fill="#10b981"
                      radius={[3, 3, 0, 0]}
                      maxBarSize={32}
                    />
                    <Bar
                      dataKey="outflow"
                      name="Money Paid Out"
                      fill="#f43f5e"
                      radius={[3, 3, 0, 0]}
                      maxBarSize={32}
                    />
                    <Line
                      type="monotone"
                      dataKey="net"
                      name="Net Movement"
                      stroke="#3b82f6"
                      strokeWidth={2.5}
                      dot={{ r: 3, fill: '#3b82f6', strokeWidth: 0 }}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </div>

            {/* Velocity Summary Strip */}
            <div className="mt-3.5 grid grid-cols-3 gap-2.5 border-t border-border/40 pt-3 text-xs">
              <div className="rounded-lg bg-emerald-500/5 border border-emerald-500/20 p-2.5">
                <span className="text-[10px] uppercase font-semibold text-emerald-600 dark:text-emerald-400 block">
                  Total Received
                </span>
                <span className="text-xs sm:text-sm font-bold tabular-nums text-foreground mt-0.5 block">
                  {fmt(totalInflow)}
                </span>
              </div>
              <div className="rounded-lg bg-rose-500/5 border border-rose-500/20 p-2.5">
                <span className="text-[10px] uppercase font-semibold text-rose-600 dark:text-rose-400 block">
                  Total Paid Out
                </span>
                <span className="text-xs sm:text-sm font-bold tabular-nums text-foreground mt-0.5 block">
                  {fmt(totalOutflow)}
                </span>
              </div>
              <div className="rounded-lg bg-blue-500/5 border border-blue-500/20 p-2.5">
                <span className="text-[10px] uppercase font-semibold text-blue-600 dark:text-blue-400 block">
                  Net Movement
                </span>
                <span className={`text-xs sm:text-sm font-bold tabular-nums mt-0.5 block ${netAll >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                  {netAll >= 0 ? `+${fmt(netAll)}` : fmt(netAll)}
                </span>
              </div>
            </div>
            {Math.abs(totalCorrections) >= 1 && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                Accounting corrections in this period, not money received or paid: {totalCorrections >= 0 ? `+${fmt(totalCorrections)}` : fmt(totalCorrections)}
              </p>
            )}
          </CardContent>
        </Card>

        {/* Source Breakdowns */}
        <CashPositionBreakdowns />
      </div>

      {/* Row 2: Insights & Actions */}
      <div className="cash-analysis-secondary grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Key Insights Card */}
        <Card className="cash-key-insights rounded-xl border border-border/80 bg-card shadow-xs min-w-0">
          <CardContent className="p-4">
            <Head icon={<Lightbulb className="h-4 w-4" />} title="Key Insights" sub="Automated treasury observations" />
            <div className="divide-y divide-border/40">
              {insights.map((i) => (
                <button
                  key={i.title}
                  type="button"
                  onClick={() => onNavigate?.(i.go)}
                  className="w-full flex items-center gap-3 py-3 px-1 text-left hover:bg-muted/40 rounded-lg transition-colors group"
                >
                  <span className={`h-7 w-7 rounded-lg flex items-center justify-center shrink-0 ${i.tone}`}>
                    {i.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-semibold text-foreground group-hover:text-primary transition-colors">
                      {i.title}
                    </span>
                    <span className="block text-[11px] text-muted-foreground truncate">{i.sub}</span>
                  </span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground/40 group-hover:text-primary group-hover:translate-x-0.5 transition-all shrink-0" />
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Quick Actions Card */}
        <Card className="cash-quick-actions rounded-xl border border-border/80 bg-card shadow-xs min-w-0">
          <CardContent className="p-4">
            <Head icon={<Zap className="h-4 w-4" />} title="Quick Actions" sub="Frequently used CFO tools and audits" />
            <div className="space-y-2">
              {actions.map((a) => (
                <Button
                  key={a.title}
                  variant="outline"
                  type="button"
                  onClick={() => (a.onClick ? a.onClick() : onNavigate?.(a.go!))}
                  className="w-full flex h-auto items-center gap-2.5 rounded-lg border border-border/70 p-3 text-left hover:bg-muted/50 transition-colors justify-start"
                >
                  <span className="h-7 w-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                    {a.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-semibold text-foreground">{a.title}</span>
                    <span className="block text-[10px] text-muted-foreground truncate">{a.sub}</span>
                  </span>
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <CashPositionDownloadReports open={reportsOpen} onOpenChange={setReportsOpen} />
    </div>
  );
}
