import { useMemo, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Clock, Download, Loader2, RefreshCw, Search, Wallet } from 'lucide-react';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { downloadCsv } from '@/lib/csvExport';
import {
  DEFAULT_FILTERS, EXCEPTIONS, computeKpis, csvFileName, csvTable, exceptionLabel, filterRows, isBehind, sortRows,
  type ExceptionCode, type RepaymentPlanRow, type SortKey, type TrackerFilters,
} from '@/lib/tenantRepaymentTracker';
import { useTenantRepaymentRegister } from '@/hooks/useTenantRepaymentTracker';
import { TenantRepaymentDetailSheet } from './TenantRepaymentDetailSheet';

const PAGE = 50;

function Kpi({ icon: Icon, label, value, sub, tone }: { icon: typeof Wallet; label: string; value: string; sub?: string; tone?: 'warn' | 'bad' }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground"><Icon className="h-3.5 w-3.5" />{label}</div>
        <p className={`mt-1 text-xl font-bold tabular-nums ${tone === 'bad' ? 'text-destructive' : tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : ''}`}>{value}</p>
        {sub && <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

/**
 * CFO Tenant Repayment Tracker. Read-only: balances are calculated from what was collected (Money In from 1 Oct 2026, receipts
 * before that), never from the stored status, and a manual balance reduction is never a repayment.
 */
export default function TenantRepaymentTracker() {
  const { data, isFetching, error, refetch } = useTenantRepaymentRegister();
  const [filters, setFilters] = useState<TrackerFilters>(DEFAULT_FILTERS);
  const [sort, setSort] = useState<SortKey>('calc_outstanding');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<RepaymentPlanRow | null>(null);

  const rows = data?.rows ?? [];
  const kpis = useMemo(() => computeKpis(rows), [rows]);
  const filtered = useMemo(() => sortRows(filterRows(rows, filters), sort), [rows, filters, sort]);
  const exceptionCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) for (const e of r.exceptions) m.set(e, (m.get(e) ?? 0) + 1);
    return m;
  }, [rows]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const shown = filtered.slice(page * PAGE, page * PAGE + PAGE);
  const set = (patch: Partial<TrackerFilters>) => { setFilters((f) => ({ ...f, ...patch })); setPage(0); };

  const exportCsv = () => {
    const t = csvTable(filtered);
    downloadCsv(csvFileName(data?.asAt), t.headers, t.rows);
  };

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-border/80 bg-gradient-to-r from-card via-card to-muted/20 p-5 sm:p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Tenant Repayment Tracker</h1>
            <p className="mt-1 text-xs sm:text-sm text-muted-foreground max-w-3xl">
              Every funded Rent Plan. Collected is what Money In shows under Tenant Products and Services (from 1 Oct 2026; collection
              receipts before that). Balance edits are shown as adjustments, never as repayments. Read-only: nothing here changes a balance,
              a repayment or the books.
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching} className="gap-1.5">
              {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh
            </Button>
            <Button size="sm" onClick={exportCsv} disabled={!filtered.length} className="gap-1.5">
              <Download className="h-3.5 w-3.5" /> Export CSV ({filtered.length})
            </Button>
          </div>
        </div>
        {data && <p className="mt-2 text-[11px] text-muted-foreground">As at {data.asAt.toLocaleString('en-GB', { timeZone: 'Africa/Kampala' })} (Kampala time).</p>}
      </div>

      {error && (
        <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          Could not load the tracker: {(error as Error).message}
        </p>
      )}
      {!data && !error && (
        <p className="py-10 text-center text-sm text-muted-foreground inline-flex w-full justify-center items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Calculating every Rent Plan from its receipts (can take a few seconds)...
        </p>
      )}

      {data && (
        <>
          <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
            <Kpi icon={Wallet} label="Active plans" value={kpis.activePlans.toLocaleString()} sub={`${formatUGX(kpis.activeOutstanding)} outstanding`} />
            <Kpi icon={Wallet} label="Total outstanding" value={formatUGX(kpis.totalOutstanding)}
              sub={`Recorded balances say ${formatUGX(kpis.storedOutstanding)}`} tone={kpis.totalOutstanding - kpis.storedOutstanding >= 1000 ? 'warn' : undefined} />
            <Kpi icon={Clock} label="Overdue plans" value={kpis.overduePlans.toLocaleString()} sub={`${formatUGX(kpis.overdueArrears)} behind schedule`} tone={kpis.overduePlans ? 'warn' : undefined} />
            <Kpi icon={CheckCircle2} label="Completed plans" value={kpis.completedPlans.toLocaleString()}
              sub={kpis.completedWithBalance ? `${kpis.completedWithBalance} still owe on collections` : 'All fully collected'} tone={kpis.completedWithBalance ? 'bad' : undefined} />
          </div>

          {exceptionCounts.size > 0 && (
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-sm font-semibold"><AlertTriangle className="h-4 w-4 text-destructive" /> Exceptions: {kpis.plansWithExceptions} plans</div>
                <p className="text-xs text-muted-foreground mt-0.5">Where the plan's status, what was collected and the books disagree. Select one to filter.</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(Object.keys(EXCEPTIONS) as ExceptionCode[]).filter((c) => exceptionCounts.get(c)).map((c) => (
                    <button key={c} type="button" onClick={() => set({ exception: filters.exception === c ? 'all' : c })}
                      title={EXCEPTIONS[c].meaning}
                      className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${filters.exception === c ? 'border-primary bg-primary/10' : EXCEPTIONS[c].severity === 'high' ? 'border-destructive/40 hover:bg-destructive/5' : 'border-amber-500/40 hover:bg-amber-500/5'}`}>
                      {EXCEPTIONS[c].label} <span className="tabular-nums font-semibold">{exceptionCounts.get(c)}</span>
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="flex flex-col lg:flex-row gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input value={filters.search} onChange={(e) => set({ search: e.target.value })} placeholder="Search tenant, phone, agent, landlord or plan ID"
                    className="pl-8" aria-label="Search the register" />
                </div>
                <Select value={filters.status} onValueChange={(v) => set({ status: v as TrackerFilters['status'] })}>
                  <SelectTrigger className="lg:w-40" aria-label="Status"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="completed">Completed</SelectItem>
                    <SelectItem value="other">Other (cancelled etc.)</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={filters.schedule} onValueChange={(v) => set({ schedule: v as TrackerFilters['schedule'] })}>
                  <SelectTrigger className="lg:w-40" aria-label="Schedule"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any schedule</SelectItem>
                    <SelectItem value="behind">Behind schedule</SelectItem>
                    <SelectItem value="on_track">On track</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={filters.exception} onValueChange={(v) => set({ exception: v as TrackerFilters['exception'] })}>
                  <SelectTrigger className="lg:w-56" aria-label="Exceptions"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All plans</SelectItem>
                    <SelectItem value="any">With any exception</SelectItem>
                    <SelectItem value="none">No exceptions</SelectItem>
                    {(Object.keys(EXCEPTIONS) as ExceptionCode[]).map((c) => <SelectItem key={c} value={c}>{EXCEPTIONS[c].label}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
                  <SelectTrigger className="lg:w-48" aria-label="Sort"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="calc_outstanding">Largest outstanding</SelectItem>
                    <SelectItem value="arrears">Largest arrears</SelectItem>
                    <SelectItem value="repaid_without_receipts">Repaid without collections</SelectItem>
                    <SelectItem value="obligation">Largest obligation</SelectItem>
                    <SelectItem value="funded_at">Most recently funded</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p className="text-xs text-muted-foreground">{filtered.length.toLocaleString()} of {rows.length.toLocaleString()} plans</p>

              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Tenant</TableHead>
                      <TableHead className="hidden md:table-cell">Agent</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Owed</TableHead>
                      <TableHead className="text-right">Collected</TableHead>
                      <TableHead className="text-right">Outstanding</TableHead>
                      <TableHead className="hidden lg:table-cell w-32">Progress</TableHead>
                      <TableHead className="hidden md:table-cell text-right">Arrears</TableHead>
                      <TableHead>Exceptions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {shown.map((r) => (
                      <TableRow key={r.rent_request_id} className="cursor-pointer" onClick={() => setSelected(r)} data-testid="tracker-row">
                        <TableCell className="text-xs">
                          <div className="font-medium">{r.tenant_name ?? 'Unknown'}</div>
                          <div className="text-muted-foreground">{r.tenant_phone ?? ''}</div>
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-xs">{r.agent_name ?? '—'}</TableCell>
                        <TableCell className="text-xs"><Badge variant="outline">{r.status}</Badge></TableCell>
                        <TableCell className="text-xs text-right tabular-nums">{formatUGX(r.obligation)}</TableCell>
                        <TableCell className="text-xs text-right tabular-nums">{formatUGX(r.verified_collected)}</TableCell>
                        <TableCell className="text-xs text-right tabular-nums">
                          <div className="font-semibold">{formatUGX(r.calc_outstanding)}</div>
                          {Math.abs(r.calc_outstanding - r.stored_outstanding) >= 1000 && (
                            <div className="text-[10px] text-destructive">recorded {formatUGX(r.stored_outstanding)}</div>
                          )}
                        </TableCell>
                        <TableCell className="hidden lg:table-cell"><Progress value={Number(r.progress_pct ?? 0)} aria-label="Repaid" /></TableCell>
                        <TableCell className="hidden md:table-cell text-xs text-right tabular-nums">
                          {isBehind(r) ? <span className="text-amber-700 dark:text-amber-400">{formatUGX(Number(r.arrears))}{r.days_behind ? ` · ${r.days_behind}d` : ''}</span> : '—'}
                        </TableCell>
                        <TableCell className="text-xs">
                          <div className="flex flex-wrap gap-1">
                            {r.exceptions.slice(0, 2).map((e) => (
                              <Badge key={e} variant={EXCEPTIONS[e as ExceptionCode]?.severity === 'high' ? 'destructive' : 'secondary'} className="text-[10px]">{exceptionLabel(e)}</Badge>
                            ))}
                            {r.exceptions.length > 2 && <Badge variant="outline" className="text-[10px]">+{r.exceptions.length - 2}</Badge>}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                    {shown.length === 0 && (
                      <TableRow><TableCell colSpan={9} className="py-8 text-center text-sm text-muted-foreground">No plans match these filters.</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>

              {pages > 1 && (
                <div className="flex items-center justify-end gap-2 text-xs">
                  <Button size="sm" variant="outline" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} aria-label="Previous page"><ChevronLeft className="h-3.5 w-3.5" /></Button>
                  <span>Page {page + 1} of {pages}</span>
                  <Button size="sm" variant="outline" onClick={() => setPage((p) => Math.min(pages - 1, p + 1))} disabled={page >= pages - 1} aria-label="Next page"><ChevronRight className="h-3.5 w-3.5" /></Button>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <TenantRepaymentDetailSheet row={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
