import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { Smartphone, Check, X, Loader2, Trash2, AlertTriangle } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { SupplierPicker, type SupplierChoice } from './SmartphoneCatalogDialog';
import { isMoBanjaIphone, MO_BANJA } from '@/lib/moBanjaIphone';
import { format } from 'date-fns';

const db = supabase as any;

interface SmartphoneOrderRow {
  id: string;
  customer_id: string | null;
  client_name: string | null;
  client_phone: string | null;
  brand: string | null;
  model_type: string | null;
  total_amount: number | null;
  payment_projection: number | null;
  amount_outstanding: number | null;
  amount_paid: number | null;
  order_status: string;
  rejection_reason: string | null;
  created_at: string;
  ops_approved_at?: string | null;
  coo_approved_at?: string | null;
  cfo_disbursed_at?: string | null;
  disbursed_amount?: number | null;
  access_daily_amount?: number | null;
  access_repayment_days?: number | null;
  advance_period_months?: number | null;
  advance_markup_pct?: number | null;
  total_repayable?: number | null;
  repayment_starts_on?: string | null;
  supplier_id?: string | null;
  supplier_name?: string | null;
}


const STATUS_TONE: Record<string, string> = {
  pending_approval: 'bg-amber-500/15 text-amber-600 border-amber-500/30',
  submitted: 'bg-amber-500/15 text-amber-600 border-amber-500/30',
  ops_approved: 'bg-indigo-500/15 text-indigo-600 border-indigo-500/30',
  coo_approved: 'bg-sky-500/15 text-sky-600 border-sky-500/30',
  approved: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30',
  completed: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30',
  rejected: 'bg-destructive/15 text-destructive border-destructive/30',
};

const STATUS_LABEL: Record<string, string> = {
  pending_approval: 'Awaiting Agent Ops',
  submitted: 'Awaiting Agent Ops',
  ops_approved: 'Awaiting COO',
  coo_approved: 'Awaiting CFO',
  approved: 'Funded',
  completed: 'Funded',
  disbursed: 'Funded',
  funded: 'Funded',
};

const statusLabel = (s: string) => STATUS_LABEL[s] || s.replace(/_/g, ' ');

/** Stage 1 — application still needs the Agent Operations Manager's decision. */
const isPending = (s: string) => s === 'pending_approval' || s === 'submitted';
/** Stage 2 — Agent Ops approved, waiting for the COO. */
const isAwaitingCoo = (s: string) => s === 'ops_approved';
/** Stage 3 — COO approved, waiting for the CFO to pay the supplier. */
const isAwaitingCfo = (s: string) => s === 'coo_approved';
/** Anything a reviewer still has to act on. */
const isOpen = (s: string) => isPending(s) || isAwaitingCoo(s) || isAwaitingCfo(s);
/** Only initial applications may be acted on inside the Agent Ops view. */
const isAgentOpsActionable = (s: string) => s === 'pending_approval' || s === 'submitted';

/**
 * Executive queue for agent smartphone applications — a three-stage flow:
 * stage 1 the Agent Operations Manager verifies the applicant and locks the
 * access amount and repayment terms; stage 2 the COO confirms and forwards the
 * file to the CFO (no money moves in either stage); stage 3 the CFO pays the
 * assigned supplier directly and starts the 33% recovery plan on the agent.
 * Rejecting at any stage requires a 10+ character reason.
 */
