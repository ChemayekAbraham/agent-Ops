import { useEffect, useState } from 'react';
import { ArrowDownAZ, ArrowUpAZ, ChevronLeft, ChevronRight, Phone, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useMetricsAgents } from '@/hooks/useAgentOpsMetrics';
import { downloadCsvWithPreamble } from '@/lib/csvExport';
import { formatUGX } from '@/lib/rentCalculations';
import { telHref } from '@/lib/awarenessCallLabels';
import {
  AGENT_CSV_HEADERS, METRICS_PAGE_SIZE, METRICS_SCOPES, METRICS_SORTS, agentCsvRow, metricsCsvName, metricsPreamble,
  type MetricsAgent, type MetricsScope,
} from '@/lib/agentMetrics';
import { CardShell, ListSkeleton, type CardControls } from './MetricsShared';
import { num } from './metricsFormat';

const BASIS = 'One row per person. Houses are listings created in the dates; listing money is from the ledger only. Advances given are those issued in the dates; advance outstanding is today\'s balance; the status is the latest advance. Figures as the server returns them.';

interface Props {
  controls: CardControls;
  from: string;
  to: string;
  scope: MetricsScope;
  sort: string;
  onScope: (s: MetricsScope) => void;
  onSort: (s: string) => void;
}

const sortParts = (sort: string) => {
  const [col, dir] = sort.split(':');
  return { col, dir: dir ?? (col === 'name' ? 'asc' : 'desc') };
};

