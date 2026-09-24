import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';
import { CheckCircle2, FileText, Loader2, MapPin, MapPinOff, MessageCircle, Phone, UserCheck, XCircle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { formatUGX } from '@/lib/rentCalculations';
import { matchesVettingQuery } from '@/components/agent/service-center/matchesVettingQuery';
import AgentRentRequestDialog from '@/components/agent/AgentRentRequestDialog';

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
  claimed_by: string | null;
  latitude: number | null;
  longitude: number | null;
  created_at: string;
  source: 'intake_form' | 'self_onboarding';
  rent_request_id: string | null;
  assigned_agent_id: string | null;
  assigned_agent_distance_km: number | null;
  claim_distance_km: number | null;
  claim_proximity: 'near' | 'far' | null;
  forwarded_from_agent_id: string | null;
  forwarded_at: string | null;
  forward_reason: string | null;
};

const QUEUE_KEY = ['tenant-rent-intake-queue'];

const STATUS_LABEL: Record<string, string> = {
  submitted: 'New',
  claimed: 'Claimed',
  visit_verified: 'House verified',
  approved: 'Approved',
  declined: 'Declined',
  rent_requested: 'Rent plan raised',
};

const OPEN_STATUSES = ['submitted', 'claimed', 'visit_verified', 'approved'];

/**
 * Shared query for the tenant-initiated rent request queue. The Service Centre
 * page reuses this hook for its tab count / alert, so both read the same
 * React Query cache entry instead of firing a second request.
 */
export function useTenantRentIntakeQueue() {
  const query = useQuery({
    queryKey: QUEUE_KEY,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('tenant_rent_intake_requests')
        .select('id, tenant_id, tenant_name, tenant_phone, rent_amount, location_name, village_name, district_name, landlord_name, landlord_phone, tenant_note, status, distance_km, service_centre_name, decline_reason, claimed_by, latitude, longitude, created_at, source, rent_request_id, assigned_agent_id, assigned_agent_distance_km, claim_distance_km, claim_proximity, forwarded_from_agent_id, forwarded_at, forward_reason')
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });

  const rows = query.data ?? [];
  return {
    ...query,
    rows,
    openCount: rows.filter((r) => OPEN_STATUSES.includes(r.status)).length,
    newCount: rows.filter((r) => r.status === 'submitted').length,
  };
}

type FilterKey = 'new' | 'mine' | 'approved' | 'closed' | 'all';

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'new', label: 'New' },
  { key: 'mine', label: 'Mine' },
  { key: 'approved', label: 'Approved' },
  { key: 'closed', label: 'Closed' },
  { key: 'all', label: 'All' },
];

const waHref = (phone: string) => `https://wa.me/${phone.replace(/[^\d]/g, '')}`;

