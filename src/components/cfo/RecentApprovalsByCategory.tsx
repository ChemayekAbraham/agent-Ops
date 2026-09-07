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
import { Loader2, ClipboardCheck, Inbox, ChevronLeft, ChevronRight } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
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

export function RecentApprovalsByCategory() {
  // Categories are read straight from the page's existing payout dropdown list.
  const categories = PAYOUT_CATEGORIES;
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [periodId, setPeriodId] = useState<string>('all');
  const [page, setPage] = useState(0);
  const [openRow, setOpenRow] = useState<ApprovalRow | null>(null);

  const { data, isLoading, error } = useQuery({
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
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', ids);
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

    return rowsWithCategory.filter((r) => {
      if (categoryFilter !== 'all' && r.categoryId !== categoryFilter) return false;
      if (cutoff !== null) {
        const t = new Date(r.row.created_at).getTime();
        if (!Number.isFinite(t) || t < cutoff) return false;
      }
      return true;
    });
  }, [rowsWithCategory, categoryFilter, periodId]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const pageRows = filtered.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <ClipboardCheck className="h-4 w-4 text-muted-foreground" />
          General Payout Activity
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          All recorded payout activity and approvals in one table. Filter by the same payout
          categories used in the dropdown above, then tap a row for full details.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <p className="text-sm text-destructive">Could not load payout activity.</p>
        ) : (
          <>
            {/* Filters */}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Select
                  value={categoryFilter}
                  onValueChange={(v) => {
                    setCategoryFilter(v);
                    setPage(0);
                  }}
                >
                  <SelectTrigger className="h-9 w-full sm:w-[260px] text-xs">
                    <SelectValue placeholder="All Categories" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Categories</SelectItem>
                    {categories.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select
                  value={periodId}
                  onValueChange={(v) => {
                    setPeriodId(v);
                    setPage(0);
                  }}
                >
                  <SelectTrigger className="h-9 w-full sm:w-[160px] text-xs">
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

              <Badge variant="secondary" className="w-fit text-xs">
                {filtered.length} record{filtered.length === 1 ? '' : 's'}
              </Badge>
            </div>

            {filtered.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-muted/20 px-4 py-8 text-center">
                <Inbox className="h-5 w-5 text-muted-foreground" />
                <p className="text-sm font-medium">No payout activity found</p>
                <p className="text-xs text-muted-foreground">
                  Try a different category or date range.
                </p>
              </div>
            ) : (
              <>
                <div className="overflow-x-auto rounded-xl border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-xs whitespace-nowrap">Date / Time</TableHead>
                        <TableHead className="text-xs whitespace-nowrap">Reference</TableHead>
                        <TableHead className="text-xs whitespace-nowrap">Payout Category</TableHead>
                        <TableHead className="text-xs whitespace-nowrap">
                          Description / Recipient
                        </TableHead>
                        <TableHead className="text-xs whitespace-nowrap text-right">Amount</TableHead>
                        <TableHead className="text-xs whitespace-nowrap">Status</TableHead>
                        <TableHead className="text-xs whitespace-nowrap">Approver</TableHead>
                        <TableHead className="text-xs whitespace-nowrap">Approved At</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pageRows.map(({ row, categoryLabel }) => {
                        const isDebit = row.operation === 'debit';
                        return (
                          <TableRow
                            key={row.id}
                            className="cursor-pointer"
                            onClick={() => setOpenRow(row)}
                          >
                            <TableCell className="text-xs whitespace-nowrap">
                              {format(new Date(row.created_at), 'dd MMM yyyy, HH:mm')}
                            </TableCell>
                            <TableCell className="text-xs font-medium max-w-[180px] truncate">
                              {row.reference_id || '—'}
                            </TableCell>
                            <TableCell className="text-xs whitespace-nowrap">
                              {categoryLabel}
                            </TableCell>
                            <TableCell className="text-xs max-w-[240px] truncate">
                              {row.beneficiary?.full_name || 'Unknown recipient'}
                              {row.evidence ? ` — ${row.evidence}` : ''}
                            </TableCell>
                            <TableCell
                              className={cn(
                                'text-xs font-semibold text-right whitespace-nowrap',
                                isDebit ? 'text-destructive' : 'text-emerald-600',
                              )}
                            >
                              {isDebit ? '−' : '+'}
                              {formatUGX(Number(row.amount))}
                            </TableCell>
                            <TableCell>
                              <Badge variant="secondary" className="text-[10px]">
                                {isDebit ? 'Taken out' : 'Approved'}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-xs max-w-[160px] truncate">
                              {row.approver || '—'}
                            </TableCell>
                            <TableCell className="text-xs whitespace-nowrap">
                              {format(new Date(row.created_at), 'dd MMM yyyy, HH:mm')}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>

                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    Page {currentPage + 1} of {totalPages}
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={currentPage === 0}
                      onClick={() => setPage((p) => Math.max(0, p - 1))}
                    >
                      <ChevronLeft className="h-4 w-4" />
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={currentPage >= totalPages - 1}
                      onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                    >
                      Next
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </CardContent>

      <Dialog open={!!openRow} onOpenChange={(o) => !o && setOpenRow(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">Approval details</DialogTitle>
            <DialogDescription className="text-xs">
              {openRow?.reference_id || 'Recorded wallet movement'}
            </DialogDescription>
          </DialogHeader>
          {openRow && (
            <dl className="space-y-2.5 text-sm">
              {[
                ['Category', openRow.metadata?.category_label || openRow.evidence || '—'],
                ['Subcategory', openRow.metadata?.sub_category || '—'],
                [
                  'Recipient',
                  `${openRow.beneficiary?.full_name || 'Unknown'}${
                    openRow.beneficiary?.phone ? ` (${openRow.beneficiary.phone})` : ''
                  }`,
                ],
                ['Amount', `${openRow.operation === 'debit' ? '−' : '+'}${formatUGX(Number(openRow.amount))}`],
                [
                  'Destination',
                  openRow.metadata?.recipient_type === 'operational_wallet'
                    ? 'Operational float'
                    : 'User wallet',
                ],
                ['Approved by', openRow.approver || '—'],
                ['Approved at', format(new Date(openRow.created_at), 'dd MMM yyyy, HH:mm')],
                ['Status', openRow.operation === 'debit' ? 'Taken out' : 'Approved'],
                ['Reason / note', openRow.evidence || '—'],
              ].map(([label, value]) => (
                <div key={String(label)} className="flex gap-3">
                  <dt className="w-32 shrink-0 text-xs text-muted-foreground">{label}</dt>
                  <dd className="min-w-0 flex-1 break-words font-medium">{String(value)}</dd>
                </div>
              ))}
            </dl>
          )}
          <Button variant="outline" size="sm" onClick={() => setOpenRow(null)}>
            Close
          </Button>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
