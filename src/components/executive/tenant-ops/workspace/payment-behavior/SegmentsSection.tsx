import { useState } from 'react';
import { ContactActions } from '@/components/ops/ContactActions';
import type { PaymentBehaviorOverview, ShiftKey } from '@/hooks/tenantOpsWorkspace/usePaymentBehavior';
import {
  BEHAVIOUR_SEGMENT_HINT, BEHAVIOUR_SEGMENT_LABEL, SELF_COLOR, AGENT_COLOR, SHIFT_HINT, SHIFT_LABEL, num, pct, signedPp, ugx,
} from './labels';
import { Callout, ChartSkeleton, EstimateBadge, ObservedBadge, PctBar, SectionCard } from './shared';
import { cn } from '@/lib/utils';

const SEGMENT_TONE: Record<string, string> = {
  self_reliant: SELF_COLOR,
  hybrid: 'hsl(var(--warning))',
  agent_led_some_self: AGENT_COLOR,
  agent_dependent: 'hsl(var(--muted-foreground))',
  no_payment: 'hsl(var(--destructive))',
};

const rLabel = (r: number | null) => {
  if (r === null) return 'no measurable relationship';
  const a = Math.abs(r);
  const strength = a < 0.1 ? 'no real relationship' : a < 0.3 ? 'a weak relationship' : a < 0.5 ? 'a moderate relationship' : 'a strong relationship';
  if (a < 0.1) return strength;
  return `${strength} (${r > 0 ? 'rises together' : 'one rises as the other falls'})`;
};

