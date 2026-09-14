import { useState, Fragment } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { CheckCircle, XCircle, Loader2, User, Wallet, Pencil, TrendingUp } from 'lucide-react';
import { TreasuryImpactBanner } from './TreasuryImpactBanner';
import { format } from 'date-fns';

interface PendingOp {
  id: string;
  user_id: string | null;
  amount: number;
  category: string;
  description: string | null;
  status: string;
  created_at: string;
  reference_id: string | null;
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
      invalidate();
    },
    onError: (err: any) => toast.error('Rejection failed', { description: err.message }),
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-6">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <Card className="overflow-hidden rounded-2xl border-border/70 shadow-sm">
      <CardHeader className="pb-0 space-y-0 p-0">
        {/* Title band */}
        <div className="flex items-start justify-between gap-4 flex-wrap px-5 pt-5 pb-4">
          <div className="flex items-start gap-3.5 min-w-0">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-md shadow-primary/25">
              <TrendingUp className="h-6 w-6" />
            </span>
            <div className="min-w-0 space-y-1">
              <CardTitle className="text-xl sm:text-2xl font-extrabold tracking-tight">
                ROI Payout Queue
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                COO-approved ROI payouts waiting for CFO approval.
              </p>
              <div className="flex items-center gap-4 flex-wrap pt-1 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <Wallet className="h-3.5 w-3.5" />
                  {operations.length} payout{operations.length === 1 ? '' : 's'} in queue
                </span>
              </div>
            </div>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4 p-5">
        {operations.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            No COO-approved ROI payouts waiting for CFO approval.
          </div>
        ) : (
          <div className="rounded-xl border border-border/70 overflow-hidden bg-card">
            <div className="overflow-x-auto max-h-[560px] overflow-y-auto">
              <table className="w-full text-sm min-w-[48rem]">
                <thead className="sticky top-0 z-10">
                  <tr className="border-b border-border/70 bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="w-10 px-2 py-2 text-center font-semibold">#</th>
                    <th className="px-2 py-2 text-left font-semibold">Payee</th>
                    <th className="px-2 py-2 text-left font-semibold">Recipient</th>
                    <th className="px-2 py-2 text-right font-semibold">Amount</th>
                    <th className="px-2 py-2 text-left font-semibold">Submitted</th>
                    <th className="px-2 py-2 text-left font-semibold">Status</th>
                    <th className="px-2 py-2 text-right font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {operations.map((op, index) => {
                    const meta = op.metadata as Record<string, any> | null;
                    const isProxy = !!op.target_wallet_user_id;
                    const rejReason = rejectionReasons[op.id] || '';
                    const editedRaw = editedAmounts[op.id];
                    const hasEdit = editedRaw !== undefined && editedRaw !== '';
                    const editedAmount = hasEdit ? Math.round(Number(editedRaw)) : op.amount;
                    const editValid = !hasEdit || (Number.isFinite(editedAmount) && editedAmount > 0);
                    const amountChanged = hasEdit && editValid && editedAmount !== op.amount;
                    const rowNumber = index + 1;

                    return (
                      <Fragment key={op.id}>
                        <tr className="border-b border-border/70 last:border-0 hover:bg-muted/40 transition-colors">
                          <td className="w-10 px-2 py-2.5 align-middle text-center">
                            <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-muted/60 text-[10px] font-medium text-muted-foreground">
                              {rowNumber}
                            </span>
                          </td>
                          <td className="px-2 py-2.5 align-middle">
                            <div className="flex items-center gap-2 flex-wrap">
                              <User className="h-4 w-4 text-muted-foreground" />
                              <span className="font-semibold">{meta?.partner_name || getName(op.user_id)}</span>
                            </div>
                            {op.description && (
                              <p className="text-xs text-muted-foreground mt-1 max-w-md">{op.description}</p>
                            )}
                          </td>
                          <td className="px-2 py-2.5 align-middle">
                            {isProxy ? (
                              <div className="flex items-center gap-2 flex-wrap">
                                <Wallet className="h-4 w-4 text-primary" />
                                <span className="font-semibold text-primary">{meta?.target_agent_name || getName(op.target_wallet_user_id)}</span>
                                <Badge variant="outline" className="text-xs">Proxy Agent</Badge>
                              </div>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-2 py-2.5 align-middle text-right">
                            <p className="font-bold text-primary">{formatUGX(editValid ? editedAmount : op.amount)}</p>
                            {amountChanged && (
                              <p className="text-[11px] text-muted-foreground">
                                Original: <span className="line-through">{formatUGX(op.amount)}</span>
                              </p>
                            )}
                          </td>
                          <td className="px-2 py-2.5 align-middle text-[11px] text-muted-foreground whitespace-nowrap">
                            {format(new Date(op.created_at), 'dd MMM yyyy, HH:mm')}
                            <br />
                            Ref: {op.reference_id || '—'}
                          </td>
                          <td className="px-2 py-2.5 align-middle">
                            <Badge variant="secondary">COO Approved</Badge>
                          </td>
                          <td className="px-2 py-2.5 align-middle text-right whitespace-nowrap">
                            <div className="flex justify-end gap-2">
                              <Button
                                size="sm"
                                onClick={() => approveMutation.mutate({ opId: op.id, overrideAmount: amountChanged ? editedAmount : undefined })}
                                disabled={approveMutation.isPending || !editValid}
                              >
                                {approveMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <CheckCircle className="h-3.5 w-3.5 mr-1" />}
                                {amountChanged ? `Approve ${formatUGX(editedAmount)}` : 'Approve'}
                              </Button>
                              <Button
                                size="sm"
                                variant="destructive"
                                disabled={rejReason.length < 10 || rejectMutation.isPending}
                                onClick={() => rejectMutation.mutate({ opId: op.id, reason: rejReason })}
                              >
                                {rejectMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <XCircle className="h-3.5 w-3.5 mr-1" />}
                                Reject
                              </Button>
                            </div>
                          </td>
                        </tr>

                        <tr className="border-b border-border/70 bg-muted/30">
                          <td colSpan={7} className="px-2 py-3">
                            <div className="grid gap-4 md:grid-cols-[240px_1fr_320px] items-start">
                              {/* CFO-editable payout amount */}
                              <div className="space-y-2">
                                <Label className="text-[11px] flex items-center gap-1 text-muted-foreground">
                                  <Pencil className="h-3 w-3" /> Payout amount (editable)
                                </Label>
                                <Input
                                  type="number"
                                  inputMode="numeric"
                                  min={1}
                                  value={editedRaw ?? String(op.amount)}
                                  onChange={e => setEditedAmounts(prev => ({ ...prev, [op.id]: e.target.value }))}
                                  className="h-9 text-sm font-mono"
                                />
                                {!editValid && (
                                  <p className="text-[11px] text-destructive">Enter a valid amount greater than 0.</p>
                                )}
                              </div>

                              {/* Rejection reason */}
                              <div className="space-y-2">
                                <Label className="text-[11px] text-muted-foreground">Rejection reason (min 10 chars)</Label>
                                <Textarea
                                  placeholder="Why is this payout being rejected?"
                                  value={rejReason}
                                  onChange={e => setRejectionReasons(prev => ({ ...prev, [op.id]: e.target.value }))}
                                  className="text-xs min-h-[60px]"
                                  rows={2}
                                />
                              </div>

                              {/* Treasury impact */}
                              <TreasuryImpactBanner payoutAmount={editValid ? editedAmount : op.amount} />
                            </div>
                          </td>
                        </tr>
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
