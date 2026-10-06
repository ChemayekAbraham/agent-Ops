import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  TrendingUp, TrendingDown, ArrowLeftRight, CalendarClock, ChevronRight,
  Lightbulb, AlertTriangle, Info, Building2, Users, Home, Handshake, Package,
} from 'lucide-react';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell,
} from 'recharts';
import { formatUGX } from '@/lib/rentCalculations';
import {
  useReceivablesTotal, useReceivablesForecast, useReceivablesPredictiveForecast,
} from '@/hooks/useReceivables';
import { usePayablesTotal, usePayablesPredictiveForecast } from '@/hooks/usePayables';

/**
 * CFO Home — Receivables & Payables. Presentation only: every figure comes
 * from the same authoritative RPCs the drill-down sheets use.
 */
const SLICE_COLORS = [
  'hsl(var(--success))', 'hsl(var(--info))', 'hsl(var(--warning))',
  'hsl(var(--primary))', 'hsl(var(--destructive))', 'hsl(var(--muted-foreground))',
];
const CAT_ICONS = [Users, Handshake, Home, Building2, Package, Package];

const compact = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toFixed(0);
};
const signedUGX = (n: number) => (n < 0 ? `UGX (${formatUGX(Math.abs(n)).replace(/^UGX\s*/, '')})` : formatUGX(n));
const pct = (v: number, t: number) => (t > 0 ? `${((v / t) * 100).toFixed(1)}%` : '0%');
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

type Cat = { key: string; label: string; outstanding: number; item_count: number };

