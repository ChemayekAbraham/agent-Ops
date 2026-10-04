import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

import { Skeleton } from '@/components/ui/skeleton';
import { Home, User, Shield, ArrowRight, Wallet, Clock, TrendingUp, HandCoins } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';

interface FundFlow {
  id: string;
  rent_amount: number;
  status: string;
  tenant_name: string;
  landlord_name: string;
  supporter_name: string;
  supporter_id: string | null;
  fund_recipient_type: string | null;
  fund_recipient_name: string | null;
  fund_routed_at: string | null;
  funded_at: string | null;
  created_at: string;
  total_roi_paid: number;
  roi_payments_count: number;
  next_roi_due_date: string | null;
}

export default function FundFlowTracker() {
  const [flows, setFlows] = useState<FundFlow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchFlows();
  }, []);

  const fetchFlows = async () => {
    setLoading(true);
    const { data: requests } = await supabase
      .from('rent_requests')
      .select('id, rent_amount, status, tenant_id, landlord_id, supporter_id, fund_recipient_type, fund_recipient_name, fund_routed_at, funded_at, created_at, total_roi_paid, roi_payments_count, next_roi_due_date')
      .in('status', ['funded', 'disbursed', 'completed', 'approved'])
      .order('created_at', { ascending: false })
      .limit(30);

    if (!requests || requests.length === 0) {
      setFlows([]);
      setLoading(false);
      return;
    }

    const userIds = [
      ...new Set(
        requests
          .flatMap((r) => [r.tenant_id, r.supporter_id])
          .filter(Boolean)
      ),
    ];
    const landlordIds = [...new Set(requests.map((r) => r.landlord_id).filter(Boolean))];

    const [profilesRes, landlordsRes] = await Promise.all([
      userIds.length > 0
        ? supabase.from('profiles').select('id, full_name').in('id', userIds)
        : { data: [] },
      landlordIds.length > 0
        ? supabase.from('landlords').select('id, name').in('id', landlordIds)
        : { data: [] },
    ]);

    const profileMap = new Map((profilesRes.data || []).map((p) => [p.id, p.full_name]));
    const landlordMap = new Map((landlordsRes.data || []).map((l) => [l.id, l.name]));

    setFlows(
      requests.map((r) => ({
        id: r.id,
        rent_amount: r.rent_amount,
        status: r.status,
        tenant_name: profileMap.get(r.tenant_id) || 'Unknown',
        landlord_name: landlordMap.get(r.landlord_id) || 'Unknown',
        supporter_name: r.supporter_id ? profileMap.get(r.supporter_id) || 'Unknown' : '—',
        supporter_id: r.supporter_id,
        fund_recipient_type: r.fund_recipient_type,
        fund_recipient_name: r.fund_recipient_name,
        fund_routed_at: r.fund_routed_at,
        funded_at: r.funded_at,
        created_at: r.created_at,
        total_roi_paid: Number(r.total_roi_paid) || 0,
        roi_payments_count: Number(r.roi_payments_count) || 0,
        next_roi_due_date: r.next_roi_due_date,
      }))
    );
    setLoading(false);
  };

  const recipientIcon = (type: string | null) => {
    switch (type) {
      case 'landlord': return <Home className="h-3.5 w-3.5" />;
      case 'caretaker': return <User className="h-3.5 w-3.5" />;
      case 'agent': return <Shield className="h-3.5 w-3.5" />;
      default: return <Clock className="h-3.5 w-3.5" />;
    }
  };

  const recipientColor = (type: string | null) => {
    switch (type) {
      case 'landlord': return 'bg-success/10 text-success border-success/30';
      case 'caretaker': return 'bg-blue-500/10 text-blue-500 border-blue-500/30';
      case 'agent': return 'bg-orange-500/10 text-orange-500 border-orange-500/30';
      default: return 'bg-muted text-muted-foreground border-border';
    }
  };

  // Aggregate totals
  const totalFunded = flows.reduce((s, f) => s + (f.supporter_id ? Number(f.rent_amount) : 0), 0);
  const totalROIPaid = flows.reduce((s, f) => s + f.total_roi_paid, 0);
  const expectedMonthlyROI = Math.round(totalFunded * 0.15);

  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Fund Flow Tracker</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2 px-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Wallet className="h-4 w-4 text-primary" />
            Fund Flow Tracker
          </CardTitle>
          <Badge variant="secondary" className="text-[10px]">
            {flows.length}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-2 space-y-3">
        {/* Funder Reward Summary */}
        {totalFunded > 0 && (
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-primary/5 border border-primary/20 p-2">
              <HandCoins className="h-3.5 w-3.5 mx-auto text-primary mb-0.5" />
              <p className="text-[10px] text-muted-foreground">Funded</p>
              <p className="text-xs font-bold">{formatUGX(totalFunded)}</p>
            </div>
            <div className="rounded-lg bg-emerald-500/5 border border-emerald-500/20 p-2">
              <TrendingUp className="h-3.5 w-3.5 mx-auto text-emerald-500 mb-0.5" />
              <p className="text-[10px] text-muted-foreground">ROI Paid</p>
              <p className="text-xs font-bold text-emerald-600">{formatUGX(totalROIPaid)}</p>
            </div>
            <div className="rounded-lg bg-amber-500/5 border border-amber-500/20 p-2">
              <Clock className="h-3.5 w-3.5 mx-auto text-amber-500 mb-0.5" />
              <p className="text-[10px] text-muted-foreground">Monthly Due</p>
              <p className="text-xs font-bold text-amber-600">{formatUGX(expectedMonthlyROI)}</p>
            </div>
          </div>
        )}

        {flows.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground py-6">No fund flows yet</p>
        ) : (
          <div className="divide-y divide-border max-h-[60vh] overflow-y-auto">
              {flows.map((flow) => {
                const monthlyReward = Math.round(Number(flow.rent_amount) * 0.15);
                return (
                  <div key={flow.id} className="py-3 space-y-2">
                    {/* Flow header */}
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium truncate">{flow.tenant_name}</p>
                      <span className="text-sm font-bold text-primary">
                        {formatUGX(Number(flow.rent_amount))}
                      </span>
                    </div>
                    {/* Flow path — stacked vertically for mobile */}
                    <div className="space-y-1 text-xs text-muted-foreground">
                      <div className="flex items-center gap-1.5">
                        <HandCoins className="h-3 w-3 shrink-0 text-primary" />
                        <span className="truncate">Supporter: {flow.supporter_name}</span>
                      </div>
                      <div className="flex items-center gap-1.5 pl-1">
                        <ArrowRight className="h-3 w-3 shrink-0 opacity-40" />
                        <Home className="h-3 w-3 shrink-0 text-emerald-500" />
                        <span className="truncate">Landlord: {flow.landlord_name}</span>
                      </div>
                      {flow.fund_recipient_type && (
                        <div className="flex items-center gap-1.5 pl-1">
                          <ArrowRight className="h-3 w-3 shrink-0 opacity-40" />
                          <Badge
                            variant="outline"
                            className={`text-[9px] px-1.5 py-0 ${recipientColor(flow.fund_recipient_type)}`}
                          >
                            {recipientIcon(flow.fund_recipient_type)}
                            <span className="ml-1 truncate max-w-[120px]">
                              {flow.fund_recipient_name} ({flow.fund_recipient_type})
                            </span>
                          </Badge>
                        </div>
                      )}
                    </div>
                    {/* Funder reward info */}
                    {flow.supporter_id && (
                      <div className="flex items-center gap-2 flex-wrap text-[10px]">
                        <Badge variant="outline" className="text-[9px] px-1.5 py-0 bg-emerald-500/10 text-emerald-600 border-emerald-500/30">
                          <TrendingUp className="h-2.5 w-2.5 mr-0.5" />
                          15% = {formatUGX(monthlyReward)}/mo
                        </Badge>
                        {flow.roi_payments_count > 0 && (
                          <span className="text-emerald-600">
                            Paid {flow.roi_payments_count}x ({formatUGX(flow.total_roi_paid)})
                          </span>
                        )}
                        {flow.roi_payments_count === 0 && flow.funded_at && (
                          <span className="text-amber-600">Pending first payout</span>
                        )}
                      </div>
                    )}
                    {/* Status */}
                    <div className="flex items-center gap-2">
                      <Badge
                        variant="outline"
                        className={`text-[9px] px-1.5 py-0 ${
                          flow.fund_routed_at
                            ? 'bg-success/10 text-success border-success/30'
                            : flow.status === 'funded'
                            ? 'bg-yellow-500/10 text-yellow-600 border-yellow-500/30'
                            : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {flow.fund_routed_at
                          ? '✓ Funds Delivered'
                          : flow.status === 'funded'
                          ? '⏳ Awaiting Verification'
                          : flow.status}
                      </Badge>
                    </div>
                  </div>
                );
              })}
            </div>
        )}
      </CardContent>
    </Card>
  );
}
