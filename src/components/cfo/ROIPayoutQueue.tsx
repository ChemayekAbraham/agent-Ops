import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { CheckCircle, XCircle, Loader2, Wallet, Pencil, Eye, Banknote, ArrowRight, Users, ShieldCheck } from 'lucide-react';
import { TreasuryImpactBanner } from './TreasuryImpactBanner';
import { format } from 'date-fns';
import { CfoApprovalGate } from '@/components/cfo/CfoApprovalGate';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';

interface PendingOp {
  id: string;
  user_id: string | null;
  amount: number;
  category: string;
  description: string | null;
  status: string;
  created_at: string;
  reference_id: string | null;
  operation_type: string | null;
  target_wallet_user_id: string | null;
  metadata: Record<string, any> | null;
}

const formatUGX = (n: number) => `UGX ${n.toLocaleString()}`;

export function ROIPayoutQueue() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [rejectionReasons, setRejectionReasons] = useState<Record<string, string>>({});
  // CFO-editable payout amounts, keyed by operation id. Empty until the CFO edits.
  const [editedAmounts, setEditedAmounts] = useState<Record<string, string>>({});
  const [reviewTarget, setReviewTarget] = useState<PendingOp | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Reset reject-mode whenever the reviewed operation changes or the sheet closes.
  useEffect(() => {
    setRejectingId(null);
  }, [reviewTarget?.id]);

  const { data: operations = [], isLoading } = useQuery({
    queryKey: ['cfo-roi-requests', 'coo_approved'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('pending_wallet_operations')
        .select('*')
        .eq('category', 'roi_payout')
        .eq('status', 'coo_approved')
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data || []) as PendingOp[];
    },
  });

  const userIds = [...new Set(operations.flatMap(op => [op.user_id, op.target_wallet_user_id].filter(Boolean) as string[]))];
  const { data: profiles = [] } = useQuery({
    queryKey: ['roi-queue-profiles', userIds.join(',')],
    queryFn: async () => {
      if (userIds.length === 0) return [];
      const { data } = await supabase.from('profiles').select('id, full_name, phone').in('id', userIds);
      return data || [];
    },
    enabled: userIds.length > 0,
  });

  const getName = (id: string | null) => {
    if (!id) return '—';
    const p = profiles.find(pr => pr.id === id);
    return p?.full_name || id.slice(0, 8);
  };

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['cfo-roi-requests'] });
    qc.invalidateQueries({ queryKey: ['roi-payout-queue-count'] });
    qc.invalidateQueries({ queryKey: ['cfo-actions-log'] });
    qc.invalidateQueries({ queryKey: ['treasury-cash-snapshot'] });
  };

  const approveMutation = useMutation({
    mutationFn: async ({ opId, overrideAmount }: { opId: string; overrideAmount?: number }) => {
      const op = operations.find(o => o.id === opId);
      const finalAmount = overrideAmount ?? op?.amount;
      const { data, error } = await supabase.functions.invoke('approve-wallet-operation', {
        body: { operation_id: opId, action: 'approve', ...(overrideAmount !== undefined ? { override_amount: overrideAmount } : {}) },
      });
      if (error) throw error;
      await supabase.from('audit_logs').insert({
        user_id: user?.id,
        action_type: 'cfo_roi_payout_approved',
        table_name: 'pending_wallet_operations',
        record_id: opId,
        metadata: {
          amount: finalAmount,
          original_amount: op?.amount,
          amount_edited: overrideAmount !== undefined && overrideAmount !== op?.amount,
          target_user_id: op?.target_wallet_user_id || op?.user_id,
          description: op?.description,
          source: 'send_money_inline',
        },
      });
      return data;
    },
    onSuccess: () => {
      toast.success('ROI payout approved — wallet credited');
      setReviewTarget(null);
      invalidate();
    },
    onError: (err: any) => toast.error('Approval failed', { description: err.message }),
  });

  const rejectMutation = useMutation({
    mutationFn: async ({ opId, reason }: { opId: string; reason: string }) => {
      const op = operations.find(o => o.id === opId);
      const { data, error } = await supabase.functions.invoke('approve-wallet-operation', {
        body: { operation_id: opId, action: 'reject', rejection_reason: reason },
      });
      if (error) throw error;
      await supabase.from('audit_logs').insert({
        user_id: user?.id,
        action_type: 'cfo_roi_payout_rejected',
        table_name: 'pending_wallet_operations',
        record_id: opId,
        metadata: {
          amount: op?.amount,
          target_user_id: op?.target_wallet_user_id || op?.user_id,
          reason,
          source: 'send_money_inline',
        },
      });
      return data;
    },
    onSuccess: () => {
      toast.success('ROI payout rejected');
      setReviewTarget(null);
      invalidate();
    },
    onError: (err: any) => toast.error('Rejection failed', { description: err.message }),
  });

  // Bulk approve: re-fetches the live COO-approved queue at click time (never the
  // React Query cache) and approves each payout through the same edge function
  // and audit trail as the single-approve path.
  const bulkApproveMutation = useMutation({
    mutationFn: async () => {
      const { data: fresh, error: fetchErr } = await supabase
        .from('pending_wallet_operations')
        .select('id, amount, user_id, target_wallet_user_id, description')
        .eq('category', 'roi_payout')
        .eq('status', 'coo_approved')
        .in('id', Array.from(selectedIds))
        .order('created_at', { ascending: false })
        .limit(100);
      if (fetchErr) throw fetchErr;
      const ops = (fresh || []) as Pick<PendingOp, 'id' | 'amount' | 'user_id' | 'target_wallet_user_id' | 'description'>[];
      // Safety re-check (mirrors Rent Payout Queue): refuse the whole batch if any
      // selected payout is no longer COO-approved, before any payment is invoked.
      if (selectedIds.size === 0) throw new Error('Select at least one payout');
      if (ops.length !== selectedIds.size) {
        throw new Error('The payment queue changed. Close this review and select eligible payouts again.');
      }
      let approved = 0;
      let failed = 0;
      let lastError = '';
      for (const op of ops) {
        const { error: fnError } = await supabase.functions.invoke('approve-wallet-operation', {
          body: { operation_id: op.id, action: 'approve' },
        });
        if (fnError) {
          failed++;
          lastError = fnError.message;
          continue;
        }
        await supabase.from('audit_logs').insert({
          user_id: user?.id,
          action_type: 'cfo_roi_payout_approved',
          table_name: 'pending_wallet_operations',
          record_id: op.id,
          metadata: {
            amount: op.amount,
            original_amount: op.amount,
            amount_edited: false,
            target_user_id: op.target_wallet_user_id || op.user_id,
            description: op.description,
            source: 'approve_all_bulk',
          },
        });
        approved++;
      }
      return { approved, failed, lastError, total: ops.length };
    },
    onSuccess: ({ approved, failed, lastError, total }) => {
      setSelectedIds(new Set());
      setBulkConfirm(false);
      invalidate();
      if (failed === 0) {
        toast.success(`Approved all ${approved} payout${approved === 1 ? '' : 's'}`);
      } else {
        toast.warning(`Approved ${approved} of ${total}`, { description: `${failed} failed${lastError ? `: ${lastError}` : ''}. They remain in the queue.` });
      }
    },
    onError: (err: any) => {
      setBulkConfirm(false);
      toast.error('Approve all failed', { description: err.message });
    },
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-6">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (operations.length === 0) {
    return (
      <div className="rounded-lg border py-6 text-center text-sm text-muted-foreground">
        No COO-approved ROI payouts waiting for CFO approval.
      </div>
    );
  }

  const payeeLabel = (op: PendingOp) => {
    const meta = op.metadata as Record<string, any> | null;
    return meta?.partner_name || getName(op.user_id);
  };

  const targetLabel = (op: PendingOp) => {
    const meta = op.metadata as Record<string, any> | null;
    const isAltWallet = op.operation_type === 'roi_split_alt_wallet';
    if (isAltWallet) return meta?.alt_recipient_name || getName(op.target_wallet_user_id);
    return meta?.target_agent_name || getName(op.target_wallet_user_id);
  };

  const routeBadge = (op: PendingOp) => {
    const isAltWallet = op.operation_type === 'roi_split_alt_wallet';
    const isProxy = !!op.target_wallet_user_id && !isAltWallet;
    if (isAltWallet) return <Badge className="text-[9px] px-2 py-0 rounded-full bg-amber-100 text-amber-700 border-amber-200">Different Wallet</Badge>;
    if (isProxy) return <Badge className="text-[9px] px-2 py-0 rounded-full bg-emerald-100 text-emerald-700 border-emerald-200">Proxy Agent</Badge>;
    return <Badge className="text-[9px] px-2 py-0 rounded-full bg-muted text-muted-foreground border-border">Own Wallet</Badge>;
  };

  const reviewMeta = reviewTarget?.metadata as Record<string, any> | null;
  const reviewEditedRaw = reviewTarget ? editedAmounts[reviewTarget.id] : undefined;
  const reviewHasEdit = reviewEditedRaw !== undefined && reviewEditedRaw !== '';
  const reviewEditedAmount = reviewTarget ? (reviewHasEdit ? Math.round(Number(reviewEditedRaw)) : reviewTarget.amount) : 0;
  const reviewEditValid = !reviewHasEdit || (Number.isFinite(reviewEditedAmount) && reviewEditedAmount > 0);
  const reviewAmountChanged = !!reviewTarget && reviewHasEdit && reviewEditValid && reviewEditedAmount !== reviewTarget.amount;
  const reviewRejReason = reviewTarget ? rejectionReasons[reviewTarget.id] || '' : '';

  const selectedOps = operations.filter(op => selectedIds.has(op.id));
  const bulkTotal = selectedOps.reduce((sum, op) => sum + (op.amount || 0), 0);
  const allSelected = operations.length > 0 && selectedOps.length === operations.length;
  const selectAll = () => setSelectedIds(new Set(operations.map(op => op.id)));
  const clearSelection = () => { setSelectedIds(new Set()); setBulkConfirm(false); };
  // Selection only: opens the review screen. Never pays anything.
  const selectAllForPayment = () => {
    if (operations.length === 0) return;
    if (selectedOps.length === 0) selectAll();
    setBulkConfirm(true);
  };
  const toggleOne = (id: string) => {
    setBulkConfirm(false);
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          {operations.length} ROI payout{operations.length === 1 ? '' : 's'} ready for CFO approval
          {selectedOps.length > 0 && (
            <span className="ml-2 normal-case tracking-normal text-primary">
              {selectedOps.length} selected · {formatUGX(bulkTotal)}
            </span>
          )}
        </p>
        <div className="flex items-center gap-2">
          {selectedOps.length > 0 && (
            <Button size="sm" variant="ghost" className="h-9 rounded-lg text-xs" onClick={clearSelection}>
              Clear
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            className="h-9 rounded-lg gap-2"
            disabled={operations.length === 0}
            onClick={selectAllForPayment}
          >
            <Banknote className="h-4 w-4" />
            {selectedOps.length > 0
              ? `${selectedOps.length} Payout${selectedOps.length === 1 ? '' : 's'} Selected — Review Payment`
              : 'Select All for Payment'}
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="rounded-xl border border-border/70 overflow-hidden bg-card">
        <div className="overflow-x-auto max-h-[560px] overflow-y-auto">
          <table className="w-full text-sm min-w-[52rem]">
            <thead className="sticky top-0 z-10">
              <tr className="border-b border-border/70 bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="w-10 px-2 py-2 text-center">
                  <Checkbox
                    checked={allSelected ? true : selectedIds.size > 0 ? 'indeterminate' : false}
                    onCheckedChange={() => (allSelected ? clearSelection() : selectAll())}
                    aria-label="Select all payouts"
                    className="h-4 w-4 rounded-[4px] border-muted-foreground/40"
                  />
                </th>
                <th className="w-10 px-2 py-2 text-center font-semibold">#</th>
                <th className="px-2 py-2 text-left font-semibold">Payee</th>
                <th className="px-2 py-2 text-left font-semibold">Payout to</th>
                <th className="px-2 py-2 text-right font-semibold">Amount</th>
                <th className="px-2 py-2 text-left font-semibold">Date &amp; time</th>
                <th className="px-2 py-2 text-left font-semibold">Status</th>
                <th className="px-2 py-2 text-right font-semibold">View</th>
              </tr>
            </thead>
            <tbody>
              {operations.map((op, index) => {
                const isNew = Date.now() - new Date(op.created_at).getTime() < 24 * 60 * 60 * 1000;
                return (
                  <tr
                    key={op.id}
                    onClick={() => setReviewTarget(op)}
                    className={`border-b border-border/70 last:border-0 cursor-pointer transition-colors hover:bg-muted/40 ${selectedIds.has(op.id) ? 'bg-primary/5' : ''}`}
                  >
                    <td className="w-10 px-2 py-2.5 align-middle text-center" onClick={e => e.stopPropagation()}>
                      <Checkbox
                        checked={selectedIds.has(op.id)}
                        onCheckedChange={() => toggleOne(op.id)}
                        aria-label={`Select payout for ${payeeLabel(op)}`}
                        className="h-4 w-4 rounded-[4px] border-muted-foreground/40 data-[state=checked]:border-primary"
                      />
                    </td>
                    <td className="w-10 px-2 py-2.5 align-middle text-center">
                      <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-muted/60 text-[10px] font-medium text-muted-foreground">
                        {index + 1}
                      </span>
                    </td>
                    <td className="px-2 py-2.5 align-middle">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="truncate font-semibold">{payeeLabel(op)}</span>
                        {isNew && (
                          <Badge className="text-[9px] px-1.5 py-0 shrink-0 bg-emerald-500 text-white border-0">
                            NEW
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-2 py-2.5 align-middle">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <Wallet className="h-3.5 w-3.5 text-primary shrink-0" />
                        <span className="truncate font-semibold text-primary max-w-[10rem]">{targetLabel(op)}</span>
                        {routeBadge(op)}
                      </div>
                    </td>
                    <td className="px-2 py-2.5 align-middle text-right font-bold text-primary whitespace-nowrap">
                      {formatUGX(op.amount)}
                    </td>
                    <td className="px-2 py-2.5 align-middle text-[11px] text-muted-foreground whitespace-nowrap">
                      {format(new Date(op.created_at), 'dd MMM yyyy, HH:mm')}
                    </td>
                    <td className="px-2 py-2.5 align-middle whitespace-nowrap">
                      <Badge variant="secondary">COO Approved</Badge>
                    </td>
                    <td className="px-2 py-2.5 align-middle text-right whitespace-nowrap" onClick={e => e.stopPropagation()}>
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0 text-xs h-8 rounded-lg"
                        onClick={() => setReviewTarget(op)}
                      >
                        <Eye className="h-3 w-3 mr-1" />
                        View
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <Sheet open={bulkConfirm} onOpenChange={(o) => { if (!bulkApproveMutation.isPending) setBulkConfirm(o); }}>
        <SheetContent side="center" className="max-h-[88vh] w-[94vw] sm:max-w-3xl overflow-y-auto rounded-xl p-0">
          <div className="space-y-5 p-5 sm:p-6">
            <SheetHeader>
              <SheetTitle className="text-xl">Review bulk ROI payment</SheetTitle>
              <SheetDescription>Review every selected payout before authorising the payment.</SheetDescription>
            </SheetHeader>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
                <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <Users className="h-4 w-4 text-primary" /> Payouts selected
                </div>
                <p className="mt-2 text-3xl font-bold text-foreground">{selectedOps.length}</p>
              </div>
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
                <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <Banknote className="h-4 w-4 text-primary" /> Total payment
                </div>
                <p className="mt-2 text-3xl font-bold text-primary">{formatUGX(bulkTotal)}</p>
              </div>
            </div>
            <TreasuryImpactBanner payoutAmount={bulkTotal} />
            <div className="space-y-2">
              <p className="text-sm font-semibold">Payment details</p>
              <div className="max-h-64 overflow-y-auto rounded-lg border border-border/70 divide-y divide-border/60">
                {selectedOps.map(op => (
                  <label key={op.id} className="flex cursor-pointer items-center gap-3 px-3 py-3 hover:bg-muted/30">
                    <Checkbox
                      checked={selectedIds.has(op.id)}
                      onCheckedChange={() => setSelectedIds(prev => { const n = new Set(prev); n.delete(op.id); return n; })}
                      aria-label={`Remove ${payeeLabel(op)} from payment`}
                      className="h-4 w-4 rounded-[4px]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{payeeLabel(op)}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        To {targetLabel(op)} · Ref {op.reference_id || '—'}
                      </span>
                    </span>
                    <span className="shrink-0 text-sm font-bold">{formatUGX(op.amount)}</span>
                  </label>
                ))}
                {selectedOps.length === 0 && (
                  <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                    No payouts selected. Close this review and select eligible payouts again.
                  </div>
                )}
              </div>
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                No payment is made until you click Confirm &amp; Pay Selected.
              </p>
            </div>
            <SheetFooter className="border-t border-border/70 pt-4">
              <Button type="button" variant="outline" onClick={() => setBulkConfirm(false)} disabled={bulkApproveMutation.isPending}>
                Back to list
              </Button>
              <CfoApprovalGate>
                <Button
                  type="button"
                  onClick={() => bulkApproveMutation.mutate()}
                  disabled={bulkApproveMutation.isPending || selectedOps.length === 0}
                >
                  {bulkApproveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Banknote className="h-4 w-4" />}
                  Confirm &amp; Pay Selected
                </Button>
              </CfoApprovalGate>
            </SheetFooter>
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={!!reviewTarget} onOpenChange={(o) => { if (!o) setReviewTarget(null); }}>
        <SheetContent side="center" className="max-h-[70vh] w-[80vw] sm:max-w-xs overflow-y-auto rounded-xl p-4">
          {reviewTarget && (
            <div className="space-y-4">
              <SheetHeader>
                <SheetTitle>ROI payout review</SheetTitle>
                <SheetDescription>
                  COO-approved payout for {payeeLabel(reviewTarget)}.
                </SheetDescription>
              </SheetHeader>

              <div className="rounded-xl border border-border/70 divide-y divide-border/60 text-sm">
                {[
                  { label: 'Payee', value: payeeLabel(reviewTarget) },
                  { label: 'Payout to', value: targetLabel(reviewTarget) },
                  { label: 'Amount', value: formatUGX(reviewTarget.amount) },
                  { label: 'Submitted', value: format(new Date(reviewTarget.created_at), 'dd MMM yyyy, HH:mm') },
                  { label: 'Reference', value: reviewTarget.reference_id || '—' },
                ].map(row => (
                  <div key={row.label} className="flex items-start justify-between gap-3 px-3 py-2">
                    <span className="text-xs text-muted-foreground shrink-0">{row.label}</span>
                    <span className="font-medium text-right break-all">{row.value}</span>
                  </div>
                ))}
              </div>

              {reviewTarget.description && (
                <div className="rounded-xl border border-border/70 bg-muted/20 px-3 py-2.5">
                  <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">Details</p>
                  <p className="text-xs leading-relaxed">{reviewTarget.description}</p>
                </div>
              )}

              {/* CFO-editable payout amount */}
              <div className="space-y-2">
                <Label className="text-[11px] flex items-center gap-1 text-muted-foreground">
                  <Pencil className="h-3 w-3" /> Payout amount (editable)
                </Label>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={reviewEditedRaw ?? String(reviewTarget.amount)}
                  onChange={e => setEditedAmounts(prev => ({ ...prev, [reviewTarget.id]: e.target.value }))}
                  className="h-9 text-sm font-mono"
                />
                {!reviewEditValid && (
                  <p className="text-[11px] text-destructive">Enter a valid amount greater than 0.</p>
                )}
                {reviewAmountChanged && (
                  <p className="text-[11px] text-muted-foreground">
                    Original: <span className="line-through">{formatUGX(reviewTarget.amount)}</span>
                  </p>
                )}
                <CfoApprovalGate>
                  <Button
                    size="sm"
                    className="w-full"
                    onClick={() => approveMutation.mutate({ opId: reviewTarget.id, overrideAmount: reviewAmountChanged ? reviewEditedAmount : undefined })}
                    disabled={approveMutation.isPending || !reviewEditValid}
                  >
                    {approveMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <CheckCircle className="h-3.5 w-3.5 mr-1" />}
                    {reviewAmountChanged ? `Approve ${formatUGX(reviewEditedAmount)}` : 'Approve'}
                  </Button>
                </CfoApprovalGate>
              </div>

              {/* Rejection */}
              {rejectingId !== reviewTarget.id ? (
                <CfoApprovalGate>
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full border-destructive/30 text-destructive hover:bg-destructive/5 hover:text-destructive"
                    onClick={() => setRejectingId(reviewTarget.id)}
                  >
                    <XCircle className="h-3.5 w-3.5 mr-1" />
                    Reject
                  </Button>
                </CfoApprovalGate>
              ) : (
                <div className="space-y-2">
                  <Label className="text-[11px] text-muted-foreground">Rejection reason (min 10 chars)</Label>
                  <Textarea
                    placeholder="Why is this payout being rejected?"
                    value={reviewRejReason}
                    onChange={e => setRejectionReasons(prev => ({ ...prev, [reviewTarget.id]: e.target.value }))}
                    className="text-xs min-h-[60px]"
                    rows={2}
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1"
                      onClick={() => setRejectingId(null)}
                    >
                      Cancel
                    </Button>
                    <CfoApprovalGate>
                      <Button
                        size="sm"
                        variant="destructive"
                        className="flex-1"
                        disabled={reviewRejReason.length < 10 || rejectMutation.isPending}
                        onClick={() => rejectMutation.mutate({ opId: reviewTarget.id, reason: reviewRejReason })}
                      >
                        {rejectMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <XCircle className="h-3.5 w-3.5 mr-1" />}
                        Confirm Reject
                      </Button>
                    </CfoApprovalGate>
                  </div>
                </div>
              )}

              {/* Treasury impact */}
              <TreasuryImpactBanner payoutAmount={reviewEditValid ? reviewEditedAmount : reviewTarget.amount} />
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
