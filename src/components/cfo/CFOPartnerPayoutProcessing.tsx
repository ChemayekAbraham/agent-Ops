import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Banknote, CheckCircle, XCircle, Loader2, RefreshCw,
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
  partner_ops_approved_at: string | null;
  coo_approved_at: string | null;
  sub_category?: string | null;
  user?: { full_name: string; phone: string; avatar_url: string | null };
}

const SUB_CATEGORY_LABELS: Record<string, { label: string; color: string }> = {
  general: { label: 'General', color: 'bg-muted text-muted-foreground border-border' },
  repair: { label: 'Repair', color: 'bg-amber-100 text-amber-700 border-amber-300' },
  rent: { label: 'Rent', color: 'bg-blue-100 text-blue-700 border-blue-300' },
  commission: { label: 'Commission', color: 'bg-emerald-100 text-emerald-700 border-emerald-300' },
  investment: { label: 'Investment', color: 'bg-purple-100 text-purple-700 border-purple-300' },
  roi: { label: 'ROI', color: 'bg-rose-100 text-rose-700 border-rose-300' },
};

import { formatDynamic } from '@/lib/currencyFormat';
const formatCurrency = formatDynamic;

export function CFOPartnerPayoutProcessing() {
  const { user } = useAuth();
  const [requests, setRequests] = useState<PartnerWithdrawalRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [approveOpen, setApproveOpen] = useState(false);
  const [selected, setSelected] = useState<PartnerWithdrawalRequest | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [transactionId, setTransactionId] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchRequests = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('investment_withdrawal_requests')
        .select('*')
        .eq('status', 'coo_approved')
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
      console.error('CFO partner payout fetch error:', e);
      toast.error('Failed to load partner payout requests');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  const handleApprove = async () => {
    if (!user || !selected || !transactionId.trim()) return;
    setProcessing(selected.id);
    try {
      const { error } = await supabase
        .from('investment_withdrawal_requests')
        .update({
          status: 'approved',
          cfo_processed_at: new Date().toISOString(),
          cfo_processed_by: user.id,
          processed_by: user.id,
          processed_at: new Date().toISOString(),
          transaction_id: transactionId.trim().toUpperCase(),
        } as any)
        .eq('id', selected.id);
      if (error) throw error;

      await supabase.from('audit_logs').insert({
        user_id: user.id,
        action_type: 'partner_withdrawal_treasury_payout_processed',
        record_id: selected.id,
        table_name: 'investment_withdrawal_requests',
        metadata: {
          amount: selected.amount,
          partner_user_id: selected.user_id,
          transaction_id: transactionId.trim().toUpperCase(),
        },
      });

      toast.success('Payout processed successfully');
      setApproveOpen(false);
      setSelected(null);
      setTransactionId('');
      fetchRequests();
    } catch (e: any) {
      toast.error(e.message || 'Failed to process payout');
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
        action_type: 'partner_withdrawal_treasury_payout_rejected',
        record_id: selected.id,
        table_name: 'investment_withdrawal_requests',
        metadata: { amount: selected.amount, reason: rejectionReason.trim(), partner_user_id: selected.user_id },
      });

      toast.success('Payout rejected');
      setRejectOpen(false);
      setRejectionReason('');
      setSelected(null);
      fetchRequests();
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

  if (requests.length === 0) return null;

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <Banknote className="h-4 w-4 text-emerald-600" />
              Treasury Payout — Partner Withdrawals
              <Badge variant="secondary" className="text-xs animate-pulse">
                {requests.length}
              </Badge>
            </CardTitle>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={fetchRequests}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {/* Sub-category summary */}
          {(() => {
            const repairCount = requests.filter(r => r.sub_category === 'repair').length;
            const rentCount = requests.filter(r => r.sub_category === 'rent').length;
            const commissionCount = requests.filter(r => r.sub_category === 'commission').length;
            const investmentCount = requests.filter(r => r.sub_category === 'investment').length;
            const roiCount = requests.filter(r => r.sub_category === 'roi').length;
            if (!repairCount && !rentCount && !commissionCount && !investmentCount && !roiCount) return null;
            return (
              <div className="flex flex-wrap items-center gap-2 mb-3 pb-3 border-b">
                <span className="text-xs text-muted-foreground">By category:</span>
                {repairCount > 0 && (
                  <Badge variant="outline" className="text-xs gap-1 bg-amber-50 text-amber-700 border-amber-200">
                    🔧 Repair: <span className="font-bold">{repairCount}</span>
                  </Badge>
                )}
                {rentCount > 0 && (
                  <Badge variant="outline" className="text-xs gap-1 bg-blue-50 text-blue-700 border-blue-200">
                    🏠 Rent: <span className="font-bold">{rentCount}</span>
                  </Badge>
                )}
                {commissionCount > 0 && (
                  <Badge variant="outline" className="text-xs gap-1 bg-emerald-50 text-emerald-700 border-emerald-200">
                    💰 Commission: <span className="font-bold">{commissionCount}</span>
                  </Badge>
                )}
                {investmentCount > 0 && (
                  <Badge variant="outline" className="text-xs gap-1 bg-purple-50 text-purple-700 border-purple-200">
                    📈 Investment: <span className="font-bold">{investmentCount}</span>
                  </Badge>
                )}
                {roiCount > 0 && (
                  <Badge variant="outline" className="text-xs gap-1 bg-rose-50 text-rose-700 border-rose-200">
                    📊 ROI: <span className="font-bold">{roiCount}</span>
                  </Badge>
                )}
              </div>
            );
          })()}
          <div className="space-y-2">
            {requests.map(req => (
              <div
                key={req.id}
                className="p-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 space-y-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <UserAvatar fullName={req.user?.full_name || ''} avatarUrl={req.user?.avatar_url} size="sm" />
                    <div>
                      <p className="text-sm font-bold">{req.user?.full_name}</p>
                      <p className="text-xs text-muted-foreground">{req.user?.phone}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-base font-black">{formatCurrency(req.amount)}</p>
                    {req.sub_category && req.sub_category !== 'general' && (
                      <Badge variant="outline" className={`text-[10px] mt-0.5 ${SUB_CATEGORY_LABELS[req.sub_category]?.color || 'bg-muted text-muted-foreground'}`}>
                        {SUB_CATEGORY_LABELS[req.sub_category]?.label || req.sub_category}
                      </Badge>
                    )}
                  </div>
                </div>

                {req.reason && (
                  <p className="text-xs text-muted-foreground italic">"{req.reason}"</p>
                )}

                <div className="flex items-center justify-between">
                  <p className="text-[10px] text-muted-foreground">
                    Operations cleared {req.coo_approved_at ? formatDistanceToNow(new Date(req.coo_approved_at), { addSuffix: true }) : ''}
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
                      className="h-8 text-xs bg-emerald-600 hover:bg-emerald-700"
                      onClick={() => { setSelected(req); setTransactionId(''); setApproveOpen(true); }}
                      disabled={!!processing}
                    >
                      <CheckCircle className="h-3 w-3 mr-1" />
                      Process Payout
                    </Button>
                  </div>
                </div>

                {expandedId === req.id && (
                  <div className="pt-2 border-t border-border/50">
                    <WithdrawalStepTracker
                      variant="partner"
                      status={req.status}
                      createdAt={req.requested_at}
                      partnerOpsApprovedAt={req.partner_ops_approved_at}
                      cooClearedAt={req.coo_approved_at}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Approve Dialog */}
      <AlertDialog open={approveOpen} onOpenChange={setApproveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Process Treasury Payout?</AlertDialogTitle>
            <AlertDialogDescription>
              Enter the Transaction ID to finalize <strong>{selected ? formatCurrency(selected.amount) : ''}</strong> payout for {selected?.user?.full_name}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            placeholder="Enter Transaction ID"
            value={transactionId}
            onChange={e => setTransactionId(e.target.value)}
            className="font-mono uppercase"
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleApprove} disabled={!!processing || !transactionId.trim()}>
              {processing ? 'Processing...' : 'Confirm Payout'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reject Dialog */}
      <AlertDialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject Payout?</AlertDialogTitle>
            <AlertDialogDescription>
              Rejecting <strong>{selected ? formatCurrency(selected.amount) : ''}</strong> for {selected?.user?.full_name}. Min 10 characters.
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
