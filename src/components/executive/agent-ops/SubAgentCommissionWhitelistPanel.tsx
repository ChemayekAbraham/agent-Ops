import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { Loader2, ShieldCheck, Search, Percent } from 'lucide-react';
import { format } from 'date-fns';

interface WhitelistRow {
  sub_agent_id: string;
  sub_agent_name: string;
  sub_agent_phone: string | null;
  parent_agent_id: string;
  parent_agent_name: string;
  link_status: string;
  whitelisted: boolean;
  reason: string | null;
  updated_at: string | null;
  collections_30d: number;
  commission_30d: number;
}

const fmtUGX = (n: number) => `UGX ${Number(n || 0).toLocaleString()}`;

export function SubAgentCommissionWhitelistPanel() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState<{ row: WhitelistRow; next: boolean } | null>(null);
  const [reason, setReason] = useState('');

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['subagent-commission-whitelist', query],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('agent_ops_list_subagent_commission_whitelist', {
        p_search: query || null,
      });
      if (error) throw error;
      return (data || []) as WhitelistRow[];
    },
    staleTime: 60_000,
  });

  const mutation = useMutation({
    mutationFn: async ({ subAgentId, next, reason }: { subAgentId: string; next: boolean; reason: string }) => {
      const { data, error } = await supabase.rpc('agent_ops_set_subagent_commission_whitelist', {
        p_sub_agent_id: subAgentId,
        p_whitelisted: next,
        p_reason: reason,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (_d, vars) => {
      toast.success(vars.next ? 'Sub-agent whitelisted for full commission' : 'Whitelist removed — parent override restored');
      setTarget(null);
      setReason('');
      qc.invalidateQueries({ queryKey: ['subagent-commission-whitelist'] });
    },
    onError: (e: any) => toast.error(e?.message || 'Could not update whitelist'),
  });

  const rows = data || [];
  const whitelistedCount = rows.filter(r => r.whitelisted).length;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
            Sub-Agent Full Commission Whitelist
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Whitelisted sub-agents keep the full 10% rent-repayment commission and their own house-listing
            bonuses — no override share is deducted for the parent agent.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="rounded-xl border bg-muted/30 p-3">
              <div className="text-xs text-muted-foreground">Linked sub-agents</div>
              <div className="text-xl font-bold">{rows.length}</div>
            </div>
            <div className="rounded-xl border bg-muted/30 p-3">
              <div className="text-xs text-muted-foreground">Whitelisted</div>
              <div className="text-xl font-bold text-emerald-600">{whitelistedCount}</div>
            </div>
            <div className="rounded-xl border bg-muted/30 p-3">
              <div className="text-xs text-muted-foreground">Standard split</div>
              <div className="text-xl font-bold">8% / 2%</div>
            </div>
          </div>

          <form
            className="flex gap-2"
            onSubmit={(e) => { e.preventDefault(); setQuery(search.trim()); }}
          >
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search sub-agent, phone or parent agent"
            />
            <Button type="submit" variant="secondary">
              <Search className="h-4 w-4" />
            </Button>
          </form>

          {isLoading && (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading sub-agents…
            </div>
          )}

          {isError && (
            <p className="py-6 text-center text-sm text-destructive">
              {(error as any)?.message || 'Failed to load sub-agents'}
            </p>
          )}

          {!isLoading && !isError && rows.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">No linked sub-agents found.</p>
          )}

          <div className="space-y-2">
            {rows.map((r) => (
              <div
                key={r.sub_agent_id}
                className="flex flex-col gap-3 rounded-xl border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-semibold">{r.sub_agent_name}</span>
                    {r.whitelisted ? (
                      <Badge className="bg-emerald-600 hover:bg-emerald-600">Full 10%</Badge>
                    ) : (
                      <Badge variant="secondary">8% + 2% parent</Badge>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {r.sub_agent_phone || 'No phone'} · Parent: {r.parent_agent_name} · {r.link_status}
                  </div>
                  <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                    <Percent className="h-3 w-3" />
                    30d collections {fmtUGX(r.collections_30d)} · commission pool {fmtUGX(r.commission_30d)}
                  </div>
                  {r.reason && (
                    <div className="mt-1 text-xs text-muted-foreground">
                      Last change: {r.reason}
                      {r.updated_at ? ` (${format(new Date(r.updated_at), 'dd MMM yy')})` : ''}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 self-start sm:self-center">
                  <Switch
                    checked={r.whitelisted}
                    disabled={mutation.isPending}
                    onCheckedChange={(next) => { setReason(''); setTarget({ row: r, next }); }}
                    aria-label="Toggle full commission whitelist"
                  />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!target} onOpenChange={(o) => { if (!o) { setTarget(null); setReason(''); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {target?.next ? 'Whitelist for full commission' : 'Remove from whitelist'}
            </DialogTitle>
            <DialogDescription>
              {target?.next
                ? `${target?.row.sub_agent_name} will earn the full 10% on every rent repayment they collect. ${target?.row.parent_agent_name} stops earning the 2% override.`
                : `${target?.row.sub_agent_name} returns to the 8% share and ${target?.row.parent_agent_name} resumes the 2% override.`}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (minimum 10 characters)"
            rows={3}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setTarget(null); setReason(''); }}>Cancel</Button>
            <Button
              disabled={reason.trim().length < 10 || mutation.isPending}
              onClick={() => target && mutation.mutate({ subAgentId: target.row.sub_agent_id, next: target.next, reason: reason.trim() })}
            >
              {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
