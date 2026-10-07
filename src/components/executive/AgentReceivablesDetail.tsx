import { useState } from 'react';
import { AlertTriangle, CalendarDays, CheckCircle2, ChevronRight, Clock3, Coins, Target, Users, UserRound, Hourglass, Layers } from 'lucide-react';
import { Bar, CartesianGrid, Cell, ComposedChart, Legend, Line, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Button } from '@/components/ui/button';
import { formatUGX } from '@/lib/rentCalculations';
import type { ReceivableProduct } from '@/hooks/useReceivables';

type ForecastRow = { label: string; behaviour: number | null; ideal: number | null };
type Props = {
  product: ReceivableProduct;
  current?: number;
  overdue?: number;
  complete: boolean;
  today: string;
  forecast: ForecastRow[];
  behaviourTotal: number | null;
  idealTotal: number | null;
  arrears?: number;
};

const amount = (v: number | null | undefined) => (v == null ? 'Unavailable' : formatUGX(v));
const short = (v: number) => (Math.abs(v) >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${(v / 1e3).toFixed(0)}K`);
const day = (d?: string | null) => d?.slice(0, 10);

function Panel({ title, children, action, className }: { title: string; children: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return <section className={`min-w-0 rounded-xl border border-border bg-card p-4 shadow-sm ${className ?? ''}`}><div className="mb-3 flex items-center justify-between gap-2"><h2 className="text-xs font-semibold">{title}</h2>{action}</div>{children}</section>;
}

const TONES = {
  primary: 'bg-primary/10 text-primary',
  success: 'bg-success/10 text-success',
  destructive: 'bg-destructive/10 text-destructive',
  warning: 'bg-warning/10 text-warning',
};

function Metric({ label, value, note, icon: Icon, tone }: { label: string; value: string; note: string; icon: typeof Users; tone: keyof typeof TONES }) {
  return <div className="min-w-0 rounded-xl border border-border bg-card p-4 shadow-sm"><div className="mb-3 flex items-center gap-2"><span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${TONES[tone]}`}><Icon className="h-4 w-4" /></span><h2 className="text-[10px] font-medium">{label}</h2></div><p className="break-words text-base font-semibold tabular-nums">{value}</p><p className="mt-2 text-[10px] text-muted-foreground">{note}</p></div>;
}

function RiskCard({ label, value, note, tone, icon: Icon }: { label: string; value: string; note: string; tone: keyof typeof TONES; icon: typeof Users }) {
  return <div className={`min-w-0 rounded-lg border border-border p-3 ${TONES[tone].split(' ')[0]}`}><div className="mb-2 flex items-center gap-2"><Icon className={`h-4 w-4 ${TONES[tone].split(' ')[1]}`} /><span className={`text-[10px] font-medium ${TONES[tone].split(' ')[1]}`}>{label}</span></div><p className="break-words text-xs font-semibold tabular-nums text-foreground">{value}</p><p className="mt-1 text-[10px] text-muted-foreground">{note}</p></div>;
}

