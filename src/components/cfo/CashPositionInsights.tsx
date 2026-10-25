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
  LineChart as LineIcon, Receipt, Lightbulb, Zap, ChevronRight, FileText, Scale, Download, ShieldCheck,
  TrendingUp, TrendingDown, AlertTriangle, Info, CheckCircle2, Landmark, Gauge, ArrowRight,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CashPositionAccounts } from './CashPositionAccounts';
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
const fmtDate = (d?: string | null) => {
  if (!d) return '—';
  const key = d.slice(0, 10);
  if (key === kampalaToday()) return 'Today';
  return new Date(`${key}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};
const label = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

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
    <div className="flex items-start justify-between gap-2 mb-3">
      <div className="flex items-start gap-2.5 min-w-0">
        <span className="h-8 w-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">{icon}</span>
        <div className="min-w-0">
          <p className="text-sm font-semibold truncate">{title}</p>
          {sub && <p className="text-[11px] text-muted-foreground truncate">{sub}</p>}
        </div>
      </div>
      {right}
    </div>
  );
}

export function CashPositionInsights({
  totalReceivables, receivablesCategories, moneyWeHave, moneyWeCanUse, moneyWeOwe, bankReconciled, onNavigate, receivablesReady = true, moneyReady = true, accountMoney, accountUpdatedAt = 0, onSelectAccount,
}: Props) {
  const [days, setDays] = useState(30);

  const flow = useQuery({
    queryKey: ['cfo-cash-flow-trend', days],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_cfo_daily_cash_flow', { p_days: days });
      if (error) throw error;
      return ((data as any[]) || []).map((r) => {
        const inflow = Number(r.inflow) || 0;
        const outflow = Number(r.outflow) || 0;
        const dayLabel = new Date(`${String(r.day).slice(0, 10)}T00:00:00`)
          .toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        return { label: dayLabel, inflow, outflow, net: inflow - outflow };
      });
    },
    staleTime: 60_000,
  });

  const rp = useQuery({
    queryKey: ['cfo-cash-position-payables-by-source-v2'],
    retry: cfoReportRetry,
    queryFn: async () => {
      const today = kampalaToday();
      const to = new Date(); to.setDate(to.getDate() + 30);
      const toKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kampala' }).format(to);
      // Independent reads: run them together instead of one after the other.
      const [{ data, error }, { data: src, error: e2 }] = await Promise.all([
        (supabase.rpc as any)('get_payables_due_range', { p_from: today, p_to: toKey }),
        (supabase.rpc as any)('get_payables_by_source', { p_from: today, p_to: toKey }),
      ]);
      if (error) throw error;
      if (e2) throw e2;
      const d = (data || {}) as any;
      const top = ((src || []) as any[]).slice(0, 5).map((r) => ({
        id: String(r.source), name: String(r.source), amount: Number(r.amount || 0),
        due_date: r.due_date ?? null, count: Number(r.count || 0),
      }));
      const all = { length: ((src || []) as any[]).reduce((n, r) => n + Number(r.count || 0), 0) };
      return { outstanding: Number(d.outstanding || 0), dueInRange: Number(d.due_in_range || 0), count: all.length, top };
    },
    staleTime: 300_000,
    gcTime: 600_000,
    refetchOnWindowFocus: false,
  });

  const recent = useQuery({
    queryKey: ['cfo-cash-position-recent-tx'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('general_ledger')
        .select('id, transaction_date, description, category, amount, direction')
        .eq('ledger_scope', 'platform')
        .in('classification', ['production', 'legacy_real'])
        .order('transaction_date', { ascending: false })
        .limit(5);
      if (error) throw error;
      return data || [];
    },
    staleTime: 60_000,
  });

  const payablesTotal = rp.data?.outstanding ?? 0; // receivables show immediately; payables fill in when ready
  const outstanding = totalReceivables + payablesTotal;
  const recvPct = outstanding > 0 ? (totalReceivables / outstanding) * 100 : 0;

  const topPayables = rp.data?.top ?? [];
  const topReceivables = receivablesCategories.slice().sort((a, b) => b.outstanding - a.outstanding).slice(0, 5);
  const obligationsReady = receivablesReady && !!rp.data && !rp.error;
  const liquidityCoverage = obligationsReady && moneyReady && payablesTotal > 0 ? moneyWeCanUse / payablesTotal : null;
  const netOutstanding = totalReceivables - payablesTotal;
  const obligationsShare = moneyWeHave > 0 ? (moneyWeOwe / moneyWeHave) * 100 : 0;
  const liquidityState = liquidityCoverage === null
    ? { label: !obligationsReady || !moneyReady ? 'Checking obligations' : 'No payables recorded', tone: 'text-muted-foreground', surface: 'bg-muted' }
    : liquidityCoverage >= 1
      ? { label: 'Covered', tone: 'text-success', surface: 'bg-success/10' }
      : { label: 'Attention required', tone: 'text-destructive', surface: 'bg-destructive/10' };

  const series = flow.data ?? [];
  const half = Math.floor(series.length / 2);
  const recentIn = series.slice(half).reduce((s, d) => s + d.inflow, 0);
  const priorIn = series.slice(0, half).reduce((s, d) => s + d.inflow, 0);
  const inChange = priorIn > 0 ? ((recentIn - priorIn) / priorIn) * 100 : null;
  const netAll = series.reduce((s, d) => s + d.net, 0);
  
  const insights = [
    inChange !== null && {
      icon: inChange >= 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />,
      tone: inChange >= 0 ? 'bg-success text-success-foreground' : 'bg-destructive text-destructive-foreground',
      title: `Money received is ${inChange >= 0 ? 'up' : 'down'} ${Math.abs(inChange).toFixed(0)}%`,
      sub: `${fmt(recentIn)} vs ${fmt(priorIn)} in the previous ${series.length - half} days`,
      go: 'cash-position',
    },
    {
      icon: <AlertTriangle className="h-4 w-4" />, tone: 'bg-destructive text-destructive-foreground',
      title: 'Payables due soon',
      sub: `${rp.data?.count ?? 0} items due in 30 days, totalling ${fmt(rp.data?.dueInRange ?? 0)}`,
      go: 'withdrawals',
    },
    {
      icon: <Info className="h-4 w-4" />, tone: 'bg-info text-info-foreground',
      title: `Net cash movement ${netAll >= 0 ? 'positive' : 'negative'}`,
      sub: `${netAll >= 0 ? '+' : ''}${fmt(netAll)} over the last ${days} days`,
      go: 'cash-position',
    },
  ].filter(Boolean) as Array<{ icon: React.ReactNode; tone: string; title: string; sub: string; go: string }>;

  const actions = [
    { icon: <FileText className="h-4 w-4" />, title: 'View Detailed Reports', sub: 'Financial, collections, payables & more', go: 'statements' },
    { icon: <Scale className="h-4 w-4" />, title: 'Reconcile Accounts', sub: 'Check balances and resolve discrepancies', go: 'reconciliation' },
    { icon: <Download className="h-4 w-4" />, title: 'Download Reports', sub: 'Export payout reports (PDF)', go: 'payout-reports' },
    { icon: <ShieldCheck className="h-4 w-4" />, title: 'Audit Log', sub: 'View recent approvals history', go: 'approval-audit' },
  ];

  const statusBadge = (due?: string | null) => {
    const today = kampalaToday();
    const key = due?.slice(0, 10);
    if (!key || key <= today) return <Badge variant="outline" className="border-destructive/30 bg-destructive/10 text-destructive text-[10px]">Due</Badge>;
    return <Badge variant="outline" className="border-warning/30 bg-warning/10 text-warning text-[10px]">Upcoming</Badge>;
  };

  return (
    <div className="cash-insights-layout">
      {onSelectAccount && <CashPositionAccounts money={accountMoney} updatedAt={accountUpdatedAt} onSelect={onSelectAccount} />}
      {/* Row 1 */}
      <div className="cash-analysis-primary">
        <Card className="cash-flow-chart min-w-0 rounded-md border-border/70 shadow-sm"><CardContent className="p-4">
          <Head icon={<LineIcon className="h-4 w-4" />} title="Cash Position Overview" sub="Money in, money out and net movement"
            right={
              <select value={days} onChange={(e) => setDays(Number(e.target.value))}
                className="h-9 rounded-md border border-border bg-card px-2 text-xs">
                <option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option>
              </select>
            } />
          <div className="h-72">
            {flow.isLoading ? <p className="text-xs text-muted-foreground">Loading…</p> : (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={series} margin={{ left: 0, right: 8, top: 4, bottom: 4 }} barCategoryGap="22%" barGap={4}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={24} tickLine={false} axisLine={{ stroke: 'hsl(var(--border))' }} />
                  <YAxis tick={{ fontSize: 11 }} width={44} tickFormatter={axisShort} tickLine={false} axisLine={false} />
                  <Tooltip formatter={(v: number) => fmt(v)} cursor={{ fill: 'hsl(var(--muted) / 0.4)' }} />
                  <Legend verticalAlign="top" align="right" iconType="circle" iconSize={8}
                    wrapperStyle={{ fontSize: 11, paddingBottom: 8 }} />
                  <Bar dataKey="inflow" name="Money Received" fill="hsl(var(--success))" radius={[3, 3, 0, 0]} maxBarSize={34} />
                  <Bar dataKey="outflow" name="Money Paid Out" fill="hsl(var(--warning))" radius={[3, 3, 0, 0]} maxBarSize={34} />
                  <Line type="monotone" dataKey="net" name="Net Movement" stroke="hsl(var(--primary))" strokeWidth={2.5}
                    dot={{ r: 3, fill: 'hsl(var(--primary))', strokeWidth: 0 }} />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>
        </CardContent></Card>

      </div>

      {/* Row 2 */}
      <div className="cash-analysis-secondary">

        <Card className="cash-key-insights min-w-0 rounded-md border-border/70 shadow-sm"><CardContent className="p-4">
          <Head icon={<Lightbulb className="h-4 w-4" />} title="Key Insights" />
          <div className="divide-y divide-border/60">
            {insights.map((i) => (
              <button key={i.title} type="button" onClick={() => onNavigate?.(i.go)} className="w-full flex items-center gap-3 py-2.5 text-left">
                <span className={`h-7 w-7 rounded-full flex items-center justify-center shrink-0 ${i.tone}`}>{i.icon}</span>
                <span className="min-w-0 flex-1"><span className="block text-xs font-semibold">{i.title}</span><span className="block text-[11px] text-muted-foreground truncate">{i.sub}</span></span>
                <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
              </button>
            ))}
          </div>
        </CardContent></Card>

        <Card className="cash-quick-actions min-w-0 rounded-md border-border/70 shadow-sm"><CardContent className="p-4">
          <Head icon={<Zap className="h-4 w-4" />} title="Quick Actions" />
          <div className="space-y-2">
            {actions.map((a) => (
              <Button key={a.title} variant="outline" type="button" onClick={() => onNavigate?.(a.go)}
                className="w-full flex h-auto items-center gap-2 rounded-md border border-border/70 px-2 py-2.5 text-left hover:bg-muted/50 min-h-11 whitespace-normal">
                <span className="text-primary shrink-0">{a.icon}</span>
                <span className="min-w-0 flex-1"><span className="block text-xs font-semibold">{a.title}</span><span className="block text-[11px] text-muted-foreground truncate">{a.sub}</span></span>
                <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
              </Button>
            ))}
          </div>
        </CardContent></Card>
      </div>
    </div>
  );
}
