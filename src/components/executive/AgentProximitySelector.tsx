import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { MapPin, User, CheckCircle2, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface AgentProximitySelectorProps {
  latitude: number | null;
  longitude: number | null;
  currentAgentId: string | null;
  selectedAgentId: string | null;
  onSelect: (agentId: string) => void;
}

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function AgentProximitySelector({
  latitude,
  longitude,
  currentAgentId,
  selectedAgentId,
  onSelect,
}: AgentProximitySelectorProps) {
  const { data: agents, isLoading } = useQuery({
    queryKey: ['nearby-agents', latitude, longitude],
    queryFn: async () => {
      // Get agents who have recent visits with GPS
      const { data: visits } = await supabase
        .from('agent_visits')
        .select('agent_id, latitude, longitude, checked_in_at')
        .order('checked_in_at', { ascending: false })
        .limit(500);

      if (!visits) return [];

      // Group by agent, take most recent location
      const agentLocations = new Map<string, { lat: number; lon: number }>();
      for (const v of visits) {
        if (!agentLocations.has(v.agent_id)) {
          agentLocations.set(v.agent_id, { lat: v.latitude, lon: v.longitude });
        }
      }

      // Calculate distances
      const agentDistances: { id: string; distance: number }[] = [];
      for (const [agentId, loc] of agentLocations) {
        if (latitude && longitude) {
          const dist = haversineDistance(latitude, longitude, loc.lat, loc.lon);
          agentDistances.push({ id: agentId, distance: dist });
        } else {
          agentDistances.push({ id: agentId, distance: 999 });
        }
      }

      agentDistances.sort((a, b) => a.distance - b.distance);
      const top10 = agentDistances.slice(0, 10);

      if (top10.length === 0) return [];

      // Get agent names
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, phone')
        .in('id', top10.map(a => a.id));

      const profileMap = new Map((profiles || []).map(p => [p.id, p]));

      return top10.map(a => ({
        id: a.id,
        name: profileMap.get(a.id)?.full_name || 'Unknown',
        phone: profileMap.get(a.id)?.phone || '',
        distance: a.distance,
        isCurrent: a.id === currentAgentId,
      }));
    },
    staleTime: 300000,
  });

  if (isLoading) {
    return (
      <div className="rounded-xl border border-border p-3 bg-muted/30">
        <h4 className="text-sm font-semibold mb-2">📍 Assign Nearby Agent</h4>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading nearby agents...
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border p-3 bg-muted/30">
      <h4 className="text-sm font-semibold mb-2">📍 Assign Nearby Agent</h4>
      {!latitude || !longitude ? (
        <p className="text-xs text-muted-foreground">No location data — showing all active agents</p>
      ) : null}
      <div className="space-y-1.5 max-h-48 overflow-y-auto">
        {(agents || []).length === 0 ? (
          <p className="text-xs text-muted-foreground py-2">No agents found with GPS data</p>
        ) : (
          (agents || []).map(agent => (
            <button
              key={agent.id}
              onClick={() => onSelect(agent.id)}
              className={cn(
                'w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors text-sm',
                selectedAgentId === agent.id
                  ? 'bg-primary/15 border border-primary/40 ring-1 ring-primary/20'
                  : 'bg-card border border-border hover:bg-muted/50'
              )}
            >
              <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">
                  {agent.name}
                  {agent.isCurrent && (
                    <span className="text-[10px] text-muted-foreground ml-1">(original)</span>
                  )}
                </p>
                <p className="text-[10px] text-muted-foreground">{agent.phone}</p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {latitude && longitude && agent.distance < 999 && (
                  <Badge variant="outline" className="text-[10px] px-1.5">
                    <MapPin className="h-2.5 w-2.5 mr-0.5" />
                    {agent.distance < 1 ? `${Math.round(agent.distance * 1000)}m` : `${agent.distance.toFixed(1)}km`}
                  </Badge>
                )}
                {selectedAgentId === agent.id && (
                  <CheckCircle2 className="h-4 w-4 text-primary" />
                )}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
