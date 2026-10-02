import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Bike } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';

interface Row {
  lease_id: string;
  agent_name: string | null;
  agent_phone: string | null;
  bike_model: string | null;
  days_since_last_deduction: number;
  amount_outstanding: number;
}

/** Read-only: active bike leases with no wallet deduction for 7+ days. */
export function DormantBikeLeasesPanel() {
  const { data = [], isLoading, error } = useQuery({
    queryKey: ['dormant-bike-leases'],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('get_dormant_bike_leases');
      if (error) throw error;
      return (data || []) as Row[];
    },
  });

  if (isLoading || error || data.length === 0) return null;

  return (
    <div className="rounded-xl border-2 border-destructive/40 bg-destructive/5 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-destructive" />
        <p className="font-bold text-sm">Dormant Bike Leases</p>
        <span className="ml-auto rounded-full bg-destructive px-2 py-0.5 text-[11px] font-bold text-destructive-foreground">
          {data.length} high priority
        </span>
      </div>
      <p className="text-[11px] text-muted-foreground">No wallet deduction for 7 or more days.</p>
      <div className="divide-y divide-border rounded-lg border bg-card">
        {data.map((r) => {
          const severe = r.days_since_last_deduction >= 14;
          return (
            <div key={r.lease_id} className="flex items-center gap-3 px-3 py-2">
              <Bike className={cn('h-4 w-4 shrink-0', severe ? 'text-destructive' : 'text-warning')} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold truncate">{r.agent_name || 'Unknown agent'}</p>
                <p className="text-[11px] text-muted-foreground truncate">
                  {r.bike_model || 'Bike'}{r.agent_phone ? ` · ${r.agent_phone}` : ''}
                </p>
              </div>
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-[11px] font-bold whitespace-nowrap',
                  severe ? 'bg-destructive/15 text-destructive' : 'bg-warning/15 text-warning',
                )}
              >
                {r.days_since_last_deduction} days
              </span>
              <span className="text-xs font-bold whitespace-nowrap">{formatUGX(Number(r.amount_outstanding))}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default DormantBikeLeasesPanel;
