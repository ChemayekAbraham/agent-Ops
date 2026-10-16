import { useState } from 'react';
import { Block, CardShell, PersonRow, ShowMore, Stat, StatGrid } from './MetricsShared';
import { num } from './metricsFormat';
import { FALLBACK_BASIS, type TotalsCardProps } from './totalsCards.shared';
import { downloadCsvWithPreamble } from '@/lib/csvExport';
import { formatUGX } from '@/lib/rentCalculations';
import { useMetricsQuality } from '@/hooks/useAgentOpsMetrics';
import { WAITING_CSV_HEADERS, metricsCsvName, metricsPreamble, waitingCsvRow } from '@/lib/agentMetrics';

const STEP = 20;

/** Houses listed in the chosen dates and where each stands, how good the listings are, and the pending houses that have waited longest. */
export function ListingsCard({ controls, totals, from, to }: TotalsCardProps) {
  const t = totals.data;
  const [limit, setLimit] = useState(10);
  const quality = useMetricsQuality(from, to, limit);
  const qn = quality.data?.network ?? null;
  const waiting = quality.data?.waiting ?? [];

  const csv = t ? () => downloadCsvWithPreamble(
    metricsCsvName('listings', from, to), metricsPreamble('Listings', from, to, t.basis),
    ['Figure', 'Houses'],
    [
      ['Listed', t.houses_listed], ['Verified', t.houses_verified], ['Pending', t.houses_pending], ['Rejected (rejection events)', t.houses_rejected], ['With GPS', t.houses_with_gps],
      ...(qn ? [['Currently rejected (listing status)', qn.houses_currently_rejected], ['Occupied', qn.occupied], ['Empty', qn.empty], ['Waiting for verification today', qn.waiting_total]] as (string | number)[][] : []),
    ],
  ) : undefined;
  const waitingCsv = waiting.length && qn ? () => downloadCsvWithPreamble(
    metricsCsvName('waiting-longest', from, to), metricsPreamble(`Waiting longest (${waiting.length} of ${qn.waiting_total})`, from, to, qn.basis), WAITING_CSV_HEADERS, waiting.map(waitingCsvRow),
  ) : undefined;

  return (
    <CardShell id="listings" controls={controls} state={totals} basis={t?.basis || FALLBACK_BASIS} onCsv={csv} empty={!!t && t.houses_listed === 0 && t.houses_rejected === 0} emptyText="No houses were listed in these dates.">
      {t && (
        <>
          <StatGrid>
            <Stat label="Houses listed" value={num(t.houses_listed)} hint="Created in the dates" testId="metrics-houses-listed" />
            <Stat label="Verified" value={num(t.houses_verified)} testId="metrics-houses-verified" />
            <Stat label="Pending" value={num(t.houses_pending)} hint="Not verified, not rejected" testId="metrics-houses-pending" />
            <Stat label="Rejected" value={num(t.houses_rejected)} hint="Rejections in the dates" testId="metrics-houses-rejected" />
            {qn && <Stat label="Currently rejected" value={num(qn.houses_currently_rejected)} hint="Houses from the dates that are rejected now" testId="metrics-houses-current-rejected" />}
            <Stat label="With GPS" value={num(t.houses_with_gps)} testId="metrics-houses-gps" />
          </StatGrid>
          <Block title="Listing quality" hint="Houses listed in the dates" state={quality} empty={!qn || qn.houses_listed === 0} emptyText="No houses were listed in these dates." testId="metrics-quality">
            {qn && (
              <StatGrid>
                <Stat label="Approval rate" value={qn.approval_rate == null ? 'None' : `${qn.approval_rate}%`} hint="Verified of listed" testId="metrics-approval-rate" />
                <Stat label="Days to verify" value={qn.avg_days_to_verify == null ? 'None' : `${qn.avg_days_to_verify}`} hint="Average, listing to verification" testId="metrics-days-to-verify" />
                <Stat label="Occupied" value={num(qn.occupied)} hint="Houses with a tenant" testId="metrics-occupied" />
                <Stat label="Empty" value={num(qn.empty)} hint="Houses with no tenant" testId="metrics-empty" />
                <Stat label="Earnings per verified house" value={qn.earn_per_approved == null ? 'None' : formatUGX(qn.earn_per_approved)} hint="Listing earnings of the dates" testId="metrics-earn-per-approved" />
              </StatGrid>
            )}
          </Block>
          <Block
            title="Waiting longest" hint={qn ? `${num(qn.waiting_total)} houses waiting for verification today, any date${qn.oldest_waiting_days != null ? `; the oldest has waited ${num(qn.oldest_waiting_days)} days` : ''}` : 'Pending houses, oldest first'}
            state={quality} empty={waiting.length === 0} emptyText="No house is waiting for verification." onCsv={waitingCsv} csvLabel="Download CSV: Waiting longest" testId="metrics-waiting"
          >
            <ul className="divide-y divide-border rounded-xl border border-border" data-testid="metrics-waiting-list">
              {waiting.map((w) => (
                <PersonRow key={w.listing_id} name={w.agent_name} phone={w.phone} detail={`${w.district ?? 'No district recorded'}, listed ${w.listed_at.slice(0, 10)}`} figure={`${num(w.days_waiting)} days`} figureHint="waiting" />
              ))}
            </ul>
            {qn && <ShowMore shown={waiting.length} total={qn.waiting_total} busy={quality.isFetching} onMore={() => setLimit((l) => Math.min(200, l + STEP))} label="waiting houses" />}
          </Block>
        </>
      )}
    </CardShell>
  );
}
