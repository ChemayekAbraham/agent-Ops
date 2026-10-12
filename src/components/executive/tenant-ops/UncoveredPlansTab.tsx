import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, CircleAlert, Loader2, Phone, Search } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { UserDrilldownDrawer } from '@/components/ops/UserDrilldownDrawer';
import { useAgentMonitoringUncovered } from '@/hooks/useAgentMonitoringUncovered';
import {
  agentOptions,
  describePayout,
  filterUncovered,
  formatPipelineStatus,
  paginate,
  sortUncovered,
  summariseUncovered,
  type PayoutKind,
  type UncoveredBucket,
  type UncoveredPlanRow,
  type UncoveredSortKey,
} from '@/lib/agentMonitoringUncovered';

const PAGE_SIZE = 25;

const COPY: Record<UncoveredBucket, { title: string; intro: string; empty: string; daysLabel: string }> = {
  tenant_paying_no_landlord: {
    title: 'Tenant paying, landlord not paid',
    intro:
      'These Rent Plans have tenant repayments but no landlord payout yet, so the repayment clock has not started and no arrears are counted for them.',
    empty: 'No Rent Plan is in this position right now.',
    daysLabel: 'Days since funding',
  },
  awaiting_landlord: {
    title: 'Awaiting landlord payment',
    intro:
      'These funded Rent Plans have no landlord payout and no tenant repayment yet, so the repayment clock has not started.',
    empty: 'No funded Rent Plan is waiting for its landlord payout right now.',
    daysLabel: 'Days waiting',
  },
};

const SORTS: Record<UncoveredBucket, { value: UncoveredSortKey; label: string }[]> = {
  tenant_paying_no_landlord: [
    { value: 'repaid_desc', label: 'Most repaid' },
    { value: 'repaid_asc', label: 'Least repaid' },
    { value: 'days_desc', label: 'Longest since funding' },
    { value: 'funded_desc', label: 'Largest Rent Plan' },
    { value: 'name_asc', label: 'Tenant A–Z' },
  ],
  awaiting_landlord: [
    { value: 'days_desc', label: 'Longest waiting' },
    { value: 'funded_desc', label: 'Largest Rent Plan' },
    { value: 'name_asc', label: 'Tenant A–Z' },
  ],
};

function SummaryCard({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: string }) {
  return (
    <Card className="overflow-hidden border-border/70 shadow-sm last:col-span-2 sm:last:col-span-1">
      <CardContent className="flex min-w-0 flex-col p-3 sm:p-4">
        <p className="truncate text-[10px] font-semibold uppercase tracking-wide text-muted-foreground sm:text-[11px]">{label}</p>
        <p className={cn('mt-1.5 break-words text-[15px] font-bold leading-tight tabular-nums sm:text-xl', accent ?? 'text-foreground')}>{value}</p>
        {hint && <p className="mt-1 break-words text-[10px] leading-snug text-muted-foreground sm:text-xs">{hint}</p>}
      </CardContent>
    </Card>
  );
}

const PAYOUT_BADGE: Record<PayoutKind, string> = {
  none: 'border-border text-muted-foreground',
  pending: 'border-warning/40 bg-warning/10 text-warning-foreground',
  failed: 'border-destructive/40 bg-destructive/10 text-destructive',
  part_paid: 'border-primary/40 bg-primary/10 text-primary',
  paid_unrecorded: 'border-warning/40 bg-warning/10 text-warning-foreground',
};

function PayoutBadge({ row }: { row: UncoveredPlanRow }) {
  return (
    <Badge variant="outline" className={cn('h-auto whitespace-normal px-1.5 py-0.5 text-left text-[10px] font-medium leading-snug', PAYOUT_BADGE[row.payout.kind])}>
      {describePayout(row.payout, formatUGX)}
    </Badge>
  );
}

function daysText(days: number | null) {
  if (days === null) return '—';
  return `${days} day${days === 1 ? '' : 's'}`;
}

/**
 * Agent Monitoring list for Rent Plans the payout clock does not cover. Read-only: the only
 * link opens the existing tenant profile drawer.
 */
