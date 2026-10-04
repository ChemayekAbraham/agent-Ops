import { useState, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useWallet } from '@/hooks/useWallet';
import { toast } from 'sonner';
import { Loader2, Check, X, Clock, ArrowDownLeft, ArrowUpRight } from 'lucide-react';

interface MoneyRequest {
  id: string;
  requester_id: string;
  recipient_id: string;
  amount: number;
  description: string | null;
  status: string;
  created_at: string;
  requester_name?: string;
  recipient_name?: string;
  requester_phone?: string;
}

interface PendingRequestsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PendingRequestsDialog({ open, onOpenChange }: PendingRequestsDialogProps) {
  const { user } = useAuth();
  const { sendMoney, wallet } = useWallet();
  const [requests, setRequests] = useState<MoneyRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [processingId, setProcessingId] = useState<string | null>(null);

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-UG', {
      style: 'currency',
      currency: 'UGX',
      minimumFractionDigits: 0,
    }).format(value);
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-UG', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const fetchRequests = useCallback(async () => {
    if (!user) return;

    setLoading(true);
    const { data, error } = await supabase
      .from('money_requests')
      .select('*')
      .or(`requester_id.eq.${user.id},recipient_id.eq.${user.id}`)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) {
      console.error('Error fetching requests:', error);
      setLoading(false);
      return;
    }

    if (data && data.length > 0) {
      const userIds = [...new Set([...data.map(r => r.requester_id), ...data.map(r => r.recipient_id)])];
      
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, phone')
        .in('id', userIds);

      const profileMap = new Map(profiles?.map(p => [p.id, p]) || []);

      const enrichedRequests = data.map(r => ({
        ...r,
        requester_name: profileMap.get(r.requester_id)?.full_name || 'Unknown',
        recipient_name: profileMap.get(r.recipient_id)?.full_name || 'Unknown',
        requester_phone: profileMap.get(r.requester_id)?.phone || '',
      }));

      setRequests(enrichedRequests);
    } else {
      setRequests([]);
    }
    setLoading(false);
  }, [user]);

  useEffect(() => {
    if (open) {
      fetchRequests();
    }
  }, [open, fetchRequests]);

  const handleApprove = async (request: MoneyRequest) => {
    if (!wallet || wallet.balance < request.amount) {
      toast.error('Insufficient balance');
      return;
    }

    setProcessingId(request.id);

    // Send money using the wallet transfer
    const { error: sendError } = await sendMoney(
      request.requester_phone!,
      request.amount,
      `Approved request: ${request.description || 'Money request'}`
    );

    if (sendError) {
      toast.error(sendError.message);
      setProcessingId(null);
      return;
    }

    // Update request status
    await supabase
      .from('money_requests')
      .update({ status: 'approved', responded_at: new Date().toISOString() })
      .eq('id', request.id);

    toast.success(`Sent ${formatCurrency(request.amount)} to ${request.requester_name}`);
    setProcessingId(null);
    fetchRequests();
  };

  const handleReject = async (requestId: string) => {
    setProcessingId(requestId);

    const { error } = await supabase
      .from('money_requests')
      .update({ status: 'rejected', responded_at: new Date().toISOString() })
      .eq('id', requestId);

    if (error) {
      toast.error('Failed to reject request');
      setProcessingId(null);
      return;
    }

    toast.success('Request rejected');
    setProcessingId(null);
    fetchRequests();
  };

  const pendingIncoming = requests.filter(r => r.recipient_id === user?.id && r.status === 'pending');
  const pendingOutgoing = requests.filter(r => r.requester_id === user?.id && r.status === 'pending');
  const history = requests.filter(r => r.status !== 'pending');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-primary" />
            Money Requests
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : (
          <div className="space-y-6">
            {/* Incoming Requests */}
            {pendingIncoming.length > 0 && (
              <div>
                <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
                  <ArrowDownLeft className="h-4 w-4 text-warning" />
                  Requests for You ({pendingIncoming.length})
                </h3>
                <div className="space-y-2">
                  {pendingIncoming.map((req) => (
                    <div key={req.id} className="p-3 rounded-lg bg-warning/10 border border-warning/20">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="font-medium">{req.requester_name}</p>
                          <p className="text-lg font-semibold text-warning">
                            {formatCurrency(req.amount)}
                          </p>
                          {req.description && (
                            <p className="text-sm text-muted-foreground truncate">{req.description}</p>
                          )}
                          <p className="text-xs text-muted-foreground mt-1">{formatDate(req.created_at)}</p>
                        </div>
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 w-8 p-0"
                            onClick={() => handleReject(req.id)}
                            disabled={processingId === req.id}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                          <Button
                            size="sm"
                            className="h-8 w-8 p-0"
                            onClick={() => handleApprove(req)}
                            disabled={processingId === req.id}
                          >
                            {processingId === req.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Check className="h-4 w-4" />
                            )}
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Outgoing Requests */}
            {pendingOutgoing.length > 0 && (
              <div>
                <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
                  <ArrowUpRight className="h-4 w-4 text-primary" />
                  Your Pending Requests ({pendingOutgoing.length})
                </h3>
                <div className="space-y-2">
                  {pendingOutgoing.map((req) => (
                    <div key={req.id} className="p-3 rounded-lg bg-secondary/50">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm text-muted-foreground">Requested from</p>
                          <p className="font-medium">{req.recipient_name}</p>
                          <p className="text-lg font-semibold">{formatCurrency(req.amount)}</p>
                        </div>
                        <Badge variant="outline" className="bg-warning/10 text-warning border-warning/20">
                          Pending
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* History */}
            {history.length > 0 && (
              <div>
                <h3 className="text-sm font-medium mb-3">History</h3>
                <div className="space-y-2">
                  {history.slice(0, 10).map((req) => {
                    const isRequester = req.requester_id === user?.id;
                    const isApproved = req.status === 'approved';
                    return (
                      <div key={req.id} className="p-3 rounded-lg bg-secondary/30 flex items-center justify-between">
                        <div>
                          <p className="text-sm">
                            {isRequester ? `From ${req.recipient_name}` : `To ${req.requester_name}`}
                          </p>
                          <p className="font-medium">{formatCurrency(req.amount)}</p>
                        </div>
                        <Badge 
                          variant="outline" 
                          className={isApproved ? 'bg-green-500/10 text-green-500' : 'bg-destructive/10 text-destructive'}
                        >
                          {req.status}
                        </Badge>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {requests.length === 0 && (
              <p className="text-center text-muted-foreground py-4">No money requests yet</p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
