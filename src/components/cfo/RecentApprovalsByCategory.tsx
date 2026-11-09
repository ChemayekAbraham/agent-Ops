import { withUuidIds } from '@/lib/isUuid';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Loader2,
  ClipboardCheck,
  Inbox,
  ChevronLeft,
  ChevronRight,
  Search,
  RefreshCw,
  Banknote,
  ArrowDownLeft,
  ArrowUpRight,
  TrendingUp,
  Filter,
  Eye,
  MoreHorizontal,
  Wallet,
  ShieldCheck,
  CheckCircle2,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { PAYOUT_CATEGORIES } from './DirectCreditTool';

const RECENT_WINDOW = 300;
const PAGE_SIZE = 15;

interface ApprovalRow {
  id: string;
  operation: string;
  amount: number;
  evidence: string | null;
  reference_id: string | null;
  created_at: string;
  created_by: string | null;
  target_user_id: string;
  metadata: Record<string, any> | null;
  beneficiary: { full_name: string | null; phone: string | null } | null;
  approver: string | null;
}

/** Strip the leading emoji/decoration so a stored label can be compared to a dropdown label. */
function normaliseLabel(value: string): string {
  return value
    .replace(/[^\p{L}\p{N}\s&]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const PERIODS = [
  { id: 'all', label: 'All time', days: null as number | null },
  { id: 'today', label: 'Today', days: 0 },
  { id: '7', label: 'Last 7 days', days: 7 },
  { id: '30', label: 'Last 30 days', days: 30 },
  { id: '90', label: 'Last 90 days', days: 90 },
];

export function RecentApprovalsByCategory({ showCardWrapper = true }: { showCardWrapper?: boolean }) {
  // Categories are read straight from the page's existing payout dropdown list.
  const categories = PAYOUT_CATEGORIES;
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [periodId, setPeriodId] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [openRow, setOpenRow] = useState<ApprovalRow | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['cfo-recent-approvals-by-category'],
    refetchOnWindowFocus: false,
    staleTime: 30_000,
    queryFn: async (): Promise<ApprovalRow[]> => {
      // Approvals live in TWO authoritative places:
      //  1. platform_wallet_corrections — CFO Direct Credit tool
      //  2. pending_wallet_operations   — the approval queues (ROI Payout,
      //     rent disbursement, commissions …), approved via
      //     approve-wallet-operation. These carry `category`, `status`,
      //     `reviewed_by` and `reviewed_at` (the approval timestamp).
      const [correctionsRes, opsRes] = await Promise.all([
        supabase
          .from('platform_wallet_corrections')
          .select('id, operation, amount, evidence, reference_id, created_at, created_by, target_user_id, metadata')
          .eq('tool', 'cfo_direct_credit')
          .order('created_at', { ascending: false })
          .limit(RECENT_WINDOW),
        supabase
          .from('pending_wallet_operations')
          .select('id, category, amount, direction, description, reference_id, user_id, target_wallet_user_id, reviewed_by, reviewed_at, metadata, status')
          .eq('status', 'approved')
          .not('reviewed_at', 'is', null)
          .order('reviewed_at', { ascending: false })
          .limit(RECENT_WINDOW),
      ]);
      if (correctionsRes.error) throw correctionsRes.error;
      if (opsRes.error) throw opsRes.error;

      const corrections = (correctionsRes.data ?? []) as unknown as ApprovalRow[];
      const opRows: ApprovalRow[] = (opsRes.data ?? []).map((o: any) => ({
        id: o.id,
        operation: o.direction === 'cash_out' ? 'debit' : 'credit',
        amount: Number(o.amount ?? 0),
        evidence: o.description ?? null,
        reference_id: o.reference_id ?? null,
        // The approval timestamp is the authoritative "when" for these rows.
        created_at: o.reviewed_at,
        created_by: o.reviewed_by ?? null,
        target_user_id: o.target_wallet_user_id || o.user_id,
        metadata: { ...(o.metadata ?? {}), category_id: o.category },
        beneficiary: null,
        approver: null,
      }));

      const list = [...corrections, ...opRows]
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, RECENT_WINDOW * 2);
      const ids = Array.from(
        new Set(
          list
            .flatMap((r) => [r.target_user_id, r.created_by])
            .filter((v): v is string => Boolean(v)),
        ),
      );
      let people: Record<string, { full_name: string | null; phone: string | null }> = {};
      if (ids.length) {
        const { data: profiles } = await withUuidIds(ids, (validIds) => supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', validIds));
        people = Object.fromEntries(
          (profiles ?? []).map((p: any) => [p.id, { full_name: p.full_name, phone: p.phone }]),
        );
      }

      return list.map((r) => ({
        ...r,
        beneficiary: people[r.target_user_id] ?? null,
        approver: r.created_by ? people[r.created_by]?.full_name ?? null : null,
      }));
    },
  });

  /** Resolve each row to one of the existing dropdown categories. */
  const rowsWithCategory = useMemo(() => {
    const byLabel = new Map(categories.map((c) => [normaliseLabel(c.label), c.id]));
    const byId = new Map(categories.map((c) => [c.id, c.id]));
    const byWalletCategory = new Map(categories.map((c) => [c.walletCategory, c.id]));

    return (data ?? []).map((row) => {
      const meta = row.metadata ?? {};
      const label = typeof meta.category_label === 'string' ? meta.category_label : '';
      const base = label.split('—')[0].split('/')[0];
      const storedId =
        typeof meta.category_id === 'string' ? meta.category_id.trim().toLowerCase() : '';
      let categoryId =
        (storedId ? byId.get(storedId) ?? byWalletCategory.get(storedId) : null) ??
        byLabel.get(normaliseLabel(label)) ??
        byLabel.get(normaliseLabel(base)) ??
        null;

      if (!categoryId) {
        const match = categories.find(
          (c) =>
            c.platformCategory === meta.platform_category &&
            c.walletCategory === meta.wallet_category &&
            c.allowedOps.includes(row.operation as any),
        );
        categoryId = match?.id ?? null;
      }
      const category = categories.find((c) => c.id === categoryId) ?? null;
      return { row, categoryId, categoryLabel: category?.label ?? 'Uncategorised' };
    });
  }, [data, categories]);

  const filtered = useMemo(() => {
    const period = PERIODS.find((p) => p.id === periodId) ?? PERIODS[0];
    let cutoff: number | null = null;
    if (period.days === 0) {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      cutoff = start.getTime();
    } else if (typeof period.days === 'number') {
      cutoff = Date.now() - period.days * 24 * 60 * 60 * 1000;
    }

    const q = search.trim().toLowerCase();

    return rowsWithCategory.filter((r) => {
      if (categoryFilter !== 'all' && r.categoryId !== categoryFilter) return false;
      if (cutoff !== null) {
        const t = new Date(r.row.created_at).getTime();
        if (!Number.isFinite(t) || t < cutoff) return false;
      }
      if (q) {
        const hay = `${r.row.reference_id ?? ''} ${r.row.beneficiary?.full_name ?? ''} ${r.row.beneficiary?.phone ?? ''} ${r.row.evidence ?? ''} ${r.categoryLabel ?? ''} ${r.row.approver ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rowsWithCategory, categoryFilter, periodId, search]);

  const totalCreditAmount = useMemo(
    () => filtered.reduce((s, r) => s + (r.row.operation === 'credit' ? Number(r.row.amount) : 0), 0),
    [filtered],
  );
  const totalDebitAmount = useMemo(
    () => filtered.reduce((s, r) => s + (r.row.operation === 'debit' ? Number(r.row.amount) : 0), 0),
    [filtered],
  );
  const netAmount = totalCreditAmount - totalDebitAmount;

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const pageRows = filtered.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE);

  const getPageNumbers = () => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i);
    if (currentPage <= 3) return [0, 1, 2, 3, 4, '...', totalPages - 1];
    if (currentPage >= totalPages - 4) return [0, '...', totalPages - 5, totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1];
    return [0, '...', currentPage - 1, currentPage, currentPage + 1, '...', totalPages - 1];
  };

  const handleResetFilters = () => {
    setCategoryFilter('all');
    setPeriodId('all');
    setSearch('');
    setPage(0);
  };

  const content = (
    <div className="space-y-4">
      {/* 4 KPI Metrics Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3.5">
        <div className="relative overflow-hidden flex flex-col justify-between rounded-2xl border border-border/70 bg-gradient-to-br from-card via-card to-card/60 p-4 shadow-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400 ring-1 ring-blue-500/20 shadow-xs">
              <ClipboardCheck className="h-5 w-5" />
            </span>
            <Badge variant="outline" className="text-[10px] font-semibold px-2 py-0.5 rounded-full border-border/60">
              Activity
            </Badge>
          </div>
          <div className="mt-3 min-w-0">
            <p className="text-xs font-medium text-muted-foreground truncate">Total Payouts Logged</p>
            <p className="text-xl sm:text-2xl font-bold tracking-tight text-foreground truncate mt-0.5">{filtered.length}</p>
            <p className="text-[11px] text-muted-foreground truncate mt-1">In current filter view</p>
          </div>
        </div>

        <div className="relative overflow-hidden flex flex-col justify-between rounded-2xl border border-border/70 bg-gradient-to-br from-card via-card to-card/60 p-4 shadow-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 ring-1 ring-emerald-500/20 shadow-xs">
              <ArrowUpRight className="h-5 w-5" />
            </span>
            <Badge variant="outline" className="text-[10px] font-semibold px-2 py-0.5 rounded-full border-border/60">
              Disbursed
            </Badge>
          </div>
          <div className="mt-3 min-w-0">
            <p className="text-xs font-medium text-muted-foreground truncate">Credits (Money Sent)</p>
            <p className="text-xl sm:text-2xl font-bold tracking-tight text-emerald-600 dark:text-emerald-400 truncate mt-0.5">
              {formatUGX(totalCreditAmount)}
            </p>
            <p className="text-[11px] text-muted-foreground truncate mt-1">Platform to wallets</p>
          </div>
        </div>

        <div className="relative overflow-hidden flex flex-col justify-between rounded-2xl border border-border/70 bg-gradient-to-br from-card via-card to-card/60 p-4 shadow-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400 ring-1 ring-amber-500/20 shadow-xs">
              <ArrowDownLeft className="h-5 w-5" />
            </span>
            <Badge variant="outline" className="text-[10px] font-semibold px-2 py-0.5 rounded-full border-border/60">
              Adjustments
            </Badge>
          </div>
          <div className="mt-3 min-w-0">
            <p className="text-xs font-medium text-muted-foreground truncate">Debits / Corrections</p>
            <p className="text-xl sm:text-2xl font-bold tracking-tight text-amber-600 dark:text-amber-400 truncate mt-0.5">
              {formatUGX(totalDebitAmount)}
            </p>
            <p className="text-[11px] text-muted-foreground truncate mt-1">Reversals &amp; retractions</p>
          </div>
        </div>

        <div className="relative overflow-hidden flex flex-col justify-between rounded-2xl border border-border/70 bg-gradient-to-br from-card via-card to-card/60 p-4 shadow-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/25 shadow-xs">
              <Banknote className="h-5 w-5" />
            </span>
            <Badge variant="outline" className="text-[10px] font-semibold px-2 py-0.5 rounded-full border-border/60">
              Net Volume
            </Badge>
          </div>
          <div className="mt-3 min-w-0">
            <p className="text-xs font-medium text-muted-foreground truncate">Net Money Out</p>
            <p className="text-xl sm:text-2xl font-bold tracking-tight text-foreground truncate mt-0.5">
              {formatUGX(netAmount)}
            </p>
            <p className="text-[11px] text-muted-foreground truncate mt-1">Credits minus debits</p>
          </div>
        </div>
      </div>

      {/* Filter Toolbar */}
      <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-muted/20 p-4">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2.5 flex-1">
            {/* Search Input */}
            <div className="relative flex-1 sm:max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(0);
                }}
                placeholder="Search recipient, ref, approver…"
                className="h-10 rounded-xl text-xs pl-9 pr-8 bg-background border-border/70 shadow-xs"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => { setSearch(''); setPage(0); }}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-xs"
                >
                  ✕
                </button>
              )}
            </div>

            {/* Category Select */}
            <Select
              value={categoryFilter}
              onValueChange={(v) => {
                setCategoryFilter(v);
                setPage(0);
              }}
            >
              <SelectTrigger className="h-10 w-full sm:w-[240px] text-xs rounded-xl bg-background border-border/70 shadow-xs">
                <SelectValue placeholder="All Categories" />
              </SelectTrigger>
              <SelectContent className="max-h-[320px]">
                <SelectItem value="all">All Categories</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Period Select */}
            <Select
              value={periodId}
              onValueChange={(v) => {
                setPeriodId(v);
                setPage(0);
              }}
            >
              <SelectTrigger className="h-10 w-full sm:w-[160px] text-xs rounded-xl bg-background border-border/70 shadow-xs">
                <SelectValue placeholder="All time" />
              </SelectTrigger>
              <SelectContent>
                {PERIODS.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-2 self-end sm:self-center">
            {(categoryFilter !== 'all' || periodId !== 'all' || search) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleResetFilters}
                className="h-9 rounded-xl text-xs gap-1.5 text-muted-foreground hover:text-foreground"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Reset
              </Button>
            )}
            <Badge variant="outline" className="text-xs px-2.5 py-1 rounded-full border-border/70 bg-card shadow-xs">
              {filtered.length} record{filtered.length === 1 ? '' : 's'}
            </Badge>
          </div>
        </div>

        {(categoryFilter !== 'all' || periodId !== 'all' || search) && (
          <div className="flex items-center gap-2 pt-1 flex-wrap text-xs">
            <span className="text-muted-foreground font-medium">Active filters:</span>
            {search && (
              <Badge variant="secondary" className="gap-1 rounded-md text-[11px] font-normal">
                Search: "{search}"
              </Badge>
            )}
            {categoryFilter !== 'all' && (
              <Badge variant="secondary" className="gap-1 rounded-md text-[11px] font-normal">
                Category: {categories.find((c) => c.id === categoryFilter)?.label || categoryFilter}
              </Badge>
            )}
            {periodId !== 'all' && (
              <Badge variant="secondary" className="gap-1 rounded-md text-[11px] font-normal">
                Period: {PERIODS.find((p) => p.id === periodId)?.label}
              </Badge>
            )}
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm font-medium text-muted-foreground">Loading general payout activity…</p>
        </div>
      ) : error ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center">
          <p className="text-sm font-semibold text-destructive">Could not load payout activity.</p>
          <Button variant="outline" size="sm" className="mt-3 text-xs" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border/70 bg-muted/10 px-4 py-12 text-center">
          <Inbox className="h-10 w-10 text-muted-foreground opacity-60" />
          <div>
            <p className="text-base font-semibold text-foreground">No payout activity found</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-sm">
              No recorded platform payouts match your selected category, period, or search query.
            </p>
          </div>
          {(categoryFilter !== 'all' || periodId !== 'all' || search) && (
            <Button variant="outline" size="sm" className="rounded-xl text-xs gap-1.5" onClick={handleResetFilters}>
              <RefreshCw className="h-3.5 w-3.5" />
              Reset filters
            </Button>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-border/70 bg-card overflow-hidden shadow-xs">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-b border-border/60 bg-muted/40 text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
                  <TableHead className="text-xs whitespace-nowrap py-3.5 px-4">Date / Time</TableHead>
                  <TableHead className="text-xs whitespace-nowrap py-3.5 px-3">Reference</TableHead>
                  <TableHead className="text-xs whitespace-nowrap py-3.5 px-3">Category</TableHead>
                  <TableHead className="text-xs whitespace-nowrap py-3.5 px-3">Recipient / Description</TableHead>
                  <TableHead className="text-xs whitespace-nowrap py-3.5 px-4 text-right">Amount (UGX)</TableHead>
                  <TableHead className="text-xs whitespace-nowrap py-3.5 px-3 text-center">Type</TableHead>
                  <TableHead className="text-xs whitespace-nowrap py-3.5 px-3">Approver</TableHead>
                  <TableHead className="text-xs whitespace-nowrap py-3.5 px-3 text-center">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="divide-y divide-border/50">
                {pageRows.map(({ row, categoryLabel }) => {
                  const isDebit = row.operation === 'debit';
                  return (
                    <TableRow
                      key={row.id}
                      className="cursor-pointer hover:bg-muted/40 transition-colors"
                      onClick={() => setOpenRow(row)}
                    >
                      <TableCell className="text-xs whitespace-nowrap py-3 px-4 font-mono text-muted-foreground">
                        {format(new Date(row.created_at), 'dd MMM yyyy, HH:mm')}
                      </TableCell>
                      <TableCell className="text-xs font-semibold py-3 px-3 max-w-[160px] truncate text-foreground">
                        {row.reference_id || '—'}
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap py-3 px-3">
                        <Badge variant="outline" className="text-[10px] font-medium rounded-md px-2 py-0.5 border-border/70 bg-muted/40">
                          {categoryLabel}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs max-w-[220px] py-3 px-3">
                        <p className="font-semibold text-foreground truncate">
                          {row.beneficiary?.full_name || 'Direct Transfer'}
                        </p>
                        {row.evidence ? (
                          <p className="text-[11px] text-muted-foreground truncate">{row.evidence}</p>
                        ) : null}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'text-xs font-bold text-right whitespace-nowrap py-3 px-4',
                          isDebit ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-400',
                        )}
                      >
                        {isDebit ? '−' : '+'}
                        {formatUGX(Number(row.amount))}
                      </TableCell>
                      <TableCell className="text-center py-3 px-3">
                        <Badge
                          variant="outline"
                          className={cn(
                            'text-[10px] px-2 py-0.5 rounded-full font-medium',
                            isDebit
                              ? 'bg-destructive/10 text-destructive border-destructive/20'
                              : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
                          )}
                        >
                          {isDebit ? 'Debit' : 'Credit'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs max-w-[140px] truncate py-3 px-3 text-muted-foreground">
                        {row.approver || 'CFO Execution'}
                      </TableCell>
                      <TableCell className="text-center py-3 px-3" onClick={(e) => e.stopPropagation()}>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 rounded-lg hover:bg-muted"
                          onClick={() => setOpenRow(row)}
                          title="View approval details"
                        >
                          <Eye className="h-4 w-4 text-muted-foreground" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {/* Pagination Footer */}
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-5 py-3.5 border-t border-border/60 bg-muted/20 text-xs text-muted-foreground">
            <div>
              {filtered.length === 0
                ? 'Showing 0 records'
                : `Showing ${currentPage * PAGE_SIZE + 1}–${Math.min((currentPage + 1) * PAGE_SIZE, filtered.length)} of ${filtered.length} records (Page ${currentPage + 1} of ${totalPages})`}
            </div>
            {totalPages > 1 && (
              <div className="flex items-center gap-1.5">
                <Button
                  size="icon"
                  variant="outline"
                  className="h-8 w-8 rounded-lg border-border/70 shadow-xs"
                  disabled={currentPage === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  aria-label="Previous page"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                {getPageNumbers().map((n, idx) =>
                  typeof n === 'number' ? (
                    <Button
                      key={n}
                      size="icon"
                      variant={n === currentPage ? 'default' : 'outline'}
                      className={cn(
                        'h-8 w-8 rounded-lg font-medium text-xs',
                        n === currentPage ? 'shadow-xs' : 'border-border/70 shadow-xs',
                      )}
                      onClick={() => setPage(n)}
                    >
                      {n + 1}
                    </Button>
                  ) : (
                    <span key={`ellipsis-${idx}`} className="px-1 text-muted-foreground select-none">
                      …
                    </span>
                  ),
                )}
                <Button
                  size="icon"
                  variant="outline"
                  className="h-8 w-8 rounded-lg border-border/70 shadow-xs"
                  disabled={currentPage >= totalPages - 1}
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  aria-label="Next page"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Details Dialog */}
      <Dialog open={!!openRow} onOpenChange={(o) => !o && setOpenRow(null)}>
        <DialogContent className="max-w-md rounded-2xl p-6">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <ClipboardCheck className="h-4 w-4" />
              </span>
              <div>
                <DialogTitle className="text-base font-bold">Payout Approval Details</DialogTitle>
                <DialogDescription className="text-xs">
                  {openRow?.reference_id ? `Reference: ${openRow.reference_id}` : 'Recorded platform wallet movement'}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          {openRow && (
            <div className="mt-3 space-y-3">
              <div className="rounded-xl border border-border/70 divide-y divide-border/60 text-xs">
                {[
                  ['Category', openRow.metadata?.category_label || openRow.evidence || '—'],
                  ['Subcategory', openRow.metadata?.sub_category || '—'],
                  [
                    'Recipient',
                    `${openRow.beneficiary?.full_name || 'Direct Transfer'}${
                      openRow.beneficiary?.phone ? ` (${openRow.beneficiary.phone})` : ''
                    }`,
                  ],
                  [
                    'Amount',
                    `${openRow.operation === 'debit' ? '−' : '+'}${formatUGX(Number(openRow.amount))}`,
                  ],
                  [
                    'Destination',
                    openRow.metadata?.recipient_type === 'operational_wallet'
                      ? 'Operational float'
                      : 'User wallet',
                  ],
                  ['Approved by', openRow.approver || 'CFO Execution'],
                  ['Approved at', format(new Date(openRow.created_at), 'dd MMM yyyy, HH:mm')],
                  ['Status', openRow.operation === 'debit' ? 'Debit (Taken out)' : 'Credit (Approved)'],
                  ['Reason / Note', openRow.evidence || '—'],
                ].map(([label, value]) => (
                  <div key={String(label)} className="flex items-start justify-between gap-3 px-3 py-2.5">
                    <span className="text-muted-foreground shrink-0">{label}</span>
                    <span className="font-semibold text-right break-all text-foreground">{String(value)}</span>
                  </div>
                ))}
              </div>

              <Button
                variant="outline"
                className="w-full h-10 rounded-xl text-xs font-semibold"
                onClick={() => setOpenRow(null)}
              >
                Close
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );

  if (!showCardWrapper) {
    return content;
  }

  return (
    <Card className="rounded-2xl border-border/70 shadow-sm bg-card overflow-hidden">
      <CardHeader className="p-6 pb-4 border-b border-border/60 bg-muted/10">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/25 shadow-xs">
              <ClipboardCheck className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-lg font-bold">General Payout Activity</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                All recorded payout disbursements and wallet operations across categories.
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-9 rounded-xl gap-2 border-border/70 shadow-xs hover:bg-muted self-start sm:self-center"
            onClick={() => {
              refetch();
              toast.success('Payout activity refreshed');
            }}
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-6">
        {content}
      </CardContent>
    </Card>
  );
}
