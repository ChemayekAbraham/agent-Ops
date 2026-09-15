import { useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import {
  FileText, Loader2, CheckCircle, XCircle, Clock, AlertTriangle,
  Filter
} from 'lucide-react';
import { TreasuryImpactBanner } from './TreasuryImpactBanner';
import { format } from 'date-fns';
import {
import { CfoApprovalGate } from '@/components/cfo/CfoApprovalGate';
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter
} from '@/components/ui/dialog';

const statusBadge = (status: string) => {
  switch (status) {
    case 'pending':
      return <Badge variant="outline" className="gap-1 text-yellow-600 border-yellow-300"><Clock className="h-3 w-3" />Pending</Badge>;
    case 'approved':
      return <Badge variant="outline" className="gap-1 text-green-600 border-green-300"><CheckCircle className="h-3 w-3" />Approved</Badge>;
    case 'rejected':
      return <Badge variant="outline" className="gap-1 text-destructive border-destructive/30"><XCircle className="h-3 w-3" />Rejected</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
};

export function CFOAgentRequisitions() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>('pending');
  const [rejectDialog, setRejectDialog] = useState<{ open: boolean; id: string }>({ open: false, id: '' });
  const [rejectReason, setRejectReason] = useState('');

  const { data: requisitions = [], isLoading } = useQuery({
    queryKey: ['cfo-agent-requisitions', statusFilter],
    queryFn: async () => {
      let query: any = (supabase
        .from('pending_wallet_operations') as any)
        .select('*, profiles:user_id(full_name, phone)')
        .eq('category', 'agent_requisition')
        .order('created_at', { ascending: false })
        .limit(100);

      if (statusFilter !== 'all') {
        query = query.eq('status', statusFilter);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    },
  });

  const approveMutation = useMutation({
    mutationFn: async (reqId: string) => {
      const req = requisitions.find((r: any) => r.id === reqId);
      if (!req) throw new Error('Requisition not found');

      const { error } = await supabase.functions.invoke('approve-wallet-operation', {
        body: { operation_id: reqId },
      });
      if (error) throw error;

      // Audit log
      await supabase.from('audit_logs').insert({
        user_id: user?.id,
        action_type: 'requisition_approved',
        description: `Approved fund requisition of UGX ${Number(req.amount).toLocaleString()} for agent ${req.user_id}`,
        metadata: { operation_id: reqId, amount: req.amount, agent_id: req.user_id },
      });

      // Notify the requesting agent
      await supabase.from('notifications').insert({
        user_id: req.user_id,
        title: 'Requisition Approved',
        message: `Your fund requisition of UGX ${Number(req.amount).toLocaleString()} has been approved and credited to your wallet.`,
        type: 'requisition_approved',
        metadata: { operation_id: reqId, amount: req.amount },
      });
    },
    onSuccess: () => {
      toast.success('Requisition approved — funds credited to agent wallet');
      queryClient.invalidateQueries({ queryKey: ['cfo-agent-requisitions'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const rejectMutation = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const req = requisitions.find((r: any) => r.id === id);
      if (!req) throw new Error('Requisition not found');

      const { error } = await supabase
        .from('pending_wallet_operations')
        .update({
          status: 'rejected',
          rejection_reason: reason,
          reviewed_by: user?.id,
          reviewed_at: new Date().toISOString(),
        })
        .eq('id', id);
      if (error) throw error;

      // Audit log
      await supabase.from('audit_logs').insert({
        user_id: user?.id,
        action_type: 'requisition_rejected',
        description: `Rejected fund requisition of UGX ${Number(req.amount).toLocaleString()} — ${reason}`,
        metadata: { operation_id: id, amount: req.amount, agent_id: req.user_id, reason },
      });

      // Notify agent
      await supabase.from('notifications').insert({
        user_id: req.user_id,
        title: 'Requisition Rejected',
        message: `Your fund requisition of UGX ${Number(req.amount).toLocaleString()} was rejected. Reason: ${reason}`,
        type: 'requisition_rejected',
        metadata: { operation_id: id, reason },
      });
    },
    onSuccess: () => {
      toast.success('Requisition rejected');
      setRejectDialog({ open: false, id: '' });
      setRejectReason('');
      queryClient.invalidateQueries({ queryKey: ['cfo-agent-requisitions'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const pendingCount = requisitions.filter((r: any) => r.status === 'pending').length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <FileText className="h-5 w-5 text-primary" />
          Agent Requisitions
          {pendingCount > 0 && statusFilter === 'pending' && (
            <Badge className="bg-yellow-500 text-white">{pendingCount}</Badge>
          )}
        </h1>
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[130px] h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
              <SelectItem value="all">All</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : requisitions.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground text-sm">
            No {statusFilter !== 'all' ? statusFilter : ''} requisitions found.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {requisitions.map((req: any) => {
            const meta = typeof req.metadata === 'object' ? req.metadata : {};
            const profile = req.profiles;
            return (
              <Card key={req.id}>
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-start justify-between flex-wrap gap-2">
                    <div className="space-y-1">
                      <p className="font-semibold text-sm">
                        {profile?.full_name || 'Unknown Agent'}
                        <span className="text-xs text-muted-foreground ml-2">{profile?.phone || ''}</span>
                      </p>
                      <p className="text-lg font-bold">UGX {Number(req.amount).toLocaleString()}</p>
                    </div>
                    {statusBadge(req.status)}
                  </div>

                  <div className="space-y-1">
                    <p className="text-xs font-medium capitalize">
                      <span className="text-muted-foreground">Purpose:</span>{' '}
                      {meta.purpose?.replace(/_/g, ' ') || 'N/A'}
                    </p>
                    <p className="text-xs text-muted-foreground">{meta.description || req.description}</p>
                    <p className="text-[10px] text-muted-foreground">
                      Submitted: {format(new Date(req.created_at), 'MMM d, yyyy HH:mm')}
                    </p>
                  </div>

                  {req.status === 'rejected' && req.rejection_reason && (
                    <div className="flex items-start gap-2 p-2 rounded-lg bg-destructive/10 text-xs text-destructive">
                      <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                      {req.rejection_reason}
                    </div>
                  )}

                  {req.status === 'pending' && (
                    <CfoApprovalGate>
                    <div className="space-y-3 pt-1">
                      <TreasuryImpactBanner payoutAmount={Number(req.amount)} />
                      <div className="flex gap-2">
                      <Button
                        size="sm"
                        className="gap-1 flex-1"
                        onClick={() => approveMutation.mutate(req.id)}
                        disabled={approveMutation.isPending}
                      >
                        {approveMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle className="h-3 w-3" />}
                        Approve & Credit
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        className="gap-1 flex-1"
                        onClick={() => setRejectDialog({ open: true, id: req.id })}
                      >
                        <XCircle className="h-3 w-3" />
                        Reject
                      </Button>
                      </div>
                    </div>
                    </CfoApprovalGate>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Reject Dialog */}
      <Dialog open={rejectDialog.open} onOpenChange={(o) => { if (!o) { setRejectDialog({ open: false, id: '' }); setRejectReason(''); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject Requisition</DialogTitle>
            <DialogDescription>Provide a reason for rejection (min 10 characters).</DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="Reason for rejection..."
            value={rejectReason}
            onChange={e => setRejectReason(e.target.value)}
            rows={3}
          />
          <p className="text-xs text-muted-foreground">{rejectReason.trim().length}/10 minimum</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setRejectDialog({ open: false, id: '' }); setRejectReason(''); }}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={rejectReason.trim().length < 10 || rejectMutation.isPending}
              onClick={() => rejectMutation.mutate({ id: rejectDialog.id, reason: rejectReason.trim() })}
            >
              {rejectMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Confirm Rejection'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