export function TenantRentIntakeQueue({ searchQuery = '' }: { searchQuery?: string } = {}) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [declineFor, setDeclineFor] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [filter, setFilter] = useState<FilterKey>('new');
  const [raiseFor, setRaiseFor] = useState<Row | null>(null);

  const { rows, isLoading, error } = useTenantRentIntakeQueue();

  const act = async (
    id: string,
    action: 'claim' | 'verify_visit' | 'approve' | 'decline' | 'forward',
    extra?: { reason?: string; toAgentId?: string },
  ) => {
    setBusyId(id);
    try {
      let coords: { lat: number; lng: number } | null = null;
      // Claim records how far the claiming agent is from the tenant's pin;
      // verify_visit proves the agent is at the house. Both need live GPS.
      if (action === 'claim' || action === 'verify_visit') {
        if (!navigator.geolocation) {
          toast.error('Location required', { description: 'This device cannot share its location.' });
          return;
        }
        coords = await new Promise((resolve) =>
          navigator.geolocation.getCurrentPosition(
            (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
            () => resolve(null),
            { enableHighAccuracy: true, timeout: 15000 },
          ),
        );
        if (!coords) {
          toast.error('Location required', {
            description: action === 'claim'
              ? 'Turn on location to claim — we check how close you are to the tenant.'
              : 'Turn on location at the house to verify the visit.',
          });
          return;
        }
      }
      // p_to_agent_id is newer than the generated types.
      const { data, error } = await (supabase as any).rpc('tenant_rent_intake_decide', {
        p_request_id: id,
        p_action: action,
        p_reason: extra?.reason ?? null,
        p_latitude: coords?.lat ?? null,
        p_longitude: coords?.lng ?? null,
        p_to_agent_id: extra?.toAgentId ?? null,
      });
      if (error) throw error;
      const result = data as { proximity?: 'near' | 'far' | null; distance_km?: number | null } | null;
      if (action === 'claim' && result?.proximity === 'far' && result.distance_km != null) {
        toast.warning('Claimed — but you are far from this tenant', {
          description: `You are about ${Number(result.distance_km).toFixed(1)} km from their house. Consider forwarding to a nearer agent.`,
        });
      } else {
        toast.success(action === 'forward' ? 'Tenant forwarded' : 'Updated');
      }
      setDeclineFor(null); setReason('');
      qc.invalidateQueries({ queryKey: QUEUE_KEY });
    } catch (e: any) {
      toast.error('Action failed', { description: e?.message });
    } finally {
      setBusyId(null);
    }
  };

  /**
   * After the normal rent request dialog completes we look up the row it just
   * created for this tenant (newest first) and link it back to the intake, so
   * the tenant's tracker moves to "Rent plan raised" without the agent doing
   * anything extra. A failure here is non-fatal: the rent request itself is
   * already created, only the intake link is missing.
   */
  const linkRaisedRequest = async (intake: Row) => {
    try {
      const { data, error } = await supabase
        .from('rent_requests')
        .select('id')
        .eq('tenant_id', intake.tenant_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (!data?.id) return;
      const { error: rpcError } = await supabase.rpc('tenant_rent_intake_decide', {
        p_request_id: intake.id,
        p_action: 'link_rent_request',
        p_rent_request_id: data.id,
      });
      if (rpcError) throw rpcError;
      toast.success('Rent plan linked to the tenant request');
    } catch (e: any) {
      toast.error('Rent request created, but not linked', { description: e?.message });
    } finally {
      qc.invalidateQueries({ queryKey: QUEUE_KEY });
    }
  };

  const filtered = useMemo(() => {
    const bySearch = rows.filter((r) =>
      matchesVettingQuery(searchQuery, r.tenant_name, r.tenant_phone, r.landlord_name, r.landlord_phone, r.village_name, r.district_name, r.location_name),
    );
    const byFilter = bySearch.filter((r) => {
      switch (filter) {
        case 'new': return r.status === 'submitted';
        case 'mine': return !!user?.id && r.claimed_by === user.id && OPEN_STATUSES.includes(r.status);
        case 'approved': return r.status === 'approved';
        case 'closed': return r.status === 'declined' || r.status === 'rent_requested';
        default: return true;
      }
    });
    // Open work first, then nearest, then newest.
    return [...byFilter].sort((a, b) => {
      const openA = OPEN_STATUSES.includes(a.status) ? 0 : 1;
      const openB = OPEN_STATUSES.includes(b.status) ? 0 : 1;
      if (openA !== openB) return openA - openB;
      const da = a.distance_km ?? Number.POSITIVE_INFINITY;
      const db = b.distance_km ?? Number.POSITIVE_INFINITY;
      if (da !== db) return da - db;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
  }, [rows, searchQuery, filter, user?.id]);

  const counts = useMemo(() => ({
    new: rows.filter((r) => r.status === 'submitted').length,
    mine: rows.filter((r) => !!user?.id && r.claimed_by === user.id && OPEN_STATUSES.includes(r.status)).length,
    approved: rows.filter((r) => r.status === 'approved').length,
    closed: rows.filter((r) => r.status === 'declined' || r.status === 'rent_requested').length,
    all: rows.length,
  }), [rows, user?.id]);

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
      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <Button
            key={f.key}
            size="sm"
            variant={filter === f.key ? 'default' : 'outline'}
            className="h-7 px-2.5 text-[11px]"
            onClick={() => setFilter(f.key)}
          >
            {f.label}
            {counts[f.key] ? ` (${counts[f.key]})` : ''}
          </Button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center">Nothing here right now.</p>
      ) : filtered.map((r) => (
        <Card key={r.id}>
          <CardContent className="p-3 space-y-2.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-bold text-sm leading-tight break-words">{r.tenant_name || 'Tenant'}</p>
                <p className="text-[11px] text-muted-foreground break-words">
                  {[r.village_name, r.district_name].filter(Boolean).join(', ') || r.location_name || 'Location not shared'}
                  {r.distance_km != null ? ` · ${r.distance_km.toFixed(1)} km from centre` : ''}
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  Waiting {formatDistanceToNow(new Date(r.created_at))}
                </p>
              </div>
              <Badge variant={r.status === 'declined' ? 'destructive' : 'secondary'} className="text-[10px] shrink-0">
                {STATUS_LABEL[r.status] ?? r.status}
              </Badge>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {r.latitude != null && r.longitude != null ? (
                <Badge variant="outline" className="text-[10px] gap-1 border-success/40 text-success">
                  <MapPin className="h-3 w-3" />House location shared
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[10px] gap-1 text-muted-foreground">
                  <MapPinOff className="h-3 w-3" />No GPS — call first
                </Badge>
              )}
              {r.claimed_by && r.claimed_by === user?.id && (
                <Badge variant="outline" className="text-[10px]">Claimed by you</Badge>
              )}
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
                <>
                  <Button asChild size="sm" variant="outline" className="text-[11px]">
                    <a href={`tel:${r.tenant_phone}`}><Phone className="mr-1.5 h-3.5 w-3.5" />Tenant</a>
                  </Button>
                  <Button asChild size="sm" variant="outline" className="text-[11px]">
                    <a href={waHref(r.tenant_phone)} target="_blank" rel="noreferrer" aria-label="WhatsApp tenant">
                      <MessageCircle className="h-3.5 w-3.5" />
                    </a>
                  </Button>
                </>
              )}
              <Button asChild size="sm" variant="outline" className="text-[11px]">
                <a href={`tel:${r.landlord_phone}`}><Phone className="mr-1.5 h-3.5 w-3.5" />Landlord</a>
              </Button>
              <Button asChild size="sm" variant="outline" className="text-[11px]">
                <a href={waHref(r.landlord_phone)} target="_blank" rel="noreferrer" aria-label="WhatsApp landlord">
                  <MessageCircle className="h-3.5 w-3.5" />
                </a>
              </Button>

              {r.status === 'submitted' && (
                <Button size="sm" className="text-[11px]" disabled={busyId === r.id} onClick={() => act(r.id, 'claim')}>
                  <UserCheck className="mr-1.5 h-3.5 w-3.5" />Claim
                </Button>
              )}
              {r.status === 'claimed' && (
                <Button size="sm" variant="secondary" className="text-[11px]" disabled={busyId === r.id} onClick={() => act(r.id, 'verify_visit')}>
                  <MapPin className="mr-1.5 h-3.5 w-3.5" />Verify house at site
                </Button>
              )}
              {(r.status === 'claimed' || r.status === 'visit_verified') && (
                <Button size="sm" className="text-[11px]" disabled={busyId === r.id} onClick={() => act(r.id, 'approve')}>
                  <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />Approve
                </Button>
              )}
              {r.status === 'approved' && (
                <Button size="sm" className="text-[11px]" onClick={() => setRaiseFor(r)}>
                  <FileText className="mr-1.5 h-3.5 w-3.5" />Raise rent request
                </Button>
              )}
              {!['declined', 'rent_requested'].includes(r.status) && (
                <Button size="sm" variant="ghost" className="text-[11px] text-destructive" onClick={() => { setDeclineFor(r.id); setReason(''); }}>
                  <XCircle className="mr-1.5 h-3.5 w-3.5" />Decline
                </Button>
              )}
            </div>

            {r.status === 'submitted' && (
              <p className="text-[11px] text-muted-foreground">Claim this request first, then verify the house at the site.</p>
            )}
            {r.status === 'approved' && (
              <p className="text-[11px] text-muted-foreground">
                Approved — raise the rent request here and the tenant's tracker updates automatically.
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

      {raiseFor && (
        <AgentRentRequestDialog
          open={!!raiseFor}
          onOpenChange={(o) => { if (!o) setRaiseFor(null); }}
          prefillTenantName={raiseFor.tenant_name ?? undefined}
          prefillTenantPhone={raiseFor.tenant_phone ?? undefined}
          prefillRentAmount={String(Math.round(Number(raiseFor.rent_amount)))}
          onSuccess={() => {
            const intake = raiseFor;
            setRaiseFor(null);
            if (intake) void linkRaisedRequest(intake);
          }}
        />
      )}
    </div>
  );
}

export default TenantRentIntakeQueue;
