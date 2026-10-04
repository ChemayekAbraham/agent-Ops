import { useEffect } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useState } from 'react';

const fmtUGX = (n: number) => `UGX ${Math.round(Number(n) || 0).toLocaleString()}`;

interface Props {
  agentId: string;
}

/**
 * Aggressive in-app blocker shown to an agent when Tenant Ops edits the amount
 * paid to a landlord (or a tenant's rent amount) on one of the agent's tenants.
 * The agent must explicitly Agree or Dispute every pending edit before they can
 * continue — this is how "both sides agree" is enforced.
 */
export function AgentPaymentEditAlert({ agentId }: Props) {
  const qc = useQueryClient();

  const { data: pending = [] } = useQuery({
    queryKey: ['agent-pending-payment-edits', agentId],
    enabled: !!agentId,
    queryFn: async () => {
      const { data } = await supabase
        .from('landlord_payment_edits')
        .select('id, edit_type, old_amount, new_amount, reason, edited_by_name, created_at, landlord_name')
        .eq('agent_id', agentId)
        .is('agent_response', null)
        .order('created_at', { ascending: false });
      return data ?? [];
    },
  });

  // Realtime — surface new edits the instant ops records them.
  useEffect(() => {
    if (!agentId) return;
    const channel = supabase
      .channel(`payment-edits-${agentId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'landlord_payment_edits', filter: `agent_id=eq.${agentId}` },
        () => qc.invalidateQueries({ queryKey: ['agent-pending-payment-edits', agentId] }),
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [agentId, qc]);

  const current = pending[0] ?? null;

  if (!current) return null;

  return <PaymentEditDialog edit={current} remaining={pending.length} agentId={agentId} />;
}

function PaymentEditDialog({ edit, remaining, agentId }: { edit: any; remaining: number; agentId: string }) {
  const qc = useQueryClient();
  const [disputing, setDisputing] = useState(false);
  const [note, setNote] = useState('');

  const respond = useMutation({
    mutationFn: async (response: 'agreed' | 'disputed') => {
      const { error } = await supabase.rpc('agent_respond_payment_edit', {
        p_edit_id: edit.id,
        p_response: response,
        p_note: response === 'disputed' ? note.trim() : null,
      } as any);
      if (error) throw error;
      return response;
    },
    onSuccess: (response) => {
      toast.success(response === 'agreed' ? 'You agreed to the change' : 'Dispute submitted to Ops');
      setDisputing(false);
      setNote('');
      qc.invalidateQueries({ queryKey: ['agent-pending-payment-edits', agentId] });
    },
    onError: (e: any) => toast.error(e.message ?? 'Could not submit response'),
  });

  const isRent = edit.edit_type === 'rent_amount';

  return (
    <Dialog open onOpenChange={() => { /* blocking — must respond */ }}>
      <DialogContent className="sm:max-w-md" onPointerDownOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" /> Payment amount changed by Ops
          </DialogTitle>
          <DialogDescription>
            Tenant Ops changed {isRent ? 'a rent amount' : 'an amount paid to a landlord'} on one of your tenants.
            Please review and confirm you agree, or raise a dispute.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-xl border border-border p-3 space-y-2 bg-card">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">
              {isRent ? 'Rent amount' : `Landlord payout${edit.landlord_name ? ` · ${edit.landlord_name}` : ''}`}
            </span>
            {remaining > 1 && <Badge variant="outline" className="text-[10px]">{remaining} pending</Badge>}
          </div>
          <div className="text-sm">
            <span className="line-through text-muted-foreground">{fmtUGX(edit.old_amount)}</span>
            {' → '}
            <span className="font-bold text-foreground">{fmtUGX(edit.new_amount)}</span>
          </div>
          <div className="text-xs text-muted-foreground">Reason: {edit.reason}</div>
          <div className="text-[11px] text-muted-foreground/80">Changed by {edit.edited_by_name || 'Ops'}</div>
        </div>

        {disputing && (
          <div className="space-y-1">
            <p className="text-[11px] text-muted-foreground">
              Disputing reverts the amount to {fmtUGX(edit.old_amount)} and pauses it there until Tenant Ops resolves the dispute.
            </p>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="Explain why you disagree (min 5 chars)…"
              className="text-sm"
            />
          </div>
        )}

        <div className="flex flex-col gap-2">
          {!disputing ? (
            <>
              <Button
                className="w-full gap-2"
                disabled={respond.isPending}
                onClick={() => respond.mutate('agreed')}
              >
                {respond.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                I agree to this amount
              </Button>
              <Button variant="outline" className="w-full" onClick={() => setDisputing(true)} disabled={respond.isPending}>
                I disagree — raise dispute
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="destructive"
                className="w-full"
                disabled={respond.isPending || note.trim().length < 5}
                onClick={() => respond.mutate('disputed')}
              >
                {respond.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Submit dispute'}
              </Button>
              <Button variant="ghost" className="w-full" onClick={() => setDisputing(false)} disabled={respond.isPending}>
                Back
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}