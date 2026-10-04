import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Home, Clock, User, ChevronRight, Loader2, CheckCircle, XCircle } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { formatDistanceToNow } from 'date-fns';
import { hapticTap } from '@/lib/haptics';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';

interface RentRequestCompact {
  id: string;
  rent_amount: number;
  duration_days: number;
  status: string;
  created_at: string;
  tenant_name: string;
  tenant_phone: string;
  house_category: string | null;
  request_city: string | null;
  agent_verified: boolean;
}

export function AgentRentRequestsWalletSection() {
  const { user } = useAuth();
  const [requests, setRequests] = useState<RentRequestCompact[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionType, setActionType] = useState<'verify' | 'reject' | null>(null);
  const [comment, setComment] = useState('');
  const [processing, setProcessing] = useState(false);

  const fetchRequests = useCallback(async () => {
    if (!user) return;

    const { data, error } = await supabase
      .from('rent_requests')
      .select('id, rent_amount, duration_days, status, created_at, house_category, request_city, tenant_id, agent_verified')
      .eq('agent_id', user.id)
      .in('status', ['pending', 'approved'])
      .order('created_at', { ascending: false })
      .limit(10);

    if (!error && data) {
      const tenantIds = [...new Set(data.map(r => r.tenant_id))];
      const { data: profiles } = tenantIds.length > 0
        ? await supabase.from('profiles').select('id, full_name, phone').in('id', tenantIds)
        : { data: [] };

      const profileMap = new Map((profiles || []).map(p => [p.id, p]));

      setRequests(data.map((r: any) => ({
        id: r.id,
        rent_amount: r.rent_amount,
        duration_days: r.duration_days,
        status: r.status,
        created_at: r.created_at,
        house_category: r.house_category,
        request_city: r.request_city,
        tenant_name: profileMap.get(r.tenant_id)?.full_name || 'Unknown',
        tenant_phone: profileMap.get(r.tenant_id)?.phone || '',
        agent_verified: r.agent_verified || false,
      })));
    }
    setLoading(false);
  }, [user]);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  const handleVerify = async () => {
    if (!selectedId) return;
    setProcessing(true);

    const { error } = await supabase
      .from('rent_requests')
      .update({ agent_verified: true, approval_comment: comment || null })
      .eq('id', selectedId);

    if (error) {
      toast.error('Failed to verify request');
    } else {
      toast.success('Request verified ✅');
      fetchRequests();
    }
    setProcessing(false);
    setSelectedId(null);
    setActionType(null);
    setComment('');
  };

  const handleReject = async () => {
    if (!selectedId || !comment.trim()) {
      toast.error('Please provide a reason for rejection');
      return;
    }
    setProcessing(true);

    const { error } = await supabase
      .from('rent_requests')
      .update({ status: 'rejected', rejected_reason: comment })
      .eq('id', selectedId);

    if (error) {
      toast.error('Failed to reject request');
    } else {
      toast.success('Request rejected');
      fetchRequests();
    }
    setProcessing(false);
    setSelectedId(null);
    setActionType(null);
    setComment('');
  };

  if (loading) {
    return (
      <Card className="border-border/50 rounded-2xl">
        <CardContent className="flex justify-center py-4">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (requests.length === 0) return null;

  const unverified = requests.filter(r => !r.agent_verified).length;

  return (
    <>
      <Card className="border-primary/30 rounded-2xl bg-primary/5">
        <CardContent className="p-0">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-primary/20">
            <Home className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-bold flex-1">Rent Requests</h3>
            {unverified > 0 && (
              <Badge variant="warning" className="text-[10px] px-1.5 py-0 animate-pulse">
                {unverified} to verify
              </Badge>
            )}
          </div>

          <div className="divide-y divide-border/30 max-h-[300px] overflow-y-auto">
            {requests.map((req) => (
              <div key={req.id} className="px-4 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <User className="h-3 w-3 text-muted-foreground shrink-0" />
                      <p className="font-semibold text-xs truncate">{req.tenant_name}</p>
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-muted-foreground">
                      <Clock className="h-2.5 w-2.5" />
                      {formatDistanceToNow(new Date(req.created_at), { addSuffix: true })}
                      <span>•</span>
                      <span className="font-medium text-foreground">{formatUGX(req.rent_amount)}</span>
                    </div>
                  </div>

                  {req.agent_verified ? (
                    <Badge variant="success" className="text-[9px] px-1.5 py-0 shrink-0">
                      ✅ Verified
                    </Badge>
                  ) : (
                    <div className="flex gap-1 shrink-0">
                      <Button
                        size="sm"
                        variant="success"
                        className="h-7 px-2 text-[10px] gap-1"
                        onClick={() => {
                          hapticTap();
                          setSelectedId(req.id);
                          setActionType('verify');
                        }}
                      >
                        <CheckCircle className="h-3 w-3" />
                        Verify
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        className="h-7 px-2 text-[10px] gap-1"
                        onClick={() => {
                          hapticTap();
                          setSelectedId(req.id);
                          setActionType('reject');
                        }}
                      >
                        <XCircle className="h-3 w-3" />
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Verify / Reject Dialog */}
      <Dialog open={!!actionType} onOpenChange={(open) => { if (!open) { setActionType(null); setSelectedId(null); setComment(''); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {actionType === 'verify' ? '✅ Verify Rent Request' : '❌ Reject Rent Request'}
            </DialogTitle>
          </DialogHeader>
          <Textarea
            placeholder={actionType === 'reject' ? 'Reason for rejection (required)...' : 'Optional comment...'}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            className="min-h-[80px]"
          />
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setActionType(null); setComment(''); }}>
              Cancel
            </Button>
            <Button
              variant={actionType === 'verify' ? 'success' : 'destructive'}
              onClick={actionType === 'verify' ? handleVerify : handleReject}
              disabled={processing || (actionType === 'reject' && !comment.trim())}
            >
              {processing ? <Loader2 className="h-4 w-4 animate-spin" /> : actionType === 'verify' ? 'Confirm Verify' : 'Confirm Reject'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
