import { CardShell, Stat, StatGrid } from './MetricsShared';
import { num } from './metricsFormat';
import { FALLBACK_BASIS, type TotalsCardProps } from './totalsCards.shared';
import { downloadCsvWithPreamble } from '@/lib/csvExport';
import { metricsCsvName, metricsPreamble } from '@/lib/agentMetrics';

/** How much of the network is active in the dates: who listed, and how the listing and GPS counts sit beside the agent counts. */
export function ActivityExtrasCard({ controls, totals, from, to }: TotalsCardProps) {
  const t = totals.data;
  const csv = t ? () => downloadCsvWithPreamble(
    metricsCsvName('activity', from, to), metricsPreamble('Activity', from, to, t.basis),
    ['Figure', 'Value'],
    [['Agents who listed in the dates', t.listers_in_range], ['Qualifying agents', t.qualifying_agents], ['Houses with GPS', t.houses_with_gps], ['Houses listed', t.houses_listed], ['Rejections in the dates', t.houses_rejected]],
  ) : undefined;
  return (
    <CardShell id="activity" controls={controls} state={totals} basis={t?.basis || FALLBACK_BASIS} onCsv={csv} empty={!!t && t.listers_in_range === 0} emptyText="No agent listed a house in these dates.">
      {t && (
        <StatGrid>
          <Stat label="Agents who listed" value={num(t.listers_in_range)} hint="In the dates" testId="metrics-listers-range" />
          <Stat label="Qualifying agents" value={num(t.qualifying_agents)} hint="On the books today" />
          <Stat label="Houses with GPS" value={num(t.houses_with_gps)} hint={`Of ${num(t.houses_listed)} listed`} />
          <Stat label="Rejections" value={num(t.houses_rejected)} hint="In the dates" />
        </StatGrid>
      )}
    </CardShell>
  );
}