export default function AgentReceivablesDetail({ product, current, overdue, complete, today, forecast, behaviourTotal, idealTotal, arrears }: Props) {
  // Due in 7 Days = today <= due_date <= today + 7 (Kampala). Overdue never counts.
  const in7End = new Date(`${today}T00:00:00Z`); in7End.setUTCDate(in7End.getUTCDate() + 7);
  const in7EndYmd = in7End.toISOString().slice(0, 10);
  const due7 = complete ? product.items.filter((i) => { const d = i.due_date?.slice(0, 10); return !!d && d >= today && d <= in7EndYmd; }).reduce((a, i) => a + i.amount, 0) : null;
  const arrearsNote = arrears ? `Overdue arrears / catch-up ${formatUGX(arrears)} is excluded from the Ideal schedule` : null;
  const [allAccounts, setAllAccounts] = useState(false);
  const [allSources, setAllSources] = useState(false);
  const items = product.items;
  const sorted = [...items].sort((a, b) => b.amount - a.amount);
  const share = (v: number) => (product.outstanding > 0 ? `${(v / product.outstanding * 100).toFixed(1)}%` : '0.0%');
  const isOverdue = (d?: string | null) => !!d && day(d)! < today;
  const overdueItems = items.filter((i) => isOverdue(i.due_date));
  const bySource = Object.entries(items.reduce<Record<string, { amount: number; n: number }>>((m, i) => {
    const e = (m[i.source] ??= { amount: 0, n: 0 }); e.amount += i.amount; e.n++; return m;
  }, {})).sort((a, b) => b[1].amount - a[1].amount);
  const upcoming = items.filter((i) => i.due_date && !isOverdue(i.due_date)).sort((a, b) => day(a.due_date)!.localeCompare(day(b.due_date)!));
  const distribution = current !== undefined && overdue !== undefined ? [
    { label: 'Current', amount: current, color: 'hsl(var(--success))' },
    { label: 'Overdue', amount: overdue, color: 'hsl(var(--warning))' },
  ] : [];
  const largest = sorted[0];
  const avg = product.item_count > 0 ? product.outstanding / product.item_count : undefined;
  const longest = overdueItems.length ? Math.max(...overdueItems.map((i) => Math.floor((Date.parse(today) - Date.parse(day(i.due_date)!)) / 86400000))) : undefined;
  const link = (open: boolean, fn: () => void) => <Button variant="link" size="sm" onClick={fn} className="h-auto min-h-0 p-0 text-[10px] text-primary">{open ? 'Show less' : 'View all'}<ChevronRight className="h-3 w-3" /></Button>;

  return <div className="agent-receivables-detail flex flex-col gap-3">
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-6">
      <Metric label="Outstanding" value={formatUGX(product.outstanding)} note="Total receivables" icon={Coins} tone="primary" />
      <Metric label="Accounts" value={product.item_count.toLocaleString()} note="Active accounts" icon={Users} tone="success" />
      <Metric label="Current" value={amount(current)} note={current === undefined ? 'Complete account data unavailable' : `${share(current)} of outstanding`} icon={CheckCircle2} tone="success" />
      <Metric label="Overdue" value={amount(overdue)} note={overdue === undefined ? 'Complete account data unavailable' : `${share(overdue)} of outstanding`} icon={Clock3} tone="destructive" />
      <Metric label="Due in 7 Days" value={amount(due7)} note="Scheduled collections" icon={CalendarDays} tone="primary" />
      <Metric label="Collection Rate" value="Unavailable" note="No consolidated rate" icon={Target} tone="success" />
    </div>

    <div className="grid items-stretch gap-3 xl:grid-cols-[1.4fr_1fr_0.8fr]">
      <Panel title="7-Day Forecast (Behaviour-based vs Ideal)">
        <div className="h-56 rounded-lg bg-primary/10 p-1"><ResponsiveContainer width="100%" height="100%"><ComposedChart data={forecast} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}><CartesianGrid vertical={false} strokeDasharray="3 3" stroke="hsl(var(--border))" /><XAxis dataKey="label" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} /><YAxis width={64} tick={{ fontSize: 10 }} tickFormatter={(v: number) => `UGX ${short(v)}`} tickLine={false} axisLine={false} /><Tooltip formatter={(v: number) => formatUGX(v)} /><Legend wrapperStyle={{ fontSize: 10 }} /><Bar dataKey="behaviour" name="Behaviour-based (UGX)" fill="hsl(var(--primary))" maxBarSize={34} radius={[3, 3, 0, 0]} /><Line dataKey="ideal" name="Ideal scheduled (UGX)" stroke="hsl(var(--success))" strokeWidth={2} dot={{ r: 3 }} /></ComposedChart></ResponsiveContainer></div>
        <div className="mt-2 flex flex-wrap justify-between gap-2 text-[10px] text-muted-foreground"><span>Behaviour {amount(behaviourTotal)}</span><span>Ideal (scheduled) {amount(idealTotal)}</span></div>{arrearsNote && <p className="mt-1 text-[10px] text-warning">{arrearsNote}.</p>}
        {behaviourTotal === null && <p className="mt-1 text-[10px] text-muted-foreground">Not enough collection history for a behaviour-based forecast; behaviour forecast unavailable.</p>}
      </Panel>

      <Panel title="Collection Performance">
        <div className="relative mx-auto h-40 w-full max-w-44">
          <ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={distribution.length ? distribution : [{ amount: 1 }]} dataKey="amount" nameKey="label" innerRadius="74%" outerRadius="96%" startAngle={90} endAngle={-270} stroke="none">{distribution.length ? distribution.map((r) => <Cell key={r.label} fill={r.color} />) : <Cell fill="hsl(var(--muted))" />}</Pie>{distribution.length > 0 && <Tooltip formatter={(v: number) => formatUGX(v)} />}</PieChart></ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1"><span className="text-[10px] text-muted-foreground">UGX</span><span className="text-xl font-semibold tabular-nums">{short(product.outstanding)}</span><span className="text-[10px] text-muted-foreground">Outstanding</span></div>
        </div>
        <div className="mt-3 space-y-2 text-[10px]">{[{ label: 'Current', v: current, dot: 'bg-success' }, { label: 'Overdue', v: overdue, dot: 'bg-warning' }, { label: 'Due in 7 Days', v: due7, dot: 'bg-primary' }].map((r) => <div key={r.label} className="grid grid-cols-[minmax(0,1fr)_auto_40px] items-center gap-2"><span className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${r.dot}`} />{r.label}</span><span className="whitespace-nowrap tabular-nums text-muted-foreground">{amount(r.v)}</span><span className="text-right tabular-nums text-muted-foreground">{r.v == null ? '—' : share(r.v)}</span></div>)}</div>
        {!distribution.length && <p className="mt-2 text-[10px] text-muted-foreground">Current and overdue totals are unavailable in this account sample.</p>}
      </Panel>

      <Panel title="Key Metrics">
        <div className="divide-y divide-border">
          <KeyRow icon={UserRound} label="Largest Account" value={largest ? formatUGX(largest.amount) : 'Unavailable'} note={largest ? `${share(largest.amount)} of total${largest.counterparty ? ` · ${largest.counterparty}` : ''}` : ''} />
          <KeyRow icon={Users} label="Average Account Size" value={avg === undefined ? 'Unavailable' : formatUGX(Math.round(avg))} note="per account" />
          <KeyRow icon={Hourglass} label="Longest Outstanding" value={longest === undefined ? 'Unavailable' : `${longest} days`} note={complete ? 'beyond due date' : 'account sample only'} />
        </div>
      </Panel>
    </div>

    <div className="grid items-start gap-3 xl:grid-cols-[1.4fr_1fr]">
      <Panel title="Top Accounts" action={link(allAccounts, () => setAllAccounts(!allAccounts))}>
        {!complete && <p className="mb-2 text-[10px] text-muted-foreground">Available account sample · {items.length} of {product.item_count.toLocaleString()} items</p>}
        <div className="overflow-x-auto"><table className="w-full text-[10px]"><thead className="bg-muted/50 text-muted-foreground"><tr><th className="p-2 text-left font-medium">#</th><th className="p-2 text-left font-medium">Account Name</th><th className="p-2 text-left font-medium">Account No.</th><th className="p-2 text-right font-medium">Outstanding (UGX)</th><th className="p-2 text-left font-medium">Due Date</th><th className="p-2 text-left font-medium">Status</th></tr></thead><tbody className="divide-y divide-border">{sorted.slice(0, allAccounts ? undefined : 5).map((i, n) => <tr key={i.item_id}><td className="p-2 text-muted-foreground">{n + 1}</td><td className="p-2 font-medium">{i.counterparty ?? 'Unavailable'}</td><td className="p-2 text-muted-foreground" title={i.item_id}>{i.item_id.slice(0, 8)}</td><td className="p-2 text-right tabular-nums whitespace-nowrap">{formatUGX(i.amount)}</td><td className="p-2 whitespace-nowrap text-muted-foreground">{day(i.due_date) ?? 'Unavailable'}</td><td className="p-2">{i.due_date ? <span className={`inline-flex rounded-full px-2 py-0.5 text-[9px] ${isOverdue(i.due_date) ? 'bg-destructive/10 text-destructive' : 'bg-success/10 text-success'}`}>{isOverdue(i.due_date) ? 'Overdue' : 'Current'}</span> : <span className="text-muted-foreground">Undated</span>}</td></tr>)}</tbody></table></div>
        {!sorted.length && <p className="py-5 text-xs text-muted-foreground">No account items available.</p>}
      </Panel>

      <Panel title="Receivables by Source" action={link(allSources, () => setAllSources(!allSources))}>
        <div className="overflow-x-auto"><table className="w-full text-[10px]"><thead className="bg-muted/50 text-muted-foreground"><tr><th className="p-2 text-left font-medium">Source</th><th className="p-2 text-right font-medium">Accounts</th><th className="p-2 text-right font-medium">Outstanding (UGX)</th><th className="p-2 text-right font-medium">% of Total</th></tr></thead><tbody className="divide-y divide-border">{bySource.slice(0, allSources ? undefined : 6).map(([s, v]) => <tr key={s}><td className="p-2"><span className="flex items-center gap-1"><Layers className="h-3 w-3 shrink-0 text-primary" />{s}</span></td><td className="p-2 text-right tabular-nums">{v.n.toLocaleString()}</td><td className="p-2 text-right tabular-nums whitespace-nowrap">{formatUGX(v.amount)}</td><td className="p-2 text-right tabular-nums">{share(v.amount)}</td></tr>)}</tbody></table></div>
        {!bySource.length && <p className="py-5 text-xs text-muted-foreground">No items.</p>}
      </Panel>
    </div>

    <div className="grid items-start gap-3 xl:grid-cols-[1.4fr_1fr]">
      <Panel title="Receivables Risk">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <RiskCard label="Largest Overdue Balance" value={complete && overdueItems.length ? formatUGX(Math.max(...overdueItems.map((i) => i.amount))) : complete ? 'None' : 'Unavailable'} note="Largest dated item" tone="destructive" icon={AlertTriangle} />
          <RiskCard label="Overdue Accounts" value={complete ? `${overdueItems.length} accounts` : 'Unavailable'} note="Past due date" tone="warning" icon={Clock3} />
          <RiskCard label="Due Within 7 Days" value={complete ? `${upcoming.filter((i) => Date.parse(day(i.due_date)!) - Date.parse(today) <= 7 * 86400000).length} accounts` : 'Unavailable'} note="Scheduled items" tone="primary" icon={CalendarDays} />
          <RiskCard label="Longest Outstanding" value={longest === undefined ? 'Unavailable' : `${longest} days`} note="Beyond due date" tone="primary" icon={Hourglass} />
        </div>
      </Panel>
      <Panel title="Upcoming Due Dates">
        {upcoming.length === 0 ? <p className="text-xs text-muted-foreground">No dated items.</p> : <ul className="divide-y divide-border">{upcoming.slice(0, 4).map((i) => <li key={i.item_id} className="flex items-center justify-between gap-3 py-2 text-[10px]"><span className="min-w-0 truncate font-medium">{i.counterparty ?? '—'}</span><span className="whitespace-nowrap text-muted-foreground">{day(i.due_date)}</span><span className="whitespace-nowrap tabular-nums">{formatUGX(i.amount)}</span></li>)}</ul>}
      </Panel>
    </div>
  </div>;
}

function KeyRow({ icon: Icon, label, value, note }: { icon: typeof Users; label: string; value: string; note: string }) {
  return <div className="flex items-start gap-3 py-3"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"><Icon className="h-4 w-4" /></span><div className="min-w-0"><p className="text-[10px] text-muted-foreground">{label}</p><p className="break-words text-xs font-semibold tabular-nums">{value}</p>{note && <p className="text-[9px] text-muted-foreground">{note}</p>}</div></div>;
}
