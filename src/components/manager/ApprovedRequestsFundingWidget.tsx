import { withUuidIds } from '@/lib/isUuid';
import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { CheckCircle, Home, Loader2, MapPin, Clock } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { excludePartnerReservedPlans } from '@/lib/partnerReservedPlans';
import { formatDistanceToNow } from 'date-fns';
import { motion } from 'framer-motion';
import { CollapsibleAgentSection } from '@/components/agent/CollapsibleAgentSection';

interface ApprovedRequest {
  id: string;
  rent_amount: number;
  duration_days: number;
  created_at: string;
  approved_at: string | null;
  house_category: string | null;
  request_city: string | null;
  tenant_name: string;
  agent_name: string | null;
  landlord_name: string;
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

export const NEEDS_FUNDER_PICK = "Needs a funder's pick on the funders' dashboard";

/**
 * Approved requests not yet funded. This used to offer a fund button paid from
 * Welile money (the CFO float-funding function); the database now refuses any
 * move into funded without a funder's pick (E60_FUNDERS_ONLY), so the list is
 * read-only and each request says what it needs. Plans a partner self-funds are
 * paid by Partner Ops approval and stay out of it, as before.
 */
export function ApprovedRequestsFundingWidget() {
  const [requests, setRequests] = useState<ApprovedRequest[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchApproved = async () => {
    const { data, error } = await supabase
      .from('rent_requests')
      .select('id, rent_amount, duration_days, created_at, approved_at, house_category, request_city, tenant_id, agent_id, landlord_id')
      .eq('status', 'approved')
      .is('funded_at', null)
      .order('approved_at', { ascending: false })
      .limit(30);

    if (error || !data) {
      setLoading(false);
      return;
    }

    // Partner self-funded plans are released by Partner Ops approval — not listed here.
    const rows = await excludePartnerReservedPlans(data);

    const tenantIds = [...new Set(rows.map(r => r.tenant_id))];
    const agentIds = [...new Set(rows.map(r => r.agent_id).filter(Boolean))] as string[];
    const landlordIds = [...new Set(rows.map(r => r.landlord_id))];
    const allUserIds = [...new Set([...tenantIds, ...agentIds])];

    const [profilesRes, landlordsRes] = await Promise.all([
      allUserIds.length > 0
        ? withUuidIds(allUserIds, (validIds) => supabase.from('profiles').select('id, full_name').in('id', validIds))
        : { data: [] },
      landlordIds.length > 0
        ? supabase.from('landlords').select('id, name').in('id', landlordIds)
        : { data: [] },
    ]);

    const profileMap = new Map((profilesRes.data || []).map(p => [p.id, p.full_name]));
    const landlordMap = new Map((landlordsRes.data || []).map(l => [l.id, l.name]));

    setRequests(rows.map(r => ({
      id: r.id,
      rent_amount: r.rent_amount,
      duration_days: r.duration_days,
      created_at: r.created_at,
      approved_at: r.approved_at,
      house_category: r.house_category,
      request_city: r.request_city,
      tenant_name: profileMap.get(r.tenant_id) || 'Unknown',
      agent_name: r.agent_id ? profileMap.get(r.agent_id) || null : null,
      landlord_name: landlordMap.get(r.landlord_id) || 'Unknown',
    })));
    setLoading(false);
  };

  useEffect(() => {
    fetchApproved();
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedFetch = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => fetchApproved(), 5000);
    };
    const channel = supabase
      .channel('approved-rent-requests-funding')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rent_requests' }, () => debouncedFetch())
      .subscribe();
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      supabase.removeChannel(channel);
    };
  }, []);

  if (loading) {
    return (
      <CollapsibleAgentSection icon={CheckCircle} label="Approved — waiting for a funder" iconColor="text-emerald-600">
        <div className="flex justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </CollapsibleAgentSection>
    );
  }

  return (
    <>
      <CollapsibleAgentSection
        icon={CheckCircle}
        label={`Approved — waiting for a funder${requests.length > 0 ? ` (${requests.length})` : ''}`}
        iconColor="text-emerald-600"
        isOpen={true}
      >
        {requests.length === 0 ? (
          <div className="text-center py-6 text-sm text-muted-foreground">
            No approved requests waiting for a funder
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Welile does not fund tenants directly (E60). A tenant is paid once a funder, or Welile&rsquo;s own funder
              account, selects them on the funders&rsquo; dashboard.
            </p>
            {requests.map((req, i) => (
              <motion.div
                key={req.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.03 }}
                className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-bold text-sm truncate">{req.tenant_name}</p>
                    <div className="flex items-center gap-2 flex-wrap mt-0.5">
                      {req.house_category && (
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 gap-0.5">
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
                  <p className="font-black text-sm text-emerald-600 dark:text-emerald-400 shrink-0">
                    {formatUGX(req.rent_amount)}
                  </p>
                </div>

                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <Clock className="h-2.5 w-2.5" />
                  Approved {req.approved_at ? formatDistanceToNow(new Date(req.approved_at), { addSuffix: true }) : '—'}
                  {req.agent_name && (
                    <>
                      <span>•</span>
                      <span>by {req.agent_name}</span>
                    </>
                  )}
                  <span>•</span>
                  <span>{req.duration_days}d</span>
                </div>

                <div className="flex items-center justify-between gap-2">
                  <p className="text-[10px] text-muted-foreground">
                    → Landlord: <span className="font-semibold text-foreground">{req.landlord_name}</span>
                  </p>
                  <span className="text-[11px] font-medium text-muted-foreground text-right" data-needs-pick={req.id}>
                    {NEEDS_FUNDER_PICK}
                  </span>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </CollapsibleAgentSection>
    </>
  );
}
