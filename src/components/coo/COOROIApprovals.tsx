import { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import {
  CheckCircle, XCircle, Loader2, TrendingUp, User, Wallet,
  CheckCheck, RefreshCw,
} from 'lucide-react';

import { format } from 'date-fns';
import { formatUGX } from '@/lib/rentCalculations';

interface PendingOp {
  id: string;
  user_id: string | null;
  amount: number;
  category: string;
  description: string | null;
  status: string;
  created_at: string;
  reference_id: string | null;
  operation_type: string;
  target_wallet_user_id: string | null;
  source_id: string | null;
  metadata: Record<string, any> | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  rejection_reason: string | null;
}

export function COOROIApprovals() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [processing, setProcessing] = useState(false);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');

  const { data: operations = [], isLoading, refetch } = useQuery({
    queryKey: ['coo-roi-approvals'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('pending_wallet_operations')
        .select('*')
        .eq('category', 'roi_payout')
        .eq('status', 'pending_coo_approval')
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data || []) as PendingOp[];
    },
  });

  const userIds = [...new Set(operations.flatMap(op => [op.user_id, op.target_wallet_user_id].filter(Boolean) as string[]))];
  const { data: profiles = [] } = useQuery({
    queryKey: ['coo-roi-profiles', userIds.join(',')],
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

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === operations.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(operations.map(o => o.id)));
    }
  };

  const selectedTotal = operations
    .filter(o => selected.has(o.id))
    .reduce((s, o) => s + o.amount, 0);

  const approveItems = useCallback(async (ids: string[]) => {
    setProcessing(true);
    try {
      for (const opId of ids) {
        // First fetch current metadata to merge
        const { data: current } = await supabase
          .from('pending_wallet_operations')
          .select('metadata')
          .eq('id', opId)
          .single();

        const existingMeta = (current?.metadata as Record<string, any>) || {};

        const { error } = await supabase
          .from('pending_wallet_operations')
          .update({
            status: 'coo_approved',
            reviewed_by: user?.id,
            reviewed_at: new Date().toISOString(),
            metadata: {
              ...existingMeta,
              coo_approved_by: user?.id,
              coo_approved_at: new Date().toISOString(),
            },
          })
          .eq('id', opId);
        if (error) throw error;
      }

      // Audit log
      await supabase.from('audit_logs').insert(
        ids.map(opId => {
          const op = operations.find(o => o.id === opId);
          return {
            user_id: user?.id,
            action_type: 'coo_roi_approval',
            table_name: 'pending_wallet_operations',
            record_id: opId,
            metadata: {
              amount: op?.amount,
              target_user_id: op?.target_wallet_user_id || op?.user_id,
              batch_size: ids.length,
            },
          };
        })
      );

      // Notify CFO users
      const { data: cfoUsers } = await supabase.from('user_roles').select('user_id').eq('role', 'cfo');
      if (cfoUsers && cfoUsers.length > 0) {
        const totalAmount = ids.reduce((s, id) => {
          const op = operations.find(o => o.id === id);
          return s + (op?.amount || 0);
        }, 0);
        await supabase.from('notifications').insert(
          cfoUsers.map(c => ({
            user_id: c.user_id,
            title: `${ids.length} ROI Payout(s) COO-Approved`,
            message: `${ids.length} ROI payout(s) totalling ${formatUGX(totalAmount)} have been approved by COO and are ready for disbursement.`,
            type: 'approval_required',
            metadata: { count: ids.length, total: totalAmount },
          }))
        );
      }

      toast.success(`${ids.length} payout(s) approved — sent to CFO for disbursement`);
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ['coo-roi-approvals'] });
    } catch (err: any) {
      toast.error('Approval failed', { description: err.message });
    } finally {
      setProcessing(false);
    }
  }, [operations, user, queryClient]);

  const rejectItem = useCallback(async (opId: string, reason: string) => {
    setProcessing(true);
    try {
      const op = operations.find(o => o.id === opId);
      const { error } = await supabase
        .from('pending_wallet_operations')
        .update({
          status: 'rejected',
          reviewed_by: user?.id,
          reviewed_at: new Date().toISOString(),
          rejection_reason: reason,
        })
        .eq('id', opId);
      if (error) throw error;

      await supabase.from('audit_logs').insert({
        user_id: user?.id,
        action_type: 'coo_roi_rejection',
        table_name: 'pending_wallet_operations',
        record_id: opId,
        metadata: { amount: op?.amount, reason },
      });

      toast.success('ROI payout rejected');
      setRejecting(null);
      setRejectionReason('');
      queryClient.invalidateQueries({ queryKey: ['coo-roi-approvals'] });
    } catch (err: any) {
      toast.error('Rejection failed', { description: err.message });
    } finally {
      setProcessing(false);
    }
  }, [operations, user, queryClient]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <TrendingUp className="h-5 w-5 text-primary" />
            ROI Return Approvals
            {operations.length > 0 && (
              <Badge variant="destructive">{operations.length}</Badge>
            )}
          </CardTitle>
          <div className="flex items-center gap-2">
            {operations.length > 0 && (
              <Button size="sm" variant="outline" onClick={toggleAll}>
                <CheckCheck className="h-3.5 w-3.5 mr-1" />
                {selected.size === operations.length ? 'Deselect All' : 'Select All'}
              </Button>
            )}
            <Button size="icon-sm" variant="ghost" onClick={() => refetch()}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {selected.size > 0 && (
          <div className="space-y-3 rounded-xl border-2 border-primary/30 bg-primary/5 p-3">
            
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold">
                {selected.size} selected · {formatUGX(selectedTotal)}
              </p>
              <Button
                size="sm"
                disabled={processing}
                onClick={() => approveItems(Array.from(selected))}
              >
                {processing ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <CheckCircle className="h-3.5 w-3.5 mr-1" />}
                Approve All Selected
              </Button>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : operations.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground py-6">
            No ROI payouts pending COO approval.
          </p>
        ) : (
          operations.map(op => {
            const meta = op.metadata as Record<string, any> | null;
            const isAltWallet = op.operation_type === 'roi_split_alt_wallet';
            const isProxy = !!op.target_wallet_user_id && !isAltWallet;
            const isRejecting = rejecting === op.id;

            return (
              <div
                key={op.id}
                className="rounded-xl border p-3 space-y-2 transition-all"
                style={{
                  borderLeftWidth: 4,
                  borderLeftColor: 'hsl(var(--warning))',
                }}
              >
                <div className="flex items-start gap-3">
                  <Checkbox
                    checked={selected.has(op.id)}
                    onCheckedChange={() => toggleSelect(op.id)}
                    className="mt-1"
                  />
                  <div className="flex-1 space-y-1">
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
                      {isAltWallet && (
                        <>
                          <span className="text-muted-foreground">→</span>
                          <Wallet className="h-4 w-4 text-primary" />
                          <span className="font-semibold text-primary">{meta?.alt_recipient_name || getName(op.target_wallet_user_id)}</span>
                          <Badge variant="outline" className="text-xs">Different Wallet</Badge>
                        </>
                      )}
                    </div>
                    <p className="text-lg font-bold text-primary">{formatUGX(op.amount)}</p>
                    <p className="text-xs text-muted-foreground">
                      {format(new Date(op.created_at), 'dd MMM yyyy, HH:mm')} · Ref: {op.reference_id || '—'}
                    </p>
                    {op.description && (
                      <p className="text-xs text-muted-foreground">{op.description}</p>
                    )}
                  </div>
                </div>

                {isRejecting ? (
                  <div className="space-y-2 pt-2 border-t">
                    <Textarea
                      placeholder="Rejection reason (min 10 chars)..."
                      value={rejectionReason}
                      onChange={e => setRejectionReason(e.target.value)}
                      className="text-xs"
                      rows={2}
                    />
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={rejectionReason.length < 10 || processing}
                        onClick={() => rejectItem(op.id, rejectionReason)}
                      >
                        Confirm Reject
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => { setRejecting(null); setRejectionReason(''); }}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-2 pt-2 border-t">
                    <Button
                      size="sm"
                      disabled={processing}
                      onClick={() => approveItems([op.id])}
                    >
                      <CheckCircle className="h-3.5 w-3.5 mr-1" />
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={processing}
                      onClick={() => setRejecting(op.id)}
                    >
                      <XCircle className="h-3.5 w-3.5 mr-1" />
                      Reject
                    </Button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
