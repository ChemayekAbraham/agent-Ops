import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, PieChart, Pie, Cell,
} from 'recharts';
import {
  LineChart as LineIcon, Receipt, Lightbulb, Zap, ChevronRight, FileText, Scale, Download, ShieldCheck,
  TrendingUp, TrendingDown, AlertTriangle, Info, CheckCircle2,
} from 'lucide-react';

const fmt = (n: number) => `UGX ${Math.round(n).toLocaleString()}`;
const short = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
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
  totalReceivables: number;
  receivablesCategories: Array<{ key: string; label: string; outstanding: number }>;
  onNavigate?: (section: string) => void;
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

export function CashPositionInsights({ totalReceivables, receivablesCategories, onNavigate }: Props) {
  const [days, setDays] = useState(30);

  const flow = useQuery({
    queryKey: ['cfo-cash-flow-trend', days],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_cfo_daily_cash_flow', { p_days: days });
      if (error) throw error;
      return ((data as any[]) || []).map((r) => {
        const inflow = Number(r.inflow) || 0;
        const outflow = Number(r.outflow) || 0;
        return { label: String(r.day).slice(5, 10), inflow, outflow, net: inflow - outflow };
      });
    },
    staleTime: 60_000,
  });

  const rp = useQuery({
    queryKey: ['cfo-cash-position-payables-by-source-v2'],
    queryFn: async () => {
      const today = kampalaToday();
      const to = new Date(); to.setDate(to.getDate() + 30);
      const toKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kampala' }).format(to);
      const { data, error } = await (supabase.rpc as any)('get_payables_due_range', { p_from: today, p_to: toKey });
      if (error) throw error;
      const d = (data || {}) as any;
      const { data: src, error: e2 } = await (supabase.rpc as any)('get_payables_by_source', { p_from: today, p_to: toKey });
      if (e2) throw e2;
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
  const pie = [
    { name: 'Receivables', value: totalReceivables, color: 'hsl(var(--success))' },
    { name: 'Payables', value: payablesTotal, color: 'hsl(var(--destructive))' },
  ];

  const topPayables = rp.data?.top ?? [];
  const topReceivables = receivablesCategories.slice().sort((a, b) => b.outstanding - a.outstanding).slice(0, 5);

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
    <div className="space-y-3">
      {/* Row 1 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-[1.4fr_1fr_1.1fr_1.1fr] gap-3">
        <Card className="rounded-xl shadow-sm min-w-0"><CardContent className="p-4">
          <Head icon={<LineIcon className="h-4 w-4" />} title="Cash Flow Trend" sub="Money in, money out and net movement"
            right={
              <select value={days} onChange={(e) => setDays(Number(e.target.value))}
                className="h-8 rounded-md border border-border bg-card px-2 text-xs">
                <option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option>
              </select>
            } />
          <div className="h-56">
            {flow.isLoading ? <p className="text-xs text-muted-foreground">Loading…</p> : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={series} margin={{ left: 0, right: 8, top: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} minTickGap={20} />
                  <YAxis tick={{ fontSize: 10 }} width={44} tickFormatter={short} />
                  <Tooltip formatter={(v: number) => fmt(v)} />
                  <Area type="monotone" dataKey="inflow" name="Money Received" stroke="hsl(var(--success))" fill="hsl(var(--success) / 0.12)" />
                  <Area type="monotone" dataKey="outflow" name="Money Paid Out" stroke="hsl(var(--destructive))" fill="hsl(var(--destructive) / 0.08)" />
                  <Area type="monotone" dataKey="net" name="Net Movement" stroke="hsl(var(--info))" fill="hsl(var(--info) / 0.08)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
          <div className="flex flex-wrap justify-center gap-4 text-[11px] mt-2">
            <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-success" />Money Received</span>
            <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-destructive" />Money Paid Out</span>
            <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-info" />Net Movement</span>
          </div>
        </CardContent></Card>

        <Card className="rounded-xl shadow-sm min-w-0"><CardContent className="p-4">
          <Head icon={<Scale className="h-4 w-4" />} title="Receivables vs Payables" sub="Outstanding amounts" />
          {outstanding <= 0 && rp.isLoading ? <p className="text-xs text-muted-foreground animate-pulse">Loading…</p> : outstanding <= 0 ? (
            <p className="text-xs text-muted-foreground">No data yet.</p>
          ) : (
            <div className="flex flex-col sm:flex-row 2xl:flex-col items-center gap-3">
              <div className="relative h-44 w-44 shrink-0">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart><Pie data={pie} dataKey="value" innerRadius={58} outerRadius={78} startAngle={90} endAngle={-270} stroke="none">
                    {pie.map((p) => <Cell key={p.name} fill={p.color} />)}
                  </Pie><Tooltip formatter={(v: number) => fmt(v)} /></PieChart>
                </ResponsiveContainer>
                <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none">
                  <span className="text-[10px] text-muted-foreground">Total Outstanding</span>
                  <span className="text-xs font-bold tabular-nums">{fmt(outstanding)}</span>
                </div>
              </div>
              <div className="space-y-3 text-xs">
                <div><p className="flex items-center gap-1.5 text-muted-foreground"><i className="h-2 w-2 rounded-full bg-success" />Receivables</p>
                  <p className="font-bold tabular-nums">{fmt(totalReceivables)}</p><p className="text-muted-foreground">{recvPct.toFixed(1)}%</p></div>
                <div><p className="flex items-center gap-1.5 text-muted-foreground"><i className="h-2 w-2 rounded-full bg-destructive" />Payables</p>
                  <p className="font-bold tabular-nums">{fmt(payablesTotal)}</p><p className="text-muted-foreground">{(100 - recvPct).toFixed(1)}%</p></div>
              </div>
            </div>
          )}
        </CardContent></Card>

        <Card className="rounded-xl shadow-sm min-w-0"><CardContent className="p-4">
          <Head icon={<Receipt className="h-4 w-4" />} title="Top 5 Payables" sub="Largest sources due now or within 30 days"
            right={onNavigate && <button className="text-xs font-medium text-primary" onClick={() => onNavigate('withdrawals')}>View All</button>} />
          {topPayables.length === 0 ? <p className="text-xs text-muted-foreground">{rp.isLoading ? 'Loading…' : 'No data yet.'}</p> : (
            <div className="overflow-x-auto"><table className="w-full text-[11px]">
              <thead className="text-muted-foreground"><tr className="text-left"><th className="py-1.5 font-medium">Source</th><th className="font-medium">Amount</th><th className="font-medium">Next Due</th><th className="font-medium">Status</th></tr></thead>
              <tbody>{topPayables.map((p) => (
                <tr key={p.id} className="border-t border-border/60">
                  <td className="py-2 pr-2 max-w-[160px] truncate">{p.name}<span className="block text-[10px] text-muted-foreground truncate">{p.count} payment{p.count === 1 ? '' : 's'}</span></td>
                  <td className="pr-2 tabular-nums whitespace-nowrap">{fmt(p.amount)}</td>
                  <td className="pr-2 whitespace-nowrap">{fmtDate(p.due_date)}</td>
                  <td>{statusBadge(p.due_date)}</td>
                </tr>))}</tbody>
            </table></div>
          )}
        </CardContent></Card>

        <Card className="rounded-xl shadow-sm min-w-0"><CardContent className="p-4">
          <Head icon={<Receipt className="h-4 w-4" />} title="Top 5 Receivables" sub="Largest outstanding sources"
            right={onNavigate && <button className="text-xs font-medium text-primary" onClick={() => onNavigate('reconciliation')}>View All</button>} />
          {topReceivables.length === 0 ? <p className="text-xs text-muted-foreground">No data yet.</p> : (
            <div className="overflow-x-auto"><table className="w-full text-[11px]">
              <thead className="text-muted-foreground"><tr className="text-left"><th className="py-1.5 font-medium">Source</th><th className="font-medium">Amount</th><th className="font-medium">Share</th><th className="font-medium">Status</th></tr></thead>
              <tbody>{topReceivables.map((r) => (
                <tr key={r.key} className="border-t border-border/60">
                  <td className="py-2 pr-2 max-w-[130px] truncate">{r.label}</td>
                  <td className="pr-2 tabular-nums whitespace-nowrap">{fmt(r.outstanding)}</td>
                  <td className="pr-2">{totalReceivables > 0 ? `${((r.outstanding / totalReceivables) * 100).toFixed(1)}%` : '—'}</td>
                  <td><Badge variant="outline" className="border-success/30 bg-success/10 text-success text-[10px]">Outstanding</Badge></td>
                </tr>))}</tbody>
            </table></div>
          )}
        </CardContent></Card>
      </div>

      {/* Row 2 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-[1.8fr_1fr_1fr] gap-3">
        <Card className="rounded-xl shadow-sm min-w-0 lg:col-span-2 2xl:col-span-1"><CardContent className="p-4">
          <Head icon={<Receipt className="h-4 w-4" />} title="Recent Transactions" sub="Latest financial activity"
            right={onNavigate && <button className="text-xs font-medium text-primary" onClick={() => onNavigate('ledger')}>View All</button>} />
          {(recent.data ?? []).length === 0 ? <p className="text-xs text-muted-foreground">{recent.isLoading ? 'Loading…' : 'No data yet.'}</p> : (
            <div className="overflow-x-auto"><table className="w-full text-[11px]">
              <thead className="text-muted-foreground"><tr className="text-left"><th className="py-1.5 font-medium">Date & Time</th><th className="font-medium">Description</th><th className="font-medium">Category</th><th className="font-medium">Amount</th><th className="font-medium">Status</th></tr></thead>
              <tbody>{(recent.data ?? []).map((t: any) => (
                <tr key={t.id} className="border-t border-border/60">
                  <td className="py-2 pr-2 whitespace-nowrap">{new Date(t.transaction_date).toLocaleString('en-GB', { timeZone: 'Africa/Kampala', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                  <td className="pr-2 max-w-[220px] truncate">{t.description || label(t.category)}</td>
                  <td className="pr-2 whitespace-nowrap">{label(t.category)}</td>
                  <td className={`pr-2 tabular-nums whitespace-nowrap ${t.direction === 'cash_in' ? 'text-success' : 'text-destructive'}`}>{t.direction === 'cash_in' ? '+' : '−'}{fmt(Number(t.amount))}</td>
                  <td><Badge variant="outline" className="border-success/30 bg-success/10 text-success text-[10px]">Posted</Badge></td>
                </tr>))}</tbody>
            </table></div>
          )}
        </CardContent></Card>

        <Card className="rounded-xl shadow-sm min-w-0"><CardContent className="p-4">
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

        <Card className="rounded-xl shadow-sm min-w-0"><CardContent className="p-4">
          <Head icon={<Zap className="h-4 w-4" />} title="Quick Actions" />
          <div className="space-y-2">
            {actions.map((a) => (
              <button key={a.title} type="button" onClick={() => onNavigate?.(a.go)}
                className="w-full flex items-center gap-3 rounded-lg border border-border/70 px-3 py-2.5 text-left hover:bg-muted/50 min-h-11">
                <span className="text-primary shrink-0">{a.icon}</span>
                <span className="min-w-0 flex-1"><span className="block text-xs font-semibold">{a.title}</span><span className="block text-[11px] text-muted-foreground truncate">{a.sub}</span></span>
                <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
              </button>
            ))}
          </div>
        </CardContent></Card>
      </div>
    </div>
  );
}
