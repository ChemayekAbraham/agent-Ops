import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Plus, TrendingUp, AlertTriangle, DollarSign, Shield, Percent, Calculator, Receipt, RefreshCw, Download, FileText, Ban, Pencil, ChevronLeft, ChevronRight, Search, X, MoreHorizontal } from 'lucide-react';
import { exportAdvanceStatements, exportConsolidatedPayments } from '@/lib/agentAdvancePdfExport';
import { downloadAdvancesExcel, downloadAdvancesPdf } from '@/lib/advancesListExport';
import { FileSpreadsheet } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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
import { SpecialAdvanceModal } from '@/components/cfo/SpecialAdvanceModal';
import { RecordAdvancePaymentDialog } from '@/components/cfo/RecordAdvancePaymentDialog';
import { AdvancePaymentSearchDialog } from '@/components/cfo/AdvancePaymentSearchDialog';
import { CancelAdvanceDialog } from '@/components/cfo/CancelAdvanceDialog';
import { EditAdvanceTermsDialog } from '@/components/advances/EditAdvanceTermsDialog';
import { DailyRecoveryRateCard } from '@/components/cfo/DailyRecoveryRateCard';
import { AdvanceWalletReconciliationDialog } from '@/components/cfo/AdvanceWalletReconciliationDialog';
import { useAdvanceReconciliationSummary } from '@/hooks/useAdvanceWalletReconciliation';
import { AdvanceWriteOffApprovals } from '@/components/cfo/AdvanceWriteOffApprovals';
import { AdvanceExceptionsPanel } from '@/components/cfo/AdvanceExceptionsPanel';
import { advanceControlCode, advanceControlMessage } from '@/lib/advanceControls';
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
  const [specialOpen, setSpecialOpen] = useState(false);
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
  const [reconAdvanceId, setReconAdvanceId] = useState<string | null>(null);
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
  const { data: reconByAdvance } = useAdvanceReconciliationSummary(paginated.map((a: any) => a.id));

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
      const owed = failures.filter((f) => advanceControlCode(f.message) === 'needs_destination').length;
      if (owed > 0) {
        toast.error(`${owed} still have a balance owed. Close each one with Transfer, keep for recoup, or an approved write-off.`);
      }
      const other = failures.filter((f) => advanceControlCode(f.message) !== 'needs_destination');
      if (other.length > 0) {
        toast.error(`${other.length} could not be cancelled: ${advanceControlMessage(other[0].message)}`);
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
    {
      label: 'Total Issued',
      sub: `${advances.length} total advances`,
      value: formatUGX(totalIssued),
      icon: DollarSign,
      cls: 'text-primary',
      iconBg: 'bg-primary/10 text-primary ring-primary/20',
      accent: 'from-primary/80 via-primary/40 to-transparent',
    },
    {
      label: 'Outstanding',
      sub: `${advances.filter((a: any) => a.status !== 'completed').length} open balances`,
      value: formatUGX(totalOutstanding),
      icon: TrendingUp,
      cls: 'text-amber-600 dark:text-amber-400',
      iconBg: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 ring-amber-500/20',
      accent: 'from-amber-500/80 via-amber-500/40 to-transparent',
    },
    {
      label: 'Accrued Access Charges',
      sub: 'Above principal',
      value: formatUGX(totalAccruedInterest),
      icon: Percent,
      cls: 'text-violet-600 dark:text-violet-400',
      iconBg: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 ring-violet-500/20',
      accent: 'from-violet-500/80 via-violet-500/40 to-transparent',
    },
    {
      label: 'Overdue Exposure',
      sub: `${advances.filter((a: any) => a.status === 'overdue').length} past maturity`,
      value: formatUGX(overdueExposure),
      icon: AlertTriangle,
      cls: 'text-destructive',
      iconBg: 'bg-destructive/10 text-destructive ring-destructive/20',
      accent: 'from-destructive/80 via-destructive/40 to-transparent',
    },
    {
      label: 'Fee Receivables',
      sub: `Collected ${formatUGX(totalAccessFeeCollected)}`,
      value: formatUGX(accessFeeReceivables),
      icon: Receipt,
      cls: 'text-sky-600 dark:text-sky-400',
      iconBg: 'bg-sky-500/10 text-sky-600 dark:text-sky-400 ring-sky-500/20',
      accent: 'from-sky-500/80 via-sky-500/40 to-transparent',
    },
  ];

  return (
    <div className="space-y-6">
      {/* Executive Command Header */}
      <div className="rounded-2xl border border-border/80 bg-gradient-to-br from-card via-card to-muted/25 p-5 sm:p-6 shadow-2xs">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="flex h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-[11px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                Advances &amp; Recovery Command
              </span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground">Advance Repayments</h1>
            <p className="text-xs sm:text-sm text-muted-foreground max-w-2xl">
              Track repayment progress on disbursed advances, verify wallet reconciliation, record manual recoveries, and export audit-ready statements.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" className="h-9 rounded-lg gap-1.5 text-xs font-medium border-border/80 bg-background/70" disabled={filtered.length === 0}>
                  <Download className="h-3.5 w-3.5 text-muted-foreground" /> Download List
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onClick={() => downloadAdvancesPdf(filtered, filter).catch((e) => toast.error(e.message || 'Download failed'))}>
                  <FileText className="h-4 w-4 mr-2 text-rose-500" /> Download PDF
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => downloadAdvancesExcel(filtered, filter).catch((e) => toast.error(e.message || 'Download failed'))}>
                  <FileSpreadsheet className="h-4 w-4 mr-2 text-emerald-600" /> Download Excel
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              onClick={handleExportPdfs}
              size="sm"
              variant="outline"
              className="h-9 rounded-lg gap-1.5 text-xs font-medium border-border/80 bg-background/70"
              disabled={exporting || filtered.length === 0}
            >
              <Download className="h-3.5 w-3.5 text-muted-foreground" /> {exporting ? 'Exporting...' : 'Export PDFs'}
            </Button>

            <Button
              onClick={handleExportPayments}
              size="sm"
              variant="outline"
              className="h-9 rounded-lg gap-1.5 text-xs font-medium border-border/80 bg-background/70"
              disabled={exportingPayments || filtered.length === 0}
            >
              <FileText className="h-3.5 w-3.5 text-muted-foreground" /> {exportingPayments ? 'Exporting...' : 'Export All Payments'}
            </Button>

            <div className="hidden sm:block h-5 w-px bg-border/70 mx-0.5" />

            <Button
              onClick={() => setPaymentSearchOpen(true)}
              size="sm"
              variant="secondary"
              className="h-9 rounded-lg gap-1.5 text-xs font-semibold shadow-2xs"
            >
              <Receipt className="h-3.5 w-3.5" /> Record Payment
            </Button>

            <Button
              id="open-special-advance"
              onClick={() => setSpecialOpen(true)}
              size="sm"
              variant="outline"
              className="h-9 rounded-lg gap-1.5 text-xs font-semibold border-primary/30 text-primary hover:bg-primary/5"
            >
              <Calculator className="h-3.5 w-3.5" /> Special Advance
            </Button>

            <Button onClick={() => setIssueOpen(true)} size="sm" className="h-9 rounded-lg gap-1.5 text-xs font-semibold shadow-2xs">
              <Plus className="h-3.5 w-3.5" /> Issue Advance
            </Button>
          </div>
        </div>
      </div>

      {/* KPI Summary Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3.5">
        {summaryCards.map((card) => (
          <Card key={card.label} className="relative overflow-hidden rounded-xl border-border/80 bg-card shadow-2xs transition-all hover:shadow-md hover:border-border">
            <div className={` inset-x-0 top-0 h-1 bg-gradient-to-r ${card.accent}`} />
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-2 mb-2.5">
                <span className="text-[11px] uppercase font-semibold text-muted-foreground tracking-wider leading-tight">
                  {card.label}
                </span>
                <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ring-1 ${card.iconBg}`}>
                  <card.icon className="h-3.5 w-3.5" />
                </span>
              </div>
              <p className="text-lg sm:text-xl font-bold tracking-tight tabular-nums text-foreground truncate">
                {card.value}
              </p>
              <p className="text-[11px] text-muted-foreground mt-1 truncate">{card.sub}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Pricing & Recovery Policy Controls */}
      <div className="grid gap-4 lg:grid-cols-12">
        {/* Access Fee Calculator */}
        <Card className="lg:col-span-7 rounded-xl border-border/80 shadow-2xs">
          <CardHeader className="pb-3 border-b border-border/50">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Calculator className="h-3.5 w-3.5" />
                </span>
                <div>
                  <CardTitle className="text-sm font-semibold">Access Fee Calculator</CardTitle>
                  <p className="text-[11px] text-muted-foreground">
                    Compound fee preview: <code className="text-[10px] bg-muted px-1 py-0.5 rounded">amount × ((1 + monthlyRate)^(days / 30) − 1)</code>
                  </p>
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground">Amount (UGX)</Label>
                <Input
                  type="number"
                  placeholder="e.g. 500000"
                  value={calcAmount}
                  onChange={(e) => setCalcAmount(e.target.value)}
                  className="h-9 text-sm tabular-nums"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground">Duration (days)</Label>
                <Input
                  type="number"
                  placeholder="30"
                  value={calcDays}
                  onChange={(e) => setCalcDays(e.target.value)}
                  className="h-9 text-sm tabular-nums"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground">Monthly Rate</Label>
                <Select value={calcRate} onValueChange={setCalcRate}>
                  <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {RATE_OPTIONS.map((r) => (
                      <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="mt-3.5 grid grid-cols-2 gap-3 rounded-lg border border-border/60 bg-muted/30 p-3">
              <div>
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Estimated Access Fee</span>
                <p className="text-base sm:text-lg font-bold tabular-nums text-amber-600 dark:text-amber-400 mt-0.5">
                  {formatUGX(calcFee)}
                </p>
              </div>
              <div className="border-l border-border/60 pl-3">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Total Payable</span>
                <p className="text-base sm:text-lg font-bold tabular-nums text-foreground mt-0.5">
                  {formatUGX(calcTotal)}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Daily Recovery Rate (CFO-adjustable) */}
        <div className="lg:col-span-5 flex">
          <DailyRecoveryRateCard />
        </div>
      </div>

      {/* Write-off approvals (second person) and reconciliation exceptions */}
      <div className="grid gap-4 lg:grid-cols-2">
        <AdvanceWriteOffApprovals />
        <AdvanceExceptionsPanel />
      </div>

      {/* Main Advances Register Card */}
      <Card className="rounded-xl border-border/80 shadow-2xs overflow-hidden">
        {/* Filter & Search Toolbar */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 border-b border-border/60 bg-muted/15">
          <Tabs value={filter} onValueChange={(v) => { setFilter(v as any); setSelectedIds(new Set()); }}>
            <TabsList className="h-9 bg-muted/70 p-1">
              <TabsTrigger value="all" className="text-xs px-3">All ({advances.length})</TabsTrigger>
              <TabsTrigger value="active" className="text-xs px-3">Active ({advances.filter((a: any) => a.status === 'active').length})</TabsTrigger>
              <TabsTrigger value="completed" className="text-xs px-3">Completed ({advances.filter((a: any) => a.status === 'completed').length})</TabsTrigger>
              <TabsTrigger value="overdue" className="text-xs px-3">Overdue ({advances.filter((a: any) => a.status === 'overdue').length})</TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="relative w-full sm:w-72">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search agent by name or phone..."
              className="h-9 pl-9 pr-8 text-xs bg-background"
              aria-label="Search advances by agent name or phone"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Sticky Selection Action Bar */}
        {selectedIds.size > 0 && (
          <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-primary/20 bg-primary/5 px-4 py-2.5 backdrop-blur-xs">
            <Badge variant="secondary" className="font-semibold text-xs">
              {selectedIds.size} selected
            </Badge>
            <div className="ml-auto flex items-center gap-2">
              {filter === 'completed' && (
                <Button
                  size="sm"
                  variant="soft"
                  className="h-8 gap-1.5 text-xs"
                  onClick={() => {
                    const firstId = Array.from(selectedIds)[0];
                    const adv = advances.find((a: any) => a.id === firstId);
                    if (adv) {
                      setRenewAgentId(adv.agent_id);
                      setRenewOpen(true);
                    }
                  }}
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Renew ({selectedIds.size})
                </Button>
              )}
              <Button
                variant="destructive"
                size="sm"
                className="h-8 gap-1.5 text-xs"
                onClick={() => {
                  if (selectedIds.size === 1) {
                    const onlyId = Array.from(selectedIds)[0];
                    const adv = advances.find((a: any) => a.id === onlyId);
                    if (adv && Number(adv.outstanding_balance) > 0) {
                      setCancelAdvance(adv);
                      return;
                    }
                  }
                  setDeleteDialogOpen(true);
                }}
              >
                <Ban className="h-3.5 w-3.5" /> Cancel / Close selected ({selectedIds.size})
              </Button>
            </div>
          </div>
        )}

        {/* Table */}
        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
            <RefreshCw className="h-5 w-5 animate-spin text-primary" />
            <span className="text-xs font-medium">Loading advances...</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 px-4">
            <p className="text-sm font-semibold text-foreground">No advances found</p>
            <p className="text-xs text-muted-foreground mt-1">
              Try adjusting your status filter or search query.
            </p>
          </div>
        ) : (
          <div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/30 hover:bg-muted/30">
                    <TableHead className="w-10">
                      <Checkbox
                        checked={filtered.length > 0 && selectedIds.size === filtered.length}
                        onCheckedChange={toggleSelectAll}
                      />
                    </TableHead>
                    <TableHead className="text-[11px] font-semibold uppercase tracking-wider">Recipient</TableHead>
                    <TableHead className="text-[11px] font-semibold uppercase tracking-wider text-right">Principal</TableHead>
                    <TableHead className="hidden sm:table-cell text-[11px] font-semibold uppercase tracking-wider text-right">Accrued</TableHead>
                    <TableHead className="text-[11px] font-semibold uppercase tracking-wider text-right">Outstanding</TableHead>
                    <TableHead className="hidden md:table-cell text-[11px] font-semibold uppercase tracking-wider text-right">Access Fee</TableHead>
                    <TableHead className="hidden md:table-cell text-[11px] font-semibold uppercase tracking-wider text-right">Fee Collected</TableHead>
                    <TableHead className="hidden lg:table-cell text-[11px] font-semibold uppercase tracking-wider">Fee Status</TableHead>
                    <TableHead className="hidden lg:table-cell text-[11px] font-semibold uppercase tracking-wider">Issued</TableHead>
                    <TableHead className="text-[11px] font-semibold uppercase tracking-wider">Maturity</TableHead>
                    <TableHead className="text-[11px] font-semibold uppercase tracking-wider">Status</TableHead>
                    <TableHead className="text-[11px] font-semibold uppercase tracking-wider text-center">Risk</TableHead>
                    <TableHead className="text-[11px] font-semibold uppercase tracking-wider text-right">Actions</TableHead>
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
                    const principalNum = Number(adv.principal) || 0;
                    const repaidPct = principalNum > 0
                      ? Math.min(100, Math.max(0, Math.round(((principalNum - Number(adv.outstanding_balance)) / principalNum) * 100)))
                      : 0;
                    const recon = reconByAdvance?.get(adv.id);

                    return (
                      <TableRow
                        key={adv.id}
                        className={`cursor-pointer transition-colors hover:bg-muted/40 ${selectedIds.has(adv.id) ? 'bg-primary/5' : ''}`}
                      >
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            checked={selectedIds.has(adv.id)}
                            onCheckedChange={() => toggleSelect(adv.id)}
                          />
                        </TableCell>
                        <TableCell onClick={() => navigate(`/agent-advances/${adv.id}`)}>
                          <div className="min-w-[130px]">
                            <p className="text-sm font-semibold text-foreground leading-tight">
                              {adv.profiles?.full_name || 'Unknown'}
                            </p>
                            {adv.profiles?.phone && (
                              <p className="text-[11px] text-muted-foreground tabular-nums mt-0.5">
                                {adv.profiles.phone}
                              </p>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-xs sm:text-sm font-medium" onClick={() => navigate(`/agent-advances/${adv.id}`)}>
                          {formatUGX(adv.principal)}
                        </TableCell>
                        <TableCell className="hidden sm:table-cell text-right tabular-nums text-xs text-amber-600 dark:text-amber-400 font-medium" onClick={() => navigate(`/agent-advances/${adv.id}`)}>
                          {formatUGX(interest)}
                        </TableCell>
                        <TableCell className="text-right" onClick={() => navigate(`/agent-advances/${adv.id}`)}>
                          <div className="inline-flex flex-col items-end min-w-[110px]">
                            <span className="text-xs sm:text-sm font-bold tabular-nums text-foreground">
                              {formatUGX(adv.outstanding_balance)}
                            </span>
                            <div className="mt-1 flex items-center gap-1.5 w-full max-w-[100px]">
                              <div className="h-1 flex-1 rounded-full bg-muted overflow-hidden">
                                <div
                                  className={`h-full rounded-full ${adv.status === 'overdue' ? 'bg-rose-500' : 'bg-emerald-500'}`}
                                  style={{ width: `${repaidPct}%` }}
                                />
                              </div>
                              <span className="text-[10px] text-muted-foreground tabular-nums">{repaidPct}%</span>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-right tabular-nums text-xs text-muted-foreground" onClick={() => navigate(`/agent-advances/${adv.id}`)}>
                          {formatUGX(advFee)}
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-right tabular-nums text-xs text-muted-foreground" onClick={() => navigate(`/agent-advances/${adv.id}`)}>
                          {formatUGX(advFeeCollected)}
                        </TableCell>
                        <TableCell className="hidden lg:table-cell" onClick={() => navigate(`/agent-advances/${adv.id}`)}>
                          <Badge variant="outline" className={`text-[10px] capitalize font-semibold ${
                            feeStatus === 'settled' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' :
                            feeStatus === 'partial' ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400' :
                            'border-destructive/30 bg-destructive/10 text-destructive'
                          }`}>
                            {feeStatus}
                          </Badge>
                        </TableCell>
                        <TableCell className="hidden lg:table-cell text-xs text-muted-foreground tabular-nums whitespace-nowrap" onClick={() => navigate(`/agent-advances/${adv.id}`)}>
                          {new Date(adv.issued_at).toLocaleDateString()}
                        </TableCell>
                        <TableCell className="text-xs font-medium tabular-nums whitespace-nowrap" onClick={() => navigate(`/agent-advances/${adv.id}`)}>
                          <span className={daysLeft === 0 && adv.status !== 'completed' ? 'text-destructive font-semibold' : 'text-muted-foreground'}>
                            {daysLeft}d
                          </span>
                        </TableCell>
                        <TableCell onClick={() => navigate(`/agent-advances/${adv.id}`)}>
                          <Badge
                            variant={adv.status === 'active' ? 'default' : adv.status === 'completed' ? 'secondary' : 'destructive'}
                            className="text-[10px] capitalize font-semibold"
                          >
                            {adv.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-center" onClick={() => navigate(`/agent-advances/${adv.id}`)}>
                          <span
                            title={`Risk: ${risk}`}
                            className={`inline-block h-2.5 w-2.5 rounded-full ring-2 ${
                              risk === 'green'
                                ? 'bg-emerald-500 ring-emerald-500/20'
                                : risk === 'yellow'
                                  ? 'bg-amber-500 ring-amber-500/20'
                                  : 'bg-rose-500 ring-rose-500/20'
                            }`}
                          />
                        </TableCell>
                        <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                          <Popover>
                            <PopoverTrigger asChild>
                              <Button
                                variant="outline"
                                size="icon"
                                aria-label="Row actions"
                                className={`relative h-8 w-8 rounded-xl border-border/80 bg-background shadow-2xs hover:bg-muted/60 ${
                                  recon?.reconciled === false ? 'border-destructive/50 text-destructive' : ''
                                }`}
                              >
                                <MoreHorizontal className="h-4 w-4" />
                                {recon?.reconciled === false && (
                                  <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-destructive ring-2 ring-background" />
                                )}
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent align="end" className="w-60 p-2 space-y-1.5">
                              <Button
                                size="sm"
                                variant="outline"
                                className={`w-full justify-start gap-2 ${
                                  reconByAdvance?.get(adv.id)?.reconciled === false
                                    ? 'text-destructive border-destructive/30'
                                    : ''
                                }`}
                                onClick={() => setReconAdvanceId(adv.id)}
                              >
                                <Shield className="h-3.5 w-3.5" />
                                {reconByAdvance?.get(adv.id)
                                  ? (reconByAdvance.get(adv.id)!.reconciled
                                    ? 'Wallet ✓'
                                    : `Wallet: ${reconByAdvance.get(adv.id)!.issue_count} issue${reconByAdvance.get(adv.id)!.issue_count === 1 ? '' : 's'}`)
                                  : 'Wallet check'}
                              </Button>
                              {(adv.status === 'active' || adv.status === 'overdue') && (
                                <div className="flex flex-col gap-1.5">
                                  <Button
                                    size="sm"
                                    variant="soft"
                                    className="w-full justify-start gap-2"
                                    onClick={() => setPaymentAdvance(adv)}
                                  >
                                    <Receipt className="h-3.5 w-3.5" /> Record Payment
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="w-full justify-start gap-2"
                                    onClick={() => setTermsAdvance(adv)}
                                  >
                                    <Pencil className="h-3.5 w-3.5" /> Edit terms
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="w-full justify-start gap-2 text-destructive border-destructive/30 hover:bg-destructive/10"
                                    onClick={() => setCancelAdvance(adv)}
                                  >
                                    <Ban className="h-3.5 w-3.5 shrink-0" /> Cancel / Transfer / Write-off
                                  </Button>
                                </div>
                              )}
                            </PopoverContent>
                          </Popover>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            {/* Pagination */}
            {filtered.length > 0 && (
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 py-3 border-t border-border/60 bg-muted/10">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>Rows per page:</span>
                  <Select
                    value={String(pageSize)}
                    onValueChange={(v) => { setPageSize(Number(v)); setPage(1); }}
                  >
                    <SelectTrigger className="h-8 w-[70px] text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[10, 25, 50, 100].map((size) => (
                        <SelectItem key={size} value={String(size)}>{size}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="hidden sm:inline tabular-nums">
                    Showing <strong className="text-foreground">{startIndex + 1}–{endIndex}</strong> of <strong className="text-foreground">{filtered.length}</strong>
                  </span>
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
                  {pageNumbers.map((p, idx) => (
                    p === '...' ? (
                      <span key={`ellipsis-${idx}`} className="px-2 text-xs text-muted-foreground">...</span>
                    ) : (
                      <Button
                        key={p}
                        variant={safePage === p ? 'default' : 'outline'}
                        size="sm"
                        className="h-8 w-8 px-0 text-xs tabular-nums"
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
      </Card>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel {selectedIds.size} advance(s)?</AlertDialogTitle>
            <AlertDialogDescription>
              Only advances with nothing owed, or with an approved write-off, are cancelled here.
              An advance that still has a balance must be closed on its own, by Transfer, keep for
              recoup, or an approved write-off. This cannot be undone.
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
      <SpecialAdvanceModal open={specialOpen} onOpenChange={setSpecialOpen} />
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

      <AdvanceWalletReconciliationDialog
        advanceId={reconAdvanceId}
        open={!!reconAdvanceId}
        onOpenChange={(o) => { if (!o) setReconAdvanceId(null); }}
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
