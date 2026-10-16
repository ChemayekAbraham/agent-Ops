import { CardShell, Stat, StatGrid } from './MetricsShared';
import { num } from './metricsFormat';
import { FALLBACK_BASIS, type TotalsCardProps } from './totalsCards.shared';
import { downloadCsvWithPreamble } from '@/lib/csvExport';
import { metricsCsvName, metricsPreamble } from '@/lib/agentMetrics';

/** Houses listed in the chosen dates and where each stands. */
export function ListingsCard({ controls, totals, from, to }: TotalsCardProps) {
  const t = totals.data;
  const csv = t ? () => downloadCsvWithPreamble(
    metricsCsvName('listings', from, to), metricsPreamble('Listings', from, to, t.basis),
    ['Figure', 'Houses'],
    [['Listed', t.houses_listed], ['Verified', t.houses_verified], ['Pending', t.houses_pending], ['Rejected (rejection events)', t.houses_rejected], ['With GPS', t.houses_with_gps]],
  ) : undefined;
  return (
    <CardShell id="listings" controls={controls} state={totals} basis={t?.basis || FALLBACK_BASIS} onCsv={csv} empty={!!t && t.houses_listed === 0 && t.houses_rejected === 0} emptyText="No houses were listed in these dates.">
      {t && (
        <StatGrid>
          <Stat label="Houses listed" value={num(t.houses_listed)} hint="Created in the dates" testId="metrics-houses-listed" />
          <Stat label="Verified" value={num(t.houses_verified)} testId="metrics-houses-verified" />
          <Stat label="Pending" value={num(t.houses_pending)} hint="Not verified, not rejected" testId="metrics-houses-pending" />
          <Stat label="Rejected" value={num(t.houses_rejected)} hint="Rejections in the dates" testId="metrics-houses-rejected" />
          <Stat label="With GPS" value={num(t.houses_with_gps)} testId="metrics-houses-gps" />
        </StatGrid>
      )}
    </CardShell>
  );
}
