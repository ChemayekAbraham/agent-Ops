import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { downloadCsv } from '@/lib/csvExport';
import {
  ArrowUpCircle, Search, X, CalendarIcon, FileText, FileSpreadsheet, Loader2, RefreshCw, CheckCircle2, Undo2,
} from 'lucide-react';

type StatusGroup = 'pending' | 'applied';

interface TopUpRow {
  id: string;
  partnerName: string;
  portfolioName: string;
  portfolioCode: string;
  portfolioId: string;
  amount: number;
  previousCapital: number | null;
  createdAt: string;
  reason: string;
  rawStatus: string;
  group: StatusGroup;
}

const APPLIED_STATUSES = new Set(['completed']);

function groupOf(status: string): StatusGroup {
  return APPLIED_STATUSES.has(status) ? 'applied' : 'pending';
}

async function fetchTopUpRows(): Promise<TopUpRow[]> {
  // Paginate: a single .limit() silently dropped the oldest records once the
  // total passed the page size, understating applied top-up totals.
  const PAGE = 1000;
  const MAX_PAGES = 20;
  const list: any[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data: ops, error } = await supabase
      .from('pending_wallet_operations')
      .select('id, source_id, user_id, amount, status, created_at, description, metadata')
      .eq('operation_type', 'portfolio_topup')
      .eq('source_table', 'investor_portfolios')
      .in('status', ['pending', 'awaiting_verification', 'approved', 'completed'])
      .order('created_at', { ascending: false })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw error;
    const batch = ops || [];
    list.push(...batch);
    if (batch.length < PAGE) break;
  }
  const portfolioIds = Array.from(new Set(list.map((o: any) => o.source_id).filter(Boolean)));


  const portfolioMap: Record<string, { account_name: string | null; portfolio_code: string | null; investor_id: string | null; investment_amount: number }> = {};
  if (portfolioIds.length > 0) {
    const { data: portfolios } = await supabase
      .from('investor_portfolios')
      .select('id, account_name, portfolio_code, investor_id, investment_amount')
      .in('id', portfolioIds);
    (portfolios || []).forEach((p: any) => {
      portfolioMap[p.id] = {
        account_name: p.account_name,
        portfolio_code: p.portfolio_code,
        investor_id: p.investor_id,
        investment_amount: Number(p.investment_amount) || 0,
      };
    });
  }

  const investorIds = Array.from(new Set([
    ...Object.values(portfolioMap).map(p => p.investor_id),
    ...list.map((o: any) => o.user_id),
  ].filter(Boolean) as string[]));
  const nameMap: Record<string, string> = {};
  if (investorIds.length > 0) {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, full_name')
      .in('id', investorIds);
    (profiles || []).forEach((pr: any) => { nameMap[pr.id] = pr.full_name || ''; });
  }

  // Capital before each top-up. The merge path never stamped `previous_capital`
  // on the operation, so we reconstruct it from the portfolio's CURRENT capital by
  // walking the applied (merged) top-ups newest → oldest and peeling each amount
  // off. Pending/parked rows are not in the principal yet, so their "before" is
  // simply the current capital.
  const beforeById: Record<string, number> = {};
  const byPortfolio: Record<string, any[]> = {};
  list.forEach((o: any) => {
    if (!o.source_id) return;
    (byPortfolio[o.source_id] ||= []).push(o);
  });
  Object.entries(byPortfolio).forEach(([pid, ops]) => {
    const current = portfolioMap[pid]?.investment_amount;
    if (current == null) return;
    let running = current;
    ops
      .filter((o) => groupOf(o.status) === 'applied')
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .forEach((o) => {
        const amt = Number(o.amount) || 0;
        beforeById[o.id] = Math.max(0, running - amt);
        running = Math.max(0, running - amt);
      });
    ops
      .filter((o) => groupOf(o.status) !== 'applied')
      .forEach((o) => {
        beforeById[o.id] = current;
      });
  });

  return list.map((o: any) => {
    const portfolio = portfolioMap[o.source_id] || { account_name: null, portfolio_code: null, investor_id: null, investment_amount: 0 };
    const meta = (o.metadata && typeof o.metadata === 'object') ? o.metadata : {};
    const reason = meta.reason || meta.agent_name ? (meta.reason || `via ${meta.agent_name}`) : (o.description || '');
    const code = portfolio.portfolio_code || meta.portfolio_code || '—';
    const stamped = meta.previous_capital != null && Number.isFinite(Number(meta.previous_capital))
      ? Number(meta.previous_capital)
      : null;
    return {
      id: o.id,
      partnerName:
        (portfolio.investor_id && nameMap[portfolio.investor_id]) ||
        (o.user_id && nameMap[o.user_id]) ||
        meta.source_wallet_owner ||
        '—',
      portfolioName: portfolio.account_name || code,
      portfolioCode: code,
      portfolioId: o.source_id,
      amount: Number(o.amount) || 0,
      previousCapital: stamped ?? (beforeById[o.id] != null ? beforeById[o.id] : null),
      createdAt: o.created_at,
      reason: meta.reason || (o.description ?? ''),
      rawStatus: o.status,
      group: groupOf(o.status),
    } as TopUpRow;
  });
}

