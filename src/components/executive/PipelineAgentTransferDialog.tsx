import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { ArrowRightLeft, Loader2, Search } from 'lucide-react';
import { toast } from 'sonner';

interface PipelineAgentTransferDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requestId: string;
  tenantName: string;
  currentAgentId?: string | null;
  currentAgentName?: string | null;
  onTransferred?: () => void;
}

/**
 * Ops-only transfer of a rent request that is still inside the approval
 * pipeline to a different agent. The RPC re-points the request (and the
 * tenant's active recurring charges) so every future commission, repayment
 * and renewal attaches to the new agent.
 */
export function PipelineAgentTransferDialog({
  open,
  onOpenChange,
  requestId,
  tenantName,
  currentAgentId,
  currentAgentName,
  onTransferred,
}: PipelineAgentTransferDialogProps) {
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState<{ id: string; full_name: string; phone: string } | null>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const { data: results, isFetching, error: searchError } = useQuery({
    queryKey: ['pipeline-transfer-agent-search', search],
    queryFn: async () => {
      if (search.trim().length < 3) return [];
      const term = search.trim();
      // Ops staff cannot read other people's profiles directly (RLS), which
      // made every search return "No matching agents". This security-definer
      // RPC does the name/phone lookup and the agent-role filter server-side.
      const { data, error } = await supabase.rpc('ops_search_transfer_agents' as any, {
        p_term: term,
        p_exclude_agent_id: currentAgentId ?? null,
        p_limit: 15,
      });
      if (error) throw error;
      return (data || []) as any[];
    },
    enabled: open && search.trim().length >= 3,
    staleTime: 30000,
  });

  const reset = () => { setSearch(''); setTarget(null); setReason(''); };

  const handleTransfer = async () => {
    if (!target || reason.trim().length < 10) return;
    setSubmitting(true);
    try {
      const { data, error } = await supabase.rpc('ops_transfer_pipeline_request_agent', {
        p_request_id: requestId,
        p_to_agent_id: target.id,
        p_reason: reason.trim(),
      });
      if (error) throw error;
      const res: any = data;
      toast.success(`Transferred to ${target.full_name}`, {
        description: `All commissions, repayments and renewals now attach to them${res?.subscriptions_updated ? ` • ${res.subscriptions_updated} recurring charge(s) moved` : ''}`,
      });
      reset();
      onOpenChange(false);
      onTransferred?.();
    } catch (e: any) {
      toast.error('Transfer failed', { description: e?.message || 'Unknown error' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeft className="h-4 w-4" />
            Transfer Tenant to Another Agent
          </DialogTitle>
          <DialogDescription className="text-xs">
            {tenantName} — currently attached to {currentAgentName || 'no agent'}. The new agent inherits all
            commissions, repayments and renewals for this request.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Search new agent (name or phone)</label>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => { setSearch(e.target.value); setTarget(null); }}
                placeholder="Type at least 3 characters..."
                className="pl-8 h-9"
              />
            </div>
            {search.trim().length >= 3 && (
              <div className="max-h-44 overflow-y-auto rounded-lg border border-border divide-y divide-border">
                {isFetching && (
                  <p className="p-2 text-xs text-muted-foreground flex items-center gap-1">
                    <Loader2 className="h-3 w-3 animate-spin" /> Searching…
                  </p>
                )}
                {!isFetching && searchError && (
                  <p className="p-2 text-xs text-destructive">
                    {(searchError as any)?.message || 'Search failed'}
                  </p>
                )}
                {!isFetching && !searchError && (results || []).length === 0 && (
                  <p className="p-2 text-xs text-muted-foreground">No matching agents</p>
                )}
                {(results || []).map((a: any) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setTarget(a)}
                    className={`w-full text-left p-2 text-sm hover:bg-muted/60 transition-colors ${target?.id === a.id ? 'bg-primary/10' : ''}`}
                  >
                    <span className="font-medium">{a.full_name || 'Unnamed'}</span>
                    <span className="block text-xs text-muted-foreground">
                      {a.phone || 'No phone'}{a.role ? ` • ${String(a.role).replace(/_/g, ' ')}` : ''}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Reason (min 10 characters)</label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this tenant being transferred?"
              rows={3}
            />
            <p className="text-[10px] text-muted-foreground">{reason.trim().length}/10</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleTransfer}
            disabled={submitting || !target || reason.trim().length < 10}
            className="gap-1"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRightLeft className="h-4 w-4" />}
            Confirm Transfer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
