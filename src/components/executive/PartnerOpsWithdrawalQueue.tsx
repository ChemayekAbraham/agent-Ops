import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  ArrowUpFromLine, CheckCircle, XCircle, Loader2, RefreshCw, Briefcase,
} from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { UserAvatar } from '@/components/UserAvatar';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { WithdrawalStepTracker } from '@/components/wallet/WithdrawalStepTracker';

interface PartnerWithdrawalRequest {
  id: string;
  user_id: string;
  amount: number;
  status: string;
  reason: string | null;
  requested_at: string;
  user?: { full_name: string; phone: string; avatar_url: string | null };
}

import { formatDynamic } from '@/lib/currencyFormat';
const formatCurrency = formatDynamic;

export function PartnerOpsWithdrawalQueue() {
  const { user } = useAuth();
  const [requests, setRequests] = useState<PartnerWithdrawalRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [approveOpen, setApproveOpen] = useState(false);
  const [selected, setSelected] = useState<PartnerWithdrawalRequest | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchRequests = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('investment_withdrawal_requests')
        .select('*')
        .eq('status', 'pending')
        .order('requested_at', { ascending: true })
        .limit(100);

      if (error) throw error;

      if (data && data.length > 0) {
        const userIds = [...new Set(data.map(r => r.user_id))];
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name, phone, avatar_url')
          .in('id', userIds);

        const profileMap = new Map(profiles?.map(p => [p.id, p]) || []);
        setRequests(
          data.map(r => ({
            ...r,
            user: profileMap.get(r.user_id) || { full_name: 'Unknown', phone: '', avatar_url: null },
          }))
        );
      } else {
        setRequests([]);
      }
    } catch (e) {
      console.error('Partner Ops withdrawal fetch error:', e);
      toast.error('Failed to load withdrawal requests');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  const handleApprove = async () => {
    if (!user || !selected) return;
    setProcessing(selected.id);
    try {
      const { error } = await supabase
        .from('investment_withdrawal_requests')
        .update({
          status: 'partner_ops_approved',
          partner_ops_approved_at: new Date().toISOString(),
          partner_ops_approved_by: user.id,
        } as any)
        .eq('id', selected.id);
      if (error) throw error;

      await supabase.from('audit_logs').insert({
        user_id: user.id,
        action_type: 'partner_withdrawal_portfolio_review_approved',
        record_id: selected.id,
        table_name: 'investment_withdrawal_requests',
        metadata: { amount: selected.amount, partner_user_id: selected.user_id },
      });

      toast.success('Forwarded for Operations Clearance');
      setRequests(prev => prev.filter(r => r.id !== selected.id));
      setApproveOpen(false);
      setSelected(null);
    } catch (e: any) {
      toast.error(e.message || 'Failed to approve');
    } finally {
      setProcessing(null);
    }
  };

  const handleReject = async () => {
    if (!user || !selected || rejectionReason.trim().length < 10) return;
    setProcessing(selected.id);
    try {
      const { error } = await supabase
        .from('investment_withdrawal_requests')
        .update({
          status: 'rejected',
          rejection_reason: rejectionReason.trim(),
          processed_by: user.id,
          processed_at: new Date().toISOString(),
        } as any)
        .eq('id', selected.id);
      if (error) throw error;

      await supabase.from('audit_logs').insert({
        user_id: user.id,
        action_type: 'partner_withdrawal_portfolio_review_rejected',
        record_id: selected.id,
        table_name: 'investment_withdrawal_requests',
        metadata: { amount: selected.amount, reason: rejectionReason.trim(), partner_user_id: selected.user_id },
      });

      toast.success('Withdrawal rejected');
      setRequests(prev => prev.filter(r => r.id !== selected.id));
      setRejectOpen(false);
      setRejectionReason('');
      setSelected(null);
    } catch (e: any) {
      toast.error(e.message || 'Failed to reject');
    } finally {
      setProcessing(null);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6 text-center">
          <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <Briefcase className="h-4 w-4 text-primary" />
              Portfolio Review — Withdrawals
              {requests.length > 0 && (
                <Badge variant="secondary" className="text-xs animate-pulse">
                  {requests.length}
                </Badge>
              )}
            </CardTitle>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={fetchRequests}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {requests.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              No withdrawal requests awaiting portfolio review
            </p>
          ) : (
            <div className="space-y-2">
              {requests.map(req => (
                <div
                  key={req.id}
                  className="p-3 rounded-xl border border-amber-500/30 bg-amber-500/5 space-y-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <UserAvatar fullName={req.user?.full_name || ''} avatarUrl={req.user?.avatar_url} size="sm" />
                      <div>
                        <p className="text-sm font-bold">{req.user?.full_name}</p>
                        <p className="text-xs text-muted-foreground">{req.user?.phone}</p>
                      </div>
                    </div>
                    <p className="text-base font-black">{formatCurrency(req.amount)}</p>
                  </div>

                  {req.reason && (
                    <p className="text-xs text-muted-foreground italic">"{req.reason}"</p>
                  )}

                  <div className="flex items-center justify-between">
                    <p className="text-[10px] text-muted-foreground">
                      Requested {formatDistanceToNow(new Date(req.requested_at), { addSuffix: true })}
                    </p>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-[10px]"
                        onClick={() => setExpandedId(expandedId === req.id ? null : req.id)}
                      >
                        {expandedId === req.id ? 'Hide' : 'Track'}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 text-xs text-destructive border-destructive/30"
                        onClick={() => { setSelected(req); setRejectOpen(true); }}
                        disabled={!!processing}
                      >
                        <XCircle className="h-3 w-3 mr-1" />
                        Reject
                      </Button>
                      <Button
                        size="sm"
                        className="h-8 text-xs"
                        onClick={() => { setSelected(req); setApproveOpen(true); }}
                        disabled={!!processing}
                      >
                        <CheckCircle className="h-3 w-3 mr-1" />
                        Approve
                      </Button>
                    </div>
                  </div>

                  {expandedId === req.id && (
                    <div className="pt-2 border-t border-border/50">
                      <WithdrawalStepTracker
                        variant="partner"
                        status={req.status}
                        createdAt={req.requested_at}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Approve Dialog */}
      <AlertDialog open={approveOpen} onOpenChange={setApproveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve Portfolio Review?</AlertDialogTitle>
            <AlertDialogDescription>
              Forward <strong>{selected ? formatCurrency(selected.amount) : ''}</strong> for {selected?.user?.full_name} to Operations Clearance.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleApprove} disabled={!!processing}>
              {processing ? 'Approving...' : 'Approve & Forward'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reject Dialog */}
      <AlertDialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject Withdrawal?</AlertDialogTitle>
            <AlertDialogDescription>
              Rejecting <strong>{selected ? formatCurrency(selected.amount) : ''}</strong> for {selected?.user?.full_name}. Minimum 10 characters.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            placeholder="Reason for rejection (min 10 characters)..."
            value={rejectionReason}
            onChange={e => setRejectionReason(e.target.value)}
            className="mt-2"
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleReject}
              disabled={rejectionReason.trim().length < 10 || !!processing}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {processing ? 'Rejecting...' : 'Reject'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
