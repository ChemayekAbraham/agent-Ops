import { useMemo, useState, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  AlertTriangle,
  ArrowUpDown,
  Banknote,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  Eye,
  Filter,
  Loader2,
  RefreshCw,
  Search,
  Users,
  Wallet,
} from 'lucide-react';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { downloadCsv } from '@/lib/csvExport';
import {
  DEFAULT_FILTERS,
  EXCEPTIONS,
  computeKpis,
  csvFileName,
  csvTable,
  exceptionLabel,
  filterRows,
  isBehind,
  sortRows,
  type ExceptionCode,
  type RepaymentPlanRow,
  type SortKey,
  type TrackerFilters,
} from '@/lib/tenantRepaymentTracker';
import { useTenantRepaymentRegister } from '@/hooks/useTenantRepaymentTracker';
import { TenantRepaymentDetailSheet } from './TenantRepaymentDetailSheet';
import { cn } from '@/lib/utils';

const PAGE = 50;

/**
 * CFO Tenant Repayment Tracker. Read-only: balances are calculated from what was collected (Money In from 1 Oct 2026, receipts
 * before that), never from the stored status, and a manual balance reduction is never a repayment.
 */
export default function TenantRepaymentTracker() {
  const { data, isFetching, error, refetch } = useTenantRepaymentRegister();
  const [filters, setFilters] = useState<TrackerFilters>(DEFAULT_FILTERS);
  const [sort, setSort] = useState<SortKey>('calc_outstanding');
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(() => new URL(window.location.href).searchParams.get('repayment_plan'));
  useEffect(() => {
    const sync = () => setSelectedId(new URL(window.location.href).searchParams.get('repayment_plan'));
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);
  const openPlan = (id: string | null) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('repayment_plan', id); else url.searchParams.delete('repayment_plan');
    window.history.replaceState(window.history.state, '', url);
    setSelectedId(id);
  };

  const rows = data?.rows ?? [];
  const selected = rows.find((r) => r.rent_request_id === selectedId) ?? null;
  const kpis = useMemo(() => computeKpis(rows), [rows]);
  const filtered = useMemo(() => sortRows(filterRows(rows, filters), sort), [rows, filters, sort]);
  const exceptionCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) for (const e of r.exceptions) m.set(e, (m.get(e) ?? 0) + 1);
    return m;
  }, [rows]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const shown = filtered.slice(page * PAGE, page * PAGE + PAGE);
  const set = (patch: Partial<TrackerFilters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(0);
  };

  const handleResetFilters = () => {
    setFilters(DEFAULT_FILTERS);
    setSort('calc_outstanding');
    setPage(0);
  };

  const hasActiveFilters =
    filters.search !== '' ||
    filters.status !== 'all' ||
    filters.schedule !== 'all' ||
    filters.exception !== 'all' ||
    sort !== 'calc_outstanding';

  const exportCsv = () => {
    const t = csvTable(filtered);
    downloadCsv(csvFileName(data?.asAt), t.headers, t.rows);
  };

  return (
    <div className="space-y-6">
      {/* Executive Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[#EBF3FF] text-[#2563EB] dark:bg-blue-950/40 dark:text-blue-400 shadow-xs">
            <Wallet className="h-6 w-6" />
          </div>
          <div>
            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-foreground">
                Tenant Repayment Tracker
              </h1>
              <Badge
                variant="outline"
                className="text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-primary/10 text-primary border-primary/20"
              >
                CFO Audit Register
              </Badge>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            className="h-10 rounded-xl px-4 gap-2 border-slate-200 dark:border-border/70 text-slate-700 dark:text-foreground bg-white dark:bg-card hover:bg-slate-50 shadow-xs font-medium text-sm"
          >
            {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4 text-slate-500" />}
            Refresh
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={exportCsv}
            disabled={!filtered.length}
            className="h-10 rounded-xl px-4 gap-2 bg-[#0B3A82] text-white hover:bg-[#0B3A82]/90 shadow-xs font-semibold text-sm"
          >
            <Download className="h-4 w-4" />
            Export CSV ({filtered.length})
          </Button>
        </div>
      </div>

      {data && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Clock className="h-3.5 w-3.5 text-slate-400" />
          <span>As at {data.asAt.toLocaleString('en-GB', { timeZone: 'Africa/Kampala' })} (Kampala time).</span>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-2xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive flex items-center gap-3"
        >
          <AlertTriangle className="h-5 w-5 shrink-0" />
          <div>
            <p className="font-semibold">Could not load the tracker</p>
            <p className="text-xs mt-0.5 opacity-90">{(error as Error).message}</p>
          </div>
        </div>
      )}
      {data && selectedId && !selected && <p role="alert" className="text-sm text-destructive">The linked Rent Plan is not in the authorized register.</p>}

      {!data && !error && (
        <div className="py-16 text-center rounded-2xl border border-slate-200/80 dark:border-border/70 bg-card p-8 flex flex-col items-center justify-center gap-3 shadow-xs">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm font-medium text-muted-foreground">
            Calculating every Rent Plan from its receipts (can take a few seconds)...
          </p>
        </div>
      )}

      {data && (
        <>
          {/* 4 Colored KPI Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
            {/* Card 1: Active Plans */}
            <div className="rounded-2xl border border-blue-100 bg-[#F0F6FF] dark:bg-blue-950/20 dark:border-blue-900/40 p-5 flex flex-col justify-between shadow-xs">
              <div className="flex items-center justify-between">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#DBEAFE] text-[#2563EB] dark:bg-blue-900/50 dark:text-blue-400">
                  <Wallet className="h-4 w-4" />
                </div>
                <Badge variant="outline" className="text-[10px] font-semibold px-2 py-0.5 rounded-full border-blue-200 bg-white/70 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                  Active
                </Badge>
              </div>
              <div className="mt-4">
                <p className="text-3xl font-extrabold tracking-tight text-slate-900 dark:text-foreground">
                  {kpis.activePlans.toLocaleString()}
                </p>
                <p className="text-sm font-medium text-slate-500 dark:text-muted-foreground mt-1">Active plans</p>
              </div>
            </div>

            {/* Card 2: Total Outstanding */}
            <div className="rounded-2xl border border-emerald-100 bg-[#F0FDF4] dark:bg-emerald-950/20 dark:border-emerald-900/40 p-5 flex flex-col justify-between shadow-xs">
              <div className="flex items-center justify-between">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#DCFCE7] text-[#16A34A] dark:bg-emerald-900/50 dark:text-emerald-400">
                  <Banknote className="h-4 w-4" />
                </div>
                <Badge variant="outline" className="text-[10px] font-semibold px-2 py-0.5 rounded-full border-emerald-200 bg-white/70 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                  Receivable
                </Badge>
              </div>
              <div className="mt-4 min-w-0">
                <p className="text-2xl sm:text-3xl font-extrabold tracking-tight text-slate-900 dark:text-foreground truncate">
                  {formatUGX(kpis.totalOutstanding)}
                </p>
                <p className="text-sm font-medium text-slate-500 dark:text-muted-foreground mt-1">Total outstanding</p>
                <span className="sr-only">Recorded balances say {formatUGX(kpis.storedOutstanding)}</span>
              </div>
            </div>

            {/* Card 3: Overdue Plans */}
            <div className="rounded-2xl border border-orange-100 bg-[#FFF7ED] dark:bg-orange-950/20 dark:border-orange-900/40 p-5 flex flex-col justify-between shadow-xs">
              <div className="flex items-center justify-between">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#FFEDD5] text-[#EA580C] dark:bg-orange-900/50 dark:text-orange-400">
                  <Clock className="h-4 w-4" />
                </div>
                <Badge variant="outline" className="text-[10px] font-semibold px-2 py-0.5 rounded-full border-orange-200 bg-white/70 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300">
                  Arrears
                </Badge>
              </div>
              <div className="mt-4 min-w-0">
                <p className="text-2xl sm:text-3xl font-extrabold tracking-tight text-slate-900 dark:text-foreground truncate">
                  {kpis.overduePlans.toLocaleString()}
                </p>
                <p className="text-sm font-medium text-slate-500 dark:text-muted-foreground mt-1">Overdue plans</p>
              </div>
            </div>

            {/* Card 4: Completed Plans */}
            <div className="rounded-2xl border border-purple-100 bg-[#FAF5FF] dark:bg-purple-950/20 dark:border-purple-900/40 p-5 flex flex-col justify-between shadow-xs">
              <div className="flex items-center justify-between">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#F3E8FF] text-[#9333EA] dark:bg-purple-900/50 dark:text-purple-400">
                  <CheckCircle2 className="h-4 w-4" />
                </div>
                <Badge variant="outline" className="text-[10px] font-semibold px-2 py-0.5 rounded-full border-purple-200 bg-white/70 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">
                  Finished
                </Badge>
              </div>
              <div className="mt-4 min-w-0">
                <p className="text-2xl sm:text-3xl font-extrabold tracking-tight text-slate-900 dark:text-foreground truncate">
                  {kpis.completedPlans.toLocaleString()}
                </p>
                <p className="text-sm font-medium text-slate-500 dark:text-muted-foreground mt-1">Completed plans</p>
                <span className="sr-only">
                  {kpis.completedWithBalance
                    ? `${kpis.completedWithBalance} still owe on collections`
                    : 'All fully collected'}
                </span>
              </div>
            </div>
          </div>

          {/* Exceptions Strip (If any) */}
          {exceptionCounts.size > 0 && (
            <Card className="rounded-2xl border border-amber-200/80 dark:border-amber-900/50 bg-amber-50/40 dark:bg-amber-950/10 p-5 shadow-xs space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="flex items-center gap-2.5 text-sm font-bold text-amber-900 dark:text-amber-200">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="h-4 w-4" />
                  </div>
                  Exceptions: {kpis.plansWithExceptions} plans
                </div>
                <p className="text-xs text-amber-800/80 dark:text-amber-300/80">
                  Where the plan's status, what was collected and the books disagree. Select one to filter.
                </p>
              </div>

              <div className="flex flex-wrap gap-2 pt-1">
                {(Object.keys(EXCEPTIONS) as ExceptionCode[])
                  .filter((c) => exceptionCounts.get(c))
                  .map((c) => {
                    const isSelected = filters.exception === c;
                    const isHigh = EXCEPTIONS[c]?.severity === 'high';
                    return (
                      <button
                        key={c}
                        type="button"
                        onClick={() => set({ exception: isSelected ? 'all' : c })}
                        title={EXCEPTIONS[c].meaning}
                        className={cn(
                          'rounded-xl border px-3 py-1.5 text-xs font-medium transition-all flex items-center gap-1.5 shadow-xs',
                          isSelected
                            ? 'border-primary bg-primary text-primary-foreground font-semibold shadow-sm'
                            : isHigh
                            ? 'border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/15'
                            : 'border-amber-300/70 dark:border-amber-800 bg-white dark:bg-card text-amber-800 dark:text-amber-300 hover:bg-amber-100/40'
                        )}
                      >
                        {EXCEPTIONS[c].label}
                        <span
                          className={cn(
                            'rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums',
                            isSelected
                              ? 'bg-white/20 text-white'
                              : isHigh
                              ? 'bg-destructive/15 text-destructive'
                              : 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300'
                          )}
                        >
                          {exceptionCounts.get(c)}
                        </span>
                      </button>
                    );
                  })}
              </div>
            </Card>
          )}

          {/* Unified Table Container Card (With Filters Inside) */}
          <Card className="rounded-2xl border border-slate-200/80 dark:border-border/70 bg-card p-5 sm:p-6 shadow-xs space-y-4">
            {/* Table Toolbar Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-blue-100 text-blue-600 dark:bg-blue-950/40 dark:text-blue-400">
                  <Users className="h-4 w-4" />
                </div>
                <h3 className="text-base sm:text-lg font-bold text-slate-900 dark:text-foreground">
                  Tenant Repayment Register
                </h3>
                <span className="rounded-full bg-blue-50 dark:bg-blue-950/40 px-3 py-1 text-xs font-semibold text-blue-600 dark:text-blue-400">
                  {filtered.length.toLocaleString()} of {rows.length.toLocaleString()} plans
                </span>
              </div>

              {hasActiveFilters && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleResetFilters}
                  className="h-8 text-xs text-primary hover:bg-primary/10 gap-1.5"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Reset all filters
                </Button>
              )}
            </div>

            {/* Filter Bar (Inside Table Card) */}
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 items-center pt-1 border-t border-slate-100 dark:border-border/50">
              {/* Search */}
              <div className="relative w-full lg:col-span-1">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <Input
                  value={filters.search}
                  onChange={(e) => set({ search: e.target.value })}
                  placeholder="Search tenant, phone, agent, landlord…"
                  className="h-10 rounded-xl text-sm pl-9 pr-8 bg-slate-50/70 dark:bg-muted/30 border-slate-200 dark:border-border/70 shadow-xs focus-visible:ring-primary/20"
                  aria-label="Search the register"
                />
                {filters.search && (
                  <button
                    type="button"
                    onClick={() => set({ search: '' })}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-xs"
                  >
                    ✕
                  </button>
                )}
              </div>

              {/* Status Filter */}
              <Select value={filters.status} onValueChange={(v) => set({ status: v as TrackerFilters['status'] })}>
                <SelectTrigger
                  className="h-10 rounded-xl text-sm w-full bg-slate-50/70 dark:bg-muted/30 border-slate-200 dark:border-border/70 shadow-xs"
                  aria-label="Status"
                >
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="other">Other (cancelled etc.)</SelectItem>
                </SelectContent>
              </Select>

              {/* Schedule Filter */}
              <Select value={filters.schedule} onValueChange={(v) => set({ schedule: v as TrackerFilters['schedule'] })}>
                <SelectTrigger
                  className="h-10 rounded-xl text-sm w-full bg-slate-50/70 dark:bg-muted/30 border-slate-200 dark:border-border/70 shadow-xs"
                  aria-label="Schedule"
                >
                  <SelectValue placeholder="Any schedule" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any schedule</SelectItem>
                  <SelectItem value="behind">Behind schedule</SelectItem>
                  <SelectItem value="on_track">On track</SelectItem>
                </SelectContent>
              </Select>

              {/* Exceptions Filter */}
              <Select value={filters.exception} onValueChange={(v) => set({ exception: v as TrackerFilters['exception'] })}>
                <SelectTrigger
                  className="h-10 rounded-xl text-sm w-full bg-slate-50/70 dark:bg-muted/30 border-slate-200 dark:border-border/70 shadow-xs"
                  aria-label="Exceptions"
                >
                  <SelectValue placeholder="All plans" />
                </SelectTrigger>
                <SelectContent className="max-h-[300px]">
                  <SelectItem value="all">All plans</SelectItem>
                  <SelectItem value="any">With any exception</SelectItem>
                  <SelectItem value="none">No exceptions</SelectItem>
                  {(Object.keys(EXCEPTIONS) as ExceptionCode[]).map((c) => (
                    <SelectItem key={c} value={c}>
                      {EXCEPTIONS[c].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Sort Key */}
              <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
                <SelectTrigger
                  className="h-10 rounded-xl text-sm w-full bg-slate-50/70 dark:bg-muted/30 border-slate-200 dark:border-border/70 shadow-xs"
                  aria-label="Sort"
                >
                  <ArrowUpDown className="h-4 w-4 mr-2 text-slate-400 shrink-0" />
                  <SelectValue placeholder="Sort register" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="calc_outstanding">Largest outstanding</SelectItem>
                  <SelectItem value="arrears">Largest arrears</SelectItem>
                  <SelectItem value="repaid_without_receipts">Repaid without collections</SelectItem>
                  <SelectItem value="obligation">Largest obligation</SelectItem>
                  <SelectItem value="funded_at">Most recently funded</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Data Table */}
            <div className="rounded-xl border border-slate-200/70 dark:border-border/60 overflow-hidden">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="border-b border-slate-200/70 dark:border-border/60 bg-slate-50/80 dark:bg-muted/30 text-xs font-bold text-slate-700 dark:text-slate-300">
                      <TableHead className="py-3.5 px-4">Tenant</TableHead>
                      <TableHead className="hidden md:table-cell py-3.5 px-3">Agent</TableHead>
                      <TableHead className="py-3.5 px-3">Status</TableHead>
                      <TableHead className="text-right py-3.5 px-3">Owed</TableHead>
                      <TableHead className="text-right py-3.5 px-3">Collected</TableHead>
                      <TableHead className="text-right py-3.5 px-4">Outstanding</TableHead>
                      <TableHead className="hidden lg:table-cell w-36 py-3.5 px-3">Progress</TableHead>
                      <TableHead className="hidden md:table-cell text-right py-3.5 px-3">Arrears</TableHead>
                      <TableHead className="py-3.5 px-3">Exceptions</TableHead>
                      <TableHead className="w-16 text-center py-3.5 px-3">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody className="divide-y divide-slate-100 dark:divide-border/40">
                    {shown.map((r) => {
                      const isCompleted = r.status === 'completed';
                      const isActive = r.status === 'repaying' || r.status === 'active';
                      return (
                        <TableRow
                          key={r.rent_request_id}
                          className="cursor-pointer hover:bg-slate-50/70 dark:hover:bg-muted/40 transition-colors"
                          onClick={() => openPlan(r.rent_request_id)}
                          data-testid="tracker-row"
                        >
                          <TableCell className="py-3.5 px-4 align-middle">
                            <div className="font-bold text-sm text-slate-900 dark:text-foreground">
                              {r.tenant_name ?? 'Unknown'}
                            </div>
                            <div className="text-xs text-muted-foreground mt-0.5">{r.tenant_phone ?? ''}</div>
                          </TableCell>
                          <TableCell className="hidden md:table-cell py-3.5 px-3 align-middle text-xs font-medium text-slate-600 dark:text-slate-400">
                            {r.agent_name ?? '—'}
                          </TableCell>
                          <TableCell className="py-3.5 px-3 align-middle whitespace-nowrap">
                            <span
                              className={cn(
                                'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize border',
                                isCompleted
                                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200/60 dark:bg-emerald-950/40 dark:text-emerald-300'
                                  : isActive
                                  ? 'bg-blue-50 text-blue-700 border-blue-200/60 dark:bg-blue-950/40 dark:text-blue-300'
                                  : 'bg-muted text-muted-foreground border-border'
                              )}
                            >
                              {r.status}
                            </span>
                          </TableCell>
                          <TableCell className="py-3.5 px-3 align-middle text-right text-xs font-medium text-slate-700 dark:text-slate-300 tabular-nums whitespace-nowrap">
                            {formatUGX(r.obligation)}
                          </TableCell>
                          <TableCell className="py-3.5 px-3 align-middle text-right text-xs font-semibold text-emerald-700 dark:text-emerald-400 tabular-nums whitespace-nowrap">
                            {formatUGX(r.verified_collected)}
                          </TableCell>
                          <TableCell className="py-3.5 px-4 align-middle text-right tabular-nums whitespace-nowrap">
                            <div className="text-xs font-bold text-slate-900 dark:text-foreground">
                              {formatUGX(r.calc_outstanding)}
                            </div>
                            {Math.abs(r.calc_outstanding - r.stored_outstanding) >= 1000 && (
                              <div className="text-[10px] font-semibold text-destructive mt-0.5">
                                recorded {formatUGX(r.stored_outstanding)}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="hidden lg:table-cell py-3.5 px-3 align-middle">
                            <div className="space-y-1">
                              <div className="flex justify-between text-[11px] font-medium text-muted-foreground">
                                <span>{Math.round(Number(r.progress_pct ?? 0))}%</span>
                              </div>
                              <Progress
                                value={Number(r.progress_pct ?? 0)}
                                className="h-2 rounded-full"
                                aria-label="Repaid"
                              />
                            </div>
                          </TableCell>
                          <TableCell className="hidden md:table-cell py-3.5 px-3 align-middle text-right text-xs tabular-nums whitespace-nowrap">
                            {isBehind(r) ? (
                              <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 dark:bg-amber-950/40 border border-amber-200/70 text-amber-800 dark:text-amber-300 px-2 py-0.5 text-xs font-bold">
                                {formatUGX(Number(r.arrears))}
                                {r.days_behind ? ` · ${r.days_behind}d` : ''}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="py-3.5 px-3 align-middle">
                            <div className="flex flex-wrap gap-1">
                              {r.exceptions.slice(0, 2).map((e) => (
                                <Badge
                                  key={e}
                                  variant={EXCEPTIONS[e as ExceptionCode]?.severity === 'high' ? 'destructive' : 'secondary'}
                                  className="text-[10px] font-normal"
                                >
                                  {exceptionLabel(e)}
                                </Badge>
                              ))}
                              {r.exceptions.length > 2 && (
                                <Badge variant="outline" className="text-[10px] font-normal">
                                  +{r.exceptions.length - 2}
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="py-3.5 px-3 align-middle text-center" onClick={(e) => e.stopPropagation()}>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8 rounded-full border border-slate-200 dark:border-border/70 bg-white dark:bg-card hover:bg-slate-50 text-slate-500 shadow-2xs"
                              onClick={() => openPlan(r.rent_request_id)}
                              aria-label={`View details for ${r.tenant_name}`}
                            >
                              <Eye className="h-4 w-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    {shown.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={10} className="py-12 text-center text-sm text-muted-foreground">
                          <div className="max-w-sm mx-auto flex flex-col items-center">
                            <CheckCircle2 className="h-10 w-10 text-emerald-500 mb-2 opacity-80" />
                            <p className="font-semibold text-foreground">No plans match these filters</p>
                            <p className="text-xs text-muted-foreground mt-1">
                              Try resetting your search query, status, or exception filters.
                            </p>
                            <Button
                              variant="outline"
                              size="sm"
                              className="mt-3.5 rounded-lg text-xs"
                              onClick={handleResetFilters}
                            >
                              Clear all filters
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination Controls */}
              <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-5 py-3.5 border-t border-slate-200/70 dark:border-border/60 bg-white dark:bg-card text-xs text-slate-500 dark:text-muted-foreground">
                <div>
                  {filtered.length === 0
                    ? 'Showing 0 plans'
                    : `Showing ${page * PAGE + 1}–${Math.min(page * PAGE + PAGE, filtered.length)} of ${filtered.length} plans (Page ${page + 1} of ${pages})`}
                </div>
                {pages > 1 && (
                  <div className="flex items-center gap-1.5">
                    <Button
                      size="icon"
                      variant="outline"
                      className="h-8 w-8 rounded-lg border-slate-200 dark:border-border/70 text-slate-500 shadow-xs"
                      onClick={() => setPage((p) => Math.max(0, p - 1))}
                      disabled={page === 0}
                      aria-label="Previous page"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <span className="px-2 font-medium">
                      Page {page + 1} of {pages}
                    </span>
                    <Button
                      size="icon"
                      variant="outline"
                      className="h-8 w-8 rounded-lg border-slate-200 dark:border-border/70 text-slate-500 shadow-xs"
                      onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
                      disabled={page >= pages - 1}
                      aria-label="Next page"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </Card>
        </>
      )}

      <TenantRepaymentDetailSheet row={selected} onClose={() => openPlan(null)} onOpenPlan={openPlan} />
    </div>
  );
}
