import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, LayoutGrid, Users, Handshake, Home, Building2, Package, FlaskConical, Search, RefreshCw, ChevronRight, CalendarDays, AlertTriangle, CheckCircle2, TrendingUp, Wallet, MapPin } from 'lucide-react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, PieChart, Pie, Cell, ComposedChart, Bar,
} from 'recharts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import TenantReceivablesDetail from '@/components/executive/TenantReceivablesDetail';
import AgentReceivablesDetail from '@/components/executive/AgentReceivablesDetail';
import ReceivablesProjection from '@/components/cfo/ReceivablesProjection';
import ReceivablesByLocation from '@/components/cfo/ReceivablesByLocation';
import { usePayablesPredictiveForecast } from '@/hooks/usePayables';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { kampalaTodayYmd } from '@/lib/kampalaDays';
import { formatUGX } from '@/lib/rentCalculations';
import {
  useReceivablesBreakdown, useReceivablesPredictiveForecast, useReceivablesForecast, useTenantReceivablesByLocation,
  type ReceivablesForecast, type ReceivableProduct,
} from '@/hooks/useReceivables';

/**
 * CFO Receivables Overview workspace. Presentation only: every figure comes
 * from the authoritative receivables RPCs. Nothing here writes data.
 */

type SubDef = { key: string; label: string };
type CatDef = { key: string; label: string; icon: typeof Users; subs: SubDef[] };

const CATS: CatDef[] = [
  { key: 'tenant', label: 'Tenant Products & Services', icon: Home, subs: [
    { key: 'rent_plan', label: 'Rent Access Plans' },
    { key: 'tenant_service_charge', label: 'Tenant Service Charges' },
    { key: 'business_advance', label: 'Business Advances' },
  ] },
  { key: 'agent', label: 'Agent Products & Services', icon: Users, subs: [
    { key: 'merchandise_recovery', label: 'Merchandise & Smartphone Recovery' },
    { key: 'agent_advance', label: 'Agent Advances' },
    { key: 'agent_advance_access_fee', label: 'Agent Advance Access Fees' },
    { key: 'bike_recovery', label: 'Bike Recoveries' },
    { key: 'credit_access_draw', label: 'Credit Access Draws' },
    { key: 'merchandise_credit_sale', label: 'Merchandise Credit Sales' },
  ] },
  { key: 'landlord', label: 'Landlord Products & Services', icon: Building2, subs: [
    { key: 'welile_homes', label: 'Welile Homes Subscriptions' },
  ] },
  { key: 'partner', label: 'Partner Products & Services', icon: Handshake, subs: [
    { key: 'promissory_note', label: 'Promissory Notes' },
  ] },
  { key: 'other', label: 'Unclassified / Other', icon: Package, subs: [] },
  { key: 'rnd', label: 'R&D', icon: FlaskConical, subs: [] },
];

const CAT_SUBTITLES: Record<string, string> = {
  tenant: 'tenant',
  agent: 'agent',
  landlord: 'landlord',
  partner: 'partner',
  other: 'unclassified and other',
  rnd: 'research and development',
};

const money = (v: number | null | undefined) => (v == null ? '—' : formatUGX(v));
const compact = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toFixed(0);
};

