import { useState } from 'react';
import { Block, CardShell, PersonRow, ShowMore, Stat, StatGrid } from './MetricsShared';
import { num } from './metricsFormat';
import { downloadCsvWithPreamble } from '@/lib/csvExport';
import { formatUGX } from '@/lib/rentCalculations';
import { useMetricsRisk } from '@/hooks/useAgentOpsMetrics';
import { RISK_CSV_HEADERS, RISK_FLAG_LABEL, metricsCsvName, metricsPreamble, riskCsvRows } from '@/lib/agentMetrics';
import { FALLBACK_BASIS } from './totalsCards.shared';
import type { CardControls } from './MetricsShared';

const STEP = 20;

/** Advances against what agents earn from listings. Every figure, ratio and flag is the server's; nothing is worked out here. */
export function RiskCard({ controls, from, to }: { controls: CardControls; from: string; to: string }) {
  const [limit, setLimit] = useState(10);
  const q = useMetricsRisk(from, to, limit, 0);
  const d = q.data;
  const s = d?.summary;
  const csv = d && (d.advance_no_listing.length || d.advance_vs_earnings.length)
    ? () => downloadCsvWithPreamble(metricsCsvName('risk', from, to), metricsPreamble('Risk', from, to, s?.basis || FALLBACK_BASIS), RISK_CSV_HEADERS, riskCsvRows(d))
    : undefined;
  const more = () => setLimit((l) => Math.min(200, l + STEP));
  return (
    <CardShell id="risk" controls={controls} state={q} basis={s?.basis || FALLBACK_BASIS} onCsv={csv} csvLabel="Download CSV: Risk (loaded rows)"
      empty={!!s && s.owing_agents === 0} emptyText="No agent has an advance outstanding.">
      {d && s && (
        <>
          <StatGrid>
            <Stat label="Advance, no listing" value={num(s.advance_no_listing_count)} hint={`${formatUGX(s.advance_no_listing_amount)} outstanding`} testId="metrics-risk-nolisting" />
            <Stat label="Agents owing" value={num(s.owing_agents)} hint={`${formatUGX(s.owing_amount)} outstanding`} testId="metrics-risk-owing" />
            <Stat label="No listing earnings" value={num(s.flag_no_earnings)} testId="metrics-risk-flag-none" />
            <Stat label="High" value={num(s.flag_high)} hint="Advance 3x earnings or more" testId="metrics-risk-flag-high" />
            <Stat label="Watch" value={num(s.flag_watch)} hint="1x to 3x" testId="metrics-risk-flag-watch" />
            <Stat label="Low" value={num(s.flag_ok)} hint="Under 1x" testId="metrics-risk-flag-ok" />
          </StatGrid>
          <Block title="Advance with no listing" hint="Owe an advance and listed no house in the dates; biggest first" state={q} empty={d.advance_no_listing.length === 0} emptyText="No agent with an advance is without a listing." testId="metrics-risk-nolisting-block">
            <ul className="divide-y divide-border rounded-xl border border-border" data-testid="metrics-risk-nolisting-list">
              {d.advance_no_listing.map((x) => (
                <PersonRow key={x.agent_id} name={x.name} phone={x.phone} detail={`Last listing ${x.last_listing ?? 'none'}`} figure={formatUGX(x.advance_outstanding)} figureHint="outstanding" />
              ))}
            </ul>
            <ShowMore shown={d.advance_no_listing.length} total={s.advance_no_listing_count} busy={q.isFetching} onMore={more} label="agents with no listing" />
          </Block>
          <Block title="Advance against listing earnings" hint="Worst flag first, then biggest advance" state={q} empty={d.advance_vs_earnings.length === 0} emptyText="No agent owes an advance." testId="metrics-risk-ratio-block">
            <ul className="divide-y divide-border rounded-xl border border-border" data-testid="metrics-risk-ratio-list">
              {d.advance_vs_earnings.map((x) => (
                <PersonRow
                  key={x.agent_id} name={x.name} phone={x.phone}
                  detail={`Listing earnings ${formatUGX(x.listing_earned)}${x.ratio != null ? `, advance is ${x.ratio}x` : ''}`}
                  badge={RISK_FLAG_LABEL[x.flag]} figure={formatUGX(x.advance_outstanding)} figureHint="outstanding"
                />
              ))}
            </ul>
            <ShowMore shown={d.advance_vs_earnings.length} total={s.owing_agents} busy={q.isFetching} onMore={more} label="agents owing" />
          </Block>
        </>
      )}
    </CardShell>
  );
}
