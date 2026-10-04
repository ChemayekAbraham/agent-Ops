import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Loader2, MapPin, Navigation, Phone, Users, CheckCircle2, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SelectedCashAgent {
  cashout_agent_id: string;
  agent_name: string;
  phone: string | null;
  district: string | null;
  region: string | null;
  distance_km: number | null;
}

interface NearbyAgent extends SelectedCashAgent {
  agent_id: string;
  label: string | null;
  city: string | null;
  queue_count: number;
}

interface Props {
  selected: SelectedCashAgent | null;
  onSelect: (agent: SelectedCashAgent | null) => void;
}

function formatDistance(km: number | null): string | null {
  if (km == null || !Number.isFinite(km)) return null;
  if (km < 1) return `${Math.round(km * 1000)} m away`;
  return `${km.toFixed(km < 10 ? 1 : 0)} km away`;
}

export function CashAgentSelector({ selected, onSelect }: Props) {
  const { user } = useAuth();
  const [agents, setAgents] = useState<NearbyAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [usedLocation, setUsedLocation] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Remember the coordinates used for the last fetch so the background
  // auto-refresh can re-query the same location without re-locating.
  const lastCoordsRef = useRef<{ lat: number | null; lng: number | null }>({ lat: null, lng: null });

  const fetchAgents = useCallback(async (lat: number | null, lng: number | null, silent = false) => {
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    lastCoordsRef.current = { lat, lng };
    try {
      const { data, error: rpcError } = await (supabase.rpc as any)('get_nearby_cashout_agents', {
        _lat: lat,
        _lng: lng,
      });
      if (rpcError) throw rpcError;
      setAgents((data || []) as NearbyAgent[]);
      setUsedLocation(lat != null && lng != null);
      if (silent) setError(null);
    } catch (e: any) {
      // Silent refreshes keep the existing list rather than wiping it on a blip.
      if (!silent) {
        setError(e?.message || 'Could not load nearby agents');
        setAgents([]);
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  // Try device geolocation first, then fall back to the user's saved residence.
  const locateAndFetch = useCallback(async () => {
    setLocating(true);
    const fallbackToProfile = async () => {
      try {
        const { data } = await supabase
          .from('profiles')
          .select('residence_lat, residence_lng')
          .eq('id', user?.id ?? '')
          .maybeSingle();
        const lat = data?.residence_lat != null ? Number(data.residence_lat) : null;
        const lng = data?.residence_lng != null ? Number(data.residence_lng) : null;
        await fetchAgents(lat, lng);
      } catch {
        await fetchAgents(null, null);
      } finally {
        setLocating(false);
      }
    };

    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          await fetchAgents(pos.coords.latitude, pos.coords.longitude);
          setLocating(false);
        },
        () => { fallbackToProfile(); },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 },
      );
    } else {
      fallbackToProfile();
    }
  }, [fetchAgents, user?.id]);

  useEffect(() => {
    locateAndFetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep queue sizes fresh while the user is choosing: silently re-query the
  // last-used location every 15s. Pauses when the tab is hidden.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      const { lat, lng } = lastCoordsRef.current;
      fetchAgents(lat, lng, true);
    }, 15000);
    return () => window.clearInterval(id);
  }, [fetchAgents]);

  // On-demand refresh of queue sizes using the last-used location.
  const refreshQueues = useCallback(async () => {
    setRefreshing(true);
    const { lat, lng } = lastCoordsRef.current;
    await fetchAgents(lat, lng, true);
    setRefreshing(false);
  }, [fetchAgents]);

  if (loading || locating) {
    return (
      <div className="p-4 rounded-xl bg-success/5 border border-success/20 flex items-center gap-3">
        <Loader2 className="h-4 w-4 animate-spin text-success" />
        <p className="text-xs text-muted-foreground">
          {locating ? 'Finding cash agents near you…' : 'Loading agents…'}
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 rounded-xl bg-destructive/5 border border-destructive/20 space-y-2">
        <p className="text-xs text-destructive">{error}</p>
        <Button variant="outline" size="sm" className="h-8 gap-2" onClick={() => locateAndFetch()}>
          <RefreshCw className="h-3.5 w-3.5" /> Retry
        </Button>
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div className="p-4 rounded-xl bg-muted/30 border border-border text-center">
        <p className="text-xs text-muted-foreground">No cash agents are available right now. Try another payout method.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between">
        <p className="text-sm font-bold text-foreground flex items-center gap-1.5">
          <MapPin className="h-4 w-4 text-success" /> Choose a cash agent
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={refreshQueues}
            disabled={refreshing}
            className="text-[11px] text-primary font-medium flex items-center gap-1 hover:underline disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3 w-3', refreshing && 'animate-spin')} /> Refresh queues
          </button>
          <button
            type="button"
            onClick={() => locateAndFetch()}
            className="text-[11px] text-primary font-medium flex items-center gap-1 hover:underline"
          >
            <Navigation className="h-3 w-3" /> {usedLocation ? 'Re-locate' : 'Use my location'}
          </button>
        </div>
      </div>
      {!usedLocation && (
        <p className="text-[10px] text-muted-foreground -mt-1">
          Enable location to sort agents by who's closest to you.
        </p>
      )}
      <div className="space-y-2 max-h-64 overflow-y-auto pr-0.5">
        {agents.map((a) => {
          const isActive = selected?.cashout_agent_id === a.cashout_agent_id;
          const dist = formatDistance(a.distance_km);
          const place = [a.district, a.region].filter(Boolean).join(', ');
          return (
            <button
              key={a.cashout_agent_id}
              type="button"
              onClick={() =>
                onSelect(
                  isActive
                    ? null
                    : {
                        cashout_agent_id: a.cashout_agent_id,
                        agent_name: a.agent_name,
                        phone: a.phone,
                        district: a.district,
                        region: a.region,
                        distance_km: a.distance_km,
                      },
                )
              }
              className={cn(
                'w-full text-left p-3 rounded-xl border transition-all flex items-start gap-3 touch-manipulation',
                isActive
                  ? 'border-success bg-success/10 ring-2 ring-success/30'
                  : 'border-border bg-card hover:border-success/40 hover:bg-success/5',
              )}
            >
              <div className={cn(
                'mt-0.5 w-8 h-8 rounded-full flex items-center justify-center shrink-0',
                isActive ? 'bg-success text-white' : 'bg-muted text-muted-foreground',
              )}>
                {isActive ? <CheckCircle2 className="h-4 w-4" /> : <MapPin className="h-4 w-4" />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground truncate">{a.agent_name}</p>
                {place && <p className="text-[11px] text-muted-foreground truncate">{place}</p>}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1">
                  {dist && (
                    <span className="text-[10px] font-medium text-success flex items-center gap-1">
                      <Navigation className="h-2.5 w-2.5" /> {dist}
                    </span>
                  )}
                  {a.phone && (
                    <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                      <Phone className="h-2.5 w-2.5" /> {a.phone}
                    </span>
                  )}
                  <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                    <Users className="h-2.5 w-2.5" /> {a.queue_count} in queue
                  </span>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
