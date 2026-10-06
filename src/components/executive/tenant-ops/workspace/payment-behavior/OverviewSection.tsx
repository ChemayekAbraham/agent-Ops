import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PaymentBehaviorOverview, PaymentBehaviorTiming } from '@/hooks/tenantOpsWorkspace/usePaymentBehavior';
import {
  AGENT_COLOR, SELF_COLOR, TENANT_GROUP_COLOR, TENANT_GROUP_LABEL, fmtDay, num, pct, plural, signedPp, ugx,
} from './labels';
import { Callout, ChartSkeleton, ChartTooltipBox, Legend, ObservedBadge, PctBar, SectionCard, StatTile } from './shared';

export function OverviewSection({
  data, timing, loading,
}: { data: PaymentBehaviorOverview | undefined; timing: PaymentBehaviorTiming | undefined; loading: boolean }) {
  const s = data?.summary;
  const t = s?.tenants;
  const p = s?.payments;
  const change = t?.self_payers_pct_change_pp ?? null;
  const onTime = timing?.on_time.by_channel;

  const donut = (['self_only', 'mixed', 'agent_only', 'no_payment'] as const)
    .map((k) => ({
      key: k,
      name: TENANT_GROUP_LABEL[k],
      value: k === 'no_payment' ? (t?.billed_not_paying ?? 0) : (t?.[k] ?? 0),
      color: TENANT_GROUP_COLOR[k],
    }))
    .filter((d) => d.value > 0);

  return (
    <div className="space-y-3">
      {/* Headline */}
      <div className="relative overflow-hidden rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/15 via-card to-card p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Tenants paying for themselves</p>
            <p className="mt-1 text-4xl font-bold leading-none tabular-nums sm:text-5xl" data-testid="headline-self-pct">
              {loading ? '—' : pct(t?.self_payers_pct)}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              <span className="font-semibold text-foreground">{num(t?.self_payers)}</span> of{' '}
              <span className="font-semibold text-foreground">{num(t?.paying)}</span> paying tenants paid at least once from their own phone;{' '}
              the rest were paid for by agents.
            </p>
          </div>
          <div className="flex flex-col items-start gap-1.5 sm:items-end">
            <ObservedBadge />
            {change !== null && (
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold',
                  change > 0 ? 'bg-success/10 text-success' : change < 0 ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground',
                )}
              >
                {change >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                {signedPp(change)} vs the previous {s?.window.days} day{s?.window.days === 1 ? '' : 's'}
                {t?.previous.self_payers_pct !== null && t?.previous.self_payers_pct !== undefined ? ` (${pct(t.previous.self_payers_pct)})` : ''}
              </span>
            )}
            <p className="text-[11px] text-muted-foreground">
              {s ? `${fmtDay(s.window.start_day)} to ${fmtDay(s.window.end_day)}` : ''}
            </p>
          </div>
        </div>
      </div>

      {/* KPI grid */}
      <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
        <StatTile
          label="Self-paying tenants" tone="primary" loading={loading}
          value={num(t?.self_payers)}
          sub={`${num(t?.self_only)} only self-pay, ${num(t?.mixed)} also use agents`}
        />
        <StatTile
          label="Agent-paid tenants" tone="default" loading={loading}
          value={num(t?.agent_paid)}
          sub={`${num(t?.agent_only)} paid only through agents`}
        />
        <StatTile
          label="Collected by self-pay" tone="primary" loading={loading}
          value={ugx(p?.self.ugx)}
          sub={`${pct(p?.self_share_pct)} of the money, ${plural(p?.self.n, 'payment')}`}
        />
        <StatTile
          label="Collected by agents" tone="default" loading={loading}
          value={ugx(p?.agent.ugx)}
          sub={`${pct(p?.agent_share_pct)} of the money, ${plural(p?.agent.n, 'payment')}`}
        />
        <StatTile
          label="Average payment" loading={loading}
          value={<span className="text-base">{ugx(p?.self.avg_ugx)} <span className="text-[11px] font-normal text-muted-foreground">self</span></span>}
          sub={`Agents: ${ugx(p?.agent.avg_ugx)}`}
        />
        <StatTile
          label="Median payment" loading={loading}
          value={<span className="text-base">{ugx(p?.self.median_ugx)} <span className="text-[11px] font-normal text-muted-foreground">self</span></span>}
          sub={`Agents: ${ugx(p?.agent.median_ugx)}`}
        />
        <StatTile
          label="Paid on time or early" tone="success" loading={loading || !timing}
          value={<span className="text-base">{pct(onTime?.self.on_time_pct)} <span className="text-[11px] font-normal text-muted-foreground">self</span></span>}
          sub={`Agents: ${pct(onTime?.agent.on_time_pct)} of settled UGX`}
        />
        <StatTile
          label="Bill covered" tone="warning" loading={loading}
          value={pct(s?.coverage.coverage_pct)}
          sub={`${ugx(s?.coverage.short_ugx)} short of ${ugx(s?.coverage.billed_ugx)} billed`}
        />
      </div>

      {s?.paid_ahead && (
        <p className="px-1 text-[11px] leading-relaxed text-muted-foreground" data-testid="paid-ahead-note">
          Paid ahead / above the bill: {ugx(s.paid_ahead.paid_ahead_ugx)} ({plural(s.paid_ahead.paid_ahead_n, 'payment')}). Not counted as collected, same as Home.
        </p>
      )}

      <div className="grid gap-3 xl:grid-cols-2">
        <SectionCard title="How tenants paid" description="Tenants billed or paying in the period, by who made their payments." badge={<ObservedBadge />}>
          {loading ? (
            <ChartSkeleton h={230} />
          ) : donut.length === 0 ? (
            <p className="py-10 text-center text-xs text-muted-foreground">No payments or bills in this selection.</p>
          ) : (
            <>
              <div className="h-[230px]" role="img" aria-label="Tenants by how they paid">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={donut} dataKey="value" nameKey="name" innerRadius={52} outerRadius={84} paddingAngle={2} isAnimationActive={false}>
                      {donut.map((d) => <Cell key={d.key} fill={d.color} />)}
                    </Pie>
                    <Tooltip content={({ active, payload }) => active && payload?.length ? (
                      <ChartTooltipBox>
                        <p className="font-semibold">{payload[0].name}</p>
                        <p className="tabular-nums">{num(Number(payload[0].value))} tenants</p>
                      </ChartTooltipBox>
                    ) : null} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <Legend items={donut.map((d) => ({ label: `${d.name} (${num(d.value)})`, color: d.color }))} />
            </>
          )}
        </SectionCard>

        <SectionCard title="Share of the money" description="Of all rent collected in the period, how much came through each method." badge={<ObservedBadge />}>
          {loading ? (
            <ChartSkeleton h={230} />
          ) : (
            <div className="space-y-4 pt-1">
              {[
                { label: 'Tenants paying themselves', value: p?.self_share_pct, ugxv: p?.self.ugx, n: p?.self.n, color: SELF_COLOR },
                { label: 'Agents paying for tenants', value: p?.agent_share_pct, ugxv: p?.agent.ugx, n: p?.agent.n, color: AGENT_COLOR },
              ].map((r) => (
                <div key={r.label} className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-xs font-medium">{r.label}</p>
                    <p className="text-sm font-bold tabular-nums">{pct(r.value)}</p>
                  </div>
                  <PctBar value={r.value} color={r.color} label={`${r.label} ${pct(r.value)}`} />
                  <p className="text-[11px] text-muted-foreground">{ugx(r.ugxv)} in {plural(r.n, 'payment')}</p>
                </div>
              ))}
              {(p?.other.n ?? 0) > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  A further {ugx(p?.other.ugx)} ({plural(p?.other.n, 'payment')}) was an agent liability settlement and is not counted as either method.
                </p>
              )}
              <p className="text-[11px] text-muted-foreground">
                By number of payments, self-pay is {pct(p?.self_count_share_pct)} of all payments.
              </p>
            </div>
          )}
        </SectionCard>
      </div>

      <SectionCard
        title="How well each group covers its bill"
        description="Share of the bill (billed in the period) that was actually paid, by how the tenant paid. Only Rent Plans billed in the period count."
        badge={<ObservedBadge />}
      >
        {loading ? (
          <ChartSkeleton h={140} />
        ) : (
          <div className="space-y-3">
            {(s?.coverage.by_segment ?? []).map((g) => (
              <div key={g.segment} className="space-y-1">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="min-w-0 text-xs font-medium">
                    {TENANT_GROUP_LABEL[g.segment]} <span className="font-normal text-muted-foreground">· {plural(g.tenants, 'tenant')}</span>
                  </p>
                  <p className="text-sm font-bold tabular-nums">{pct(g.coverage_pct)}</p>
                </div>
                <PctBar value={g.coverage_pct} color={TENANT_GROUP_COLOR[g.segment]} label={`${TENANT_GROUP_LABEL[g.segment]} ${pct(g.coverage_pct)}`} />
                <p className="text-[11px] text-muted-foreground">{ugx(g.covered_ugx)} paid of {ugx(g.billed_ugx)} billed · {ugx(g.short_ugx)} short</p>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {s && (
        <Callout tone="info" title="Reading these figures">
          Self-payments only began on {fmtDay(s.data_since.first_self_payment_day)}, so earlier periods have no self-pay history. A tenant counts as
          self-paying if any of their payments in the period came from their own phone. Groups of very different size (here{' '}
          {plural(t?.self_payers, 'self-paying tenant')} against {num(t?.agent_only)} agent-only) should be compared with care.
        </Callout>
      )}
    </div>
  );
}
