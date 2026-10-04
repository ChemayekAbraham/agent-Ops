import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Banknote,
  Loader2,
  Search,
  X,
  User,
  Calendar,
  Percent,
  TrendingUp,
  Receipt,
  HandCoins,
  FileClock,
  Undo2,
  Eye,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { formatUGX, getRiskLevel } from '@/lib/agentAdvanceCalculations';
import { differenceInDays, format } from 'date-fns';
import { cn } from '@/lib/utils';

import { ReverseAdvanceDialog } from '@/components/cfo/ReverseAdvanceDialog';
import { BulkReverseAdvancesDialog } from '@/components/cfo/BulkReverseAdvancesDialog';
import { Checkbox } from '@/components/ui/checkbox';

type StatusFilter = 'all' | 'active' | 'overdue' | 'completed';

interface AdvanceRow {
  id: string;
  agent_id: string;
  principal: number;
  outstanding_balance: number;
  arrears_balance: number | null;
  access_fee: number | null;
  access_fee_collected: number | null;
  access_fee_status: string | null;
  registration_fee: number | null;
  monthly_rate: number | null;
  cycle_days: number | null;
  daily_installment: number | null;
  status: string;
  issued_at: string;
  expires_at: string;
  issued_by: string | null;
  recovery_source: string | null;
  roi_recovery_percent: number | null;
  profiles: { full_name: string | null; phone: string | null } | null;
}

function statusBadge(status: string) {
  switch (status) {
    case 'active':
      return <Badge className="bg-green-500/10 text-green-600 border-green-500/20 hover:bg-green-500/10">Active</Badge>;
    case 'completed':
      return <Badge className="bg-blue-500/10 text-blue-600 border-blue-500/20 hover:bg-blue-500/10">Completed</Badge>;
    case 'overdue':
      return <Badge className="bg-red-500/10 text-red-600 border-red-500/20 hover:bg-red-500/10">Overdue</Badge>;
    case 'cancelled':
      return <Badge className="bg-muted text-muted-foreground border-border hover:bg-muted">Cancelled</Badge>;
    default:
      return <Badge variant="outline" className="capitalize">{status}</Badge>;
  }
}

