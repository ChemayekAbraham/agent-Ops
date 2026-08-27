import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { endOfMonth, endOfYear, format, startOfMonth, startOfWeek, startOfYear, subDays } from 'date-fns';
import { Download, FileBarChart, Loader2, RefreshCw } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

type Row = Record<string, any>;
interface ReportData {
  generated_at: string; timezone: string; from: string; to: string; days: number;
  overview: Row; rent: Row & { agents: Row[]; daily: Row[]; top_paying: Row[]; top_missed: Row[] };
  advances: Row & { daily: Row[]; top_paying: Row[]; top_overdue: Row[] };
  service_centres: Row & { rows: Row[] }; products: Row; performance: Row[];
}
type Preset = 'today' | 'yesterday' | '5d' | '7d' | 'weekend' | 'month' | 'year' | 'custom';
const presets: { id: Preset; label: string }[] = [
  { id: 'today', label: 'Today' }, { id: 'yesterday', label: 'Yesterday' }, { id: '5d', label: '5 days' },
  { id: '7d', label: '7 days' }, { id: 'weekend', label: 'Weekend' }, { id: 'month', label: 'Monthly' },
  { id: 'year', label: 'Yearly' }, { id: 'custom', label: 'Custom' },
];
const dateKey = (d: Date) => format(d, 'yyyy-MM-dd');
const resolvePreset = (id: Preset) => {
  const now = new Date();
  if (id === 'yesterday') { const d = subDays(now, 1); return { from: dateKey(d), to: dateKey(d) }; }
  if (id === '5d') return { from: dateKey(subDays(now, 4)), to: dateKey(now) };
  if (id === '7d') return { from: dateKey(subDays(now, 6)), to: dateKey(now) };
  if (id === 'weekend') { const start = startOfWeek(now, { weekStartsOn: 1 }); return { from: dateKey(subDays(start, 2)), to: dateKey(subDays(start, 1)) }; }
  if (id === 'month') return { from: dateKey(startOfMonth(now)), to: dateKey(endOfMonth(now) > now ? now : endOfMonth(now)) };
  if (id === 'year') return { from: dateKey(startOfYear(now)), to: dateKey(endOfYear(now) > now ? now : endOfYear(now)) };
  return { from: dateKey(now), to: dateKey(now) };
};
const n = (v: any) => Number(v) || 0;
const ugx = (v: any) => formatUGX(n(v));
const pct = (v: any) => `${n(v).toFixed(1)}%`;
const short = (v: any) => n(v) >= 1_000_000 ? `${(n(v) / 1_000_000).toFixed(1)}M` : n(v) >= 1_000 ? `${Math.round(n(v) / 1_000)}K` : String(Math.round(n(v)));

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <div className="min-w-0 rounded-lg border bg-card p-3"><p className="text-[10px] font-semibold uppercase text-muted-foreground">{label}</p><p className="mt-1 break-words text-base font-bold tabular-nums">{value}</p>{hint && <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p>}</div>;
}
function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <section className="report-page space-y-4 border-t pt-5 first:border-t-0 first:pt-0"><div><h2 className="text-lg font-bold">{title}</h2>{description && <p className="text-xs text-muted-foreground">{description}</p>}</div>{children}</section>;
}
function Table({ headers, rows }: { headers: string[]; rows: (string | number)[][] }) {
  return <div className="overflow-x-auto rounded-lg border"><table className="w-full min-w-[680px] text-xs"><thead className="bg-muted/50"><tr>{headers.map(h => <th key={h} className="whitespace-nowrap px-3 py-2 text-left font-semibold">{h}</th>)}</tr></thead><tbody className="divide-y">{rows.length ? rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={cn('px-3 py-2', j > 0 && 'tabular-nums')}>{v}</td>)}</tr>) : <tr><td colSpan={headers.length} className="p-8 text-center text-muted-foreground">No qualifying records in this period.</td></tr>}</tbody></table></div>;
}
const chartTooltip = (value: any) => ugx(value);

