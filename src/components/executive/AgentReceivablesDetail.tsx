import { useState, useMemo } from 'react';
import {
  AlertTriangle, CalendarDays, CheckCircle2, ChevronRight, Clock3,
  Coins, Users, UserRound, Hourglass, Layers
} from 'lucide-react';
import {
  Bar, CartesianGrid, Cell, ComposedChart, Legend, Line, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis
} from 'recharts';
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
const short = (v: number) =>
  Math.abs(v) >= 1e9
    ? `${(v / 1e9).toFixed(2)}B`
    : Math.abs(v) >= 1e6
    ? `${(v / 1e6).toFixed(1)}M`
    : `${(v / 1e3).toFixed(0)}K`;

const day = (d?: string | null) => d?.slice(0, 10);

export default function AgentReceivablesDetail({
  product,
  current,
  overdue,
  complete,
  today,
  forecast,
  behaviourTotal,
  idealTotal,
  arrears,
}: Props) {
  const [allAccounts, setAllAccounts] = useState(false);
  const [allSources, setAllSources] = useState(false);

  const items = product.items;
  const sorted = useMemo(() => [...items].sort((a, b) => b.amount - a.amount), [items]);
  const share = (v: number) =>
    product.outstanding > 0 ? `${((v / product.outstanding) * 100).toFixed(1)}%` : '0.0%';

  const overdueItems = useMemo(
    () => items.filter((i) => !!i.due_date && day(i.due_date)! < today),
    [items, today]
  );
  const isOverdue = (d?: string | null) => !!d && day(d)! < today;

  const bySource = useMemo(() => {
    const counts = items.reduce<Record<string, { amount: number; n: number }>>((m, i) => {
      const e = (m[i.source] ??= { amount: 0, n: 0 });
      e.amount += i.amount;
      e.n++;
      return m;
    }, {});
    return Object.entries(counts).sort((a, b) => b[1].amount - a[1].amount);
  }, [items]);

  const distribution = useMemo(() => {
    if (current === undefined || overdue === undefined) return [];
    return [
      { label: 'Current (Performing)', amount: current, color: '#10b981' },
      { label: 'Overdue (Arrears)', amount: overdue, color: '#f43f5e' },
    ];
  }, [current, overdue]);

  const largest = sorted[0];
  const avg = product.item_count > 0 ? product.outstanding / product.item_count : undefined;
  const longest = overdueItems.length
    ? Math.max(...overdueItems.map((i) => Math.floor((Date.parse(today) - Date.parse(day(i.due_date)!)) / 86400000)))
    : undefined;

  const currentPct = current !== undefined && product.outstanding > 0 ? (current / product.outstanding) * 100 : null;
  const overduePct = overdue !== undefined && product.outstanding > 0 ? (overdue / product.outstanding) * 100 : null;

  return (
    <div className="agent-receivables-detail space-y-5">
      {/* 1. TOP EXECUTIVE KPI STRIP (4 Cards) */}
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Total Outstanding"
          value={formatUGX(product.outstanding)}
          note="Gross product receivables"
          icon={Coins}
          tone="primary"
          badge="Book Value"
        />
        <MetricCard
          label="Active Accounts"
          value={product.item_count.toLocaleString()}
          note={complete ? 'Full ledger verified' : `Sample: ${items.length} accounts`}
          icon={Users}
          tone="info"
          badge="Counterparties"
        />
        <MetricCard
          label="Current (Performing)"
          value={amount(current)}
          note={currentPct != null ? `${currentPct.toFixed(1)}% of product · Performing` : 'Not yet due'}
          icon={CheckCircle2}
          tone="success"
          badge="Healthy"
        />
        <MetricCard
          label="Overdue in Arrears"
          value={amount(overdue)}
          note={overduePct != null ? `${overduePct.toFixed(1)}% delinquency rate` : 'Past contractual date'}
          icon={Clock3}
          tone="destructive"
          badge="At Risk"
        />
      </div>

      {/* 2. COLLECTION FORECAST & CAPITAL DISTRIBUTION */}
      <div className="grid gap-5 xl:grid-cols-2 [&>*]:min-w-0">
        {/* 7-Day Collection Forecast */}
        <Panel
          title="7-Day Collection Forecast"
          subtitle="Empirical runoff velocity vs. scheduled contractual maturities"
          right={
            <div className="flex items-center gap-2.5 text-[11px] text-muted-foreground font-medium">
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-xs bg-primary" /> Behavioural runoff
              </span>
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-3 rounded-full bg-emerald-500" /> Ideal scheduled
              </span>
            </div>
          }
        >
          <div className="h-52 w-full rounded-xl bg-muted/20 p-2">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={forecast} margin={{ top: 10, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeDasharray="2 2" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  width={56}
                  tickFormatter={short}
                  tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip formatter={(v: number) => formatUGX(v)} />
                <Bar
                  dataKey="behaviour"
                  name="Behaviour-based"
                  fill="hsl(var(--primary))"
                  maxBarSize={32}
                  radius={[4, 4, 0, 0]}
                />
                <Line
                  dataKey="ideal"
                  name="Ideal Scheduled"
                  stroke="#10b981"
                  strokeWidth={2.5}
                  dot={{ r: 3, fill: '#10b981' }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span>Modelled 7-Day Inflow: <strong className="text-foreground">{amount(behaviourTotal)}</strong></span>
            <span>Contractual Maturity: <strong className="text-foreground">{amount(idealTotal)}</strong></span>
          </div>
          {arrears ? (
            <p className="mt-1 text-[10px] text-amber-600 dark:text-amber-400">
              Note: Overdue arrears of {formatUGX(arrears)} are excluded from upcoming scheduled maturities.
            </p>
          ) : null}
        </Panel>

        {/* Portfolio Distribution & Key Metrics */}
        <Panel
          title="Portfolio Distribution & Credit Risk"
          subtitle="Capital health breakdown and single-counterparty exposure"
        >
          <div className="grid grid-cols-1 sm:grid-cols-[140px_minmax(0,1fr)] items-center gap-5">
            {/* Donut Chart */}
            <div className="relative h-36 w-36 mx-auto shrink-0">
              {distribution.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={distribution}
                      dataKey="amount"
                      nameKey="label"
                      innerRadius="68%"
                      outerRadius="92%"
                      paddingAngle={2}
                      stroke="hsl(var(--card))"
                      strokeWidth={2}
                    >
                      {distribution.map((entry) => (
                        <Cell key={entry.label} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(v: number) => formatUGX(v)} />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                  No breakdown
                </div>
              )}
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Total</span>
                <span className="text-sm font-bold tabular-nums text-foreground">{short(product.outstanding)}</span>
                <span className="text-[9px] text-muted-foreground">UGX</span>
              </div>
            </div>

            {/* 3 Executive Risk Metrics */}
            <div className="space-y-2.5">
              <div className="p-2.5 rounded-lg bg-muted/40 border border-border/60">
                <div className="flex items-center justify-between text-xs mb-0.5">
                  <span className="text-muted-foreground">Largest Single Exposure</span>
                  <span className="font-semibold text-foreground tabular-nums">
                    {largest ? formatUGX(largest.amount) : '—'}
                  </span>
                </div>
                <p className="text-[10px] text-muted-foreground truncate">
                  {largest ? `${share(largest.amount)} of total · ${largest.counterparty ?? 'Unnamed'}` : 'No accounts recorded'}
                </p>
              </div>

              <div className="p-2.5 rounded-lg bg-muted/40 border border-border/60">
                <div className="flex items-center justify-between text-xs mb-0.5">
                  <span className="text-muted-foreground">Average Account Balance</span>
                  <span className="font-semibold text-foreground tabular-nums">
                    {avg !== undefined ? formatUGX(Math.round(avg)) : '—'}
                  </span>
                </div>
                <p className="text-[10px] text-muted-foreground">Per active counterparty line</p>
              </div>

              <div className="p-2.5 rounded-lg bg-amber-500/5 border border-amber-500/20">
                <div className="flex items-center justify-between text-xs mb-0.5">
                  <span className="text-amber-600 dark:text-amber-400 font-medium">Maximum Aging Duration</span>
                  <span className="font-bold text-foreground tabular-nums">
                    {longest !== undefined ? `${longest} days` : '0 days'}
                  </span>
                </div>
                <p className="text-[10px] text-muted-foreground">Days beyond contractual maturity</p>
              </div>
            </div>
          </div>
        </Panel>
      </div>

      {/* 3. ACTIONABLE LEDGERS: TOP ACCOUNTS & SOURCE CHANNELS */}
      <div className="grid gap-5 xl:grid-cols-2 [&>*]:min-w-0">
        {/* Top Accounts Ledger */}
        <Panel
          title="Top Accounts by Outstanding Balance"
          subtitle="Ranked list of highest counterparty exposures"
          action={
            sorted.length > 5 ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setAllAccounts(!allAccounts)}
                className="h-6 px-2 text-[10px] text-primary hover:text-primary hover:bg-primary/10"
              >
                {allAccounts ? 'Show Top 5' : `View All (${sorted.length})`}
                <ChevronRight className="h-3 w-3 ml-0.5" />
              </Button>
            ) : null
          }
        >
          <div className="overflow-x-auto -mx-4 -mb-4 px-4 pb-4">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border/60 text-[11px] text-muted-foreground">
                  <th className="py-2.5 text-left font-medium">#</th>
                  <th className="py-2.5 text-left font-medium">Counterparty</th>
                  <th className="py-2.5 text-right font-medium">Outstanding (UGX)</th>
                  <th className="py-2.5 text-left font-medium pl-3">Due Date</th>
                  <th className="py-2.5 text-left font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {sorted.slice(0, allAccounts ? undefined : 5).map((i, n) => {
                  const overdueFlag = isOverdue(i.due_date);
                  return (
                    <tr key={i.item_id} className="hover:bg-muted/40 transition-colors">
                      <td className="py-2.5 text-muted-foreground text-[11px]">{n + 1}</td>
                      <td className="py-2.5 font-medium text-foreground">
                        <div className="flex flex-col">
                          <span>{i.counterparty ?? 'Unnamed Account'}</span>
                          <span className="text-[10px] text-muted-foreground font-mono">{i.item_id.slice(0, 8)}</span>
                        </div>
                      </td>
                      <td className="py-2.5 text-right tabular-nums font-semibold text-foreground whitespace-nowrap">
                        {formatUGX(i.amount)}
                      </td>
                      <td className="py-2.5 pl-3 whitespace-nowrap text-muted-foreground tabular-nums text-[11px]">
                        {day(i.due_date) ?? 'Undated'}
                      </td>
                      <td className="py-2.5">
                        {i.due_date ? (
                          <span
                            className={`inline-flex rounded-md px-1.5 py-0.5 text-[10px] font-medium ${
                              overdueFlag ? 'bg-destructive/10 text-destructive' : 'bg-success/10 text-success'
                            }`}
                          >
                            {overdueFlag ? 'Overdue' : 'Current'}
                          </span>
                        ) : (
                          <span className="text-muted-foreground text-[10px]">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!sorted.length && (
            <p className="py-8 text-center text-xs text-muted-foreground">No accounts recorded for this product.</p>
          )}
        </Panel>

        {/* Source Channels Ledger */}
        <Panel
          title="Receivables by Source Channel"
          subtitle="Origination and recovery channels for this product"
          action={
            bySource.length > 5 ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setAllSources(!allSources)}
                className="h-6 px-2 text-[10px] text-primary hover:text-primary hover:bg-primary/10"
              >
                {allSources ? 'Show Top 5' : `View All (${bySource.length})`}
                <ChevronRight className="h-3 w-3 ml-0.5" />
              </Button>
            ) : null
          }
        >
          <div className="overflow-x-auto -mx-4 -mb-4 px-4 pb-4">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border/60 text-[11px] text-muted-foreground">
                  <th className="py-2.5 text-left font-medium">Source Channel</th>
                  <th className="py-2.5 text-right font-medium">Accounts</th>
                  <th className="py-2.5 text-right font-medium">Outstanding (UGX)</th>
                  <th className="py-2.5 text-right font-medium">Share</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {bySource.slice(0, allSources ? undefined : 5).map(([s, v]) => {
                  const pct = product.outstanding > 0 ? (v.amount / product.outstanding) * 100 : 0;
                  return (
                    <tr key={s} className="hover:bg-muted/40 transition-colors">
                      <td className="py-2.5 font-medium text-foreground">
                        <div className="flex items-center gap-2">
                          <Layers className="h-3.5 w-3.5 text-blue-500 shrink-0" />
                          <span>{s}</span>
                        </div>
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums text-muted-foreground">
                        {v.n.toLocaleString()}
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums font-semibold text-foreground whitespace-nowrap">
                        {formatUGX(v.amount)}
                      </td>
                      <td className="py-2.5 pl-2 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <span className="tabular-nums font-medium text-muted-foreground text-[11px]">
                            {share(v.amount)}
                          </span>
                          <div className="h-1.5 w-12 rounded-full bg-muted overflow-hidden">
                            <div
                              className="h-full rounded-full bg-blue-500"
                              style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
                            />
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!bySource.length && (
            <p className="py-8 text-center text-xs text-muted-foreground">No source channels recorded.</p>
          )}
        </Panel>
      </div>
    </div>
  );
}

function Panel({
  title,
  subtitle,
  right,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-xl border border-border/80 bg-card p-4 shadow-xs">
      <div className="mb-3.5 flex flex-wrap items-center justify-between gap-2 border-b border-border/40 pb-2.5">
        <div>
          <h2 className="text-xs font-semibold tracking-tight text-foreground uppercase">{title}</h2>
          {subtitle && <p className="text-[11px] text-muted-foreground mt-0.5">{subtitle}</p>}
        </div>
        {right || action}
      </div>
      {children}
    </section>
  );
}

function MetricCard({
  label,
  value,
  note,
  icon: Icon,
  tone,
  badge,
}: {
  label: string;
  value: string;
  note: string;
  icon: typeof Users;
  tone: 'primary' | 'success' | 'destructive' | 'info';
  badge?: string;
}) {
  const toneMap = {
    primary: {
      border: 'border-border/80 hover:border-primary/40',
      iconBg: 'bg-primary/10 text-primary',
      badge: 'bg-primary/10 text-primary',
    },
    success: {
      border: 'border-border/80 hover:border-emerald-500/40',
      iconBg: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
      badge: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    },
    destructive: {
      border: 'border-border/80 hover:border-rose-500/40',
      iconBg: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
      badge: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
    },
    info: {
      border: 'border-border/80 hover:border-blue-500/40',
      iconBg: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
      badge: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
    },
  };

  const style = toneMap[tone];

  return (
    <div
      className={`min-w-0 rounded-xl border bg-card p-4 shadow-2xs transition-all duration-200 ${style.border}`}
    >
      <div className="mb-2.5 flex items-center justify-between gap-1.5">
        <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${style.iconBg}`}>
          <Icon className="h-4 w-4" />
        </div>
        {badge && (
          <span className={`rounded-md px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${style.badge}`}>
            {badge}
          </span>
        )}
      </div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">
        {label}
      </p>
      <p className="mt-1 text-base lg:text-lg font-bold tabular-nums tracking-tight text-foreground truncate" title={value}>
        {value}
      </p>
      <p className="mt-1 text-[11px] text-muted-foreground/85 truncate">{note}</p>
    </div>
  );
}