export function DisbursedAdvancesRegister() {
  const [status, setStatus] = useState<StatusFilter>('all');
  const [agentQuery, setAgentQuery] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [selected, setSelected] = useState<AdvanceRow | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [reverseAdvance, setReverseAdvance] = useState<AdvanceRow | null>(null);
  const [bulkIds, setBulkIds] = useState<string[] | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const queryClient = useQueryClient();

  const { data: advances = [], isLoading } = useQuery({
    queryKey: ['disbursed-advances-register'],
    queryFn: async (): Promise<AdvanceRow[]> => {
      const { data, error } = await supabase
        .from('agent_advances')
        .select(
          'id, agent_id, principal, outstanding_balance, arrears_balance, access_fee, access_fee_collected, access_fee_status, registration_fee, monthly_rate, cycle_days, daily_installment, status, issued_at, expires_at, issued_by, recovery_source, roi_recovery_percent, reversed_at, reversal_amount, profiles:agent_id (full_name, phone)',
        )
        .order('issued_at', { ascending: false });
      if (error) throw error;
      return (data || []) as unknown as AdvanceRow[];
    },
  });

  const filtered = useMemo(() => {
    const q = agentQuery.trim().toLowerCase();
    const from = fromDate ? new Date(fromDate + 'T00:00:00') : null;
    const to = toDate ? new Date(toDate + 'T23:59:59') : null;
    return advances.filter((a) => {
      if (status !== 'all' && a.status !== status) return false;
      if (q) {
        const name = (a.profiles?.full_name || '').toLowerCase();
        const phone = (a.profiles?.phone || '').toLowerCase();
        if (!name.includes(q) && !phone.includes(q)) return false;
      }
      const issued = new Date(a.issued_at);
      if (from && issued < from) return false;
      if (to && issued > to) return false;
      return true;
    });
  }, [advances, status, agentQuery, fromDate, toDate]);

  const totals = useMemo(() => {
    const principal = filtered.reduce((s, a) => s + Number(a.principal || 0), 0);
    const outstanding = filtered.reduce((s, a) => s + Number(a.outstanding_balance || 0), 0);
    const fees = filtered.reduce((s, a) => s + Number(a.access_fee || 0) + Number(a.registration_fee || 0), 0);
    const agents = new Set(filtered.map((a) => a.agent_id)).size;
    return { principal, outstanding, fees, agents, count: filtered.length };
  }, [filtered]);

  const hasFilters = status !== 'all' || !!agentQuery || !!fromDate || !!toDate;
  const clearFilters = () => {
    setStatus('all');
    setAgentQuery('');
    setFromDate('');
    setToDate('');
    setPage(1);
  };

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const startIndex = (safePage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, filtered.length);
  const paginated = useMemo(
    () => filtered.slice(startIndex, endIndex),
    [filtered, startIndex, endIndex],
  );

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const pageNumbers = useMemo(() => {
    const pages: (number | string)[] = [];
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      if (safePage > 3) pages.push(1, '...');
      for (let i = Math.max(2, safePage - 1); i <= Math.min(totalPages - 1, safePage + 1); i++) {
        pages.push(i);
      }
      if (safePage < totalPages - 2) pages.push('...', totalPages);
      else if (safePage < totalPages - 1) pages.push(totalPages);
    }
    return pages;
  }, [safePage, totalPages]);

  // Rows a reversal can still touch: not yet reversed. The reversal window and
  // recovery amounts are decided server-side, never here.
  const isReversible = (a: AdvanceRow) => !(a as any).reversed_at;
  const reversibleFiltered = useMemo(() => filtered.filter(isReversible), [filtered]);
  const REVERSAL_WINDOW_DAYS = 3;
  const isTodaysBatch = (a: AdvanceRow) =>
    isReversible(a) &&
    new Date(a.issued_at).getTime() >= Date.now() - REVERSAL_WINDOW_DAYS * 86_400_000;
  const todaysBatch = useMemo(() => advances.filter(isTodaysBatch), [advances]);


  const toggleChecked = (id: string) =>
    setCheckedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const openBulk = (ids: string[] | null) => {
    setBulkIds(ids);
    setBulkOpen(true);
  };

  const invalidateAdvanceQueries = () => {
    queryClient.invalidateQueries({ queryKey: ['disbursed-advances-register'] });
    queryClient.invalidateQueries({ queryKey: ['cfo-advances'] });
    queryClient.invalidateQueries({ queryKey: ['cfo-outstanding-advances'] });
    // Reversed requests go back to Waiting for Approval — refresh every queue.
    queryClient.invalidateQueries({
      predicate: (q) => {
        const k = String(q.queryKey?.[0] ?? '');
        return k.includes('advance-request') || k.includes('advance_requests') || k.includes('agent-advance');
      },
    });
  };



  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Banknote className="h-4 w-4 text-primary" />
          Disbursed Advances Register
          <Badge variant="outline" className="text-[10px] ml-1">{advances.length} total</Badge>
        </CardTitle>
        <p className="text-[11px] text-muted-foreground">
          Every advance disbursed to an agent wallet. Filter by date, agent, or status and open any row for the full disbursement detail.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <div className="rounded-lg border p-2">
            <p className="text-[10px] text-muted-foreground flex items-center gap-1"><HandCoins className="h-3 w-3" /> Principal Disbursed</p>
            <p className="text-sm font-bold">{formatUGX(totals.principal)}</p>
          </div>
          <div className="rounded-lg border p-2">
            <p className="text-[10px] text-muted-foreground flex items-center gap-1"><TrendingUp className="h-3 w-3 text-amber-600" /> Outstanding</p>
            <p className="text-sm font-bold text-amber-600">{formatUGX(totals.outstanding)}</p>
          </div>
          <div className="rounded-lg border p-2">
            <p className="text-[10px] text-muted-foreground flex items-center gap-1"><Receipt className="h-3 w-3 text-emerald-600" /> Fees Charged</p>
            <p className="text-sm font-bold text-emerald-600">{formatUGX(totals.fees)}</p>
          </div>
          <div className="rounded-lg border p-2">
            <p className="text-[10px] text-muted-foreground flex items-center gap-1"><User className="h-3 w-3" /> Agents</p>
            <p className="text-sm font-bold">{totals.agents}</p>
          </div>
        </div>

        {/* Filters */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 items-end">
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Agent</Label>
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={agentQuery}
                onChange={(e) => setAgentQuery(e.target.value)}
                placeholder="Name or phone"
                className="h-8 pl-7 text-sm"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Status</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
              <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="overdue">Overdue</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Disbursed from</Label>
            <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="h-8 text-sm" />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Disbursed to</Label>
            <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="h-8 text-sm" />
          </div>
        </div>
        {hasFilters && (
          <div className="flex items-center justify-between">
            <p className="text-[11px] text-muted-foreground">
              Showing <span className="font-semibold text-foreground">{filtered.length}</span> of {advances.length}
            </p>
            <Button variant="ghost" size="sm" className="h-7 text-[11px]" onClick={clearFilters}>
              <X className="h-3 w-3 mr-1" /> Clear filters
            </Button>
          </div>
        )}

        {/* Bulk reversal toolbar */}
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-2">
          <p className="text-[11px] text-muted-foreground flex-1 min-w-[180px]">
            {checkedIds.size > 0
              ? `${checkedIds.size} advance${checkedIds.size === 1 ? '' : 's'} selected for reversal.`
              : 'Tick rows to reverse several advances at once, or reverse the whole recent batch (last 3 days).'}
          </p>
          {checkedIds.size > 0 && (
            <Button variant="ghost" size="sm" className="h-7 text-[11px]" onClick={() => setCheckedIds(new Set())}>
              Clear selection
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[11px] gap-1"
            disabled={todaysBatch.length === 0}
            onClick={() => openBulk(null)}
          >
            <Undo2 className="h-3 w-3" /> Reverse recent batch ({todaysBatch.length})
          </Button>
          <Button
            size="sm"
            variant="destructive"
            className="h-7 text-[11px] gap-1"
            disabled={checkedIds.size === 0}
            onClick={() => openBulk(Array.from(checkedIds))}
          >
            <Undo2 className="h-3 w-3" /> Reverse selected ({checkedIds.size})
          </Button>
        </div>

        {/* Table */}
        {isLoading ? (
          <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-10 text-muted-foreground text-sm">No disbursed advances match your filters.</div>
        ) : (
          <div className="rounded-xl border border-border/50 shadow-sm overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50 hover:bg-muted/50">
                  <TableHead className="w-10">
                    <Checkbox
                      aria-label="Select all reversible advances"
                      checked={
                        reversibleFiltered.length > 0 &&
                        reversibleFiltered.every((a) => checkedIds.has(a.id))
                      }
                      onCheckedChange={(v) =>
                        setCheckedIds(v ? new Set(reversibleFiltered.map((a) => a.id)) : new Set())
                      }
                    />
                  </TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider">Agent</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider">Principal</TableHead>
                  <TableHead className="text-right hidden sm:table-cell text-xs font-semibold uppercase tracking-wider">Outstanding</TableHead>
                  <TableHead className="hidden md:table-cell text-xs font-semibold uppercase tracking-wider">Disbursed</TableHead>
                  <TableHead className="hidden lg:table-cell text-xs font-semibold uppercase tracking-wider">Days Left</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider">Status</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider">Review</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginated.map((a) => {
                  const daysLeft = Math.max(0, differenceInDays(new Date(a.expires_at), new Date()));
                  const risk = getRiskLevel(a);
                  return (
                    <TableRow
                      key={a.id}
                      className="cursor-pointer hover:bg-muted/30 transition-colors"
                      onClick={() => setSelected(a)}
                    >
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          aria-label="Select advance for reversal"
                          disabled={!isReversible(a)}
                          checked={checkedIds.has(a.id)}
                          onCheckedChange={() => toggleChecked(a.id)}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className={cn('h-2 w-2 rounded-full shrink-0', risk === 'green' ? 'bg-green-500' : risk === 'yellow' ? 'bg-amber-500' : 'bg-red-500')} />
                          <div className="min-w-0">
                            <p className="font-medium truncate">{a.profiles?.full_name || 'Unknown'}</p>
                            <p className="text-[11px] text-muted-foreground truncate">{a.profiles?.phone || '—'}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-semibold">{formatUGX(a.principal)}</TableCell>
                      <TableCell className="text-right tabular-nums hidden sm:table-cell text-amber-600 font-semibold">{formatUGX(a.outstanding_balance)}</TableCell>
                      <TableCell className="hidden md:table-cell text-muted-foreground text-sm whitespace-nowrap">{format(new Date(a.issued_at), 'dd MMM yyyy')}</TableCell>
                      <TableCell className="hidden lg:table-cell text-sm tabular-nums text-muted-foreground">{daysLeft}d</TableCell>
                      <TableCell>{statusBadge(a.status)}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          {!(a as any).reversed_at && (
                            <Button
                              size="sm"
                              variant="destructive"
                              className="h-7 text-[11px] gap-1"
                              onClick={(e) => { e.stopPropagation(); setReverseAdvance(a); }}
                            >
                              <Undo2 className="h-3 w-3" /> Reverse
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs gap-1"
                            onClick={(e) => { e.stopPropagation(); setSelected(a); }}
                          >
                            <Eye className="h-3.5 w-3.5" /> Review
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Pagination */}
        {filtered.length > 0 && (
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2">
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span>Rows per page</span>
              <Select
                value={String(pageSize)}
                onValueChange={(v) => {
                  setPageSize(Number(v));
                  setPage(1);
                }}
              >
                <SelectTrigger className="h-7 w-[70px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[10, 25, 50, 100].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="hidden sm:inline">
                Showing {startIndex + 1}–{endIndex} of {filtered.length}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={safePage <= 1}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              {pageNumbers.map((p, i) =>
                typeof p === 'number' ? (
                  <Button
                    key={`${p}-${i}`}
                    variant={p === safePage ? 'default' : 'outline'}
                    size="sm"
                    className="h-7 min-w-[28px] px-2 text-xs"
                    onClick={() => setPage(p)}
                  >
                    {p}
                  </Button>
                ) : (
                  <span key={`ellipsis-${i}`} className="px-1 text-xs text-muted-foreground">
                    ...
                  </span>
                ),
              )}
              <Button
                variant="outline"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={safePage >= totalPages}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>

      <DisbursementDetailDrawer
        advance={selected}
        onClose={() => setSelected(null)}
        onReverse={(a) => { setSelected(null); setReverseAdvance(a); }}
      />

      <ReverseAdvanceDialog
        advance={reverseAdvance}
        open={!!reverseAdvance}
        onOpenChange={(o) => { if (!o) setReverseAdvance(null); }}
        onSuccess={() => {
          setReverseAdvance(null);
          invalidateAdvanceQueries();
        }}
      />

      <BulkReverseAdvancesDialog
        open={bulkOpen}
        advanceIds={bulkIds}
        onOpenChange={(o) => {
          setBulkOpen(o);
          if (!o) {
            setBulkIds(null);
            setCheckedIds(new Set());
          }
        }}
        onSuccess={invalidateAdvanceQueries}
      />
    </Card>

  );
}

function DisbursementDetailDrawer({ advance, onClose, onReverse }: { advance: AdvanceRow | null; onClose: () => void; onReverse: (a: AdvanceRow) => void }) {
  const { data: ledger = [], isLoading } = useQuery({
    queryKey: ['advance-ledger', advance?.id],
    enabled: !!advance?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_advance_ledger')
        .select('id, date, opening_balance, interest_accrued, amount_deducted, closing_balance, deduction_status, recovery_source, roi_amount, recovery_percent')
        .eq('advance_id', advance!.id)
        .order('date', { ascending: false });
      if (error) throw error;
      const rows = data || [];
      // ROI advances only ever show ROI recovery events — never daily sweep rows
      return advance?.recovery_source === 'roi'
        ? rows.filter((r: any) => r.recovery_source === 'roi' && Number(r.amount_deducted || 0) > 0)
        : rows;
    },
  });

  const { data: issuer } = useQuery({
    queryKey: ['advance-issuer', advance?.issued_by],
    enabled: !!advance?.issued_by,
    queryFn: async () => {
      const { data } = await supabase.from('profiles').select('full_name').eq('id', advance!.issued_by!).maybeSingle();
      return data?.full_name || null;
    },
  });

  if (!advance) return null;

  const isRoi = advance.recovery_source === 'roi';
  const interest = Math.max(0, Number(advance.outstanding_balance) - Number(advance.principal));
  const totalPayable = Number(advance.principal) + Number(advance.access_fee || 0) + Number(advance.registration_fee || 0);
  const totalDeducted = ledger.reduce((s, l) => s + Number(l.amount_deducted || 0), 0);
  const outstanding = Number(advance.outstanding_balance);
  // ROI advances: progress is recovered ÷ (recovered + outstanding) and only moves on ROI recoveries
  const repaid = isRoi ? totalDeducted : Math.max(0, totalPayable - outstanding);
  const progressBase = isRoi ? totalDeducted + outstanding : totalPayable;
  const progress = progressBase > 0 ? Math.min(100, Math.round((repaid / progressBase) * 100)) : 0;
  const lastRecovery = isRoi ? ledger.find((l) => Number(l.amount_deducted || 0) > 0) : null;

  const rows: Array<[string, React.ReactNode]> = isRoi
    ? [
        ['Principal', formatUGX(advance.principal)],
        ['Access Fee', formatUGX(Number(advance.access_fee || 0))],
        ['Registration Fee', formatUGX(Number(advance.registration_fee || 0))],
        ['Total Payable', formatUGX(totalPayable)],
        ['Recovery Source', 'ROI'],
        ['ROI Recovery %', `${Number(advance.roi_recovery_percent || 0)}%`],
        ['Total Recovered from ROI', formatUGX(totalDeducted)],
        ['Remaining Outstanding', formatUGX(outstanding)],
        ['Last ROI Recovery', lastRecovery ? format(new Date(lastRecovery.date), 'dd MMM yyyy') : 'None yet'],
        ['Next Recovery', 'On next successful ROI payout'],
        ['Monthly Rate', `${Math.round(Number(advance.monthly_rate || 0) * 100)}%`],
        ['Fee Status', advance.access_fee_status || '—'],
      ]
    : [
    ['Principal', formatUGX(advance.principal)],
    ['Access Fee', formatUGX(Number(advance.access_fee || 0))],
    ['Registration Fee', formatUGX(Number(advance.registration_fee || 0))],
    ['Total Payable', formatUGX(totalPayable)],
    ['Outstanding', formatUGX(advance.outstanding_balance)],
    ['Arrears', formatUGX(Number(advance.arrears_balance || 0))],
    ['Accrued Interest', formatUGX(interest)],
    ['Daily Installment', formatUGX(Number(advance.daily_installment || 0))],
    ['Monthly Rate', `${Math.round(Number(advance.monthly_rate || 0) * 100)}%`],
    ['Cycle Days', `${advance.cycle_days ?? '—'} days`],
    ['Fee Status', advance.access_fee_status || '—'],
    ['Recovery Source', 'Daily wallet sweep'],
  ];

  return (
    <Sheet open={!!advance} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-md p-0">
        <ScrollArea className="h-full">
          <div className="p-5 space-y-5">
            <SheetHeader className="space-y-1 text-left">
              <SheetTitle className="flex items-center gap-2 text-base">
                <User className="h-4 w-4 text-primary" />
                {advance.profiles?.full_name || 'Unknown agent'}
              </SheetTitle>
              <SheetDescription className="text-xs">
                {advance.profiles?.phone || '—'} · {statusBadge(advance.status)}
              </SheetDescription>
            </SheetHeader>

            {/* Repayment progress */}
            <div className="rounded-lg border p-3 space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">
                  {isRoi ? `Recovered from ROI ${formatUGX(repaid)}` : `Repaid ${formatUGX(repaid)}`}
                </span>
                <span className="font-semibold">{progress}%</span>
              </div>
              <div className="h-2 rounded-full bg-muted overflow-hidden">
                <div className="h-full bg-emerald-500" style={{ width: `${progress}%` }} />
              </div>
              <p className="text-[10px] text-muted-foreground">
                {isRoi
                  ? `of ${formatUGX(progressBase)} — advances only on ROI recoveries`
                  : `of ${formatUGX(totalPayable)} total payable`}
              </p>
            </div>

            {/* Disbursement dates */}
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg border p-2">
                <p className="text-[10px] text-muted-foreground flex items-center gap-1"><Calendar className="h-3 w-3" /> Disbursed</p>
                <p className="text-xs font-semibold">{format(new Date(advance.issued_at), 'dd MMM yyyy, HH:mm')}</p>
              </div>
              <div className="rounded-lg border p-2">
                <p className="text-[10px] text-muted-foreground flex items-center gap-1"><FileClock className="h-3 w-3" /> Expires</p>
                <p className="text-xs font-semibold">{format(new Date(advance.expires_at), 'dd MMM yyyy')}</p>
                {isRoi && <p className="text-[9px] text-muted-foreground">Term only — no daily repayment</p>}
              </div>
            </div>

            {/* Key figures */}
            <div className="rounded-lg border divide-y text-xs">
              {rows.map(([label, value]) => (
                <div key={label} className="flex justify-between px-3 py-1.5">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="font-mono font-semibold">{value}</span>
                </div>
              ))}
              {issuer && (
                <div className="flex justify-between px-3 py-1.5">
                  <span className="text-muted-foreground">Disbursed by</span>
                  <span className="font-semibold">{issuer}</span>
                </div>
              )}
            </div>

            {/* Repayment ledger */}
            <div className="space-y-2">
              <p className="text-xs font-bold flex items-center gap-1.5">
                <Percent className="h-3.5 w-3.5 text-primary" /> {isRoi ? 'ROI Recovery History' : 'Repayment History'}
                {ledger.length > 0 && <Badge variant="outline" className="text-[10px]">{formatUGX(totalDeducted)} recovered</Badge>}
              </p>
              {isLoading ? (
                <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
              ) : ledger.length === 0 ? (
                <p className="text-[11px] text-muted-foreground py-2">
                  {isRoi ? 'No ROI recoveries yet. Recovery happens on the next ROI payout.' : 'No repayment entries recorded yet.'}
                </p>
              ) : (
                <div className="rounded-md border overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-[10px]">Date</TableHead>
                        {isRoi && <TableHead className="text-[10px] text-right">ROI</TableHead>}
                        {isRoi && <TableHead className="text-[10px] text-right">%</TableHead>}
                        <TableHead className="text-[10px] text-right">{isRoi ? 'Recovered' : 'Deducted'}</TableHead>
                        <TableHead className="text-[10px] text-right">{isRoi ? 'Outstanding' : 'Balance'}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {ledger.map((l) => (
                        <TableRow key={l.id}>
                          <TableCell className="text-[11px]">{format(new Date(l.date), 'dd MMM')}</TableCell>
                          {isRoi && (
                            <TableCell className="text-[11px] text-right font-mono">
                              {l.roi_amount != null ? formatUGX(Number(l.roi_amount)) : '—'}
                            </TableCell>
                          )}
                          {isRoi && (
                            <TableCell className="text-[11px] text-right font-mono">
                              {l.recovery_percent != null ? `${Number(l.recovery_percent)}%` : '—'}
                            </TableCell>
                          )}
                          <TableCell className="text-[11px] text-right font-mono text-emerald-600">{formatUGX(Number(l.amount_deducted || 0))}</TableCell>
                          <TableCell className="text-[11px] text-right font-mono">{formatUGX(Number(l.closing_balance || 0))}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>

            {!(advance as any).reversed_at && (
              <Button
                variant="destructive"
                className="w-full gap-1"
                onClick={() => onReverse(advance)}
              >
                <Undo2 className="h-4 w-4" /> Reverse this disbursement
              </Button>
            )}
            <Button variant="outline" className="w-full" onClick={onClose}>Close</Button>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
