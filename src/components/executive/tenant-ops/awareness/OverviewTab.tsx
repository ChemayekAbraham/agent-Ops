import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { PhoneOff } from 'lucide-react';
import {
  CHART_GRID, CHART_TICK, ChartSkeleton, ChartTooltipBox, Legend, PctBar, SectionCard, StatTile,
} from '@/components/executive/tenant-ops/workspace/payment-behavior/shared';
import { WorkspaceEmptyState } from '@/components/executive/tenant-ops/workspace/WorkspaceEmptyState';
import { LABEL_30M_ACCESS, LABEL_SELF_PAYMENT } from '@/lib/awarenessCallLabels';
import { count, kampalaDate, percent } from '@/lib/awarenessMonitoringLabels';
import type { AwarenessGaps, AwarenessSummary } from '@/hooks/useAwarenessMonitoring';

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
  summary, gaps, loading,
}: { summary: AwarenessSummary | undefined; gaps: AwarenessGaps | undefined; loading: boolean }) {
  const t = summary?.totals;
  const empty = !loading && (t?.calls ?? 0) === 0;
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
          sub={`${percent(summary?.aware_merchant_codes.knew_pct)} of answered calls`} />
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
            title="Calls per day"
            description={summary ? `Kampala days, ${kampalaDate(summary.window.start_day)} to ${kampalaDate(summary.window.end_day)}. A call counts on the day it was dialled.` : undefined}
          >
            {loading ? (
              <ChartSkeleton h={220} />
            ) : (
              <>
                <div className="h-[230px]" role="img" aria-label="Calls and answered calls per day">
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
                              <p className="font-semibold">{kampalaDate(p.day)}</p>
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
                  title={LABEL_SELF_PAYMENT}
                  counts={[summary.aware_merchant_codes.knew, summary.aware_merchant_codes.heard, summary.aware_merchant_codes.did_not_know]}
                  pcts={[summary.aware_merchant_codes.knew_pct, summary.aware_merchant_codes.heard_pct, summary.aware_merchant_codes.did_not_know_pct]}
                  labels={['Knew about it', 'Heard but unsure', 'Did not know']}
                />
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