export function PortfolioTopUpsCard() {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<TopUpRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      setRows(await fetchTopUpRows());
    } catch {
      /* surfaced via empty state */
    } finally {
      setLoading(false);
    }
  };

  // Lightweight count fetch for the card badge on mount.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const data = await fetchTopUpRows();
        if (active) setRows(data);
      } catch { /* ignore */ }
    })();
    return () => { active = false; };
  }, []);

  const pendingCount = rows.filter(r => r.group === 'pending').length;
  const pendingTotal = rows.filter(r => r.group === 'pending').reduce((s, r) => s + r.amount, 0);

  return (
    <>
      <button
        onClick={() => { setOpen(true); load(); }}
        className={cn(
          'rounded-2xl border p-3.5 space-y-2 text-left w-full transition-all hover:shadow-lg active:scale-[0.98]',
          pendingCount > 0 ? 'border-amber-500/30 bg-amber-500/5' : 'border-primary/30 bg-primary/5',
        )}
      >
        <div className="flex items-center gap-2">
          <div className={cn('p-1.5 rounded-lg', pendingCount > 0 ? 'text-amber-600 bg-amber-500/10' : 'text-primary bg-primary/10')}>
            <ArrowUpCircle className="h-4 w-4" />
          </div>
          <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Top-Ups</span>
        </div>
        <p className="text-xl font-black tracking-tight tabular-nums">{pendingCount}</p>
        <p className="text-[11px] text-muted-foreground leading-snug">
          {pendingCount > 0 ? `${formatUGX(pendingTotal)} pending · tap to review` : 'No pending top-ups · tap to view'}
        </p>
      </button>

      <TopUpsDialog open={open} onOpenChange={setOpen} rows={rows} loading={loading} onRefresh={load} />
    </>
  );
}

