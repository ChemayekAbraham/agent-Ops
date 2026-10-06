import { useState } from 'react';
import { AlertTriangle, CalendarDays, CheckCircle2, ChevronRight, Clock3, Coins, MapPin, Target, Users } from 'lucide-react';
import { Bar, CartesianGrid, Cell, ComposedChart, Legend, Line, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Button } from '@/components/ui/button';
import { formatUGX } from '@/lib/rentCalculations';
import type { ReceivableProduct, TenantReceivablesLocationBreakdown } from '@/hooks/useReceivables';

type ForecastRow = { label: string; behaviour: number | null; ideal: number | null };
type Props = {
  product: ReceivableProduct;
  current?: number;
  overdue?: number;
  complete: boolean;
  today: string;
  locations?: TenantReceivablesLocationBreakdown;
  locationLoading: boolean;
  locationError: boolean;
  forecast: ForecastRow[];
  behaviourTotal: number | null;
  idealTotal: number | null;
};

const amount = (value: number | null | undefined) => value == null ? 'Unavailable' : formatUGX(value);
const short = (value: number) => Math.abs(value) >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : `${(value / 1e3).toFixed(0)}K`;

function Panel({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return <section className="min-w-0 rounded-lg border border-border bg-card p-4"><div className="mb-3 flex items-center justify-between gap-2"><h2 className="text-xs font-semibold">{title}</h2>{action}</div>{children}</section>;
}

function Metric({ label, value, note, icon: Icon, tone }: { label: string; value: string; note: string; icon: typeof Users; tone: 'info' | 'success' | 'destructive' }) {
  const colors = { info: 'bg-primary/10 text-primary', success: 'bg-success/10 text-success', destructive: 'bg-destructive/10 text-destructive' };
  return <div className="min-w-0 rounded-lg border border-border bg-card p-4"><div className="mb-3 flex items-center gap-2"><span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${colors[tone]}`}><Icon className="h-4 w-4" /></span><h2 className="text-[10px] font-medium">{label}</h2></div><p className="break-words text-base font-semibold tabular-nums">{value}</p><p className="mt-2 text-[10px] text-muted-foreground">{note}</p></div>;
}

export default function TenantReceivablesDetail({ product, current, overdue, complete, today, locations, locationLoading, locationError, forecast, behaviourTotal, idealTotal }: Props) {
  const [allAccounts, setAllAccounts] = useState(false);
  const [allLocations, setAllLocations] = useState(false);
  const [allInsights, setAllInsights] = useState(false);
  const sortedItems = [...product.items].sort((a, b) => b.amount - a.amount);
  const rows = [...(locations?.rows ?? [])].sort((a, b) => b.outstanding - a.outstanding);
  const distribution = current !== undefined && overdue !== undefined ? [
    { label: 'Current', amount: current, color: 'hsl(var(--success))' },
    { label: 'Overdue', amount: overdue, color: 'hsl(var(--warning))' },
  ] : [];
  const share = (value: number) => product.outstanding > 0 ? `${(value / product.outstanding * 100).toFixed(1)}%` : '0.0%';
  const overdueItems = product.items.filter((item) => item.due_date && item.due_date.slice(0, 10) < today);
  const largestLocation = rows[0];
  const action = (expanded: boolean, onClick: () => void) => <Button variant="link" size="sm" onClick={onClick} className="h-auto min-h-0 p-0 text-[10px] text-primary">{expanded ? 'Show less' : 'View all'}<ChevronRight className="h-3 w-3" /></Button>;

  return <div className="tenant-receivables-detail flex flex-col gap-3">
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <Metric label="Total Accounts" value={product.item_count.toLocaleString()} note="Open receivable items" icon={Users} tone="info" />
      <Metric label="Outstanding Amount" value={formatUGX(product.outstanding)} note="Selected product outstanding" icon={Coins} tone="success" />
      <Metric label="Overdue Amount" value={amount(overdue)} note={overdue === undefined ? 'Complete account data unavailable' : `${share(overdue)} of outstanding`} icon={Clock3} tone="destructive" />
      <Metric label="Due in 7 Days" value={amount(idealTotal)} note="Scheduled collections" icon={CalendarDays} tone="info" />
      <Metric label="Collection Rate" value="Unavailable" note="No consolidated collection rate" icon={Target} tone="success" />
    </div>
    <div className="grid items-start gap-3 xl:grid-cols-[1.3fr_1fr]">
      <div className="grid min-w-0 gap-3">
        <Panel title="7-Day Collection Forecast">
          <p className="mb-3 text-[10px] text-muted-foreground">Expected collections vs. scheduled collections</p>
          <div className="h-64 rounded-lg bg-primary/10 p-1"><ResponsiveContainer width="100%" height="100%"><ComposedChart data={forecast} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}><CartesianGrid vertical={false} strokeDasharray="3 3" stroke="hsl(var(--border))" /><XAxis dataKey="label" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} stroke="hsl(var(--muted-foreground))" /><YAxis width={64} tick={{ fontSize: 10 }} tickFormatter={(v: number) => `UGX ${short(v)}`} tickLine={false} axisLine={false} stroke="hsl(var(--muted-foreground))" /><Tooltip formatter={(v: number) => formatUGX(v)} /><Legend wrapperStyle={{ fontSize: 10 }} /><Bar dataKey="behaviour" name="Expected Collections (UGX)" fill="hsl(var(--primary))" maxBarSize={38} radius={[3, 3, 0, 0]} /><Line dataKey="ideal" name="Ideal (scheduled UGX)" stroke="hsl(var(--success))" strokeWidth={2} dot={{ r: 3 }} /></ComposedChart></ResponsiveContainer></div>
          <div className="mt-2 flex flex-wrap justify-between gap-2 text-[10px] text-muted-foreground"><span>Behaviour {amount(behaviourTotal)}</span><span>Ideal {amount(idealTotal)}</span></div>
        </Panel>
        <Panel title="Top Accounts by Outstanding Balance" action={action(allAccounts, () => setAllAccounts(!allAccounts))}>
          {!complete && <p className="mb-2 text-[10px] text-muted-foreground">Available account sample · {product.items.length} of {product.item_count.toLocaleString()} items</p>}
          <div className="overflow-x-auto"><table className="w-full text-[10px]"><thead className="bg-muted/50 text-muted-foreground"><tr><th className="p-2 text-left font-medium">#</th><th className="p-2 text-left font-medium">Tenant</th><th className="p-2 text-left font-medium">Account No.</th><th className="p-2 text-right font-medium">Outstanding (UGX)</th><th className="p-2 text-left font-medium">Due Date</th><th className="p-2 text-left font-medium">Status</th></tr></thead><tbody className="divide-y divide-border">{sortedItems.slice(0, allAccounts ? undefined : 5).map((item, index) => <tr key={item.item_id}><td className="p-2 text-muted-foreground">{index + 1}</td><td className="p-2 font-medium">{item.counterparty ?? 'Unavailable'}</td><td className="p-2 text-muted-foreground" title={item.item_id}>{item.item_id.slice(0, 8)}</td><td className="p-2 text-right tabular-nums whitespace-nowrap">{formatUGX(item.amount)}</td><td className="p-2 whitespace-nowrap text-muted-foreground">{item.due_date?.slice(0, 10) ?? 'Unavailable'}</td><td className="p-2">{item.due_date ? <span className={`inline-flex rounded px-2 py-1 text-[9px] ${item.due_date.slice(0, 10) < today ? 'bg-destructive/10 text-destructive' : 'bg-success/10 text-success'}`}>{item.due_date.slice(0, 10) < today ? 'Overdue' : 'Current'}</span> : <span className="text-muted-foreground">Undated</span>}</td></tr>)}</tbody></table></div>
          {!sortedItems.length && <p className="py-5 text-xs text-muted-foreground">No account items available.</p>}
        </Panel>
      </div>
      <div className="grid min-w-0 gap-3">
        <Panel title="Collection Performance">
          <div className="grid grid-cols-1 items-center gap-4 sm:grid-cols-[minmax(120px,0.8fr)_minmax(0,1.5fr)]">
            <div className="relative mx-auto h-36 w-full max-w-40">
              <ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={distribution.length ? distribution : [{ amount: 1 }]} dataKey="amount" nameKey="label" innerRadius="74%" outerRadius="96%" startAngle={90} endAngle={-270} stroke="none">{distribution.length ? distribution.map((row) => <Cell key={row.label} fill={row.color} />) : <Cell fill="hsl(var(--muted))" />}</Pie>{distribution.length > 0 && <Tooltip formatter={(v: number) => formatUGX(v)} />}</PieChart></ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1"><span className="text-[10px] text-muted-foreground">UGX</span><span className="text-xl font-semibold tabular-nums">{short(product.outstanding)}</span><span className="text-[10px] text-muted-foreground">Outstanding</span></div>
            </div>
            <div className="space-y-6 text-[10px]">{[{ label: 'Current', value: current, dot: 'bg-success' }, { label: 'Overdue', value: overdue, dot: 'bg-warning' }, { label: 'Due in 7 Days', value: idealTotal, dot: 'bg-primary' }].map((row) => <div key={row.label} className="grid grid-cols-[minmax(0,1fr)_auto_34px] items-center gap-2"><span className="flex items-center gap-2"><span className={`h-2 w-2 shrink-0 rounded-full ${row.dot}`} /><span>{row.label}</span></span><span className="whitespace-nowrap text-right tabular-nums text-muted-foreground">{amount(row.value)}</span><span className="text-right tabular-nums text-muted-foreground">{row.value == null ? '—' : share(row.value)}</span></div>)}</div>
          </div>
          {!distribution.length && <p className="mt-2 text-[10px] text-muted-foreground">Current and overdue totals are unavailable in this account sample.</p>}
        </Panel>
        <Panel title="Receivables by Location" action={action(allLocations, () => setAllLocations(!allLocations))}>
          <div className="overflow-x-auto"><table className="w-full text-[10px]"><thead className="bg-muted/50 text-muted-foreground"><tr><th className="p-2 text-left font-medium">Location</th><th className="p-2 text-right font-medium">Accounts</th><th className="p-2 text-right font-medium">Outstanding (UGX)</th><th className="p-2 text-right font-medium">Overdue (UGX)</th><th className="p-2 text-right font-medium">% of Total</th></tr></thead><tbody className="divide-y divide-border">{rows.slice(0, allLocations ? undefined : 6).map((row) => <tr key={row.key ?? row.label}><td className="p-2"><span className="flex items-center gap-1"><svg-less><MapPin className="h-3 w-3 shrink-0 text-primary" />{row.label}</span></td><td className="p-2 text-right tabular-nums">{row.tenant_count.toLocaleString()}</td><td className="p-2 text-right tabular-nums whitespace-nowrap">{formatUGX(row.outstanding)}</td><td className="p-2 text-right text-muted-foreground">—</td><td className="p-2 text-right tabular-nums">{share(row.outstanding)}</td></tr>)}</tbody></table></div>
          {!rows.length && <p className="py-5 text-xs text-muted-foreground">{locationLoading ? 'Loading locations…' : locationError ? 'Location report unavailable.' : 'No location data available.'}</p>}
        </Panel>
        <Panel title="Key Insights & Alerts" action={action(allInsights, () => setAllInsights(!allInsights))}>
          <div className="divide-y divide-border"><Insight icon={AlertTriangle} tone="destructive" title="Top 5 overdue accounts" detail={complete ? `${formatUGX([...overdueItems].sort((a, b) => b.amount - a.amount).slice(0, 5).reduce((sum, item) => sum + item.amount, 0))} · ${overdueItems.length} overdue items` : 'Complete dated account data unavailable'} /><Insight icon={Target} tone="warning" title="Collection rate" detail="No consolidated collection rate available" /><Insight icon={MapPin} tone="info" title="Highest location concentration" detail={largestLocation ? `${largestLocation.label} · ${share(largestLocation.outstanding)} of outstanding` : 'Location breakdown unavailable'} />{allInsights && <Insight icon={CheckCircle2} tone="success" title="Scheduled collections" detail={`${amount(idealTotal)} due in the next 7 days`} />}</div>
        </Panel>
      </div>
    </div>
  </div>;
}

function Insight({ icon: Icon, tone, title, detail }: { icon: typeof Users; tone: 'destructive' | 'warning' | 'info' | 'success'; title: string; detail: string }) {
  const colors = { destructive: 'bg-destructive/10 text-destructive', warning: 'bg-warning/10 text-warning', info: 'bg-info/10 text-info', success: 'bg-success/10 text-success' };
  return <div className="flex items-start gap-2 py-3"><span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${colors[tone]}`}><Icon className="h-3.5 w-3.5" /></span><div className="min-w-0"><p className="text-[10px] font-medium">{title}</p><p className="mt-1 text-[9px] text-muted-foreground">{detail}</p></div></div>;
}