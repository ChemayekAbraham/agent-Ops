import { useState, Fragment } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { CheckCircle, XCircle, Loader2, User, Wallet, Pencil } from 'lucide-react';
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

  if (operations.length === 0) {
    return (
      <div className="rounded-lg border py-6 text-center text-sm text-muted-foreground">
        No COO-approved ROI payouts waiting for CFO approval.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
        {operations.length} ROI payout{operations.length === 1 ? '' : 's'} ready for CFO approval
      </p>

      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Payee</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Submitted</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {operations.map(op => {
              const meta = op.metadata as Record<string, any> | null;
              const isProxy = !!op.target_wallet_user_id;
              const rejReason = rejectionReasons[op.id] || '';
              const editedRaw = editedAmounts[op.id];
              const hasEdit = editedRaw !== undefined && editedRaw !== '';
              const editedAmount = hasEdit ? Math.round(Number(editedRaw)) : op.amount;
              const editValid = !hasEdit || (Number.isFinite(editedAmount) && editedAmount > 0);
              const amountChanged = hasEdit && editValid && editedAmount !== op.amount;

              return (
                <Fragment key={op.id}>
                  <TableRow>
                    <TableCell>
                      <div className="flex items-center gap-2 flex-wrap">
                        <User className="h-4 w-4 text-muted-foreground" />
                        <span className="font-semibold">{meta?.partner_name || getName(op.user_id)}</span>
                        {isProxy && (
                          <>
                            <span className="text-muted-foreground">→</span>
                            <Wallet className="h-4 w-4 text-primary" />
                            <span className="font-semibold text-primary">{meta?.target_agent_name || getName(op.target_wallet_user_id)}</span>
                            <Badge variant="outline" className="text-xs">Proxy Agent</Badge>
                          </>
                        )}
                      </div>
                      {op.description && (
                        <p className="text-xs text-muted-foreground mt-1 max-w-md">{op.description}</p>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <p className="font-bold text-primary">{formatUGX(editValid ? editedAmount : op.amount)}</p>
                      {amountChanged && (
                        <p className="text-[11px] text-muted-foreground">
                          Original: <span className="line-through">{formatUGX(op.amount)}</span>
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      <p className="text-xs text-muted-foreground">
                        {format(new Date(op.created_at), 'dd MMM yyyy, HH:mm')}
                      </p>
                      <p className="text-[11px] text-muted-foreground">Ref: {op.reference_id || '—'}</p>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">COO Approved</Badge>
                    </TableCell>
                  </TableRow>

                  <TableRow className="bg-muted/30">
                    <TableCell colSpan={4}>
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
                          <Button
                            size="sm"
                            className="w-full md:w-auto"
                            onClick={() => approveMutation.mutate({ opId: op.id, overrideAmount: amountChanged ? editedAmount : undefined })}
                            disabled={approveMutation.isPending || !editValid}
                          >
                            {approveMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <CheckCircle className="h-3.5 w-3.5 mr-1" />}
                            {amountChanged ? `Approve ${formatUGX(editedAmount)}` : 'Approve'}
                          </Button>
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
                          <Button
                            size="sm"
                            variant="destructive"
                            className="w-full md:w-auto"
                            disabled={rejReason.length < 10 || rejectMutation.isPending}
                            onClick={() => rejectMutation.mutate({ opId: op.id, reason: rejReason })}
                          >
                            {rejectMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <XCircle className="h-3.5 w-3.5 mr-1" />}
                            Reject
                          </Button>
                        </div>

                        {/* Treasury impact */}
                        <TreasuryImpactBanner payoutAmount={editValid ? editedAmount : op.amount} />
                      </div>
                    </TableCell>
                  </TableRow>
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
