import { useMemo, useState } from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { TrendingUp } from 'lucide-react';
import { useTenantOpsPipelineTrend, type PipelineTrendPoint } from '@/hooks/useTenantOpsPipelineTrend';

type MetricKey = keyof Omit<PipelineTrendPoint, 'date' | 'fullDate'>;
type MetricKind = 'line' | 'bar';

interface MetricDef {
  key: MetricKey;
  label: string;
  color: string;
  kind: MetricKind;
  hint: string;
}

/**
 * Definitions mirror the server-side stamps exactly — nothing is re-derived here.
 * Colours are deliberately far apart on the wheel so no two metrics read alike:
 * indigo line, sky line, amber bar, emerald bar, violet line, neutral grey line.
 */
const METRICS: MetricDef[] = [
  { key: 'registrations', label: 'Registrations', color: '#4f46e5', kind: 'line', hint: 'New tenants registered that day' },
  { key: 'applications', label: 'Applications', color: '#0284c7', kind: 'line', hint: 'Rent Plan applications raised' },
  { key: 'cooApproved', label: 'COO approved', color: '#7c3aed', kind: 'line', hint: 'Applications approved by the COO' },
  { key: 'cfoFunded', label: 'CFO funded', color: '#d97706', kind: 'bar', hint: 'Applications funded by Finance' },
  { key: 'landlordFunded', label: 'Landlord funded', color: '#059669', kind: 'bar', hint: 'Landlord payouts disbursed' },
  { key: 'rejected', label: 'Rejected', color: '#94a3b8', kind: 'line', hint: 'Applications rejected' },
];

const RANGES = [
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
];

const DEFAULT_ON: MetricKey[] = ['registrations', 'applications', 'cfoFunded', 'landlordFunded'];

export function TenantOpsPipelineTrendChart({ className }: { className?: string }) {
  const [days, setDays] = useState(30);
  const [visible, setVisible] = useState<MetricKey[]>(DEFAULT_ON);
  const { data, isLoading } = useTenantOpsPipelineTrend(days);

  const rows = data ?? [];
  const totals = useMemo(() => {
    const acc = {} as Record<MetricKey, number>;
    METRICS.forEach((m) => {
      acc[m.key] = rows.reduce((s, r) => s + (r[m.key] as number), 0);
    });
    return acc;
  }, [rows]);

  const toggle = (key: MetricKey) =>
    setVisible((prev) =>
      prev.includes(key)
        ? prev.length > 1
          ? prev.filter((k) => k !== key)
          : prev
        : [...prev, key],
    );

  const active = METRICS.filter((m) => visible.includes(m.key));

  // Keep the axis readable on small screens by thinning tick labels.
  const tickInterval = days <= 7 ? 0 : days <= 30 ? 3 : 9;
  // Bars stay narrow so the trend lines remain the visual focus.
  const barSize = days <= 7 ? 14 : days <= 30 ? 8 : 4;

  return (
    <Card className={cn('overflow-hidden', className)}>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <TrendingUp className="h-4 w-4 text-primary" />
            Pipeline comparison
          </CardTitle>
          <div className="flex items-center gap-1 rounded-lg bg-muted p-1">
            {RANGES.map((r) => (
              <Button
                key={r.days}
                size="sm"
                variant={days === r.days ? 'default' : 'ghost'}
                className="h-7 px-3 text-xs"
                onClick={() => setDays(r.days)}
              >
                {r.label}
              </Button>
            ))}
          </div>
        </div>

        {/* Legend doubles as the show/hide control */}
        <div className="mt-2 flex flex-wrap gap-1.5 sm:gap-2">
          {METRICS.map((m) => {
            const on = visible.includes(m.key);
            return (
              <button
                key={m.key}
                type="button"
                onClick={() => toggle(m.key)}
                title={m.hint}
                aria-pressed={on}
                className={cn(
                  'flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] transition-colors sm:px-2.5 sm:text-xs',
                  on
                    ? 'border-border bg-card text-foreground shadow-sm'
                    : 'border-dashed border-border bg-muted/40 text-muted-foreground',
                )}
              >
                {m.kind === 'bar' ? (
                  <span
                    className="h-2.5 w-2 shrink-0 rounded-[2px]"
                    style={{ backgroundColor: on ? m.color : 'hsl(var(--muted-foreground))' }}
                  />
                ) : (
                  <span
                    className="h-0.5 w-3 shrink-0 rounded-full"
                    style={{ backgroundColor: on ? m.color : 'hsl(var(--muted-foreground))' }}
                  />
                )}
                <span className="whitespace-nowrap">{m.label}</span>
                <span className="font-semibold tabular-nums">{totals[m.key] ?? 0}</span>
              </button>
            );
          })}
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        {isLoading && rows.length === 0 ? (
          <Skeleton className="h-[240px] w-full rounded-lg" />
        ) : rows.length === 0 ? (
          <div className="flex h-[240px] items-center justify-center text-sm text-muted-foreground">
            No activity in this period yet
          </div>
        ) : (
          <div className="h-[260px] w-full sm:h-[320px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={rows} margin={{ top: 8, right: 8, left: -18, bottom: 0 }} barCategoryGap="28%">
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" strokeOpacity={0.5} vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                  interval={tickInterval}
                  tickMargin={8}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={12}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                  allowDecimals={false}
                  axisLine={false}
                  tickLine={false}
                  width={44}
                />
                <Tooltip
                  cursor={{ fill: 'hsl(var(--muted))', fillOpacity: 0.35 }}
                  contentStyle={{
                    background: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: 12,
                    fontSize: 12,
                    color: 'hsl(var(--foreground))',
                    boxShadow: '0 8px 24px -12px hsl(var(--foreground) / 0.25)',
                  }}
                  labelStyle={{ fontWeight: 600, marginBottom: 4 }}
                  itemStyle={{ paddingTop: 1, paddingBottom: 1 }}
                  labelFormatter={(_label, payload) =>
                    (payload?.[0]?.payload as PipelineTrendPoint | undefined)?.fullDate ?? ''
                  }
                />
                {active
                  .filter((m) => m.kind === 'bar')
                  .map((m) => (
                    <Bar
                      key={m.key}
                      dataKey={m.key}
                      name={m.label}
                      fill={m.color}
                      fillOpacity={0.75}
                      radius={[3, 3, 0, 0]}
                      barSize={barSize}
                      maxBarSize={16}
                    />
                  ))}
                {active
                  .filter((m) => m.kind === 'line')
                  .map((m) => (
                    <Line
                      key={m.key}
                      type="monotone"
                      dataKey={m.key}
                      name={m.label}
                      stroke={m.color}
                      strokeWidth={2.25}
                      dot={false}
                      activeDot={{ r: 4, strokeWidth: 0 }}
                    />
                  ))}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
        <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
          Tap a label to show or hide a metric. Lines track volume stages (registrations,
          applications, approvals); bars track money stages (Finance funding, landlord payout).
          Counts use each stage's own recorded date in Kampala time, including days with no activity.
        </p>
      </CardContent>
    </Card>
  );
}

export default TenantOpsPipelineTrendChart;
