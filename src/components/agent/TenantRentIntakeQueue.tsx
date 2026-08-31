import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, Loader2, MapPin, Phone, UserCheck, XCircle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { formatUGX } from '@/lib/rentCalculations';

type Row = {
  id: string;
  tenant_id: string;
  tenant_name: string | null;
  tenant_phone: string | null;
  rent_amount: number;
  location_name: string | null;
  village_name: string | null;
  district_name: string | null;
  landlord_name: string;
  landlord_phone: string;
  tenant_note: string | null;
  status: string;
  distance_km: number | null;
  service_centre_name: string | null;
  decline_reason: string | null;
  created_at: string;
};

const STATUS_LABEL: Record<string, string> = {
  submitted: 'New',
  claimed: 'Claimed',
  visit_verified: 'House verified',
  approved: 'Approved',
  declined: 'Declined',
  rent_requested: 'Rent plan raised',
};

export function TenantRentIntakeQueue() {
  const qc = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [declineFor, setDeclineFor] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const { data: rows = [], isLoading, error } = useQuery({
    queryKey: ['tenant-rent-intake-queue'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('tenant_rent_intake_requests')
        .select('id, tenant_id, tenant_name, tenant_phone, rent_amount, location_name, village_name, district_name, landlord_name, landlord_phone, tenant_note, status, distance_km, service_centre_name, decline_reason, created_at')
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });

  const act = async (
    id: string,
    action: 'claim' | 'verify_visit' | 'approve' | 'decline',
    extra?: { reason?: string },
  ) => {
    setBusyId(id);
    try {
      let coords: { lat: number; lng: number } | null = null;
      if (action === 'verify_visit' && navigator.geolocation) {
        coords = await new Promise((resolve) =>
          navigator.geolocation.getCurrentPosition(
            (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
            () => resolve(null),
            { enableHighAccuracy: true, timeout: 15000 },
          ),
        );
        if (!coords) {
          toast.error('Location required', { description: 'Turn on location at the house to verify the visit.' });
          return;
        }
      }
      const { error } = await supabase.rpc('tenant_rent_intake_decide', {
        p_request_id: id,
        p_action: action,
        p_reason: extra?.reason ?? null,
        p_latitude: coords?.lat ?? null,
        p_longitude: coords?.lng ?? null,
      });
      if (error) throw error;
      toast.success('Updated');
      setDeclineFor(null); setReason('');
      qc.invalidateQueries({ queryKey: ['tenant-rent-intake-queue'] });
    } catch (e: any) {
      toast.error('Action failed', { description: e?.message });
    } finally {
      setBusyId(null);
    }
  };

  if (isLoading) {
    return <div className="flex items-center justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }
  if (error) {
    return <p className="text-sm text-destructive">{(error as Error).message}</p>;
  }
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground py-6 text-center">No tenant rent requests routed to you yet.</p>;
  }

  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <Card key={r.id}>
          <CardContent className="p-3 space-y-2.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-bold text-sm leading-tight break-words">{r.tenant_name || 'Tenant'}</p>
                <p className="text-[11px] text-muted-foreground break-words">
                  {[r.village_name, r.district_name].filter(Boolean).join(', ') || r.location_name || 'Location not shared'}
                  {r.distance_km != null ? ` · ${r.distance_km.toFixed(1)} km from centre` : ''}
                </p>
              </div>
              <Badge variant={r.status === 'declined' ? 'destructive' : 'secondary'} className="text-[10px] shrink-0">
                {STATUS_LABEL[r.status] ?? r.status}
              </Badge>
            </div>

            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div>
                <p className="text-muted-foreground">Monthly rent</p>
                <p className="font-bold text-foreground">{formatUGX(Number(r.rent_amount))}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Landlord</p>
                <p className="font-medium text-foreground break-words">{r.landlord_name}</p>
              </div>
            </div>

            {r.tenant_note && <p className="text-[11px] text-muted-foreground break-words">Note: {r.tenant_note}</p>}
            {r.decline_reason && <p className="text-[11px] text-destructive break-words">Declined: {r.decline_reason}</p>}

            <div className="flex flex-wrap gap-2">
              {r.tenant_phone && (
                <Button asChild size="sm" variant="outline" className="text-[11px]">
                  <a href={`tel:${r.tenant_phone}`}><Phone className="mr-1.5 h-3.5 w-3.5" />Tenant</a>
                </Button>
              )}
              <Button asChild size="sm" variant="outline" className="text-[11px]">
                <a href={`tel:${r.landlord_phone}`}><Phone className="mr-1.5 h-3.5 w-3.5" />Landlord</a>
              </Button>

              {r.status === 'submitted' && (
                <Button size="sm" className="text-[11px]" disabled={busyId === r.id} onClick={() => act(r.id, 'claim')}>
                  <UserCheck className="mr-1.5 h-3.5 w-3.5" />Claim
                </Button>
              )}
              {(r.status === 'submitted' || r.status === 'claimed') && (
                <Button size="sm" variant="secondary" className="text-[11px]" disabled={busyId === r.id} onClick={() => act(r.id, 'verify_visit')}>
                  <MapPin className="mr-1.5 h-3.5 w-3.5" />Verify house at site
                </Button>
              )}
              {(r.status === 'claimed' || r.status === 'visit_verified') && (
                <Button size="sm" className="text-[11px]" disabled={busyId === r.id} onClick={() => act(r.id, 'approve')}>
                  <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />Approve
                </Button>
              )}
              {!['declined', 'rent_requested'].includes(r.status) && (
                <Button size="sm" variant="ghost" className="text-[11px] text-destructive" onClick={() => { setDeclineFor(r.id); setReason(''); }}>
                  <XCircle className="mr-1.5 h-3.5 w-3.5" />Decline
                </Button>
              )}
            </div>

            {r.status === 'approved' && (
              <p className="text-[11px] text-muted-foreground">
                Approved — now raise the rent request for this tenant from your rent request flow.
              </p>
            )}

            {declineFor === r.id && (
              <div className="space-y-2 rounded-lg border p-2">
                <Textarea
                  rows={2} value={reason} onChange={(e) => setReason(e.target.value)}
                  placeholder="Reason (at least 10 characters)"
                  className="text-xs"
                />
                <div className="flex gap-2">
                  <Button size="sm" variant="destructive" className="text-[11px]" disabled={busyId === r.id || reason.trim().length < 10}
                    onClick={() => act(r.id, 'decline', { reason: reason.trim() })}>
                    Confirm decline
                  </Button>
                  <Button size="sm" variant="ghost" className="text-[11px]" onClick={() => setDeclineFor(null)}>Cancel</Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export default TenantRentIntakeQueue;
