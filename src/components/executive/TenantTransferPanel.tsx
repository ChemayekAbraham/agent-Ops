import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { AlertTriangle, ArrowRightLeft, Clock, Ban, Search, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';

interface FlaggedTenant {
  tenant_id: string;
  tenant_name: string;
  tenant_phone: string;
  agent_id: string;
  agent_name: string;
  flag_type: string;
  last_visit_at: string | null;
  accumulated_debt: number;
  active_rent_requests: number;
}

export function TenantTransferPanel() {
  const queryClient = useQueryClient();
  const [selectedTenant, setSelectedTenant] = useState<FlaggedTenant | null>(null);
  const [targetAgentSearch, setTargetAgentSearch] = useState('');
  const [targetAgent, setTargetAgent] = useState<{ id: string; full_name: string; phone: string } | null>(null);
  const [reason, setReason] = useState('');

  // Flagged tenants
  const { data: flagged, isLoading, refetch } = useQuery({
    queryKey: ['flagged-tenants-transfer'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_flagged_tenants_for_transfer');
      if (error) throw error;
      return (data || []) as FlaggedTenant[];
    },
    staleTime: 300000,
  });

  // Search agents
  const { data: agentResults } = useQuery({
    queryKey: ['search-agents-transfer', targetAgentSearch],
    queryFn: async () => {
      if (targetAgentSearch.length < 3) return [];
      const { data } = await supabase
        .from('profiles')
        .select('id, full_name, phone')
        .or(`full_name.ilike.%${targetAgentSearch}%,phone.ilike.%${targetAgentSearch}%`)
        .limit(10);
      // Filter to only agents
      if (!data || data.length === 0) return [];
      const { data: agentRoles } = await supabase
        .from('user_roles')
        .select('user_id')
        .in('user_id', data.map(d => d.id))
        .eq('role', 'agent');
      const agentIds = new Set((agentRoles || []).map(r => r.user_id));
      return data.filter(d => agentIds.has(d.id));
    },
    enabled: targetAgentSearch.length >= 3,
    staleTime: 30000,
  });

  // Transfer mutation
  const transferMutation = useMutation({
    mutationFn: async () => {
      if (!selectedTenant || !targetAgent) throw new Error('Missing data');
      const { data, error } = await supabase.functions.invoke('transfer-tenant', {
        body: {
          tenant_id: selectedTenant.tenant_id,
          from_agent_id: selectedTenant.agent_id,
          to_agent_id: targetAgent.id,
          reason,
          flag_type: selectedTenant.flag_type,
        },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: (data) => {
      toast.success(`Tenant transferred! ${data.rent_requests_updated} request(s) and ${data.subscriptions_updated} subscription(s) reassigned.`);
      setSelectedTenant(null);
      setTargetAgent(null);
      setTargetAgentSearch('');
      setReason('');
      queryClient.invalidateQueries({ queryKey: ['flagged-tenants-transfer'] });
    },
    onError: (err: any) => {
      toast.error(err.message || 'Transfer failed');
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ArrowRightLeft className="h-5 w-5 text-warning" />
          <h3 className="text-sm font-semibold">Tenant Transfers</h3>
          {flagged && flagged.length > 0 && (
            <Badge variant="destructive" className="text-xs animate-pulse">
              {flagged.length} flagged
            </Badge>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isLoading}>
          <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-16 bg-muted animate-pulse rounded-xl" />
          ))}
        </div>
      ) : !flagged || flagged.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground text-sm">
          <AlertTriangle className="h-8 w-8 mx-auto mb-2 opacity-40" />
          No tenants flagged for transfer
        </div>
      ) : (
        <div className="space-y-2 max-h-[400px] overflow-y-auto">
          {flagged.map((t) => (
            <button
              key={t.tenant_id}
              onClick={() => {
                setSelectedTenant(t);
                setReason(
                  t.flag_type === 'no_visits'
                    ? 'Agent has not visited tenant in over 14 days'
                    : 'Tenant has accumulated 3+ missed payments under current agent'
                );
              }}
              className="w-full text-left p-3 rounded-xl border border-border bg-card hover:bg-accent/50 transition-colors"
            >
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-medium text-sm">{t.tenant_name}</p>
                  <p className="text-xs text-muted-foreground">{t.tenant_phone}</p>
                </div>
                <Badge variant={t.flag_type === 'no_visits' ? 'secondary' : 'destructive'} className="text-[10px]">
                  {t.flag_type === 'no_visits' ? (
                    <><Clock className="h-3 w-3 mr-1" />No visits</>
                  ) : (
                    <><Ban className="h-3 w-3 mr-1" />Debt</>
                  )}
                </Badge>
              </div>
              <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                <span>Agent: <span className="font-medium text-foreground">{t.agent_name}</span></span>
                {t.last_visit_at && (
                  <span>Last visit: {format(new Date(t.last_visit_at), 'dd MMM')}</span>
                )}
                {t.accumulated_debt > 0 && (
                  <span className="text-destructive font-medium">
                    Debt: {Number(t.accumulated_debt).toLocaleString()} UGX
                  </span>
                )}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {t.active_rent_requests} active request(s)
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Transfer Dialog */}
      <Dialog open={!!selectedTenant} onOpenChange={(open) => !open && setSelectedTenant(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowRightLeft className="h-5 w-5" />
              Transfer Tenant
            </DialogTitle>
          </DialogHeader>

          {selectedTenant && (
            <div className="space-y-4">
              {/* Tenant info */}
              <div className="p-3 rounded-lg bg-muted/50">
                <p className="text-sm font-medium">{selectedTenant.tenant_name}</p>
                <p className="text-xs text-muted-foreground">{selectedTenant.tenant_phone}</p>
                <p className="text-xs mt-1">
                  Current agent: <span className="font-medium">{selectedTenant.agent_name}</span>
                </p>
                <p className="text-xs">{selectedTenant.active_rent_requests} active request(s) will be reassigned</p>
              </div>

              {/* Target agent search */}
              <div className="space-y-2">
                <label className="text-sm font-medium">New Agent</label>
                {targetAgent ? (
                  <div className="flex items-center justify-between p-2 rounded-lg bg-primary/10 border border-primary/20">
                    <div>
                      <p className="text-sm font-medium">{targetAgent.full_name}</p>
                      <p className="text-xs text-muted-foreground">{targetAgent.phone}</p>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => { setTargetAgent(null); setTargetAgentSearch(''); }}>
                      Change
                    </Button>
                  </div>
                ) : (
                  <div className="relative">
                    <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Search agent by name or phone..."
                      value={targetAgentSearch}
                      onChange={(e) => setTargetAgentSearch(e.target.value)}
                      className="pl-9"
                    />
                    {agentResults && agentResults.length > 0 && (
                      <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-popover border border-border rounded-lg shadow-lg max-h-40 overflow-y-auto">
                        {agentResults
                          .filter(a => a.id !== selectedTenant.agent_id)
                          .map((a) => (
                            <button
                              key={a.id}
                              onClick={() => { setTargetAgent(a); setTargetAgentSearch(''); }}
                              className="w-full text-left px-3 py-2 hover:bg-accent text-sm"
                            >
                              <span className="font-medium">{a.full_name}</span>
                              <span className="ml-2 text-muted-foreground text-xs">{a.phone}</span>
                            </button>
                          ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Reason */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Reason (min 10 chars)</label>
                <Textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Why is this tenant being transferred?"
                  rows={2}
                />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setSelectedTenant(null)}>Cancel</Button>
            <Button
              onClick={() => transferMutation.mutate()}
              disabled={!targetAgent || reason.length < 10 || transferMutation.isPending}
              className="bg-warning text-warning-foreground hover:bg-warning/90"
            >
              {transferMutation.isPending ? 'Transferring...' : 'Confirm Transfer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
