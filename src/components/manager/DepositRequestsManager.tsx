import { useState, useEffect } from 'react';
import { usePolling } from '@/hooks/usePolling';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
import { Wallet, Check, X, Loader2, User, Phone, Calendar, BarChart3, ExternalLink, UserCheck } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { formatUGX } from '@/lib/rentCalculations';
import { DepositAnalytics } from './DepositAnalytics';

interface DepositRequest {
  id: string;
  user_id: string;
  agent_id: string | null;
  amount: number;
  status: string;
  created_at: string;
  transaction_id: string | null;
  provider: string | null;
  user_name?: string;
  user_phone?: string;
  agent_name?: string;
}

export function DepositRequestsManager() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [deposits, setDeposits] = useState<DepositRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());
  const [rejectDialog, setRejectDialog] = useState<{ open: boolean; deposit: DepositRequest | null }>({
    open: false,
    deposit: null,
  });
  const [rejectionReason, setRejectionReason] = useState('');
  const [approveDialog, setApproveDialog] = useState<{ open: boolean; deposit: DepositRequest | null }>({ open: false, deposit: null });
  const [approveTid, setApproveTid] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'approved' | 'rejected' | 'agent'>('pending');

  const fetchDeposits = async () => {
    try {
      let query = supabase
        .from('deposit_requests')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100); // Bounded query — prevents loading millions of rows

      if (statusFilter === 'agent') {
        query = query.not('agent_id', 'is', null);
      } else if (statusFilter !== 'all') {
        query = query.eq('status', statusFilter);
      }

      const { data, error } = await query;

      if (error) throw error;

      if (data && data.length > 0) {
        const userIds = [...new Set([
          ...data.map(d => d.user_id),
          ...data.filter(d => d.agent_id).map(d => d.agent_id)
        ])];

        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', userIds);

        const profileMap = new Map(profiles?.map(p => [p.id, p]) || []);

        const enriched = data.map(d => ({
          ...d,
          user_name: profileMap.get(d.user_id)?.full_name || 'Unknown',
          user_phone: profileMap.get(d.user_id)?.phone || '',
          agent_name: d.agent_id ? profileMap.get(d.agent_id)?.full_name || 'Unknown' : null,
        }));

        setDeposits(enriched);
      } else {
        setDeposits([]);
      }
    } catch (error) {
      console.error('Error fetching deposits:', error);
      toast.error('Failed to load deposit requests');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDeposits();
  }, [statusFilter]);

  // Polled every 30s (+ on focus). The old Realtime listener was on
  // deposit_requests, which was never published, so it never fired (doc 147).
  const { lastUpdatedAt, refresh } = usePolling(() => fetchDeposits(), 30_000);

  const openApproveDialog = (deposit: DepositRequest) => {
    setApproveDialog({ open: true, deposit });
    setApproveTid('');
  };

  const handleApprove = async () => {
    const deposit = approveDialog.deposit;
    if (!deposit) return;
    setApproveDialog({ open: false, deposit: null });
    setProcessingIds(prev => new Set(prev).add(deposit.id));
    try {
      const { data, error } = await supabase.functions.invoke('approve-deposit', {
        body: {
          deposit_request_id: deposit.id,
          action: 'approve',
          is_manager: true,
          transaction_id: approveTid.trim().toUpperCase(),
        },
      });

      if (error || data?.error) {
        const { extractEdgeFunctionError } = await import('@/lib/extractEdgeFunctionError');
        const msg = await extractEdgeFunctionError({ error, data }, 'Failed to approve deposit');
        console.error('[DepositRequestsManager] approve failed:', msg, error);
        throw new Error(msg);
      }
      toast.success(`Approved deposit of ${formatUGX(deposit.amount)}`);
      setApproveTid('');
      fetchDeposits();
    } catch (error: any) {
      toast.error(error.message || 'Failed to approve deposit');
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
      const { data, error } = await supabase.functions.invoke('approve-deposit', {
        body: {
          deposit_request_id: deposit.id,
          action: 'reject',
          rejection_reason: rejectionReason || 'Rejected by manager',
          is_manager: true,
        },
      });

      if (error || data?.error) {
        const { extractEdgeFunctionError } = await import('@/lib/extractEdgeFunctionError');
        const msg = await extractEdgeFunctionError({ error, data }, 'Failed to reject deposit');
        console.error('[DepositRequestsManager] reject failed:', msg, error);
        throw new Error(msg);
      }
      toast.success('Deposit request rejected');
      setRejectionReason('');
      fetchDeposits();
    } catch (error: any) {
      toast.error(error.message || 'Failed to reject deposit');
    } finally {
      setProcessingIds(prev => {
        const next = new Set(prev);
        next.delete(deposit.id);
        return next;
      });
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'pending':
        return <Badge variant="outline" className="bg-warning/10 text-warning border-warning/30">Pending</Badge>;
      case 'approved':
        return <Badge variant="outline" className="bg-success/10 text-success border-success/30">Approved</Badge>;
      case 'rejected':
        return <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/30">Rejected</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map(i => (
          <Skeleton key={i} className="h-32 w-full" />
        ))}
      </div>
    );
  }

  return (
    <Tabs defaultValue="requests" className="space-y-4">
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="requests" className="gap-2">
          <Wallet className="h-4 w-4" />
          Requests
        </TabsTrigger>
        <TabsTrigger value="analytics" className="gap-2">
          <BarChart3 className="h-4 w-4" />
          Analytics
        </TabsTrigger>
      </TabsList>

      <TabsContent value="requests" className="space-y-4">
        {/* Header with filter and full page link */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex gap-2 overflow-x-auto pb-1">
            {([
              { value: 'pending', label: 'Pending' },
              { value: 'agent', label: '🧑‍💼 Agent' },
              { value: 'approved', label: 'Approved' },
              { value: 'rejected', label: 'Rejected' },
              { value: 'all', label: 'All' },
            ] as const).map(({ value, label }) => (
              <Button
                key={value}
                variant={statusFilter === value ? 'default' : 'outline'}
                size="sm"
                onClick={() => setStatusFilter(value)}
                className="whitespace-nowrap"
              >
                {label}
              </Button>
            ))}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate('/deposits-management')}
            className="gap-1 whitespace-nowrap"
          >
            <ExternalLink className="h-3 w-3" />
            Full Page
          </Button>
        </div>

        {deposits.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Wallet className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <p className="text-muted-foreground">
                {statusFilter === 'agent' ? 'No agent deposits found' : `No ${statusFilter !== 'all' ? statusFilter : ''} deposit requests`}
              </p>
            </CardContent>
          </Card>
        ) : (
          <AnimatePresence mode="popLayout">
            {deposits.map((deposit, index) => (
              <motion.div
                key={deposit.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ delay: index * 0.05 }}
              >
                <Card>
                  <CardContent className="p-4">
                    <div className="flex justify-between items-start mb-3">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <User className="h-4 w-4 text-muted-foreground" />
                          <span className="font-medium">{deposit.user_name}</span>
                        </div>
                        {deposit.user_phone && (
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Phone className="h-3 w-3" />
                            <span>{deposit.user_phone}</span>
                          </div>
                        )}
                      </div>
                      {getStatusBadge(deposit.status)}
                    </div>

                    <div className="flex items-center justify-between mb-3">
                      <span className="text-2xl font-bold text-primary">{formatUGX(deposit.amount)}</span>
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Calendar className="h-3 w-3" />
                        <span>{format(new Date(deposit.created_at), 'MMM d, yyyy h:mm a')}</span>
                      </div>
                    </div>

                    {deposit.transaction_id && (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
                        <span>Txn ID:</span>
                        <span className="font-mono font-medium text-foreground">{deposit.transaction_id}</span>
                        {deposit.provider && (
                          <Badge variant="outline" className={deposit.provider === 'mtn' ? 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20' : 'bg-red-500/10 text-red-600 border-red-500/20'}>
                            {deposit.provider.toUpperCase()}
                          </Badge>
                        )}
                      </div>
                    )}

                    {deposit.agent_name && (
                      <div className="flex items-center gap-1.5 mb-3 px-2 py-1.5 rounded-md bg-primary/5 border border-primary/10">
                        <UserCheck className="h-3.5 w-3.5 text-primary shrink-0" />
                        <p className="text-xs text-primary font-medium">
                          Agent: {deposit.agent_name}
                        </p>
                      </div>
                    )}

                    {deposit.status === 'pending' && (
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          className="flex-1"
                          onClick={() => openApproveDialog(deposit)}
                          disabled={processingIds.has(deposit.id)}
                        >
                          {processingIds.has(deposit.id) ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <>
                              <Check className="h-4 w-4 mr-1" />
                              Approve
                            </>
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          className="flex-1"
                          onClick={() => setRejectDialog({ open: true, deposit })}
                          disabled={processingIds.has(deposit.id)}
                        >
                          <X className="h-4 w-4 mr-1" />
                          Reject
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </AnimatePresence>
        )}

        {/* Approve TID Dialog */}
        <AlertDialog open={approveDialog.open} onOpenChange={open => { if (!open) setApproveDialog({ open: false, deposit: null }); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Confirm Approval</AlertDialogTitle>
              <AlertDialogDescription>
                Enter the Transaction ID to approve {approveDialog.deposit && formatUGX(approveDialog.deposit.amount)}.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <Input
              placeholder="Enter Transaction ID"
              value={approveTid}
              onChange={(e) => setApproveTid(e.target.value)}
              className="font-mono uppercase"
            />
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleApprove} disabled={!approveTid.trim()}>
                Approve
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Reject Dialog */}
        <AlertDialog open={rejectDialog.open} onOpenChange={(open) => setRejectDialog({ open, deposit: null })}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Reject Deposit Request</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to reject this deposit of {rejectDialog.deposit && formatUGX(rejectDialog.deposit.amount)}?
              </AlertDialogDescription>
            </AlertDialogHeader>
            <Input
              placeholder="Reason for rejection (optional)"
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
      </TabsContent>

      <TabsContent value="analytics">
        <DepositAnalytics />
      </TabsContent>
    </Tabs>
  );
}
