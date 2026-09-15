import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  Loader2, CheckCircle2, XCircle, Clock, HelpCircle, Wallet, RefreshCw, AlertTriangle, Building2,
  ChevronLeft, ChevronRight, ArrowDownCircle,
} from 'lucide-react';

export interface StaffRequisition {
  id: string;
  requisition_code: string;
  requester_id: string;
  requester_name: string | null;
  requester_role: string | null;
  department_id: string | null;
  department_key: string | null;
  title: string;
  amount: number;
  currency: string;
  category: string | null;
  reason: string;
  needed_by: string | null;
  attachment_urls: string[];
  stage: 'supervisor' | 'coo' | 'cfo' | 'ceo' | 'approved' | 'rejected' | 'returned';
  current_approver_role: string | null;
  final_stage: 'cfo' | 'ceo';
  returned_from_stage: string | null;
  supervisor_note: string | null;
  coo_note: string | null;
  cfo_note: string | null;
  approved_amount: number | null;
  rejection_reason: string | null;
  wallet_credit_status: string | null;
  wallet_transaction_id: string | null;
  credited_at: string | null;
  created_at: string;
}

interface ReqEvent {
  id: string;
  requisition_id: string;
  actor_name: string | null;
  action: string;
  stage: string | null;
  comment: string | null;
  metadata?: Record<string, unknown> | null;
  created_at: string;
}

interface UsageReport {
  id: string;
  requisition_id: string;
  amount_used: number;
  summary: string;
  submitted_at: string | null;
  attachment_paths: string[] | null;
}

interface BudgetContext {
  department_id: string;
  department_name: string;
  approved_budget: number;
  committed_amount: number;
  remaining_budget: number;
}

type TabKey = 'inbox' | 'in_flight' | 'returned' | 'approved' | 'rejected';

const PAGE_SIZE = 15;

const STAGE_LABEL: Record<string, string> = {
  supervisor: 'Department head',
  coo: 'COO',
  cfo: 'CFO',
  ceo: 'CEO',
  approved: 'Approved',
  rejected: 'Declined',
  returned: 'With requester',
};

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

