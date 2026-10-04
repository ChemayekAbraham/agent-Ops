import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CheckCircle, Clock, Home, MapPin, Loader2, User, Pencil } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { formatDistanceToNow } from 'date-fns';
import { EditApprovedRentDialog } from './EditApprovedRentDialog';

import { useAuth } from '@/hooks/useAuth';

interface ApprovedRequest {
  id: string;
  rent_amount: number;
  duration_days: number;
  status: string;
  approved_at: string | null;
  created_at: string;
  house_category: string | null;
  request_city: string | null;
  access_fee?: number;
  request_fee?: number;
  total_repayment?: number;
  daily_repayment?: number;
  number_of_payments?: number | null;
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

interface ApprovedRentRequestsWidgetProps {
  /** When 'agent', only shows requests posted by the current agent */
  mode: 'manager' | 'agent';
}

export function ApprovedRentRequestsWidget({ mode }: ApprovedRentRequestsWidgetProps) {
  const { user } = useAuth();
  const [requests, setRequests] = useState<ApprovedRequest[]>([]);
  const [loading, setLoading] = useState(true);

  const [editingRequest, setEditingRequest] = useState<ApprovedRequest | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  const fetchRequests = useCallback(async () => {
    if (!user) return;

    let query = supabase
      .from('rent_requests')
      .select('id, rent_amount, duration_days, status, approved_at, created_at, house_category, request_city, access_fee, request_fee, total_repayment, daily_repayment, number_of_payments, tenant_id, agent_id')
      .in('status', ['approved', 'funded'])
      .order('approved_at', { ascending: false })
      .limit(20);

    if (mode === 'agent') {
      query = query.eq('agent_id', user.id);
    }

    const { data, error } = await query;

    if (!error && data) {
      const tenantIds = [...new Set(data.map(r => r.tenant_id))];
      const agentIds = [...new Set(data.map(r => r.agent_id).filter(Boolean))] as string[];
      const allIds = [...new Set([...tenantIds, ...agentIds])];

      const { data: profiles } = allIds.length > 0
        ? await supabase.from('profiles').select('id, full_name, phone').in('id', allIds)
        : { data: [] };

      const profileMap = new Map((profiles || []).map(p => [p.id, p]));

      setRequests(data.map((r: any) => ({
        ...r,
        tenant: profileMap.get(r.tenant_id) ? { full_name: profileMap.get(r.tenant_id)!.full_name, phone: profileMap.get(r.tenant_id)!.phone } : null,
        agent: r.agent_id && profileMap.get(r.agent_id) ? { full_name: profileMap.get(r.agent_id)!.full_name } : null,
      })));
    }
    setLoading(false);
  }, [user, mode]);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  if (loading) {
    return (
      <Card className="border-2 border-success/50 bg-success/5">
        <CardContent className="flex justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-success" />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="animate-fade-in">
      <Card className="border-2 border-success bg-gradient-to-br from-success/15 via-success/10 to-emerald-500/5 shadow-lg shadow-success/10 overflow-hidden">
        <CardContent className="p-0">
          {/* Header */}
          <div className="flex items-center gap-3 px-4 py-3 bg-success/20 border-b border-success/30">
            <div className="p-2 rounded-full bg-success/30">
              <CheckCircle className="h-5 w-5 text-success" />
            </div>
            <h3 className="font-bold text-base text-success">
              ✅ Approved Rent Requests{requests.length > 0 ? ` (${requests.length})` : ''}
            </h3>
          </div>

          {requests.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              No approved rent requests yet
            </div>
          ) : (
            <div className="divide-y divide-success/20">
              {requests.map((req, i) => (
                <div
                  key={req.id}
                  style={{ animationDelay: `${i * 0.05}s` }}
                  className="animate-fade-in px-4 py-3 hover:bg-success/10 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-bold text-sm truncate">
                        {req.tenant?.full_name || 'Unknown Tenant'}
                      </p>
                      <div className="flex items-center gap-2 flex-wrap mt-1">
                        {req.house_category && (
                          <Badge variant="success" className="text-[10px] px-1.5 py-0 gap-0.5">
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
                    <div className="text-right shrink-0 flex items-start gap-1.5">
                      <div>
                        <p className="font-extrabold text-base text-success">{formatUGX(req.rent_amount)}</p>
                        <Badge variant="success" className="text-[10px] gap-0.5 mt-0.5">
                          <CheckCircle className="h-2.5 w-2.5" />
                          Approved
                        </Badge>
                      </div>
                      {mode === 'manager' && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 shrink-0"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingRequest(req);
                            setEditOpen(true);
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                        </Button>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground mt-1.5">
                    <Clock className="h-2.5 w-2.5" />
                    {req.approved_at
                      ? `Approved ${formatDistanceToNow(new Date(req.approved_at), { addSuffix: true })}`
                      : `Requested ${formatDistanceToNow(new Date(req.created_at), { addSuffix: true })}`
                    }
                    {mode === 'manager' && req.agent?.full_name && (
                      <>
                        <span>•</span>
                        <User className="h-2.5 w-2.5" />
                        <span>{req.agent.full_name}</span>
                      </>
                    )}
                    <span>•</span>
                    <span>{req.duration_days}d</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <EditApprovedRentDialog
        request={editingRequest}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={fetchRequests}
      />
    </div>
  );
}