export function UncoveredPlansTab({ bucket }: { bucket: UncoveredBucket }) {
  const copy = COPY[bucket];
  const showRepayment = bucket === 'tenant_paying_no_landlord';
  const sorts = SORTS[bucket];
  const query = useAgentMonitoringUncovered();

  const [search, setSearch] = useState('');
  const [agentId, setAgentId] = useState('all');
  const [sort, setSort] = useState<UncoveredSortKey>(sorts[0].value);
  const [page, setPage] = useState(1);
  const [openTenant, setOpenTenant] = useState<{ tenantId: string; agentId: string | null } | null>(null);

  const rows = useMemo(
    () => (bucket === 'tenant_paying_no_landlord' ? query.data?.tenantPaying : query.data?.awaiting) ?? [],
    [bucket, query.data],
  );
  const agents = useMemo(() => agentOptions(rows), [rows]);
  const filtered = useMemo(() => filterUncovered(rows, { search, agentId }), [agentId, rows, search]);
  const sorted = useMemo(() => sortUncovered(filtered, sort), [filtered, sort]);
  const paged = useMemo(() => paginate(sorted, page, PAGE_SIZE), [page, sorted]);
  const summary = useMemo(() => summariseUncovered(filtered), [filtered]);

  // A new search, agent or sort always starts from the first page.
  useEffect(() => { setPage(1); }, [search, agentId, sort]);

  const ready = query.isSuccess;

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border bg-card p-4 shadow-sm">
        <h2 className="text-base font-bold tracking-tight sm:text-lg">{copy.title}</h2>
        <p className="mt-1 break-words text-xs text-muted-foreground">{copy.intro}</p>
        <p className="mt-1 break-words text-[11px] text-muted-foreground">
          Counted from the day after the landlord was paid, so nothing here is measured yet.
          {query.data ? ` Days counted to ${query.data.asOf}.` : ''}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3">
        {ready ? (
          showRepayment ? (
            <>
              <SummaryCard label="Rent Plans" value={String(summary.plans)} hint={agentId === 'all' && !search.trim() ? 'in this position' : `of ${rows.length} in this position`} accent="text-primary" />
              <SummaryCard label="Total repaid" value={formatUGX(summary.totalRepaid)} hint="paid by tenants so far" accent="text-success" />
              <SummaryCard label="Still owed" value={formatUGX(summary.totalOwed)} hint="left on these Rent Plans" accent={summary.totalOwed > 0 ? 'text-destructive' : undefined} />
            </>
          ) : (
            <>
              <SummaryCard label="Rent Plans" value={String(summary.plans)} hint={agentId === 'all' && !search.trim() ? 'waiting for the landlord' : `of ${rows.length} waiting`} accent="text-primary" />
              <SummaryCard label="Rent Plan amount funded" value={formatUGX(summary.totalFunded)} hint="not yet paid to landlords" />
              <SummaryCard label="Longest wait" value={summary.longestDays === null ? '—' : daysText(summary.longestDays)} hint="since funding" accent={(summary.longestDays ?? 0) >= 7 ? 'text-destructive' : undefined} />
            </>
          )
        ) : (
          Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="border-border/70"><CardContent className="p-3 sm:p-4"><Skeleton className="h-3 w-16" /><Skeleton className="mt-2 h-6 w-24" /></CardContent></Card>
          ))
        )}
      </div>

      <Card className="overflow-hidden border-border/70 shadow-sm">
        <div className="flex flex-col gap-2 border-b bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search tenant, phone or agent"
              aria-label="Search tenant, phone or agent"
              className="h-8 w-full bg-background pl-8 text-xs"
            />
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
            <Select value={agentId} onValueChange={setAgentId}>
              <SelectTrigger className="h-8 w-full bg-background text-xs sm:w-52" aria-label="Filter by agent">
                <SelectValue placeholder="All agents" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All agents ({rows.length})</SelectItem>
                {agents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>{agent.name} ({agent.count})</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={sort} onValueChange={(value) => setSort(value as UncoveredSortKey)}>
              <SelectTrigger className="h-8 w-full bg-background text-xs sm:w-48" aria-label="Sort by">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sorts.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <CardContent className="p-0">
          {query.isLoading ? (
            <div className="flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading Rent Plans…</div>
          ) : query.isError ? (
            <div className="flex flex-col items-center gap-3 p-10 text-center">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              <p className="text-sm text-muted-foreground">{query.error instanceof Error ? query.error.message : 'Unable to load these Rent Plans.'}</p>
              <Button variant="outline" size="sm" onClick={() => void query.refetch()}>Try again</Button>
            </div>
          ) : paged.total === 0 ? (
            <div className="flex flex-col items-center gap-2 p-10 text-center">
              <CircleAlert className="h-5 w-5 text-muted-foreground" />
              <p className="text-sm font-medium">{rows.length === 0 ? copy.empty : 'No Rent Plan matches this view'}</p>
              {rows.length > 0 && <p className="text-xs text-muted-foreground">Try clearing the search or the agent filter.</p>}
            </div>
          ) : (
            <>
              <div className="hidden overflow-x-auto md:block">
                <Table>
                  <TableHeader className="[&_th]:whitespace-nowrap [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide">
                    <TableRow className="bg-muted/20">
                      <TableHead>Tenant</TableHead>
                      <TableHead>Agent</TableHead>
                      <TableHead className="text-right">Rent Plan funded</TableHead>
                      {showRepayment && <TableHead className="text-right">Repaid so far</TableHead>}
                      {showRepayment && <TableHead className="text-right">Still owed</TableHead>}
                      <TableHead className="text-right">{copy.daysLabel}</TableHead>
                      <TableHead>Landlord payout</TableHead>
                      <TableHead>Pipeline status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paged.items.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell>
                          <div className="min-w-[160px]">
                            <Button variant="link" className="h-auto p-0 text-left font-semibold" onClick={() => setOpenTenant({ tenantId: row.tenantId, agentId: row.agentId })}>
                              {row.tenantName}
                            </Button>
                            <p className="text-xs text-muted-foreground">{row.tenantPhone || 'No phone number'}</p>
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">{row.agentName}</TableCell>
                        <TableCell className="whitespace-nowrap text-right tabular-nums">{formatUGX(row.fundedAmount)}</TableCell>
                        {showRepayment && <TableCell className="whitespace-nowrap text-right font-semibold tabular-nums text-success">{formatUGX(row.repaid)}</TableCell>}
                        {showRepayment && <TableCell className="whitespace-nowrap text-right tabular-nums">{formatUGX(row.stillOwed)}</TableCell>}
                        <TableCell className="whitespace-nowrap text-right tabular-nums">{daysText(row.daysSinceFunding)}</TableCell>
                        <TableCell className="max-w-[220px]"><PayoutBadge row={row} /></TableCell>
                        <TableCell className="whitespace-nowrap text-sm">{formatPipelineStatus(row.pipelineStatus)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="space-y-2 p-3 md:hidden">
                {paged.items.map((row) => (
                  <div key={row.id} className="rounded-xl border border-border/70 bg-card p-3 shadow-sm">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <Button variant="link" className="h-auto max-w-full whitespace-normal p-0 text-left text-sm font-semibold" onClick={() => setOpenTenant({ tenantId: row.tenantId, agentId: row.agentId })}>
                          {row.tenantName}
                        </Button>
                        {row.tenantPhone ? (
                          <a href={`tel:${row.tenantPhone.replace(/[^\d+]/g, '')}`} className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-2">
                            <Phone className="h-3 w-3" /> {row.tenantPhone}
                          </a>
                        ) : <p className="text-xs text-muted-foreground">No phone number</p>}
                        <p className="mt-0.5 break-words text-xs text-muted-foreground">Agent: {row.agentName}</p>
                      </div>
                      <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px]">{formatPipelineStatus(row.pipelineStatus)}</Badge>
                    </div>
                    <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                      <div><dt className="text-[10px] text-muted-foreground">Rent Plan funded</dt><dd className="font-semibold tabular-nums">{formatUGX(row.fundedAmount)}</dd></div>
                      <div><dt className="text-[10px] text-muted-foreground">{copy.daysLabel}</dt><dd className="font-semibold tabular-nums">{daysText(row.daysSinceFunding)}</dd></div>
                      {showRepayment && <div><dt className="text-[10px] text-muted-foreground">Repaid so far</dt><dd className="font-semibold tabular-nums text-success">{formatUGX(row.repaid)}</dd></div>}
                      {showRepayment && <div><dt className="text-[10px] text-muted-foreground">Still owed</dt><dd className="font-semibold tabular-nums">{formatUGX(row.stillOwed)}</dd></div>}
                    </dl>
                    <div className="mt-2"><PayoutBadge row={row} /></div>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2">
                <p className="text-xs tabular-nums text-muted-foreground">
                  {(paged.page - 1) * PAGE_SIZE + 1}–{Math.min(paged.page * PAGE_SIZE, paged.total)} of {paged.total} Rent Plans
                </p>
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="sm" className="h-8 gap-1 px-2 text-xs" disabled={paged.page <= 1} onClick={() => setPage(paged.page - 1)} aria-label="Previous page">
                    <ChevronLeft className="h-3.5 w-3.5" /> Prev
                  </Button>
                  <span className="px-1 text-xs tabular-nums text-muted-foreground">Page {paged.page} of {paged.pageCount}</span>
                  <Button variant="outline" size="sm" className="h-8 gap-1 px-2 text-xs" disabled={paged.page >= paged.pageCount} onClick={() => setPage(paged.page + 1)} aria-label="Next page">
                    Next <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <UserDrilldownDrawer
        open={Boolean(openTenant)}
        onOpenChange={(open) => { if (!open) setOpenTenant(null); }}
        tenantId={openTenant?.tenantId ?? null}
        agentId={openTenant?.agentId ?? undefined}
        defaultTab="tenant"
      />
    </div>
  );
}

export default UncoveredPlansTab;
