import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Clock, Home, MapPin, Loader2, User, FileText } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { formatDistanceToNow } from 'date-fns';

interface RentRequest {
  id: string;
  rent_amount: number;
  duration_days: number;
  status: string;
  created_at: string;
  house_category: string | null;
  request_city: string | null;
  tenant_name: string;
  tenant_phone: string;
}

const STATUS_CONFIG: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning' }> = {
  pending: { label: '⏳ Pending', variant: 'warning' },
  approved: { label: '✅ Approved', variant: 'success' },
  funded: { label: '💰 Funded', variant: 'success' },
  rejected: { label: '❌ Rejected', variant: 'destructive' },
};

const CATEGORY_LABELS: Record<string, string> = {
  'single-room': 'Single Room',
  'double-room': 'Double Room',
  '1-bed': '1 Bed',
  '2-bed': '2 Bed',
  '2-bed-full': '2 Bed Full',
  '3-bed': '3 Bed',
  '3-bed-luxury': '3 Bed Luxury',
  '4-bed': '4+ Bed',
  'shop': 'Shop / Lock-up Shop',
  'market-stall': 'Market Stall',
  'kiosk': 'Kiosk / Container',
  'salon-workshop': 'Salon / Workshop',
  'office': 'Office Space',
  'warehouse': 'Warehouse / Store',
  'commercial': 'Other Commercial Premises',
};

interface AgentTenantRentRequestsListProps {
  onOpenRequests?: () => void;
}

export function AgentTenantRentRequestsList({ onOpenRequests }: AgentTenantRentRequestsListProps) {
  const { user } = useAuth();
  const [requests, setRequests] = useState<RentRequest[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchRequests = useCallback(async () => {
    if (!user) return;

    const { data, error } = await supabase
      .from('rent_requests')
      .select('id, rent_amount, duration_days, status, created_at, house_category, request_city, tenant_id')
      .eq('agent_id', user.id)
      .in('status', ['pending', 'approved', 'funded'])
      .order('created_at', { ascending: false })
      .limit(15);

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
      })));
    }
    setLoading(false);
  }, [user]);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  if (loading) {
    return (
      <Card className="border border-border/60">
        <CardContent className="flex justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (requests.length === 0) return null;

  const pendingCount = requests.filter(r => r.status === 'pending').length;

  return (
    <div className="animate-fade-in">
      <Card className="border-2 border-primary/40 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent shadow-lg shadow-primary/10 overflow-hidden">
        <CardContent className="p-0">
          {/* Header */}
          <button
            onClick={onOpenRequests}
            className="flex items-center gap-3 px-4 py-3.5 bg-primary/15 border-b border-primary/20 w-full text-left hover:bg-primary/20 transition-colors touch-manipulation active:scale-[0.99]"
          >
            <div className="p-2.5 rounded-xl bg-primary/20">
              <FileText className="h-5 w-5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-extrabold text-base text-foreground">
                🏠 Tenant Rent Requests
              </h3>
              <p className="text-[11px] text-muted-foreground font-medium">
                {pendingCount > 0 ? `${pendingCount} awaiting action` : 'All processed'} · Tap for details →
              </p>
            </div>
            {pendingCount > 0 ? (
              <Badge variant="warning" className="text-xs font-bold px-2 py-0.5 animate-pulse">
                {pendingCount} pending
              </Badge>
            ) : (
              <Badge variant="secondary" className="text-[10px]">
                {requests.length}
              </Badge>
            )}
          </button>

          {/* List */}
          <div className="divide-y divide-border/40">
            {requests.map((req, i) => {
              const statusCfg = STATUS_CONFIG[req.status] || { label: req.status, variant: 'outline' as const };
              return (
                <div
                  key={req.id}
                  style={{ animationDelay: `${i * 0.04}s` }}
                  className="animate-fade-in px-4 py-3 hover:bg-muted/30 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <User className="h-3 w-3 text-muted-foreground shrink-0" />
                        <p className="font-semibold text-sm truncate">{req.tenant_name}</p>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap mt-1">
                        {req.house_category && (
                          <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                            <Home className="h-2.5 w-2.5" />
                            {CATEGORY_LABELS[req.house_category] || req.house_category}
                          </span>
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
                      <Badge variant={statusCfg.variant} className="text-[9px] px-1.5 py-0 mt-0.5">
                        {statusCfg.label}
                      </Badge>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mt-1.5">
                    <Clock className="h-2.5 w-2.5" />
                    {formatDistanceToNow(new Date(req.created_at), { addSuffix: true })}
                    <span>•</span>
                    <span>{req.duration_days}d</span>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
