import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import {
  Home, MapPin, Users, Calendar, Search, UserCheck,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { ViewingSchedulerDialog } from './ViewingSchedulerDialog';

interface TenantSeeking {
  id: string;
  full_name: string;
  phone: string;
  city: string | null;
  rent_request?: {
    id: string;
    rent_amount: number;
    status: string;
  } | null;
}

interface EmptyHouse {
  id: string;
  title: string;
  address: string;
  region: string;
  monthly_rent: number;
  daily_rate: number;
  number_of_rooms: number;
  house_category: string;
  agent_id: string;
  latitude: number | null;
  longitude: number | null;
  landlord_id: string | null;
}

interface NearbyAgent {
  id: string;
  full_name: string;
  phone: string;
  city: string | null;
  active_viewings: number;
}

export function TenantMatchingQueue({ onViewingCreated }: { onViewingCreated?: () => void }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [search, setSearch] = useState('');
  const [selectedTenant, setSelectedTenant] = useState<TenantSeeking | null>(null);
  const [selectedHouse, setSelectedHouse] = useState<EmptyHouse | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<NearbyAgent | null>(null);
  const [schedulerOpen, setSchedulerOpen] = useState(false);

  // Fetch tenants with pending/approved rent requests (seeking housing)
  const { data: tenants, isLoading: loadingTenants } = useQuery({
    queryKey: ['matching-tenants'],
    queryFn: async () => {
      const { data: requests } = await supabase
        .from('rent_requests')
        .select('id, rent_amount, status, tenant_id')
        .in('status', ['pending', 'approved'])
        .order('created_at', { ascending: false })
        .limit(100);

      if (!requests?.length) return [];

      const tenantIds = [...new Set(requests.map(r => r.tenant_id))];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, phone, city')
        .in('id', tenantIds);

      const profileMap = new Map((profiles || []).map(p => [p.id, p]));

      return requests.map(r => ({
        ...profileMap.get(r.tenant_id),
        id: r.tenant_id,
        rent_request: { id: r.id, rent_amount: r.rent_amount, status: r.status },
      })).filter(t => t.full_name) as TenantSeeking[];
    },
    staleTime: 60000,
  });

  // Fetch empty houses
  const { data: emptyHouses, isLoading: loadingHouses } = useQuery({
    queryKey: ['matching-empty-houses'],
    queryFn: async () => {
      const { data } = await supabase
        .from('house_listings')
        .select('id, title, address, region, monthly_rent, daily_rate, number_of_rooms, house_category, agent_id, latitude, longitude, landlord_id')
        .eq('status', 'available')
        .is('tenant_id', null)
        .eq('verified', true)
        .order('created_at', { ascending: false })
        .limit(200);
      return (data || []) as EmptyHouse[];
    },
    staleTime: 60000,
  });

  // Fetch agents with their workload
  const { data: agents } = useQuery({
    queryKey: ['matching-agents'],
    queryFn: async () => {
      const { data: agentRoles } = await supabase
        .from('user_roles')
        .select('user_id')
        .eq('role', 'agent')
        .limit(200);

      if (!agentRoles?.length) return [];

      const agentIds = agentRoles.map(r => r.user_id);
      const [profilesRes, viewingsRes] = await Promise.all([
        supabase.from('profiles').select('id, full_name, phone, city').in('id', agentIds),
        supabase.from('property_viewings').select('agent_id').in('agent_id', agentIds).in('status', ['matched', 'scheduled']),
      ]);

      const workloadMap = new Map<string, number>();
      (viewingsRes.data || []).forEach(v => {
        workloadMap.set(v.agent_id, (workloadMap.get(v.agent_id) || 0) + 1);
      });

      return (profilesRes.data || []).map(p => ({
        ...p,
        active_viewings: workloadMap.get(p.id) || 0,
      })) as NearbyAgent[];
    },
    staleTime: 60000,
  });

  // Auto-suggest houses matching tenant's rent budget (±30%)
  const suggestedHouses = selectedTenant?.rent_request
    ? (emptyHouses || []).filter(h => {
        const budget = selectedTenant.rent_request!.rent_amount;
        return h.monthly_rent >= budget * 0.7 && h.monthly_rent <= budget * 1.3;
      })
    : (emptyHouses || []);

  // Suggest agents near the selected house (by region match for now, GPS proximity later)
  const suggestedAgents = selectedHouse
    ? (agents || []).sort((a, b) => a.active_viewings - b.active_viewings)
    : (agents || []);

  const filteredTenants = (tenants || []).filter(t =>
    !search || t.full_name?.toLowerCase().includes(search.toLowerCase()) || t.phone?.includes(search)
  );

  const handleCreateViewing = () => {
    if (!selectedTenant || !selectedHouse || !selectedAgent) {
      toast({ title: 'Select all three', description: 'Pick a tenant, house, and agent first.', variant: 'destructive' });
      return;
    }
    setSchedulerOpen(true);
  };

  const isLoading = loadingTenants || loadingHouses;

  return (
    <div className="space-y-4">
      {/* Selection Summary */}
      <div className="rounded-2xl border-2 border-primary/20 bg-primary/5 p-3">
        <p className="text-xs font-bold text-primary mb-2">🔗 Match & Schedule a Viewing</p>
        <div className="grid grid-cols-3 gap-2">
          <div className={`rounded-xl border p-2 text-center text-xs ${selectedTenant ? 'border-green-500 bg-green-50 dark:bg-green-950/30' : 'border-dashed border-muted-foreground/40'}`}>
            <Users className="h-4 w-4 mx-auto mb-1 text-muted-foreground" />
            {selectedTenant ? (
              <p className="font-semibold truncate">{selectedTenant.full_name}</p>
            ) : (
              <p className="text-muted-foreground">1. Pick Tenant</p>
            )}
          </div>
          <div className={`rounded-xl border p-2 text-center text-xs ${selectedHouse ? 'border-green-500 bg-green-50 dark:bg-green-950/30' : 'border-dashed border-muted-foreground/40'}`}>
            <Home className="h-4 w-4 mx-auto mb-1 text-muted-foreground" />
            {selectedHouse ? (
              <p className="font-semibold truncate">{selectedHouse.title}</p>
            ) : (
              <p className="text-muted-foreground">2. Pick House</p>
            )}
          </div>
          <div className={`rounded-xl border p-2 text-center text-xs ${selectedAgent ? 'border-green-500 bg-green-50 dark:bg-green-950/30' : 'border-dashed border-muted-foreground/40'}`}>
            <UserCheck className="h-4 w-4 mx-auto mb-1 text-muted-foreground" />
            {selectedAgent ? (
              <p className="font-semibold truncate">{selectedAgent.full_name}</p>
            ) : (
              <p className="text-muted-foreground">3. Assign Agent</p>
            )}
          </div>
        </div>
        {selectedTenant && selectedHouse && selectedAgent && (
          <Button onClick={handleCreateViewing} className="w-full mt-3 gap-2">
            <Calendar className="h-4 w-4" /> Schedule Viewing Appointment
          </Button>
        )}
      </div>

      {/* Step 1: Tenants Seeking Housing */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <h3 className="text-sm font-bold">Step 1: Tenants Seeking Housing</h3>
          <Badge variant="outline" className="text-[10px]">{(tenants || []).length}</Badge>
        </div>
        <div className="relative mb-2">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input placeholder="Search tenant by name or phone..." value={search} onChange={e => setSearch(e.target.value)} className="pl-8 h-8 text-xs" />
        </div>
        {isLoading ? (
          <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}</div>
        ) : (
          <div className="grid gap-2 max-h-[200px] overflow-y-auto pr-1">
            {filteredTenants.slice(0, 20).map(tenant => (
              <button
                key={tenant.id}
                onClick={() => setSelectedTenant(tenant)}
                className={`w-full text-left rounded-xl border p-2.5 transition-all hover:border-primary/50 ${selectedTenant?.id === tenant.id ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-border'}`}
              >
                <div className="flex justify-between items-center">
                  <div>
                    <p className="font-semibold text-xs">{tenant.full_name}</p>
                    <p className="text-[10px] text-muted-foreground">{tenant.phone} · {tenant.city || 'N/A'}</p>
                  </div>
                  <Badge className="bg-primary/10 text-primary border-0 text-[10px]">
                    UGX {tenant.rent_request?.rent_amount?.toLocaleString()}/mo
                  </Badge>
                </div>
              </button>
            ))}
            {filteredTenants.length === 0 && <p className="text-xs text-muted-foreground text-center py-4">No tenants seeking housing</p>}
          </div>
        )}
      </div>

      {/* Step 2: Suggested Houses */}
      {selectedTenant && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <h3 className="text-sm font-bold">Step 2: Suggested Houses</h3>
            <Badge variant="outline" className="text-[10px]">{suggestedHouses.length} matches</Badge>
            {selectedTenant.rent_request && (
              <span className="text-[10px] text-muted-foreground">Budget: UGX {selectedTenant.rent_request.rent_amount.toLocaleString()} ±30%</span>
            )}
          </div>
          <div className="grid gap-2 max-h-[200px] overflow-y-auto pr-1">
            {suggestedHouses.slice(0, 20).map(house => (
              <button
                key={house.id}
                onClick={() => {
                  setSelectedHouse(house);
                  // Auto-select the listing agent
                  const listingAgent = (agents || []).find(a => a.id === house.agent_id);
                  if (listingAgent) setSelectedAgent(listingAgent);
                }}
                className={`w-full text-left rounded-xl border p-2.5 transition-all hover:border-primary/50 ${selectedHouse?.id === house.id ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-border'}`}
              >
                <div className="flex justify-between items-start">
                  <div>
                    <p className="font-semibold text-xs">{house.title}</p>
                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <MapPin className="h-2.5 w-2.5" /> {house.address}, {house.region}
                    </div>
                    <div className="flex gap-1.5 mt-0.5">
                      <Badge variant="outline" className="text-[9px] h-4 px-1">{house.house_category}</Badge>
                      <Badge variant="outline" className="text-[9px] h-4 px-1">{house.number_of_rooms} rooms</Badge>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-bold text-xs">UGX {house.monthly_rent.toLocaleString()}</p>
                    <p className="text-[10px] text-primary">{house.daily_rate.toLocaleString()}/day</p>
                  </div>
                </div>
              </button>
            ))}
            {suggestedHouses.length === 0 && <p className="text-xs text-muted-foreground text-center py-4">No houses match this budget</p>}
          </div>
        </div>
      )}

      {/* Step 3: Assign Agent */}
      {selectedHouse && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <h3 className="text-sm font-bold">Step 3: Assign Agent</h3>
            <span className="text-[10px] text-muted-foreground">Sorted by lowest workload</span>
          </div>
          <div className="grid gap-2 max-h-[160px] overflow-y-auto pr-1">
            {suggestedAgents.slice(0, 10).map(agent => (
              <button
                key={agent.id}
                onClick={() => setSelectedAgent(agent)}
                className={`w-full text-left rounded-xl border p-2.5 transition-all hover:border-primary/50 ${selectedAgent?.id === agent.id ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-border'}`}
              >
                <div className="flex justify-between items-center">
                  <div>
                    <p className="font-semibold text-xs">{agent.full_name}</p>
                    <p className="text-[10px] text-muted-foreground">{agent.phone} · {agent.city || 'N/A'}</p>
                  </div>
                  <div className="flex gap-1.5">
                    <Badge className={`border-0 text-[10px] ${agent.active_viewings === 0 ? 'bg-green-500/20 text-green-700' : agent.active_viewings <= 3 ? 'bg-amber-500/20 text-amber-700' : 'bg-red-500/20 text-red-700'}`}>
                      {agent.active_viewings} active
                    </Badge>
                    {agent.id === selectedHouse?.agent_id && (
                      <Badge className="bg-blue-500/20 text-blue-700 border-0 text-[10px]">Listing Agent</Badge>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Viewing Scheduler Dialog */}
      {selectedTenant && selectedHouse && selectedAgent && (
        <ViewingSchedulerDialog
          open={schedulerOpen}
          onOpenChange={setSchedulerOpen}
          tenant={selectedTenant}
          house={selectedHouse}
          agent={selectedAgent}
          onSuccess={() => {
            setSelectedTenant(null);
            setSelectedHouse(null);
            setSelectedAgent(null);
            onViewingCreated?.();
          }}
        />
      )}
    </div>
  );
}
