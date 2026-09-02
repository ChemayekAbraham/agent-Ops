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
import { Smartphone, Check, X, Loader2 } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { SupplierPicker, type SupplierChoice } from './SmartphoneCatalogDialog';
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
  coo_approved_at?: string | null;
  cfo_disbursed_at?: string | null;
  disbursed_amount?: number | null;
  access_daily_amount?: number | null;
  access_repayment_days?: number | null;
  supplier_id?: string | null;
  supplier_name?: string | null;
}


const STATUS_TONE: Record<string, string> = {
  pending_approval: 'bg-amber-500/15 text-amber-600 border-amber-500/30',
  submitted: 'bg-amber-500/15 text-amber-600 border-amber-500/30',
  coo_approved: 'bg-sky-500/15 text-sky-600 border-sky-500/30',
  approved: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30',
  completed: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30',
  rejected: 'bg-destructive/15 text-destructive border-destructive/30',
};

const STATUS_LABEL: Record<string, string> = {
  pending_approval: 'Awaiting COO',
  submitted: 'Awaiting COO',
  coo_approved: 'Awaiting CFO disbursement',
  approved: 'Disbursed & active',
};

const statusLabel = (s: string) => STATUS_LABEL[s] || s.replace(/_/g, ' ');

/** Stage 1 — application still needs the COO decision. */
const isPending = (s: string) => s === 'pending_approval' || s === 'submitted';
/** Stage 2 — COO approved, waiting for the CFO to release the funds. */
const isAwaitingCfo = (s: string) => s === 'coo_approved';
/** Anything the executives still have to act on. */
const isOpen = (s: string) => isPending(s) || isAwaitingCfo(s);

/**
 * Executive queue for agent smartphone applications — a two-stage flow:
 * stage 1 the COO approves the official amount and forwards the file to the
 * CFO (no money moves); stage 2 the CFO disburses the access amount into the
 * agent's wallet float, activates the order and starts the 33% recovery plan.
 * Rejecting at either stage requires a 10+ character reason.
 */
