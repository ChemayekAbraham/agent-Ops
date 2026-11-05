import { useState } from 'react';
import { Wallet, CalendarDays, TrendingUp, RefreshCw, BarChart2 } from 'lucide-react';
import {
  ResponsiveContainer,
  ComposedChart,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Bar,
  Line,
  Legend,
} from 'recharts';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  RECEIVABLE_FORECAST_PERIODS,
  useReceivablesProjection,
} from '@/hooks/useReceivablesProjection';
import { formatUGX } from '@/lib/rentCalculations';

const money = (value: number | null) => (value == null ? 'Unavailable' : formatUGX(value));

const compact = (value: number) => {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(0)}K`;
  return value.toFixed(0);
};

export default function ReceivablesProjection() {
  const [id, setId] = useState('7d');
  const { period, daily, rows, historyQ, contractQ } = useReceivablesProjection(id);

  const behavior = rows.every((r) => r.behavior != null)
    ? rows.reduce((sum, r) => sum + (r.behavior ?? 0), 0)
    : null;

  const contract = rows.every((r) => r.contract != null)
    ? rows.reduce((sum, r) => sum + (r.contract ?? 0), 0)
    : null;

  const loading = historyQ.isLoading || contractQ.isLoading;

  return (
    <div className="space-y-5">
      {/* Period Selection Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="tablist"
          aria-label="Forecast period"
          className="inline-flex flex-wrap items-center gap-1.5 rounded-xl border border-border/70 bg-card/60 p-1.5 shadow-2xs backdrop-blur-xs"
        >
          {RECEIVABLE_FORECAST_PERIODS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={id === p.id}
              onClick={() => setId(p.id)}
              className={`rounded-lg px-3.5 py-1.5 text-xs font-medium transition-all ${
                id === p.id
                  ? 'bg-primary text-primary-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/80'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        <Badge variant="outline" className="text-[11px] font-medium py-1 px-2.5 border-border/80">
          Viewing: {period.label} Horizon
        </Badge>
      </div>

      {loading ? (
        <Panel>
          <div className="py-12 text-center">
            <RefreshCw className="mx-auto h-6 w-6 animate-spin text-muted-foreground" />
            <p className="mt-3 text-xs font-medium text-muted-foreground">Generating projection models…</p>
          </div>
        </Panel>
      ) : historyQ.isError || contractQ.isError ? (
        <Panel>
          <div className="py-8 text-center space-y-3">
            <p className="text-xs font-semibold text-destructive">Projection models unavailable. Please refresh.</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void historyQ.refetch();
                void contractQ.refetch();
              }}
              className="gap-1.5"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </Button>
          </div>
        </Panel>
      ) : (
        <>
          {/* Executive KPI Summary */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
            <Metric
              label="Behavior Projection"
              value={money(behavior)}
              note="Based on historical counterparty collection velocity"
              icon={Wallet}
              tone="primary"
            />
            <Metric
              label="Ideal Contract Schedule"
              value={money(contract)}
              note="Scheduled contractual maturities"
              icon={CalendarDays}
              tone="success"
            />
            <Metric
              label={daily ? 'Daily Runoff Average' : 'Monthly Runoff Average'}
              value={money(behavior == null || rows.length === 0 ? null : behavior / rows.length)}
              note={`Projected average collections per ${daily ? 'day' : 'month'}`}
              icon={TrendingUp}
              tone="warning"
            />
          </div>

          {/* Projection Chart */}
          <Panel
            title={`Receivables Runoff Model — ${period.label}`}
            subtitle="Comparing empirical behavior-based projection against scheduled contract maturities"
            right={
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-xs bg-primary" /> Behavior projection
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-1.5 w-3 rounded-full bg-emerald-500" /> Ideal (contract)
                </span>
              </div>
            }
          >
            <div className="h-60 w-full rounded-xl bg-muted/20 p-2">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={rows} margin={{ top: 12, right: 8, left: -10, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    tickFormatter={compact}
                    tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip formatter={(v: number) => formatUGX(v)} />
                  <Bar
                    dataKey="behavior"
                    name="Behavior projection"
                    fill="hsl(var(--primary))"
                    maxBarSize={32}
                    radius={[4, 4, 0, 0]}
                  />
                  <Line
                    dataKey="contract"
                    name="Ideal (contract)"
                    stroke="#10b981"
                    strokeWidth={2.5}
                    dot={{ r: 3, fill: '#10b981' }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </Panel>

          {/* Breakdown Table */}
          <Panel
            title={daily ? 'Day-by-Day Projection Schedule' : 'Month-by-Month Projection Schedule'}
            subtitle="Periodic breakdown of modelled receipts against contractual maturity targets"
          >
            <div className="overflow-x-auto -mx-4 -mb-4 px-4 pb-4">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border/60 text-[11px] text-muted-foreground">
                    <th className="py-2.5 text-left font-medium">{daily ? 'Date' : 'Month'}</th>
                    <th className="py-2.5 text-right font-medium">Behavior Projection (UGX)</th>
                    <th className="py-2.5 text-right font-medium">Ideal Contract (UGX)</th>
                    <th className="py-2.5 text-right font-medium">Variance (UGX)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {rows.map((r) => {
                    const variance = r.behavior != null && r.contract != null ? r.behavior - r.contract : null;
                    return (
                      <tr key={r.key} className="hover:bg-muted/40 transition-colors">
                        <td className="py-2.5 font-medium text-foreground">{r.date}</td>
                        <td className="py-2.5 text-right tabular-nums font-semibold text-foreground">
                          {money(r.behavior)}
                        </td>
                        <td className="py-2.5 text-right tabular-nums text-muted-foreground">
                          {money(r.contract)}
                        </td>
                        <td className="py-2.5 text-right tabular-nums">
                          {variance != null ? (
                            <span
                              className={`text-[11px] font-medium ${
                                variance >= 0
                                  ? 'text-emerald-600 dark:text-emerald-400'
                                  : 'text-rose-600 dark:text-rose-400'
                              }`}
                            >
                              {variance >= 0 ? `+${money(variance)}` : money(variance)}
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-border/80 bg-muted/20 font-bold text-foreground">
                    <td className="py-3">Total Projection</td>
                    <td className="py-3 text-right tabular-nums text-foreground">{money(behavior)}</td>
                    <td className="py-3 text-right tabular-nums text-muted-foreground">{money(contract)}</td>
                    <td className="py-3 text-right tabular-nums">
                      {behavior != null && contract != null ? (
                        <span
                          className={`text-xs ${
                            behavior - contract >= 0
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-rose-600 dark:text-rose-400'
                          }`}
                        >
                          {behavior - contract >= 0
                            ? `+${money(behavior - contract)}`
                            : money(behavior - contract)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}

function Panel({
  title,
  subtitle,
  right,
  children,
}: {
  title?: string;
  subtitle?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-xl border border-border/80 bg-card p-4 shadow-xs">
      {title && (
        <div className="mb-3.5 flex flex-wrap items-center justify-between gap-2 border-b border-border/40 pb-2.5">
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-foreground">{title}</h2>
            {subtitle && <p className="text-[11px] text-muted-foreground mt-0.5">{subtitle}</p>}
          </div>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

function Metric({
  label,
  value,
  note,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  note: string;
  icon: typeof Wallet;
  tone: 'primary' | 'success' | 'warning';
}) {
  const toneMap = {
    primary: {
      border: 'border-border/80 hover:border-primary/40',
      iconBg: 'bg-primary/10 text-primary',
    },
    success: {
      border: 'border-border/80 hover:border-emerald-500/40',
      iconBg: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    },
    warning: {
      border: 'border-border/80 hover:border-amber-500/40',
      iconBg: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    },
  };

  const style = toneMap[tone];

  return (
    <div
      className={`min-w-0 rounded-xl border bg-card p-4 shadow-2xs transition-all duration-200 ${style.border}`}
    >
      <div className="mb-2.5 flex items-center gap-2">
        <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${style.iconBg}`}>
          <Icon className="h-4 w-4" />
        </div>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">
          {label}
        </span>
      </div>
      <p className="text-base font-bold tabular-nums text-foreground truncate" title={value}>
        {value}
      </p>
      <p className="mt-1 text-[10px] text-muted-foreground/80 truncate">{note}</p>
    </div>
  );
}