export function SmartphoneOrderApprovalQueue({
  pendingOnly = false,
  rejectedOnly = false,
  inProgressOnly = false,
  stage: stageFilter,
}: {
  pendingOnly?: boolean;
  rejectedOnly?: boolean;
  inProgressOnly?: boolean;
  /**
   * Restricts the queue to one review desk. A desk sees the files waiting on it
   * plus every file it has already signed off (those stay listed with an
   * updated status badge and open strictly read-only).
   */
  stage?: 'ops' | 'coo' | 'cfo';
} = {}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [rejectTarget, setRejectTarget] = useState<SmartphoneOrderRow | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [detailsTarget, setDetailsTarget] = useState<SmartphoneOrderRow | null>(null);
  const [approveTarget, setApproveTarget] = useState<SmartphoneOrderRow | null>(null);
  const [officialAmount, setOfficialAmount] = useState('');
  const [repaymentDays, setRepaymentDays] = useState('30');
  const [supplierDraft, setSupplierDraft] = useState<SupplierChoice | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SmartphoneOrderRow | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const approveStage: 'ops' | 'coo' | 'cfo' = stageFilter
    ? stageFilter
    : !approveTarget
      ? 'ops'
      : isAwaitingCfo(approveTarget.order_status)
        ? 'cfo'
        : isAwaitingCoo(approveTarget.order_status)
          ? 'coo'
          : 'ops';

  /**
   * A row may only be acted on by the desk it is currently sitting with. Once a
   * desk has signed off, its own copy of the file becomes read-only.
   */
  const canActOnRow = (status: string) => {
    if (stageFilter === 'coo') return isAwaitingCoo(status);
    if (stageFilter === 'cfo') return isAwaitingCfo(status);
    return isAgentOpsActionable(status);
  };
  /** Both review stages (Agent Ops, COO) record terms and move money nowhere. */
  const isReviewStage = approveStage !== 'cfo';
  /**
   * Agent Ops is the only stage that sets the terms. From the moment they
   * approve, the amount and repayment period are locked (read-only) for the COO
   * and the CFO — they confirm the file, they do not re-price it.
   */
  const termsLocked = approveStage !== 'ops';

  const openApprove = (o: SmartphoneOrderRow) => {
    if (!canActOnRow(o.order_status)) return;
    setApproveTarget(o);
    const existing = Number(o.total_amount || 0);
    // Welile funds the down payment only, so the Access Amount is exactly the
    // down payment at both stages. Interest is charged on top of it.
    setOfficialAmount(existing > 0 ? String(Math.round(existing)) : '');
    const days = Number(o.access_repayment_days || 0);
    setRepaymentDays(days > 0 ? String(days) : '30');
  };


  const closeApprove = () => {
    setApproveTarget(null);
    setOfficialAmount('');
    setRepaymentDays('30');
  };

  const officialAmountNumber = Math.max(0, Math.round(Number(officialAmount || 0) || 0));
  const officialProjection = Math.round(officialAmountNumber * 0.33);

  // Repayment maths shown to both the executive and (once saved) the agent:
  // Access Amount = the down payment Welile releases. The agent repays that
  // amount plus 33% interest, spread evenly over the chosen number of days.
  const phoneAmountNumber = Math.max(0, Math.round(Number(approveTarget?.total_amount || 0)));
  const accessInterest = officialProjection;
  const totalPayable = officialAmountNumber + accessInterest;
  const repaymentDaysNumber = Math.max(0, Math.round(Number(repaymentDays || 0) || 0));
  const dailyDeduction = repaymentDaysNumber > 0 ? Math.round(totalPayable / repaymentDaysNumber) : 0;




  const { data: wallet, isLoading: walletLoading } = useQuery({
    queryKey: ['smartphone-order-wallet', detailsTarget?.customer_id],
    enabled: !!detailsTarget?.customer_id,
    queryFn: async () => {
      const { data, error } = await db
        .from('wallets')
        .select('withdrawable_balance, float_balance, advance_balance')
        .eq('user_id', detailsTarget!.customer_id)
        .maybeSingle();
      if (error) throw error;
      return data as { withdrawable_balance: number; float_balance: number; advance_balance: number } | null;
    },
  });

  // Applicant profile metrics — applications are no longer gated on tenant
  // count or documents, so the reviewing manager sees the full standing here
  // and makes the call.
  const { data: applicant, isLoading: applicantLoading } = useQuery({
    queryKey: ['smartphone-applicant-metrics', detailsTarget?.customer_id],
    enabled: !!detailsTarget?.customer_id,
    queryFn: async () => {
      const { data, error } = await db.rpc('get_agent_smartphone_eligibility', {
        p_user_id: detailsTarget!.customer_id,
      });
      if (error) throw error;
      return (data || null) as {
        rank: number | null;
        collected_30d: number;
        max_amount: number;
        is_active_agent?: boolean;
        active_tenant_count: number;
        required_active_tenants: number;
        meets_tenant_guideline?: boolean;
        has_national_id: boolean;
        has_workplace_verification: boolean;
      } | null;
    },
  });

  // Fetch the agent's actual NIN from their profile so ops can see the number directly.
  // Checks both profiles.national_id and proxy_agent_identity.nin and uses whichever is set.
  const { data: agentProfile } = useQuery({
    queryKey: ['smartphone-applicant-profile', detailsTarget?.customer_id],
    enabled: !!detailsTarget?.customer_id,
    queryFn: async () => {
      const [profileRes, proxyRes] = await Promise.all([
        db
          .from('profiles')
          .select('national_id, full_name, phone')
          .eq('id', detailsTarget!.customer_id)
          .maybeSingle(),
        db
          .from('proxy_agent_identity')
          .select('nin')
          .eq('agent_user_id', detailsTarget!.customer_id)
          .maybeSingle(),
      ]);
      const nin =
        (profileRes.data?.national_id && profileRes.data.national_id.trim()) ||
        (proxyRes.data?.nin && proxyRes.data.nin.trim()) ||
        null;
      return {
        national_id: nin,
        full_name: profileRes.data?.full_name ?? null,
        phone: profileRes.data?.phone ?? null,
      } as { national_id: string | null; full_name: string | null; phone: string | null };
    },
  });


  const { data: orders = [], isLoading } = useQuery<SmartphoneOrderRow[]>({
    queryKey: ['smartphone-order-queue'],
    queryFn: async () => {
      const { data, error } = await db.rpc('list_smartphone_orders', { p_status: null });
      if (error) throw error;
      return (data || []) as SmartphoneOrderRow[];
    },
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['smartphone-order-queue'] });
    queryClient.invalidateQueries({ queryKey: ['agent-products'] });
  };

  const approve = useMutation({
    mutationFn: async ({
      id,
      amount,
      stage,
      daily,
      days,
    }: { id: string; amount: number; stage: 'ops' | 'coo' | 'cfo'; daily?: number; days?: number }) => {
      // One RPC per stage. The two review stages carry the access amount and the
      // repayment terms; the CFO stage carries only the amount released.
      const fn =
        stage === 'cfo'
          ? 'cfo_disburse_smartphone_order'
          : stage === 'coo'
            ? 'coo_approve_smartphone_order'
            : 'agent_ops_approve_smartphone_order';
      const { data, error } = await db.rpc(
        fn,
        stage === 'cfo'
          ? { p_sale_id: id, p_amount: amount }
          : {
              p_sale_id: id,
              p_total_amount: amount,
              p_daily_deduction: daily ?? null,
              p_repayment_days: days ?? null,
            },
      );
      if (error) throw error;
      return { ...(data as any), stage };
    },
    onSuccess: (data: any, variables) => {
      if (data?.stage === 'cfo') {
        toast.success(
          `${formatUGX(Number(data?.total_amount || 0))} paid to the assigned supplier. Recovery plan activated on the agent: ${formatUGX(Number(data?.payment_projection || 0))} charge, first daily ${formatUGX(Number(data?.daily_amount || 0))} (28% monthly, reducing). The agent has been notified.`,
        );
        // Fire-and-forget: tell the applying agent the down payment is with the
        // supplier and share the supplier's contact for tracking.
        void db.functions
          .invoke('notify-smartphone-order-disbursed', { body: { sale_id: variables.id } })
          .catch((e) => console.error('[SmartphoneOrderApprovalQueue] notify failed', e));
      } else {
        const daily = Number(data?.access_daily_amount || 0);
        const nextStage = data?.stage === 'ops' ? 'the COO' : 'the CFO for supplier payment';
        toast.success(
          `Approved at ${formatUGX(Number(data?.total_amount || 0))}${daily > 0 ? ` · ${formatUGX(daily)}/day for ${Number(data?.access_repayment_days || 0)} days` : ''} and forwarded to ${nextStage}.`,
        );
      }
      closeApprove();
      setDetailsTarget(null);
      invalidate();
    },

    onError: (e: any) => toast.error(e.message || 'Could not process this application'),
  });


  const reject = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { error } = await db.rpc('reject_smartphone_order', { p_sale_id: id, p_reason: reason });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Order rejected. No wallet charge applied.');
      setRejectTarget(null);
      setDetailsTarget(null);
      setRejectReason('');

      invalidate();
    },
    onError: (e: any) => toast.error(e.message || 'Could not reject order'),
  });

  const assignSupplier = useMutation({
    mutationFn: async ({ id, supplier }: { id: string; supplier: SupplierChoice | null }) => {
      const { error } = await db.rpc('assign_smartphone_order_supplier', {
        p_sale_id: id,
        p_supplier_id: supplier?.id ?? null,
      });
      if (error) throw error;
      return supplier;
    },
    onSuccess: (supplier) => {
      toast.success(supplier ? `Supplier set to ${supplier.name}` : 'Supplier cleared');
      setSupplierDraft(null);
      setDetailsTarget((prev) =>
        prev ? { ...prev, supplier_id: supplier?.id ?? null, supplier_name: supplier?.name ?? null } : prev,
      );
      invalidate();
    },
    onError: (e: any) => toast.error(e.message || 'Could not assign the supplier'),
  });

  const deleteSingleOrder = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      const { data: plans } = await db.from('merchandise_recovery_plans').select('id').eq('sale_id', deleteTarget.id);
      if (plans && plans.length > 0) {
        const planIds = plans.map((p: any) => p.id);
        await db.from('merchandise_recovery_deductions').delete().in('plan_id', planIds);
        await db.from('merchandise_recovery_plans').delete().eq('sale_id', deleteTarget.id);
      }
      const { error } = await db.from('merchandise_sales').delete().eq('id', deleteTarget.id);
      if (error) throw error;

      toast.success(`Application for ${deleteTarget.client_name || 'Agent'} deleted.`);
      setDeleteTarget(null);
      invalidate();
    } catch (err: any) {
      toast.error(err.message || 'Could not delete application');
    } finally {
      setIsDeleting(false);
    }
  };

  const deleteBulkOrders = async () => {
    if (filtered.length === 0) return;
    setIsDeleting(true);
    let successCount = 0;
    let failCount = 0;

    for (const order of filtered) {
      try {
        const { data: plans } = await db.from('merchandise_recovery_plans').select('id').eq('sale_id', order.id);
        if (plans && plans.length > 0) {
          const planIds = plans.map((p: any) => p.id);
          await db.from('merchandise_recovery_deductions').delete().in('plan_id', planIds);
          await db.from('merchandise_recovery_plans').delete().eq('sale_id', order.id);
        }
        const { error } = await db.from('merchandise_sales').delete().eq('id', order.id);
        if (error) throw error;
        successCount++;
      } catch {
        failCount++;
      }
    }

    setIsDeleting(false);
    setBulkDeleteOpen(false);
    invalidate();

    if (failCount === 0) {
      toast.success(`Deleted all ${successCount} applications.`);
    } else {
      toast.error(`Deleted ${successCount} applications. ${failCount} failed.`);
    }
  };

  const scoped = useMemo(() => {
    // A desk-scoped queue keeps the files it has already signed off, so nothing
    // disappears after approval — it simply carries a later status badge.
    let rows = orders;
    if (stageFilter === 'coo') {
      rows = rows.filter((o) => isAwaitingCoo(o.order_status) || !!o.coo_approved_at);
    } else if (stageFilter === 'cfo') {
      rows = rows.filter((o) => isAwaitingCfo(o.order_status) || !!o.cfo_disbursed_at);
    }
    if (rejectedOnly) return rows.filter((o) => o.order_status === 'rejected');
    if (inProgressOnly) return rows.filter((o) => isAwaitingCoo(o.order_status) || isAwaitingCfo(o.order_status));
    if (pendingOnly) return rows.filter((o) => isPending(o.order_status));
    return rows;
  }, [orders, pendingOnly, rejectedOnly, inProgressOnly, stageFilter]);



  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return scoped;
    return scoped.filter((o) =>
      [o.client_name, o.client_phone, o.brand, o.model_type]
        .some((v) => (v || '').toLowerCase().includes(q)),
    );
  }, [scoped, search]);

  const pendingCount = useMemo(() => orders.filter((o) => isPending(o.order_status)).length, [orders]);
  const awaitingCooCount = useMemo(() => orders.filter((o) => isAwaitingCoo(o.order_status)).length, [orders]);
  const awaitingCfoCount = useMemo(() => orders.filter((o) => isAwaitingCfo(o.order_status)).length, [orders]);

  const rowBusy = (id: string) =>
    (approve.isPending && approve.variables?.id === id) ||
    (reject.isPending && reject.variables?.id === id);

  /** What the sign-off button does at this desk. */
  const stageActionLabel =
    stageFilter === 'cfo'
      ? 'Approve & pay supplier'
      : stageFilter === 'coo'
        ? 'Approve & send to CFO'
        : 'Approve & send to COO';

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <Smartphone className="h-4 w-4 text-primary" />
            {rejectedOnly
              ? 'Rejected applications'
              : inProgressOnly
                ? 'Applications in progress'
                : pendingOnly
                  ? 'Pending applications'
                  : 'Smartphone applications'}
            {rejectedOnly ? (
              <Badge variant="outline" className={STATUS_TONE.rejected}>{scoped.length} rejected</Badge>
            ) : (
              <>
                {!inProgressOnly && !stageFilter && (
                  <Badge variant="secondary">{pendingCount} awaiting Agent Ops</Badge>
                )}
                {(!stageFilter || stageFilter === 'coo') && (
                  <Badge variant="outline" className={STATUS_TONE.ops_approved}>
                    {awaitingCooCount} awaiting COO
                  </Badge>
                )}
                {(!stageFilter || stageFilter === 'cfo') && (
                  <Badge variant="outline" className={STATUS_TONE.coo_approved}>
                    {awaitingCfoCount} awaiting CFO
                  </Badge>
                )}
              </>
            )}
          </CardTitle>


          {filtered.length > 0 && rejectedOnly && (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => setBulkDeleteOpen(true)}
              disabled={isDeleting}
              className="gap-1.5 h-8 text-xs font-semibold shrink-0"
            >
              {isDeleting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              <span>Delete All ({filtered.length})</span>
            </Button>
          )}
        </div>
        {!rejectedOnly && (
          <p className="text-[11px] text-muted-foreground">
            Stage 1 — Agent Ops verifies the applicant and locks the access amount and repayment terms.
            Stage 2 — COO confirms and forwards to the CFO. Stage 3 — CFO pays the assigned supplier
            directly and activates the 33% recovery plan on the agent.
          </p>
        )}
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search agent, phone, brand or model"
          className="mt-2 h-9"
        />
      </CardHeader>

      <CardContent className="space-y-2">
        {isLoading ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading orders…
          </p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {rejectedOnly
              ? 'No rejected applications.'
              : inProgressOnly
                ? 'No applications awaiting COO or CFO.'
                : pendingOnly
                  ? 'No applications awaiting approval.'
                  : 'No smartphone orders yet.'}
          </p>
        ) : (
          filtered.map((o) => {
            const total = Number(o.total_amount || 0);
            const projection = Number(o.payment_projection || Math.round(total * 0.33));
            return (
              <div
                key={o.id}
                role="button"
                tabIndex={0}
                onClick={() => setDetailsTarget(o)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetailsTarget(o); }
                }}
                className="rounded-lg border p-3 space-y-2 cursor-pointer transition-colors hover:bg-muted/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate">{o.client_name || 'Agent'}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {o.client_phone || '—'} · {format(new Date(o.created_at), 'dd MMM yyyy HH:mm')}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Badge variant="outline" className={STATUS_TONE[o.order_status] || ''}>
                      {statusLabel(o.order_status)}
                    </Badge>
                    {rejectedOnly && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteTarget(o);
                        }}
                        disabled={isDeleting}
                        className="h-7 w-7 text-destructive hover:bg-destructive/10 shrink-0"
                        title="Delete this rejected application"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                  <div className="rounded-md bg-muted/50 px-2 py-1.5">
                    <p className="text-[10px] text-muted-foreground">Brand</p>
                    <p className="text-xs font-semibold">{o.brand || '—'}</p>
                  </div>
                  <div className="rounded-md bg-muted/50 px-2 py-1.5">
                    <p className="text-[10px] text-muted-foreground">Model</p>
                    <p className="text-xs font-semibold truncate">{o.model_type || '—'}</p>
                  </div>
                  <div className="rounded-md bg-muted/50 px-2 py-1.5">
                    <p className="text-[10px] text-muted-foreground">
                      {isMoBanjaIphone(o.brand, o.model_type) ? MO_BANJA.amountLabelShort : 'Phone amount'}
                    </p>
                    <p className="text-xs font-semibold">{formatUGX(total)}</p>
                  </div>
                  <div className="rounded-md bg-muted/50 px-2 py-1.5">
                    <p className="text-[10px] text-muted-foreground">Projection (33%)</p>
                    <p className="text-xs font-semibold">{formatUGX(projection)}</p>
                  </div>
                </div>

                {o.rejection_reason && (
                  <p className="text-[11px] text-destructive">Rejected: {o.rejection_reason}</p>
                )}

                {canActOnRow(o.order_status) ? (
                  <div className="flex flex-wrap gap-2" onClick={(e) => e.stopPropagation()}>
                    <Button
                      size="sm"
                      onClick={() => openApprove(o)}
                      disabled={rowBusy(o.id)}
                    >
                      {approve.isPending && approve.variables?.id === o.id ? (
                        <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Processing…</>
                      ) : (
                        <><Check className="h-3.5 w-3.5 mr-1" /> {stageActionLabel}</>
                      )}
                    </Button>


                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => { setRejectTarget(o); setRejectReason(''); }}
                      disabled={rowBusy(o.id)}
                    >
                      {reject.isPending && reject.variables?.id === o.id ? (
                        <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Rejecting…</>
                      ) : (
                        <><X className="h-3.5 w-3.5 mr-1" /> Reject</>
                      )}
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className={STATUS_TONE[o.order_status] || ''}>
                      {statusLabel(o.order_status)}
                    </Badge>
                    <span className="text-[11px] text-muted-foreground">
                      {isAwaitingCoo(o.order_status)
                        ? 'Awaiting COO review'
                        : isAwaitingCfo(o.order_status)
                          ? 'Awaiting CFO disbursement'
                          : 'Read-only'}
                    </span>
                  </div>
                )}

              </div>
            );
          })
        )}
      </CardContent>

      <Dialog open={!!detailsTarget} onOpenChange={(open) => { if (!open) { setDetailsTarget(null); setSupplierDraft(null); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Smartphone className="h-4 w-4 text-primary" />
              Smartphone application
            </DialogTitle>
          </DialogHeader>
          {detailsTarget && (() => {
            const total = Number(detailsTarget.total_amount || 0);
            const totalRepayable = Number(detailsTarget.total_repayable || 0);
            const projection = Number(
              detailsTarget.payment_projection || Math.max(0, totalRepayable - total),
            );
            const rows: Array<[string, string]> = [
              ['Agent', detailsTarget.client_name || 'Agent'],
              ['Phone number', detailsTarget.client_phone || '—'],
              ['Submitted', format(new Date(detailsTarget.created_at), 'dd MMM yyyy HH:mm')],
              ['Brand', detailsTarget.brand || '—'],
              ['Model', detailsTarget.model_type || '—'],
              [
                isMoBanjaIphone(detailsTarget.brand, detailsTarget.model_type)
                  ? MO_BANJA.amountLabel
                  : 'Phone amount',
                formatUGX(total),
              ],
              ['Charge (28%/month, reducing)', formatUGX(projection)],
              ['Access Amount (down payment)', formatUGX(total)],
              ['Amount paid', formatUGX(Number(detailsTarget.amount_paid || 0))],

              ['Outstanding', formatUGX(Number(detailsTarget.amount_outstanding || 0))],
            ];
            const savedDaily = Number(detailsTarget.access_daily_amount || 0);
            const savedDays = Number(detailsTarget.access_repayment_days || 0);
            const savedMonths = Number(detailsTarget.advance_period_months || 0);
            if (savedDaily > 0) {
              rows.push(['First daily deduction', `${formatUGX(savedDaily)} / day (reduces monthly)`]);
            }
            if (savedDays > 0) {
              rows.push([
                'Repayment period',
                savedMonths > 0 ? `${savedMonths} months (${savedDays} days)` : `${savedDays} days`,
              ]);
            }
            if (totalRepayable > 0) {
              rows.push(['Total payable', formatUGX(totalRepayable)]);
            }

            return (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Status</span>
                  <Badge variant="outline" className={STATUS_TONE[detailsTarget.order_status] || ''}>
                    {statusLabel(detailsTarget.order_status)}
                  </Badge>

                </div>

                <div className="rounded-lg border divide-y">
                  {rows.map(([label, value]) => (
                    <div key={label} className="flex items-center justify-between gap-3 px-3 py-2">
                      <span className="text-xs text-muted-foreground">{label}</span>
                      <span className="text-xs font-semibold text-right truncate">{value}</span>
                    </div>
                  ))}
                </div>

                {isMoBanjaIphone(detailsTarget.brand, detailsTarget.model_type) && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-1">
                    <p className="text-xs font-semibold flex items-center gap-1.5">
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-600" /> {MO_BANJA.partner} programme
                    </p>
                    <p className="text-[11px] text-muted-foreground">{MO_BANJA.opsNote}</p>
                  </div>
                )}

                <p className="text-[11px] text-muted-foreground">
                  Paid to{' '}
                  <span className="font-semibold text-foreground">
                    {detailsTarget.supplier_name || 'the registered supplier'}
                  </span>
                  {' · '}repaid by{' '}
                  <span className="font-semibold text-foreground">
                    {detailsTarget.client_name || 'the applying agent'}
                  </span>
                </p>

                <div className="rounded-lg border p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold">Supplier</p>
                    {!isAgentOpsActionable(detailsTarget.order_status) && (
                      <Badge variant="outline" className="text-[10px]">Read-only</Badge>
                    )}
                  </div>
                  {detailsTarget.supplier_id ? (
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-medium truncate">
                        {detailsTarget.supplier_name || 'Registered supplier'}
                      </p>
                      {isAgentOpsActionable(detailsTarget.order_status) && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2"
                          disabled={assignSupplier.isPending}
                          onClick={() => assignSupplier.mutate({ id: detailsTarget.id, supplier: null })}
                        >
                          <X className="h-3.5 w-3.5 mr-1" /> Clear
                        </Button>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-[11px] text-muted-foreground">
                        {isAgentOpsActionable(detailsTarget.order_status)
                          ? 'No supplier assigned yet. Search a registered user to supply this device.'
                          : 'No supplier assigned yet. Supplier assignment is locked once the application has left Agent Ops.'}
                      </p>
                      {isAgentOpsActionable(detailsTarget.order_status) && (
                        <>
                          <SupplierPicker value={supplierDraft} onChange={setSupplierDraft} />
                          <Button
                            size="sm"
                            className="h-8"
                            disabled={!supplierDraft || assignSupplier.isPending}
                            onClick={() =>
                              supplierDraft && assignSupplier.mutate({ id: detailsTarget.id, supplier: supplierDraft })
                            }
                          >
                            {assignSupplier.isPending ? (
                              <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Saving…</>
                            ) : (
                              <><Check className="h-3.5 w-3.5 mr-1" /> Assign supplier</>
                            )}
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                </div>

                <div className="rounded-lg border p-3 space-y-2">
                  <p className="text-xs font-semibold">Applicant profile &amp; standing</p>
                  {!detailsTarget.customer_id ? (
                    <p className="text-[11px] text-muted-foreground">No linked agent account.</p>
                  ) : applicantLoading ? (
                    <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                      <Loader2 className="h-3 w-3 animate-spin" /> Loading agent metrics…
                    </p>
                  ) : !applicant ? (
                    <p className="text-[11px] text-muted-foreground">Metrics unavailable for this agent.</p>
                  ) : (
                    <div className="space-y-2">
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                        <div className="rounded-md bg-muted/50 px-2 py-1.5">
                          <p className="text-[10px] text-muted-foreground">Active tenants</p>
                          <p className="text-xs font-semibold">
                            {Number(applicant.active_tenant_count || 0)}
                            <span className="text-muted-foreground font-normal">
                              {' '}/ {Number(applicant.required_active_tenants || 3)} guide
                            </span>
                          </p>
                        </div>
                        <div className="rounded-md bg-muted/50 px-2 py-1.5">
                          <p className="text-[10px] text-muted-foreground">Collections (30d)</p>
                          <p className="text-xs font-semibold">{formatUGX(Number(applicant.collected_30d || 0))}</p>
                        </div>
                        <div className="rounded-md bg-muted/50 px-2 py-1.5">
                          <p className="text-[10px] text-muted-foreground">Rank</p>
                          <p className="text-xs font-semibold">{applicant.rank ?? '—'}</p>
                        </div>
                        <div className="rounded-md bg-muted/50 px-2 py-1.5">
                          <p className="text-[10px] text-muted-foreground">Portfolio cap</p>
                          <p className="text-xs font-semibold">{formatUGX(Number(applicant.max_amount || 0))}</p>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        <Badge
                          variant="outline"
                          className={applicant.is_active_agent
                            ? 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30'
                            : 'bg-amber-500/15 text-amber-600 border-amber-500/30'}
                        >
                          {applicant.is_active_agent ? 'Active agent' : 'Agent status unconfirmed'}
                        </Badge>
                        <Badge
                          variant="outline"
                          className={agentProfile?.national_id || applicant.has_national_id
                            ? 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30'
                            : 'bg-amber-500/15 text-amber-600 border-amber-500/30'}
                        >
                          {agentProfile?.national_id
                            ? `✓ NIN: ${agentProfile.national_id}`
                            : applicant.has_national_id
                              ? '✓ National ID on profile'
                              : '⏳ ID declared — verify on collection day'}
                        </Badge>
                        <Badge
                          variant="outline"
                          className={applicant.has_workplace_verification
                            ? 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30'
                            : 'bg-amber-500/15 text-amber-600 border-amber-500/30'}
                        >
                          {applicant.has_workplace_verification ? '✓ Workplace captured' : '⏳ Workplace photo — bring on collection day'}
                        </Badge>
                        <Badge
                          variant="outline"
                          className={applicant.meets_tenant_guideline
                            ? 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30'
                            : 'bg-amber-500/15 text-amber-600 border-amber-500/30'}
                        >
                          {applicant.meets_tenant_guideline ? 'Meets tenant guideline' : 'Below tenant guideline'}
                        </Badge>
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        Applications are open to every agent — approve or reject on the standing above.
                      </p>
                    </div>
                  )}
                </div>

                <div className="rounded-lg border p-3 space-y-2">
                  <p className="text-xs font-semibold">Agent wallet (live)</p>
                  {!detailsTarget.customer_id ? (
                    <p className="text-[11px] text-muted-foreground">No linked agent account.</p>
                  ) : walletLoading ? (
                    <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                      <Loader2 className="h-3 w-3 animate-spin" /> Loading balances…
                    </p>
                  ) : (
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div className="rounded-md bg-muted/50 px-2 py-1.5">
                        <p className="text-[10px] text-muted-foreground">Withdrawable</p>
                        <p className="text-xs font-semibold">{formatUGX(Number(wallet?.withdrawable_balance || 0))}</p>
                      </div>
                      <div className="rounded-md bg-muted/50 px-2 py-1.5">
                        <p className="text-[10px] text-muted-foreground">Float</p>
                        <p className="text-xs font-semibold">{formatUGX(Number(wallet?.float_balance || 0))}</p>
                      </div>
                      <div className="rounded-md bg-muted/50 px-2 py-1.5">
                        <p className="text-[10px] text-muted-foreground">Advance</p>
                        <p className="text-xs font-semibold">{formatUGX(Number(wallet?.advance_balance || 0))}</p>
                      </div>
                    </div>
                  )}
                </div>

                {detailsTarget.rejection_reason && (
                  <p className="text-[11px] text-destructive">Rejected: {detailsTarget.rejection_reason}</p>
                )}

                {canActOnRow(detailsTarget.order_status) ? (
                  <DialogFooter className="gap-2 sm:gap-2">
                    <Button
                      variant="outline"
                      onClick={() => { setRejectTarget(detailsTarget); setRejectReason(''); }}
                    >
                      <X className="h-3.5 w-3.5 mr-1" /> Reject
                    </Button>
                    <Button
                      disabled={approve.isPending}
                      onClick={() => openApprove(detailsTarget)}
                    >
                      <Check className="h-3.5 w-3.5 mr-1" /> {stageActionLabel}
                    </Button>
                  </DialogFooter>
                ) : (
                  <div className="rounded-lg border p-3 space-y-2 bg-muted/30">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium">Current progress</span>
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline" className="text-[10px]">Read-only</Badge>
                        <Badge variant="outline" className={STATUS_TONE[detailsTarget.order_status] || ''}>
                          {isAwaitingCfo(detailsTarget.order_status)
                            ? 'Awaiting CFO Approval'
                            : isAwaitingCoo(detailsTarget.order_status)
                              ? 'Awaiting COO Approval'
                              : statusLabel(detailsTarget.order_status)}
                        </Badge>
                      </div>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      {isAwaitingCfo(detailsTarget.order_status)
                        ? 'The COO has approved this application. It is now with the CFO for supplier payment and can only be viewed here.'
                        : isAwaitingCoo(detailsTarget.order_status)
                          ? 'Agent Ops has approved this application. It is now with the COO for review and can only be viewed here.'
                          : 'This application has already been decided and is shown for reference only.'}
                    </p>
                  </div>
                )}


              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!approveTarget}
        onOpenChange={(o) => { if (!o && !approve.isPending) closeApprove(); }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Check className="h-4 w-4 text-primary" />
              {approveStage === 'cfo'
                ? 'Pay supplier & activate application'
                : approveStage === 'coo'
                  ? 'COO approval — forward to CFO'
                  : 'Agent Ops approval — forward to COO'}
            </DialogTitle>
          </DialogHeader>

          {approveTarget && (
            <div className="space-y-3">
              <div className="rounded-lg border divide-y">
                <div className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="text-xs text-muted-foreground">Agent</span>
                  <span className="text-xs font-semibold text-right truncate">
                    {approveTarget.client_name || 'Agent'}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="text-xs text-muted-foreground">Device</span>
                  <span className="text-xs font-semibold text-right truncate">
                    {[approveTarget.brand, approveTarget.model_type].filter(Boolean).join(' · ') || '—'}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="text-xs text-muted-foreground">
                    {approveStage === 'cfo'
                      ? 'COO approved amount'
                      : isMoBanjaIphone(approveTarget.brand, approveTarget.model_type)
                        ? MO_BANJA.amountLabel
                        : 'Phone amount'}
                  </span>
                  <span className="text-xs font-semibold">{formatUGX(phoneAmountNumber)}</span>
                </div>
              </div>

              <div className="space-y-1">
                <Label className="text-xs">
                  {approveStage === 'cfo'
                    ? 'Amount to pay the supplier (UGX)'
                    : 'Access Amount (down payment) — UGX'}
                </Label>

                <Input
                  type="number"
                  min={1000}
                  step={1000}
                  inputMode="numeric"
                  autoFocus={!termsLocked}
                  readOnly={termsLocked}
                  disabled={termsLocked}
                  placeholder="e.g. 1200000"
                  value={officialAmount}
                  onChange={(e) => setOfficialAmount(e.target.value)}
                />
                {termsLocked && (
                  <p className="text-[11px] text-muted-foreground">
                    Locked by Agent Operations — read-only at this stage.
                  </p>
                )}
              </div>

              {isReviewStage && (
                <>
                  <div className="space-y-1">
                    <Label className="text-xs" htmlFor="smartphone-repayment-days">
                      Repayment Period (Days)
                    </Label>
                    <Input
                      id="smartphone-repayment-days"
                      type="number"
                      min={1}
                      step={1}
                      inputMode="numeric"
                      readOnly={termsLocked}
                      disabled={termsLocked}
                      placeholder="e.g. 30"
                      value={repaymentDays}
                      onChange={(e) => setRepaymentDays(e.target.value)}
                    />
                  </div>

                  <div className="rounded-lg border border-primary/40 bg-primary/10 p-3 space-y-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Daily wallet deduction
                    </p>
                    <p className="text-2xl font-bold text-primary">
                      {formatUGX(dailyDeduction)} <span className="text-sm font-medium">/ day</span>
                    </p>
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div className="rounded-md bg-background/70 px-2 py-1.5">
                        <p className="text-[10px] text-muted-foreground">Interest (33%)</p>
                        <p className="text-xs font-semibold">{formatUGX(accessInterest)}</p>
                      </div>
                      <div className="rounded-md bg-background/70 px-2 py-1.5">
                        <p className="text-[10px] text-muted-foreground">Days</p>
                        <p className="text-xs font-semibold">{repaymentDaysNumber || '—'}</p>
                      </div>
                      <div className="rounded-md bg-background/70 px-2 py-1.5">
                        <p className="text-[10px] text-muted-foreground">Total payable</p>
                        <p className="text-xs font-semibold">{formatUGX(totalPayable)}</p>
                      </div>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      {formatUGX(dailyDeduction)} is deducted from the agent&apos;s wallet each day for{' '}
                      {repaymentDaysNumber || 0} days — {formatUGX(totalPayable)} in total. That is{' '}
                      {formatUGX(officialAmountNumber)} down payment + {formatUGX(accessInterest)} interest
                      (33%).
                    </p>

                  </div>
                </>
              )}

              <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-1">
                <p className="text-[11px] text-muted-foreground">Monthly Recovery Projection (33%)</p>
                <p className="text-lg font-bold text-primary">{formatUGX(officialProjection)}</p>
                <p className="text-[11px] text-muted-foreground">
                  {approveStage === 'cfo' ? (
                    <>
                      {formatUGX(officialAmountNumber)} is paid straight to the assigned supplier&apos;s
                      account, the application becomes active and the 33% wallet repayments start on the
                      applying agent.
                    </>
                  ) : (
                    <>
                      No money moves yet. The application is locked at {formatUGX(officialAmountNumber)} and
                      forwarded to {approveStage === 'ops' ? 'the COO' : 'the CFO'}, who
                      {approveStage === 'ops' ? ' reviews it before the CFO pays the supplier.' : ' pays the assigned supplier and activates it.'}
                    </>
                  )}
                </p>
              </div>

            </div>
          )}

          <DialogFooter>
            <Button variant="outline" disabled={approve.isPending} onClick={closeApprove}>
              Cancel
            </Button>
            <Button
              disabled={
                approve.isPending ||
                officialAmountNumber < 1000 ||
                !approveTarget ||
                (isReviewStage && repaymentDaysNumber < 1)
              }
              onClick={() =>
                approveTarget &&
                approve.mutate({
                  id: approveTarget.id,
                  amount: officialAmountNumber,
                  stage: approveStage,
                  daily: isReviewStage ? dailyDeduction : undefined,
                  days: isReviewStage ? repaymentDaysNumber : undefined,
                })
              }
            >

              {approve.isPending ? (
                <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Processing…</>
              ) : approveStage === 'cfo' ? (
                <><Check className="h-3.5 w-3.5 mr-1" /> Confirm supplier payment</>
              ) : (
                <><Check className="h-3.5 w-3.5 mr-1" /> Approve &amp; forward</>
              )}
            </Button>
          </DialogFooter>

        </DialogContent>
      </Dialog>


      <Dialog open={!!rejectTarget} onOpenChange={(o) => { if (!o) setRejectTarget(null); }}>
        <DialogContent className="max-w-sm">

          <DialogHeader>
            <DialogTitle>Reject smartphone order</DialogTitle>
          </DialogHeader>
          <Textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Reason (min 10 characters)"
            className="min-h-[80px]"
          />
          <DialogFooter>
            <Button variant="outline" disabled={reject.isPending} onClick={() => setRejectTarget(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={reject.isPending || rejectReason.trim().length < 10 || !rejectTarget}
              onClick={() => rejectTarget && reject.mutate({ id: rejectTarget.id, reason: rejectReason.trim() })}
            >
              {reject.isPending ? (
                <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Rejecting…</>
              ) : 'Reject order'}
            </Button>

          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Single Confirmation Dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Delete Smartphone Application?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-sm">
              Are you sure you want to permanently delete the application for{' '}
              <strong>{deleteTarget?.client_name || 'Agent'}</strong> ({deleteTarget?.brand || ''} {deleteTarget?.model_type || ''})?
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={deleteSingleOrder}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Trash2 className="h-4 w-4 mr-2" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete All Confirmation Dialog */}
      <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Delete All {filtered.length} Applications?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-sm">
              This will permanently delete all <strong>{filtered.length}</strong> rejected smartphone applications currently listed.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={deleteBulkOrders}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 font-bold"
            >
              {isDeleting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Trash2 className="h-4 w-4 mr-2" />}
              Yes, Delete All ({filtered.length})
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
