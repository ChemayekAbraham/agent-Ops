import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { formatUGX } from '@/lib/rentCalculations';
import { 
  FileText, 
  CheckCircle, 
  XCircle, 
  Clock, 
  Loader2, 
  User,
  Building,
  Calendar,
  Banknote,
  MessageSquare,
  ChevronRight,
  RefreshCw,
  Home,
  Shield,
  ShieldCheck
} from 'lucide-react';
import { format } from 'date-fns';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
  DrawerFooter,
} from '@/components/ui/drawer';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import { hapticTap } from '@/lib/haptics';
import { useIsMobile } from '@/hooks/use-mobile';
import { VerifyTenantButton, VerifyLandlordButton } from '@/components/verification';

interface RentRequest {
  id: string;
  rent_amount: number;
  total_repayment: number;
  access_fee: number;
  request_fee: number;
  duration_days: number;
  daily_repayment: number;
  status: string | null;
  created_at: string;
  tenant_id: string;
  landlord_id: string;
  agent_id: string | null;
  approval_comment: string | null;
  rejected_reason: string | null;
  approved_by: string | null;
  agent_verified?: boolean;
  manager_verified?: boolean;
  tenant?: { full_name: string; phone: string };
  landlord?: { id: string; name: string; property_address: string; verified?: boolean; ready_to_receive?: boolean };
}

