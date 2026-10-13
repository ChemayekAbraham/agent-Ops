import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { PhoneOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  CHART_GRID, CHART_TICK, ChartSkeleton, ChartTooltipBox, Legend, PctBar, SectionCard, StatTile,
} from '@/components/executive/tenant-ops/workspace/payment-behavior/shared';
import { WorkspaceEmptyState } from '@/components/executive/tenant-ops/workspace/WorkspaceEmptyState';
import { LABEL_30M_ACCESS, LABEL_LANDLORD_CONSENT, LABEL_PAYOUT_OTP, LABEL_SELF_PAYMENT } from '@/lib/awarenessCallLabels';
import { count, kampalaDate, percent } from '@/lib/awarenessMonitoringLabels';
import type { AwarenessBucket, AwarenessGaps, AwarenessSummary } from '@/hooks/useAwarenessMonitoring';

const CALLS_COLOR = 'hsl(var(--primary))';
const ANSWERED_COLOR = 'hsl(var(--success))';
const KNEW = 'hsl(var(--success))';
const HEARD = 'hsl(var(--warning))';
const DID_NOT = 'hsl(var(--destructive))';

const dayTick = (ymd: string) => {
  const [, m, d] = ymd.split('-').map(Number);
  return `${d}/${m}`;
};

function AnswerBlock({
  title, counts, pcts, labels,
}: {
  title: string;
  counts: [number, number, number];
  pcts: [number | null, number | null, number | null];
  labels: [string, string, string];
}) {
  const colors = [KNEW, HEARD, DID_NOT];
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold">{title}</p>
      {labels.map((label, i) => (
        <div key={label} className="space-y-1">
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span>{label}</span>
            <span className="tabular-nums"><strong>{count(counts[i])}</strong> <span className="text-muted-foreground">({percent(pcts[i])})</span></span>
          </div>
          <PctBar value={pcts[i]} color={colors[i]} label={`${title}: ${label} ${percent(pcts[i])}`} />
        </div>
      ))}
    </div>
  );
}

