import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { Undo2, Loader2 } from 'lucide-react';
import { CfoApprovalGate } from '@/components/cfo/CfoApprovalGate';

interface Props {
  advance: any | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

/**
 * Reverses a disbursed advance. The amount to reverse is derived entirely from
 * the authoritative approval / disbursement / ledger records for that advance
 * (Approved, Disbursed, Already recovered) — the CFO never types an amount and
 * the agent's wallet balance is only used to size what can be pulled back right
 * now. Recovery goes through CFO Direct Debit (the only permitted wallet ->
 * platform debit path); the advance then returns to Waiting for Approval.
 */
export function ReverseAdvanceDialog({ advance, open, onOpenChange, onSuccess }: Props) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const agentId: string | undefined = advance?.agent_id;
  const agentName = advance?.profiles?.full_name || 'agent';

  // Server-side truth for this specific advance.
  const { data: plan, isLoading: loadingPlan, refetch: refetchPlan } = useQuery({
    queryKey: ['advance-reversal-plan', advance?.id],
    enabled: !!advance?.id && open,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('advance_reversal_plan', {
        p_advance_id: advance!.id,
      });
      if (error) throw error;
      return data as any;
    },
  });

  useEffect(() => {
    if (open) setReason('');
  }, [open, advance?.id]);

  const approved = Number(plan?.principal ?? advance?.principal ?? 0);
  const disbursed = Number(plan?.disbursed_amount || 0);
  const alreadyRecovered = Number(plan?.clawback_posted_amount || 0);
  const withdrawable = Number(plan?.withdrawable || 0);
  const approvedToday = plan ? !!plan.approved_today : true;
  const alreadyReversed = !!plan?.already_reversed;

  // System-calculated: what still has to come back out of the wallet.
  const amountToReverse = Math.max(0, disbursed - alreadyRecovered);
  // Wallet balance only limits what is recoverable at this moment.
  const recoverableNow = Math.max(0, Math.min(amountToReverse, withdrawable));
  const shortage = Math.max(0, amountToReverse - recoverableNow);
  const needsDebit = amountToReverse > 0 && recoverableNow > 0;

  const handleSubmit = async () => {
    if (!advance) return;
    if (reason.trim().length < 10) {
      toast.error('Please enter a reason (min 10 characters).');
      return;
    }
    if (alreadyReversed) {
      toast.error('This advance has already been reversed.');
      return;
    }
    if (!approvedToday) {
      toast.error('Only advances approved today can be reverted to Waiting for Approval.');
      return;
    }

    setSubmitting(true);
    try {
      let groupId: string | null = null;

      // Debit only when money really left treasury and part of it is still
      // outstanding — this is what stops a second Revert click from creating a
      // duplicate clawback / ledger entry.
      if (needsDebit) {
        const { data, error } = await supabase.functions.invoke('cfo-direct-credit', {
          body: {
            target_user_id: agentId,
            amount: recoverableNow,
            reason: `Advance reversal — ${reason.trim()}`,
            operation: 'debit' as const,
            wallet_category: 'wallet_transfer',
            platform_category: 'wallet_transfer',
            financial_impact: 'neutral' as const,
            category_label: 'Agent advance reversal (clawback)',
            recipient_type: 'user',
            // Evidence tag the reversal RPC looks for in cfo_debit_obligations.
            sub_category: `advance_reversal:${advance.id}`,
            manual_credit: true,
          },
        });
        if (error) throw new Error((error as any)?.message || 'Wallet clawback failed');
        if ((data as any)?.error) throw new Error((data as any).error);
        groupId = (data as any)?.transaction_group_id ?? null;
      }

      const { data: result, error: rpcError } = await supabase.rpc('reverse_agent_advance', {
        p_advance_id: advance.id,
        p_reason: reason.trim(),
        p_clawback_amount: recoverableNow,
        p_clawback_group_id: groupId,
      });
      if (rpcError) throw rpcError;

      const recovered = Number((result as any)?.clawback_amount || 0);
      const unrecovered = Number((result as any)?.unrecovered_shortfall || 0);
      const fullyRecovered = (result as any)?.fully_recovered !== false;
      const outstandingAfter = Number((result as any)?.outstanding_after || 0);
      const parts: string[] = [];
      if (fullyRecovered) {
        parts.push('Advance reverted to Waiting for Approval.');
        if (recovered > 0) parts.push(`${formatUGX(recovered)} recovered from ${agentName}'s wallet.`);
        else parts.push('No wallet recovery was needed.');
      } else {
        parts.push(
          recovered > 0
            ? `${formatUGX(recovered)} recovered from ${agentName}'s wallet.`
            : `Nothing could be recovered — ${agentName}'s wallet is empty.`,
        );
        parts.push(
          `${formatUGX(unrecovered)} stays outstanding: the advance remains active (balance ${formatUGX(outstandingAfter)}) and keeps recovering from future earnings.`,
        );
      }
      toast.success(parts.join(' '));


      onOpenChange(false);
      onSuccess?.();
    } catch (e: any) {
      // Refresh the plan so the dialog reflects any partially completed step
      // (e.g. the debit landed but the status flip failed).
      refetchPlan();
      toast.error(e.message || 'Reversal failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!submitting) onOpenChange(o); }}>
      <AlertDialogContent className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Undo2 className="h-4 w-4 text-destructive" />
            Reverse advance for {agentName}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            The amount is calculated automatically from this advance&apos;s approval, disbursement and
            recovery records. If the wallet cannot cover the full amount, only what is available is
            recovered and the rest stays outstanding on the active advance for future earnings.
          </AlertDialogDescription>

        </AlertDialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
            <div className="rounded-lg border p-2">
              <p className="text-[10px] text-muted-foreground">Approved</p>
              <p className="text-xs font-bold">{loadingPlan ? '…' : formatUGX(approved)}</p>
            </div>
            <div className="rounded-lg border p-2">
              <p className="text-[10px] text-muted-foreground">Disbursed</p>
              <p className="text-xs font-bold">{loadingPlan ? '…' : formatUGX(disbursed)}</p>
            </div>
            <div className="rounded-lg border p-2">
              <p className="text-[10px] text-muted-foreground">Already recovered</p>
              <p className="text-xs font-bold text-emerald-600">
                {loadingPlan ? '…' : formatUGX(alreadyRecovered)}
              </p>
            </div>
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-2">
              <p className="text-[10px] text-muted-foreground">Amount to reverse</p>
              <p className="text-xs font-bold text-destructive">
                {loadingPlan ? '…' : formatUGX(amountToReverse)}
              </p>
            </div>
          </div>

          {!loadingPlan && (
            <div className="rounded-lg border bg-muted/40 p-3 space-y-1 text-xs">
              {amountToReverse === 0 ? (
                <p className="font-semibold">
                  {disbursed === 0
                    ? 'This advance was never disbursed — no wallet recovery is required.'
                    : 'The full disbursed amount has already been recovered — no further wallet recovery is required.'}
                </p>
              ) : (
                <>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Recoverable from wallet now</span>
                    <span className="font-semibold">{formatUGX(recoverableNow)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Agent withdrawable balance</span>
                    <span className="font-semibold">{formatUGX(withdrawable)}</span>
                  </div>
                  {shortage > 0 && (
                    <p className="text-destructive font-medium">
                      Shortage of {formatUGX(shortage)} — the agent does not hold enough withdrawable
                      funds. Only {formatUGX(recoverableNow)} is pulled back now; the wallet is never
                      driven negative.
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          {!loadingPlan && alreadyReversed && (
            <p className="text-xs font-medium text-destructive">
              This advance was already reversed — no further action is possible.
            </p>
          )}
          {!loadingPlan && !approvedToday && (
            <p className="text-xs font-medium text-destructive">
              Only advances approved today can be reverted to Waiting for Approval.
            </p>
          )}

          <div>
            <Label className="text-xs font-semibold">Reason (required, min 10 chars)</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Advance disbursed in error today, reversing full principal"
              className="mt-1 min-h-[70px]"
            />
          </div>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>Keep advance</AlertDialogCancel>
          <CfoApprovalGate>
          <Button
            variant="destructive"
            onClick={handleSubmit}
            disabled={
              submitting ||
              loadingPlan ||
              alreadyReversed ||
              !approvedToday ||
              reason.trim().length < 10
            }
          >
            {submitting ? (<><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Reversing…</>) : 'Reverse advance'}
          </Button>
          </CfoApprovalGate>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

