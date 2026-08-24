import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Loader2, MapPin, ExternalLink } from 'lucide-react';
import { format } from 'date-fns';
import { formatUGX } from '@/lib/businessAdvanceCalculations';
import { ServiceCentreStageTracker } from './ServiceCentreStageTracker';
import { getServiceCentreStage } from '@/lib/serviceCentreStage';

/** Service centres the COO has vetted and marked active. */
export function ActiveServiceCentresList() {
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['service-centres-active'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('service_centre_setups' as any)
        .select('*')
        .in('status', ['active', 'paid'])
        .order('ceo_approved_at', { ascending: false, nullsFirst: false });
      if (error) throw error;
      return (data || []) as any[];
    },
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-6">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!rows.length) {
    return (
      <p className="py-4 text-center text-sm text-muted-foreground">
        No active service centres yet. Verified centres become active once the COO vets them.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {rows.map((s: any) => (
        <div key={s.id} className="rounded-xl border border-border p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 space-y-0.5">
              <div className="flex items-center gap-2">
                <p className="truncate text-sm font-semibold text-foreground">{s.agent_name}</p>
                {getServiceCentreStage(s).isFunded ? (
                  <Badge className="bg-emerald-600 text-white text-[10px]">Funded</Badge>
                ) : (
                  <Badge className="bg-emerald-500/15 text-emerald-600 text-[10px]">Active</Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{s.agent_phone}</p>
              <p className="text-xs text-muted-foreground">{s.location_name || 'No description'}</p>
              {s.verified_amount != null && (
                <p className="text-xs font-medium text-foreground">
                  Unit price: {formatUGX(Number(s.verified_amount))}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Approved:{' '}
                {s.ceo_approved_at ? format(new Date(s.ceo_approved_at), 'dd MMM yyyy HH:mm') : 'n/a'}
              </p>
              {s.ceo_comment && (
                <p className="text-xs italic text-muted-foreground">COO note: {s.ceo_comment}</p>
              )}
              <ServiceCentreStageTracker setup={s} className="mt-1" />
            </div>
            <a
              href={`https://www.google.com/maps?q=${s.latitude},${s.longitude}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex shrink-0 items-center gap-1 text-xs text-primary hover:underline"
            >
              <MapPin className="h-3 w-3" />
              Map
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </div>
      ))}
    </div>
  );
}

export default ActiveServiceCentresList;
