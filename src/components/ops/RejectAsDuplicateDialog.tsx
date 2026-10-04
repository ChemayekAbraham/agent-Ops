import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Loader2, ShieldX, AlertTriangle } from 'lucide-react';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import type { DuplicateAccount } from '@/components/ops/DuplicateAccountAlert';

export interface AgentDuplicateFlag {
  id: string;
  agent_id: string;
  duplicate_of_user_id: string | null;
  match_type: string;
  reason: string;
  status: string;
  flagged_at: string;
}

/** Active duplicate-account flags for a set of agents (blocks new advance requests). */
export function useAgentDuplicateFlags(agentIds: string[]) {
  const ids = Array.from(new Set(agentIds.filter(Boolean))).sort();
  return useQuery({
    queryKey: ['agent-duplicate-flags', ids.join(',')],
    enabled: ids.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<Record<string, AgentDuplicateFlag>> => {
      const { data, error } = await (supabase as any)
        .from('agent_duplicate_flags')
        .select('id, agent_id, duplicate_of_user_id, match_type, reason, status, flagged_at')
        .in('agent_id', ids)
        .eq('status', 'active');
      if (error) throw error;
      const map: Record<string, AgentDuplicateFlag> = {};
      for (const row of (data ?? []) as AgentDuplicateFlag[]) map[row.agent_id] = row;
      return map;
    },
  });
}

interface RejectAsDuplicateDialogProps {
  requestId: string | null;
  agentName?: string | null;
  dups?: DuplicateAccount[];
  onOpenChange: (open: boolean) => void;
  onDone?: () => void;
}

/**
 * CFO / Agent Ops action: reject an advance request specifically because the
 * account is a duplicate, and permanently flag the account so it can never
 * submit another advance request until a manager releases the flag.
 */
export function RejectAsDuplicateDialog({
  requestId, agentName, dups, onOpenChange, onDone,
}: RejectAsDuplicateDialogProps) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [dupId, setDupId] = useState<string | null>(null);

  const selectedDup = (dups ?? []).find((d) => d.id === dupId) ?? (dups ?? [])[0];

  const mutation = useMutation({
    mutationFn: async () => {
      if (!requestId) throw new Error('No request selected');
      const { error } = await (supabase.rpc as any)('reject_advance_as_duplicate', {
        p_request_id: requestId,
        p_reason: reason.trim(),
        p_duplicate_of_user_id: selectedDup?.id ?? null,
        p_match_type: selectedDup?.match_type ?? 'manual',
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Rejected as duplicate — account flagged and blocked from future advances');
      setReason('');
      onOpenChange(false);
      onDone?.();
      queryClient.invalidateQueries({ queryKey: ['advance-requests-queue'] });
      queryClient.invalidateQueries({ queryKey: ['advance-requests-reviewed'] });
      queryClient.invalidateQueries({ queryKey: ['cfo-advance-requests'] });
      queryClient.invalidateQueries({ queryKey: ['agent-duplicate-flags'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <Dialog open={!!requestId} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-red-700 dark:text-red-400">
            <ShieldX className="h-5 w-5" /> Reject as duplicate account
          </DialogTitle>
          <DialogDescription>
            {agentName ? `${agentName} ` : 'This account '}
            will be rejected and permanently flagged. A flagged account cannot
            submit any new advance request until a manager releases the flag.
          </DialogDescription>
        </DialogHeader>

        {(dups ?? []).length > 0 && (
          <div className="space-y-2">
            <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              Duplicate of
            </Label>
            <div className="space-y-1.5 max-h-48 overflow-y-auto">
              {(dups ?? []).map((d) => {
                const active = (dupId ?? (dups ?? [])[0]?.id) === d.id;
                return (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => setDupId(d.id)}
                    className={
                      'w-full text-left rounded-lg border px-2.5 py-2 transition ' +
                      (active
                        ? 'border-red-400 bg-red-50 dark:bg-red-950/30'
                        : 'border-border hover:bg-muted/50')
                    }
                  >
                    <p className="text-xs font-semibold truncate">{d.full_name || 'Unnamed'}</p>
                    <p className="text-[10px] text-muted-foreground truncate">
                      {d.phone || d.email || '—'} • {d.match_type.replace('_', ' ')}
                    </p>
                    {d.active_advances > 0 && (
                      <p className="text-[10px] font-semibold text-red-600 inline-flex items-center gap-1">
                        <AlertTriangle className="h-3 w-3" />
                        {d.active_advances} active advance{d.active_advances > 1 ? 's' : ''} • {formatUGX(d.outstanding)} outstanding
                      </p>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="space-y-1.5">
          <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            Reason (min 10 characters, shown to the agent)
          </Label>
          <Textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Same full name and mobile money number as an account with an ongoing advance."
            className="text-sm"
          />
        </div>

        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            className="flex-1 gap-1.5"
            disabled={reason.trim().length < 10 || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldX className="h-4 w-4" />}
            Flag & reject
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}