import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import {
  Popover, PopoverContent, PopoverTrigger,
} from '@/components/ui/popover';
import { toast } from 'sonner';
import { Search, ChevronsUpDown, UserPlus, Loader2, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';

type Profile = {
  id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
};

export function TenantToSubAgentPanel() {
  const { user } = useAuth();
  const qc = useQueryClient();

  const [tenantQuery, setTenantQuery] = useState('');
  const [selectedTenant, setSelectedTenant] = useState<Profile | null>(null);
  const [parentOpen, setParentOpen] = useState(false);
  const [parentSearch, setParentSearch] = useState('');
  const [selectedParent, setSelectedParent] = useState<Profile | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // ─── Tenant search (by name / phone / email) ─────────────────────────────
  const { data: tenants, isFetching: tenantsLoading } = useQuery({
    queryKey: ['ttsa-tenant-search', tenantQuery],
    queryFn: async (): Promise<Profile[]> => {
      const q = tenantQuery.trim();
      if (q.length < 2) return [];

      const { data: tenantRoleRows } = await supabase
        .from('user_roles')
        .select('user_id')
        .eq('role', 'tenant')
        .limit(2000);
      const tenantIds = (tenantRoleRows || []).map(r => r.user_id);
      if (tenantIds.length === 0) return [];

      const like = `%${q}%`;
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, phone, email')
        .in('id', tenantIds)
        .or(`full_name.ilike.${like},phone.ilike.${like},email.ilike.${like}`)
        .limit(20);
      if (error) throw error;
      return data || [];
    },
    enabled: tenantQuery.trim().length >= 2,
    staleTime: 10_000,
  });

  // ─── Active agent search (parent dropdown) ───────────────────────────────
  const { data: agents, isFetching: agentsLoading } = useQuery({
    queryKey: ['ttsa-agent-search', parentSearch],
    queryFn: async (): Promise<Profile[]> => {
      const { data: agentRoleRows } = await supabase
        .from('user_roles')
        .select('user_id')
        .eq('role', 'agent')
        .limit(2000);
      const agentIds = (agentRoleRows || []).map(r => r.user_id);
      if (agentIds.length === 0) return [];

      let qb = supabase
        .from('profiles')
        .select('id, full_name, phone, email')
        .in('id', agentIds)
        .order('full_name', { ascending: true })
        .limit(50);

      const q = parentSearch.trim();
      if (q.length >= 2) {
        const like = `%${q}%`;
        qb = qb.or(`full_name.ilike.${like},phone.ilike.${like},email.ilike.${like}`);
      }

      const { data, error } = await qb;
      if (error) throw error;
      return data || [];
    },
    staleTime: 30_000,
  });

  const reset = () => {
    setSelectedTenant(null);
    setSelectedParent(null);
    setTenantQuery('');
    setParentSearch('');
  };

  const convert = async () => {
    if (!user?.id) {
      toast.error('You must be signed in.');
      return;
    }
    if (!selectedTenant || !selectedParent) {
      toast.error('Pick both a tenant and a parent agent.');
      return;
    }
    if (selectedTenant.id === selectedParent.id) {
      toast.error('Tenant and parent agent cannot be the same person.');
      return;
    }

    setSubmitting(true);
    try {
      // 1. Add 'agent' role (idempotent — unique on user_id+role)
      const { error: roleErr } = await supabase
        .from('user_roles')
        .insert({ user_id: selectedTenant.id, role: 'agent' });
      if (roleErr && !roleErr.message.toLowerCase().includes('duplicate')) {
        throw roleErr;
      }

      // 2. Check for existing sub-agent link (any status)
      const { data: existing } = await supabase
        .from('agent_subagents')
        .select('id, parent_agent_id, status')
        .eq('sub_agent_id', selectedTenant.id)
        .maybeSingle();

      if (existing) {
        if (existing.parent_agent_id === selectedParent.id && existing.status === 'verified') {
          toast.info('This tenant is already a verified sub-agent of that parent.');
          return;
        }
        // Re-point + verify
        const { error: updErr } = await supabase
          .from('agent_subagents')
          .update({
            parent_agent_id: selectedParent.id,
            status: 'verified',
            source: 'agent_ops_assignment',
            verified_by: user.id,
            verified_at: new Date().toISOString(),
            rejection_reason: null,
          })
          .eq('id', existing.id);
        if (updErr) throw updErr;
      } else {
        const { error: insErr } = await supabase
          .from('agent_subagents')
          .insert({
            parent_agent_id: selectedParent.id,
            sub_agent_id: selectedTenant.id,
            source: 'agent_ops_assignment',
            status: 'verified',
            verified_by: user.id,
            verified_at: new Date().toISOString(),
          });
        if (insErr) throw insErr;
      }

      toast.success(
        `${selectedTenant.full_name || 'Tenant'} is now a sub-agent of ${selectedParent.full_name || 'agent'}.`,
        { description: 'Tenant role kept. Sub-agent role added and verified.' }
      );

      qc.invalidateQueries({ queryKey: ['ttsa-tenant-search'] });
      qc.invalidateQueries({ queryKey: ['ttsa-agent-search'] });
      qc.invalidateQueries({ queryKey: ['sub-agents'] });
      reset();
    } catch (err: any) {
      console.error('[TenantToSubAgentPanel] convert failed', err);
      toast.error('Conversion failed', { description: err?.message || 'Unknown error' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="p-4 sm:p-6 space-y-5">
      <div>
        <div className="flex items-center gap-2">
          <UserPlus className="h-5 w-5 text-primary" />
          <h3 className="text-base sm:text-lg font-semibold">
            Move Tenant → Sub-Agent
          </h3>
        </div>
        <p className="text-xs sm:text-sm text-muted-foreground mt-1">
          Convert a tenant into a sub-agent under any active agent. The tenant keeps their
          tenant role and rent plan; the sub-agent role is added and verified instantly.
        </p>
      </div>

      {/* ─── Step 1: pick tenant ──────────────────────── */}
      <div className="space-y-2">
        <Label htmlFor="tenant-search" className="text-sm font-semibold">
          1. Find tenant
        </Label>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            id="tenant-search"
            value={tenantQuery}
            onChange={(e) => setTenantQuery(e.target.value)}
            placeholder="Search by name, phone, or email (min 2 chars)"
            className="pl-9"
          />
        </div>

        {tenantQuery.trim().length >= 2 && (
          <div className="border border-border rounded-lg max-h-56 overflow-y-auto bg-card">
            {tenantsLoading && (
              <div className="p-3 text-sm text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Searching…
              </div>
            )}
            {!tenantsLoading && (tenants?.length || 0) === 0 && (
              <div className="p-3 text-sm text-muted-foreground">No matching tenants.</div>
            )}
            {(tenants || []).map((t) => {
              const isSelected = selectedTenant?.id === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setSelectedTenant(t)}
                  className={cn(
                    'w-full flex items-center justify-between gap-2 p-3 text-left text-sm border-b border-border last:border-b-0 hover:bg-accent transition-colors',
                    isSelected && 'bg-primary/10'
                  )}
                >
                  <div className="min-w-0">
                    <div className="font-medium truncate">{t.full_name || 'Unnamed'}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {t.phone || t.email || t.id.slice(0, 8)}
                    </div>
                  </div>
                  {isSelected && <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />}
                </button>
              );
            })}
          </div>
        )}

        {selectedTenant && (
          <div className="flex items-center gap-2 p-2 rounded-lg bg-primary/5 border border-primary/20 text-sm">
            <Badge variant="outline" className="bg-background">Tenant</Badge>
            <span className="font-medium truncate">{selectedTenant.full_name || 'Unnamed'}</span>
            <span className="text-xs text-muted-foreground truncate">{selectedTenant.phone}</span>
          </div>
        )}
      </div>

      {/* ─── Step 2: pick parent agent ─────────────────── */}
      <div className="space-y-2">
        <Label className="text-sm font-semibold">2. Choose parent agent</Label>
        <Popover open={parentOpen} onOpenChange={setParentOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              className="w-full justify-between font-normal"
            >
              {selectedParent ? (
                <span className="truncate">
                  {selectedParent.full_name || 'Unnamed agent'}
                  <span className="text-muted-foreground ml-2 text-xs">{selectedParent.phone}</span>
                </span>
              ) : (
                <span className="text-muted-foreground">Select an active agent…</span>
              )}
              <ChevronsUpDown className="h-4 w-4 opacity-50 shrink-0" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
            <Command shouldFilter={false}>
              <CommandInput
                placeholder="Search agent by name, phone, email…"
                value={parentSearch}
                onValueChange={setParentSearch}
              />
              <CommandList>
                {agentsLoading && (
                  <div className="p-3 text-sm text-muted-foreground flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                  </div>
                )}
                {!agentsLoading && (agents?.length || 0) === 0 && (
                  <CommandEmpty>No agents found.</CommandEmpty>
                )}
                <CommandGroup>
                  {(agents || []).map((a) => (
                    <CommandItem
                      key={a.id}
                      value={a.id}
                      onSelect={() => {
                        setSelectedParent(a);
                        setParentOpen(false);
                      }}
                    >
                      <div className="flex flex-col min-w-0">
                        <span className="font-medium truncate">{a.full_name || 'Unnamed'}</span>
                        <span className="text-xs text-muted-foreground truncate">
                          {a.phone || a.email || a.id.slice(0, 8)}
                        </span>
                      </div>
                      {selectedParent?.id === a.id && (
                        <CheckCircle2 className="ml-auto h-4 w-4 text-primary" />
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>

      {/* ─── Action ─────────────────────────────────────── */}
      <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end pt-2">
        <Button variant="ghost" onClick={reset} disabled={submitting}>
          Clear
        </Button>
        <Button
          onClick={convert}
          disabled={!selectedTenant || !selectedParent || submitting}
        >
          {submitting ? (
            <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Converting…</>
          ) : (
            <>Convert & Assign</>
          )}
        </Button>
      </div>
    </Card>
  );
}