/** The headline cards, the daily trend and the answer breakdown. */
export function OverviewTab({
  summary, gaps, loading, bucket = 'day', onBucketChange,
}: {
  summary: AwarenessSummary | undefined; gaps: AwarenessGaps | undefined; loading: boolean;
  bucket?: AwarenessBucket; onBucketChange?: (b: AwarenessBucket) => void;
}) {
  const t = summary?.totals;
  const empty = !loading && (t?.calls ?? 0) === 0;
  const weekly = bucket === 'week';
  // while the other grouping is still being read, the held answer is for the previous one: show the placeholder, not the wrong chart
  const trendStale = Boolean(summary?.bucket) && summary?.bucket !== bucket;
  const trend = (summary?.trend ?? []).map((d) => ({ ...d, label: dayTick(d.day) }));

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 xl:grid-cols-4" data-testid="awareness-cards">
        <StatTile label="Calls made" tone="primary" loading={loading} value={count(t?.calls)}
          sub={`${count(t?.answered)} answered`} />
        <StatTile label="People reached" tone="success" loading={loading} value={count(t?.people_reached)}
          sub={`of ${count(t?.people_called)} people called`} />
        <StatTile label="Answered" tone="default" loading={loading} value={percent(t?.answered_pct)}
          sub={`${count(t?.no_answer)} no answer, ${count(t?.phone_off)} phone off, ${count(t?.wrong_number)} wrong number`} />
        <StatTile label="Rent Plans called" tone="default" loading={loading} value={count(t?.rent_plans_called)}
          sub={`by ${count(t?.callers)} ${t?.callers === 1 ? 'caller' : 'callers'}`} />
        <StatTile label={LABEL_30M_ACCESS} tone="success" loading={loading} value={count(summary?.aware_30m.knew)}
          sub={`${percent(summary?.aware_30m.knew_pct)} of answered calls`} />
        <StatTile label={LABEL_SELF_PAYMENT} tone="success" loading={loading} value={count(summary?.aware_merchant_codes.knew)}
          sub={`${percent(summary?.aware_merchant_codes.knew_pct)} of answered tenant and agent calls`} />
        <StatTile label="Landlords who consent" tone="success" loading={loading} value={count(summary?.landlord_consent?.consents)}
          sub={`${percent(summary?.landlord_consent?.consents_pct)} of ${count(t?.answered_landlord)} answered landlord calls`} />
        <StatTile label={LABEL_PAYOUT_OTP} tone="success" loading={loading} value={count(summary?.aware_payout_otp?.knew)}
          sub={`${percent(summary?.aware_payout_otp?.knew_pct)} of answered landlord calls`} />
        <StatTile label="Fully explained" tone="primary" loading={loading} value={count(summary?.explained.yes)}
          sub={`${count(summary?.explained.partly)} partly, ${count(summary?.explained.no)} not explained`} />
        <StatTile label="Stages without a call" tone="warning" loading={!gaps} value={count(gaps?.totals.without_call)}
          sub={`${percent(gaps?.totals.covered_pct)} of ${count(gaps?.totals.passed)} stage moves had a call`} />
      </div>

      {empty ? (
        <WorkspaceEmptyState
          icon={PhoneOff}
          title="No awareness calls match these filters"
          hint={gaps?.tracking_started
            ? `Calls have been recorded since ${kampalaDate(gaps.tracking_started)}. Try a wider date range or fewer filters.`
            : 'No awareness call has been recorded yet. They appear here as staff save them from the Review Rent Request sheet or the Service Centre queue.'}
        />
      ) : (
        <>
          <SectionCard
            title={weekly ? 'Calls per week' : 'Calls per day'}
            description={summary
              ? `Kampala days, ${kampalaDate(summary.window.start_day)} to ${kampalaDate(summary.window.end_day)}. A call counts on the day it was dialled${weekly ? '; weeks run Monday to Sunday, and the first and last may be part weeks' : ''}.`
              : undefined}
            actions={onBucketChange ? (
              <div role="group" aria-label="Group the trend by" className="inline-flex rounded-lg border border-border p-0.5">
                {(['day', 'week'] as const).map((b) => (
                  <button
                    key={b}
                    type="button"
                    aria-pressed={bucket === b}
                    onClick={() => onBucketChange(b)}
                    className={cn(
                      'h-8 min-w-[3.5rem] rounded-md px-3 text-xs font-medium transition-colors touch-manipulation',
                      bucket === b ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
                    )}
                  >
                    {b === 'day' ? 'Day' : 'Week'}
                  </button>
                ))}
              </div>
            ) : undefined}
          >
            {loading || trendStale ? (
              <ChartSkeleton h={220} />
            ) : (
              <>
                <div className="h-[230px]" role="img" aria-label={weekly ? 'Calls and answered calls per week' : 'Calls and answered calls per day'}>
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={trend} margin={{ top: 6, right: 8, left: -10, bottom: 0 }}>
                      <CartesianGrid stroke={CHART_GRID} vertical={false} />
                      <XAxis dataKey="label" tick={CHART_TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                      <YAxis tick={CHART_TICK} tickLine={false} axisLine={false} allowDecimals={false} width={34} />
                      <Tooltip
                        cursor={{ fill: 'hsl(var(--muted) / 0.4)' }}
                        content={({ active, payload }) => {
                          if (!active || !payload?.length) return null;
                          const p = payload[0].payload as (typeof trend)[number];
                          return (
                            <ChartTooltipBox>
                              <p className="font-semibold">
                                {weekly && p.period_end && p.period_end !== p.day ? `${kampalaDate(p.day)} to ${kampalaDate(p.period_end)}` : kampalaDate(p.day)}
                              </p>
                              <p className="tabular-nums">{count(p.calls)} calls, {count(p.answered)} answered ({percent(p.answered_pct)})</p>
                              <p className="tabular-nums">{count(p.people_reached)} people reached</p>
                            </ChartTooltipBox>
                          );
                        }}
                      />
                      <Bar dataKey="calls" fill={CALLS_COLOR} fillOpacity={0.35} radius={[3, 3, 0, 0]} isAnimationActive={false} />
                      <Line dataKey="answered" stroke={ANSWERED_COLOR} strokeWidth={2} dot={{ r: 2 }} isAnimationActive={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
                <Legend items={[{ label: 'Calls made', color: CALLS_COLOR }, { label: 'Answered', color: ANSWERED_COLOR }]} />
              </>
            )}
          </SectionCard>

          <SectionCard title="What people told us" description="Counted over the answered calls in the filters above.">
            {loading || !summary ? (
              <ChartSkeleton h={160} />
            ) : (
              <div className="grid gap-4 md:grid-cols-3">
                <AnswerBlock
                  title={LABEL_30M_ACCESS}
                  counts={[summary.aware_30m.knew, summary.aware_30m.heard, summary.aware_30m.did_not_know]}
                  pcts={[summary.aware_30m.knew_pct, summary.aware_30m.heard_pct, summary.aware_30m.did_not_know_pct]}
                  labels={['Knew about it', 'Heard but unsure', 'Did not know']}
                />
                <AnswerBlock
                  title={`${LABEL_SELF_PAYMENT} (tenants and agents)`}
                  counts={[summary.aware_merchant_codes.knew, summary.aware_merchant_codes.heard, summary.aware_merchant_codes.did_not_know]}
                  pcts={[summary.aware_merchant_codes.knew_pct, summary.aware_merchant_codes.heard_pct, summary.aware_merchant_codes.did_not_know_pct]}
                  labels={['Knew about it', 'Heard but unsure', 'Did not know']}
                />
                {summary.landlord_consent && (
                  <AnswerBlock
                    title={`${LABEL_LANDLORD_CONSENT} (landlords)`}
                    counts={[summary.landlord_consent.consents, summary.landlord_consent.unsure, summary.landlord_consent.refuses]}
                    pcts={[summary.landlord_consent.consents_pct, summary.landlord_consent.unsure_pct, summary.landlord_consent.refuses_pct]}
                    labels={['Consents', 'Not sure, wants to think', 'Does not consent']}
                  />
                )}
                {summary.aware_payout_otp && (
                  <AnswerBlock
                    title={`${LABEL_PAYOUT_OTP} (landlords)`}
                    counts={[summary.aware_payout_otp.knew, summary.aware_payout_otp.heard, summary.aware_payout_otp.did_not_know]}
                    pcts={[summary.aware_payout_otp.knew_pct, summary.aware_payout_otp.heard_pct, summary.aware_payout_otp.did_not_know_pct]}
                    labels={['Knew about it', 'Heard but unsure', 'Did not know']}
                  />
                )}
                <AnswerBlock
                  title="Was it explained to them"
                  counts={[summary.explained.yes, summary.explained.partly, summary.explained.no]}
                  pcts={[summary.explained.yes_pct, summary.explained.partly_pct, summary.explained.no_pct]}
                  labels={['Yes, fully explained', 'Partly explained', 'Not explained']}
                />
              </div>
            )}
          </SectionCard>
        </>
      )}
    </div>
  );
}
