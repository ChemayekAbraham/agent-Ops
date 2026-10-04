import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { FileText, MapPin, Clock, Loader2, Home, SmartphoneNfc, User, UserCheck } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { formatDistanceToNow } from 'date-fns';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { CollapsibleAgentSection } from '@/components/agent/CollapsibleAgentSection';
import { SwipeableRow, swipeActions } from '@/components/SwipeableRow';
import { RentRequestDetailDrawer } from '@/components/rent/RentRequestDetailDrawer';
import { RentApprovalConfirmDialog } from '@/components/rent/RentApprovalConfirmDialog';

interface PendingRequest {
  id: string;
  rent_amount: number;
  duration_days: number;
  daily_repayment: number;
  total_repayment: number;
  access_fee: number;
  request_fee: number;
  status: string;
  created_at: string;
  house_category: string | null;
  request_city: string | null;
  tenant_no_smartphone: boolean;
  tenant_id: string;
  agent_id: string | null;
  tenant: { full_name: string; phone: string } | null;
  agent: { full_name: string } | null;
}

const CATEGORY_LABELS: Record<string, string> = {
  'single-room': 'Single Room',
  'double-room': 'Double Room',
  '1-bed': '1 Bed House',
  '2-bed': '2 Bedroom',
  '2-bed-full': '2 Bed Full',
  '3-bed': '3 Bedroom',
  '3-bed-luxury': '3 Bed Luxury',
  '4-bed': '4+ Bed Villa',
  'shop': 'Shop / Lock-up Shop',
  'market-stall': 'Market Stall',
  'kiosk': 'Kiosk / Container',
  'salon-workshop': 'Salon / Workshop',
  'office': 'Office Space',
  'warehouse': 'Warehouse / Store',
  'commercial': 'Other Commercial Premises',
};

