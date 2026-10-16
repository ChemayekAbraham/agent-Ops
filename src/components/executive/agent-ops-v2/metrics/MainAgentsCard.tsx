import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Phone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useMetricsMainAgents, useMetricsRisk } from '@/hooks/useAgentOpsMetrics';
import { downloadCsvWithPreamble } from '@/lib/csvExport';
import { formatUGX } from '@/lib/rentCalculations';
import { telHref } from '@/lib/awarenessCallLabels';
import { MAIN_CSV_HEADERS, METRICS_PAGE_SIZE, mainAgentCsvRow, metricsCsvName, metricsPreamble, type MetricsMainAgent } from '@/lib/agentMetrics';
import { CardShell, ListSkeleton, type CardControls } from './MetricsShared';
import { num } from './metricsFormat';

const BASIS_OWES = 'A main agent is the agent a sub-agent is first verified under. "Team owes most" ranks main agents by the advance outstanding today of their team, biggest first; only teams that owe something are listed. Deleted accounts are left out. As the server returns them.';
const BASIS = 'A main agent is the agent a sub-agent is first verified under; each sub-agent counts once, deleted accounts are left out. Team figures cover the dates. Biggest team first. As the server returns them.';

export function MainAgentsCard({ controls, from, to }: { controls: CardControls; from: string; to: string }) {
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<'size' | 'owes'>('size');
  const bySize = useMetricsMainAgents(from, to, page, sort === 'size');
  const byOwes = useMetricsRisk(from, to, METRICS_PAGE_SIZE, page * METRICS_PAGE_SIZE, sort === 'owes');
  useEffect(() => { setPage(0); }, [from, to, sort]);
  const owes = sort === 'owes';
  // both answers are shown as the server returns them; the risk answer only carries a different list name
  const rows: MetricsMainAgent[] = owes
    ? (byOwes.data?.main_agents_by_advance ?? []).map((m) => ({ ...m, total_matched: byOwes.data?.summary.main_agents_owing_count ?? 0 }))
    : bySize.rows;
  const total = owes ? (byOwes.data?.summary.main_agents_owing_count ?? 0) : bySize.total;
  const q = owes ? byOwes : bySize;
  const basis = owes ? BASIS_OWES : BASIS;
  const last = Math.max(0, Math.ceil(total / METRICS_PAGE_SIZE) - 1);
  const shownFrom = rows.length ? page * METRICS_PAGE_SIZE + 1 : 0;
  const shownTo = page * METRICS_PAGE_SIZE + rows.length;
  const csv = rows.length
    ? () => downloadCsvWithPreamble(metricsCsvName(owes ? 'main-agents-team-owes' : 'main-agents', from, to), metricsPreamble(`Main agents, ${owes ? 'team owes most' : 'biggest team'} (rows ${shownFrom} to ${shownTo} of ${total})`, from, to, basis), MAIN_CSV_HEADERS, rows.map(mainAgentCsvRow))
    : undefined;
  return (
    <CardShell id="main-agents" controls={controls} state={q} basis={basis} onCsv={csv} csvLabel="Download CSV: Main agents (this page)" skeleton={<ListSkeleton />} empty={rows.length === 0 && !q.isFetching} emptyText={owes ? 'No team owes an advance.' : 'No main agents have a team yet.'}>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Order main agents by">
        <Button type="button" size="sm" variant={!owes ? 'default' : 'outline'} aria-pressed={!owes} className="min-h-11" onClick={() => setSort('size')}>Biggest team</Button>
        <Button type="button" size="sm" variant={owes ? 'default' : 'outline'} aria-pressed={owes} className="min-h-11" onClick={() => setSort('owes')}>Team owes most</Button>
      </div>
      <ul className="space-y-2 md:hidden" data-testid="metrics-main-cards">
        {rows.map((m) => {
          const href = telHref(m.phone);
          return (
            <li key={m.main_agent_id} className="flex flex-col gap-1 rounded-xl border border-border bg-card p-3">
              <div className="flex items-start justify-between gap-2">
                <span className="truncate text-sm font-semibold text-foreground">{m.name}</span>
                {href && <a href={href} aria-label={`Call ${m.name}`} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Phone className="h-4 w-4" /></a>}
              </div>
              <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground"><span>{num(m.team_size)} sub-agents</span><span>{num(m.team_houses)} houses</span></span>
              <span className="text-sm font-bold tabular-nums text-foreground">{formatUGX(m.team_earnings)}<span className="ml-1 text-xs font-normal text-muted-foreground">team listing earnings</span></span>
              <span className="text-xs text-muted-foreground">{formatUGX(m.team_advances_outstanding)} advances outstanding</span>
            </li>
          );
        })}
      </ul>
      <div className="hidden md:block" data-testid="metrics-main-table">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Main agent</TableHead><TableHead className="text-right">Sub-agents</TableHead><TableHead className="text-right">Team houses</TableHead>
              <TableHead className="text-right">Team listing earnings</TableHead><TableHead className="text-right">Advances outstanding</TableHead><TableHead className="w-14"><span className="sr-only">Call</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((m) => {
              const href = telHref(m.phone);
              return (
                <TableRow key={m.main_agent_id}>
                  <TableCell className="font-medium">{m.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(m.team_size)}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(m.team_houses)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatUGX(m.team_earnings)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatUGX(m.team_advances_outstanding)}</TableCell>
                  <TableCell>{href && <a href={href} aria-label={`Call ${m.name}`} className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Phone className="h-4 w-4" /></a>}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{total ? `${num(shownFrom)} to ${num(shownTo)} of ${num(total)}` : ''}</p>
        <div className="flex gap-1">
          <Button type="button" variant="outline" className="min-h-11 min-w-11" disabled={page === 0 || q.isFetching} onClick={() => setPage((p) => Math.max(0, p - 1))} aria-label="Previous page of main agents"><ChevronLeft className="h-4 w-4" /></Button>
          <Button type="button" variant="outline" className="min-h-11 min-w-11" disabled={page >= last || q.isFetching} onClick={() => setPage((p) => Math.min(last, p + 1))} aria-label="Next page of main agents"><ChevronRight className="h-4 w-4" /></Button>
        </div>
      </div>
    </CardShell>
  );
}
