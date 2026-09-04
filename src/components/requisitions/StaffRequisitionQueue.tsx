import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import {
  Loader2, CheckCircle2, XCircle, Clock, HelpCircle, Wallet, RefreshCw, AlertTriangle, Building2,
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
  created_at: string;
}

interface BudgetContext {
  department_id: string;
  department_name: string;
  approved_budget: number;
  committed_amount: number;
  remaining_budget: number;
}

type TabKey = 'inbox' | 'in_flight' | 'returned' | 'approved' | 'rejected';

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

function StageBadge({ row }: { row: StaffRequisition }) {
  if (row.stage === 'approved') {
    return (
      <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700">
        <CheckCircle2 className="mr-1 h-3 w-3" /> Approved
      </Badge>
    );
  }
  if (row.stage === 'rejected') {
    return (
      <Badge variant="outline" className="border-red-500/30 bg-red-500/10 text-red-700">
        <XCircle className="mr-1 h-3 w-3" /> Declined
      </Badge>
    );
  }
  if (row.stage === 'returned') {
    return (
      <Badge variant="outline" className="border-blue-500/30 bg-blue-500/10 text-blue-700">
        <HelpCircle className="mr-1 h-3 w-3" /> More info needed
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-700">
      <Clock className="mr-1 h-3 w-3" /> {STAGE_LABEL[row.stage]} review
    </Badge>
  );
}

/**
 * Shared review queue for staff requisitions. Rendered on every reviewing
 * dashboard; the "Awaiting my review" tab is derived from the caller's roles
 * against `current_approver_role`, so one component serves department heads,
 * the COO and the CFO without per-role forks.
 */
export function StaffRequisitionQueue() {
  const { user, roles } = useAuth();
  const [rows, setRows] = useState<StaffRequisition[]>([]);
  const [budgets, setBudgets] = useState<Record<string, BudgetContext>>({});
  const [events, setEvents] = useState<Record<string, ReqEvent[]>>({});
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabKey>('inbox');

  const [active, setActive] = useState<StaffRequisition | null>(null);
  const [actionType, setActionType] = useState<'approve' | 'reject' | 'return_info'>('approve');
  const [reduceMode, setReduceMode] = useState(false);
  const [comment, setComment] = useState('');
  const [amountOverride, setAmountOverride] = useState('');
  const [acting, setActing] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);


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

  const visible = buckets[tab];

  const openAction = (row: StaffRequisition, type: 'approve' | 'reject' | 'return_info', reduce = false) => {
    setActive(row);
    setActionType(type);
    setReduceMode(reduce);
    setComment('');
    setAmountOverride(String(row.approved_amount ?? row.amount));
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
          : actionType === 'reject'
            ? 'Requisition declined'
            : 'Sent back to the requester',
      );

      setActive(null);
      setComment('');
      await fetchAll();
    }
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

  const TABS: Array<{ key: TabKey; label: string }> = [
    { key: 'inbox', label: `Awaiting my review (${buckets.inbox.length})` },
    { key: 'in_flight', label: `In progress (${buckets.in_flight.length})` },
    { key: 'returned', label: `Sent back (${buckets.returned.length})` },
    { key: 'approved', label: `Approved (${buckets.approved.length})` },
    { key: 'rejected', label: `Declined (${buckets.rejected.length})` },
  ];

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

      {loading ? (
        <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading requisitions…
        </div>
      ) : visible.length === 0 ? (
        <Card className="rounded-2xl p-8 text-center text-sm text-muted-foreground">
          Nothing here right now.
        </Card>
      ) : (
        <div className="space-y-3">
          {visible.map((row) => {
            const b = budgetFor(row);
            return (
              <Card key={row.id} className="rounded-2xl p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground">{row.requisition_code}</span>
                      <StageBadge row={row} />
                      {overBudget(row) && (
                        <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-700">
                          <AlertTriangle className="mr-1 h-3 w-3" /> Over department budget
                        </Badge>
                      )}
                    </div>
                    <p className="font-semibold">{row.title}</p>
                    <p className="text-sm text-muted-foreground">
                      {row.requester_name || 'Staff'}
                      {b?.department_name ? ` • ${b.department_name}` : ''}
                      {row.category ? ` • ${row.category}` : ''} • {fmtDate(row.created_at)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {routeNote(row)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-bold">{formatUGX(Number(row.approved_amount ?? row.amount))}</p>
                    {row.needed_by && (
                      <p className="text-xs text-muted-foreground">Needed by {row.needed_by}</p>
                    )}
                  </div>
                </div>

                <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">{row.reason}</p>

                {b && (
                  <div className="mt-3 flex flex-wrap gap-4 rounded-xl border bg-muted/40 p-3 text-xs">
                    <span className="flex items-center gap-1 font-medium">
                      <Building2 className="h-3 w-3" /> {b.department_name}
                    </span>
                    <span>Approved budget: <b>{formatUGX(Number(b.approved_budget))}</b></span>
                    <span>Committed: <b>{formatUGX(Number(b.committed_amount))}</b></span>
                    <span className={Number(b.remaining_budget) < 0 ? 'text-amber-700' : ''}>
                      Remaining: <b>{formatUGX(Number(b.remaining_budget))}</b>
                    </span>
                  </div>
                )}

                {row.stage === 'approved' && (
                  <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    <span>
                      Wallet: <b>{row.wallet_credit_status || 'pending'}</b>
                      {row.credited_at ? ` • ${fmtDate(row.credited_at)}` : ''}
                    </span>
                    {row.wallet_credit_status !== 'credited' && (
                      <Button size="sm" variant="outline" disabled={retrying === row.id} onClick={() => void retryCredit(row.id)}>
                        {retrying === row.id ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}
                        Retry wallet credit
                      </Button>
                    )}
                  </div>
                )}

                {row.rejection_reason && (
                  <p className="mt-3 rounded-xl border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-700">
                    {row.rejection_reason}
                  </p>
                )}

                {isMine(row) && row.requester_id !== user?.id && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => openAction(row, 'approve')}>Approve</Button>
                    <Button size="sm" variant="secondary" onClick={() => openAction(row, 'approve', true)}>
                      Reduce requested amount
                    </Button>

                    <Button size="sm" variant="outline" onClick={() => openAction(row, 'return_info')}>
                      Send back for info
                    </Button>
                    <Button size="sm" variant="destructive" onClick={() => openAction(row, 'reject')}>Decline</Button>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={!!active} onOpenChange={(o) => { if (!o) setActive(null); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {actionType === 'approve' ? (reduceMode ? 'Reduce requested amount' : 'Approve requisition')
                : actionType === 'reject' ? 'Decline requisition'
                  : 'Send back for more information'}

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
    </div>
  );
}

export default StaffRequisitionQueue;
