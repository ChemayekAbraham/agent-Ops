import { Area, Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { LineChart as LineChartIcon } from 'lucide-react';
import type { PaymentBehaviorTrend, TrendPoint } from '@/hooks/tenantOpsWorkspace/usePaymentBehavior';
import { AGENT_COLOR, CONFIDENCE_LABEL, SELF_COLOR, axisUgx, fmtDay, fmtDayShort, num, pct, ugx } from './labels';
import { CHART_GRID, CHART_TICK, Callout, ChartSkeleton, ChartTooltipBox, EstimateBadge, Legend, ObservedBadge, SectionCard } from './shared';
import { WorkspaceEmptyState } from '@/components/executive/tenant-ops/workspace/WorkspaceEmptyState';

const BUCKET_WORD = { day: 'day', week: 'week', month: 'month' } as const;

function PointTooltip({ active, payload, bucket }: { active?: boolean; payload?: { payload: TrendPoint }[]; bucket: 'day' | 'week' | 'month' }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <ChartTooltipBox>
      <p className="font-semibold">
        {bucket === 'day' ? fmtDay(p.bucket_start) : `${fmtDay(p.bucket_start)} to ${fmtDay(p.bucket_end)}`}
        {p.partial && <span className="font-normal text-muted-foreground"> · still in progress</span>}
      </p>
      <dl className="mt-1.5 space-y-0.5">
        <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Self-pay share</dt><dd className="font-semibold tabular-nums">{pct(p.self_share_pct)}</dd></div>
        <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Self-paying tenants</dt><dd className="tabular-nums">{num(p.self_tenants)} of {num(p.paying_tenants)} ({pct(p.self_tenant_pct)})</dd></div>
        <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Self-paid</dt><dd className="tabular-nums">{ugx(p.self_ugx)} ({num(p.self_n)})</dd></div>
        <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Agent-paid</dt><dd className="tabular-nums">{ugx(p.agent_ugx)} ({num(p.agent_n)})</dd></div>
      </dl>
    </ChartTooltipBox>
  );
}

export function TrendsSection({ data, loading }: { data: PaymentBehaviorTrend | undefined; loading: boolean }) {
  const points = data?.points ?? [];
  const proj = data?.projection;
  const hasData = points.some((p) => p.self_n + p.agent_n > 0);
  const bucket = data?.bucket ?? 'day';
  // The self-pay share only means something once someone could pay themselves.
  const chartPoints = points.map((p) => ({ ...p, label: fmtDayShort(p.bucket_start) }));

  return (
    <div className="space-y-3">
      <SectionCard
        title="Self-pay share over time"
        description={`Share of the money collected, and share of paying tenants, that came from tenants paying themselves, per ${BUCKET_WORD[bucket]}.`}
        badge={<ObservedBadge />}
      >
        {loading ? (
          <ChartSkeleton h={240} />
        ) : !hasData ? (
          <WorkspaceEmptyState icon={LineChartIcon} title="No payments in this period" hint="Pick a wider date range." />
        ) : (
          <>
            <div className="h-[240px]" role="img" aria-label="Self-pay share of money and of tenants over time">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartPoints} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={CHART_GRID} vertical={false} />
                  <XAxis dataKey="label" tick={CHART_TICK} minTickGap={22} tickMargin={6} />
                  <YAxis tick={CHART_TICK} width={36} tickFormatter={(v) => `${v}%`} domain={[0, 'auto']} />
                  <Tooltip content={<PointTooltip bucket={bucket} />} />
                  <Area dataKey="self_tenant_pct" type="monotone" stroke={AGENT_COLOR} fill={AGENT_COLOR} fillOpacity={0.12} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
                  <Line dataKey="self_share_pct" type="monotone" stroke={SELF_COLOR} strokeWidth={2.5} dot={chartPoints.length <= 14} connectNulls isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <Legend items={[{ label: '% of the money paid by tenants themselves', color: SELF_COLOR }, { label: '% of paying tenants who paid themselves', color: AGENT_COLOR }]} />
          </>
        )}
      </SectionCard>

      <div className="grid gap-3 xl:grid-cols-2">
        <SectionCard title="Money self-paid" description={`UGX paid by tenants themselves per ${BUCKET_WORD[bucket]}.`} badge={<ObservedBadge />}>
          {loading ? <ChartSkeleton h={200} /> : (
            <div className="h-[200px]" role="img" aria-label="UGX self-paid over time">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartPoints} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={CHART_GRID} vertical={false} />
                  <XAxis dataKey="label" tick={CHART_TICK} minTickGap={22} tickMargin={6} />
                  <YAxis tick={CHART_TICK} width={40} tickFormatter={axisUgx} />
                  <Tooltip content={<PointTooltip bucket={bucket} />} />
                  <Bar dataKey="self_ugx" fill={SELF_COLOR} radius={[3, 3, 0, 0]} maxBarSize={22} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </SectionCard>
        <SectionCard title="Money paid by agents" description={`UGX paid by agents for tenants per ${BUCKET_WORD[bucket]}.`} badge={<ObservedBadge />}>
          {loading ? <ChartSkeleton h={200} /> : (
            <div className="h-[200px]" role="img" aria-label="UGX paid by agents over time">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartPoints} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={CHART_GRID} vertical={false} />
                  <XAxis dataKey="label" tick={CHART_TICK} minTickGap={22} tickMargin={6} />
                  <YAxis tick={CHART_TICK} width={40} tickFormatter={axisUgx} />
                  <Tooltip content={<PointTooltip bucket={bucket} />} />
                  <Bar dataKey="agent_ugx" fill={AGENT_COLOR} radius={[3, 3, 0, 0]} maxBarSize={22} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </SectionCard>
      </div>

      <SectionCard
        title="Where self-pay may be heading"
        description="A simple straight-line extension of the recent weekly trend. It is a guide, not a forecast the data can guarantee."
        badge={<EstimateBadge label="Estimate" />}
      >
        {loading ? (
          <ChartSkeleton h={110} />
        ) : !proj || proj.available === false ? (
          <Callout tone="info" title="No projection yet">{proj && proj.available === false ? proj.reason : 'Not enough data.'}</Callout>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {proj.projected.map((w) => (
                <div key={w.week_start} className="rounded-xl border border-dashed border-warning/50 bg-warning/5 p-2.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Week of {fmtDayShort(w.week_start)}</p>
                  <p className="mt-0.5 text-lg font-bold tabular-nums">{pct(w.self_share_pct)}</p>
                  <p className="text-[11px] text-muted-foreground">about {ugx(w.self_ugx)}</p>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Based on {proj.weeks_used} complete weeks ({fmtDay(proj.first_week)} onward). The self-pay share has been moving by about{' '}
              <span className="font-semibold text-foreground">{proj.slope_pp_per_week > 0 ? '+' : ''}{proj.slope_pp_per_week} points a week</span>{' '}
              (the line fits the weeks with r&sup2; {proj.r_squared}). <span className="font-semibold text-foreground">{CONFIDENCE_LABEL[proj.confidence]}</span>:{' '}
              {proj.confidence === 'low'
                ? 'only a few weeks of history exist, so treat these as indicative.'
                : 'at least eight weeks fit the line reasonably well.'}
            </p>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
