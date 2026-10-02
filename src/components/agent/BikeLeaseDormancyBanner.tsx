import { useQuery } from '@tanstack/react-query';
import { Bike } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';

interface Row {
  lease_id: string;
  bike_model: string | null;
  days_since_last_deduction: number;
  amount_outstanding: number;
  lease_days_remaining: number;
}

/** Friendly reminder when the agent's bike lease repayments have paused for 7+ days. */
export function BikeLeaseDormancyBanner() {
  const { data = [] } = useQuery({
    queryKey: ['my-dormant-bike-leases'],
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('get_my_dormant_bike_leases');
      if (error) return [];
      return (data || []) as Row[];
    },
  });

  if (data.length === 0) return null;

  return (
    <div className="mx-3 mt-2 space-y-2">
      {data.map((r) => (
        <div key={r.lease_id} className="flex items-start gap-2.5 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2.5">
          <Bike className="h-4 w-4 mt-0.5 text-warning shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              Your bike lease payments have been paused for {r.days_since_last_deduction} days — collect rent to keep your repayment on track.
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {r.bike_model ? `${r.bike_model} · ` : ''}Balance left {formatUGX(Number(r.amount_outstanding))} · {r.lease_days_remaining} days remaining on your lease
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

export default BikeLeaseDormancyBanner;
