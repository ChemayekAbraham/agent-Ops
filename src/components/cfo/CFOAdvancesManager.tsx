import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Plus, TrendingUp, AlertTriangle, DollarSign, Shield, Percent, Calculator, Receipt, Trash2, RefreshCw, Download, FileText, Ban, Pencil, ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import { exportAdvanceStatements, exportConsolidatedPayments } from '@/lib/agentAdvancePdfExport';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { formatUGX, getRiskLevel } from '@/lib/agentAdvanceCalculations';
import IssueAdvanceSheet from '@/components/manager/IssueAdvanceSheet';
import { CFOInitiateAdvanceDialog } from '@/components/cfo/CFOInitiateAdvanceDialog';
import { RecordAdvancePaymentDialog } from '@/components/cfo/RecordAdvancePaymentDialog';
import { AdvancePaymentSearchDialog } from '@/components/cfo/AdvancePaymentSearchDialog';
import { CancelAdvanceDialog } from '@/components/cfo/CancelAdvanceDialog';
import { EditAdvanceTermsDialog } from '@/components/advances/EditAdvanceTermsDialog';
import { DailyRecoveryRateCard } from '@/components/cfo/DailyRecoveryRateCard';
import { differenceInDays } from 'date-fns';
import { toast } from 'sonner';

const RATE_OPTIONS = [
  { label: '33%', value: '0.33' },
  { label: '28%', value: '0.28' },
  { label: '25%', value: '0.25' },
  { label: '20%', value: '0.20' },
  { label: '15%', value: '0.15' },
];

function calculateAccessFee(amount: number, monthlyRate: number, durationDays: number): number {
  return Math.round(amount * (Math.pow(1 + monthlyRate, durationDays / 30) - 1));
}