export function SmartphoneOrderApprovalQueue({ pendingOnly = false, rejectedOnly = false }: { pendingOnly?: boolean; rejectedOnly?: boolean } = {}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [rejectTarget, setRejectTarget] = useState<SmartphoneOrderRow | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [detailsTarget, setDetailsTarget] = useState<SmartphoneOrderRow | null>(null);
  const [approveTarget, setApproveTarget] = useState<SmartphoneOrderRow | null>(null);
  const [officialAmount, setOfficialAmount] = useState('');
  const [repaymentDays, setRepaymentDays] = useState('30');
  const [supplierDraft, setSupplierDraft] = useState<SupplierChoice | null>(null);

  const approveStage: 'coo' | 'cfo' = approveTarget && isAwaitingCfo(approveTarget.order_status) ? 'cfo' : 'coo';

  const openApprove = (o: SmartphoneOrderRow) => {
    setApproveTarget(o);
    const existing = Number(o.total_amount || 0);
    // COO stage: Access Amount = phone amount + 33% markup, saved as the approved
    // total price. CFO stage: the COO-approved amount is what gets disbursed.
    if (isAwaitingCfo(o.order_status)) {
      setOfficialAmount(existing > 0 ? String(Math.round(existing)) : '');
    } else {
      setOfficialAmount(existing > 0 ? String(Math.round(existing * 1.33)) : '');
    }
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
  // Difference = Access Amount (Total) − Phone Amount, spread over 30 days to get
  // the daily wallet deduction, then multiplied by the chosen number of days.
  const phoneAmountNumber = Math.max(0, Math.round(Number(approveTarget?.total_amount || 0)));
  const accessDifference = Math.max(0, officialAmountNumber - phoneAmountNumber);
  const dailyDeduction = Math.round(accessDifference / 30);
  const repaymentDaysNumber = Math.max(0, Math.round(Number(repaymentDays || 0) || 0));
  const totalPayable = dailyDeduction * repaymentDaysNumber;



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
    }: { id: string; amount: number; stage: 'coo' | 'cfo'; daily?: number; days?: number }) => {
      const { data, error } = await db.rpc(
        stage === 'cfo' ? 'cfo_disburse_smartphone_order' : 'coo_approve_smartphone_order',
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
    onSuccess: (data: any) => {
      if (data?.stage === 'cfo') {
        toast.success(
          `${formatUGX(Number(data?.total_amount || 0))} disbursed to the agent's wallet float. ${formatUGX(Number(data?.payment_projection || 0))}/month (33%) recovery plan activated.`,
        );
      } else {
        const daily = Number(data?.access_daily_amount || 0);
        toast.success(
          `Approved at ${formatUGX(Number(data?.total_amount || 0))}${daily > 0 ? ` · ${formatUGX(daily)}/day for ${Number(data?.access_repayment_days || 0)} days` : ''} and forwarded to the CFO for disbursement.`,
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

  const scoped = useMemo(
    () => (rejectedOnly ? orders.filter((o) => o.order_status === 'rejected') : pendingOnly ? orders.filter((o) => isOpen(o.order_status)) : orders),
    [orders, pendingOnly, rejectedOnly],
  );


  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return scoped;
    return scoped.filter((o) =>
      [o.client_name, o.client_phone, o.brand, o.model_type]
        .some((v) => (v || '').toLowerCase().includes(q)),
    );
  }, [scoped, search]);

  const pendingCount = useMemo(() => orders.filter((o) => isPending(o.order_status)).length, [orders]);
  const awaitingCfoCount = useMemo(() => orders.filter((o) => isAwaitingCfo(o.order_status)).length, [orders]);

  const rowBusy = (id: string) =>
    (approve.isPending && approve.variables?.id === id) ||
    (reject.isPending && reject.variables?.id === id);


  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Smartphone className="h-4 w-4 text-primary" />
          {rejectedOnly ? 'Rejected applications' : pendingOnly ? 'Pending applications' : 'Smartphone applications'}
          {rejectedOnly ? (
            <Badge variant="outline" className={STATUS_TONE.rejected}>{scoped.length} rejected</Badge>
          ) : (
            <>
              <Badge variant="secondary">{pendingCount} awaiting COO</Badge>
              <Badge variant="outline" className={STATUS_TONE.coo_approved}>
                {awaitingCfoCount} awaiting CFO
              </Badge>
            </>
          )}
        </CardTitle>
        {!rejectedOnly && (
          <p className="text-[11px] text-muted-foreground">
            Stage 1 — COO approves the official amount and forwards to the CFO. Stage 2 — CFO releases the
            amount into the agent's wallet float and activates the 33% recovery plan.
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
            {rejectedOnly ? 'No rejected applications.' : pendingOnly ? 'No applications awaiting approval.' : 'No smartphone orders yet.'}
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
                  <Badge variant="outline" className={STATUS_TONE[o.order_status] || ''}>
                    {statusLabel(o.order_status)}
                  </Badge>

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
                    <p className="text-[10px] text-muted-foreground">Phone amount</p>
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

                {isOpen(o.order_status) && (
                  <div className="flex flex-wrap gap-2" onClick={(e) => e.stopPropagation()}>
                    <Button
                      size="sm"
                      onClick={() => openApprove(o)}
                      disabled={rowBusy(o.id)}
                    >
                      {approve.isPending && approve.variables?.id === o.id ? (
                        <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Processing…</>
                      ) : isAwaitingCfo(o.order_status) ? (
                        <><Check className="h-3.5 w-3.5 mr-1" /> Disburse &amp; activate</>
                      ) : (
                        <><Check className="h-3.5 w-3.5 mr-1" /> Approve &amp; send to CFO</>
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
            const projection = Number(detailsTarget.payment_projection || Math.round(total * 0.33));
            const rows: Array<[string, string]> = [
              ['Agent', detailsTarget.client_name || 'Agent'],
              ['Phone number', detailsTarget.client_phone || '—'],
              ['Submitted', format(new Date(detailsTarget.created_at), 'dd MMM yyyy HH:mm')],
              ['Brand', detailsTarget.brand || '—'],
              ['Model', detailsTarget.model_type || '—'],
              ['Phone amount', formatUGX(total)],
              ['Projection (33%)', formatUGX(projection)],
              ['Access Amount (Total)', formatUGX(Math.round(total * 1.33))],
              ['Amount paid', formatUGX(Number(detailsTarget.amount_paid || 0))],

              ['Outstanding', formatUGX(Number(detailsTarget.amount_outstanding || 0))],
            ];
            const savedDaily = Number(detailsTarget.access_daily_amount || 0);
            const savedDays = Number(detailsTarget.access_repayment_days || 0);
            if (savedDaily > 0) {
              rows.push(['Daily deduction', `${formatUGX(savedDaily)} / day`]);
            }
            if (savedDays > 0) {
              rows.push(['Repayment period', `${savedDays} days`]);
              if (savedDaily > 0) rows.push(['Total payable', formatUGX(savedDaily * savedDays)]);
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

                <div className="rounded-lg border p-3 space-y-2">
                  <p className="text-xs font-semibold">Supplier</p>
                  {detailsTarget.supplier_id ? (
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-medium truncate">
                        {detailsTarget.supplier_name || 'Registered supplier'}
                      </p>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2"
                        disabled={assignSupplier.isPending}
                        onClick={() => assignSupplier.mutate({ id: detailsTarget.id, supplier: null })}
                      >
                        <X className="h-3.5 w-3.5 mr-1" /> Clear
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-[11px] text-muted-foreground">
                        No supplier assigned yet. Search a registered user to supply this device.
                      </p>
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
                          className={applicant.has_national_id
                            ? 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30'
                            : 'bg-destructive/15 text-destructive border-destructive/30'}
                        >
                          National ID {applicant.has_national_id ? 'verified' : 'missing'}
                        </Badge>
                        <Badge
                          variant="outline"
                          className={applicant.has_workplace_verification
                            ? 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30'
                            : 'bg-amber-500/15 text-amber-600 border-amber-500/30'}
                        >
                          Workplace {applicant.has_workplace_verification ? 'captured' : 'not captured'}
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

                {isOpen(detailsTarget.order_status) && (
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
                      <Check className="h-3.5 w-3.5 mr-1" />
                      {isAwaitingCfo(detailsTarget.order_status) ? 'Disburse & activate' : 'Approve & send to CFO'}
                    </Button>

                  </DialogFooter>
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
              {approveStage === 'cfo' ? 'Disburse & activate application' : 'COO approval — forward to CFO'}
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
                    {approveStage === 'cfo' ? 'COO approved amount' : 'Phone amount'}
                  </span>
                  <span className="text-xs font-semibold">{formatUGX(phoneAmountNumber)}</span>
                </div>
              </div>

              <div className="space-y-1">
                <Label className="text-xs">
                  {approveStage === 'cfo' ? 'Amount to disburse (UGX)' : 'Access Amount (Total) — UGX'}
                </Label>
                <Input
                  type="number"
                  min={1000}
                  step={1000}
                  inputMode="numeric"
                  autoFocus
                  placeholder="e.g. 1200000"
                  value={officialAmount}
                  onChange={(e) => setOfficialAmount(e.target.value)}
                />
              </div>

              {approveStage === 'coo' && (
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
                        <p className="text-[10px] text-muted-foreground">Difference</p>
                        <p className="text-xs font-semibold">{formatUGX(accessDifference)}</p>
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
                      {repaymentDaysNumber || 0} days — {formatUGX(totalPayable)} in total. Difference ={' '}
                      {formatUGX(officialAmountNumber)} − {formatUGX(phoneAmountNumber)}, spread over 30 days.
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
                      {formatUGX(officialAmountNumber)} will be released into the agent&apos;s wallet float
                      (company money, not withdrawable), the application becomes active and 33% wallet
                      repayments begin.
                    </>
                  ) : (
                    <>
                      No money moves yet. The application is locked at {formatUGX(officialAmountNumber)} and
                      forwarded to the CFO, who releases the funds and activates it.
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
                (approveStage === 'coo' && repaymentDaysNumber < 1)
              }
              onClick={() =>
                approveTarget &&
                approve.mutate({
                  id: approveTarget.id,
                  amount: officialAmountNumber,
                  stage: approveStage,
                  daily: approveStage === 'coo' ? dailyDeduction : undefined,
                  days: approveStage === 'coo' ? repaymentDaysNumber : undefined,
                })
              }
            >

              {approve.isPending ? (
                <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Processing…</>
              ) : approveStage === 'cfo' ? (
                <><Check className="h-3.5 w-3.5 mr-1" /> Confirm disbursement</>
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
    </Card>
  );
}
