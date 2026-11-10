import { withUuidIds } from '@/lib/isUuid';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Layers, Loader2, CheckCircle2 } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import { excludePartnerReservedPlans } from '@/lib/partnerReservedPlans';

export const NEEDS_FUNDER_PICK = "Needs a funder's pick on the funders' dashboard";

/**
 * COO-approved requests that no funder has picked yet. This used to batch-fund
 * them from Welile money (the CFO float-funding function); the database now refuses
 * any move into funded without a funder's pick (E60_FUNDERS_ONLY), so it is a
 * read-only list. Plans a partner self-funds are paid by Partner Ops approval
 * and stay out of it, as before.
 */
export function BatchPayoutProcessor() {
  const { data: pending, isLoading } = useQuery({
    queryKey: ['batch-payout-pending'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('rent_requests')
        .select('id, rent_amount, tenant_id, status, created_at')
        .eq('status', 'coo_approved')
        .order('created_at', { ascending: true });
      if (error) throw error;

      // Plans a partner is self-funding are disbursed by Partner Ops approval,
      // not by the company float — keep them out of this list.
      const rows = await excludePartnerReservedPlans(data || []);

      const userIds = [...new Set(rows.map(r => r.tenant_id))];
      const profileMap = new Map<string, string>();
      if (userIds.length > 0) {
        const { data: profiles } = await withUuidIds(userIds, (validIds) => supabase.from('profiles').select('id, full_name').in('id', validIds));
        for (const p of profiles || []) profileMap.set(p.id, p.full_name);
      }

      return rows.map(r => ({ ...r, amount: r.rent_amount, tenant_name: profileMap.get(r.tenant_id) || 'Unknown' }));
    },
    staleTime: 30_000,
  });

  const items = pending || [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Layers className="h-4 w-4 text-primary" />
          Batch Payout Processor
          {items.length > 0 && <Badge variant="outline" className="text-[10px] ml-1">{items.length} waiting for a funder</Badge>}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Welile does not fund tenants directly (E60). A tenant is paid once a funder, or Welile&rsquo;s own funder account, selects
          them on the funders&rsquo; dashboard.
        </p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : items.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <CheckCircle2 className="h-10 w-10 mx-auto mb-2 text-success" />
            <p className="font-medium">Nothing waiting</p>
            <p className="text-xs">No COO-approved request is waiting for a funder&rsquo;s pick</p>
          </div>
        ) : (
          <div className="space-y-1 max-h-[300px] overflow-y-auto">
            {items.map(item => (
              <div key={item.id} className="flex items-center gap-3 p-2 rounded-lg border text-sm" data-needs-pick={item.id}>
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{item.tenant_name}</p>
                  <p className="text-xs text-muted-foreground">
                    {format(new Date(item.created_at), 'dd MMM yyyy')} · {NEEDS_FUNDER_PICK}
                  </p>
                </div>
                <p className="font-mono font-bold text-xs">{formatUGX(item.amount)}</p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