export function CFOAdvancesManager() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<'all' | 'active' | 'completed' | 'overdue'>('all');
  const [issueOpen, setIssueOpen] = useState(false);
  const [renewOpen, setRenewOpen] = useState(false);
  const [renewAgentId, setRenewAgentId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // cancel_agent_advance requires a reason of at least 10 characters.
  const [cancelReason, setCancelReason] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportingPayments, setExportingPayments] = useState(false);
  const [paymentAdvance, setPaymentAdvance] = useState<any | null>(null);
  const [paymentSearchOpen, setPaymentSearchOpen] = useState(false);
  const [termsAdvance, setTermsAdvance] = useState<any | null>(null);
  const [cancelAdvance, setCancelAdvance] = useState<any | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [search, setSearch] = useState('');


  const handleExportPayments = async () => {
    if (filtered.length === 0) return;
    setExportingPayments(true);
    const toastId = toast.loading('Generating consolidated payments report...');
    try {
      const { filename, rowCount } = await exportConsolidatedPayments(filtered, filter);
      toast.success(`Downloaded ${filename} (${rowCount} payments)`, { id: toastId });
      await supabase.from('audit_logs').insert({
        user_id: user?.id,
        action_type: 'cfo_advance_payments_export',
        table_name: 'agent_advance_ledger',
        metadata: { advance_count: filtered.length, payment_count: rowCount, filter, filename },
      });
    } catch (e: any) {
      toast.error(e.message || 'Export failed', { id: toastId });
    } finally {
      setExportingPayments(false);
    }
  };

  const handleExportPdfs = async () => {
    if (filtered.length === 0) return;
    setExporting(true);
    const uniqueAgents = new Set(filtered.map((a: any) => a.agent_id)).size;
    const toastId = toast.loading(`Generating ${uniqueAgents} agent statement(s)...`);
    try {
      const { filename, agentCount } = await exportAdvanceStatements(filtered, (current, total) => {
        toast.loading(`Generating PDFs (${current}/${total})...`, { id: toastId });
      });
      toast.success(`Downloaded ${filename}`, { id: toastId });
      await supabase.from('audit_logs').insert({
        user_id: user?.id,
        action_type: 'cfo_advance_export',
        table_name: 'agent_advances',
        metadata: { agent_count: agentCount, advance_count: filtered.length, filter, filename },
      });
    } catch (e: any) {
      toast.error(e.message || 'Export failed', { id: toastId });
    } finally {
      setExporting(false);
    }
  };

  // Calculator state
  const [calcAmount, setCalcAmount] = useState('');
  const [calcDays, setCalcDays] = useState('30');
  const [calcRate, setCalcRate] = useState('0.33');

  const { data: advances = [], isLoading, refetch } = useQuery({
    queryKey: ['cfo-advances'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_advances')
        .select('*, profiles!agent_advances_agent_id_fkey(full_name, phone)')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
  });

  const filtered = useMemo(() => {
    let rows = advances;
    if (filter !== 'all') rows = rows.filter((a: any) => a.status === filter);
    const q = search.trim().toLowerCase();
    if (q) {
      rows = rows.filter((a: any) => {
        const name = (a.profiles?.full_name || '').toLowerCase();
        const phone = (a.profiles?.phone || '').toLowerCase();
        return name.includes(q) || phone.includes(q);
      });
    }
    return rows;
  }, [advances, filter, search]);

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

  useEffect(() => {
    setPage(1);
  }, [filter, pageSize, search]);



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



  const totalIssued = advances.reduce((s: number, a: any) => s + Number(a.principal), 0);
  const totalOutstanding = advances.filter((a: any) => a.status !== 'completed').reduce((s: number, a: any) => s + Number(a.outstanding_balance), 0);
  const totalAccruedInterest = advances.reduce((s: number, a: any) => s + Math.max(0, Number(a.outstanding_balance) - Number(a.principal)), 0);
  const overdueExposure = advances.filter((a: any) => a.status === 'overdue').reduce((s: number, a: any) => s + Number(a.outstanding_balance), 0);

  // Access Fee Receivables
  const totalAccessFees = advances.reduce((s: number, a: any) => s + Number(a.access_fee || 0), 0);
  const totalAccessFeeCollected = advances.reduce((s: number, a: any) => s + Number(a.access_fee_collected || 0), 0);
  const accessFeeReceivables = totalAccessFees - totalAccessFeeCollected;

  const calcFee = calcAmount ? calculateAccessFee(Number(calcAmount), Number(calcRate), Number(calcDays)) : 0;
  const calcTotal = Number(calcAmount || 0) + calcFee;

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filtered.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map((a: any) => a.id)));
    }
  };

  // Cancels the selected advances through cancel_agent_advance.
  //
  // This used to be `supabase.from('agent_advances').delete()`, which destroyed
  // the rows outright — no pre_cancel_outstanding, no ledger entry, and an audit
  // row written by a separate unguarded call that could fail on its own. It ran
  // once, on 2026-05-05, and that advance is unrecoverable.
  //
  // cancel_agent_advance locks the row, enforces the CFO/Manager gate, requires
  // a reason, preserves pre_cancel_outstanding and writes its audit row inside
  // the same transaction. It takes one advance at a time, so we loop and report
  // per-advance outcomes rather than failing the whole batch on one error.
  const handleCancelSelected = async () => {
    if (cancelReason.trim().length < 10) {
      toast.error('Please enter a reason (min 10 characters).');
      return;
    }

    setDeleting(true);
    try {
      const ids = Array.from(selectedIds);
      const failures: { id: string; message: string }[] = [];

      for (const id of ids) {
        const { error } = await supabase.rpc('cancel_agent_advance', {
          p_advance_id: id,
          p_recoup: false,
          p_reason: cancelReason.trim(),
        });
        if (error) failures.push({ id, message: error.message });
      }

      const succeeded = ids.length - failures.length;
      if (succeeded > 0) toast.success(`${succeeded} advance(s) cancelled`);
      if (failures.length > 0) {
        toast.error(
          `${failures.length} could not be cancelled: ${failures[0].message}`,
        );
      }

      if (succeeded > 0) {
        setSelectedIds(new Set());
        setCancelReason('');
        setDeleteDialogOpen(false);
      }
      refetch();
    } catch (e: any) {
      toast.error(e.message || 'Cancellation failed');
    } finally {
      setDeleting(false);
    }
  };

  const summaryCards = [
    { label: 'Total Issued', value: formatUGX(totalIssued), icon: DollarSign, cls: 'text-primary' },
    { label: 'Outstanding', value: formatUGX(totalOutstanding), icon: TrendingUp, cls: 'text-amber-600' },
    { label: 'Accrued Interest', value: formatUGX(totalAccruedInterest), icon: Percent, cls: 'text-purple-600' },
    { label: 'Overdue Exposure', value: formatUGX(overdueExposure), icon: AlertTriangle, cls: 'text-destructive' },
    { label: 'Fee Receivables', value: formatUGX(accessFeeReceivables), icon: Receipt, cls: 'text-blue-600' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Advance Repayments</h1>
          <p className="text-sm text-muted-foreground">Track repayment progress on disbursed advances, record payments and export repayment reports.</p>
        </div>
        <div className="flex gap-2">
          <Button
            onClick={handleExportPdfs}
            size="sm"
            variant="outline"
            className="gap-1"
            disabled={exporting || filtered.length === 0}
          >
            <Download className="h-4 w-4" /> {exporting ? 'Exporting...' : 'Export PDFs'}
          </Button>
          <Button
            onClick={handleExportPayments}
            size="sm"
            variant="outline"
            className="gap-1"
            disabled={exportingPayments || filtered.length === 0}
          >
            <FileText className="h-4 w-4" /> {exportingPayments ? 'Exporting...' : 'Export All Payments'}
          </Button>
          <Button
            onClick={() => setPaymentSearchOpen(true)}
            size="sm"
            variant="secondary"
            className="gap-1"
          >
            <Receipt className="h-4 w-4" /> Record Payment
          </Button>
          <Button onClick={() => setIssueOpen(true)} size="sm" className="gap-1">
            <Plus className="h-4 w-4" /> Issue Advance
          </Button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {summaryCards.map((card) => (
          <Card key={card.label} className="border-border/50">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-1">
                <card.icon className={`h-4 w-4 ${card.cls}`} />
                <span className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider">{card.label}</span>
              </div>
              <p className="text-lg font-black tracking-tight">{card.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Access Fee Calculator */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Calculator className="h-4 w-4" /> Access Fee Calculator
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 items-end">
            <div>
              <Label className="text-xs">Amount (UGX)</Label>
              <Input type="number" placeholder="e.g. 500000" value={calcAmount} onChange={(e) => setCalcAmount(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">Duration (days)</Label>
              <Input type="number" placeholder="30" value={calcDays} onChange={(e) => setCalcDays(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">Monthly Rate</Label>
              <Select value={calcRate} onValueChange={setCalcRate}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {RATE_OPTIONS.map((r) => (
                    <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Access Fee</Label>
              <p className="text-lg font-bold text-amber-600">{formatUGX(calcFee)}</p>
            </div>
            <div>
              <Label className="text-xs">Total Payable</Label>
              <p className="text-lg font-bold">{formatUGX(calcTotal)}</p>
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground mt-2">
            Formula: accessFee = amount × ((1 + monthlyRate)^(days / 30) − 1)
          </p>
        </CardContent>
      </Card>

      {/* Daily Recovery Rate (CFO-adjustable) */}
      <DailyRecoveryRateCard />

      {/* Filters */}
      <Tabs value={filter} onValueChange={(v) => { setFilter(v as any); setSelectedIds(new Set()); }}>
        <TabsList>
          <TabsTrigger value="all">All ({advances.length})</TabsTrigger>
          <TabsTrigger value="active">Active ({advances.filter((a: any) => a.status === 'active').length})</TabsTrigger>
          <TabsTrigger value="completed">Completed ({advances.filter((a: any) => a.status === 'completed').length})</TabsTrigger>
          <TabsTrigger value="overdue">Overdue ({advances.filter((a: any) => a.status === 'overdue').length})</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Sticky Selection Action Bar */}
      {selectedIds.size > 0 && (
        <div className="sticky top-0 z-10 flex items-center gap-2 rounded-lg border bg-card p-3 shadow-sm">
          <span className="text-sm font-medium text-muted-foreground">{selectedIds.size} selected</span>
          <div className="ml-auto flex gap-2">
            {filter === 'completed' && (
              <Button
                size="sm"
                variant="soft"
                className="gap-1"
                onClick={() => {
                  const firstId = Array.from(selectedIds)[0];
                  const adv = advances.find((a: any) => a.id === firstId);
                  if (adv) {
                    setRenewAgentId(adv.agent_id);
                    setRenewOpen(true);
                  }
                }}
              >
                <RefreshCw className="h-4 w-4" /> Renew ({selectedIds.size})
              </Button>
            )}
            <Button variant="destructive" size="sm" className="gap-1" onClick={() => setDeleteDialogOpen(true)}>
              <Trash2 className="h-4 w-4" /> Delete ({selectedIds.size})
            </Button>
          </div>
        </div>
      )}

      {/* Table */}
      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground">Loading advances...</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">No advances found</div>
      ) : (
        <div className="rounded-md border">
          <Table>
           <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={filtered.length > 0 && selectedIds.size === filtered.length}
                    onCheckedChange={toggleSelectAll}
                  />
                </TableHead>
                <TableHead>Recipient</TableHead>
                <TableHead>Principal</TableHead>
                <TableHead className="hidden sm:table-cell">Interest</TableHead>
                <TableHead>Outstanding</TableHead>
                <TableHead className="hidden md:table-cell">Access Fee</TableHead>
                <TableHead className="hidden md:table-cell">Fee Collected</TableHead>
                <TableHead className="hidden lg:table-cell">Fee Status</TableHead>
                <TableHead className="hidden lg:table-cell">Issued</TableHead>
                <TableHead>Days Left</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Risk</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paginated.map((adv: any) => {
                const risk = getRiskLevel(adv);
                const daysLeft = Math.max(0, differenceInDays(new Date(adv.expires_at), new Date()));
                const interest = Math.max(0, Number(adv.outstanding_balance) - Number(adv.principal));
                const advFee = Number(adv.access_fee || 0);
                const advFeeCollected = Number(adv.access_fee_collected || 0);
                const feeStatus = adv.access_fee_status || 'unpaid';

                return (
                  <TableRow
                    key={adv.id}
                    className={`cursor-pointer ${selectedIds.has(adv.id) ? 'bg-primary/5' : ''}`}
                  >
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selectedIds.has(adv.id)}
                        onCheckedChange={() => toggleSelect(adv.id)}
                      />
                    </TableCell>
                    <TableCell className="font-medium" onClick={() => navigate(`/agent-advances/${adv.id}`)}>{adv.profiles?.full_name || 'Unknown'}</TableCell>
                    <TableCell onClick={() => navigate(`/agent-advances/${adv.id}`)}>{formatUGX(adv.principal)}</TableCell>
                    <TableCell className="hidden sm:table-cell text-amber-600" onClick={() => navigate(`/agent-advances/${adv.id}`)}>{formatUGX(interest)}</TableCell>
                    <TableCell className="font-semibold" onClick={() => navigate(`/agent-advances/${adv.id}`)}>{formatUGX(adv.outstanding_balance)}</TableCell>
                    <TableCell className="hidden md:table-cell" onClick={() => navigate(`/agent-advances/${adv.id}`)}>{formatUGX(advFee)}</TableCell>
                    <TableCell className="hidden md:table-cell" onClick={() => navigate(`/agent-advances/${adv.id}`)}>{formatUGX(advFeeCollected)}</TableCell>
                    <TableCell className="hidden lg:table-cell" onClick={() => navigate(`/agent-advances/${adv.id}`)}>
                      <Badge variant="outline" className={
                        feeStatus === 'settled' ? 'border-emerald-500/30 text-emerald-600' :
                        feeStatus === 'partial' ? 'border-amber-500/30 text-amber-600' :
                        'border-destructive/30 text-destructive'
                      }>
                        {feeStatus}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-muted-foreground" onClick={() => navigate(`/agent-advances/${adv.id}`)}>
                      {new Date(adv.issued_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell onClick={() => navigate(`/agent-advances/${adv.id}`)}>{daysLeft}d</TableCell>
                    <TableCell onClick={() => navigate(`/agent-advances/${adv.id}`)}>
                      <Badge variant={adv.status === 'active' ? 'default' : adv.status === 'completed' ? 'secondary' : 'destructive'}>
                        {adv.status}
                      </Badge>
                    </TableCell>
                    <TableCell onClick={() => navigate(`/agent-advances/${adv.id}`)}>
                      <div className={`h-3 w-3 rounded-full ${risk === 'green' ? 'bg-green-500' : risk === 'yellow' ? 'bg-amber-500' : 'bg-red-500'}`} />
                    </TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      {(adv.status === 'active' || adv.status === 'overdue') && (
                        <div className="flex flex-col sm:flex-row gap-1 justify-end">
                          <Button
                            size="sm"
                            variant="soft"
                            className="gap-1"
                            onClick={() => setPaymentAdvance(adv)}
                          >
                            <Receipt className="h-3.5 w-3.5" /> Record Payment
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-1"
                            onClick={() => setTermsAdvance(adv)}
                          >
                            <Pencil className="h-3.5 w-3.5" /> Edit terms
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-1 text-destructive border-destructive/30 hover:bg-destructive/10"
                            onClick={() => setCancelAdvance(adv)}
                          >
                            <Ban className="h-3.5 w-3.5" /> Cancel
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {/* Pagination */}
          {filtered.length > 0 && (
            <div className="flex items-center justify-between px-4 py-3 border-t">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span>Rows per page:</span>
                <Select
                  value={String(pageSize)}
                  onValueChange={(v) => { setPageSize(Number(v)); setPage(1); }}
                >
                  <SelectTrigger className="h-8 w-[70px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[10, 25, 50, 100].map((size) => (
                      <SelectItem key={size} value={String(size)}>{size}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="hidden sm:inline">
                  {startIndex + 1}-{endIndex} of {filtered.length}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={safePage <= 1}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                {pageNumbers.map((p, idx) => (
                  p === '...' ? (
                    <span key={`ellipsis-${idx}`} className="px-2 text-muted-foreground">...</span>
                  ) : (
                    <Button
                      key={p}
                      variant={safePage === p ? 'default' : 'outline'}
                      size="sm"
                      className="h-8 w-8 px-0"
                      onClick={() => setPage(Number(p))}
                    >
                      {p}
                    </Button>
                  )
                ))}
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

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel {selectedIds.size} advance(s)?</AlertDialogTitle>
            <AlertDialogDescription>
              Each advance is cancelled as a write-off: the outstanding balance is set to zero
              and the pre-cancellation balance is retained on the record. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="bulk-cancel-reason" className="text-xs">
              Reason (min 10 characters)
            </Label>
            <Input
              id="bulk-cancel-reason"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="Why are these advances being cancelled?"
              disabled={deleting}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Back</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleCancelSelected}
              disabled={deleting || cancelReason.trim().length < 10}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? 'Cancelling...' : 'Cancel advances'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <CFOInitiateAdvanceDialog open={issueOpen} onOpenChange={setIssueOpen} onSuccess={refetch} />
      <IssueAdvanceSheet
        open={renewOpen}
        onOpenChange={(open) => { setRenewOpen(open); if (!open) setRenewAgentId(null); }}
        onSuccess={() => { refetch(); setSelectedIds(new Set()); }}
        preselectedAgentId={renewAgentId || undefined}
      />

      <RecordAdvancePaymentDialog
        advance={paymentAdvance}
        open={!!paymentAdvance}
        onOpenChange={(o) => { if (!o) setPaymentAdvance(null); }}
        onSuccess={() => { refetch(); setPaymentAdvance(null); }}
      />

      <AdvancePaymentSearchDialog
        open={paymentSearchOpen}
        onOpenChange={setPaymentSearchOpen}
        advances={advances}
        onSelect={(a) => setPaymentAdvance(a)}
      />

      <CancelAdvanceDialog
        advance={cancelAdvance}
        open={!!cancelAdvance}
        onOpenChange={(o) => { if (!o) setCancelAdvance(null); }}
        onSuccess={() => { refetch(); setCancelAdvance(null); }}
      />

      <EditAdvanceTermsDialog
        advance={termsAdvance ? { ...termsAdvance, agent_name: termsAdvance.profiles?.full_name } : null}
        open={!!termsAdvance}
        onOpenChange={(o) => { if (!o) setTermsAdvance(null); }}
        onSaved={() => { refetch(); setTermsAdvance(null); }}
      />
    </div>
  );
}