export function SegmentsSection({ data, loading }: { data: PaymentBehaviorOverview | undefined; loading: boolean }) {
  const [shiftTab, setShiftTab] = useState<ShiftKey>('moving_to_agents');
  const segs = data?.segments.rows ?? [];
  const shift = data?.shift;
  const cmp = data?.comparison;
  const cor = data?.correlations;
  const shiftRows = (shift?.rows ?? []).filter((r) => r.shift === shiftTab);

  return (
    <div className="space-y-3">
      <SectionCard
        title="Behavioural segments"
        description="Tenants grouped by how much of what they paid came from their own payments in the period."
        badge={<ObservedBadge />}
      >
        {loading || !data ? <ChartSkeleton h={200} /> : segs.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">No tenants billed or paying in this selection.</p>
        ) : (
          <div className="grid gap-2 min-[480px]:grid-cols-2 2xl:grid-cols-3">
            {segs.map((g) => (
              <div key={g.segment} className="min-w-0 rounded-xl border border-border/60 bg-card p-3 shadow-sm" data-testid={`segment-${g.segment}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-sm font-semibold"><span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: SEGMENT_TONE[g.segment] }} />{BEHAVIOUR_SEGMENT_LABEL[g.segment]}</p>
                    <p className="text-[11px] text-muted-foreground">{BEHAVIOUR_SEGMENT_HINT[g.segment]}</p>
                  </div>
                  <p className="text-2xl font-bold tabular-nums">{num(g.tenants)}</p>
                </div>
                <div className="mt-2.5 space-y-1">
                  <div className="flex items-baseline justify-between text-[11px]"><span className="text-muted-foreground">Bill covered</span><span className="font-semibold tabular-nums">{pct(g.coverage_pct)}</span></div>
                  <PctBar value={g.coverage_pct} color={SEGMENT_TONE[g.segment]} label={`${BEHAVIOUR_SEGMENT_LABEL[g.segment]} coverage ${pct(g.coverage_pct)}`} />
                </div>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                  <div><dt className="text-muted-foreground">Billed days paid</dt><dd className="font-semibold tabular-nums">{pct(g.avg_paid_day_pct)}</dd></div>
                  <div><dt className="text-muted-foreground">Still short</dt><dd className="font-semibold tabular-nums">{ugx(g.short_ugx)}</dd></div>
                  <div><dt className="text-muted-foreground">Self-paid</dt><dd className="font-semibold tabular-nums">{ugx(g.self_ugx)}</dd></div>
                  <div><dt className="text-muted-foreground">Agent-paid</dt><dd className="font-semibold tabular-nums">{ugx(g.agent_ugx)}</dd></div>
                </dl>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Who is relying on agents more, or less"
        description={shift ? `Each tenant now versus the previous ${data?.summary.window.days} days (${shift.previous_window.start_day} to ${shift.previous_window.end_day}).` : undefined}
        badge={<ObservedBadge />}
      >
        {loading || !data ? <ChartSkeleton h={140} /> : (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2" role="tablist" aria-label="Shift in payment method">
              {(['moving_to_agents', 'moving_to_self', 'new_self_adopter'] as ShiftKey[]).map((k) => (
                <button
                  key={k} type="button" role="tab" aria-selected={shiftTab === k} onClick={() => setShiftTab(k)}
                  className={cn('rounded-xl border p-2.5 text-left transition-colors', shiftTab === k ? 'border-primary bg-primary/5' : 'border-border/60 bg-card hover:bg-muted/40')}
                >
                  <p className="text-xl font-bold tabular-nums">{num(shift?.counts[k] ?? 0)}</p>
                  <p className="text-[11px] font-semibold leading-tight">{SHIFT_LABEL[k]}</p>
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{SHIFT_HINT[shiftTab]}.</p>
            {shiftRows.length === 0 ? (
              <p className="rounded-lg border border-dashed py-6 text-center text-xs text-muted-foreground">
                Nobody in this group for the selected period.
              </p>
            ) : (
              <div className="space-y-2">
                {shiftRows.slice(0, 30).map((r) => (
                  <div key={r.tenant_id} className="rounded-xl border border-border/60 bg-card p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">{r.tenant_name}</p>
                        <p className="text-[11px] text-muted-foreground">
                          Self-pay share {pct(r.previous_self_share_pct, 0)} → {pct(r.self_share_pct, 0)}
                        </p>
                      </div>
                      <ContactActions phone={r.tenant_phone} showLabels message={`Hello ${r.tenant_name}, this is Welile Ops about your Rent Plan.`} />
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground">Paid by self {ugx(r.self_ugx)} · by agents {ugx(r.agent_ugx)}</p>
                  </div>
                ))}
                {shiftRows.length > 30 && <p className="text-center text-[11px] text-muted-foreground">Showing the 30 largest of {num(shiftRows.length)}.</p>}
              </div>
            )}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Self-payers compared with agent-only tenants"
        description="Average share of the bill covered, tenant by tenant."
        badge={<EstimateBadge label="Comparison" />}
      >
        {loading || !data ? <ChartSkeleton h={110} /> : !cmp?.self_payers || !cmp.agent_only ? (
          <Callout tone="info" title="Nothing to compare">One of the two groups has no billed tenants in this selection.</Callout>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              {([['Self-paying tenants', cmp.self_payers, SELF_COLOR], ['Agent-only tenants', cmp.agent_only, AGENT_COLOR]] as const).map(([label, g, color]) => (
                <div key={label} className="rounded-xl border border-border/60 bg-card p-3">
                  <p className="flex items-center gap-1.5 text-xs font-semibold"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: color }} />{label}</p>
                  <p className="mt-1 text-2xl font-bold tabular-nums">{pct(g.coverage_pct)}</p>
                  <p className="text-[11px] text-muted-foreground">{num(g.tenants)} tenants · billed days paid {pct(g.paid_day_pct)}</p>
                </div>
              ))}
            </div>
            <Callout tone={cmp.enough_data ? 'info' : 'warning'} title={`Difference: ${signedPp(cmp.difference_pp)} (margin of error about ${cmp.margin_pp_95 ?? '—'} points)`}>
              {cmp.enough_data
                ? (cmp.difference_pp !== null && cmp.margin_pp_95 !== null && Math.abs(cmp.difference_pp) > cmp.margin_pp_95
                    ? 'The gap is larger than the margin of error, so it is unlikely to be chance. '
                    : 'The gap is smaller than the margin of error, so it may just be chance. ')
                : 'One group is very small, so this is only a rough indication. '}
              {cmp.definition}
            </Callout>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="What goes with self-paying"
        description="Correlations across tenants. This shows association, never cause."
        badge={<EstimateBadge label="Correlation" />}
      >
        {loading || !data ? <ChartSkeleton h={110} /> : (
          <div className="space-y-2.5">
            {!cor?.enough_data && (
              <Callout tone="warning" title="Limited data">
                Only {num(cor?.tenants_with_self_pay)} tenants in this selection have paid themselves, so these relationships are weak evidence. At least 10 self-paying tenants and 30 tenants overall are needed for a reading.
              </Callout>
            )}
            {(cor?.pairs ?? []).map((pr) => {
              const r = pr.r;
              const w = r === null ? 0 : Math.min(50, Math.abs(r) * 50);
              return (
                <div key={pr.key} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="min-w-0 text-xs font-medium">{pr.label}</p>
                    <p className="shrink-0 text-xs font-bold tabular-nums">{r === null ? '—' : r.toFixed(2)} <span className="font-normal text-muted-foreground">n={num(pr.n)}</span></p>
                  </div>
                  <div className="relative h-2 rounded-full bg-muted" role="img" aria-label={`${pr.label}: correlation ${r ?? 'not available'}`}>
                    <span className="absolute inset-y-0 left-1/2 w-px bg-border" aria-hidden />
                    {r !== null && (
                      <span
                        className="absolute inset-y-0 rounded-full"
                        style={{ background: r >= 0 ? 'hsl(var(--success))' : 'hsl(var(--destructive))', width: `${w}%`, left: r >= 0 ? '50%' : `${50 - w}%` }}
                      />
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground">{rLabel(r)}</p>
                </div>
              );
            })}
            <p className="text-[11px] text-muted-foreground">{cor?.definition}</p>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
