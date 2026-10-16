import { CardShell, Stat, StatGrid } from './MetricsShared';
import { num } from './metricsFormat';
import { FALLBACK_BASIS, type TotalsCardProps } from './totalsCards.shared';
import { downloadCsvWithPreamble } from '@/lib/csvExport';
import { metricsCsvName, metricsPreamble } from '@/lib/agentMetrics';

/** The people counts: who is on the books today and who has listed. */
export function HeadlineCard({ controls, totals, from, to }: TotalsCardProps) {
  const t = totals.data;
  const csv = t ? () => downloadCsvWithPreamble(
    metricsCsvName('headline', from, to), metricsPreamble('Headline', from, to, t.basis),
    ['Figure', 'Value'],
    [['Users with the agent role', t.agents_role], ['Qualifying agents', t.qualifying_agents], ['Linked sub-agents', t.linked_subagents], ['Agents who have ever listed', t.listers_ever], ['Agents who listed in the dates', t.listers_in_range]],
  ) : undefined;
  return (
    <CardShell id="headline" controls={controls} state={totals} basis={t?.basis || FALLBACK_BASIS} onCsv={csv}>
      {t && (
        <StatGrid>
          <Stat label="Qualifying agents" value={num(t.qualifying_agents)} hint="Counted as agents by Agent Ops" testId="metrics-qualifying" />
          <Stat label="Agent role" value={num(t.agents_role)} hint="Everyone holding the agent role" />
          <Stat label="Linked sub-agents" value={num(t.linked_subagents)} hint="Verified sub-agent links" />
          <Stat label="Have ever listed" value={num(t.listers_ever)} hint="At least one house, ever" />
          <Stat label="Listed in the dates" value={num(t.listers_in_range)} hint="At least one house in the dates" />
        </StatGrid>
      )}
    </CardShell>
  );
}
