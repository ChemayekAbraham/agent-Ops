import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Phone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useMetricsMainAgents } from '@/hooks/useAgentOpsMetrics';
import { downloadCsvWithPreamble } from '@/lib/csvExport';
import { formatUGX } from '@/lib/rentCalculations';
import { telHref } from '@/lib/awarenessCallLabels';
import { MAIN_CSV_HEADERS, METRICS_PAGE_SIZE, mainAgentCsvRow, metricsCsvName, metricsPreamble } from '@/lib/agentMetrics';
import { CardShell, ListSkeleton, type CardControls } from './MetricsShared';
import { num } from './metricsFormat';

const BASIS = 'A main agent is the agent a sub-agent is first verified under; each sub-agent counts once, deleted accounts are left out. Team figures cover the dates. Biggest team first. As the server returns them.';

export function MainAgentsCard({ controls, from, to }: { controls: CardControls; from: string; to: string }) {
  const [page, setPage] = useState(0);
  const q = useMetricsMainAgents(from, to, page);
  useEffect(() => { setPage(0); }, [from, to]);
  const last = Math.max(0, Math.ceil(q.total / METRICS_PAGE_SIZE) - 1);
  const shownFrom = q.rows.length ? page * METRICS_PAGE_SIZE + 1 : 0;
  const shownTo = page * METRICS_PAGE_SIZE + q.rows.length;
  const csv = q.rows.length
    ? () => downloadCsvWithPreamble(metricsCsvName('main-agents', from, to), metricsPreamble(`Main agents (rows ${shownFrom} to ${shownTo} of ${q.total})`, from, to, BASIS), MAIN_CSV_HEADERS, q.rows.map(mainAgentCsvRow))
    : undefined;
  return (
    <CardShell id="main-agents" controls={controls} state={q} basis={BASIS} onCsv={csv} csvLabel="Download CSV: Main agents (this page)" skeleton={<ListSkeleton />} empty={q.rows.length === 0 && !q.isFetching} emptyText="No main agents have a team yet.">
      <ul className="space-y-2 md:hidden" data-testid="metrics-main-cards">
        {q.rows.map((m) => {
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
            {q.rows.map((m) => {
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
        <p className="text-xs text-muted-foreground">{q.total ? `${num(shownFrom)} to ${num(shownTo)} of ${num(q.total)}` : ''}</p>
        <div className="flex gap-1">
          <Button type="button" variant="outline" className="min-h-11 min-w-11" disabled={page === 0 || q.isFetching} onClick={() => setPage((p) => Math.max(0, p - 1))} aria-label="Previous page of main agents"><ChevronLeft className="h-4 w-4" /></Button>
          <Button type="button" variant="outline" className="min-h-11 min-w-11" disabled={page >= last || q.isFetching} onClick={() => setPage((p) => Math.min(last, p + 1))} aria-label="Next page of main agents"><ChevronRight className="h-4 w-4" /></Button>
        </div>
      </div>
    </CardShell>
  );
}