export function AgentOpsComprehensiveReport() {
  const initial = resolvePreset('today');
  const [preset, setPreset] = useState<Preset>('today');
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const reportQuery = useQuery({
    queryKey: ['agent-ops-comprehensive-report', from, to],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('get_agent_ops_comprehensive_report', { p_from: from, p_to: to });
      if (error) throw error;
      return data as ReportData;
    }, staleTime: 60_000, refetchInterval: 5 * 60_000, refetchOnWindowFocus: true,
  });
  const report = reportQuery.data;
  const productRows = (report?.products?.product_rows || []) as Row[];
  const productSummary = useMemo(() => {
    const map = new Map<string, Row>();
    productRows.forEach((r) => {
      const key = [r.product, r.item_name || r.brand || r.model_type].filter(Boolean).join(' · ') || 'Other product';
      const x = map.get(key) || { product: key, applications: 0, expected: 0, collected: 0, pending: 0, approved: 0, rejected: 0 };
      x.applications += 1; x.expected += n(r.value || r.total_amount); x.collected += n(r.paid);
      const status = String(r.order_status || r.payment_status || '').toLowerCase();
      if (status.includes('reject')) x.rejected += 1; else if (status.includes('pending')) x.pending += 1; else x.approved += 1;
      map.set(key, x);
    });
    return [...map.values()].sort((a, b) => b.expected - a.expected);
  }, [productRows]);
  const applyPreset = (id: Preset) => { setPreset(id); if (id !== 'custom') { const range = resolvePreset(id); setFrom(range.from); setTo(range.to); } };
  const exportPdf = () => {
    if (!report) return;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const addHeader = (section: string) => { doc.setTextColor(23, 78, 55); doc.setFontSize(18); doc.text('WELILE', 40, 42); doc.setTextColor(20, 20, 20); doc.setFontSize(13); doc.text(section, 40, 64); doc.setFontSize(8); doc.setTextColor(95); doc.text(`${from} to ${to} · Africa/Kampala · Generated ${format(new Date(report.generated_at), 'dd MMM yyyy HH:mm')}`, 40, 79); };
    const table = (head: string[], body: any[][]) => autoTable(doc, { startY: 102, head: [head], body, theme: 'grid', styles: { fontSize: 7, cellPadding: 4 }, headStyles: { fillColor: [23, 78, 55] }, margin: { left: 40, right: 40 } });
    addHeader('Agent Operations — Comprehensive Report');
    table(['Metric', 'Value'], [['All agents', report.overview.all_agents], ['Agents', report.overview.agents], ['Sub-agents', report.overview.sub_agents], ['Rent collected', ugx(report.overview.collected)], ['Active-book pending', ugx(report.overview.pending)], ['Tenants collected', report.overview.tenants_paid], ['Not collected', report.overview.tenants_not_collected]]);
    doc.addPage(); addHeader('Rent Collections'); table(['Agent', 'Collected', 'Expected', 'Missed', 'Success'], report.rent.agents.map(r => [r.agent_name, ugx(r.collected), ugx(r.expected), ugx(r.missed), pct(r.success_rate)]));
    doc.addPage(); addHeader('Agent Advances'); table(['Agent', 'Recovered', 'Outstanding', 'Missed'], [...report.advances.top_paying, ...report.advances.top_overdue].map(r => [r.agent_name, ugx(r.recovered), ugx(r.outstanding), ugx(r.missed)]));
    doc.addPage(); addHeader('Service Centers'); table(['Agents', 'Location', 'Amount', 'Receivable', 'Repaid', 'Requested'], report.service_centres.rows.map(r => [(r.agents || []).map((a: Row) => `${a.name} (${a.phone || '—'})`).join(', '), r.stationed_location || '—', ugx(r.forecast_amount || r.unit_price), ugx(r.receivable), ugx(r.repaid), format(new Date(r.created_at), 'dd MMM yyyy')]));
    doc.addPage(); addHeader('Agent Products & Services'); table(['Product', 'Applications', 'Expected', 'Collected', 'Pending', 'Approved', 'Rejected'], productSummary.map(r => [r.product, r.applications, ugx(r.expected), ugx(r.collected), r.pending, r.approved, r.rejected]));
    doc.addPage(); addHeader('Agent Performance'); table(['Rank', 'Agent', 'Collected', 'Expected', 'Success'], report.performance.map((r, i) => [i + 1, r.agent_name, ugx(r.collected), ugx(r.expected), pct(r.success_rate)]));
    const pages = doc.getNumberOfPages(); for (let i = 1; i <= pages; i += 1) { doc.setPage(i); doc.setFontSize(8); doc.setTextColor(110); doc.text(`Page ${i} of ${pages}`, 515, 815); }
    doc.save(`agent-operations-${from}-to-${to}.pdf`);
  };
  if (reportQuery.isLoading) return <div className="flex min-h-72 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /> Preparing comprehensive report…</div>;
  if (reportQuery.isError || !report) return <Card><CardContent className="p-8 text-center text-sm text-destructive">Could not load the comprehensive report. {(reportQuery.error as Error)?.message}</CardContent></Card>;
  return <div className="space-y-4">
    <Card><CardHeader className="p-4 pb-2"><div className="flex flex-wrap items-start justify-between gap-3"><div><CardTitle className="flex items-center gap-2 text-base"><FileBarChart className="h-4 w-4" /> Comprehensive Agent Operations Report</CardTitle><p className="mt-1 text-xs text-muted-foreground">Authoritative operational snapshot · {report.timezone} · refreshed every 5 minutes</p></div><div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => reportQuery.refetch()}><RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', reportQuery.isFetching && 'animate-spin')} /> Refresh</Button><Button size="sm" onClick={exportPdf}><Download className="mr-1.5 h-3.5 w-3.5" /> Export PDF</Button></div></div></CardHeader><CardContent className="space-y-3 p-4 pt-2"><div className="flex gap-1 overflow-x-auto pb-1">{presets.map(p => <Button key={p.id} size="sm" variant={preset === p.id ? 'default' : 'outline'} className="h-8 shrink-0 text-xs" onClick={() => applyPreset(p.id)}>{p.label}</Button>)}</div>{preset === 'custom' && <div className="grid max-w-md grid-cols-2 gap-2"><Input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} /><Input type="date" value={to} min={from} max={dateKey(new Date())} onChange={e => setTo(e.target.value)} /></div>}<Badge variant="secondary">{format(new Date(`${from}T12:00:00`), 'dd MMM yyyy')} – {format(new Date(`${to}T12:00:00`), 'dd MMM yyyy')}</Badge></CardContent></Card>
    <div className="space-y-8 rounded-lg border bg-background p-3 sm:p-5">
      <Section title="Overview / Summary" description="What the operating system records for the selected period."><div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-7"><Kpi label="All agents" value={String(report.overview.all_agents)} /><Kpi label="Agents" value={String(report.overview.agents)} hint="At least one rent request" /><Kpi label="Sub-agents" value={String(report.overview.sub_agents)} hint="Parent-child relationship" /><Kpi label="Rent collected" value={ugx(report.overview.collected)} /><Kpi label="Pending active book" value={ugx(report.overview.pending)} /><Kpi label="Tenants collected" value={String(report.overview.tenants_paid)} /><Kpi label="Not collected" value={String(report.overview.tenants_not_collected)} /></div></Section>
      <Section title="Rent Collections" description="Expected versus paid rent exposes partial collections and the resulting shortfall."><div className="grid grid-cols-2 gap-2 md:grid-cols-5"><Kpi label="Collected" value={ugx(report.rent.collected)} /><Kpi label="Expected" value={ugx(report.rent.expected)} /><Kpi label="Missed" value={ugx(report.rent.missed)} /><Kpi label="New requests" value={String(report.rent.new_requests)} /><Kpi label="New request volume" value={ugx(report.rent.new_request_volume)} /></div><div className="h-72"><ResponsiveContainer><BarChart data={report.rent.agents.slice(0, 20)}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="agent_name" tick={{ fontSize: 9 }} interval={0} angle={-25} height={75} /><YAxis tickFormatter={short} /><Tooltip formatter={chartTooltip} /><Legend /><Bar dataKey="expected" name="Expected" fill="hsl(var(--muted-foreground))" /><Bar dataKey="collected" name="Collected" fill="hsl(var(--primary))" /></BarChart></ResponsiveContainer></div><Table headers={['Agent','Collected','Expected','Missed','Tenants paid','Active tenants','Success']} rows={report.rent.agents.map(r => [r.agent_name,ugx(r.collected),ugx(r.expected),ugx(r.missed),r.tenants_paid,r.active_tenants,pct(r.success_rate)])} /><div><h3 className="mb-1 text-sm font-semibold">Rent Behaviour</h3><p className="mb-3 text-xs text-muted-foreground">Tracks expected rent, actual collections and the unpaid difference for each day in the period.</p><div className="h-72"><ResponsiveContainer><LineChart data={report.rent.daily}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="day" tick={{ fontSize: 10 }} /><YAxis tickFormatter={short} /><Tooltip formatter={chartTooltip} /><Legend /><Line type="monotone" dataKey="expected" name="Expected" stroke="hsl(var(--muted-foreground))" dot={false} /><Line type="monotone" dataKey="collected" name="Paid" stroke="hsl(var(--primary))" strokeWidth={2} /><Line type="monotone" dataKey="missed" name="Missed" stroke="hsl(var(--destructive))" strokeWidth={2} /></LineChart></ResponsiveContainer></div></div><div className="grid gap-4 lg:grid-cols-2"><div><h3 className="mb-2 text-sm font-semibold">Top 5 — zero/lowest missed</h3><Table headers={['Agent','Expected','Paid','Missed']} rows={report.rent.top_paying.map(r => [r.agent_name,ugx(r.expected),ugx(r.collected),ugx(r.missed)])} /></div><div><h3 className="mb-2 text-sm font-semibold">Top 5 — highest missed</h3><Table headers={['Agent','Expected','Paid','Missed']} rows={report.rent.top_missed.map(r => [r.agent_name,ugx(r.expected),ugx(r.collected),ugx(r.missed)])} /></div></div><div className="rounded-lg bg-muted/50 p-3 text-xs">Summary: {ugx(report.rent.collected)} collected against {ugx(report.rent.expected)} expected; recorded shortfall {ugx(report.rent.missed)}.</div></Section>
      <Section title="Agent Advances"><div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8"><Kpi label="Total volume" value={ugx(report.advances.total_volume)} /><Kpi label="Pending" value={String(report.advances.pending)} /><Kpi label="Approved" value={String(report.advances.approved)} /><Kpi label="Repaying" value={String(report.advances.repaying)} /><Kpi label="Overdue" value={String(report.advances.overdue)} /><Kpi label="Recovered" value={ugx(report.advances.repaid)} /><Kpi label="Agents" value={String(report.advances.agents)} /><Kpi label="Recovery rate" value={pct(report.advances.recovery_rate)} /></div><div className="h-72"><ResponsiveContainer><LineChart data={report.advances.daily}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="day" tick={{ fontSize: 10 }} /><YAxis tickFormatter={short} /><Tooltip formatter={chartTooltip} /><Legend /><Line dataKey="recovered" name="Recovered" stroke="hsl(var(--primary))" strokeWidth={2} /><Line dataKey="missed" name="Missed" stroke="hsl(var(--destructive))" strokeWidth={2} /></LineChart></ResponsiveContainer></div><div className="grid gap-4 lg:grid-cols-2"><Table headers={['Top paying agent','Recovered','Outstanding']} rows={report.advances.top_paying.map(r => [r.agent_name,ugx(r.recovered),ugx(r.outstanding)])} /><Table headers={['Overdue agent','Outstanding','Missed']} rows={report.advances.top_overdue.map(r => [r.agent_name,ugx(r.outstanding),ugx(r.missed)])} /></div></Section>
      <Section title="Service Centers"><div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-7"><Kpi label="All centers" value={String(report.service_centres.all)} /><Kpi label="Pending" value={String(report.service_centres.pending)} /><Kpi label="Approved" value={String(report.service_centres.approved)} /><Kpi label="Rejected" value={String(report.service_centres.rejected)} /><Kpi label="Approved volume" value={ugx(report.service_centres.approved_volume)} /><Kpi label="Receivables" value={ugx(report.service_centres.receivables)} /><Kpi label="Repayments" value={ugx(report.service_centres.repayments)} /></div><Table headers={['Agents','Center amount','Receivable','Repaid','Location','Requested']} rows={report.service_centres.rows.map(r => [(r.agents || []).map((a: Row) => `${a.name} · ${a.phone || '—'}`).join(', ') || '—',ugx(r.forecast_amount || r.unit_price),ugx(r.receivable),ugx(r.repaid),r.stationed_location || '—',format(new Date(r.created_at),'dd MMM yyyy')])} /></Section>
      <Section title="Agent Products & Services"><div className="grid grid-cols-2 gap-2 md:grid-cols-4"><Kpi label="Products" value={String(productSummary.length)} /><Kpi label="Applications" value={String(productSummary.reduce((s,r)=>s+r.applications,0))} /><Kpi label="Expected" value={ugx(productSummary.reduce((s,r)=>s+r.expected,0))} /><Kpi label="Collected" value={ugx(productSummary.reduce((s,r)=>s+r.collected,0))} /></div><Table headers={['Product / type','Applications','Expected','Collected','Pending','Approved','Rejected']} rows={productSummary.map(r => [r.product,r.applications,ugx(r.expected),ugx(r.collected),r.pending,r.approved,r.rejected])} /></Section>
      <Section title="Agent Performance" description="Ranks the same rent collection performance used in this report: paid against expected for the selected period."><Table headers={['Rank','Agent','Collections','Amount collected','Expected','Success rate']} rows={report.performance.map((r,i)=>[i+1,r.agent_name,r.tenants_paid,ugx(r.collected),ugx(r.expected),pct(r.success_rate)])} /></Section>
    </div>
  </div>;
}