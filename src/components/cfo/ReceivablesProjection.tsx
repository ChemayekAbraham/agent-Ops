import { useState } from 'react';
import { Wallet, CalendarDays, TrendingUp, RefreshCw } from 'lucide-react';
import { ResponsiveContainer, ComposedChart, CartesianGrid, XAxis, YAxis, Tooltip, Bar, Line } from 'recharts';
import { Button } from '@/components/ui/button';
import { RECEIVABLE_FORECAST_PERIODS, useReceivablesProjection } from '@/hooks/useReceivablesProjection';
import { formatUGX } from '@/lib/rentCalculations';

const money = (value: number | null) => value == null ? 'Unavailable' : formatUGX(value);
const compact = (value: number) => Math.abs(value) >= 1e9 ? `${(value / 1e9).toFixed(2)}B` : Math.abs(value) >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : Math.abs(value) >= 1e3 ? `${(value / 1e3).toFixed(0)}K` : value.toFixed(0);

export default function ReceivablesProjection() {
  const [id, setId] = useState('7d');
  const { period, daily, rows, historyQ, contractQ } = useReceivablesProjection(id);
  const behavior = rows.every((r) => r.behavior != null) ? rows.reduce((sum, r) => sum + (r.behavior ?? 0), 0) : null;
  const contract = rows.every((r) => r.contract != null) ? rows.reduce((sum, r) => sum + (r.contract ?? 0), 0) : null;
  const loading = historyQ.isLoading || contractQ.isLoading;
  return <>
    <div role="tablist" aria-label="Forecast period" className="inline-flex flex-wrap gap-1 rounded-lg border border-border/70 bg-card p-1">{RECEIVABLE_FORECAST_PERIODS.map((p) => <Button key={p.id} variant="ghost" size="sm" role="tab" aria-selected={id === p.id} onClick={() => setId(p.id)} className={`rounded-md text-xs ${id === p.id ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-primary hover:bg-primary/10'}`}>{p.label}</Button>)}</div>
    {loading ? <Panel><p className="text-xs text-muted-foreground">Loading forecast…</p></Panel> : historyQ.isError || contractQ.isError ? <Panel><p className="text-xs text-destructive">Forecast unavailable. Please refresh.</p><Button variant="outline" size="sm" onClick={() => { void historyQ.refetch(); void contractQ.refetch(); }}><RefreshCw />Refresh</Button></Panel> : <>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3"><Metric label="Behavior projection" value={money(behavior)} note="Based on past receivables collections" icon={Wallet} tone="primary" /><Metric label="Ideal (contract)" value={money(contract)} note="Scheduled by contract" icon={CalendarDays} tone="success" /><Metric label={daily ? 'Daily Average' : 'Monthly Average'} value={money(behavior == null ? null : behavior / rows.length)} note={`Behavior projection per ${daily ? 'day' : 'month'}`} icon={TrendingUp} tone="warning" /></div>
      <Panel title={`Receivables Projection — ${period.label}`}><div className="h-28 rounded-lg bg-primary/10 p-1"><ResponsiveContainer width="100%" height="100%"><ComposedChart data={rows} margin={{ top: 8, right: 4, left: -20, bottom: 0 }}><CartesianGrid vertical={false} stroke="hsl(var(--border))" /><XAxis dataKey="label" tick={{ fontSize: 9 }} tickLine={false} axisLine={false} /><YAxis tickFormatter={compact} tick={{ fontSize: 9 }} tickLine={false} axisLine={false} /><Tooltip formatter={(v: number) => formatUGX(v)} /><Bar dataKey="behavior" name="Behavior projection" fill="hsl(var(--primary))" maxBarSize={22} radius={[3, 3, 0, 0]} /><Line dataKey="contract" name="Ideal (contract)" stroke="hsl(var(--success))" strokeWidth={2} dot={false} /></ComposedChart></ResponsiveContainer></div></Panel>
      <Panel title={daily ? 'Day by Day' : 'Month by Month'}><div className="overflow-x-auto"><table className="w-full text-[10px]"><thead className="bg-muted/50 text-muted-foreground"><tr><th className="p-2 text-left font-medium">{daily ? 'Date' : 'Month'}</th><th className="p-2 text-right font-medium">Behavior projection (UGX)</th><th className="p-2 text-right font-medium">Ideal — contract (UGX)</th></tr></thead><tbody className="divide-y divide-border">{rows.map((r) => <tr key={r.key}><td className="p-2">{r.date}</td><td className="p-2 text-right tabular-nums">{money(r.behavior)}</td><td className="p-2 text-right tabular-nums">{money(r.contract)}</td></tr>)}</tbody><tfoot><tr className="border-t border-border font-semibold"><td className="p-2">Total</td><td className="p-2 text-right tabular-nums">{money(behavior)}</td><td className="p-2 text-right tabular-nums">{money(contract)}</td></tr></tfoot></table></div></Panel>
    </>}
  </>;
}

function Panel({ title, children }: { title?: string; children: React.ReactNode }) {
  return <section className="min-w-0 rounded-lg border border-border bg-card p-3">{title && <h2 className="mb-3 text-xs font-semibold">{title}</h2>}{children}</section>;
}
function Metric({ label, value, note, icon: Icon, tone }: { label: string; value: string; note: string; icon: typeof Wallet; tone: string }) {
  const tones: Record<string, string> = { primary: 'bg-primary/5 text-primary', success: 'bg-success/5 text-success', warning: 'bg-warning/5 text-warning' };
  return <div className={`min-w-0 rounded-lg border border-border p-2.5 ${tones[tone]}`}><div className="mb-2 flex items-center gap-2"><Icon className="h-4 w-4 shrink-0" /><span className="text-[10px] font-medium">{label}</span></div><p className="text-xs leading-5 font-semibold tabular-nums text-foreground break-words">{value}</p><p className="mt-1 text-[10px] text-muted-foreground">{note}</p></div>;
}