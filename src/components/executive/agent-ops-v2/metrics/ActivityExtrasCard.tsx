import { useState } from 'react';
import { Block, CardShell, PersonRow, ShowMore, Stat, StatGrid } from './MetricsShared';
import { num } from './metricsFormat';
import { downloadCsvWithPreamble } from '@/lib/csvExport';
import { useMetricsRisk } from '@/hooks/useAgentOpsMetrics';
import { ACTIVITY_CSV_HEADERS, activityCsvRows, metricsCsvName, metricsPreamble } from '@/lib/agentMetrics';
import { FALLBACK_BASIS } from './totalsCards.shared';
import type { CardControls } from './MetricsShared';

const STEP = 20;

/** Agents who have gone quiet: listers with nothing in the last 30 days, and sub-agents who were linked but never listed a house. */
export function ActivityExtrasCard({ controls, from, to }: { controls: CardControls; from: string; to: string }) {
  const [limit, setLimit] = useState(10);
  const q = useMetricsRisk(from, to, limit, 0);
  const d = q.data;
  const s = d?.summary;
  const csv = d && (d.inactive_listers.length || d.never_listed_subagents.length)
    ? () => downloadCsvWithPreamble(metricsCsvName('activity', from, to), metricsPreamble('Activity', from, to, s?.basis || FALLBACK_BASIS), ACTIVITY_CSV_HEADERS, activityCsvRows(d))
    : undefined;
  return (
    <CardShell id="activity" controls={controls} state={q} basis={s?.basis || FALLBACK_BASIS} onCsv={csv} csvLabel="Download CSV: Activity (loaded rows)"
      empty={!!s && s.inactive_listers_count === 0 && s.never_listed_subagents_count === 0} emptyText="No inactive listers and no sub-agent who has never listed.">
      {d && s && (
        <>
          <StatGrid>
            <Stat label="Inactive listers" value={num(s.inactive_listers_count)} hint="Listed before, nothing in the last 30 days" testId="metrics-inactive-count" />
            <Stat label="Sub-agents who never listed" value={num(s.never_listed_subagents_count)} hint="Verified link, no house yet" testId="metrics-never-count" />
          </StatGrid>
          <Block title="Inactive listers" hint={`Nothing listed since before ${s.inactive_window_start}; most recent first`} state={q} empty={d.inactive_listers.length === 0} emptyText="No inactive listers." testId="metrics-inactive">
            <ul className="divide-y divide-border rounded-xl border border-border" data-testid="metrics-inactive-list">
              {d.inactive_listers.map((x) => (
                <PersonRow key={x.agent_id} name={x.name} phone={x.phone} detail={`${num(x.houses_listed_ever)} houses listed ever, last on ${x.last_listing ?? 'unknown'}`} figure={`${num(x.days_inactive)} days`} figureHint="inactive" />
              ))}
            </ul>
            <ShowMore shown={d.inactive_listers.length} total={s.inactive_listers_count} busy={q.isFetching} onMore={() => setLimit((l) => Math.min(200, l + STEP))} label="inactive listers" />
          </Block>
          <Block title="Sub-agents who never listed" hint="Verified links, oldest link first" state={q} empty={d.never_listed_subagents.length === 0} emptyText="Every linked sub-agent has listed a house." testId="metrics-never">
            <ul className="divide-y divide-border rounded-xl border border-border" data-testid="metrics-never-list">
              {d.never_listed_subagents.map((x) => (
                <PersonRow key={x.agent_id} name={x.name} phone={x.phone} detail={`Main agent ${x.main_agent_name ?? 'none'}, linked ${x.linked_on ?? 'unknown'}`} />
              ))}
            </ul>
            <ShowMore shown={d.never_listed_subagents.length} total={s.never_listed_subagents_count} busy={q.isFetching} onMore={() => setLimit((l) => Math.min(200, l + STEP))} label="sub-agents" />
          </Block>
        </>
      )}
    </CardShell>
  );
}