function TopUpsDialog({ open, onOpenChange, rows, loading, onRefresh }: {
  open: boolean; onOpenChange: (v: boolean) => void; rows: TopUpRow[]; loading: boolean; onRefresh: () => void;
}) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | StatusGroup>('all');
  const [fromDate, setFromDate] = useState<Date | undefined>();
  const [toDate, setToDate] = useState<Date | undefined>();
  const searchRef = useRef<HTMLInputElement>(null);
  const [actionTarget, setActionTarget] = useState<{ row: TopUpRow; action: 'apply' | 'reverse' } | null>(null);
  const [reasonText, setReasonText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const runAction = async () => {
    if (!actionTarget) return;
    if (reasonText.trim().length < 10) {
      toast.error('Reason must be at least 10 characters');
      return;
    }
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke('portfolio-topup-row-action', {
        body: { op_id: actionTarget.row.id, action: actionTarget.action, reason: reasonText.trim() },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      toast.success(
        actionTarget.action === 'apply'
          ? `Applied ${formatUGX(actionTarget.row.amount)} into capital`
          : `Reversed ${formatUGX(actionTarget.row.amount)} — top-up re-parked`,
      );
      setActionTarget(null);
      setReasonText('');
      onRefresh();
    } catch (e: any) {
      toast.error(e?.message || 'Action failed');
    } finally {
      setSubmitting(false);
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => {
      if (statusFilter !== 'all' && r.group !== statusFilter) return false;
      if (q && !(r.partnerName.toLowerCase().includes(q) || r.portfolioName.toLowerCase().includes(q) || r.portfolioCode.toLowerCase().includes(q))) return false;
      if (fromDate) {
        const d = new Date(r.createdAt);
        const start = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
        if (d < start) return false;
      }
      if (toDate) {
        const d = new Date(r.createdAt);
        const end = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate(), 23, 59, 59, 999);
        if (d > end) return false;
      }
      return true;
    });
  }, [rows, search, statusFilter, fromDate, toDate]);

  const totalAmount = filtered.reduce((s, r) => s + r.amount, 0);
  const hasActiveFilter = !!search || statusFilter !== 'all' || !!fromDate || !!toDate;

  const clearFilters = () => { setSearch(''); setStatusFilter('all'); setFromDate(undefined); setToDate(undefined); };

  const exportRows = () => filtered.map(r => [
    r.partnerName,
    r.portfolioName,
    r.portfolioCode,
    format(new Date(r.createdAt), 'yyyy-MM-dd HH:mm'),
    r.amount,
    r.group === 'applied' ? 'Applied' : 'Pending',
    r.reason || '',
  ]);
  const headers = ['Partner', 'Portfolio Name', 'Portfolio ID', 'Date Applied', 'Amount (UGX)', 'Status', 'Reason'];

  const handleCsv = () => {
    downloadCsv(`portfolio_topups_${format(new Date(), 'yyyy-MM-dd')}.csv`, headers, exportRows());
  };

  const handlePdf = async () => {
    const { default: jsPDF } = await import('jspdf');
    const autoTable = (await import('jspdf-autotable')).default;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    doc.setFontSize(14);
    doc.text('Portfolio Top-Ups', 40, 36);
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text(`Generated ${format(new Date(), 'PPP p')} · ${filtered.length} record(s) · Total ${formatUGX(totalAmount)}`, 40, 52);
    autoTable(doc, {
      startY: 66,
      head: [headers],
      body: exportRows().map(r => r.map((c, i) => (i === 4 ? formatUGX(Number(c)) : String(c)))),
      styles: { fontSize: 8, cellPadding: 4 },
      headStyles: { fillColor: [37, 99, 235] },
      columnStyles: { 6: { cellWidth: 160 } },
    });
    doc.save(`portfolio_topups_${format(new Date(), 'yyyy-MM-dd')}.pdf`);
  };

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowUpCircle className="h-5 w-5 text-primary" /> Portfolio Top-Ups
          </DialogTitle>
          <DialogDescription>
            {filtered.length} record(s) · {formatUGX(totalAmount)} total
          </DialogDescription>
        </DialogHeader>

        {/* Filters bar */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by username or portfolio name…"
              className="h-9 w-full rounded-lg border border-border bg-background pl-8 pr-8 text-sm placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-muted">
                <X className="h-3 w-3 text-muted-foreground" />
              </button>
            )}
          </div>

          <Select value={statusFilter} onValueChange={(v: any) => setStatusFilter(v)}>
            <SelectTrigger className="w-[130px] h-9 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="applied">Applied</SelectItem>
            </SelectContent>
          </Select>

          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className={cn('h-9 gap-1.5 text-xs', !fromDate && 'text-muted-foreground')}>
                <CalendarIcon className="h-3.5 w-3.5" />{fromDate ? format(fromDate, 'dd MMM') : 'From'}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar mode="single" selected={fromDate} onSelect={setFromDate} initialFocus className="p-3 pointer-events-auto" />
            </PopoverContent>
          </Popover>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className={cn('h-9 gap-1.5 text-xs', !toDate && 'text-muted-foreground')}>
                <CalendarIcon className="h-3.5 w-3.5" />{toDate ? format(toDate, 'dd MMM') : 'To'}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar mode="single" selected={toDate} onSelect={setToDate} initialFocus className="p-3 pointer-events-auto" />
            </PopoverContent>
          </Popover>

          {hasActiveFilter && (
            <Button variant="ghost" size="sm" className="h-9 text-xs gap-1" onClick={clearFilters}>
              <X className="h-3.5 w-3.5" /> Clear
            </Button>
          )}

          <div className="flex items-center gap-2 ml-auto">
            <Button variant="outline" size="sm" className="h-9 gap-1.5 text-xs" onClick={onRefresh} disabled={loading}>
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh
            </Button>
            <Button variant="outline" size="sm" className="h-9 gap-1.5 text-xs" onClick={handleCsv} disabled={filtered.length === 0}>
              <FileSpreadsheet className="h-3.5 w-3.5" /> CSV
            </Button>
            <Button variant="outline" size="sm" className="h-9 gap-1.5 text-xs" onClick={handlePdf} disabled={filtered.length === 0}>
              <FileText className="h-3.5 w-3.5" /> PDF
            </Button>
          </div>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-auto rounded-lg border border-border">
          <Table>
            <TableHeader className="sticky top-0 bg-background z-10">
              <TableRow>
                <TableHead>Partner</TableHead>
                <TableHead>Portfolio</TableHead>
                <TableHead>Date Applied</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow><TableCell colSpan={6} className="text-center py-10 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin mx-auto" /></TableCell></TableRow>
              ) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center py-10 text-muted-foreground text-sm">No top-ups match the current filters.</TableCell></TableRow>
              ) : (
                filtered.map(r => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{r.partnerName}</TableCell>
                    <TableCell>
                      <div className="leading-tight">
                        <p className="font-medium">{r.portfolioName}</p>
                        <p className="text-[11px] text-muted-foreground font-mono">{r.portfolioCode}</p>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm whitespace-nowrap">{format(new Date(r.createdAt), 'dd MMM yyyy, HH:mm')}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <div className="leading-tight">
                        {r.previousCapital != null && (
                          <p className="text-[11px] text-muted-foreground tabular-nums">Before: {formatUGX(r.previousCapital)}</p>
                        )}
                        <p className="font-semibold tabular-nums">{formatUGX(r.amount)}</p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={r.group === 'applied' ? 'secondary' : 'outline'} className={cn('text-[10px]', r.group === 'pending' && 'border-amber-500/40 text-amber-600')}>
                        {r.group === 'applied' ? 'Applied' : 'Pending'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        {r.group === 'applied' ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 gap-1 text-[11px] border-red-500/40 text-red-600 hover:bg-red-500/10"
                            onClick={() => { setReasonText(''); setActionTarget({ row: r, action: 'reverse' }); }}
                            title="Reverse this merge if the cron mis-applied it"
                          >
                            <Undo2 className="h-3.5 w-3.5" /> Reverse
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 gap-1 text-[11px] border-emerald-500/40 text-emerald-600 hover:bg-emerald-500/10"
                            onClick={() => { setReasonText(''); setActionTarget({ row: r, action: 'apply' }); }}
                            title="Apply now if the merge cron failed to run"
                          >
                            <CheckCircle2 className="h-3.5 w-3.5" /> Apply
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </DialogContent>
    </Dialog>

    {/* Apply / Reverse confirmation with mandatory reason */}
    <Dialog open={!!actionTarget} onOpenChange={(v) => { if (!v && !submitting) { setActionTarget(null); setReasonText(''); } }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {actionTarget?.action === 'reverse'
              ? (<><Undo2 className="h-5 w-5 text-red-600" /> Reverse Top-Up Merge</>)
              : (<><CheckCircle2 className="h-5 w-5 text-emerald-600" /> Apply Top-Up</>)}
          </DialogTitle>
          <DialogDescription>
            {actionTarget && (
              actionTarget.action === 'reverse'
                ? `Remove ${formatUGX(actionTarget.row.amount)} from "${actionTarget.row.portfolioName}" and re-park this top-up (use if the cron mis-applied the merge).`
                : `Merge ${formatUGX(actionTarget.row.amount)} into "${actionTarget.row.portfolioName}" now (use if the merge cron failed to run).`
            )}
          </DialogDescription>
        </DialogHeader>
        <textarea
          value={reasonText}
          onChange={(e) => setReasonText(e.target.value)}
          placeholder="Reason (min 10 characters)…"
          rows={3}
          className="w-full rounded-lg border border-border bg-background p-2.5 text-sm placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">{reasonText.trim().length}/10 min</span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" disabled={submitting} onClick={() => { setActionTarget(null); setReasonText(''); }}>Cancel</Button>
            <Button
              size="sm"
              disabled={submitting || reasonText.trim().length < 10}
              className={actionTarget?.action === 'reverse' ? 'bg-red-600 hover:bg-red-700 text-white' : 'bg-emerald-600 hover:bg-emerald-700 text-white'}
              onClick={runAction}
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : (actionTarget?.action === 'reverse' ? 'Reverse' : 'Apply')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
    </>
  );
}