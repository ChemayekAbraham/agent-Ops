import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ChannelOnTime, PaymentBehaviorTiming } from '@/hooks/tenantOpsWorkspace/usePaymentBehavior';
import {
  AGENT_COLOR, LAG_BUCKET_COLOR, LAG_BUCKET_LABEL, SELF_COLOR, TENANT_GROUP_LABEL, WEEKDAY_SHORT, fmtDay, fmtHour, num, pct, ugx,
} from './labels';
import { CHART_GRID, CHART_TICK, Callout, ChartSkeleton, ChartTooltipBox, ObservedBadge, SectionCard } from './shared';

function OnTimeCard({ title, color, d }: { title: string; color: string; d: ChannelOnTime | undefined }) {
  const empty = !d || d.settled_days === 0;
  return (
    <div className="min-w-0 rounded-xl border border-border/60 bg-card p-3 shadow-sm">
      <div className="flex items-baseline justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: color }} />{title}</p>
        <p className="text-2xl font-bold tabular-nums">{empty ? '—' : pct(d.on_time_pct)}</p>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {empty ? 'No settled payments with day detail in this selection.' : `paid on or before the due day, by UGX · ${pct(d.late_pct)} late · ${ugx(d.settled_ugx)} settled across ${num(d.settled_days)} billed days`}
      </p>
      {!empty && (
        <>
          <div className="mt-2.5 flex h-3 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={`${title} timing: ${pct(d.on_time_pct)} on time or early`}>
            {d.buckets.map((b) => (
              <div key={b.key} title={`${LAG_BUCKET_LABEL[b.key]}: ${pct(b.settled_pct)}`} style={{ width: `${Math.max(0, b.settled_pct ?? 0)}%`, background: LAG_BUCKET_COLOR[b.key] }} />
            ))}
          </div>
          <dl className="mt-2 grid grid-cols-1 gap-x-3 gap-y-0.5 text-[11px] min-[420px]:grid-cols-2">
            {d.buckets.map((b) => (
              <div key={b.key} className="flex items-center justify-between gap-2">
                <dt className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                  <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: LAG_BUCKET_COLOR[b.key] }} />
                  <span className="truncate">{LAG_BUCKET_LABEL[b.key]}</span>
                </dt>
                <dd className="font-semibold tabular-nums">{pct(b.settled_pct)}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-[11px] text-muted-foreground">
            When late, on average {d.avg_days_late_when_late ?? '—'} days late. Median: {d.median_days_vs_due === 0 ? 'on the due day' : `${d.median_days_vs_due} ${Math.abs(d.median_days_vs_due ?? 0) === 1 ? 'day' : 'days'} ${(d.median_days_vs_due ?? 0) < 0 ? 'ahead of' : 'after'} the due day`}.
          </p>
        </>
      )}
    </div>
  );
}

function HourChart({ title, color, values }: { title: string; color: string; values: number[] | undefined }) {
  const data = (values ?? []).map((n, h) => ({ h, label: fmtHour(h), n }));
  return (
    <div className="min-w-0">
      <p className="mb-1 text-xs font-semibold">{title}</p>
      <div className="h-[150px]" role="img" aria-label={`${title}: payments by hour of day`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={CHART_GRID} vertical={false} />
            <XAxis dataKey="label" tick={CHART_TICK} interval={3} tickMargin={4} />
            <YAxis tick={CHART_TICK} width={30} allowDecimals={false} />
            <Tooltip content={({ active, payload }) => active && payload?.length ? (
              <ChartTooltipBox><p className="font-semibold">{(payload[0].payload as { label: string }).label}</p><p className="tabular-nums">{num(Number(payload[0].value))} payments</p></ChartTooltipBox>
            ) : null} />
            <Bar dataKey="n" fill={color} radius={[2, 2, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function DayChart({ title, color, values }: { title: string; color: string; values: number[] | undefined }) {
  const data = (values ?? []).map((n, i) => ({ label: WEEKDAY_SHORT[i], n }));
  return (
    <div className="min-w-0">
      <p className="mb-1 text-xs font-semibold">{title}</p>
      <div className="h-[130px]" role="img" aria-label={`${title}: payments by weekday`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={CHART_GRID} vertical={false} />
            <XAxis dataKey="label" tick={CHART_TICK} tickMargin={4} />
            <YAxis tick={CHART_TICK} width={30} allowDecimals={false} />
            <Tooltip content={({ active, payload }) => active && payload?.length ? (
              <ChartTooltipBox><p className="font-semibold">{(payload[0].payload as { label: string }).label}</p><p className="tabular-nums">{num(Number(payload[0].value))} payments</p></ChartTooltipBox>
            ) : null} />
            <Bar dataKey="n" fill={color} radius={[2, 2, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function TimelinessSection({ data, loading }: { data: PaymentBehaviorTiming | undefined; loading: boolean }) {
  const ot = data?.on_time;
  const fr = data?.frequency;
  const am = data?.amounts;
  const clock = data?.clock;

  return (
    <div className="space-y-3">
      <SectionCard
        title="On time versus late"
        description="Whether each payment arrived on or before the billed day it settled. Money is settled against billed days oldest first."
        badge={<ObservedBadge />}
      >
        {loading || !data ? (
          <ChartSkeleton h={200} />
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 xl:grid-cols-2">
              <OnTimeCard title="Tenants paying themselves" color={SELF_COLOR} d={ot?.by_channel.self} />
              <OnTimeCard title="Agents paying for tenants" color={AGENT_COLOR} d={ot?.by_channel.agent} />
            </div>
            {ot && (ot.detail_coverage_pct ?? 0) < 100 && (
              <Callout tone="warning" title="Day-by-day detail is partial">
                Billed-day settlement records start on {fmtDay(ot.settlement_detail_since)}. {num(ot.receipts_with_detail)} of {num(ot.receipts_in_window)} payments in this
                period ({pct(ot.detail_coverage_pct)}) have that detail, so the on-time figures describe those payments only.
              </Callout>
            )}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Payment frequency and consistency"
        description="Share of billed days on which a Rent Plan received any payment. Consistent: 80%+ of billed days. Patchy: 40-80%. Sporadic: under 40%."
        badge={<ObservedBadge />}
      >
        {loading || !data ? <ChartSkeleton h={160} /> : (
          <div className="space-y-3">
            <div className="hidden overflow-hidden rounded-lg border sm:block">
              <table className="w-full text-xs">
                <thead className="bg-muted/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <tr><th className="px-3 py-2">Group (Rent Plans)</th><th className="px-3 py-2 text-right">Plans</th><th className="px-3 py-2 text-right">Billed days paid</th><th className="px-3 py-2 text-right">Consistent</th><th className="px-3 py-2 text-right">Patchy</th><th className="px-3 py-2 text-right">Sporadic</th></tr>
                </thead>
                <tbody>
                  {(fr?.by_segment ?? []).map((r) => (
                    <tr key={r.segment} className="border-t">
                      <td className="px-3 py-2 font-medium">{TENANT_GROUP_LABEL[r.segment] ?? r.segment}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{num(r.plans)}</td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums">{pct(r.paid_day_pct)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{num(r.consistent)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{num(r.patchy)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{num(r.sporadic)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="space-y-2 sm:hidden">
              {(fr?.by_segment ?? []).map((r) => (
                <div key={r.segment} className="rounded-xl border border-border/60 bg-card p-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-xs font-semibold">{TENANT_GROUP_LABEL[r.segment] ?? r.segment}</p>
                    <p className="text-base font-bold tabular-nums">{pct(r.paid_day_pct)}</p>
                  </div>
                  <p className="text-[11px] text-muted-foreground">{num(r.plans)} Rent Plans · {num(r.consistent)} consistent · {num(r.patchy)} patchy · {num(r.sporadic)} sporadic</p>
                </div>
              ))}
            </div>
            <div className="grid gap-2 xl:grid-cols-2">
              {([['self', 'Tenants paying themselves', SELF_COLOR], ['agent', 'Agents paying for tenants', AGENT_COLOR]] as const).map(([k, label, color]) => {
                const c = fr?.by_channel[k];
                return (
                  <div key={k} className="rounded-xl border border-border/60 bg-card p-3">
                    <p className="flex items-center gap-1.5 text-xs font-semibold"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: color }} />{label}</p>
                    <dl className="mt-1.5 grid grid-cols-3 gap-2 text-center">
                      <div><dd className="text-base font-bold tabular-nums">{c?.avg_payments_per_tenant ?? '—'}</dd><dt className="text-[10px] text-muted-foreground">payments per tenant</dt></div>
                      <div><dd className="text-base font-bold tabular-nums">{c?.avg_pay_days_per_tenant ?? '—'}</dd><dt className="text-[10px] text-muted-foreground">days paid per tenant</dt></div>
                      <div><dd className="text-base font-bold tabular-nums">{c?.median_days_between_payments ?? '—'}</dd><dt className="text-[10px] text-muted-foreground">median days between</dt></div>
                    </dl>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </SectionCard>

      <SectionCard title="Size of payments" description="Spread of individual payment amounts. Half of all payments are below the median." badge={<ObservedBadge />}>
        {loading || !data ? <ChartSkeleton h={110} /> : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[420px] text-xs">
              <thead className="bg-muted/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr><th className="px-3 py-2">Method</th><th className="px-3 py-2 text-right">Payments</th><th className="px-3 py-2 text-right">10th</th><th className="px-3 py-2 text-right">Median</th><th className="px-3 py-2 text-right">Average</th><th className="px-3 py-2 text-right">90th</th><th className="px-3 py-2 text-right">Largest</th></tr>
              </thead>
              <tbody>
                {([['self', 'Self-paid'], ['agent', 'Agent-paid']] as const).map(([k, label]) => (
                  <tr key={k} className="border-t">
                    <td className="px-3 py-2 font-medium">{label}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{num(am?.[k]?.n)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{ugx(am?.[k]?.p10)}</td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">{ugx(am?.[k]?.median_ugx)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{ugx(am?.[k]?.avg_ugx)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{ugx(am?.[k]?.p90)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{ugx(am?.[k]?.max_ugx)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="When payments are made"
        description={`Hour of day and weekday (Kampala time). Typical hour: self-paid ${fmtHour(clock?.median_hour?.self)}, agent-paid ${fmtHour(clock?.median_hour?.agent)}. Agent payments reflect when agents enter them.`}
        badge={<ObservedBadge />}
      >
        {loading || !data ? <ChartSkeleton h={200} /> : (
          <div className="grid gap-4 xl:grid-cols-2">
            <HourChart title="Self-paid by hour" color={SELF_COLOR} values={clock?.hours.self} />
            <HourChart title="Agent-paid by hour" color={AGENT_COLOR} values={clock?.hours.agent} />
            <DayChart title="Self-paid by weekday" color={SELF_COLOR} values={clock?.weekdays.self} />
            <DayChart title="Agent-paid by weekday" color={AGENT_COLOR} values={clock?.weekdays.agent} />
          </div>
        )}
      </SectionCard>
    </div>
  );
}
