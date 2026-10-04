import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Search, Link2, UserPlus, Check, X, Home, SmartphoneNfc } from 'lucide-react';
import { toast } from 'sonner';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

interface ProfileResult {
  id: string;
  full_name: string;
  phone: string;
  territory?: string;
}

interface LandlordResult {
  id: string;
  name: string;
  phone: string;
  property_address?: string;
}

function PersonSearch({
  label: _label,
  role,
  selected,
  onSelect,
  onClear,
  badgeLabel,
  badgeColor,
  iconColor,
  bgColor,
  borderColor,
}: {
  label: string;
  role: 'agent' | 'tenant';
  selected: ProfileResult | null;
  onSelect: (p: ProfileResult) => void;
  onClear: () => void;
  badgeLabel: string;
  badgeColor: string;
  iconColor: string;
  bgColor: string;
  borderColor: string;
}) {
  const [search, setSearch] = useState('');

  const { data: results } = useQuery({
    queryKey: [`connector-${role}-search`, search],
    queryFn: async () => {
      if (search.length < 3) return [];
      const { data } = await supabase
        .from('profiles')
        .select('id, full_name, phone, territory')
        .or(`full_name.ilike.%${search}%,phone.ilike.%${search}%`)
        .limit(6);
      if (!data || data.length === 0) return [];
      const ids = data.map(p => p.id);
      const { data: roles } = await supabase
        .from('user_roles')
        .select('user_id')
        .in('user_id', ids)
        .eq('role', role)
        .eq('enabled', true);
      const roleIds = new Set((roles || []).map(r => r.user_id));
      return data.filter(p => roleIds.has(p.id)) as ProfileResult[];
    },
    enabled: search.length >= 3 && !selected,
    staleTime: 30000,
  });

  if (selected) {
    return (
      <div className={`flex items-center gap-2 p-2 rounded-xl ${bgColor} border ${borderColor}`}>
        <UserPlus className={`h-4 w-4 ${iconColor} shrink-0`} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate">{selected.full_name}</p>
          <p className="text-xs text-muted-foreground">{selected.phone || 'No phone'}</p>
        </div>
        <button onClick={onClear} className="p-1 rounded hover:bg-muted">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
      <Input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={`Search ${role} name or phone...`}
        className="pl-8 h-9 text-sm"
      />
      {results && results.length > 0 && (
        <div className="absolute z-10 top-full mt-1 left-0 right-0 bg-popover border border-border rounded-lg shadow-lg max-h-40 overflow-y-auto">
          {results.map(r => (
            <button
              key={r.id}
              onClick={() => { onSelect(r); setSearch(''); }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors flex items-center gap-2"
            >
              <Badge variant="outline" className={`text-[10px] shrink-0 ${badgeColor}`}>{badgeLabel}</Badge>
              <span className="truncate font-medium">{r.full_name}</span>
              <span className="text-xs text-muted-foreground ml-auto shrink-0">{r.phone || ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function LandlordSearch({
  selected,
  onSelect,
  onClear,
}: {
  selected: LandlordResult | null;
  onSelect: (l: LandlordResult) => void;
  onClear: () => void;
}) {
  const [search, setSearch] = useState('');

  const { data: results } = useQuery({
    queryKey: ['connector-landlord-search', search],
    queryFn: async () => {
      if (search.length < 3) return [];
      // Trigram-indexed RPC — the raw OR-ILIKE fallback used to burn the DB CPU.
      const { data } = await supabase.rpc('search_landlords_fuzzy', {
        p_query: search,
        p_limit: 6,
        p_threshold: 0.15,
      });
      return ((data || []) as any[]).map((d) => ({
        id: d.id,
        name: d.name,
        phone: d.phone,
        property_address: d.property_address,
      })) as LandlordResult[];
    },
    enabled: search.length >= 3 && !selected,
    staleTime: 30000,
  });

  if (selected) {
    return (
      <div className="flex items-center gap-2 p-2 rounded-xl bg-amber-500/10 border border-amber-500/20">
        <Home className="h-4 w-4 text-amber-600 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate">{selected.name}</p>
          <p className="text-xs text-muted-foreground">{selected.phone || 'No phone'}</p>
          {selected.property_address && (
            <p className="text-xs text-muted-foreground truncate">{selected.property_address}</p>
          )}
        </div>
        <button onClick={onClear} className="p-1 rounded hover:bg-muted">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
      <Input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search landlord name or phone..."
        className="pl-8 h-9 text-sm"
      />
      {results && results.length > 0 && (
        <div className="absolute z-10 top-full mt-1 left-0 right-0 bg-popover border border-border rounded-lg shadow-lg max-h-40 overflow-y-auto">
          {results.map(l => (
            <button
              key={l.id}
              onClick={() => { onSelect(l); setSearch(''); }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors flex items-center gap-2"
            >
              <Badge variant="outline" className="text-[10px] shrink-0 border-amber-500/30 text-amber-600">Landlord</Badge>
              <span className="truncate font-medium">{l.name}</span>
              <span className="text-xs text-muted-foreground ml-auto shrink-0">{l.phone || ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function AgentTenantConnector() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'tenant' | 'landlord'>('tenant');
  const [selectedAgent, setSelectedAgent] = useState<ProfileResult | null>(null);
  const [selectedTenant, setSelectedTenant] = useState<ProfileResult | null>(null);
  const [selectedLandlord, setSelectedLandlord] = useState<LandlordResult | null>(null);
  const [noSmartphone, setNoSmartphone] = useState(false);
  const [reason, setReason] = useState('');

  const connectTenantMutation = useMutation({
    mutationFn: async () => {
      if (!selectedAgent || !selectedTenant || reason.length < 10) {
        throw new Error('Select both agent and tenant, and provide a reason (10+ chars)');
      }
      const { error } = await supabase
        .from('profiles')
        .update({ referrer_id: selectedAgent.id })
        .eq('id', selectedTenant.id);
      if (error) throw error;

      await supabase.from('audit_logs').insert({
        action_type: 'connect_tenant_to_agent',
        user_id: user?.id || '',
        record_id: selectedTenant.id,
        table_name: 'profiles',
        metadata: {
          agent_id: selectedAgent.id,
          agent_name: selectedAgent.full_name,
          tenant_id: selectedTenant.id,
          tenant_name: selectedTenant.full_name,
          no_smartphone: noSmartphone,
          reason,
        },
      });
    },
    onSuccess: () => {
      toast.success(`${selectedTenant?.full_name} connected to ${selectedAgent?.full_name}`);
      reset();
      queryClient.invalidateQueries({ queryKey: ['connector-'] });
    },
    onError: (err: any) => toast.error(err.message || 'Failed to connect'),
  });

  const connectLandlordMutation = useMutation({
    mutationFn: async () => {
      if (!selectedAgent || !selectedLandlord || reason.length < 10) {
        throw new Error('Select both agent and landlord, and provide a reason (10+ chars)');
      }
      // Create agent-landlord assignment
      const { error } = await supabase
        .from('agent_landlord_assignments')
        .insert({
          agent_id: selectedAgent.id,
          landlord_id: selectedLandlord.id,
          status: 'active',
        });
      if (error) throw error;

      await supabase.from('audit_logs').insert({
        action_type: 'connect_landlord_to_agent',
        user_id: user?.id || '',
        record_id: selectedLandlord.id,
        table_name: 'agent_landlord_assignments',
        metadata: {
          agent_id: selectedAgent.id,
          agent_name: selectedAgent.full_name,
          landlord_id: selectedLandlord.id,
          landlord_name: selectedLandlord.name,
          no_smartphone: noSmartphone,
          reason,
        },
      });
    },
    onSuccess: () => {
      toast.success(`${selectedLandlord?.name} connected to ${selectedAgent?.full_name}`);
      reset();
      queryClient.invalidateQueries({ queryKey: ['connector-'] });
    },
    onError: (err: any) => toast.error(err.message || 'Failed to connect'),
  });

  const reset = () => {
    setSelectedAgent(null);
    setSelectedTenant(null);
    setSelectedLandlord(null);
    setNoSmartphone(false);
    setReason('');
  };

  const isPending = connectTenantMutation.isPending || connectLandlordMutation.isPending;
  const canConnect = tab === 'tenant'
    ? selectedAgent && selectedTenant && reason.length >= 10
    : selectedAgent && selectedLandlord && reason.length >= 10;

  return (
    <div className="rounded-2xl border border-border bg-card p-3 sm:p-4">
      <div className="flex items-center gap-2 mb-3">
        <Link2 className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">Connect to Agent</h3>
      </div>

      <Tabs value={tab} onValueChange={(v) => { setTab(v as any); reset(); }}>
        <TabsList className="w-full mb-3">
          <TabsTrigger value="tenant" className="flex-1 text-xs gap-1">
            <UserPlus className="h-3.5 w-3.5" /> Tenant
          </TabsTrigger>
          <TabsTrigger value="landlord" className="flex-1 text-xs gap-1">
            <Home className="h-3.5 w-3.5" /> Landlord
          </TabsTrigger>
        </TabsList>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* Agent search — always shown */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">1. Find Agent</label>
            <PersonSearch
              label="Agent"
              role="agent"
              selected={selectedAgent}
              onSelect={setSelectedAgent}
              onClear={() => setSelectedAgent(null)}
              badgeLabel="Agent"
              badgeColor=""
              iconColor="text-primary"
              bgColor="bg-primary/10"
              borderColor="border-primary/20"
            />
          </div>

          <TabsContent value="tenant" className="mt-0 space-y-2">
            <label className="text-xs font-medium text-muted-foreground">2. Find Tenant</label>
            <PersonSearch
              label="Tenant"
              role="tenant"
              selected={selectedTenant}
              onSelect={setSelectedTenant}
              onClear={() => setSelectedTenant(null)}
              badgeLabel="Tenant"
              badgeColor="border-green-500/30 text-green-600"
              iconColor="text-green-600"
              bgColor="bg-green-500/10"
              borderColor="border-green-500/20"
            />
          </TabsContent>

          <TabsContent value="landlord" className="mt-0 space-y-2">
            <label className="text-xs font-medium text-muted-foreground">2. Find Landlord</label>
            <LandlordSearch
              selected={selectedLandlord}
              onSelect={setSelectedLandlord}
              onClear={() => setSelectedLandlord(null)}
            />
          </TabsContent>
        </div>
      </Tabs>

      {/* No-smartphone toggle */}
      {(selectedAgent && (selectedTenant || selectedLandlord)) && (
        <div className="mt-3 space-y-2">
          <button
            onClick={() => setNoSmartphone(!noSmartphone)}
            className={`w-full p-2.5 rounded-xl border-2 transition-all text-left flex items-center gap-3 ${
              noSmartphone
                ? 'border-warning/50 bg-warning/10'
                : 'border-muted hover:border-muted-foreground/30'
            }`}
          >
            <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-colors ${
              noSmartphone ? 'bg-warning border-warning' : 'border-muted-foreground/40'
            }`}>
              {noSmartphone && <Check className="h-3.5 w-3.5 text-warning-foreground" />}
            </div>
            <SmartphoneNfc className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs font-medium">
                {tab === 'tenant' ? 'Tenant' : 'Landlord'} has no smartphone
              </p>
              <p className="text-[10px] text-muted-foreground">
                Agent will manage all interactions on their behalf
              </p>
            </div>
          </button>

          <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/50 text-xs">
            <Check className="h-3.5 w-3.5 text-green-500" />
            <span>
              Connecting <strong>{tab === 'tenant' ? selectedTenant?.full_name : selectedLandlord?.name}</strong> → <strong>{selectedAgent?.full_name}</strong>
              {noSmartphone && <Badge variant="outline" className="ml-1.5 text-[9px] px-1.5 py-0 border-warning/40 text-warning">📵 No smartphone</Badge>}
            </span>
          </div>

          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason for connection (min 10 characters)..."
            className="text-sm min-h-[60px]"
          />

          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => tab === 'tenant' ? connectTenantMutation.mutate() : connectLandlordMutation.mutate()}
              disabled={!canConnect || isPending}
              className="flex-1"
            >
              <Link2 className="h-3.5 w-3.5 mr-1.5" />
              {isPending ? 'Connecting...' : 'Connect'}
            </Button>
            <Button size="sm" variant="outline" onClick={reset}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
