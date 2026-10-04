import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
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
import { Wallet, Check, X, Loader2, ChevronDown, ChevronUp, User, ExternalLink } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { formatUGX } from '@/lib/rentCalculations';

interface DepositRequest {
  id: string;
  user_id: string;
  amount: number;
  status: string;
  created_at: string;
  transaction_id: string | null;
  provider: string | null;
  user_name?: string;
}

export function FloatingDepositsWidget() {
  const navigate = useNavigate();
  const [deposits, setDeposits] = useState<DepositRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());
  const [rejectDialog, setRejectDialog] = useState<{ open: boolean; deposit: DepositRequest | null }>({
    open: false,
    deposit: null,
  });
  const [rejectionReason, setRejectionReason] = useState('');

  const fetchDeposits = async () => {
    try {
      const { data, error } = await supabase
        .from('deposit_requests')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(10);

      if (error) throw error;

      if (data && data.length > 0) {
        const userIds = [...new Set(data.map(d => d.user_id))];
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', userIds);

        const profileMap = new Map(profiles?.map(p => [p.id, p.full_name]) || []);
        const enriched = data.map(d => ({
          ...d,
          user_name: profileMap.get(d.user_id) || 'Unknown',
        }));
        setDeposits(enriched);
      } else {
        setDeposits([]);
      }
    } catch (error) {
      console.error('Error fetching deposits:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDeposits();
    // Realtime removed — deposit_requests not in realtime whitelist
  }, []);

  const handleApprove = async (deposit: DepositRequest) => {
    setProcessingIds(prev => new Set(prev).add(deposit.id));
    try {
      const { error } = await supabase.functions.invoke('approve-deposit', {
        body: {
          deposit_request_id: deposit.id,
          action: 'approve',
          is_manager: true,
        },
      });

      if (error) throw error;
      toast.success(`Approved ${formatUGX(deposit.amount)}`);
      fetchDeposits();
    } catch (error: any) {
      toast.error(error.message || 'Failed to approve');
    } finally {
      setProcessingIds(prev => {
        const next = new Set(prev);
        next.delete(deposit.id);
        return next;
      });
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
    } catch (error: any) {
      toast.error(error.message || 'Failed to reject');
    } finally {
      setProcessingIds(prev => {
        const next = new Set(prev);
        next.delete(deposit.id);
        return next;
      });
    }
  };

  if (loading || deposits.length === 0) return null;

  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className="fixed bottom-24 right-4 z-40 w-[calc(100%-2rem)] max-w-sm pointer-events-none"
      >
        <Card className="shadow-2xl border-2 border-warning/50 bg-card/95 backdrop-blur-sm pointer-events-auto">
          <CardHeader className="p-3 pb-2">
            <button
              onClick={() => setExpanded(!expanded)}
              className="flex items-center justify-between w-full"
            >
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-lg bg-warning/20">
                  <Wallet className="h-4 w-4 text-warning" />
                </div>
                <div className="text-left">
                  <CardTitle className="text-sm font-semibold">Pending Deposits</CardTitle>
                  <p className="text-xs text-muted-foreground">{deposits.length} awaiting approval</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="bg-warning/10 text-warning border-warning/30">
                  {deposits.length}
                </Badge>
                {expanded ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronUp className="h-4 w-4 text-muted-foreground" />
                )}
              </div>
            </button>
          </CardHeader>

          <AnimatePresence>
            {expanded && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
              >
                <CardContent className="p-3 pt-0">
                  <ScrollArea className="max-h-64">
                    <div className="space-y-2">
                      {deposits.map((deposit) => (
                        <motion.div
                          key={deposit.id}
                          initial={{ opacity: 0, x: -10 }}
                          animate={{ opacity: 1, x: 0 }}
                          className="p-3 rounded-lg bg-muted/50 border border-border/50"
                        >
                          {/* Transaction ID hidden until verified via TID Verification */}

                          <div className="flex items-start justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <User className="h-3 w-3 text-muted-foreground" />
                              <span className="text-sm font-medium truncate max-w-[120px]">
                                {deposit.user_name}
                              </span>
                            </div>
                            <span className="text-xs text-muted-foreground">
                              {format(new Date(deposit.created_at), 'MMM d, h:mm a')}
                            </span>
                          </div>
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-lg font-bold text-primary">
                              {formatUGX(deposit.amount)}
                            </span>
                            {deposit.provider && (
                              <Badge variant="outline" className={deposit.provider === 'mtn' ? 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20 text-[10px]' : 'bg-red-500/10 text-red-600 border-red-500/20 text-[10px]'}>
                                {deposit.provider.toUpperCase()}
                              </Badge>
                            )}
                          </div>
                          <div className="flex items-center justify-end gap-1">
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-success hover:text-success hover:bg-success/10"
                                onClick={() => handleApprove(deposit)}
                                disabled={processingIds.has(deposit.id)}
                              >
                                {processingIds.has(deposit.id) ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <Check className="h-4 w-4" />
                                )}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-destructive hover:text-destructive hover:bg-destructive/10"
                                onClick={() => setRejectDialog({ open: true, deposit })}
                                disabled={processingIds.has(deposit.id)}
                              >
                                <X className="h-4 w-4" />
                              </Button>
                            </div>
                        </motion.div>
                      ))}
                    </div>
                  </ScrollArea>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full mt-2 gap-1"
                    onClick={() => navigate('/deposits-management')}
                  >
                    <ExternalLink className="h-3 w-3" />
                    View All Deposits
                  </Button>
                </CardContent>
              </motion.div>
            )}
          </AnimatePresence>
        </Card>
      </motion.div>

      <AlertDialog open={rejectDialog.open} onOpenChange={(open) => setRejectDialog({ open, deposit: null })}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject Deposit</AlertDialogTitle>
            <AlertDialogDescription>
              Reject deposit of {rejectDialog.deposit && formatUGX(rejectDialog.deposit.amount)}?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            placeholder="Reason (optional)"
            value={rejectionReason}
            onChange={(e) => setRejectionReason(e.target.value)}
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleReject} className="bg-destructive hover:bg-destructive/90">
              Reject
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
