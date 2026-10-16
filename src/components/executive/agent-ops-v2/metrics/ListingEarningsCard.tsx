import { Block, CardShell, PersonRow, Stat, StatGrid } from './MetricsShared';
import { FALLBACK_BASIS, type TotalsCardProps } from './totalsCards.shared';
import { downloadCsvWithPreamble } from '@/lib/csvExport';
import { formatUGX } from '@/lib/rentCalculations';
import { useMetricsTopEarners } from '@/hooks/useAgentOpsMetrics';
import { TOP_EARNER_CSV_HEADERS, metricsCsvName, metricsPreamble, topEarnerCsvRow } from '@/lib/agentMetrics';
import { num } from './metricsFormat';

/** Listing money from the ledger only. Earned and clawed back are shown as the server returns them; the net of the two is per agent, in the Agents card. */
export function ListingEarningsCard({ controls, totals, from, to }: TotalsCardProps) {
  const t = totals.data;
  const top = useMetricsTopEarners(from, to, 5);
  const earners = top.rows.filter((a) => a.listing_earned > 0);
  const csv = t ? () => downloadCsvWithPreamble(
    metricsCsvName('listing-earnings', from, to), metricsPreamble('Listing earnings', from, to, t.basis),
    ['Figure', 'Amount (UGX)'],
    [['Listing earnings', t.listing_earned], ['Clawed back', t.listing_clawed_back]],
  ) : undefined;
  const topCsv = earners.length ? () => downloadCsvWithPreamble(
    metricsCsvName('top-earners', from, to), metricsPreamble(`Top earners (${earners.length})`, from, to, t?.basis || FALLBACK_BASIS), TOP_EARNER_CSV_HEADERS, earners.map(topEarnerCsvRow),
  ) : undefined;
  return (
    <CardShell id="earnings" controls={controls} state={totals} basis={t?.basis || FALLBACK_BASIS} onCsv={csv} empty={!!t && t.listing_earned === 0 && t.listing_clawed_back === 0} emptyText="No listing earnings or clawbacks in these dates.">
      {t && (
        <>
          <StatGrid>
            <Stat label="Listing earnings" value={formatUGX(t.listing_earned)} hint="Paid into agent wallets" testId="metrics-listing-earned" />
            <Stat label="Clawed back" value={formatUGX(t.listing_clawed_back)} hint="Taken back for rejected listings" testId="metrics-listing-clawed" />
          </StatGrid>
          <Block title="Top earners" hint="Most listing earnings in the dates" state={top} empty={earners.length === 0} emptyText="No agent earned listing money in these dates." onCsv={topCsv} csvLabel="Download CSV: Top earners" testId="metrics-top-earners">
            <ul className="divide-y divide-border rounded-xl border border-border" data-testid="metrics-top-earners-list">
              {earners.map((a) => (
                <PersonRow key={a.agent_id} name={a.name} phone={a.phone} detail={`${num(a.houses_listed)} listed, ${num(a.houses_approved)} verified`} figure={formatUGX(a.listing_earned)} figureHint={`net ${formatUGX(a.net)}`} />
              ))}
            </ul>
          </Block>
          <p className="text-xs text-muted-foreground">Read from the ledger, never from the earnings table. The net for each agent is on the Agents card.</p>
        </>
      )}
    </CardShell>
  );
}