export default function ReceivablesOverview() {
  const [search, setSearch] = useState('');
  const [params, setParams] = useSearchParams();
  const requestedCat = params.get('cat') ?? 'overview';
  const catKey = requestedCat === 'agent_lending' ? 'forecast' : requestedCat;
  const isDetailCat = ['tenant', 'agent', 'landlord', 'partner', 'other', 'rnd'].includes(catKey);
  const subParam = params.get('sub');
  const go = (cat: string, sub?: string) => {
    const n = new URLSearchParams();
    if (cat !== 'overview') n.set('cat', cat);
    if (sub) n.set('sub', sub);
    setParams(n, { replace: true });
  };

  const breakdown = useReceivablesBreakdown();
  const live = breakdown.data?.categories ?? [];
  const liveCat = (k: string) => live.find((c) => c.key === k);

  const cats = CATS.map((c) => {
    const lc = liveCat(c.key);
    const extra = (lc?.products ?? []).filter((p) => !c.subs.some((s) => s.key === p.key))
      .map((p) => ({ key: p.key, label: p.label }));
    return { ...c, subs: [...c.subs, ...extra], outstanding: lc?.outstanding ?? 0, count: lc?.item_count ?? 0 };
  });
  const cat = cats.find((c) => c.key === catKey);
  const subKey = cat ? (subParam && cat.subs.some((s) => s.key === subParam) ? subParam : cat.subs[0]?.key) : undefined;
  const sub = cat?.subs.find((s) => s.key === subKey);
  const product = cat && subKey ? liveCat(cat.key)?.products.find((p) => p.key === subKey) : undefined;

  return (
    <main className="receivables-workspace min-h-screen bg-background">
      <div className="border-b border-border bg-card lg:fixed lg:inset-x-0 lg:top-0 lg:z-30 flex h-14 items-center">
        <Link to="/cfo/dashboard" className="hidden h-full w-[190px] shrink-0 items-center gap-2 border-r border-border px-4 text-base font-semibold lg:flex"><TrendingUp className="h-5 w-5 text-info" /> Welile CFO</Link>
        <div className="relative mx-4 w-full max-w-lg"><Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><Input aria-label="Search receivable categories" placeholder="Search categories…" value={search} onChange={(e) => setSearch(e.target.value)} className="h-9 min-h-0 rounded-full bg-muted/40 pl-9 text-xs" /></div>
        <span className="ml-auto hidden px-5 text-xs text-muted-foreground sm:block">CFO</span>
      </div>
      <div className="lg:pt-14">
        <div className="grid grid-cols-1 lg:grid-cols-[190px_minmax(0,1fr)]">
          <nav aria-label="Receivable categories" className="border-r border-border bg-card px-2 py-4 flex flex-col lg:fixed lg:bottom-0 lg:left-0 lg:top-14 lg:w-[190px]">
            <p className="px-3 pb-3 text-[10px] text-muted-foreground">CFO</p>
            <Button asChild variant="ghost" className="mb-2 h-9 justify-start px-3 text-xs font-medium"><Link to="/cfo/dashboard"><ArrowLeft /> Back</Link></Button>
            <SideItem active={catKey === 'overview'} icon={LayoutGrid} label="Overview" onClick={() => go('overview')} />
            {cats.map((c) => <SideItem key={c.key} active={catKey === c.key} icon={c.icon} label={c.label} onClick={() => go(c.key)} />)}
            <div className="my-3 border-t border-border/60" />
            <SideItem active={catKey === 'forecast'} icon={TrendingUp} label="Forecast" onClick={() => go('forecast')} />
          </nav>
          <div className="min-w-0 px-4 py-5 lg:col-start-2">
            {(isDetailCat) && cat && <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground"><Button variant="link" className="h-auto min-h-0 p-0 text-[10px] text-primary" onClick={() => go('overview')}>Receivables</Button><ChevronRight className="h-3 w-3" /><span>{cat.label}</span><ChevronRight className="h-3 w-3" /><span>{sub?.label}</span></div>}
            <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <div><h1 className="text-xl font-semibold">{isDetailCat ? cat?.label : catKey === 'forecast' ? 'Forecast' : 'Receivables Overview'}</h1><p className="mt-1 text-xs text-muted-foreground">{isDetailCat ? `Track outstanding receivables, collection performance and forecast for ${CAT_SUBTITLES[catKey] ?? 'these'} products and services.` : 'Outstanding receivables, collection risk and expected collections.'}</p></div>
              <div className="flex items-center gap-3"><span className="text-[10px] text-muted-foreground">Last updated · {breakdown.data?.as_at?.slice(0,10) ?? '—'} · EAT</span><Button variant="outline" size="sm" className="rounded-md text-primary hover:text-primary" disabled={breakdown.isFetching} onClick={() => void breakdown.refetch()}><RefreshCw className={breakdown.isFetching ? 'animate-spin' : ''} />Refresh</Button></div>
            </header>
          <div className="min-w-0 flex flex-col gap-3">
            {catKey === 'forecast' ? <ReceivablesProjection /> : breakdown.isLoading ? (
              <Card><p className="text-sm text-muted-foreground">Loading live receivables…</p></Card>
            ) : breakdown.isError ? (<Card><p className="text-sm text-destructive">Could not load receivables. Please refresh.</p></Card>) : !cat ? (
              <Overview cats={cats} products={(k) => liveCat(k)?.products ?? []} onOpen={go} total={breakdown.data?.total ?? 0} search={search} />
            ) : (
              <>
                {!isDetailCat && <div>
                  <h2 className="text-lg font-semibold">{cat.label}</h2>
                  <p className="text-xs text-muted-foreground">{formatUGX(cat.outstanding)} · {cat.count.toLocaleString()} items</p>
                </div>}
                {cat.subs.length === 0 ? (
                  <Card><p className="text-sm text-muted-foreground">No receivable products are recorded under this category yet.</p></Card>
                ) : (
                  <>
                    <div role="tablist" className={`inline-flex flex-wrap gap-1 border border-border/70 bg-card p-1 ${isDetailCat ? 'rounded-lg' : 'rounded-xl'}`}>
                      {cat.subs.map((s) => (
                        <Button variant="ghost" size="sm" key={s.key} role="tab" aria-selected={s.key === subKey} onClick={() => go(cat.key, s.key)}
                          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${s.key === subKey
                            ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-primary hover:bg-primary/10'}`}>
                          {s.label}
                        </Button>
                      ))}
                    </div>
                    {sub && <SubDetail key={sub.key} catKey={cat.key} label={sub.label} productKey={sub.key} product={product} />}
                  </>
                )}
              </>
            )}
          </div>
          </div>
        </div>
      </div>
    </main>
  );
}

function SideItem({ active, icon: Icon, label, value, onClick }: {
  active: boolean; icon: typeof Users; label: string; value?: number; onClick: () => void;
}) {
  return (
    <Button variant="ghost" type="button" onClick={onClick} aria-current={active ? 'page' : undefined}
      className={`w-full h-auto justify-start flex items-center gap-2 rounded-md px-3 py-2 text-left transition-colors ${active ? 'bg-primary/10 text-primary' : 'hover:bg-muted text-foreground'}`}>
      <Icon className="h-4 w-4 shrink-0" />
      <span className="flex-1 min-w-0">
        <span className="block text-[10px] font-medium whitespace-normal leading-4">{label}</span>
        {value !== undefined && <span className="block text-[11px] text-muted-foreground tabular-nums">UGX {compact(value)}</span>}
      </span>
    </Button>
  );
}

function Card({ title, right, className, children }: { title?: string; right?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <section className={`rounded-lg border border-border bg-card p-3 min-w-0 ${className ?? ''}`}>
      {title && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-semibold">{title}</h3>{right}
        </div>
      )}
      {children}
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 min-w-0">
      <p className="text-[11px] uppercase text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums break-words">{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

const CATEGORY_ICON_STYLES: Record<string, string> = {
  tenant: 'bg-success/10 text-success',
  agent: 'bg-info/10 text-info',
  landlord: 'bg-warning/10 text-warning',
  partner: 'bg-primary/10 text-primary',
  other: 'bg-muted text-muted-foreground',
  rnd: 'receivable-category-rnd',
};
const CATEGORY_TONES = ['success', 'info', 'warning', 'primary', 'muted-foreground', 'receivable-rnd'];
const SLICE_COLORS = CATEGORY_TONES.map((tone) => `hsl(var(--${tone}))`);

function Overview({ cats, products, onOpen, total, search }: {
  cats: (CatDef & { outstanding: number; count: number })[];
  products: (k: string) => ReceivableProduct[]; onOpen: (c: string, s?: string) => void; total: number; search: string;
}) {
  const today = kampalaTodayYmd();
  const end = new Date(`${today}T00:00:00Z`); end.setUTCDate(end.getUTCDate() + 6);
  const forecast = useReceivablesPredictiveForecast('day', 7);
  const scheduled = useReceivablesForecast(today, end.toISOString().slice(0, 10));
  const payables = usePayablesPredictiveForecast('day', 7);
  const locations = useTenantReceivablesByLocation({ level: 'region' });
  const actual = forecast.data?.actual;
  const items = cats.flatMap((c) => products(c.key).flatMap((p) => p.items));
  const complete = cats.every((c) => products(c.key).every((p) => p.items.length === p.item_count));
  const overdueItems = items.filter((i) => i.due_date && i.due_date.slice(0, 10) < today);
  const overdueFor = (key: string) => {
    const ps = products(key);
    return ps.every((p) => p.items.length === p.item_count) ? ps.flatMap((p) => p.items).filter((i) => i.due_date && i.due_date.slice(0, 10) < today).reduce((sum, i) => sum + Number(i.amount), 0) : undefined;
  };
  const expected = forecast.data && forecast.data.periods.every((p) => p.quality !== 'insufficient' && p.quality !== 'low') ? forecast.data.periods.reduce((sum, p) => sum + Number(p.runoff_amount), 0) : undefined;
  const payable = payables.data && payables.data.periods.every((p) => p.quality !== 'insufficient' && p.quality !== 'low') ? payables.data.periods.reduce((sum, p) => sum + Number(p.runoff_amount), 0) : undefined;
  const chart = (forecast.data?.periods ?? []).map((p) => ({ label: p.label, amount: p.quality === 'insufficient' || p.quality === 'low' ? null : Number(p.runoff_amount) }));
  let cumulative = 0;
  const chartRows = chart.map((p) => { cumulative += p.amount ?? 0; return { ...p, cumulative: p.amount === null ? null : cumulative }; });
  const counts = cats.reduce((sum, c) => sum + c.count, 0);
  const topLocations = [...(locations.data?.rows ?? [])].sort((a, b) => b.outstanding - a.outstanding).slice(0, 6);
  const largestOverdue = complete && overdueItems.length ? Math.max(...overdueItems.map((i) => Number(i.amount))) : undefined;
  const longest = complete && overdueItems.length ? Math.max(...overdueItems.map((i) => Math.floor((Date.parse(today) - Date.parse(i.due_date?.slice(0, 10) ?? today)) / 86400000))) : undefined;
  return (
    <>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-7">
        <OverviewMetric label="Total Receivables" value={money(total)} note={`${counts.toLocaleString()} open items`} icon={Wallet} tone="info" />
        <OverviewMetric label="Net Receivables" value={money(payable === undefined ? undefined : total - payable)} note="After next 7 days expected payables" icon={Wallet} tone="primary" />
        <OverviewMetric label="Current" value={money(actual?.not_yet_due)} note="Not yet due" icon={CheckCircle2} tone="success" />
        <OverviewMetric label="Overdue" value={money(actual?.overdue)} note="Past due date" icon={AlertTriangle} tone="destructive" />
        <OverviewMetric label="Due in 7 Days" value={money(scheduled.data?.scheduled_total)} note="Scheduled collections" icon={CalendarDays} tone="primary" />
        <OverviewMetric label="Collection Rate" value="Unavailable" note="No consolidated rate" icon={TrendingUp} tone="success" />
        <OverviewMetric label="Accounts Receivable" value={counts.toLocaleString()} note="Open receivable items" icon={Users} tone="info" />
      </div>
      <ReceivablesByLocation />
      <div className="grid gap-3 xl:grid-cols-[1.4fr_1.2fr_1fr] [&>*]:min-w-0">
        <Card title="Receivables by Category" className="h-full category-table">
          <div className="overflow-x-auto">
            <table className="w-full text-[10px]"><thead className="bg-muted/50 text-muted-foreground"><tr><th className="p-1 text-left font-medium">Category</th><th className="p-1 text-right font-medium">Items</th><th className="p-1 text-right font-medium">Outstanding (UGX)</th><th className="p-1 text-right font-medium">Overdue (UGX)</th><th className="p-1 text-right font-medium">Share</th></tr></thead>
              <tbody className="divide-y divide-border">{cats.filter((c) => c.label.toLowerCase().includes(search.toLowerCase())).map((c) => <tr key={c.key} className="hover:bg-muted/40"><td className="py-2 pr-1"><Button variant="ghost" className="h-auto min-h-0 justify-start whitespace-normal gap-1 px-0 py-1 text-left text-[9px] font-medium" onClick={() => onOpen(c.key)}><span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${CATEGORY_ICON_STYLES[c.key] ?? 'bg-muted text-muted-foreground'}`}><c.icon className="h-3.5 w-3.5" /></span>{c.label}<ChevronRight className="h-3 w-3" /></Button></td><td className="p-1 text-right tabular-nums">{c.count.toLocaleString()}</td><td className="p-1 text-right tabular-nums whitespace-nowrap">{formatUGX(c.outstanding).replace(/^UGX\s*/, '')}</td><td className="p-1 text-right tabular-nums whitespace-nowrap">{money(overdueFor(c.key)).replace(/^UGX\s*/, '')}</td><td className="p-1 text-right tabular-nums">{total > 0 ? (c.outstanding / total * 100).toFixed(1) : '0'}%</td></tr>)}</tbody>
            </table>
          </div>
        </Card>
        <div className="grid content-start gap-3">
          <Card title="Receivables by Category" className="category-distribution">
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] items-center gap-2">
            <div className="relative h-40">
              {total > 0 ? <ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={cats} dataKey="outstanding" nameKey="label" innerRadius="62%" outerRadius="90%" paddingAngle={1} stroke="hsl(var(--card))">{cats.map((c, i) => <Cell key={c.key} fill={SLICE_COLORS[i]} />)}</Pie><Tooltip formatter={(v: number) => formatUGX(v)} /></PieChart></ResponsiveContainer> : <p className="pt-16 text-center text-muted-foreground">No outstanding receivables</p>}
              {total > 0 && <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"><span className="text-xs text-muted-foreground">UGX</span><span className="text-xl font-semibold tabular-nums">{compact(total)}</span><span className="text-xs text-muted-foreground">Total</span></div>}
            </div>
            <div className="space-y-2">{cats.map((c, i) => <div key={c.key} className="flex items-center gap-1.5 text-[9px]"><svg width="8" height="8" aria-hidden="true"><circle cx="4" cy="4" r="4" fill={SLICE_COLORS[i]} /></svg><span className="flex-1">{c.label}</span><span className="tabular-nums">{total ? (c.outstanding / total * 100).toFixed(1) : '0'}%</span></div>)}</div>
            </div>
          </Card>
          <Card title="7-Day Receivables Forecast">
            <div className="mb-2 flex flex-wrap gap-3 text-[10px] text-muted-foreground"><span>Expected collections</span><span>Cumulative</span></div>
            <div className="h-28 rounded-lg bg-primary/10 p-1"><ResponsiveContainer width="100%" height="100%"><ComposedChart data={chartRows} margin={{ top: 8, right: 4, left: -20, bottom: 0 }}><CartesianGrid vertical={false} stroke="hsl(var(--border))" /><XAxis dataKey="label" tick={{ fontSize: 9 }} tickLine={false} axisLine={false} /><YAxis tickFormatter={compact} tick={{ fontSize: 9 }} tickLine={false} axisLine={false} /><Tooltip formatter={(v: number) => formatUGX(v)} /><Bar dataKey="amount" name="Expected collections" fill="hsl(var(--primary))" maxBarSize={22} radius={[3,3,0,0]} /><Line dataKey="cumulative" name="Cumulative" stroke="hsl(var(--success))" strokeWidth={2} dot={false} /></ComposedChart></ResponsiveContainer></div>
            {expected === undefined && <p className="mt-2 text-[11px] text-muted-foreground">Insufficient data for a complete forecast.</p>}
          </Card>
        </div>
        <div className="grid content-start gap-3">
          <Card title="Collection Outlook (Next 7 Days)"><div className="divide-y divide-border"><OutlookRow label="Expected Receipts" value={money(expected)} tone="success" /><OutlookRow label="Expected Payables" value={money(payable)} tone="destructive" /><OutlookRow label="Net Expected Cash Flow" value={expected !== undefined && payable !== undefined ? money(expected - payable) : 'Unavailable'} tone="info" /></div></Card>
          <Card title="Top Locations by Receivables" right={<Button variant="link" size="sm" className="h-auto min-h-0 p-0" onClick={() => onOpen('tenant')}>View all <ChevronRight /></Button>}>
            <p className="mb-3 text-[11px] text-muted-foreground">Tenant products & services</p>
            <div className="overflow-x-auto"><table className="w-full text-[11px]"><thead className="bg-muted/50 text-muted-foreground"><tr><th className="p-2 text-left font-medium">Location</th><th className="p-2 text-right font-medium">Accounts</th><th className="p-2 text-right font-medium">Outstanding</th></tr></thead><tbody className="divide-y divide-border">{topLocations.map((r) => <tr key={r.label}><td className="py-3"><span className="flex items-center gap-1"><MapPin className="h-3 w-3 shrink-0 text-info" />{r.label}</span></td><td className="p-1 text-right tabular-nums">{r.tenant_count.toLocaleString()}</td><td className="p-1 text-right tabular-nums whitespace-nowrap">{formatUGX(r.outstanding)}</td></tr>)}</tbody></table></div>
            {!topLocations.length && <p className="py-5 text-xs text-muted-foreground">{locations.isLoading ? 'Loading locations…' : locations.isError ? 'Location report unavailable.' : 'No location data available.'}</p>}
          </Card>
        </div>
      </div>
      <Card title="Receivables Risk"><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><OverviewMetric label="Largest Overdue Balance" value={money(largestOverdue)} note={complete ? 'Largest dated item' : 'Complete account data unavailable'} icon={AlertTriangle} tone="destructive" /><OverviewMetric label="Overdue Accounts" value={complete ? `${overdueItems.length} items` : 'Unavailable'} note="Past due date" icon={CalendarDays} tone="warning" /><OverviewMetric label="Due Within 7 Days" value={complete ? `${items.filter((i) => i.due_date && i.due_date.slice(0,10) >= today && i.due_date.slice(0,10) <= end.toISOString().slice(0,10)).length} items` : 'Unavailable'} note="Scheduled receivable items" icon={CalendarDays} tone="info" /><OverviewMetric label="Longest Overdue Balance" value={longest === undefined ? 'Unavailable' : `${longest} days`} note="Days beyond due date" icon={CalendarDays} tone="primary" /></div></Card>
    </>
  );
}

function OverviewMetric({ label, value, note, icon: Icon, tone }: { label: string; value: string; note: string; icon: typeof Users; tone: string }) {
  const tones: Record<string, string> = { info: 'bg-primary/5 text-primary', success: 'bg-success/5 text-success', destructive: 'bg-destructive/5 text-destructive', primary: 'bg-primary/5 text-primary', warning: 'bg-warning/5 text-warning' };
  return <div className={`min-w-0 rounded-lg border border-border p-2.5 ${tones[tone] ?? 'bg-muted text-foreground'}`}><div className="mb-2 flex items-center gap-2"><Icon className="h-4 w-4 shrink-0" /><span className="text-[10px] font-medium">{label}</span></div><p className="whitespace-nowrap text-xs leading-5 font-semibold tabular-nums text-foreground">{value}</p><p className="mt-1 text-[10px] text-muted-foreground">{note}</p></div>;
}
function OutlookRow({ label, value, tone }: { label: string; value: string; tone: string }) {
  return <div className="flex flex-wrap items-center justify-between gap-2 py-3"><span className="flex items-center gap-2 text-[11px] text-muted-foreground"><Wallet className={`h-4 w-4 ${tone === 'success' ? 'text-success' : tone === 'destructive' ? 'text-destructive' : 'text-primary'}`} />{label}</span><span className="text-xs font-semibold tabular-nums">{value}</span></div>;
}

function SubDetail({ catKey, label, productKey, product }: {
  catKey: string; label: string; productKey: string; product?: ReceivableProduct;
}) {
  const t = kampalaTodayYmd();
  const items = useMemo(() => product?.items ?? [], [product]);
  const complete = !!product && items.length === product.item_count;
  const overdue = complete ? items.filter((i) => i.due_date && i.due_date < t).reduce((s, i) => s + i.amount, 0) : undefined;
  const current = overdue !== undefined && product ? Math.max(0, product.outstanding - overdue) : undefined;

  const upcoming = useMemo(() => items.filter((i) => i.due_date).sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? '')).slice(0, 8), [items]);
  const bySource = useMemo(() => {
    const m = new Map<string, { amount: number; n: number }>();
    for (const i of items) { const e = m.get(i.source) ?? { amount: 0, n: 0 }; e.amount += i.amount; e.n++; m.set(i.source, e); }
    return [...m.entries()].sort((a, b) => b[1].amount - a[1].amount);
  }, [items]);

  const isTenant = catKey === 'tenant';
  const loc = useTenantReceivablesByLocation({ level: 'region', productKey }, isTenant && !!product);

  const fc = useReceivablesPredictiveForecast('day', 7).data;
  const ideal = useQuery({
    queryKey: ['receivables-overview-ideal-7d', fc?.as_at],
    enabled: !!fc,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => Promise.all((fc?.periods ?? []).map(async (p) => {
      const { data, error } = await supabase.rpc('get_receivables_forecast', { p_from: p.forecast_from, p_to: p.period_end });
      if (error) throw error;
      return data as unknown as ReceivablesForecast;
    })),
  });
  const stream = fc?.streams.find((s) => s.category_key === catKey && s.product_key === productKey);
  const hasBehaviour = !!stream && !stream.insufficient_data;
  const proj = (fc?.periods ?? []).map((p, i) => ({
    label: p.label,
    behaviour: hasBehaviour ? p.sources.filter((s) => s.product_key === productKey && s.basis === 'modelled').reduce((a, s) => a + s.runoff, 0) : null,
    ideal: ideal.data?.[i]?.products.filter((s) => s.product_key === productKey).reduce((a, s) => a + s.scheduled, 0) ?? null,
  }));
  const bTotal = hasBehaviour ? proj.reduce((a, p) => a + (p.behaviour ?? 0), 0) : null;
  const iTotal = ideal.data ? proj.reduce((a, p) => a + (p.ideal ?? 0), 0) : null;

  if (!product) {
    return <Card title={label}><p className="text-sm text-muted-foreground">No live outstanding balance is recorded for {label} yet.</p></Card>;
  }

  if (isTenant) {
    return <TenantReceivablesDetail product={product} current={current} overdue={overdue} complete={complete} today={t} locations={loc.data} locationLoading={loc.isLoading} locationError={loc.isError} forecast={proj} behaviourTotal={bTotal} idealTotal={iTotal} />;
  }

  if (catKey !== 'tenant') {
    // Shared detail layout across Agent / Landlord / Partner / Other / R&D product pages.
    return <AgentReceivablesDetail product={product} current={current} overdue={overdue} complete={complete} today={t} forecast={proj} behaviourTotal={bTotal} idealTotal={iTotal} />;
  }

  return (
    <div className="flex-1 flex flex-col gap-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <Stat label="Outstanding" value={formatUGX(product.outstanding)} />
        <Stat label="Accounts" value={product.item_count.toLocaleString()} />
        <Stat label="Current" value={current === undefined ? 'Unavailable' : formatUGX(current)} sub="Not yet due" />
        <Stat label="Overdue" value={overdue === undefined ? 'Unavailable' : formatUGX(overdue)} sub={complete ? 'Past due date' : 'Item list sampled'} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card title="Upcoming due dates">
          {upcoming.length === 0 ? <p className="text-xs text-muted-foreground">No dated items.</p> : (
            <ul className="divide-y divide-border/60">
              {upcoming.map((i) => (
                <li key={i.item_id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="min-w-0 truncate">{i.counterparty ?? '—'}</span>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">{i.due_date}{(i.due_date ?? t) < t && <span className="ml-2 text-destructive">overdue</span>}</span>
                  <span className="tabular-nums whitespace-nowrap">{formatUGX(i.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={isTenant ? 'Location breakdown' : 'Source breakdown'}>
          {isTenant && loc.data ? (
            <ul className="divide-y divide-border/60">
              {loc.data.rows.map((r) => (
                <li key={r.label} className="flex items-center justify-between py-2 text-sm">
                  <span>{r.label}</span>
                  <span className="tabular-nums">{formatUGX(r.outstanding)} <span className="text-xs text-muted-foreground">· {r.tenant_count}</span></span>
                </li>
              ))}
            </ul>
          ) : bySource.length === 0 ? <p className="text-xs text-muted-foreground">No items.</p> : (
            <ul className="divide-y divide-border/60">
              {bySource.map(([s, v]) => (
                <li key={s} className="flex items-center justify-between py-2 text-sm">
                  <span className="truncate">{s}</span>
                  <span className="tabular-nums">{formatUGX(v.amount)} <span className="text-xs text-muted-foreground">· {v.n}</span></span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="7-day forecast · behaviour-based vs ideal" className="flex-1 flex flex-col" right={
        <span className="text-xs text-muted-foreground">Behaviour {money(bTotal)} · Ideal {money(iTotal)}</span>
      }>
        {!hasBehaviour && <p className="mb-2 text-xs text-muted-foreground">Not enough collection history for a behaviour-based forecast; ideal schedule shown.</p>}
        <div className="flex-1 min-h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={proj} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} />
              <YAxis tickFormatter={(v) => `UGX ${compact(v)}`} tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} width={70} />
              <Tooltip formatter={(v: number) => formatUGX(v)} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="ideal" name="Ideal (scheduled)" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="behaviour" name="Behaviour-based" stroke="hsl(var(--success))" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>
    </div>
  );
}
