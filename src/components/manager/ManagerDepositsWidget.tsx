import { useState, useEffect } from 'react';
import { usePolling } from '@/hooks/usePolling';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import {
  Wallet,
  ArrowRight,
  Check,
  X,
  Loader2,
  User,
  Clock,
  CheckCircle2,
  XCircle,
  ExternalLink,
} from 'lucide-react';
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
import { Input } from '@/components/ui/input';

interface DepositEntry {
  id: string;
  user_id: string;
  agent_id: string | null;
  amount: number;
  status: string;
  created_at: string;
  provider: string | null;
  transaction_id: string | null;
  notes: string | null;
  user_name?: string;
  user_phone?: string;
  agent_name?: string;
}

// Derive a human-readable label for deposit type
function getDepositType(d: DepositEntry): string {
  if (d.notes) {
    const n = d.notes.toLowerCase();
    if (n.includes('rent')) return 'Rent Repayment';
    if (n.includes('access')) return 'Access Fee';
  }
  if (d.provider === 'mtn') return 'MTN Mobile Money';
  if (d.provider === 'airtel') return 'Airtel Money';
  if (d.agent_id) return 'Agent Deposit';
  return 'Wallet Deposit';
}

export function ManagerDepositsWidget() {
  const navigate = useNavigate();
  const [deposits, setDeposits] = useState<DepositEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());
  const [rejectDialog, setRejectDialog] = useState<{ open: boolean; deposit: DepositEntry | null }>({ open: false, deposit: null });
  const [rejectionReason, setRejectionReason] = useState('');

  // Stats
  const [stats, setStats] = useState({ pending: 0, pendingAmount: 0, todayApproved: 0, todayAmount: 0 });

  const fetchDeposits = async () => {
    try {
      // Use server-side RPC for scale — joins profiles in SQL, no client-side enrichment
      const { data: result, error } = await (supabase.rpc as any)('get_deposits_paginated', {
        p_status: 'pending',
        p_page: 1,
        p_page_size: 20,
      });

      if (error) throw error;

      const parsed = typeof result === 'string' ? JSON.parse(result) : result;
      const allData = (parsed?.data || []) as DepositEntry[];
      
      // Also fetch today's approved for stats
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const { data: approvedResult } = await (supabase.rpc as any)('get_deposits_paginated', {
        p_status: 'approved',
        p_start_date: today.toISOString(),
        p_page: 1,
        p_page_size: 10,
      });
      const approvedParsed = typeof approvedResult === 'string' ? JSON.parse(approvedResult) : approvedResult;
      const todayApproved = (approvedParsed?.data || []) as DepositEntry[];

      setStats({
        pending: parsed?.total || 0,
        pendingAmount: allData.reduce((s: number, d: DepositEntry) => s + Number(d.amount), 0),
        todayApproved: approvedParsed?.total || 0,
        todayAmount: todayApproved.reduce((s: number, d: DepositEntry) => s + Number(d.amount), 0),
      });

      setDeposits([...allData, ...todayApproved]);
    } catch (err) {
      console.error('ManagerDepositsWidget fetch error:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDeposits();
  }, []);

  // Polled every 30s (+ on focus). The old Realtime listener was on
  // deposit_requests, which was never published, so it never fired (doc 147).
  const { lastUpdatedAt, refresh } = usePolling(() => fetchDeposits(), 30_000);

  const handleApprove = async (deposit: DepositEntry) => {
    setProcessingIds(prev => new Set(prev).add(deposit.id));
    try {
      const { error } = await supabase.functions.invoke('approve-deposit', {
        body: { deposit_request_id: deposit.id, action: 'approve', is_manager: true },
      });
      if (error) throw error;
      toast.success(`Approved ${formatUGX(deposit.amount)} from ${deposit.user_name}`);
      fetchDeposits();
    } catch (err: any) {
      toast.error(err.message || 'Failed to approve');
    } finally {
      setProcessingIds(prev => { const n = new Set(prev); n.delete(deposit.id); return n; });
    }
  };

  const handleReject = async () => {
    const deposit = rejectDialog.deposit;
    if (!deposit) return;

    setProcessingIds(prev => new Set(prev).add(deposit.id));
    setRejectDialog({ open: false, deposit: null });
    try {
      const { error } = await supabase.functions.invoke('approve-deposit', {
        body: {
          deposit_request_id: deposit.id,
          action: 'reject',
          rejection_reason: rejectionReason || 'Rejected by manager',
          is_manager: true,
        },
      });
      if (error) throw error;
      toast.success('Deposit rejected');
      setRejectionReason('');
      fetchDeposits();
    } catch (err: any) {
      toast.error(err.message || 'Failed to reject');
    } finally {
      setProcessingIds(prev => { const n = new Set(prev); n.delete(deposit.id); return n; });
    }
  };

  const pendingDeposits = deposits.filter(d => d.status === 'pending');
  const recentApproved = deposits.filter(d => d.status === 'approved').slice(0, 3);

  return (
    <>
      {/* Stats bar */}
      <div className="grid grid-cols-2 gap-2">
        <Card className="border-primary/30 bg-primary/5 cursor-pointer active:scale-95 transition-transform touch-manipulation" onClick={() => navigate('/deposits-management')}>
          <CardContent className="p-3 text-center">
            <div className="flex items-center justify-center gap-1 mb-1">
              <Clock className="h-3.5 w-3.5 text-primary" />
              <span className="text-[10px] font-medium text-primary">Pending Deposits</span>
            </div>
            <p className="text-xl font-black text-primary">{stats.pending}</p>
            <p className="text-[10px] text-muted-foreground font-medium">{formatUGX(stats.pendingAmount)}</p>
          </CardContent>
        </Card>
        <Card className="border-success/30 bg-success/5 cursor-pointer active:scale-95 transition-transform touch-manipulation" onClick={() => navigate('/deposits-management?status=approved')}>
          <CardContent className="p-3 text-center">
            <div className="flex items-center justify-center gap-1 mb-1">
              <CheckCircle2 className="h-3.5 w-3.5 text-success" />
              <span className="text-[10px] font-medium text-success">Approved Today</span>
            </div>
            <p className="text-xl font-black text-success">{stats.todayApproved}</p>
            <p className="text-[10px] text-muted-foreground font-medium">{formatUGX(stats.todayAmount)}</p>
          </CardContent>
        </Card>
      </div>

      {/* Pending deposits list */}
      <Card>
        <CardHeader className="pb-2 pt-3 px-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Clock className="h-4 w-4 text-warning" />
              Pending Deposits
              {stats.pending > 0 && (
                <Badge variant="secondary" className="bg-warning/10 text-warning border-warning/30 text-[10px]">
                  {stats.pending}
                </Badge>
              )}
            </CardTitle>
            <Button variant="ghost" size="sm" className="h-7 text-xs gap-1 text-muted-foreground" onClick={() => navigate('/deposits-management')}>
              View All <ExternalLink className="h-3 w-3" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="px-3 pb-3">
          {loading ? (
            <div className="space-y-2">
              {[1, 2].map(i => <div key={i} className="h-16 bg-muted animate-pulse rounded-lg" />)}
            </div>
          ) : pendingDeposits.length === 0 ? (
            <div className="text-center py-6 text-muted-foreground">
              <CheckCircle2 className="h-10 w-10 mx-auto mb-2 opacity-40 text-success" />
              <p className="text-sm">No pending deposits</p>
            </div>
          ) : (
            <AnimatePresence mode="popLayout">
              <div className="space-y-2">
                {pendingDeposits.map(deposit => (
                  <motion.div
                    key={deposit.id}
                    layout
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: -80 }}
                    className="p-3 rounded-lg border bg-card space-y-3"
                  >
                    {/* Transaction ID — top priority */}
                    <div className="p-2.5 rounded-lg bg-warning/10 border border-warning/30">
                      <p className="text-[10px] font-semibold text-warning uppercase tracking-wider mb-0.5">Transaction ID — Verify First</p>
                      <p className="font-mono text-xl font-black text-foreground break-all tracking-tight">
                        {deposit.transaction_id || <span className="text-destructive text-sm italic font-sans font-medium">No Transaction ID provided</span>}
                      </p>
                    </div>

                    {/* User info + amount */}
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                          <User className="h-4 w-4 text-primary" />
                        </div>
                        <div>
                          <button
                            className="font-semibold text-sm text-foreground hover:text-primary hover:underline transition-colors text-left"
                            onClick={() => navigate(`/users?search=${encodeURIComponent(deposit.user_name || '')}`)}
                          >
                            {deposit.user_name}
                          </button>
                          <p className="text-[11px] text-muted-foreground">{deposit.user_phone}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="font-bold text-primary text-sm">{formatUGX(deposit.amount)}</p>
                        <p className="text-[10px] text-muted-foreground">{format(new Date(deposit.created_at), 'h:mm a')}</p>
                      </div>
                    </div>

                    {/* Deposit type & provider */}
                    <div className="flex items-center justify-between">
                      <Badge variant="outline" className="text-[10px] bg-muted/50">
                        {getDepositType(deposit)}
                      </Badge>
                      {deposit.provider && (
                        <Badge variant="outline" className={`text-[10px] ${deposit.provider === 'mtn' ? 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20' : 'bg-red-500/10 text-red-600 border-red-500/20'}`}>
                          {deposit.provider.toUpperCase()}
                        </Badge>
                      )}
                    </div>

                    {/* Notes if any */}
                    {deposit.notes && (
                      <p className="text-[11px] text-muted-foreground italic bg-muted/30 rounded px-2 py-1">"{deposit.notes}"</p>
                    )}

                    {/* Approve / Reject buttons at bottom */}
                    <div className="flex gap-2 pt-1 border-t">
                      <Button
                        size="sm"
                        className="flex-1 h-9 text-xs touch-manipulation"
                        onClick={() => handleApprove(deposit)}
                        disabled={processingIds.has(deposit.id)}
                      >
                        {processingIds.has(deposit.id) ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <><Check className="h-3 w-3 mr-1" />Approve</>
                        )}
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        className="flex-1 h-9 text-xs touch-manipulation"
                        onClick={() => setRejectDialog({ open: true, deposit })}
                        disabled={processingIds.has(deposit.id)}
                      >
                        <X className="h-3 w-3 mr-1" />Reject
                      </Button>
                    </div>
                  </motion.div>
                ))}
              </div>
            </AnimatePresence>
          )}

          {/* Recently approved (today) */}
          {recentApproved.length > 0 && (
            <div className="mt-3 pt-3 border-t">
              <p className="text-[11px] font-medium text-muted-foreground mb-2 flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3 text-success" />
                Approved Today
              </p>
              <div className="space-y-1.5">
                {recentApproved.map(d => (
                  <div key={d.id} className="flex items-center justify-between text-sm">
                    <button
                      className="font-medium hover:text-primary hover:underline transition-colors text-left text-sm"
                      onClick={() => navigate(`/users?search=${encodeURIComponent(d.user_name || '')}`)}
                    >
                      {d.user_name}
                    </button>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-muted-foreground">{getDepositType(d)}</span>
                      <span className="font-bold text-success text-sm">{formatUGX(d.amount)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Reject dialog */}
      <AlertDialog open={rejectDialog.open} onOpenChange={open => setRejectDialog({ open, deposit: open ? rejectDialog.deposit : null })}>
        <AlertDialogContent className="max-h-[90vh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>Reject Deposit</AlertDialogTitle>
            <AlertDialogDescription>
              Reject {rejectDialog.deposit && formatUGX(rejectDialog.deposit.amount)} from {rejectDialog.deposit?.user_name}?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            placeholder="Reason (optional)"
            value={rejectionReason}
            onChange={e => setRejectionReason(e.target.value)}
          />
          <AlertDialogFooter className="flex-col-reverse sm:flex-row gap-2">
            <AlertDialogCancel>← Back</AlertDialogCancel>
            <AlertDialogAction onClick={handleReject} className="bg-destructive hover:bg-destructive/90">
              Reject
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