export function AgentsCard({ controls, from, to, scope, sort, onScope, onSort }: Props) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<MetricsAgent | null>(null);
  const q = useMetricsAgents({ from, to, search, sort, scope, page });
  const { col, dir } = sortParts(sort);

  useEffect(() => { setPage(0); }, [from, to, scope, sort, search]);

  const last = Math.max(0, Math.ceil(q.total / METRICS_PAGE_SIZE) - 1);
  const shownFrom = q.rows.length ? page * METRICS_PAGE_SIZE + 1 : 0;
  const shownTo = page * METRICS_PAGE_SIZE + q.rows.length;
  const csv = q.rows.length
    ? () => downloadCsvWithPreamble(metricsCsvName('agents', from, to), metricsPreamble(`Agents (${METRICS_SCOPES.find((s) => s.id === scope)?.label}, rows ${shownFrom} to ${shownTo} of ${q.total})`, from, to, BASIS), AGENT_CSV_HEADERS, q.rows.map(agentCsvRow))
    : undefined;

  return (
    <CardShell
      id="agents" controls={controls} state={q} basis={BASIS} onCsv={csv} csvLabel="Download CSV: Agents (this page)"
      skeleton={<ListSkeleton />}
      empty={q.rows.length === 0 && !q.isFetching} emptyText={search.trim() ? 'No agent matches that search.' : 'No agents to show for these dates.'}
    >
      <AgentFilters search={search} onSearch={setSearch} scope={scope} onScope={onScope} col={col} dir={dir} onSort={onSort} />
      {/* phones: one card per agent */}
      <ul className="space-y-2 md:hidden" data-testid="metrics-agent-cards">
        {q.rows.map((a) => (
          <li key={a.agent_id}>
            <button type="button" onClick={() => setOpen(a)} className="flex min-h-11 w-full flex-col gap-1 rounded-xl border border-border bg-card p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Open ${a.name}`}>
              <span className="truncate text-sm font-semibold text-foreground">{a.name}</span>
              <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                <span>{num(a.houses_listed)} listed</span>
                <span>{num(a.houses_approved)} verified</span>
                <span>{num(a.houses_pending)} pending</span>
              </span>
              <span className="text-sm font-bold tabular-nums text-foreground">{formatUGX(a.net)}<span className="ml-1 text-xs font-normal text-muted-foreground">net listing earnings</span></span>
            </button>
          </li>
        ))}
      </ul>
      {/* md and up: a table */}
      <div className="hidden md:block" data-testid="metrics-agent-table">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead>Main agent</TableHead>
              <TableHead className="text-right">Listed</TableHead>
              <TableHead className="text-right">Verified</TableHead>
              <TableHead className="text-right">Pending</TableHead>
              <TableHead className="text-right">Earned</TableHead>
              <TableHead className="text-right">Net</TableHead>
              <TableHead className="text-right">Advance owed today</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.rows.map((a) => (
              <TableRow key={a.agent_id} className="cursor-pointer" onClick={() => setOpen(a)}>
                <TableCell className="font-medium"><button type="button" className="min-h-11 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Open ${a.name}`}>{a.name}</button></TableCell>
                <TableCell className="text-muted-foreground">{a.main_agent_name ?? 'None'}</TableCell>
                <TableCell className="text-right tabular-nums">{num(a.houses_listed)}</TableCell>
                <TableCell className="text-right tabular-nums">{num(a.houses_approved)}</TableCell>
                <TableCell className="text-right tabular-nums">{num(a.houses_pending)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatUGX(a.listing_earned)}</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{formatUGX(a.net)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatUGX(a.advance_outstanding)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between gap-2" data-testid="metrics-agent-pager">
        <p className="text-xs text-muted-foreground">{q.total ? `${num(shownFrom)} to ${num(shownTo)} of ${num(q.total)}` : ''}</p>
        <div className="flex gap-1">
          <Button type="button" variant="outline" className="min-h-11 min-w-11" disabled={page === 0 || q.isFetching} onClick={() => setPage((p) => Math.max(0, p - 1))} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></Button>
          <Button type="button" variant="outline" className="min-h-11 min-w-11" disabled={page >= last || q.isFetching} onClick={() => setPage((p) => Math.min(last, p + 1))} aria-label="Next page"><ChevronRight className="h-4 w-4" /></Button>
        </div>
      </div>
      <AgentSheet agent={open} onClose={() => setOpen(null)} />
    </CardShell>
  );
}

function AgentFilters({ search, onSearch, scope, onScope, col, dir, onSort }: {
  search: string; onSearch: (v: string) => void; scope: MetricsScope; onScope: (s: MetricsScope) => void; col: string; dir: string; onSort: (s: string) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={search} onChange={(e) => onSearch(e.target.value)} placeholder="Search by name or phone" className="h-11 pl-9" aria-label="Search agents" inputMode="search" />
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <Select value={scope} onValueChange={(v) => onScope(v as MetricsScope)}>
          <SelectTrigger className="h-11" aria-label="Who to list"><SelectValue /></SelectTrigger>
          <SelectContent>{METRICS_SCOPES.map((s) => <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={col} onValueChange={(v) => onSort(v === 'name' ? 'name:asc' : v)}>
          <SelectTrigger className="h-11" aria-label="Sort by"><SelectValue /></SelectTrigger>
          <SelectContent>{METRICS_SORTS.map((s) => <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>)}</SelectContent>
        </Select>
        <Button type="button" variant="outline" className="min-h-11 min-w-11" onClick={() => onSort(`${col}:${dir === 'asc' ? 'desc' : 'asc'}`)} aria-label={dir === 'asc' ? 'Sorted ascending, switch to descending' : 'Sorted descending, switch to ascending'}>
          {dir === 'asc' ? <ArrowUpAZ className="h-4 w-4" /> : <ArrowDownAZ className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}

function AgentSheet({ agent, onClose }: { agent: MetricsAgent | null; onClose: () => void }) {
  const href = telHref(agent?.phone);
  const rows: [string, string][] = agent ? [
    ['Main agent', agent.main_agent_name ?? 'None'],
    ['Houses listed', num(agent.houses_listed)],
    ['Houses verified', num(agent.houses_approved)],
    ['Houses pending', num(agent.houses_pending)],
    ['Houses rejected', num(agent.houses_rejected)],
    ['Top district', agent.top_district ?? 'None'],
    ['GPS share', `${agent.gps_share}%`],
    ['Last listing', agent.last_listing ?? 'None'],
    ['Listing earnings', formatUGX(agent.listing_earned)],
    ['Clawed back', formatUGX(agent.clawed_back)],
    ['Net listing earnings', formatUGX(agent.net)],
    ['Advances given in the dates', formatUGX(agent.advance_principal)],
    ['Advance outstanding today', formatUGX(agent.advance_outstanding)],
    ['Latest advance status', agent.advance_status ?? 'None'],
  ] : [];
  return (
    <Sheet open={!!agent} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto rounded-t-2xl" data-testid="metrics-agent-sheet">
        <SheetHeader className="text-left">
          <SheetTitle>{agent?.name}</SheetTitle>
          <SheetDescription>{agent?.phone ?? 'No phone recorded'}</SheetDescription>
        </SheetHeader>
        {href && agent && (
          <Button asChild className="mt-3 min-h-11 w-full">
            <a href={href} aria-label={`Call ${agent.name}`}><Phone className="mr-2 h-4 w-4" />Call {agent.phone}</a>
          </Button>
        )}
        <dl className="mt-3 divide-y divide-border">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-baseline justify-between gap-3 py-2">
              <dt className="text-sm text-muted-foreground">{k}</dt>
              <dd className="text-right text-sm font-semibold tabular-nums text-foreground">{v}</dd>
            </div>
          ))}
        </dl>
      </SheetContent>
    </Sheet>
  );
}