export function AgentRentRequestsManager() {
  const isMobile = useIsMobile();
  const [requests, setRequests] = useState<RentRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [processing, setProcessing] = useState<string | null>(null);
  const [selectedRequest, setSelectedRequest] = useState<RentRequest | null>(null);
  const [actionType, setActionType] = useState<'approve' | 'reject' | null>(null);
  const [comment, setComment] = useState('');

  useEffect(() => {
    fetchRequests();
  }, []);

  const fetchRequests = async () => {
    if (!loading) setRefreshing(true);
    
    const { data: requestsData, error } = await supabase
      .from('rent_requests')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      toast.error('Failed to load rent requests');
      setLoading(false);
      setRefreshing(false);
      return;
    }

    // Fetch tenant profiles
    const tenantIds = [...new Set((requestsData || []).map(r => r.tenant_id))];
    const { data: profiles } = tenantIds.length > 0
      ? await supabase.from('profiles').select('id, full_name, phone').in('id', tenantIds)
      : { data: [] };

    // Fetch landlords with verification status
    const landlordIds = [...new Set((requestsData || []).map(r => r.landlord_id))];
    const { data: landlords } = landlordIds.length > 0
      ? await supabase.from('landlords').select('id, name, property_address, verified, ready_to_receive').in('id', landlordIds)
      : { data: [] };

    const requestsWithDetails = (requestsData || []).map(r => ({
      ...r,
      tenant: profiles?.find(p => p.id === r.tenant_id),
      landlord: landlords?.find(l => l.id === r.landlord_id)
    }));

    setRequests(requestsWithDetails);
    setLoading(false);
    setRefreshing(false);
  };

  const handleApprove = async () => {
    if (!selectedRequest) return;
    setProcessing(selectedRequest.id);
    
    try {
      const { error } = await supabase.functions.invoke('approve-rent-request', {
        body: { 
          rent_request_id: selectedRequest.id,
          approval_comment: comment || null
        }
      });

      if (error) throw error;
      
      toast.success('Request approved successfully!');
      closeDialog();
      fetchRequests();
    } catch (error: any) {
      toast.error(error.message || 'Failed to approve request');
    } finally {
      setProcessing(null);
    }
  };

  const handleReject = async () => {
    if (!selectedRequest) return;
    if (!comment.trim()) {
      toast.error('Please provide a reason for rejection');
      return;
    }
    
    setProcessing(selectedRequest.id);
    
    try {
      const { error } = await supabase
        .from('rent_requests')
        .update({ 
          status: 'rejected',
          rejected_reason: comment
        })
        .eq('id', selectedRequest.id);

      if (error) throw error;
      
      toast.success('Request rejected');
      closeDialog();
      fetchRequests();
    } catch (error: any) {
      toast.error(error.message || 'Failed to reject request');
    } finally {
      setProcessing(null);
    }
  };

  const closeDialog = () => {
    setSelectedRequest(null);
    setActionType(null);
    setComment('');
  };

  const openAction = (request: RentRequest, action: 'approve' | 'reject') => {
    hapticTap();
    setSelectedRequest(request);
    setActionType(action);
    setComment('');
  };

  const getStatusBadge = (status: string | null) => {
    switch (status) {
      case 'pending':
        return <Badge variant="outline" className="bg-warning/10 text-warning border-warning/30 gap-1"><Clock className="h-3 w-3" />Pending</Badge>;
      case 'approved':
        return <Badge variant="outline" className="bg-primary/10 text-primary border-primary/30 gap-1"><CheckCircle className="h-3 w-3" />Approved</Badge>;
      case 'funded':
        return <Badge variant="outline" className="bg-success/10 text-success border-success/30 gap-1"><Banknote className="h-3 w-3" />Funded</Badge>;
      case 'disbursed':
        return <Badge variant="outline" className="bg-chart-5/10 text-chart-5 border-chart-5/30 gap-1"><CheckCircle className="h-3 w-3" />Disbursed</Badge>;
      case 'completed':
        return <Badge className="bg-success text-success-foreground gap-1"><CheckCircle className="h-3 w-3" />Completed</Badge>;
      case 'rejected':
        return <Badge variant="destructive" className="gap-1"><XCircle className="h-3 w-3" />Rejected</Badge>;
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  // Defensive: a rent request is only truly "completed" when fully repaid.
  // If the row is marked completed but money is still outstanding, surface
  // it as "Active" so users don't get a misleading green Completed badge.
  const getStatusBadgeForRequest = (req: { status: string | null; amount_repaid?: number | null; total_repayment?: number | null }) => {
    if (req.status === 'completed') {
      const repaid = Number(req.amount_repaid ?? 0);
      const total = Number(req.total_repayment ?? 0);
      if (total > 0 && repaid < total) {
        return <Badge variant="outline" className="bg-chart-5/10 text-chart-5 border-chart-5/30 gap-1"><Banknote className="h-3 w-3" />Active</Badge>;
      }
    }
    return getStatusBadge(req.status);
  };

  const pendingRequests = requests.filter(r => r.status === 'pending');
  const otherRequests = requests.filter(r => r.status !== 'pending');

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    );
  }

  const ActionContent = () => (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="comment">
          {actionType === 'approve' ? 'Comment (optional)' : 'Reason for rejection (required)'}
        </Label>
        <Textarea
          id="comment"
          placeholder={actionType === 'approve' 
            ? 'Add a comment about this approval...' 
            : 'Explain why you are rejecting this request...'
          }
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={4}
          className="resize-none"
        />
      </div>
      
      <div className="flex gap-3 pt-2">
        <Button 
          variant="outline" 
          onClick={closeDialog} 
          className="flex-1 min-h-[48px]"
          type="button"
        >
          Cancel
        </Button>
        <Button 
          onClick={(e) => {
            e.preventDefault();
            if (actionType === 'approve') {
              handleApprove();
            } else {
              handleReject();
            }
          }}
          disabled={processing === selectedRequest?.id || (actionType === 'reject' && !comment.trim())}
          variant={actionType === 'approve' ? 'success' : 'destructive'}
          className="flex-1 gap-2 min-h-[48px]"
          type="button"
        >
          {processing === selectedRequest?.id ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : actionType === 'approve' ? (
            <CheckCircle className="h-4 w-4" />
          ) : (
            <XCircle className="h-4 w-4" />
          )}
          {actionType === 'approve' ? 'Approve' : 'Reject'}
        </Button>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Header with refresh */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2">
            <Home className="h-5 w-5 text-primary" />
            Rent Requests
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Review and approve tenant rent requests
          </p>
        </div>
        <Button
          variant="outline"
          size="icon"
          onClick={() => {
            hapticTap();
            fetchRequests();
          }}
          disabled={refreshing}
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3">
        <Card className="bg-warning/5 border-warning/20">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-xl bg-warning/20">
                <Clock className="h-5 w-5 text-warning" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Pending</p>
                <p className="text-2xl font-bold text-warning">{pendingRequests.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-success/5 border-success/20">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-xl bg-success/20">
                <CheckCircle className="h-5 w-5 text-success" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Approved</p>
                <p className="text-2xl font-bold text-success">
                  {requests.filter(r => ['approved', 'funded', 'disbursed', 'completed'].includes(r.status || '')).length}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Pending Requests */}
      {pendingRequests.length > 0 && (
        <div className="space-y-3">
          <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">
            Pending Approval ({pendingRequests.length})
          </h3>
          <AnimatePresence>
            {pendingRequests.map((request, index) => (
              <motion.div
                key={request.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ delay: index * 0.05 }}
              >
                <Card className="border-2 border-warning/30 bg-warning/5">
                  <CardContent className="p-4">
                    <div className="flex flex-col gap-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-2">
                            <User className="h-4 w-4 text-primary" />
                            <span className="font-semibold truncate">
                              {request.tenant?.full_name || 'Unknown Tenant'}
                            </span>
                          </div>
                          
                          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
                            <Building className="h-3.5 w-3.5" />
                            <span className="truncate">{request.landlord?.property_address || 'Unknown'}</span>
                          </div>
                          
                          <div className="flex flex-wrap gap-2 text-sm">
                            <Badge variant="secondary" className="gap-1">
                              <Banknote className="h-3 w-3" />
                              {formatUGX(request.rent_amount)}
                            </Badge>
                            <Badge variant="outline" className="gap-1 bg-primary/10 text-primary border-primary/30 font-bold">
                              <Banknote className="h-3 w-3" />
                              {formatUGX(request.daily_repayment)}/day
                            </Badge>
                            <Badge variant="outline" className="gap-1">
                              <Calendar className="h-3 w-3" />
                              {request.duration_days} days
                            </Badge>
                          </div>
                          
                          <p className="text-xs text-primary font-medium mt-1.5">
                            📅 Repayment starts: {format(new Date(new Date(request.created_at).getTime() + 86400000), 'MMM d, yyyy')}
                          </p>
                        </div>
                        
                        <div className="flex flex-col gap-2 shrink-0">
                          <Button
                            size="default"
                            variant="success"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              openAction(request, 'approve');
                            }}
                            className="gap-1.5 min-h-[44px] min-w-[100px] touch-manipulation"
                            type="button"
                          >
                            <CheckCircle className="h-4 w-4" />
                            Approve
                          </Button>
                          <Button
                            size="default"
                            variant="destructive"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              openAction(request, 'reject');
                            }}
                            className="gap-1.5 min-h-[44px] min-w-[100px] touch-manipulation"
                            type="button"
                          >
                            <XCircle className="h-4 w-4" />
                            Reject
                          </Button>
                        </div>
                      </div>
                      
                      {/* Verification Section */}
                      <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-muted/50 border">
                        <div className="flex items-center gap-2 text-sm">
                          <Shield className="h-4 w-4 text-primary" />
                          <span className="font-medium">Verification Status</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <VerifyTenantButton
                            requestId={request.id}
                            landlordId={request.landlord_id}
                            agentVerified={request.agent_verified}
                            managerVerified={request.manager_verified}
                            onVerified={fetchRequests}
                            variant="agent"
                          />
                          {request.manager_verified && (
                            <Badge variant="outline" className="bg-primary/10 text-primary border-primary/30 gap-1">
                              <ShieldCheck className="h-3 w-3" />
                              Manager
                            </Badge>
                          )}
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      {/* Other Requests */}
      {otherRequests.length > 0 && (
        <div className="space-y-3">
          <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">
            All Requests ({otherRequests.length})
          </h3>
          <ScrollArea className="max-h-[400px]">
            <div className="space-y-2">
              {otherRequests.map((request) => (
                <Card key={request.id} className="bg-card/50">
                  <CardContent className="p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm truncate">
                            {request.tenant?.full_name || 'Unknown'}
                          </span>
                          {getStatusBadgeForRequest(request)}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                          {formatUGX(request.rent_amount)} • {request.duration_days} days
                        </p>
                        {request.approval_comment && (
                          <div className="flex items-start gap-1.5 mt-2 p-2 bg-success/10 rounded-lg">
                            <MessageSquare className="h-3.5 w-3.5 text-success mt-0.5 shrink-0" />
                            <p className="text-xs text-success">{request.approval_comment}</p>
                          </div>
                        )}
                        {request.rejected_reason && (
                          <div className="flex items-start gap-1.5 mt-2 p-2 bg-destructive/10 rounded-lg">
                            <MessageSquare className="h-3.5 w-3.5 text-destructive mt-0.5 shrink-0" />
                            <p className="text-xs text-destructive">{request.rejected_reason}</p>
                          </div>
                        )}
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </ScrollArea>
        </div>
      )}

      {requests.length === 0 && (
        <Card className="p-8 text-center">
          <FileText className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
          <p className="text-muted-foreground">No rent requests yet</p>
          <p className="text-sm text-muted-foreground/70 mt-1">
            Tenant requests will appear here for you to review
          </p>
        </Card>
      )}

      {/* Action Dialog/Drawer */}
      {isMobile ? (
        <Drawer open={!!selectedRequest && !!actionType} onOpenChange={(open) => !open && closeDialog()}>
          <DrawerContent>
            <DrawerHeader>
              <DrawerTitle className="flex items-center gap-2">
                {actionType === 'approve' ? (
                  <CheckCircle className="h-5 w-5 text-success" />
                ) : (
                  <XCircle className="h-5 w-5 text-destructive" />
                )}
                {actionType === 'approve' ? 'Approve Request' : 'Reject Request'}
              </DrawerTitle>
              <DrawerDescription>
                {selectedRequest?.tenant?.full_name} - {formatUGX(selectedRequest?.rent_amount || 0)}
              </DrawerDescription>
            </DrawerHeader>
            <div className="px-4 pb-4">
              <ActionContent />
            </div>
          </DrawerContent>
        </Drawer>
      ) : (
        <Dialog open={!!selectedRequest && !!actionType} onOpenChange={(open) => !open && closeDialog()}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {actionType === 'approve' ? (
                  <CheckCircle className="h-5 w-5 text-success" />
                ) : (
                  <XCircle className="h-5 w-5 text-destructive" />
                )}
                {actionType === 'approve' ? 'Approve Request' : 'Reject Request'}
              </DialogTitle>
              <DialogDescription>
                {selectedRequest?.tenant?.full_name} - {formatUGX(selectedRequest?.rent_amount || 0)}
              </DialogDescription>
            </DialogHeader>
            <ActionContent />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