export function PendingRentRequestsWidget() {
  const [requests, setRequests] = useState<PendingRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState<PendingRequest | null>(null);

  const fetchRequests = async () => {
    const { data, error } = await supabase
      .from('rent_requests')
      .select('id, rent_amount, duration_days, daily_repayment, total_repayment, access_fee, request_fee, status, created_at, house_category, request_city, tenant_id, agent_id, tenant_no_smartphone')
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(20);

    if (!error && data) {
      const tenantIds = [...new Set(data.map(r => r.tenant_id))];
      const agentIds = [...new Set(data.map(r => r.agent_id).filter(Boolean))] as string[];
      const allIds = [...new Set([...tenantIds, ...agentIds])];
      
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, phone')
        .in('id', allIds);

      const profileMap = new Map((profiles || []).map(p => [p.id, p]));

      setRequests(data.map((r: any) => ({
        ...r,
        tenant: profileMap.get(r.tenant_id) ? { full_name: profileMap.get(r.tenant_id)!.full_name, phone: profileMap.get(r.tenant_id)!.phone } : null,
        agent: r.agent_id && profileMap.get(r.agent_id) ? { full_name: profileMap.get(r.agent_id)!.full_name } : null,
      })));
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchRequests();
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedFetch = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => fetchRequests(), 5000);
    };
    const channel = supabase
      .channel('pending-rent-requests-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rent_requests' }, () => { debouncedFetch(); })
      .subscribe();
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      supabase.removeChannel(channel);
    };
  }, []);

  const requestApproval = (req: PendingRequest) => {
    setPendingApproval(req);
  };

  const confirmApproval = async () => {
    if (!pendingApproval) return;
    const id = pendingApproval.id;
    setActionLoading(id);
    const { error } = await supabase
      .from('rent_requests')
      .update({ status: 'approved', approved_at: new Date().toISOString() })
      .eq('id', id);
    if (error) {
      toast.error('Failed to approve: ' + error.message);
    } else {
      toast.success('Request approved!');
      setRequests(prev => prev.filter(r => r.id !== id));
      setPendingApproval(null);
    }
    setActionLoading(null);
  };

  const handleReject = async (id: string) => {
    setActionLoading(id);
    const { error } = await supabase
      .from('rent_requests')
      .update({ status: 'rejected', rejected_reason: 'Rejected by manager' })
      .eq('id', id);
    if (error) {
      toast.error('Failed to reject: ' + error.message);
    } else {
      toast.success('Request rejected.');
      setRequests(prev => prev.filter(r => r.id !== id));
    }
    setActionLoading(null);
  };

  if (loading) {
    return (
      <CollapsibleAgentSection icon={FileText} label="Incoming Rent Requests" iconColor="text-primary">
        <div className="flex justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </CollapsibleAgentSection>
    );
  }

  return (
    <CollapsibleAgentSection
      icon={FileText}
      label={`Incoming Rent Requests${requests.length > 0 ? ` (${requests.length})` : ''}`}
      iconColor="text-primary"
    >
      {requests.length > 0 && (
        <p className="text-[10px] text-muted-foreground mb-2 px-1">
          ← Swipe left to reject · Swipe right to approve →
        </p>
      )}
      {requests.length === 0 ? (
        <div className="text-center py-6 text-sm text-muted-foreground">
          No pending rent requests
        </div>
      ) : (
        <div className="space-y-2">
          {requests.map((req, i) => (
            <motion.div
              key={req.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.03 }}
            >
              <SwipeableRow
                leftActions={[swipeActions.approve(() => requestApproval(req))]}
                rightActions={[swipeActions.reject(() => handleReject(req.id))]}
                disabled={!!actionLoading}
              >
              <div className="p-3 space-y-2 cursor-pointer active:bg-muted/50" onClick={() => setSelectedRequestId(req.id)}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-bold text-sm truncate">
                        {req.tenant?.full_name || 'Unknown Tenant'}
                      </p>
                      <div className="flex items-center gap-1.5 flex-wrap mt-1">
                        {/* Who posted indicator */}
                        {req.agent_id && req.agent_id !== req.tenant_id ? (
                          <Badge variant="outline" className="text-[9px] px-1.5 py-0 gap-0.5 border-amber-500/40 text-amber-600 bg-amber-500/8">
                            <UserCheck className="h-2.5 w-2.5" />
                            Agent Posted
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[9px] px-1.5 py-0 gap-0.5 border-emerald-500/40 text-emerald-600 bg-emerald-500/8">
                            <User className="h-2.5 w-2.5" />
                            Self Posted
                          </Badge>
                        )}
                        {/* No Smartphone badge */}
                        {req.tenant_no_smartphone && (
                          <Badge variant="outline" className="text-[9px] px-1.5 py-0 gap-0.5 border-red-500/40 text-red-600 bg-red-500/8">
                            <SmartphoneNfc className="h-2.5 w-2.5" />
                            No Phone
                          </Badge>
                        )}
                        {req.house_category && (
                          <Badge variant="secondary" className="text-[9px] px-1.5 py-0 gap-0.5">
                            <Home className="h-2.5 w-2.5" />
                            {CATEGORY_LABELS[req.house_category] || req.house_category}
                          </Badge>
                        )}
                        {req.request_city && (
                          <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                            <MapPin className="h-2.5 w-2.5" />
                            {req.request_city}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="font-bold text-sm">{formatUGX(req.rent_amount)}</p>
                      <p className="text-[9px] text-muted-foreground">Rent</p>
                    </div>
                  </div>

                  {/* Amounts breakdown */}
                  <div className="grid grid-cols-3 gap-1 bg-muted/30 rounded-lg px-2 py-1.5">
                    <div className="text-center">
                      <p className="text-[9px] text-muted-foreground">Daily</p>
                      <p className="text-[10px] font-bold">{formatUGX(req.daily_repayment)}</p>
                    </div>
                    <div className="text-center border-x border-border/50">
                      <p className="text-[9px] text-muted-foreground">Total Due</p>
                      <p className="text-[10px] font-bold">{formatUGX(req.total_repayment)}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-[9px] text-muted-foreground">Fees</p>
                      <p className="text-[10px] font-bold">{formatUGX(req.access_fee + req.request_fee)}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground flex-wrap">
                    <Clock className="h-2.5 w-2.5 shrink-0" />
                    <span>{formatDistanceToNow(new Date(req.created_at), { addSuffix: true })}</span>
                    {req.agent?.full_name && (
                      <>
                        <span>•</span>
                        <span className="truncate">by {req.agent.full_name}</span>
                      </>
                    )}
                    <span>•</span>
                    <span>{req.duration_days}d</span>
                  </div>
                </div>
              </SwipeableRow>
            </motion.div>
          ))}
        </div>
      )}
      <RentRequestDetailDrawer
        requestId={selectedRequestId}
        open={!!selectedRequestId}
        onOpenChange={(open) => { if (!open) setSelectedRequestId(null); }}
      />
      <RentApprovalConfirmDialog
        open={!!pendingApproval}
        onOpenChange={(open) => { if (!open) setPendingApproval(null); }}
        request={pendingApproval ? {
          id: pendingApproval.id,
          rent_amount: pendingApproval.rent_amount,
          duration_days: pendingApproval.duration_days,
          access_fee: pendingApproval.access_fee,
          request_fee: pendingApproval.request_fee,
          total_repayment: pendingApproval.total_repayment,
          daily_repayment: pendingApproval.daily_repayment,
          tenant_name: pendingApproval.tenant?.full_name ?? null,
        } : null}
        onConfirm={confirmApproval}
        loading={actionLoading === pendingApproval?.id}
      />
    </CollapsibleAgentSection>
  );
}
