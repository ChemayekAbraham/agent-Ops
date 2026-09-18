import { useMemo } from 'react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { formatUGX } from '@/lib/rentCalculations';
import {
  buildTopupBacktest,
  BACKTEST_MIN_BASIS,
  DEFAULT_TOPUP_SETTINGS,
  type TopupHistoryPeriod,
  type TopupModelSettings,
} from '@/lib/topupBacktest';

/**
 * How the top-up prediction would have performed: for every completed period it
 * replays the model on the periods before it and compares that prediction with
 * the amount actually received.
 */
export function TopupBacktestPanel({
  periods,
  settings = DEFAULT_TOPUP_SETTINGS,
}: {
  periods: TopupHistoryPeriod[];
  settings?: TopupModelSettings;
}) {
  const backtest = useMemo(() => buildTopupBacktest(periods, settings), [periods, settings]);

  if (!backtest.rows.length) {
    return (
      <div className="rounded-xl border border-dashed border-border p-3">
        <p className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1">
          Prediction accuracy
        </p>
        <p className="text-[11px] text-muted-foreground">
          Needs at least {BACKTEST_MIN_BASIS + 1} completed periods in the selected window before
          past predictions can be checked against what was received.
        </p>
      </div>
    );
  }

  const chartData = backtest.rows.map((r) => ({
    label: r.label,
    Predicted: r.predicted,
    Received: r.actual,
    Difference: r.variance,
  }));

  return (
    <div className="rounded-xl border border-border p-3 space-y-3">
      <div>
        <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
          Prediction accuracy — predicted vs received top-ups
        </p>
        <p className="text-[11px] text-muted-foreground">
          Each completed period is predicted using only the periods before it, then compared with
          the amount actually received.
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        <Mini label="Predicted (all tested periods)" value={formatUGX(backtest.predictedTotal)} />
        <Mini label="Actually received" value={formatUGX(backtest.actualTotal)} tone="emerald" />
        <Mini
          label="Average miss"
          value={backtest.mape === null ? '—' : `${Math.round(backtest.mape)}%`}
          sub={
            backtest.withinBandPct === null
              ? undefined
              : `${Math.round(backtest.withinBandPct)}% within 20%`
          }
        />
        <Mini
          label={backtest.bias >= 0 ? 'Predicted too low by' : 'Predicted too high by'}
          value={formatUGX(Math.abs(backtest.bias))}
          tone={backtest.bias >= 0 ? 'emerald' : 'rose'}
        />
      </div>

      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
            <YAxis
              tick={{ fontSize: 10 }}
              width={70}
              tickFormatter={(v) => new Intl.NumberFormat('en-UG').format(Number(v))}
            />
            <Tooltip
              formatter={(v: any, name: any) => [formatUGX(Number(v)), name]}
              contentStyle={{ fontSize: 11 }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="Received" fill="hsl(152 60% 40%)" radius={[3, 3, 0, 0]} />
            <Line
              type="monotone"
              dataKey="Predicted"
              stroke="hsl(199 89% 48%)"
              strokeWidth={2}
              strokeDasharray="3 3"
              dot={{ r: 3 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-widest text-muted-foreground">
              <th className="py-2 pr-3 font-semibold">Period</th>
              <th className="py-2 pr-3 font-semibold text-right">Predicted</th>
              <th className="py-2 pr-3 font-semibold text-right">Received</th>
              <th className="py-2 pr-3 font-semibold text-right">Difference</th>
              <th className="py-2 pr-3 font-semibold text-right">Miss</th>
              <th className="py-2 font-semibold text-right">Built from</th>
            </tr>
          </thead>
          <tbody>
            {backtest.rows.map((r) => (
              <tr key={r.key} className="border-t border-border/60">
                <td className="py-2 pr-3 font-medium">{r.label}</td>
                <td className="py-2 pr-3 text-right font-mono tabular-nums">{formatUGX(r.predicted)}</td>
                <td className="py-2 pr-3 text-right font-mono tabular-nums">{formatUGX(r.actual)}</td>
                <td
                  className={`py-2 pr-3 text-right font-mono tabular-nums ${
                    r.variance >= 0 ? 'text-emerald-600' : 'text-rose-600'
                  }`}
                >
                  {formatUGX(r.variance)}
                </td>
                <td className="py-2 pr-3 text-right font-mono tabular-nums text-muted-foreground">
                  {r.errorPct === null ? '—' : `${Math.round(r.errorPct)}%`}
                </td>
                <td className="py-2 text-right font-mono tabular-nums text-muted-foreground">
                  {r.basis} period{r.basis === 1 ? '' : 's'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Mini({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'emerald' | 'rose';
}) {
  const toneClass = tone === 'emerald' ? 'text-emerald-600' : tone === 'rose' ? 'text-rose-600' : '';
  return (
    <div className="rounded-lg border border-border p-2.5">
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</p>
      <p className={`text-sm font-bold font-mono tabular-nums ${toneClass}`}>{value}</p>
      {sub ? <p className="text-[10px] text-muted-foreground font-mono">{sub}</p> : null}
    </div>
  );
}
