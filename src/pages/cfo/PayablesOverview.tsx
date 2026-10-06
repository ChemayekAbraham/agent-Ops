import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, LayoutGrid, Search, RefreshCw, ChevronRight, TrendingDown, Wallet, Users, CalendarDays, AlertTriangle, CheckCircle2, Handshake, Building2, Package, Layers } from 'lucide-react';
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip, ComposedChart, CartesianGrid, XAxis, YAxis, Bar, Line } from 'recharts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { usePayablesTotal, usePayablesBreakdown, usePayablesPredictiveForecast, usePayablesContractSchedule, type PayableProduct, type PayableItem } from '@/hooks/usePayables';
import { formatUGX } from '@/lib/rentCalculations';

const COLORS = ['success', 'primary', 'warning', 'destructive', 'muted-foreground', 'receivable-rnd'].map((tone) => `hsl(var(--${tone}))`);
const ICONS = [Handshake, Building2, Wallet, Users, Layers, Package];
const TONES = ['bg-success/10 text-success', 'bg-primary/10 text-primary', 'bg-warning/10 text-warning', 'bg-destructive/10 text-destructive', 'bg-muted text-muted-foreground'];
const money = (value: number | null | undefined) => value == null ? 'Unavailable' : formatUGX(value);
const compact = (value: number) => Math.abs(value) >= 1e9 ? `${(value / 1e9).toFixed(2)}B` : Math.abs(value) >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : Math.abs(value) >= 1e3 ? `${(value / 1e3).toFixed(0)}K` : value.toFixed(0);