export function CFOReceivablesPayablesHome() {
  const navigate = useNavigate();
  const rec = useReceivablesTotal();
  const pay = usePayablesTotal();
  const today = new Date();
  const in30 = new Date(Date.now() + 30 * 86400000);
  const forecast = useReceivablesForecast(isoDay(today), isoDay(in30));
  const recTrend = useReceivablesPredictiveForecast('day', 30);
  const payTrend = usePayablesPredictiveForecast('day', 30);

  const r = rec.data, p = pay.data;
  const money = (v: number | undefined, loaded: boolean) => (loaded ? formatUGX(Number(v ?? 0)) : '—');
  const net = (r?.total ?? 0) - (p?.total ?? 0);
  const exposure = (r?.total ?? 0) + (p?.total ?? 0);
  const inflow30 = forecast.data?.range_total;

  const trend = useMemo(() => {
    const map = new Map<string, { label: string; rec: number; pay: number }>();
    for (const h of recTrend.data?.history ?? [])
      map.set(h.period_start, { label: h.label, rec: Number(h.actual_amount), pay: 0 });
    for (const h of payTrend.data?.history ?? []) {
      const e = map.get(h.period_start) ?? { label: h.label, rec: 0, pay: 0 };
      e.pay = Number(h.actual_amount);
      map.set(h.period_start, e);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
  }, [recTrend.data, payTrend.data]);

  const recCats: Cat[] = [...(r?.categories ?? [])].sort((a, b) => b.outstanding - a.outstanding);
  const payCats: Cat[] = [...(p?.categories ?? [])].sort((a, b) => b.outstanding - a.outstanding);
  const spark = trend.slice(-8);

  return (
    <div className="space-y-4">
      {/* ── KPI row ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <Kpi
          icon={<TrendingUp className="h-4 w-4" />} tone="success" label="Total Receivables"
          value={money(r?.total, !!r)}
          foot={r ? `${r.item_count} open items` : 'Loading…'}
          percent={r ? pct(r.total, exposure) : undefined}
          percentLabel="of total money owed (receivables + payables)"
          spark={spark.map((s) => s.rec)}
          onClick={() => navigate('/cfo/receivables')} chevron
        />
        <Kpi
          icon={<TrendingDown className="h-4 w-4" />} tone="destructive" label="Total Payables"
          value={money(p?.total, !!p)}
          foot={p ? `${p.item_count} open obligations · overdue ${formatUGX(p.overdue)}` : 'Loading…'}
          percent={p ? pct(p.total, exposure) : undefined}
          percentLabel="of total money owed (receivables + payables)"
          spark={spark.map((s) => s.pay)}
        />
        <Kpi
          icon={<ArrowLeftRight className="h-4 w-4" />} tone="info" label="Net Position (Receivables − Payables)"
          value={r && p ? signedUGX(net) : '—'}
          foot={r && p ? (net < 0 ? 'Payables exceed receivables' : 'Receivables exceed payables') : 'Loading…'}
          percent={r && p && exposure > 0 ? `${((net / exposure) * 100).toFixed(1)}%` : undefined}
          percentLabel="net position as a share of total money owed"
        />
        <Kpi
          icon={<CalendarClock className="h-4 w-4" />} tone="primary" label="Expected Cash Inflow (Next 30 Days)"
          value={inflow30 === undefined ? '—' : formatUGX(inflow30)}
          foot="Scheduled + projected collections"
          percent={inflow30 !== undefined && r ? pct(inflow30, r.total) : undefined}
          percentLabel="of receivables expected to come in within 30 days"
        />
      </div>

      {/* ── Charts row ── */}
      <div className="grid grid-cols-1 xl:grid-cols-[1.2fr_1fr_1fr] gap-4 [&>*]:min-w-0">
        <Panel title="Receivables vs Payables Trend" right={
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
            <Dot c="hsl(var(--success))" /> Receivables <Dot c="hsl(var(--destructive))" /> Payables
          </div>
        }>
          <div className="h-56">
            {trend.length === 0 ? <Empty /> : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gRec" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--success))" stopOpacity={0.25} />
                      <stop offset="100%" stopColor="hsl(var(--success))" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gPay" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--destructive))" stopOpacity={0.25} />
                      <stop offset="100%" stopColor="hsl(var(--destructive))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} />
                  <YAxis tickFormatter={(v) => `UGX ${compact(v)}`} tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} width={70} />
                  <Tooltip formatter={(v: number) => formatUGX(v)} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                  <Area type="monotone" dataKey="pay" name="Payables" stroke="hsl(var(--destructive))" strokeWidth={2} fill="url(#gPay)" />
                  <Area type="monotone" dataKey="rec" name="Receivables" stroke="hsl(var(--success))" strokeWidth={2} fill="url(#gRec)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </Panel>
        <Donut title="Receivables by Category" total={r?.total ?? 0} cats={recCats} centerLabel="Total Receivables" />
        <Donut title="Payables by Category" total={p?.total ?? 0} cats={payCats} centerLabel="Total Payables" />
      </div>

      {/* ── Tables row ── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <CatTable title="Top Receivables" cats={recCats} total={r?.total ?? 0} count={r?.item_count ?? 0} totalLabel="Total Receivables" />
        <CatTable title="Top Payables" cats={payCats} total={p?.total ?? 0} count={p?.item_count ?? 0} totalLabel="Total Payables" />
      </div>

      {/* ── Key insights ── */}
      <div className="rounded-2xl border border-border/70 bg-card shadow-sm p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Insight icon={<Lightbulb className="h-4 w-4" />} title="Key Insights" sub="Quick view of your receivables and payables" tone="primary" />
        <Insight icon={<AlertTriangle className="h-4 w-4" />} tone="destructive"
          title={`Payables overdue ${p ? formatUGX(p.overdue) : '—'}`}
          sub={p ? `Due today ${formatUGX(p.due_today)}` : ''} />
        <Insight icon={<Info className="h-4 w-4" />} tone="info"
          title={`Net position is ${net < 0 ? 'negative' : 'positive'}`}
          sub={r && p ? `${net < 0 ? 'Payables exceed receivables' : 'Receivables exceed payables'} by UGX ${compact(Math.abs(net))}` : ''} />
        <Insight icon={<CalendarClock className="h-4 w-4" />} tone="primary"
          title="Next 30 days" sub={inflow30 === undefined ? '' : `${formatUGX(inflow30)} expected inflow`} />
      </div>
    </div>
  );
}

/* ── pieces ── */
const TONES: Record<string, string> = {
  success: 'bg-success/15 text-success',
  destructive: 'bg-destructive/15 text-destructive',
  info: 'bg-info/15 text-info',
  primary: 'bg-primary/15 text-primary',
};

const FOOT_TONES: Record<string, string> = {
  success: 'text-success',
  destructive: 'text-destructive',
  info: 'text-info',
  primary: 'text-primary',
};

function Kpi({ icon, tone, label, value, foot, percent, percentLabel, spark, onClick, chevron }: {
  icon: React.ReactNode; tone: string; label: string; value: string; foot: string;
  percent?: string; percentLabel?: string;
  spark?: number[]; onClick?: () => void; chevron?: boolean;
}) {
  const color = tone === 'destructive' ? 'hsl(var(--destructive))' : 'hsl(var(--success))';
  const data = (spark ?? []).map((v, i) => ({ i, v }));
  return (
    <button type="button" onClick={onClick} disabled={!onClick}
      className="text-left rounded-2xl border border-border/70 bg-card shadow-sm p-4 hover:shadow-md transition-shadow disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <div className="flex items-start justify-between">
        <span className={`h-8 w-8 rounded-lg flex items-center justify-center ${TONES[tone]}`}>{icon}</span>
        {chevron && <ChevronRight className="h-4 w-4 text-muted-foreground" />}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">{label}</p>
      <div className="mt-1 flex items-end justify-between gap-2">
        <p className="min-w-0 text-xl font-bold tabular-nums tracking-tight break-words">{value}</p>
        <div className="shrink-0 flex items-center gap-2">
          {percent && (
            <span
              className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${TONES[tone]}`}
              aria-label={percentLabel ? `${percent} ${percentLabel}` : percent}
              title={percentLabel}
            >
              {percent}
            </span>
          )}
          {data.length > 1 && (
            <div className="hidden 2xl:block">
              <AreaChart width={72} height={30} data={data}>
                <Area type="monotone" dataKey="v" stroke={color} fill={color} fillOpacity={0.12} strokeWidth={1.5} isAnimationActive={false} />
              </AreaChart>
            </div>
          )}
        </div>
      </div>
      <p className={`mt-2 text-[11px] font-medium ${FOOT_TONES[tone]}`}>{foot}</p>
    </button>
  );
}

function Panel({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card shadow-sm p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        {right}
      </div>
      {children}
    </div>
  );
}

const Dot = ({ c }: { c: string }) => <span className="inline-block h-2 w-2 rounded-full" style={{ background: c }} />;
const Empty = () => <div className="h-full flex items-center justify-center text-xs text-muted-foreground">No trend data yet</div>;

function Donut({ title, total, cats, centerLabel }: { title: string; total: number; cats: Cat[]; centerLabel: string }) {
  return (
    <Panel title={title}>
      <div className="flex items-center gap-3">
        <div className="relative h-36 w-36 shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={cats} dataKey="outstanding" nameKey="label" innerRadius="62%" outerRadius="100%" stroke="none">
                {cats.map((c, i) => <Cell key={c.key} fill={SLICE_COLORS[i % SLICE_COLORS.length]} />)}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <p className="text-sm font-bold tabular-nums">UGX {compact(total)}</p>
            <p className="text-[10px] text-muted-foreground">{centerLabel}</p>
          </div>
        </div>
        <ul className="flex-1 min-w-0 space-y-2">
          {cats.map((c, i) => (
            <li key={c.key} className="flex items-center gap-2 text-[11px]">
              <Dot c={SLICE_COLORS[i % SLICE_COLORS.length]} />
              <span className="flex-1 truncate">{c.label}</span>
              <span className="text-muted-foreground tabular-nums">{pct(c.outstanding, total)}</span>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

function CatTable({ title, cats, total, count, totalLabel }: {
  title: string; cats: Cat[]; total: number; count: number; totalLabel: string;
}) {
  return (
    <Panel title={title}>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-muted/40 text-muted-foreground">
              <th className="text-left font-medium px-3 py-2 rounded-l-lg">Category</th>
              <th className="text-right font-medium px-3 py-2">Outstanding (UGX)</th>
              <th className="text-right font-medium px-3 py-2">Open Items</th>
              <th className="text-right font-medium px-3 py-2 rounded-r-lg">% of Total</th>
            </tr>
          </thead>
          <tbody>
            {cats.map((c, i) => {
              const Icon = CAT_ICONS[i % CAT_ICONS.length];
              return (
                <tr key={c.key} className="border-b border-border/50">
                  <td className="px-3 py-2.5">
                    <span className="inline-flex items-center gap-2">
                      <span className="h-5 w-5 rounded flex items-center justify-center" style={{ background: SLICE_COLORS[i % SLICE_COLORS.length] }}>
                        <Icon className="h-3 w-3 text-background" />
                      </span>
                      {c.label}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{new Intl.NumberFormat('en-US').format(Math.round(c.outstanding))}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{c.item_count.toLocaleString()}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{pct(c.outstanding, total)}</td>
                </tr>
              );
            })}
            <tr className="font-semibold">
              <td className="px-3 py-2.5">{totalLabel}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{new Intl.NumberFormat('en-US').format(Math.round(total))}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{count.toLocaleString()}</td>
              <td className="px-3 py-2.5 text-right">100%</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function Insight({ icon, title, sub, tone }: { icon: React.ReactNode; title: string; sub: string; tone: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className={`h-8 w-8 rounded-full flex items-center justify-center shrink-0 ${TONES[tone]}`}>{icon}</span>
      <div className="min-w-0">
        <p className="text-xs font-semibold">{title}</p>
        <p className="text-[11px] text-muted-foreground">{sub}</p>
      </div>
    </div>
  );
}
