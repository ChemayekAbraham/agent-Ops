import { CardShell, Stat, StatGrid } from './MetricsShared';
import { FALLBACK_BASIS, type TotalsCardProps } from './totalsCards.shared';
import { downloadCsvWithPreamble } from '@/lib/csvExport';
import { formatUGX } from '@/lib/rentCalculations';
import { metricsCsvName, metricsPreamble } from '@/lib/agentMetrics';

/** Listing money from the ledger only. Earned and clawed back are shown as the server returns them; the net of the two is per agent, in the Agents card. */
export function ListingEarningsCard({ controls, totals, from, to }: TotalsCardProps) {
  const t = totals.data;
  const csv = t ? () => downloadCsvWithPreamble(
    metricsCsvName('listing-earnings', from, to), metricsPreamble('Listing earnings', from, to, t.basis),
    ['Figure', 'Amount (UGX)'],
    [['Listing earnings', t.listing_earned], ['Clawed back', t.listing_clawed_back]],
  ) : undefined;
  return (
    <CardShell id="earnings" controls={controls} state={totals} basis={t?.basis || FALLBACK_BASIS} onCsv={csv} empty={!!t && t.listing_earned === 0 && t.listing_clawed_back === 0} emptyText="No listing earnings or clawbacks in these dates.">
      {t && (
        <>
          <StatGrid>
            <Stat label="Listing earnings" value={formatUGX(t.listing_earned)} hint="Paid into agent wallets" testId="metrics-listing-earned" />
            <Stat label="Clawed back" value={formatUGX(t.listing_clawed_back)} hint="Taken back for rejected listings" testId="metrics-listing-clawed" />
          </StatGrid>
          <p className="text-xs text-muted-foreground">Read from the ledger, never from the earnings table. The net for each agent is on the Agents card.</p>
        </>
      )}
    </CardShell>
  );
}
