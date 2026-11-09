import { withUuidIds } from '@/lib/isUuid';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Loader2, Utensils, RefreshCw, Download, MoreHorizontal, Undo2,
  Search, X, Users, Calendar, Wallet, CheckCircle2, ChevronLeft, ChevronRight,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { formatUGX } from '@/lib/agentAdvanceCalculations';

interface Row {
  id: string;
  target_user_id: string;
  amount: number;
  operation: string;
  created_at: string;
  created_by: string | null;
  reference_id: string | null;
  evidence: string | null;
  metadata?: any;
}

/** Tracker of Lunch Allowance payments made through CFO Send Money. */
export function LunchAllowanceTracker() {
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const [reversing, setReversing] = useState<Row | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [viewTab, setViewTab] = useState<'all' | 'staff'>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['cfo-lunch-allowance'],
    staleTime: 60_000,
    queryFn: async () => {
      const { data: rows, error } = await supabase
        .from('platform_wallet_corrections')
        .select('id,target_user_id,amount,operation,created_at,created_by,reference_id,evidence,metadata')
        .ilike('metadata->>category_label', '%lunch allowance%')
        .order('created_at', { ascending: false })
        .limit(1000);
      if (error) throw error;
      // Automated lunch allowance payouts post straight to the ledger (no
      // platform_wallet_corrections row), so read their user wallet legs too.
      const { data: autoRows, error: autoErr } = await supabase
        .from('general_ledger')
        .select('id,user_id,amount,created_at')
        .eq('category', 'wallet_deposit')
        .ilike('description', '%automated%')
        .ilike('description', '%lunch allowance%')
        .order('created_at', { ascending: false })
        .limit(1000);
      if (autoErr) throw autoErr;
      const automated: Row[] = (autoRows ?? []).map((r: any) => ({
        id: r.id,
        target_user_id: r.user_id,
        amount: r.amount,
        operation: 'credit',
        created_at: r.created_at,
        created_by: null,
        reference_id: 'Automated',
        evidence: null,
      }));
      const list = [...((rows ?? []) as Row[]), ...automated].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      const ids = [...new Set(list.flatMap((r) => [r.target_user_id, r.created_by]).filter(Boolean))] as string[];
      const names: Record<string, string> = {};
      if (ids.length) {
        const { data: profs } = await withUuidIds(ids, (validIds) => supabase.from('profiles').select('id,full_name').in('id', validIds));
        (profs ?? []).forEach((p: any) => { names[p.id] = p.full_name || 'Unknown'; });
      }
      return { list, names };
    },
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.list ?? []).filter((r) => {
      const d = r.created_at.slice(0, 10);
      if (to && d > to) return false;
      if (q && !(data?.names[r.target_user_id] ?? '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data, to, search]);

  const reversedIds = useMemo(() => {
    const set = new Set<string>();
    (data?.list ?? []).forEach((r) => {
      const m = String(r.metadata?.sub_category ?? '').match(/^lunch_allowance_reversal:(.+)$/);
      if (r.operation === 'debit' && m) set.add(m[1]);
    });
    return set;
  }, [data]);

  const submitReversal = async () => {
    if (!reversing || reason.trim().length < 10) return;
    setBusy(true);
    try {
      const { data: res, error } = await supabase.functions.invoke('cfo-direct-credit', {
        body: {
          target_user_id: reversing.target_user_id,
          amount: Number(reversing.amount),
          reason: `Lunch allowance reversal — ${reason.trim()}`,
          operation: 'debit',
          wallet_category: 'wallet_transfer',
          platform_category: 'wallet_transfer',
          financial_impact: 'neutral',
          category_label: 'Lunch allowance reversal',
          recipient_type: 'user',
          sub_category: `lunch_allowance_reversal:${reversing.id}`,
        },
      });
      if (error) throw new Error((error as any)?.message || 'Reversal failed');
      if ((res as any)?.error) throw new Error((res as any).error);
      toast.success('Lunch allowance returned to the company');
      setReversing(null); setReason('');
      refetch();
    } catch (e: any) {
      toast.error(e?.message ?? 'Reversal failed');
    } finally { setBusy(false); }
  };

  const signed = (r: Row) => (r.operation === 'debit' ? -1 : 1) * Number(r.amount);
  const total = filtered.reduce((s, r) => s + signed(r), 0);
  const monthKey = new Date().toISOString().slice(0, 7);
  const thisMonth = (data?.list ?? []).filter((r) => r.created_at.startsWith(monthKey)).reduce((s, r) => s + signed(r), 0);

  const perStaff = useMemo(() => {
    const m = new Map<string, { total: number; count: number; last: string }>();
    filtered.forEach((r) => {
      const e = m.get(r.target_user_id) ?? { total: 0, count: 0, last: r.created_at };
      e.total += signed(r); e.count += 1; if (r.created_at > e.last) e.last = r.created_at;
      m.set(r.target_user_id, e);
    });
    return [...m.entries()].sort((a, b) => b[1].total - a[1].total);
  }, [filtered]);

  const fmtDate = (s: string) => new Date(s).toLocaleString('en-GB', { timeZone: 'Africa/Kampala', dateStyle: 'medium', timeStyle: 'short' });

  // Pagination for all payments
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const startIndex = (safePage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, filtered.length);
  const paginatedRows = useMemo(() => filtered.slice(startIndex, endIndex), [filtered, startIndex, endIndex]);

  const downloadPdf = () => {
    const doc = new jsPDF();
    const n = (id: string | null) => (id ? data?.names[id] ?? 'Unknown' : 'System');
    doc.setFontSize(14);
    doc.text('Welile - Lunch Allowance', 14, 16);
    doc.setFontSize(9);
    const range = to ? `Up to ${to}` : 'All time';
    doc.text(`Period: ${range}${search ? ` | Staff: ${search}` : ''} | Generated ${fmtDate(new Date().toISOString())}`, 14, 22);
    doc.text(`Total: ${formatUGX(total)} | Staff paid: ${perStaff.length} | Payments: ${filtered.length}`, 14, 27);
    autoTable(doc, {
      startY: 32,
      head: [['Staff member', 'Payments', 'Last payment', 'Total']],
      body: perStaff.map(([id, s]) => [n(id), String(s.count), fmtDate(s.last), formatUGX(s.total)]),
      styles: { fontSize: 8 },
    });
    autoTable(doc, {
      startY: (doc as any).lastAutoTable.finalY + 8,
      head: [['Date', 'Staff member', 'Reference', 'Sent by', 'Amount']],
      body: filtered.map((r) => [fmtDate(r.created_at), n(r.target_user_id), r.reference_id ?? '', n(r.created_by), formatUGX(signed(r)) + (r.operation === 'debit' ? ' (reversed)' : '')]),
      styles: { fontSize: 8 },
    });
    doc.save(`lunch-allowance-${new Date().toISOString().slice(0, 10)}.pdf`);
  };

  return (
    <div className="space-y-5">
      {/* Header Banner */}
      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-border/60 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Utensils className="h-4 w-4" />
            </span>
            <h1 className="text-xl lg:text-2xl font-bold tracking-tight text-foreground">
              Lunch Allowance
            </h1>
            <Badge variant="outline" className="text-[10px] font-semibold uppercase tracking-wider bg-muted/60 text-muted-foreground border-border/80">
              Operations
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground max-w-2xl leading-relaxed">
            Track and reconcile staff meal allowance distributions, disbursements, and company recoveries.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <Button
            variant="outline"
            size="sm"
            onClick={downloadPdf}
            disabled={isLoading || filtered.length === 0}
            className="h-8 gap-1.5 rounded-lg text-xs font-medium border-border/80 hover:bg-muted/80 shadow-2xs"
          >
            <Download className="h-3.5 w-3.5 text-muted-foreground" />
            <span>Download PDF</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            className="h-8 gap-1.5 rounded-lg text-xs font-medium border-border/80 hover:bg-muted/80 shadow-2xs"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </Button>
        </div>
      </header>

      {/* KPI Metric Strip */}
      <section aria-label="Lunch Allowance summary" className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
        <div className="min-w-0 rounded-xl border border-border/80 bg-card p-4 shadow-2xs transition-all hover:border-border">
          <div className="mb-2.5 flex items-center justify-between gap-1.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Wallet className="h-4 w-4" />
            </div>
            <span className="rounded-md px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider bg-primary/10 text-primary">
              Net Disbursed
            </span>
          </div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">
            Total Distributed
          </p>
          <p className="mt-1 text-base lg:text-lg font-bold tabular-nums tracking-tight text-foreground truncate" title={formatUGX(total)}>
            {formatUGX(total)}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground/85 truncate">
            {filtered.length} total transaction{filtered.length === 1 ? '' : 's'} recorded
          </p>
        </div>

        <div className="min-w-0 rounded-xl border border-border/80 bg-card p-4 shadow-2xs transition-all hover:border-emerald-500/40">
          <div className="mb-2.5 flex items-center justify-between gap-1.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <Calendar className="h-4 w-4" />
            </div>
            <span className="rounded-md px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              Active Month
            </span>
          </div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">
            This Month
          </p>
          <p className="mt-1 text-base lg:text-lg font-bold tabular-nums tracking-tight text-foreground truncate" title={formatUGX(thisMonth)}>
            {formatUGX(thisMonth)}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground/85 truncate">
            Disbursed in {new Date().toLocaleString('en-GB', { month: 'long', year: 'numeric' })}
          </p>
        </div>

        <div className="min-w-0 rounded-xl border border-border/80 bg-card p-4 shadow-2xs transition-all hover:border-blue-500/40">
          <div className="mb-2.5 flex items-center justify-between gap-1.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400">
              <Users className="h-4 w-4" />
            </div>
            <span className="rounded-md px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider bg-blue-500/10 text-blue-600 dark:text-blue-400">
              Recipients
            </span>
          </div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">
            Staff Members
          </p>
          <p className="mt-1 text-base lg:text-lg font-bold tabular-nums tracking-tight text-foreground truncate">
            {perStaff.length} recipients
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground/85 truncate">
            Avg {perStaff.length ? formatUGX(Math.round(total / perStaff.length)) : 'UGX 0'} per staff member
          </p>
        </div>
      </section>

      {/* Main Ledger Card */}
      <Card className="rounded-xl border border-border/80 bg-card shadow-2xs overflow-hidden">
        {/* Controls Toolbar */}
        <div className="p-3.5 sm:p-4 border-b border-border/60 bg-muted/15 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <Tabs value={viewTab} onValueChange={(v) => { setViewTab(v as any); setPage(1); }}>
            <TabsList className="h-8 bg-muted/70 p-1">
              <TabsTrigger value="all" className="text-xs px-3">
                All Transactions ({filtered.length})
              </TabsTrigger>
              <TabsTrigger value="staff" className="text-xs px-3">
                By Staff Member ({perStaff.length})
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-60">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                placeholder="Search staff name…"
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                className="h-8 pl-8 pr-7 text-xs bg-background"
                aria-label="Search staff name"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>

            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground font-medium whitespace-nowrap">Up to:</span>
              <Input
                type="date"
                value={to}
                onChange={(e) => { setTo(e.target.value); setPage(1); }}
                className="h-8 w-36 text-xs bg-background"
                aria-label="Filter up to date"
              />
            </div>

            {(to || search) && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => { setTo(''); setSearch(''); setPage(1); }}
              >
                Clear
              </Button>
            )}
          </div>
        </div>

        {/* Content View */}
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
              <span className="text-xs font-medium">Loading lunch allowance ledger…</span>
            </div>
          ) : viewTab === 'staff' ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/30 hover:bg-muted/30 text-[11px] text-muted-foreground uppercase tracking-wider">
                    <TableHead className="py-2.5 px-4 font-semibold">Staff Member</TableHead>
                    <TableHead className="py-2.5 px-4 text-center font-semibold">Disbursements</TableHead>
                    <TableHead className="py-2.5 px-4 font-semibold">Last Received</TableHead>
                    <TableHead className="py-2.5 px-4 text-right font-semibold">Total Disbursed (UGX)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {perStaff.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center py-12 text-xs text-muted-foreground">
                        No lunch allowance payments match the filters.
                      </TableCell>
                    </TableRow>
                  ) : (
                    perStaff.map(([id, s]) => (
                      <TableRow key={id} className="hover:bg-muted/40 transition-colors">
                        <TableCell className="py-3 px-4">
                          <div className="flex items-center gap-2">
                            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary text-[10px] font-bold">
                              {(data?.names[id] ?? 'U').charAt(0).toUpperCase()}
                            </span>
                            <span className="font-medium text-xs text-foreground">
                              {data?.names[id] ?? 'Unknown staff'}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="py-3 px-4 text-center tabular-nums text-xs text-muted-foreground">
                          <Badge variant="outline" className="text-[10px] font-medium">
                            {s.count} payment{s.count === 1 ? '' : 's'}
                          </Badge>
                        </TableCell>
                        <TableCell className="py-3 px-4 text-xs text-muted-foreground tabular-nums">
                          {fmtDate(s.last)}
                        </TableCell>
                        <TableCell className="py-3 px-4 text-right tabular-nums text-xs font-bold text-foreground">
                          {formatUGX(s.total)}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/30 hover:bg-muted/30 text-[11px] text-muted-foreground uppercase tracking-wider">
                      <TableHead className="py-2.5 px-4 font-semibold">Date</TableHead>
                      <TableHead className="py-2.5 px-4 font-semibold">Staff Recipient</TableHead>
                      <TableHead className="py-2.5 px-4 font-semibold">Disbursed By</TableHead>
                      <TableHead className="py-2.5 px-4 font-semibold">Reference</TableHead>
                      <TableHead className="py-2.5 px-4 text-right font-semibold">Amount (UGX)</TableHead>
                      <TableHead className="py-2.5 px-4 text-center font-semibold">Status</TableHead>
                      <TableHead className="py-2.5 px-3 text-right font-semibold w-12"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginatedRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="text-center py-12 text-xs text-muted-foreground">
                          No lunch allowance disbursements found.
                        </TableCell>
                      </TableRow>
                    ) : (
                      paginatedRows.map((r) => {
                        const isRev = r.operation === 'debit';
                        const hasBeenRev = reversedIds.has(r.id);
                        return (
                          <TableRow key={r.id} className="hover:bg-muted/40 transition-colors">
                            <TableCell className="py-3 px-4 text-xs text-muted-foreground whitespace-nowrap tabular-nums">
                              {fmtDate(r.created_at)}
                            </TableCell>
                            <TableCell className="py-3 px-4">
                              <span className="font-semibold text-xs text-foreground">
                                {data?.names[r.target_user_id] ?? 'Unknown'}
                              </span>
                            </TableCell>
                            <TableCell className="py-3 px-4 text-xs text-muted-foreground">
                              {r.created_by ? data?.names[r.created_by] ?? 'Unknown' : 'System Automated'}
                            </TableCell>
                            <TableCell className="py-3 px-4 text-xs font-mono text-muted-foreground">
                              {r.reference_id || '—'}
                            </TableCell>
                            <TableCell className="py-3 px-4 text-right tabular-nums text-xs font-bold whitespace-nowrap">
                              <span className={isRev ? 'text-destructive' : 'text-foreground'}>
                                {formatUGX(signed(r))}
                              </span>
                            </TableCell>
                            <TableCell className="py-3 px-4 text-center whitespace-nowrap">
                              {isRev ? (
                                <Badge variant="destructive" className="text-[10px] font-medium">
                                  Reversed
                                </Badge>
                              ) : hasBeenRev ? (
                                <Badge variant="secondary" className="text-[10px] font-medium">
                                  Returned
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="text-[10px] font-medium border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
                                  Paid
                                </Badge>
                              )}
                            </TableCell>
                            <TableCell className="py-3 px-3 text-right">
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                                    aria-label="Actions"
                                  >
                                    <MoreHorizontal className="h-4 w-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-44">
                                  <DropdownMenuItem
                                    disabled={isRev || hasBeenRev}
                                    onClick={() => { setReversing(r); setReason(''); }}
                                    className="text-destructive focus:text-destructive"
                                  >
                                    <Undo2 className="h-3.5 w-3.5 mr-2" /> Reverse to company
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination Footer */}
              {filtered.length > 0 && (
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 py-3 border-t border-border/60 bg-muted/10">
                  <div className="text-xs text-muted-foreground tabular-nums">
                    Showing <strong className="text-foreground">{startIndex + 1}–{endIndex}</strong> of <strong className="text-foreground">{filtered.length}</strong> payments
                  </div>
                  <div className="flex items-center gap-1 self-end sm:self-auto">
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={safePage <= 1}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <span className="text-xs text-muted-foreground px-2">
                      Page <strong className="text-foreground">{safePage}</strong> of {totalPages}
                    </span>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      disabled={safePage >= totalPages}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Reversal Confirmation Modal */}
      <AlertDialog open={!!reversing} onOpenChange={(o) => { if (!o && !busy) setReversing(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base font-bold">
              Reverse lunch allowance disbursement?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs leading-relaxed">
              {reversing && (
                <>
                  <strong className="text-foreground">{formatUGX(Number(reversing.amount))}</strong> will be deducted from{' '}
                  <strong className="text-foreground">{data?.names[reversing.target_user_id] ?? 'this staff member'}</strong>&apos;s wallet and returned to the company treasury pool.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5 pt-1">
            <label className="text-xs font-medium text-muted-foreground">Reason for Reversal (min 10 characters)</label>
            <Textarea
              placeholder="e.g. Inadvertent duplicate meal allowance disbursement"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="text-xs min-h-[70px]"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy} className="h-8 text-xs">Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || reason.trim().length < 10}
              onClick={(e) => { e.preventDefault(); submitReversal(); }}
              className="h-8 text-xs bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
              Confirm Reversal
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
