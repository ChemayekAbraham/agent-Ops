import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { AlertTriangle, RefreshCw, ArrowRightLeft, Search } from 'lucide-react';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';

interface IdleRow {
  rent_request_id: string;
  tenant_id: string;
  agent_id: string;
  cadence: 'daily' | 'weekly' | 'unknown';
  days_idle: number;
  state: 'warn' | 'at_risk' | 'reassign_ready';
  last_collection_at: string | null;
  updated_at: string;
  tenant_name?: string | null;
  agent_name?: string | null;
}

export function IdleTenantsPanel() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<'all' | 'reassign_ready' | 'at_risk'>('reassign_ready');
  const [selected, setSelected] = useState<IdleRow | null>(null);
  const [newAgentPhone, setNewAgentPhone] = useState('');
  const [reason, setReason] = useState('');

  const { data: rows = [], isLoading, refetch } = useQuery({
    queryKey: ['idle-tenants', filter],
    queryFn: async () => {
      let q = supabase
        .from('tenant_idle_states')
        .select('rent_request_id, tenant_id, agent_id, cadence, days_idle, state, last_collection_at, updated_at')
        .neq('state', 'healthy')
        .order('days_idle', { ascending: false })
        .limit(500);
      if (filter !== 'all') q = q.eq('state', filter);
      const { data, error } = await q;
      if (error) throw error;
      const rows = (data ?? []) as IdleRow[];
      const ids = Array.from(new Set(rows.flatMap((r) => [r.tenant_id, r.agent_id])));
      if (ids.length === 0) return rows;
      const { data: profiles } = await supabase.from('profiles').select('id, full_name').in('id', ids);
      const nameById = new Map((profiles ?? []).map((p: any) => [p.id, p.full_name]));
      return rows.map((r) => ({
        ...r,
        tenant_name: nameById.get(r.tenant_id) ?? null,
        agent_name: nameById.get(r.agent_id) ?? null,
      }));
    },
  });

  const refreshMut = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke('refresh-tenant-idle-states');
      if (error) throw error;
      return data;
    },
    onSuccess: (d: any) => {
      toast.success(`Idle states refreshed (${d?.rows ?? 0} rows)`);
      qc.invalidateQueries({ queryKey: ['idle-tenants'] });
    },
    onError: (e: any) => toast.error(e.message || 'Refresh failed'),
  });

  const reassignMut = useMutation({
    mutationFn: async ({ rent_request_id, new_agent_id, reason }: { rent_request_id: string; new_agent_id: string; reason: string }) => {
      const { data, error } = await supabase.rpc('agent_ops_reassign_idle_tenant', {
        p_rent_request_id: rent_request_id,
        p_new_agent_id: new_agent_id,
        p_reason: reason,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success('Tenant reassigned');
      setSelected(null);
      setNewAgentPhone('');
      setReason('');
      qc.invalidateQueries({ queryKey: ['idle-tenants'] });
    },
    onError: (e: any) => toast.error(e.message || 'Reassignment failed'),
  });

  const submitReassign = async () => {
    if (!selected) return;
    if (reason.trim().length < 10) return toast.error('Reason must be at least 10 characters');
    const phone = newAgentPhone.trim();
    if (!phone) return toast.error('Enter the new agent phone');
    const { data: match, error } = await supabase
      .from('profiles')
      .select('id, full_name')
      .eq('phone', phone)
      .maybeSingle();
    if (error || !match) return toast.error('No agent found with that phone');
    reassignMut.mutate({ rent_request_id: selected.rent_request_id, new_agent_id: match.id, reason: reason.trim() });
  };

  const stateBadge = (s: IdleRow['state']) => (
    <Badge variant={s === 'reassign_ready' ? 'destructive' : s === 'at_risk' ? 'secondary' : 'outline'}>
      {s === 'reassign_ready' ? 'Reassign ready' : s === 'at_risk' ? 'At risk' : 'Warned'}
    </Badge>
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h3 className="font-semibold flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            Idle Tenants
          </h3>
          <p className="text-xs text-muted-foreground">
            Tenants whose current agent has stopped collecting. Reassignment does not lock the tenant — the original agent can still collect until you transfer.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as any)}
            className="h-9 rounded-md border bg-background px-2 text-sm"
          >
            <option value="reassign_ready">Reassign ready</option>
            <option value="at_risk">At risk</option>
            <option value="all">All (incl. warned)</option>
          </select>
          <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isLoading}>
            <Search className="h-4 w-4 mr-1" /> Reload
          </Button>
          <Button size="sm" onClick={() => refreshMut.mutate()} disabled={refreshMut.isPending}>
            <RefreshCw className={`h-4 w-4 mr-1 ${refreshMut.isPending ? 'animate-spin' : ''}`} />
            Recompute
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="text-left p-2">Tenant</th>
              <th className="text-left p-2">Current agent</th>
              <th className="text-left p-2">Cadence</th>
              <th className="text-right p-2">Idle</th>
              <th className="text-left p-2">Last collection</th>
              <th className="text-left p-2">State</th>
              <th className="text-right p-2">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !isLoading && (
              <tr>
                <td colSpan={7} className="p-6 text-center text-muted-foreground">
                  No idle tenants at this level. 🎉
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.rent_request_id} className="border-t">
                <td className="p-2">
                  <div className="font-medium">{r.tenant_name ?? r.tenant_id.slice(0, 8)}</div>
                </td>
                <td className="p-2">{r.agent_name ?? r.agent_id.slice(0, 8)}</td>
                <td className="p-2 capitalize">{r.cadence}</td>
                <td className="p-2 text-right font-mono">{r.days_idle}d</td>
                <td className="p-2 text-xs text-muted-foreground">
                  {r.last_collection_at
                    ? formatDistanceToNow(new Date(r.last_collection_at), { addSuffix: true })
                    : 'Never'}
                </td>
                <td className="p-2">{stateBadge(r.state)}</td>
                <td className="p-2 text-right">
                  <Button
                    size="sm"
                    variant={r.state === 'reassign_ready' ? 'default' : 'outline'}
                    onClick={() => setSelected(r)}
                    disabled={r.state === 'warn'}
                  >
                    <ArrowRightLeft className="h-3.5 w-3.5 mr-1" />
                    Reassign
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reassign tenant to another agent</DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-3">
              <div className="rounded-md border p-3 text-sm">
                <div><span className="text-muted-foreground">Tenant:</span> {selected.tenant_name ?? selected.tenant_id.slice(0, 8)}</div>
                <div><span className="text-muted-foreground">Current agent:</span> {selected.agent_name ?? selected.agent_id.slice(0, 8)}</div>
                <div><span className="text-muted-foreground">Idle:</span> {selected.days_idle} days ({selected.cadence})</div>
              </div>
              <div>
                <label className="text-xs font-medium">New agent phone (must have collected in last 3 days)</label>
                <Input
                  value={newAgentPhone}
                  onChange={(e) => setNewAgentPhone(e.target.value)}
                  placeholder="+2567xxxxxxxx"
                />
              </div>
              <div>
                <label className="text-xs font-medium">Reason (min 10 chars)</label>
                <Textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Why is this tenant being reassigned?"
                  rows={3}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSelected(null)}>Cancel</Button>
            <Button onClick={submitReassign} disabled={reassignMut.isPending}>
              {reassignMut.isPending ? 'Reassigning…' : 'Confirm reassignment'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default IdleTenantsPanel;
