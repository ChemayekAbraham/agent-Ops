import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, Search, MapPin, Sparkles, UserCheck } from 'lucide-react';
import { toast } from 'sonner';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** business_advances row */
  advance: any;
  /** Optional rent history row to pin to the verification (the landlord+property being checked) */
  rentHistoryRow?: any;
  onAssigned?: () => void;
}

/**
 * Agent Ops assigns a nearby field agent to physically verify the landlord
 * and property linked to a Business Advance.
 *
 * Auto-suggests the 5 closest agents by Haversine distance from the
 * property GPS (uses each agent's last check-in location), with a
 * manual search fallback by name/phone.
 */
export function AssignNearbyAgentDialog({
  open,
  onOpenChange,
  advance,
  rentHistoryRow,
  onAssigned,
}: Props) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [selectedAgent, setSelectedAgent] = useState<any>(null);

  // Use rent history property GPS if available, else the business GPS
  const lat = Number(advance?.business_latitude) || null;
  const lng = Number(advance?.business_longitude) || null;
  const landlordName = rentHistoryRow?.landlord_name || advance?.business_name;
  const landlordPhone = rentHistoryRow?.landlord_phone || '';
  const propertyLocation = rentHistoryRow?.property_location || advance?.business_address;

  useEffect(() => {
    if (!open) {
      setSearch('');
      setSelectedAgent(null);
    }
  }, [open]);

  // Auto-suggest nearest agents
  const { data: nearby = [], isLoading: loadingNearby } = useQuery({
    queryKey: ['suggest-nearby-agents', lat, lng, open],
    enabled: open && lat !== null && lng !== null,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('suggest_nearby_agents', {
        _lat: lat as number,
        _lng: lng as number,
        _limit: 5,
      });
      if (error) throw error;
      return data || [];
    },
  });

  // Manual search fallback (by name or phone)
  const { data: searchResults = [], isLoading: loadingSearch } = useQuery({
    queryKey: ['search-agents', search],
    enabled: open && search.trim().length >= 2,
    queryFn: async () => {
      const term = `%${search.trim()}%`;
      // Two-step: get agent ids, then fetch matching profiles
      const { data: agentRoles } = await supabase
        .from('user_roles')
        .select('user_id')
        .eq('role', 'agent');
      const agentIds = (agentRoles || []).map((r: any) => r.user_id);
      if (agentIds.length === 0) return [];
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, phone')
        .in('id', agentIds)
        .or(`full_name.ilike.${term},phone.ilike.${term}`)
        .limit(10);
      if (error) throw error;
      return (data || []).map((p: any) => ({
        agent_id: p.id,
        full_name: p.full_name,
        phone: p.phone,
        distance_km: null as number | null,
      }));
    },
  });

  const list = search.trim().length >= 2 ? searchResults : nearby;

  const assignMutation = useMutation({
    mutationFn: async () => {
      if (!user?.id) throw new Error('Not signed in');
      if (!selectedAgent) throw new Error('Pick an agent first');
      if (!advance?.id) throw new Error('Missing advance');

      const { error } = await supabase.from('landlord_physical_verifications').insert({
        business_advance_id: advance.id,
        rent_history_record_id: rentHistoryRow?.id || null,
        landlord_name: landlordName,
        landlord_phone: landlordPhone,
        property_location: propertyLocation,
        property_latitude: lat,
        property_longitude: lng,
        assigned_agent_id: selectedAgent.agent_id,
        assigned_by: user.id,
        distance_km: selectedAgent.distance_km ?? null,
        status: 'assigned',
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(`Dispatched ${selectedAgent.full_name} to verify ${landlordName}`);
      qc.invalidateQueries({ queryKey: ['landlord-physical-verifications'] });
      onAssigned?.();
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserCheck className="h-5 w-5 text-primary" /> Dispatch field agent
          </DialogTitle>
          <DialogDescription>
            Send a nearby agent to physically confirm <strong>{landlordName}</strong> and the property.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-xl bg-muted/40 p-3 text-xs space-y-1">
          <div className="flex items-center gap-1.5 font-bold">
            <MapPin className="h-3.5 w-3.5 text-primary" /> Property to verify
          </div>
          <p>{propertyLocation || '—'}</p>
          {lat && lng ? (
            <a
              href={`https://maps.google.com/?q=${lat},${lng}`}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline"
            >
              Open in Maps ({lat.toFixed(4)}, {lng.toFixed(4)})
            </a>
          ) : (
            <p className="text-amber-600">⚠ No GPS on this advance — use search below.</p>
          )}
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search any agent by name or phone..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        {!search && (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Sparkles className="h-3 w-3 text-primary" />
            Auto-suggested by closest known location
          </div>
        )}

        <div className="space-y-2 max-h-72 overflow-y-auto">
          {(loadingNearby || loadingSearch) && (
            <div className="flex justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {!loadingNearby && !loadingSearch && list.length === 0 && (
            <p className="text-center text-xs text-muted-foreground py-6">
              {search ? 'No agents matched.' : 'No nearby agents found — try searching by name.'}
            </p>
          )}
          {list.map((a: any) => {
            const isSelected = selectedAgent?.agent_id === a.agent_id;
            return (
              <button
                key={a.agent_id}
                onClick={() => setSelectedAgent(a)}
                className={`w-full text-left p-3 rounded-xl border transition ${
                  isSelected
                    ? 'border-primary bg-primary/10'
                    : 'border-border hover:border-primary/40 hover:bg-muted/40'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold truncate">{a.full_name || 'Agent'}</p>
                    <p className="text-[11px] text-muted-foreground truncate">{a.phone || ''}</p>
                  </div>
                  {a.distance_km !== null && a.distance_km !== undefined && (
                    <Badge variant="secondary" className="shrink-0 text-[10px]">
                      {a.distance_km < 1 ? `${Math.round(a.distance_km * 1000)} m` : `${a.distance_km} km`}
                    </Badge>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        <Button
          onClick={() => assignMutation.mutate()}
          disabled={!selectedAgent || assignMutation.isPending}
          className="w-full"
        >
          {assignMutation.isPending ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Dispatching…
            </>
          ) : (
            <>
              <UserCheck className="h-4 w-4 mr-2" />
              {selectedAgent ? `Dispatch ${selectedAgent.full_name}` : 'Pick an agent'}
            </>
          )}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
