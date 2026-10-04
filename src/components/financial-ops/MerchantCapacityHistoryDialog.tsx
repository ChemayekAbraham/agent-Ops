import { useMemo, useState } from 'react';
import { format } from 'date-fns';
import { Gauge, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatUGX } from '@/lib/rentCalculations';
import {
  useMerchantFloatAllocationEvidence,
  type MerchantFloatAllocationRow,
} from '@/hooks/useMerchantAgentFloatAllocation';
import {
  buildMerchantCapacityHistory,
  summariseCapacityHistory,
} from '@/lib/merchantCapacityHistory';

const WINDOWS = [30, 60, 90] as const;

/**
 * Agent capacity history — read-only view of how one merchant desk's qualified
 * UGX/day has moved, derived from the ledger-verified payout evidence for that
 * desk. One query per open, no writes.
 */
export function MerchantCapacityHistoryDialog({
  open,
  onOpenChange,
  agentId,
  agentName,
  performance,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  agentId: string | null;
  agentName: string;
  performance: MerchantFloatAllocationRow | undefined;
}) {
  const [days, setDays] = useState<number>(30);
  const { data: evidence, isLoading } = useMerchantFloatAllocationEvidence(agentId, days, open);

  const points = useMemo(
    () => buildMerchantCapacityHistory(evidence ?? [], performance, { days }),
    [evidence, performance, days],
  );
  const summary = useMemo(() => summariseCapacityHistory(points), [points]);

  const chartData = points.map((p) => ({
    ...p,
    label: format(new Date(p.date), 'd MMM'),
  }));

  const TrendIcon =
    summary?.direction === 'up' ? TrendingUp : summary?.direction === 'down' ? TrendingDown : Minus;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Gauge className="h-4 w-4 text-primary" />
            Capacity history — {agentName}
          </DialogTitle>
        </DialogHeader>

        <p className="text-[11px] text-muted-foreground">
          Qualified daily capacity on each day, rebuilt from this desk's verified payout record.
          Read-only — nothing here moves or reserves money.
        </p>

        <div className="flex flex-wrap items-center gap-1.5">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setDays(w)}
              className={`rounded-full border px-3 py-1 text-[11px] font-semibold ${
                days === w
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              Last {w} days
            </button>
          ))}
        </div>

        {isLoading ? (
          <p className="py-10 text-center text-xs text-muted-foreground">Loading payout record…</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Qualifies now" value={formatUGX(summary?.last ?? 0)} />
              <Stat label={`${days} days ago`} value={formatUGX(summary?.first ?? 0)} />
              <Stat label="Peak in window" value={formatUGX(summary?.peak ?? 0)} />
              <Stat
                label="Change"
                value={`${(summary?.change ?? 0) >= 0 ? '+' : '−'}${formatUGX(
                  Math.abs(summary?.change ?? 0),
                )}`}
                tone={
                  summary?.direction === 'up'
                    ? 'text-success'
                    : summary?.direction === 'down'
                      ? 'text-destructive'
                      : undefined
                }
                icon={<TrendIcon className="h-3 w-3" />}
              />
            </div>

            <div className="rounded-xl border border-border bg-background p-2">
              <p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Qualified UGX/day over time
              </p>
              <div className="h-56 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                    <YAxis
                      tick={{ fontSize: 10 }}
                      width={54}
                      tickFormatter={(v) => `${Math.round(Number(v) / 1000)}k`}
                    />
                    <ChartTooltip
                      formatter={(v: number) => formatUGX(Number(v))}
                      labelClassName="text-xs"
                      contentStyle={{ fontSize: 11 }}
                    />
                    <Area
                      type="monotone"
                      dataKey="capacity"
                      name="Qualified/day"
                      stroke="hsl(var(--primary))"
                      fill="hsl(var(--primary) / 0.15)"
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="rounded-xl border border-border bg-background p-2">
              <p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Verified payouts per day vs trailing average
              </p>
              <div className="h-44 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                    <YAxis
                      tick={{ fontSize: 10 }}
                      width={54}
                      tickFormatter={(v) => `${Math.round(Number(v) / 1000)}k`}
                    />
                    <ChartTooltip
                      formatter={(v: number) => formatUGX(Number(v))}
                      contentStyle={{ fontSize: 11 }}
                    />
                    <Bar dataKey="paidThatDay" name="Paid out" fill="hsl(var(--muted-foreground) / 0.4)" />
                    <Area
                      type="monotone"
                      dataKey="trailingDailyThroughput"
                      name="Trailing avg/day"
                      stroke="hsl(var(--warning))"
                      fill="hsl(var(--warning) / 0.12)"
                      strokeWidth={2}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="overflow-hidden rounded-xl border border-border">
              <div className="max-h-64 overflow-y-auto">
                <table className="w-full text-left text-[11px]">
                  <thead className="sticky top-0 bg-muted/60 text-[10px] uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1.5">Day</th>
                      <th className="px-2 py-1.5 text-right">Qualified/day</th>
                      <th className="px-2 py-1.5 text-right">Paid out</th>
                      <th className="px-2 py-1.5 text-right">Payouts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...points].reverse().map((p) => (
                      <tr key={p.date} className="border-t border-border">
                        <td className="px-2 py-1.5">{format(new Date(p.date), 'd MMM yyyy')}</td>
                        <td className="px-2 py-1.5 text-right font-mono font-semibold tabular-nums">
                          {formatUGX(p.capacity)}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                          {formatUGX(p.paidThatDay)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                          {p.payoutsThatDay}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <p className="text-[10px] text-muted-foreground">
              Active days with at least one verified payout: {summary?.activeDays ?? 0} of{' '}
              {points.length}. Capacity applies this desk's current standing
              {performance?.blocker ? ` (blocked — ${performance.blocker})` : ''} to its trailing
              30-day payout average.
            </p>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Stat({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: string;
  tone?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-background px-2.5 py-2">
      <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p
        className={`mt-0.5 flex items-center gap-1 font-mono text-sm font-bold tabular-nums ${
          tone ?? 'text-foreground'
        }`}
      >
        {icon}
        {value}
      </p>
    </div>
  );
}