/** Read-only payable workspace; totals and forecasts retain their existing authoritative sources. */
export default function PayablesOverview() {
  const [search, setSearch] = useState('');
  const [params, setParams] = useSearchParams();
  const total = usePayablesTotal();
  const breakdown = usePayablesBreakdown();
  const forecast = usePayablesPredictiveForecast('day', 7);
  const cats = breakdown.data?.categories ?? [];
  const catKey = params.get('cat') ?? 'overview';
  const cat = cats.find((c) => c.key === catKey);
  const product = cat?.products.find((p) => p.key === params.get('sub')) ?? cat?.products[0];
  const go = (key: string, sub?: string) => {
    const next = new URLSearchParams();
    if (key !== 'overview') next.set('cat', key);
    if (sub) next.set('sub', sub);
    setParams(next, { replace: true });
  };
  const validation = breakdown.data?.validation;
  const periods = forecast.data?.periods;
  const expected = periods?.reduce((sum, p) => sum + p.forecast_amount, 0);
  const scheduled = periods?.reduce((sum, p) => sum + p.scheduled_amount, 0);
  const chart = periods?.map((p) => ({ label: p.label, amount: p.forecast_amount, scheduled: p.scheduled_amount })) ?? [];
  const allItems = cats.flatMap((c) => c.products.flatMap((p) => p.items));
  const complete = !!breakdown.data && cats.every((c) => c.products.every((p) => p.items.length === p.item_count));
  const items = [...allItems].sort((a, b) => b.amount - a.amount).slice(0, 6);
  const refreshing = total.isFetching || breakdown.isFetching || forecast.isFetching;
  const refresh = () => { void total.refetch(); void breakdown.refetch(); void forecast.refetch(); };

  return (
    <main className="receivables-workspace min-h-screen bg-background">
      <div className="border-b border-border bg-card lg:fixed lg:inset-x-0 lg:top-0 lg:z-30 flex h-14 items-center">
        <Link to="/cfo/dashboard" className="hidden h-full w-[190px] shrink-0 items-center gap-2 border-r border-border px-4 text-base font-semibold lg:flex"><TrendingDown className="h-5 w-5 text-primary" />Welile CFO</Link>
        <div className="relative mx-4 w-full max-w-lg"><Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><Input aria-label="Search payable categories" placeholder="Search categories…" value={search} onChange={(e) => setSearch(e.target.value)} className="h-9 min-h-0 rounded-full bg-muted/40 pl-9 text-xs" /></div>
        <span className="ml-auto hidden px-5 text-xs text-muted-foreground sm:block">CFO</span>
      </div>
      <div className="lg:pt-14 grid grid-cols-1 lg:grid-cols-[190px_minmax(0,1fr)]">
        <nav aria-label="Payable categories" className="border-r border-border bg-card px-2 py-4 flex flex-col lg:fixed lg:bottom-0 lg:left-0 lg:top-14 lg:w-[190px] lg:overflow-y-auto">
          <p className="px-3 pb-3 text-[10px] text-muted-foreground">CFO</p>
          <Button asChild variant="ghost" className="mb-2 h-9 justify-start px-3 text-xs"><Link to="/cfo/dashboard"><ArrowLeft />Back</Link></Button>
          <SideItem active={catKey === 'overview'} icon={LayoutGrid} label="Overview" onClick={() => go('overview')} />
          {cats.map((c, i) => <SideItem key={c.key} active={catKey === c.key} icon={ICONS[i % ICONS.length]} label={c.label} onClick={() => go(c.key)} />)}
          <div className="my-3 border-t border-border/60" />
          <SideItem active={catKey === 'daily'} icon={TrendingDown} label="Forecast" onClick={() => go('daily')} />
        </nav>
        <div className="min-w-0 px-4 py-5 lg:col-start-2">
          {cat && <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground"><Button variant="link" className="h-auto min-h-0 p-0 text-[10px]" onClick={() => go('overview')}>Payables</Button><ChevronRight className="h-3 w-3" /><span>{cat.label}</span>{product && <><ChevronRight className="h-3 w-3" /><span>{product.label}</span></>}</div>}
          <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div><h1 className="text-xl font-semibold">{cat?.label ?? (catKey === 'daily' ? 'Forecast' : 'Payables Overview')}</h1><p className="mt-1 text-xs text-muted-foreground">Outstanding obligations, payment schedules and expected payouts.</p></div>
            <div className="flex flex-wrap items-center gap-3"><span className="text-[10px] text-muted-foreground">Last updated · {breakdown.data?.as_at?.slice(0, 10) ?? '—'} · EAT</span><Button variant="outline" size="sm" className="rounded-md text-primary hover:text-primary" disabled={refreshing} onClick={refresh}><RefreshCw className={refreshing ? 'animate-spin' : ''} />Refresh</Button></div>
          </header>
          <div className="flex flex-col gap-3 min-w-0">
            {validation && <p className={`flex items-center gap-1.5 text-[10px] ${validation.ties_out ? 'text-success' : 'text-destructive'}`}>{validation.ties_out ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> : <AlertTriangle className="h-3.5 w-3.5 shrink-0" />}{validation.ties_out ? 'Categories tie out exactly to the authoritative total.' : `Category total differs by ${formatUGX(validation.difference)}. No figure has been adjusted to force a match.`}</p>}
            {catKey === 'daily' ? <DailyForecast /> : breakdown.isLoading ? <Panel><p className="text-xs text-muted-foreground">Loading live payables…</p></Panel> : breakdown.isError || total.isError ? <Panel><p className="text-xs text-destructive">Could not load payables. Please refresh.</p></Panel> : cat ? <>
              {cat.products.length ? <><div role="tablist" aria-label="Payable products" className="inline-flex flex-wrap gap-1 rounded-lg border border-border/70 bg-card p-1">{cat.products.map((p) => <Button key={p.key} variant="ghost" size="sm" role="tab" aria-selected={product?.key === p.key} onClick={() => go(cat.key, p.key)} className={`rounded-md whitespace-normal text-xs ${product?.key === p.key ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-primary hover:bg-primary/10'}`}>{p.label}</Button>)}</div>{product && <ProductDetail product={product} />}</> : <Panel><p className="text-xs text-muted-foreground">No open payables in this category.</p></Panel>}
            </> : <>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
                <Metric label="Total Payables" value={money(total.data?.total)} note="Outstanding obligations" icon={Wallet} tone="primary" />
                <Metric label="Current" value={money(forecast.data?.actual.not_yet_due)} note="Not yet due" icon={CheckCircle2} tone="success" />
                <Metric label="Overdue" value={money(total.data?.overdue)} note="Past due date" icon={AlertTriangle} tone="destructive" />
                <Metric label="Due in 7 Days" value={money(scheduled)} note="Scheduled portion of forecast" icon={CalendarDays} tone="primary" />
                <Metric label="Due Today" value={money(total.data?.due_today)} note="Obligations due today" icon={CalendarDays} tone="warning" />
                <Metric label="Accounts Payable" value={total.data?.item_count.toLocaleString() ?? 'Unavailable'} note="Open payable items" icon={Users} tone="primary" />
              </div>
              <div className="grid gap-3 xl:grid-cols-[1.4fr_1.2fr_1fr] [&>*]:min-w-0">
                <Panel title="Payables by Category">
                  <div className="overflow-x-auto"><table className="w-full text-[10px]"><thead className="bg-muted/50 text-muted-foreground"><tr><th className="p-1 text-left font-medium">Category</th><th className="p-1 text-right font-medium">Items</th><th className="p-1 text-right font-medium">Outstanding (UGX)</th><th className="p-1 text-right font-medium">Share</th></tr></thead><tbody className="divide-y divide-border">{cats.filter((c) => c.label.toLowerCase().includes(search.toLowerCase())).map((c, i) => {
                    const Icon = ICONS[i % ICONS.length];
                    return <tr key={c.key} className="hover:bg-muted/40"><td className="py-2 pr-1"><Button variant="ghost" className="h-auto min-h-0 justify-start whitespace-normal gap-1 px-0 py-1 text-left text-[9px]" onClick={() => go(c.key)}><span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${TONES[i % TONES.length]}`}><Icon /></span>{c.label}<ChevronRight /></Button></td><td className="p-1 text-right tabular-nums">{c.item_count.toLocaleString()}</td><td className="p-1 text-right tabular-nums whitespace-nowrap">{formatUGX(c.outstanding).replace(/^UGX\s*/, '')}</td><td className="p-1 text-right tabular-nums">{breakdown.data?.total ? (c.outstanding / breakdown.data.total * 100).toFixed(1) : '0'}%</td></tr>;
                  })}</tbody></table></div>
                </Panel>
                <div className="grid content-start gap-3">
                  <Panel title="Payables by Category"><Distribution data={cats.map((c) => ({ label: c.label, amount: c.outstanding }))} total={breakdown.data?.total ?? 0} /></Panel>
                  <Panel title="7-Day Payables Forecast"><div className="mb-2 flex flex-wrap gap-3 text-[10px] text-muted-foreground"><span>Expected payouts (estimated)</span><span>Scheduled portion</span></div><ForecastChart rows={chart} />{forecast.isError && <p className="mt-2 text-[10px] text-destructive">Forecast unavailable. Please refresh.</p>}{periods?.some((p) => p.quality === 'low' || p.quality === 'insufficient') && <p className="mt-2 text-[10px] text-muted-foreground">Limited history; estimates include low-confidence periods.</p>}<Button variant="link" size="sm" className="h-auto min-h-0 px-0 pt-2 text-[10px]" onClick={() => go('daily')}>Open forecast <ChevronRight /></Button></Panel>
                </div>
                <div className="grid content-start gap-3">
                  <Panel title="Payment Outlook (Next 7 Days)"><Outlook label="Expected Payouts (est.)" value={money(expected)} /><Outlook label="Scheduled Portion" value={money(scheduled)} /><Outlook label="Unscheduled Obligations" value={money(forecast.data?.unscheduled?.amount)} />{forecast.data?.unscheduled && <p className="mt-2 text-[10px] text-muted-foreground">Included in total payables; excluded from the dated forecast.</p>}</Panel>
                  <Panel title="Top Outstanding Obligations"><p className="mb-2 text-[10px] text-muted-foreground">{complete ? 'All recorded obligations' : 'Largest items in the available account sample'}</p><ItemTable items={items} /></Panel>
                </div>
              </div>
              <Panel title="Payables Risk"><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Overdue Balance" value={money(total.data?.overdue)} note="Past due date" icon={AlertTriangle} tone="destructive" /><Metric label="Due Today" value={money(total.data?.due_today)} note="Scheduled obligations" icon={CalendarDays} tone="warning" /><Metric label="Unscheduled Obligations" value={money(forecast.data?.unscheduled?.amount)} note="No contractual due date" icon={Wallet} tone="primary" /><Metric label="Category Reconciliation" value={validation ? validation.ties_out ? 'Matched' : 'Discrepancy' : 'Unavailable'} note="Compared with authoritative total" icon={CheckCircle2} tone={validation?.ties_out ? 'success' : 'destructive'} /></div></Panel>
            </>}
          </div>
        </div>
      </div>
    </main>
  );
}

function ProductDetail({ product }: { product: PayableProduct }) {
  return <>
    <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
      <Metric label="Outstanding" value={formatUGX(product.outstanding)} note="Recorded payable balance" icon={Wallet} tone="primary" />
      <Metric label="Accounts" value={product.item_count.toLocaleString()} note="Open obligations" icon={Users} tone="primary" />
      <Metric label="Scheduled" value={formatUGX(product.scheduled_amount)} note="Scheduled payable amount" icon={CalendarDays} tone="success" />
      <Metric label="Projected" value={formatUGX(product.projected_amount)} note="Projected payable amount" icon={TrendingDown} tone="warning" />
      <Metric label="Available Items" value={product.items.length.toLocaleString()} note={product.items.length === product.item_count ? 'Complete account list' : `Sample of ${product.item_count} items`} icon={Layers} tone="primary" />
      <Metric label="Payment Source" value={product.source.replace(/_/g, ' ')} note="Recorded source" icon={Building2} tone="primary" />
    </div>
    <div className="grid gap-3 xl:grid-cols-[1.4fr_1.2fr_1fr] [&>*]:min-w-0">
      <Panel title="Top Accounts"><ItemTable items={product.items} />{product.items.length < product.item_count && <p className="mt-2 text-[10px] text-muted-foreground">Showing largest {product.items.length} of {product.item_count} items.</p>}</Panel>
      <Panel title="Payment Schedule"><Distribution data={[{ label: 'Scheduled', amount: product.scheduled_amount }, { label: 'Projected', amount: product.projected_amount }]} total={product.scheduled_amount + product.projected_amount} /></Panel>
      <Panel title="Key Metrics"><Outlook label="Outstanding" value={formatUGX(product.outstanding)} /><Outlook label="Scheduled" value={formatUGX(product.scheduled_amount)} /><Outlook label="Projected" value={formatUGX(product.projected_amount)} /><Outlook label="Open Obligations" value={product.item_count.toLocaleString()} /></Panel>
    </div>
    <Panel title="Upcoming Due Dates"><ItemTable items={[...product.items].filter((i) => i.due_date).sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? '')).slice(0, 8)} /></Panel>
  </>;
}

const FORECAST_PERIODS = [
  { id: '7d', label: 'Next 7 days', gran: 'day' as const, n: 7 },
  { id: '14d', label: 'Next 14 days', gran: 'day' as const, n: 14 },
  { id: '30d', label: 'Next 30 days', gran: 'day' as const, n: 30 },
  { id: '60d', label: 'Next 60 days', gran: 'day' as const, n: 60 },
  { id: '90d', label: 'Next 90 days', gran: 'day' as const, n: 90 },
  { id: '1y', label: 'Next 1 year', gran: 'month' as const, n: 12 },
  { id: '2y', label: 'Next 2 years', gran: 'month' as const, n: 24 },
  { id: '3y', label: 'Next 3 years', gran: 'month' as const, n: 36 },
  { id: '4y', label: 'Next 4 years', gran: 'month' as const, n: 48 },
  { id: '5y', label: 'Next 5 years', gran: 'month' as const, n: 60 },
];

function DailyForecast() {
  const [pid, setPid] = useState('7d');
  const period = FORECAST_PERIODS.find((p) => p.id === pid) ?? FORECAST_PERIODS[0];
  const daily = period.gran === 'day';
  const q = usePayablesPredictiveForecast(period.gran, period.n);
  const contractQ = usePayablesContractSchedule(period.gran, period.n);
  const history = q.data?.history ?? [];
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const overall = avg(history.map((x) => x.actual_amount));
  const contractMap = new Map((contractQ.data ?? []).map((c) => [c.index, Number(c.contract_amount ?? 0)]));
  const rows = (q.data?.periods ?? []).map((p) => {
    const dow = new Date(p.period_start).getUTCDay();
    const same = daily ? history.filter((x) => new Date(x.period_start).getUTCDay() === dow).map((x) => x.actual_amount) : [];
    return { key: p.period_start, date: daily ? p.period_start.slice(0, 10) : p.label, label: p.label, behavior: Math.round(same.length ? avg(same) : overall), contract: contractMap.get(p.index) ?? 0 };
  });
  const sum = rows.reduce((a, r) => a + r.behavior, 0);
  const sched = rows.reduce((a, r) => a + r.contract, 0);
  const unit = daily ? 'day' : 'month';
  return <>
    <div role="tablist" aria-label="Forecast period" className="inline-flex flex-wrap gap-1 rounded-lg border border-border/70 bg-card p-1">{FORECAST_PERIODS.map((p) => <Button key={p.id} variant="ghost" size="sm" role="tab" aria-selected={pid === p.id} onClick={() => setPid(p.id)} className={`rounded-md text-xs ${pid === p.id ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-primary hover:bg-primary/10'}`}>{p.label}</Button>)}</div>
    {q.isLoading || contractQ.isLoading ? <Panel><p className="text-xs text-muted-foreground">Loading forecast…</p></Panel> : q.isError ? <Panel><p className="text-xs text-destructive">Forecast unavailable. Please refresh.</p></Panel> : <>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3"><Metric label="Behavior projection" value={formatUGX(sum)} note="Based on past payables" icon={Wallet} tone="primary" /><Metric label="Ideal (contract)" value={contractQ.isError ? 'Unavailable' : formatUGX(sched)} note="Scheduled by contract" icon={CalendarDays} tone="success" /><Metric label="Daily Average" value={formatUGX(rows.length ? sum / rows.length : 0)} note="Behavior projection per day" icon={TrendingDown} tone="warning" /></div>
      <Panel title={`Payables Projection — Next ${days} Days`}><ForecastChart rows={rows.map((r) => ({ label: r.label, amount: r.behavior, scheduled: r.contract }))} /></Panel>
      <Panel title="Day by Day"><div className="overflow-x-auto"><table className="w-full text-[10px]"><thead className="bg-muted/50 text-muted-foreground"><tr><th className="p-2 text-left font-medium">Date</th><th className="p-2 text-right font-medium">Behavior projection (UGX)</th><th className="p-2 text-right font-medium">Ideal — contract (UGX)</th></tr></thead><tbody className="divide-y divide-border">{rows.map((r) => <tr key={r.key}><td className="p-2">{r.date}</td><td className="p-2 text-right tabular-nums">{formatUGX(r.behavior)}</td><td className="p-2 text-right tabular-nums">{formatUGX(r.contract)}</td></tr>)}</tbody><tfoot><tr className="border-t border-border font-semibold"><td className="p-2">Total</td><td className="p-2 text-right tabular-nums">{formatUGX(sum)}</td><td className="p-2 text-right tabular-nums">{formatUGX(sched)}</td></tr></tfoot></table></div></Panel>
    </>}
  </>;
}

function SideItem({ active, icon: Icon, label, onClick }: { active: boolean; icon: typeof Users; label: string; onClick: () => void }) {
  return <Button variant="ghost" onClick={onClick} aria-current={active ? 'page' : undefined} className={`w-full h-auto justify-start gap-2 rounded-md px-3 py-2 text-left ${active ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted'}`}><Icon className="shrink-0" /><span className="min-w-0 whitespace-normal text-[10px] font-medium leading-4">{label}</span></Button>;
}
function Panel({ title, children }: { title?: string; children: React.ReactNode }) {
  return <section className="min-w-0 rounded-lg border border-border bg-card p-3">{title && <h2 className="mb-3 text-xs font-semibold">{title}</h2>}{children}</section>;
}
function Metric({ label, value, note, icon: Icon, tone }: { label: string; value: string; note: string; icon: typeof Users; tone: string }) {
  const tones: Record<string, string> = { primary: 'bg-primary/5 text-primary', success: 'bg-success/5 text-success', destructive: 'bg-destructive/5 text-destructive', warning: 'bg-warning/5 text-warning' };
  return <div className={`min-w-0 rounded-lg border border-border p-2.5 ${tones[tone]}`}><div className="mb-2 flex items-center gap-2"><Icon className="h-4 w-4 shrink-0" /><span className="text-[10px] font-medium">{label}</span></div><p className="text-xs leading-5 font-semibold tabular-nums text-foreground break-words">{value}</p><p className="mt-1 text-[10px] text-muted-foreground">{note}</p></div>;
}
function Outlook({ label, value }: { label: string; value: string }) {
  return <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-3 last:border-0"><span className="flex items-center gap-2 text-[11px] text-muted-foreground"><Wallet className="h-4 w-4 text-primary" />{label}</span><span className="text-xs font-semibold tabular-nums break-words">{value}</span></div>;
}
function Distribution({ data, total }: { data: { label: string; amount: number }[]; total: number }) {
  return <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] items-center gap-2"><div className="relative h-40">{total > 0 ? <><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={data} dataKey="amount" nameKey="label" innerRadius="62%" outerRadius="90%" paddingAngle={1} stroke="hsl(var(--card))">{data.map((d, i) => <Cell key={d.label} fill={COLORS[i % COLORS.length]} />)}</Pie><Tooltip formatter={(v: number) => formatUGX(v)} /></PieChart></ResponsiveContainer><div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"><span className="text-xs text-muted-foreground">UGX</span><span className="text-lg font-semibold tabular-nums">{compact(total)}</span><span className="text-[10px] text-muted-foreground">Total</span></div></> : <p className="pt-16 text-center text-[10px] text-muted-foreground">No recorded balance</p>}</div><div className="space-y-2">{data.map((d, i) => <div key={d.label} className="flex items-center gap-1.5 text-[9px]"><svg width="8" height="8" className="shrink-0" aria-hidden="true"><circle cx="4" cy="4" r="4" fill={COLORS[i % COLORS.length]} /></svg><span className="flex-1">{d.label}</span><span className="tabular-nums">{total > 0 ? (d.amount / total * 100).toFixed(1) : '0'}%</span></div>)}</div></div>;
}
function ForecastChart({ rows }: { rows: { label: string; amount: number; scheduled: number }[] }) {
  return <div className="h-28 rounded-lg bg-primary/10 p-1"><ResponsiveContainer width="100%" height="100%"><ComposedChart data={rows} margin={{ top: 8, right: 4, left: -20, bottom: 0 }}><CartesianGrid vertical={false} stroke="hsl(var(--border))" /><XAxis dataKey="label" tick={{ fontSize: 9 }} tickLine={false} axisLine={false} /><YAxis tickFormatter={compact} tick={{ fontSize: 9 }} tickLine={false} axisLine={false} /><Tooltip formatter={(v: number) => formatUGX(v)} /><Bar dataKey="amount" name="Expected payouts (est.)" fill="hsl(var(--primary))" maxBarSize={22} radius={[3, 3, 0, 0]} /><Line dataKey="scheduled" name="Scheduled portion" stroke="hsl(var(--success))" strokeWidth={2} dot={false} /></ComposedChart></ResponsiveContainer></div>;
}
function ItemTable({ items }: { items: PayableItem[] }) {
  return <div className="max-h-96 overflow-auto">{items.length ? <table className="w-full text-[10px]"><thead className="bg-muted/50 text-muted-foreground"><tr><th className="p-2 text-left font-medium">Account</th><th className="p-2 text-left font-medium">Due Date</th><th className="p-2 text-right font-medium">Amount</th></tr></thead><tbody className="divide-y divide-border">{items.map((item) => <tr key={`${item.source}:${item.item_id}`}><td className="py-2 pr-2"><span className="block">{item.counterparty || 'Unnamed'}</span>{item.status && <span className="text-[9px] text-muted-foreground">{item.status.replace(/_/g, ' ')}</span>}</td><td className="p-1 text-muted-foreground whitespace-nowrap">{item.due_date ? `${item.due_kind === 'projected' ? 'Est. ' : ''}${item.due_date.slice(0, 10)}` : 'No date'}</td><td className="p-1 text-right tabular-nums whitespace-nowrap">{formatUGX(item.amount)}</td></tr>)}</tbody></table> : <p className="py-5 text-xs text-muted-foreground">No recorded items.</p>}</div>;
}