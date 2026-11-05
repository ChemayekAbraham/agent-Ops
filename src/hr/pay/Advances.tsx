import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Loader2, HandCoins, Plus, Search, X, CheckCircle2, Clock,
  AlertTriangle, Filter, Calendar, Users, Wallet, ArrowUpRight,
  Pencil, XCircle, Ban, Check, ChevronLeft, ChevronRight, RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';
import HRPlaceholderPage from '@/hr/pages/HRPlaceholderPage';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { listAdvances, requestAdvance, decideAdvance, cancelAdvance, updateAdvance, type AdvanceRow } from '@/hr/pay/api/advances';
import { listStaffForPayroll, type PayrollStaffOption } from '@/hr/pay/api/compensation';
import { myPayrollAuthority } from '@/hr/pay/api/workflow';

function formatAmount(value: number): string {
  return new Intl.NumberFormat('en-UG', { maximumFractionDigits: 0 }).format(value);
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function firstOfNextMonth(): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

const STATUS_BADGE: Record<string, { label: string; badgeCls: string }> = {
  requested: { label: 'Awaiting HR', badgeCls: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400' },
  hr_approved: { label: 'Awaiting CEO', badgeCls: 'border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-400' },
  ceo_approved: { label: 'Awaiting CFO', badgeCls: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400' },
  approved: { label: 'Active (Recovering)', badgeCls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' },
  settled: { label: 'Settled', badgeCls: 'border-border/80 bg-muted/60 text-muted-foreground' },
  rejected: { label: 'Rejected', badgeCls: 'border-destructive/30 bg-destructive/10 text-destructive' },
  cancelled: { label: 'Cancelled', badgeCls: 'border-border/80 bg-muted/60 text-muted-foreground' },
};

const ACTION_LABEL: Record<string, string> = {
  requested: 'HR Approve',
  hr_approved: 'CEO Approve',
  ceo_approved: 'Record Disbursement',
};

const DONE_LABEL: Record<string, string> = {
  requested: 'HR approval recorded.',
  hr_approved: 'CEO approval recorded.',
  ceo_approved: 'Disbursement recorded. No money was moved; recovery starts on next payroll.',
};

function isActionable(status: string): boolean {
  return status === 'requested' || status === 'hr_approved' || status === 'ceo_approved';
}

function EmbeddedShell({ heading, subtitle, children }: { heading: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-5">
      {children}
    </div>
  );
}

export function AdvancesPanel() {
  return <Advances embedded />;
}

export default function Advances({ embedded = false }: { embedded?: boolean } = {}) {
  const Shell = embedded ? EmbeddedShell : HRPlaceholderPage;
  const [rows, setRows] = useState<AdvanceRow[]>([]);
  const [staff, setStaff] = useState<PayrollStaffOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPreparer, setIsPreparer] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Search & Filter state
  const [search, setSearch] = useState('');
  const [filterTab, setFilterTab] = useState<'all' | 'actionable' | 'active' | 'settled'>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);

  // Request dialog
  const [open, setOpen] = useState(false);
  const [staffId, setStaffId] = useState('');
  const [principal, setPrincipal] = useState('');
  const [purpose, setPurpose] = useState('');
  const [months, setMonths] = useState('1');
  const [firstOn, setFirstOn] = useState(firstOfNextMonth());
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  // Reject dialog
  const [rejectRow, setRejectRow] = useState<AdvanceRow | null>(null);
  const [rejectNote, setRejectNote] = useState('');
  const [rejectError, setRejectError] = useState('');

  // Edit dialog
  const [editRow, setEditRow] = useState<AdvanceRow | null>(null);
  const [editPurpose, setEditPurpose] = useState('');
  const [editMonths, setEditMonths] = useState('1');
  const [editFirstOn, setEditFirstOn] = useState('');
  const [editError, setEditError] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  // Cancel dialog
  const [cancelRow, setCancelRow] = useState<AdvanceRow | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelError, setCancelError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [advances, authority] = await Promise.all([listAdvances(), myPayrollAuthority()]);
      setRows(advances);
      setIsPreparer(authority.preparer);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!isPreparer || staff.length > 0) return;
    listStaffForPayroll()
      .then(setStaff)
      .catch((err) => toast.error((err as Error).message));
  }, [isPreparer, staff.length]);

  const staffLabel = useMemo(() => {
    const map = new Map<string, string>();
    staff.forEach((s) => map.set(s.staffId, s.name));
    return map;
  }, [staff]);

  function resetForm() {
    setStaffId('');
    setPrincipal('');
    setPurpose('');
    setMonths('1');
    setFirstOn(firstOfNextMonth());
    setFormError('');
  }

  const requestMonthly = useMemo(() => {
    const amount = Number(principal);
    const m = Number(months);
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(m) || m < 1 || m > 3) {
      return null;
    }
    return Math.ceil(amount / m);
  }, [principal, months]);

  async function submitRequest() {
    const amount = Number(principal);
    const m = Number(months);
    if (!staffId) return setFormError('Choose the staff member.');
    if (!Number.isFinite(amount) || amount <= 0) return setFormError('Enter a principal above zero.');
    if (purpose.trim().length < 10) return setFormError('The purpose must be at least 10 characters.');
    if (!Number.isInteger(m) || m < 1 || m > 3) return setFormError('Choose the recovery period.');
    if (!firstOn) return setFormError('Choose the first recovery date.');
    setFormError('');
    setSaving(true);
    try {
      await requestAdvance(staffId, amount, purpose.trim(), 'fixed', Math.ceil(amount / m), firstOn, m);
      toast.success('Advance requested.');
      setOpen(false);
      resetForm();
      await load();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function approve(row: AdvanceRow) {
    setBusyId(row.id);
    try {
      await decideAdvance(row.id, true, '');
      toast.success(DONE_LABEL[row.status] ?? 'Approval recorded.');
      await load();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  const editMonthly = useMemo(() => {
    if (!editRow) return null;
    const m = Number(editMonths);
    if (!Number.isInteger(m) || m < 1 || m > 3) return null;
    return Math.ceil(editRow.principal / m);
  }, [editRow, editMonths]);

  async function submitEdit() {
    if (!editRow) return;
    const m = Number(editMonths);
    if (!Number.isInteger(m) || m < 1 || m > 3) return setEditError('Choose the recovery period.');
    if (editPurpose.trim().length === 0) return;
    setEditError('');
    setEditSaving(true);
    try {
      await updateAdvance(editRow.id, {
        purpose: editPurpose.trim(),
        recovery_months: m,
        first_recovery_on: editFirstOn,
      });
      toast.success('Advance updated.');
      setEditRow(null);
      await load();
    } catch (err) {
      setEditError((err as Error).message);
    } finally {
      setEditSaving(false);
    }
  }

  async function reject() {
    if (!rejectRow) return;
    if (rejectNote.trim().length < 10) {
      setRejectError('A note of at least 10 characters is required.');
      return;
    }
    setRejectError('');
    setBusyId(rejectRow.id);
    try {
      await decideAdvance(rejectRow.id, false, rejectNote.trim());
      toast.success('Advance rejected.');
      setRejectRow(null);
      setRejectNote('');
      await load();
    } catch (err) {
      setRejectError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function cancel() {
    if (!cancelRow) return;
    if (cancelReason.trim().length < 10) {
      setCancelError('A reason of at least 10 characters is required.');
      return;
    }
    setCancelError('');
    setBusyId(cancelRow.id);
    try {
      await cancelAdvance(cancelRow.id, cancelReason.trim());
      toast.success('Advance cancelled.');
      setCancelRow(null);
      setCancelReason('');
      await load();
    } catch (err) {
      setCancelError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  // Summary Metrics
  const summary = useMemo(() => {
    let principalTotal = 0;
    let recoveredTotal = 0;
    let outstandingTotal = 0;
    let awaitingApproval = 0;
    let activeRecovering = 0;

    rows.forEach((r) => {
      principalTotal += Number(r.principal || 0);
      recoveredTotal += Number(r.recovered || 0);
      outstandingTotal += Number(r.outstanding || 0);
      if (isActionable(r.status)) awaitingApproval++;
      if (r.status === 'approved') activeRecovering++;
    });

    return {
      principalTotal,
      recoveredTotal,
      outstandingTotal,
      awaitingApproval,
      activeRecovering,
      count: rows.length,
    };
  }, [rows]);

  // Filtering
  const filteredRows = useMemo(() => {
    let list = rows;
    if (filterTab === 'actionable') {
      list = list.filter((r) => isActionable(r.status));
    } else if (filterTab === 'active') {
      list = list.filter((r) => r.status === 'approved');
    } else if (filterTab === 'settled') {
      list = list.filter((r) => r.status === 'settled');
    }

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((r) => {
        const name = (r.staff_name ?? staffLabel.get(r.staff_id) ?? '').toLowerCase();
        const ref = (r.staff_ref ?? '').toLowerCase();
        const purposeText = (r.purpose ?? '').toLowerCase();
        return name.includes(q) || ref.includes(q) || purposeText.includes(q);
      });
    }

    return list;
  }, [rows, filterTab, search, staffLabel]);

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const startIndex = (safePage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, filteredRows.length);
  const paginatedRows = useMemo(() => filteredRows.slice(startIndex, endIndex), [filteredRows, startIndex, endIndex]);

  return (
    <Shell
      heading="Salary Advances"
      subtitle="Staff payroll advances: review workflow approvals, disbursement records, and payroll deduction recovery."
    >
      {/* Executive Command Header */}
      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-border/60 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <HandCoins className="h-4 w-4" />
            </span>
            <h1 className="text-xl lg:text-2xl font-bold tracking-tight text-foreground">
              Salary Advances
            </h1>
            <Badge variant="outline" className="text-[10px] font-semibold uppercase tracking-wider bg-muted/60 text-muted-foreground border-border/80">
              Payroll
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground max-w-2xl leading-relaxed">
            Multi-stage staff advances: HR &amp; CEO approvals, CFO payout tracking, and scheduled payroll deductions.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          {isPreparer && (
            <Button
              size="sm"
              onClick={() => setOpen(true)}
              className="h-8 gap-1.5 rounded-lg text-xs font-semibold shadow-2xs"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Request Advance</span>
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void load()}
            disabled={loading}
            className="h-8 gap-1.5 rounded-lg text-xs font-medium border-border/80 hover:bg-muted/80 shadow-2xs"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </Button>
        </div>
      </header>

      {/* KPI Metric Strip */}
      <section aria-label="Salary Advances summary" className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
        <div className="min-w-0 rounded-xl border border-border/80 bg-card p-4 shadow-2xs">
          <div className="mb-2 flex items-center justify-between gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">
              Outstanding Portfolio
            </span>
            <Wallet className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
          </div>
          <p className="text-base sm:text-lg font-bold tabular-nums tracking-tight text-foreground truncate">
            UGX {formatAmount(summary.outstandingTotal)}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground truncate">
            {summary.activeRecovering} active recovering
          </p>
        </div>

        <div className="min-w-0 rounded-xl border border-border/80 bg-card p-4 shadow-2xs">
          <div className="mb-2 flex items-center justify-between gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">
              Recovered So Far
            </span>
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
          </div>
          <p className="text-base sm:text-lg font-bold tabular-nums tracking-tight text-emerald-600 dark:text-emerald-400 truncate">
            UGX {formatAmount(summary.recoveredTotal)}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground truncate">
            Payroll automatic deductions
          </p>
        </div>

        <div className="min-w-0 rounded-xl border border-border/80 bg-card p-4 shadow-2xs">
          <div className="mb-2 flex items-center justify-between gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">
              Total Principal Issued
            </span>
            <Users className="h-3.5 w-3.5 text-primary shrink-0" />
          </div>
          <p className="text-base sm:text-lg font-bold tabular-nums tracking-tight text-foreground truncate">
            UGX {formatAmount(summary.principalTotal)}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground truncate">
            Across {summary.count} historical advances
          </p>
        </div>

        <div className="min-w-0 rounded-xl border border-border/80 bg-card p-4 shadow-2xs bg-amber-500/5 border-amber-500/20">
          <div className="mb-2 flex items-center justify-between gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400 truncate">
              Action Required
            </span>
            <Clock className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
          </div>
          <p className="text-base sm:text-lg font-bold tabular-nums tracking-tight text-foreground truncate">
            {summary.awaitingApproval} Requests
          </p>
          <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400 truncate">
            Awaiting stage decisions
          </p>
        </div>
      </section>

      {/* Main Advances Register Card */}
      <Card className="rounded-xl border border-border/80 bg-card shadow-2xs overflow-hidden">
        {/* Controls Toolbar */}
        <div className="p-3.5 sm:p-4 border-b border-border/60 bg-muted/15 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <Tabs value={filterTab} onValueChange={(v) => { setFilterTab(v as any); setPage(1); }}>
            <TabsList className="h-8 bg-muted/70 p-1">
              <TabsTrigger value="all" className="text-xs px-3">
                All ({rows.length})
              </TabsTrigger>
              <TabsTrigger value="actionable" className="text-xs px-3">
                Awaiting Decisions ({summary.awaitingApproval})
              </TabsTrigger>
              <TabsTrigger value="active" className="text-xs px-3">
                Active ({summary.activeRecovering})
              </TabsTrigger>
              <TabsTrigger value="settled" className="text-xs px-3">
                Settled ({rows.filter((r) => r.status === 'settled').length})
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-64">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                placeholder="Search staff, ref, or purpose…"
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                className="h-8 pl-8 pr-7 text-xs bg-background"
                aria-label="Search salary advances"
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

            <span className="text-[11px] text-muted-foreground tabular-nums whitespace-nowrap pl-1">
              Showing <strong className="text-foreground">{filteredRows.length}</strong> advances
            </span>
          </div>
        </div>

        {/* Content Table */}
        <CardContent className="p-0">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
              <span className="text-xs font-medium">Loading salary advances…</span>
            </div>
          ) : error ? (
            <div className="p-8 text-center text-xs text-destructive">
              Could not load advances: {error}
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="p-12 text-center text-xs text-muted-foreground">
              No salary advances found matching the current filter.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/30 hover:bg-muted/30 text-[11px] text-muted-foreground uppercase tracking-wider">
                    <TableHead className="py-2.5 px-4 font-semibold">Staff Member</TableHead>
                    <TableHead className="py-2.5 px-3 text-right font-semibold">Principal (UGX)</TableHead>
                    <TableHead className="py-2.5 px-3 font-semibold">Recovery Terms</TableHead>
                    <TableHead className="py-2.5 px-3 text-right font-semibold">Recovered</TableHead>
                    <TableHead className="py-2.5 px-3 text-right font-semibold">Outstanding</TableHead>
                    <TableHead className="py-2.5 px-3 text-center font-semibold">Status</TableHead>
                    <TableHead className="py-2.5 px-3 font-semibold">Timeline</TableHead>
                    <TableHead className="py-2.5 px-4 text-right font-semibold">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paginatedRows.map((row) => {
                    const statusObj = STATUS_BADGE[row.status] ?? {
                      label: row.status,
                      badgeCls: 'border-border/80 bg-muted/60 text-muted-foreground',
                    };
                    const name = row.staff_name ?? staffLabel.get(row.staff_id) ?? 'Unknown Staff';

                    return (
                      <TableRow key={row.id} className="hover:bg-muted/40 transition-colors">
                        <TableCell className="py-3 px-4">
                          <div className="flex flex-col min-w-[160px]">
                            <span className="font-semibold text-xs text-foreground leading-tight">
                              {name}
                            </span>
                            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground font-mono mt-0.5">
                              {row.staff_ref ?? 'No Ref'}
                            </div>
                            <p className="text-[11px] text-muted-foreground/90 line-clamp-1 mt-1 italic" title={row.purpose}>
                              &quot;{row.purpose}&quot;
                            </p>
                          </div>
                        </TableCell>

                        <TableCell className="py-3 px-3 text-right tabular-nums text-xs font-semibold whitespace-nowrap text-foreground">
                          {formatAmount(row.principal)}
                        </TableCell>

                        <TableCell className="py-3 px-3 whitespace-nowrap">
                          <div className="text-xs">
                            <span className="font-medium text-foreground tabular-nums">
                              {formatAmount(row.recovery_value)}
                            </span>
                            <span className="text-muted-foreground text-[11px]"> / mo</span>
                          </div>
                          <div className="text-[10px] text-muted-foreground mt-0.5">
                            {row.recovery_months ? `${row.recovery_months} cycle(s)` : '1 cycle'} · Starts {formatDate(row.first_recovery_on)}
                          </div>
                        </TableCell>

                        <TableCell className="py-3 px-3 text-right tabular-nums text-xs text-muted-foreground whitespace-nowrap">
                          {formatAmount(row.recovered)}
                        </TableCell>

                        <TableCell className="py-3 px-3 text-right tabular-nums text-xs font-bold whitespace-nowrap text-foreground">
                          {formatAmount(row.outstanding)}
                        </TableCell>

                        <TableCell className="py-3 px-3 text-center whitespace-nowrap">
                          <Badge variant="outline" className={`text-[10px] font-medium border ${statusObj.badgeCls}`}>
                            {statusObj.label}
                          </Badge>
                        </TableCell>

                        <TableCell className="py-3 px-3 whitespace-nowrap text-[11px] text-muted-foreground">
                          {row.disbursed_at ? (
                            <div>Disbursed: <span className="text-foreground font-medium">{formatDate(row.disbursed_at)}</span></div>
                          ) : row.approved_at ? (
                            <div>Approved: <span className="text-foreground font-medium">{formatDate(row.approved_at)}</span></div>
                          ) : row.hr_approved_at ? (
                            <div>HR OK: <span className="text-foreground font-medium">{formatDate(row.hr_approved_at)}</span></div>
                          ) : (
                            <div>Requested: <span className="text-foreground font-medium">{formatDate(row.requested_at)}</span></div>
                          )}
                        </TableCell>

                        <TableCell className="py-3 px-4 text-right whitespace-nowrap">
                          <div className="flex items-center justify-end gap-1.5">
                            {isPreparer && row.status === 'requested' && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs px-2"
                                disabled={busyId === row.id}
                                onClick={() => {
                                  setEditRow(row);
                                  setEditPurpose(row.purpose);
                                  setEditMonths(String(row.recovery_months ?? 1));
                                  setEditFirstOn(row.first_recovery_on);
                                  setEditError('');
                                }}
                              >
                                <Pencil className="h-3 w-3 mr-1" /> Edit
                              </Button>
                            )}

                            {isActionable(row.status) && (
                              <>
                                <Button
                                  size="sm"
                                  className="h-7 text-xs px-2.5 font-medium shadow-2xs"
                                  disabled={busyId === row.id}
                                  title={
                                    row.status === 'ceo_approved'
                                      ? 'Records that this advance has been disbursed. It moves no money.'
                                      : undefined
                                  }
                                  onClick={() => void approve(row)}
                                >
                                  {busyId === row.id ? (
                                    <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                  ) : (
                                    <Check className="h-3 w-3 mr-1" />
                                  )}
                                  {ACTION_LABEL[row.status] ?? 'Approve'}
                                </Button>

                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 text-xs px-2 text-destructive border-destructive/30 hover:bg-destructive/10"
                                  disabled={busyId === row.id}
                                  onClick={() => {
                                    setRejectRow(row);
                                    setRejectNote('');
                                    setRejectError('');
                                  }}
                                  title="Reject request"
                                >
                                  <XCircle className="h-3 w-3" />
                                </Button>

                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 text-xs px-2 text-muted-foreground hover:text-foreground"
                                  disabled={busyId === row.id}
                                  onClick={() => {
                                    setCancelRow(row);
                                    setCancelReason('');
                                    setCancelError('');
                                  }}
                                  title="Cancel advance"
                                >
                                  <Ban className="h-3 w-3" />
                                </Button>
                              </>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}

          {/* Pagination Footer */}
          {filteredRows.length > 0 && (
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 py-3 border-t border-border/60 bg-muted/10">
              <div className="text-xs text-muted-foreground tabular-nums">
                Showing <strong className="text-foreground">{startIndex + 1}–{endIndex}</strong> of <strong className="text-foreground">{filteredRows.length}</strong> advances
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
        </CardContent>
      </Card>

      {/* Request Advance Modal */}
      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : (setOpen(false), resetForm()))}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base font-bold">Request a Salary Advance</DialogTitle>
            <DialogDescription className="text-xs">
              Staff advance requests follow HR and CEO approval before disbursement authorization and automatic payroll recovery.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3.5 pt-1">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">Staff Member</Label>
              <Select value={staffId} onValueChange={setStaffId}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Choose staff member…" />
                </SelectTrigger>
                <SelectContent className="max-h-56">
                  {staff.map((s) => (
                    <SelectItem key={s.staffId} value={s.staffId} className="text-xs">
                      {s.name}
                      {s.department ? ` · ${s.department}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">Principal Amount (UGX)</Label>
              <Input
                inputMode="numeric"
                placeholder="e.g. 500000"
                value={principal}
                onChange={(e) => setPrincipal(e.target.value.replace(/\D/g, ''))}
                className="h-8 text-xs font-mono"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">Purpose / Reason</Label>
              <Textarea
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                placeholder="Specific reason (minimum 10 characters)"
                className="text-xs min-h-[64px]"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground">Recovery Term</Label>
                <Select value={months} onValueChange={setMonths}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Period" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1" className="text-xs">1 month</SelectItem>
                    <SelectItem value="2" className="text-xs">2 months</SelectItem>
                    <SelectItem value="3" className="text-xs">3 months</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground">First Deduction Date</Label>
                <Input
                  type="date"
                  value={firstOn}
                  onChange={(e) => setFirstOn(e.target.value)}
                  className="h-8 text-xs font-mono"
                />
              </div>
            </div>

            {requestMonthly !== null && (
              <div className="rounded-lg bg-muted/40 p-2.5 border border-border/60 flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Estimated Monthly Deduction:</span>
                <span className="font-bold tabular-nums text-foreground">
                  UGX {formatAmount(requestMonthly)} / month
                </span>
              </div>
            )}

            {formError && <p className="text-xs text-destructive font-medium">{formError}</p>}
          </div>

          <DialogFooter className="pt-2">
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => { setOpen(false); resetForm(); }}>
              Cancel
            </Button>
            <Button size="sm" className="h-8 text-xs font-semibold" onClick={submitRequest} disabled={saving}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
              Submit Request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Advance Modal */}
      <Dialog open={!!editRow} onOpenChange={(next) => (!next ? setEditRow(null) : null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base font-bold">Edit Salary Advance</DialogTitle>
            <DialogDescription className="text-xs">
              Update terms or repayment schedule prior to approval.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3.5 pt-1">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">Purpose</Label>
              <Textarea
                value={editPurpose}
                onChange={(e) => setEditPurpose(e.target.value)}
                className="text-xs min-h-[64px]"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground">Recovery Term</Label>
                <Select value={editMonths} onValueChange={setEditMonths}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1" className="text-xs">1 month</SelectItem>
                    <SelectItem value="2" className="text-xs">2 months</SelectItem>
                    <SelectItem value="3" className="text-xs">3 months</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground">First Deduction</Label>
                <Input
                  type="date"
                  value={editFirstOn}
                  onChange={(e) => setEditFirstOn(e.target.value)}
                  className="h-8 text-xs font-mono"
                />
              </div>
            </div>

            {editMonthly !== null && (
              <div className="rounded-lg bg-muted/40 p-2.5 border border-border/60 flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Monthly Deduction:</span>
                <span className="font-bold tabular-nums text-foreground">
                  UGX {formatAmount(editMonthly)}
                </span>
              </div>
            )}

            {editError && <p className="text-xs text-destructive font-medium">{editError}</p>}
          </div>

          <DialogFooter className="pt-2">
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setEditRow(null)}>
              Cancel
            </Button>
            <Button size="sm" className="h-8 text-xs" onClick={submitEdit} disabled={editSaving}>
              {editSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject Modal */}
      <Dialog open={!!rejectRow} onOpenChange={(next) => (!next ? setRejectRow(null) : null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base font-bold">Reject Advance Request</DialogTitle>
            <DialogDescription className="text-xs">
              Provide a clear reason for declining this advance request.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 pt-1">
            <Label className="text-xs font-medium text-muted-foreground">Rejection Reason (min 10 characters)</Label>
            <Textarea
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
              placeholder="e.g. Exceeds monthly net pay advance limit"
              className="text-xs min-h-[64px]"
            />
            {rejectError && <p className="text-xs text-destructive font-medium">{rejectError}</p>}
          </div>
          <DialogFooter className="pt-2">
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setRejectRow(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              className="h-8 text-xs"
              onClick={reject}
              disabled={busyId === rejectRow?.id}
            >
              Confirm Rejection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel Modal */}
      <Dialog open={!!cancelRow} onOpenChange={(next) => (!next ? setCancelRow(null) : null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base font-bold">Cancel Advance</DialogTitle>
            <DialogDescription className="text-xs">
              This will withdraw and void the advance file.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 pt-1">
            <Label className="text-xs font-medium text-muted-foreground">Reason for Cancellation</Label>
            <Textarea
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="At least 10 characters"
              className="text-xs min-h-[64px]"
            />
            {cancelError && <p className="text-xs text-destructive font-medium">{cancelError}</p>}
          </div>
          <DialogFooter className="pt-2">
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setCancelRow(null)}>
              Back
            </Button>
            <Button
              size="sm"
              variant="destructive"
              className="h-8 text-xs"
              onClick={cancel}
              disabled={busyId === cancelRow?.id}
            >
              Confirm Cancellation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}