function fmtDay(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * Explains the route a requisition is taking, so a CFO-skipping path is visible
 * instead of looking like a lost item. Nobody reviews their own money: a
 * requester who holds the CFO role is routed COO -> CEO, and a requester who
 * holds the COO role starts at CFO.
 */
function routeNote(row: StaffRequisition) {
  const final = row.final_stage === 'ceo' ? 'CEO' : 'CFO';
  const cfoSkipped = row.final_stage === 'ceo' && (row.requester_role || '').toLowerCase() === 'cfo';
  const withNow =
    row.current_approver_role ? STAGE_LABEL[row.current_approver_role] || row.current_approver_role.toUpperCase() : null;
  return [
    withNow ? `Now with ${withNow}` : null,
    `Final approval: ${final}`,
    cfoSkipped ? 'CFO review skipped — requester holds the CFO role' : null,
  ]
    .filter(Boolean)
    .join(' • ');
}

function StageBadge({ row, compact = false }: { row: StaffRequisition; compact?: boolean }) {
  const base = compact
    ? 'text-[9px] px-1.5 py-0 h-4 uppercase tracking-wider whitespace-nowrap'
    : '';
  if (row.stage === 'approved') {
    return (
      <Badge variant="outline" className={cn('border-emerald-500/30 bg-emerald-500/10 text-emerald-700', base)}>
        {!compact && <CheckCircle2 className="mr-1 h-3 w-3" />} Approved
      </Badge>
    );
  }
  if (row.stage === 'rejected') {
    return (
      <Badge variant="outline" className={cn('border-red-500/30 bg-red-500/10 text-red-700', base)}>
        {!compact && <XCircle className="mr-1 h-3 w-3" />} Declined
      </Badge>
    );
  }
  if (row.stage === 'returned') {
    return (
      <Badge variant="outline" className={cn('border-blue-500/30 bg-blue-500/10 text-blue-700', base)}>
        {!compact && <HelpCircle className="mr-1 h-3 w-3" />} More info needed
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className={cn('border-amber-500/30 bg-amber-500/10 text-amber-700', base)}>
      {!compact && <Clock className="mr-1 h-3 w-3" />} {STAGE_LABEL[row.stage]} review
    </Badge>
  );
}

/**
 * Shared review queue for staff requisitions. Rendered on every reviewing
 * dashboard; the "Awaiting my review" tab is derived from the caller's roles
 * against `current_approver_role`, so one component serves department heads,
 * the COO and the CFO without per-role forks.
 *
 * Presentation is a compact table matching the Agent Advance Request review
 * table (same spacing, typography, filter bar and row behaviour). Approval
 * routing, decisions and wallet credit are unchanged.
 */
export function StaffRequisitionQueue() {
  const { user, roles } = useAuth();
  const [rows, setRows] = useState<StaffRequisition[]>([]);
  const [budgets, setBudgets] = useState<Record<string, BudgetContext>>({});
  const [events, setEvents] = useState<Record<string, ReqEvent[]>>({});
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabKey>('inbox');

  const [active, setActive] = useState<StaffRequisition | null>(null);
  const [actionType, setActionType] = useState<'approve' | 'reject'>('approve');
  const [reduceMode, setReduceMode] = useState(false);
  const [comment, setComment] = useState('');
  const [amountOverride, setAmountOverride] = useState('');
  const [acting, setActing] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);

  // Requester's own reduction of what they asked for (never a decision).
  const [ownReduce, setOwnReduce] = useState<StaffRequisition | null>(null);
  const [ownAmount, setOwnAmount] = useState('');
  const [ownReason, setOwnReason] = useState('');
  const [ownSaving, setOwnSaving] = useState(false);

  const [detail, setDetail] = useState<StaffRequisition | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [departmentFilter, setDepartmentFilter] = useState<string>('all');
  const [submittedFrom, setSubmittedFrom] = useState('');
  const [submittedTo, setSubmittedTo] = useState('');
  const [page, setPage] = useState(1);

  const fetchAll = useCallback(async () => {
    const [reqRes, budgetRes] = await Promise.all([
      supabase.from('staff_requisitions').select('*').order('created_at', { ascending: false }),
      supabase.from('v_staff_requisition_budget_context').select('*'),
    ]);
    if (reqRes.error) {
      toast.error('Could not load requisitions', { description: reqRes.error.message });
    } else {
      setRows((reqRes.data || []) as unknown as StaffRequisition[]);
    }
    if (!budgetRes.error) {
      const map: Record<string, BudgetContext> = {};
      for (const b of (budgetRes.data || []) as unknown as BudgetContext[]) {
        map[b.department_id] = b;
      }
      setBudgets(map);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void fetchAll(); }, [fetchAll]);

  useEffect(() => {
    const channel = supabase
      .channel('staff-requisitions-queue')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'staff_requisitions' }, () => { void fetchAll(); })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [fetchAll]);

  const loadEvents = useCallback(async (id: string) => {
    const { data } = await supabase
      .from('staff_requisition_events')
      .select('*')
      .eq('requisition_id', id)
      .order('created_at', { ascending: true });
    setEvents((prev) => ({ ...prev, [id]: (data || []) as unknown as ReqEvent[] }));
  }, []);

  const isMine = useCallback(
    (row: StaffRequisition) =>
      !!row.current_approver_role &&
      ((roles as string[]).includes(row.current_approver_role) ||
        (roles as string[]).includes('super_admin') ||
        (roles as string[]).includes('manager')),
    [roles],
  );

  const buckets = useMemo(() => {
    const pending = rows.filter((r) => ['supervisor', 'coo', 'cfo', 'ceo'].includes(r.stage));
    return {
      inbox: pending.filter((r) => isMine(r) && r.requester_id !== user?.id),
      in_flight: pending.filter((r) => !(isMine(r) && r.requester_id !== user?.id)),
      returned: rows.filter((r) => r.stage === 'returned'),
      approved: rows.filter((r) => r.stage === 'approved'),
      rejected: rows.filter((r) => r.stage === 'rejected'),
    } as Record<TabKey, StaffRequisition[]>;
  }, [rows, isMine, user?.id]);

  const bucketRows = buckets[tab];

  const departmentName = useCallback(
    (row: StaffRequisition) =>
      (row.department_id ? budgets[row.department_id]?.department_name : null) || row.department_key || '—',
    [budgets],
  );

  const departmentOptions = useMemo(() => {
    const set = new Set<string>();
    bucketRows.forEach((r) => set.add(departmentName(r)));
    return Array.from(set).sort();
  }, [bucketRows, departmentName]);

  const visible = useMemo(() => {
    return bucketRows.filter((row) => {
      if (statusFilter !== 'all' && row.stage !== statusFilter) return false;
      if (departmentFilter !== 'all' && departmentName(row) !== departmentFilter) return false;
      if (search.trim()) {
        const t = search.trim().toLowerCase();
        const haystack = [row.requisition_code, row.requester_name, row.title, row.reason, row.category]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(t)) return false;
      }
      const created = new Date(row.created_at);
      if (submittedFrom) {
        const from = new Date(submittedFrom);
        from.setHours(0, 0, 0, 0);
        if (created < from) return false;
      }
      if (submittedTo) {
        const to = new Date(submittedTo);
        to.setHours(23, 59, 59, 999);
        if (created > to) return false;
      }
      return true;
    });
  }, [bucketRows, statusFilter, departmentFilter, departmentName, search, submittedFrom, submittedTo]);

  const hasActiveFilters =
    statusFilter !== 'all' || departmentFilter !== 'all' || search !== '' || submittedFrom !== '' || submittedTo !== '';

  const clearFilters = () => {
    setStatusFilter('all');
    setDepartmentFilter('all');
    setSearch('');
    setSubmittedFrom('');
    setSubmittedTo('');
  };

  useEffect(() => { setPage(1); }, [tab, statusFilter, departmentFilter, search, submittedFrom, submittedTo]);

  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const pageRows = useMemo(
    () => visible.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [visible, page],
  );

  const openAction = (row: StaffRequisition, type: 'approve' | 'reject', reduce = false) => {
    setActive(row);
    setActionType(type);
    setReduceMode(reduce);
    setComment('');
    setAmountOverride(String(row.approved_amount ?? row.amount));
    void loadEvents(row.id);
  };

  const openOwnReduce = (row: StaffRequisition) => {
    setOwnReduce(row);
    setOwnAmount('');
    setOwnReason('');
    void loadEvents(row.id);
  };

  const openDetail = (row: StaffRequisition) => {
    setDetail(row);
    void loadEvents(row.id);
  };

  const submitAction = async () => {
    if (!active) return;
    if (actionType !== 'approve' && comment.trim().length < 10) {
      toast.error('Add a comment of at least 10 characters for the audit trail');
      return;
    }
    const amount = Number(amountOverride);
    if (actionType === 'approve' && (!Number.isFinite(amount) || amount <= 0)) {
      toast.error('Enter a valid amount');
      return;
    }
    if (reduceMode) {
      const requested = Number(active.approved_amount ?? active.amount);
      if (amount >= requested) {
        toast.error(`Enter an amount lower than ${formatUGX(requested)}`);
        return;
      }
      if (comment.trim().length < 10) {
        toast.error('Explain the reduction in at least 10 characters');
        return;
      }
    }

    setActing(true);
    const { error } = await invokeEdgeFunction('staff-requisition-decide', {
      body: {
        requisition_id: active.id,
        action: actionType,
        comment: comment.trim(),
        ...(actionType === 'approve' ? { amount } : {}),
      },
      errorTitle: 'Decision failed',
    });
    setActing(false);
    if (!error) {
      toast.success(
        actionType === 'approve'
          ? (reduceMode
            ? `Approved at the reduced amount of ${formatUGX(amount)}`
            : 'Approved — the requisition moved forward')
          : 'Requisition declined',
      );
      setActive(null);
      setComment('');
      await fetchAll();
    }
  };

  const submitOwnReduce = async () => {
    if (!ownReduce) return;
    const requested = Number(ownReduce.amount);
    const amount = Number(ownAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error('Enter a valid amount');
      return;
    }
    if (amount >= requested) {
      toast.error(`Enter an amount lower than ${formatUGX(requested)}`);
      return;
    }
    if (ownReason.trim().length < 10) {
      toast.error('Explain the reduction in at least 10 characters');
      return;
    }
    setOwnSaving(true);
    const { error } = await supabase.rpc('staff_requisition_reduce_amount', {
      p_requisition_id: ownReduce.id,
      p_new_amount: amount,
      p_reason: ownReason.trim(),
    });
    setOwnSaving(false);
    if (error) {
      toast.error('Could not reduce the amount', { description: error.message });
      return;
    }
    toast.success(`Amount reduced to ${formatUGX(amount)} — the original request stays on record`);
    setOwnReduce(null);
    await fetchAll();
  };

  const retryCredit = async (id: string) => {
    setRetrying(id);
    const { data, error } = await invokeEdgeFunction('requisition-credit-retry', {
      body: { source_table: 'staff_requisitions', requisition_id: id },
    });
    setRetrying(null);
    if (error) toast.error('Wallet credit failed', { description: error.message });
    else toast.success((data as { message?: string } | null)?.message || 'Wallet credited');
    await fetchAll();
  };

  const budgetFor = (row: StaffRequisition) => (row.department_id ? budgets[row.department_id] : undefined);

  const overBudget = (row: StaffRequisition) => {
    const b = budgetFor(row);
    if (!b) return false;
    return Number(b.remaining_budget) < 0;
  };

  const canReviewRow = (row: StaffRequisition) => isMine(row) && row.requester_id !== user?.id;
  const canOwnReduce = (row: StaffRequisition) =>
    row.requester_id === user?.id && ['supervisor', 'coo', 'cfo', 'ceo', 'returned'].includes(row.stage);

  /** Original figure asked for, taken from the reduction trail when present. */
  const originalAmount = (row: StaffRequisition) => {
    const first = (events[row.id] || []).find((e) => e.action === 'amount_reduced');
    const orig = first?.metadata && (first.metadata as { original_amount?: number }).original_amount;
    return Number(orig ?? row.amount);
  };

  const TABS: Array<{ key: TabKey; label: string }> = [
    { key: 'inbox', label: `Awaiting my review (${buckets.inbox.length})` },
    { key: 'in_flight', label: `In progress (${buckets.in_flight.length})` },
    { key: 'returned', label: `Sent back (${buckets.returned.length})` },
    { key: 'approved', label: `Approved (${buckets.approved.length})` },
    { key: 'rejected', label: `Declined (${buckets.rejected.length})` },
  ];

  const activeReduction = active
    ? Number(active.approved_amount ?? active.amount) - Number(amountOverride || 0)
    : 0;
  const ownReduction = ownReduce ? Number(ownReduce.amount) - Number(ownAmount || 0) : 0;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="flex items-center gap-2 text-lg sm:text-xl font-semibold">
          <Wallet className="h-4 w-4 sm:h-5 sm:w-5 text-primary" /> Staff requisitions
        </h2>
        <p className="text-xs sm:text-sm text-muted-foreground">
          Raised from My Space, reviewed by the department head, then the COO, then the CFO. The requester's
          wallet is credited automatically on final approval.
        </p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
        <TabsList className="flex-wrap h-auto gap-1 p-1">
          {TABS.map((t) => (
            <TabsTrigger key={t.key} value={t.key} className="text-[10px] sm:text-xs px-2 py-1 h-auto">
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* Filter bar — same shape as the advance request review table */}
      <Card className="border-muted">
        <CardContent className="p-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end">
            <div className="space-y-1">
              <Label htmlFor="req-search" className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Search</Label>
              <Input
                id="req-search"
                placeholder="Code, requester or purpose"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="req-status" className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Status</Label>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger id="req-status" className="h-8 text-xs">
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="supervisor">Department head review</SelectItem>
                  <SelectItem value="coo">COO review</SelectItem>
                  <SelectItem value="cfo">CFO review</SelectItem>
                  <SelectItem value="ceo">CEO review</SelectItem>
                  <SelectItem value="returned">More info needed</SelectItem>
                  <SelectItem value="approved">Approved</SelectItem>
                  <SelectItem value="rejected">Declined</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="req-dept" className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Department</Label>
              <Select value={departmentFilter} onValueChange={setDepartmentFilter}>
                <SelectTrigger id="req-dept" className="h-8 text-xs">
                  <SelectValue placeholder="All departments" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All departments</SelectItem>
                  {departmentOptions.map((d) => (
                    <SelectItem key={d} value={d}>{d}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Submitted Date Range</Label>
              <div className="flex items-center gap-2">
                <Input type="date" value={submittedFrom} onChange={(e) => setSubmittedFrom(e.target.value)} className="h-8 text-xs" />
                <span className="text-muted-foreground">-</span>
                <Input type="date" value={submittedTo} onChange={(e) => setSubmittedTo(e.target.value)} className="h-8 text-xs" />
              </div>
            </div>
            <div>
              <Button variant="outline" size="sm" className="h-8 text-xs w-full" onClick={clearFilters} disabled={!hasActiveFilters}>
                Clear Filters
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold">{TABS.find((t) => t.key === tab)?.label}</h3>
        <Badge variant="secondary">{visible.length} of {bucketRows.length} shown</Badge>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading requisitions…
        </div>
      ) : visible.length === 0 ? (
        <Card className="rounded-2xl p-8 text-center text-sm text-muted-foreground">
          {bucketRows.length === 0 ? 'Nothing here right now.' : (
            <>
              No requisitions match the selected filters.
              <div>
                <Button variant="outline" size="sm" className="mt-3" onClick={clearFilters}>Clear filters</Button>
              </div>
            </>
          )}
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-muted/50 border-b">
                <tr>
                  <th className="text-left px-3 py-2 font-semibold">Requisition ID</th>
                  <th className="text-left px-3 py-2 font-semibold">Requester</th>
                  <th className="text-left px-3 py-2 font-semibold">Department</th>
                  <th className="text-left px-3 py-2 font-semibold">Description / Purpose</th>
                  <th className="text-right px-3 py-2 font-semibold">Requested (UGX)</th>
                  <th className="text-right px-3 py-2 font-semibold">Current (UGX)</th>
                  <th className="text-left px-3 py-2 font-semibold">Status</th>
                  <th className="text-left px-3 py-2 font-semibold">Submitted</th>
                  <th className="text-right px-3 py-2 font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {pageRows.map((row) => {
                  const requested = originalAmount(row);
                  const current = Number(row.approved_amount ?? row.amount);
                  return (
                    <tr
                      key={row.id}
                      tabIndex={0}
                      role="button"
                      aria-label={`Open requisition ${row.requisition_code}`}
                      onClick={() => openDetail(row)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          openDetail(row);
                        }
                      }}
                      className="cursor-pointer hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                    >
                      <td className="px-3 py-2 font-mono text-[11px] whitespace-nowrap">{row.requisition_code}</td>
                      <td className="px-3 py-2">
                        <p className="font-semibold truncate max-w-[150px]">{row.requester_name || 'Staff'}</p>
                        {overBudget(row) && (
                          <Badge variant="outline" className="mt-0.5 text-[9px] px-1.5 py-0 h-4 uppercase tracking-wider border-amber-500/40 bg-amber-500/10 text-amber-700">
                            Over budget
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">{departmentName(row)}</td>
                      <td className="px-3 py-2 max-w-[220px]">
                        <p className="truncate font-medium">{row.title}</p>
                        <p className="truncate text-[11px] text-muted-foreground">{row.reason}</p>
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{formatUGX(requested)}</td>
                      <td className={cn('px-3 py-2 text-right font-mono font-bold', current < requested ? 'text-amber-700' : 'text-primary')}>
                        {formatUGX(current)}
                      </td>
                      <td className="px-3 py-2"><StageBadge row={row} compact /></td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{fmtDay(row.created_at)}</td>
                      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                        <div className="flex flex-nowrap justify-end gap-1">
                          {canReviewRow(row) && (
                            <>
                              <Button size="sm" className="h-7 px-2 text-[11px] whitespace-nowrap" onClick={() => openAction(row, 'approve')}>Approve</Button>
                              <Button size="sm" variant="secondary" className="h-7 px-2 text-[11px] whitespace-nowrap" onClick={() => openAction(row, 'approve', true)}>
                                Reduce
                              </Button>
                              <Button size="sm" variant="destructive" className="h-7 px-2 text-[11px] whitespace-nowrap" onClick={() => openAction(row, 'reject')}>
                                Decline
                              </Button>
                            </>
                          )}
                          {canOwnReduce(row) && (
                            <Button size="sm" variant="outline" className="h-7 px-2 text-[11px] whitespace-nowrap" onClick={() => openOwnReduce(row)}>
                              <ArrowDownCircle className="mr-1 h-3 w-3" /> Reduce
                            </Button>
                          )}
                          {row.stage === 'approved' && row.wallet_credit_status !== 'credited' && (
                            <Button size="sm" variant="outline" className="h-7 px-2 text-[11px] whitespace-nowrap" disabled={retrying === row.id} onClick={() => void retryCredit(row.id)}>
                              {retrying === row.id ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}
                              Retry
                            </Button>
                          )}
                          {!canReviewRow(row) && !canOwnReduce(row) && row.stage !== 'approved' && (
                            <span className="text-[11px] text-muted-foreground">View</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between border-t px-3 py-2 text-xs">
              <span className="text-muted-foreground">
                Page {page} of {totalPages} • {visible.length} requisitions
              </span>
              <div className="flex gap-1">
                <Button size="sm" variant="outline" className="h-7 px-2" disabled={page === 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                  <ChevronLeft className="h-3 w-3" />
                </Button>
                <Button size="sm" variant="outline" className="h-7 px-2" disabled={page === totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
                  <ChevronRight className="h-3 w-3" />
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* Row details */}
      <Dialog open={!!detail} onOpenChange={(o) => { if (!o) setDetail(null); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground">{detail?.requisition_code}</span>
              {detail && <StageBadge row={detail} />}
            </DialogTitle>
            <DialogDescription>{detail?.title}</DialogDescription>
          </DialogHeader>

          {detail && (
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-muted-foreground">
                  {detail.requester_name || 'Staff'} • {departmentName(detail)}
                  {detail.category ? ` • ${detail.category}` : ''} • {fmtDate(detail.created_at)}
                </p>
                <p className="text-lg font-bold">{formatUGX(Number(detail.approved_amount ?? detail.amount))}</p>
              </div>
              <p className="text-xs text-muted-foreground">{routeNote(detail)}</p>
              {detail.needed_by && <p className="text-xs text-muted-foreground">Needed by {detail.needed_by}</p>}
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">{detail.reason}</p>

              {budgetFor(detail) && (
                <div className="flex flex-wrap gap-4 rounded-xl border bg-muted/40 p-3 text-xs">
                  <span className="flex items-center gap-1 font-medium">
                    <Building2 className="h-3 w-3" /> {budgetFor(detail)!.department_name}
                  </span>
                  <span>Approved budget: <b>{formatUGX(Number(budgetFor(detail)!.approved_budget))}</b></span>
                  <span>Committed: <b>{formatUGX(Number(budgetFor(detail)!.committed_amount))}</b></span>
                  <span className={Number(budgetFor(detail)!.remaining_budget) < 0 ? 'text-amber-700' : ''}>
                    Remaining: <b>{formatUGX(Number(budgetFor(detail)!.remaining_budget))}</b>
                  </span>
                </div>
              )}

              {detail.stage === 'approved' && (
                <p className="text-xs text-muted-foreground">
                  Wallet: <b>{detail.wallet_credit_status || 'pending'}</b>
                  {detail.credited_at ? ` • ${fmtDate(detail.credited_at)}` : ''}
                </p>
              )}

              {detail.rejection_reason && (
                <p className="rounded-xl border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-700">
                  {detail.rejection_reason}
                </p>
              )}

              {usageReports[detail.id] && (
                <div className="rounded-xl border bg-muted/30 p-3">
                  <p className="text-sm font-semibold">Usage report</p>
                  <p className="mt-1 text-sm">
                    Used {formatUGX(Number(usageReports[detail.id].amount_used))}
                    {usageReports[detail.id].submitted_at ? ` • ${fmtDate(usageReports[detail.id].submitted_at)}` : ''}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                    {usageReports[detail.id].summary}
                  </p>
                  {(usageReports[detail.id].attachment_paths?.length ?? 0) > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {usageReports[detail.id].attachment_paths!.map((path, i) => (
                        <Button
                          key={path}
                          size="sm"
                          variant="outline"
                          disabled={viewingPath === path}
                          onClick={() => void viewUsageAttachment(detail.id, path)}
                        >
                          Report receipt {i + 1}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {(events[detail.id]?.length ?? 0) > 0 && (
                <div className="space-y-2 rounded-xl border p-3">
                  <p className="text-xs font-semibold uppercase text-muted-foreground">Audit trail</p>
                  {events[detail.id].map((e) => (
                    <div key={e.id} className="text-xs">
                      <span className="font-medium capitalize">{e.action.replace(/_/g, ' ')}</span>
                      {e.stage ? ` • ${STAGE_LABEL[e.stage] || e.stage}` : ''} • {e.actor_name || 'System'} • {fmtDate(e.created_at)}
                      {e.comment && <p className="text-muted-foreground">{e.comment}</p>}
                      {e.action === 'amount_reduced' && e.metadata && (
                        <p className="text-muted-foreground">
                          {formatUGX(Number((e.metadata as { original_amount?: number }).original_amount ?? 0))}
                          {' → '}
                          {formatUGX(Number((e.metadata as { new_amount?: number }).new_amount ?? 0))}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                {canReviewRow(detail) && (
                  <>
                    <Button size="sm" onClick={() => { const r = detail; setDetail(null); openAction(r, 'approve'); }}>Approve</Button>
                    <Button size="sm" variant="secondary" onClick={() => { const r = detail; setDetail(null); openAction(r, 'approve', true); }}>
                      Reduce requested amount
                    </Button>
                    <Button size="sm" variant="destructive" onClick={() => { const r = detail; setDetail(null); openAction(r, 'reject'); }}>Decline</Button>
                  </>
                )}
                {canOwnReduce(detail) && (
                  <Button size="sm" variant="outline" onClick={() => { const r = detail; setDetail(null); openOwnReduce(r); }}>
                    <ArrowDownCircle className="mr-1 h-3 w-3" /> Reduce requested amount
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Reviewer decision */}
      <Dialog open={!!active} onOpenChange={(o) => { if (!o) setActive(null); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {actionType === 'approve' ? (reduceMode ? 'Reduce requested amount' : 'Approve requisition')
                : 'Decline requisition'}
            </DialogTitle>
            <DialogDescription>
              {active?.requisition_code} • {active?.title}
            </DialogDescription>
          </DialogHeader>

          {active && overBudget(active) && (
            <div className="flex gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                This department has already committed more than its approved budget for the open cycle. You can
                still approve, but the overspend is on record.
              </span>
            </div>
          )}

          {actionType === 'approve' && (
            <div className="space-y-2">
              <Label htmlFor="req-amount">Approved amount (UGX)</Label>
              {reduceMode && active && (
                <p className="text-xs text-muted-foreground">
                  Requested: <b>{formatUGX(Number(active.approved_amount ?? active.amount))}</b> — enter a lower amount.
                </p>
              )}
              <Input
                id="req-amount"
                inputMode="numeric"
                value={amountOverride}
                onChange={(e) => setAmountOverride(e.target.value.replace(/[^0-9.]/g, ''))}
              />
              {reduceMode && activeReduction > 0 && (
                <p className="text-xs text-amber-700">Reduction: {formatUGX(activeReduction)}</p>
              )}
              {active?.stage === active?.final_stage && (
                <p className="text-xs text-muted-foreground">
                  Final approval — this credits the requester's wallet immediately.
                </p>
              )}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="req-comment">
              Comment {actionType === 'approve' && !reduceMode ? '(optional)' : '(required, min 10 characters)'}
            </Label>
            <Textarea
              id="req-comment"
              rows={3}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={reduceMode ? 'Why is the amount being reduced?' : actionType === 'approve' ? 'Any note for the audit trail' : 'Explain your decision'}
            />
          </div>

          {active && (events[active.id]?.length ?? 0) > 0 && (
            <div className="space-y-2 rounded-xl border p-3">
              <p className="text-xs font-semibold uppercase text-muted-foreground">Audit trail</p>
              {events[active.id].map((e) => (
                <div key={e.id} className="text-xs">
                  <span className="font-medium capitalize">{e.action.replace(/_/g, ' ')}</span>
                  {e.stage ? ` • ${STAGE_LABEL[e.stage] || e.stage}` : ''} • {e.actor_name || 'System'} • {fmtDate(e.created_at)}
                  {e.comment && <p className="text-muted-foreground">{e.comment}</p>}
                </div>
              ))}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setActive(null)} disabled={acting}>Cancel</Button>
            <Button
              onClick={() => void submitAction()}
              disabled={acting}
              variant={actionType === 'reject' ? 'destructive' : 'default'}
            >
              {acting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Requester reduces their own request */}
      <Dialog open={!!ownReduce} onOpenChange={(o) => { if (!o) setOwnReduce(null); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reduce requested amount</DialogTitle>
            <DialogDescription>
              {ownReduce?.requisition_code} • {ownReduce?.title}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="rounded-xl border bg-muted/40 p-3 text-sm">
              <p>Originally requested: <b>{ownReduce ? formatUGX(Number(ownReduce.amount)) : '—'}</b></p>
              {ownReduction > 0 && (
                <p className="text-amber-700">Reduction: <b>{formatUGX(ownReduction)}</b></p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="own-amount">New amount (UGX)</Label>
              <Input
                id="own-amount"
                inputMode="numeric"
                value={ownAmount}
                onChange={(e) => setOwnAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                placeholder="Enter a lower amount"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="own-reason">Why are you reducing it? (min 10 characters)</Label>
              <Textarea
                id="own-reason"
                rows={3}
                value={ownReason}
                onChange={(e) => setOwnReason(e.target.value)}
              />
            </div>

            <p className="text-xs text-muted-foreground">
              The amount you first asked for stays on the requisition history. Approvals continue from where the
              requisition already is.
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOwnReduce(null)} disabled={ownSaving}>Cancel</Button>
            <Button onClick={() => void submitOwnReduce()} disabled={ownSaving}>
              {ownSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Confirm reduction
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default StaffRequisitionQueue;
