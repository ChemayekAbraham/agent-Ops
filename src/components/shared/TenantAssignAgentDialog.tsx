import { useState, useEffect, useMemo, useRef, useDeferredValue } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, UserPlus, Home, Search, X, User } from 'lucide-react';
import { toast } from 'sonner';


interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  rentRequestId: string | null;
  tenantId: string | null;
  tenantName: string;
  currentAgentId: string | null;
  onSaved?: () => void;
}

export default function TenantAssignAgentDialog({
  open, onOpenChange, rentRequestId, tenantId, tenantName, currentAgentId, onSaved,
}: Props) {
  const qc = useQueryClient();
  const [agentId, setAgentId] = useState<string>(currentAgentId || '');
  // Remember the picked person so the selection stays visible even after the
  // search list reloads (the list is re-fetched per search term).
  const [selectedAgent, setSelectedAgent] = useState<{ id: string; full_name: string | null; phone: string | null } | null>(null);
  const [agentQuery, setAgentQuery] = useState('');
  const deferredAgentQuery = useDeferredValue(agentQuery.trim());
  const [agentDropdownOpen, setAgentDropdownOpen] = useState(false);
  const agentPickerRef = useRef<HTMLDivElement>(null);
  const [listingId, setListingId] = useState<string>('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setAgentId(currentAgentId || '');
    setSelectedAgent(null);
    setAgentQuery('');
    setAgentDropdownOpen(false);
    setListingId('');
  }, [currentAgentId, rentRequestId, open]);


  // Load the rent_request landlord (used to scope listings)
  const { data: rentReq } = useQuery({
    queryKey: ['tenant-assign-rentreq', rentRequestId],
    enabled: !!rentRequestId && open,
    queryFn: async () => {
      const { data } = await supabase
        .from('rent_requests')
        .select('id, landlord_id, agent_id, assigned_agent_id')
        .eq('id', rentRequestId!)
        .maybeSingle();
      return data;
    },
  });

  // Search real registered agents AND sub-agents. `list_assignable_agents`
  // already scopes server-side to profiles holding an agent / senior_agent /
  // sub_agent role, so no extra client-side narrowing is applied (the previous
  // "qualifying agents" filter silently hid sub-agents). The RPC also filters
  // by the search term so matches are not lost to the row cap.
  const { data: agents = [], isFetching: agentsFetching, isPending: agentsPending } = useQuery({
    queryKey: ['tenant-assign-agents', deferredAgentQuery],
    enabled: open,
    // Keep the previous page of results mounted while a new search resolves so
    // the input is never unmounted/disabled mid-typing (that stole focus after
    // every keystroke).
    placeholderData: (prev) => prev,
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc('list_assignable_agents', {
        p_search: deferredAgentQuery || null,
        p_limit: 200,
      });
      if (error) throw error;
      return ((data || []) as Array<{ id: string; full_name: string | null; phone: string | null }>)
        .filter(p => p.full_name || p.phone)
        .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));
    },
  });

  const agentsLoading = agentsPending;

  const filteredAgents = useMemo(() => {
    const q = agentQuery.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter(a =>
      (a.full_name || '').toLowerCase().includes(q) ||
      (a.phone || '').toLowerCase().includes(q)
    );
  }, [agents, agentQuery]);



  // Close the agent dropdown when clicking outside the picker.
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (agentPickerRef.current && !agentPickerRef.current.contains(e.target as Node)) {
        setAgentDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Load properties — prefer the rent_request landlord's listings; fall back to vacant listings
  const { data: listings = [] } = useQuery({
    queryKey: ['tenant-assign-listings', rentReq?.landlord_id],
    enabled: open,
    queryFn: async () => {
      let q = supabase
        .from('house_listings')
        .select('id, title, house_category, address, village, district, agent_id, tenant_id, landlord_id')
        .order('created_at', { ascending: false })
        .limit(200);
      if (rentReq?.landlord_id) q = q.eq('landlord_id', rentReq.landlord_id);
      else q = q.is('tenant_id', null);
      const { data } = await q;
      return (data || []) as any[];
    },
  });


  // Name/phone of the person currently assigned, so the picker shows a real
  // person (not "Selected agent") when the dialog opens.
  const { data: currentAgentProfile } = useQuery({
    queryKey: ['tenant-assign-current-agent', currentAgentId],
    enabled: open && !!currentAgentId,
    queryFn: async () => {
      const { data } = await supabase
        .from('profiles')
        .select('id, full_name, phone')
        .eq('id', currentAgentId!)
        .maybeSingle();
      return (data || null) as { id: string; full_name: string | null; phone: string | null } | null;
    },
  });

  const shownAgent = useMemo(() => {
    if (!agentId) return null;
    if (selectedAgent?.id === agentId) return selectedAgent;
    if (currentAgentProfile?.id === agentId) return currentAgentProfile;
    return agents.find((x) => x.id === agentId) || null;
  }, [agentId, selectedAgent, currentAgentProfile, agents]);

  const handleSave = async () => {
    if (!rentRequestId) return;
    if (!agentId && !listingId) {
      toast.error('Pick an agent or a property to link');
      return;
    }
    setSaving(true);
    try {
      // Ops staff cannot write to rent_requests directly (RLS), so the transfer
      // goes through the SECURITY DEFINER RPC, which also writes the history row.
      const { error } = await (supabase as any).rpc('ops_transfer_tenant_agent', {
        p_rent_request_id: rentRequestId,
        p_new_agent_id: agentId || null,
        p_listing_id: listingId || null,
        p_reason: null,
      });
      if (error) throw error;

      toast.success('Tenant assignment updated');
      qc.invalidateQueries({ queryKey: ['daily-collection-rent-requests'] });
      onSaved?.();
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e?.message || 'Failed to save assignment');
    } finally {
      setSaving(false);
    }
  };


  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Assign Agent &amp; Property — {tenantName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5" ref={agentPickerRef}>
            <Label className="text-xs flex items-center gap-1.5">
              <UserPlus className="h-3.5 w-3.5" /> Assigned Agent
            </Label>
            {agentId ? (
              <div className="flex items-center gap-2 p-2.5 rounded-md border border-primary/40 bg-primary/5">
                <User className="h-4 w-4 text-primary shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] uppercase tracking-wide font-semibold text-primary">
                    {agentId === currentAgentId ? 'Currently assigned' : 'Selected'}
                  </p>
                  <p className="text-sm font-medium truncate">{shownAgent?.full_name || 'Unnamed'}</p>
                  {shownAgent?.phone ? (
                    <p className="text-xs text-muted-foreground truncate">{shownAgent.phone}</p>
                  ) : null}
                </div>

                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => {
                    setAgentId('');
                    setSelectedAgent(null);
                    setAgentQuery('');
                    setAgentDropdownOpen(true);
                  }}
                >
                  Change
                </Button>
              </div>
            ) : (
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
                <Input
                  placeholder={agentsLoading ? 'Loading agents…' : 'Type agent or sub-agent name or phone…'}
                  value={agentQuery}
                  onChange={(e) => {
                    setAgentQuery(e.target.value);
                    setAgentDropdownOpen(true);
                  }}
                  onFocus={() => setAgentDropdownOpen(true)}
                  className="pl-9 pr-9"
                />
                {agentsFetching ? (
                  <Loader2 className="absolute right-2.5 top-2.5 h-4 w-4 animate-spin text-muted-foreground" />
                ) : agentQuery ? (
                  <button
                    type="button"
                    onClick={() => { setAgentQuery(''); setAgentDropdownOpen(true); }}
                    className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground"
                    aria-label="Clear search"
                  >
                    <X className="h-4 w-4" />
                  </button>
                ) : null}
                {agentDropdownOpen && (
                  <div className="absolute z-50 w-full mt-1 bg-popover border rounded-md shadow-lg max-h-60 overflow-y-auto">
                    {agentsLoading ? (
                      <div className="py-6 flex justify-center">
                        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                      </div>
                    ) : filteredAgents.length === 0 ? (
                      <div className="px-3 py-2.5 text-sm text-muted-foreground">
                        {agents.length === 0 ? 'No agents available.' : 'No agent matches your search.'}
                      </div>
                    ) : (
                      filteredAgents.map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent transition-colors"
                          onClick={() => {
                            setAgentId(a.id);
                            setSelectedAgent(a);
                            setAgentQuery('');
                            setAgentDropdownOpen(false);
                          }}
                        >
                          <User className="h-4 w-4 text-muted-foreground shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{a.full_name || 'Unnamed'}</p>
                            {a.phone ? <p className="text-xs text-muted-foreground truncate">{a.phone}</p> : null}
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}
            <p className="text-[10px] text-muted-foreground">Updates the rent plan's collecting agent.</p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs flex items-center gap-1.5">
              <Home className="h-3.5 w-3.5" /> Link Property to this Agent
            </Label>
            <Select value={listingId} onValueChange={setListingId}>
              <SelectTrigger>
                <SelectValue placeholder={listings.length ? 'Select a property (optional)' : 'No properties available'} />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {listings.map(l => (
                  <SelectItem key={l.id} value={l.id}>
                    {(l.title || l.house_category || 'Property')} — {l.village || l.district || l.address || '—'}
                    {l.tenant_id ? ' · occupied' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground">
              Links the chosen property to this agent{tenantId ? ' and to this tenant if it is vacant' : ''}.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || (!agentId && !listingId)}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}