import { useState, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Loader2, UserPlus, Home, Check, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
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
  const [agentOpen, setAgentOpen] = useState(false);
  const [listingId, setListingId] = useState<string>('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setAgentId(currentAgentId || '');
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

  // Load all agents (single-role, enabled)
  const { data: agents = [], isLoading: agentsLoading } = useQuery({
    queryKey: ['tenant-assign-agents'],
    enabled: open,
    queryFn: async () => {
      // Security-definer RPC — works for operators / agents / funders
      // who otherwise cannot SELECT public.user_roles directly.
      const { data, error } = await supabase.rpc('list_assignable_agents');
      if (error) throw error;
      return ((data || []) as Array<{ id: string; full_name: string | null; phone: string | null }>)
        .filter(p => p.full_name || p.phone)
        .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));
    },
  });

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

  const selectedListing = useMemo(
    () => listings.find(l => l.id === listingId),
    [listings, listingId]
  );

  const handleSave = async () => {
    if (!rentRequestId) return;
    if (!agentId && !listingId) {
      toast.error('Pick an agent or a property to link');
      return;
    }
    setSaving(true);
    try {
      // 1) Assign agent on the rent_request
      if (agentId && agentId !== currentAgentId) {
        const { error } = await supabase
          .from('rent_requests')
          .update({ agent_id: agentId, assigned_agent_id: agentId })
          .eq('id', rentRequestId);
        if (error) throw error;
      }

      // 2) Link property to the chosen agent + tenant
      if (listingId) {
        const updates: Record<string, any> = {};
        if (agentId) updates.agent_id = agentId;
        if (tenantId && !selectedListing?.tenant_id) updates.tenant_id = tenantId;
        if (Object.keys(updates).length > 0) {
          const { error } = await supabase
            .from('house_listings')
            .update(updates)
            .eq('id', listingId);
          if (error) throw error;
        }
      }

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
          <div className="space-y-1.5">
            <Label className="text-xs flex items-center gap-1.5">
              <UserPlus className="h-3.5 w-3.5" /> Assigned Agent
            </Label>
            <Popover open={agentOpen} onOpenChange={setAgentOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={agentOpen}
                  className="w-full justify-between px-3 font-normal h-10"
                  type="button"
                >
                  {agentId ? (
                    (() => {
                      const a = agents.find((x) => x.id === agentId);
                      return a ? (
                        <span className="truncate text-left">
                          {a.full_name || 'Unnamed'}
                          {a.phone ? <span className="text-muted-foreground ml-1.5">· {a.phone}</span> : null}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">Select an agent</span>
                      );
                    })()
                  ) : (
                    <span className="text-muted-foreground">Select an agent</span>
                  )}
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="p-0 w-[var(--radix-popover-trigger-width)]" align="start">
                <Command>
                  <CommandInput placeholder="Search agent by name or phone…" />
                  <CommandList className="max-h-64">
                    <CommandEmpty>No agent found.</CommandEmpty>
                    <CommandGroup>
                      {agents.map((a) => {
                        const label = `${a.full_name || 'Unnamed'}${a.phone ? ` · ${a.phone}` : ''}`;
                        return (
                          <CommandItem
                            key={a.id}
                            value={`${a.id}:${label}`}
                            onSelect={() => {
                              setAgentId(a.id);
                              setAgentOpen(false);
                            }}
                          >
                            <Check className={cn('mr-2 h-4 w-4 shrink-0', agentId === a.id ? 'opacity-100' : 'opacity-0')} />
                            <span className="truncate">{label}</span>
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
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