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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { Undo2, Loader2 } from 'lucide-react';

interface Props {
  advance: any | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

/**
 * Reverses a disbursed advance: pulls the money back out of the agent's
 * withdrawable wallet through the CFO Direct Debit channel (the only permitted
 * wallet -> platform debit path) and then marks the advance reversed so all
 * further deductions stop and no debt remains on the agent.
 */
export function ReverseAdvanceDialog({ advance, open, onOpenChange, onSuccess }: Props) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [noClawback, setNoClawback] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const agentId: string | undefined = advance?.agent_id;
  const agentName = advance?.profiles?.full_name || 'agent';
  const principal = Number(advance?.principal || 0);
  const outstanding = Number(advance?.outstanding_balance || 0);

  const { data: withdrawable = 0, isLoading: loadingBalance } = useQuery({
    queryKey: ['advance-reversal-withdrawable', agentId],
    enabled: !!agentId && open,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_user_available_balance', {
        p_user_id: agentId!,
      });
      if (error) throw error;
      return Number(data || 0);
    },
  });

  useEffect(() => {
    if (!open) return;
    setAmount(String(Math.max(0, Math.min(principal, withdrawable))));
    setReason('');
    setNoClawback(false);
  }, [open, principal, withdrawable]);

  const clawback = noClawback ? 0 : Math.max(0, Number(amount || 0));
  const exceedsBalance = clawback > withdrawable;

  const handleSubmit = async () => {
    if (!advance) return;
    if (reason.trim().length < 10) {
      toast.error('Please enter a reason (min 10 characters).');
      return;
    }
    if (!noClawback && clawback <= 0) {
      toast.error('Enter a clawback amount, or tick "funds already returned".');
      return;
    }
    if (exceedsBalance) {
      toast.error(`Agent only has ${formatUGX(withdrawable)} withdrawable. Lower the amount.`);
      return;
    }

    setSubmitting(true);
    try {
      let groupId: string | null = null;

      if (clawback > 0) {
        const { data, error } = await supabase.functions.invoke('cfo-direct-credit', {
          body: {
            target_user_id: agentId,
            amount: clawback,
            reason: `Advance reversal — ${reason.trim()}`,
            operation: 'debit' as const,
            wallet_category: 'wallet_transfer',
            platform_category: 'wallet_transfer',
            financial_impact: 'neutral' as const,
            category_label: 'Agent advance reversal (clawback)',
            recipient_type: 'user',
            sub_category: advance.id,
          },
        });
        if (error) throw new Error((error as any)?.message || 'Wallet clawback failed');
        if ((data as any)?.error) throw new Error((data as any).error);
        groupId = (data as any)?.transaction_group_id ?? null;
      }

      const { error: rpcError } = await supabase.rpc('reverse_agent_advance', {
        p_advance_id: advance.id,
        p_reason: reason.trim(),
        p_clawback_amount: clawback,
        p_clawback_group_id: groupId,
      });
      if (rpcError) throw rpcError;

      toast.success(
        clawback > 0
          ? `Advance reversed. ${formatUGX(clawback)} pulled back from ${agentName}'s wallet.`
          : 'Advance reversed. No wallet clawback taken.',
      );
      onOpenChange(false);
      onSuccess?.();
    } catch (e: any) {
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
            Pulls the disbursed money back out of the agent&apos;s wallet, stops all deductions and
            clears the advance. This is an accounting reversal, not a cancellation.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg border p-2">
              <p className="text-[10px] text-muted-foreground">Disbursed</p>
              <p className="text-xs font-bold">{formatUGX(principal)}</p>
            </div>
            <div className="rounded-lg border p-2">
              <p className="text-[10px] text-muted-foreground">Outstanding</p>
              <p className="text-xs font-bold text-amber-600">{formatUGX(outstanding)}</p>
            </div>
            <div className="rounded-lg border p-2">
              <p className="text-[10px] text-muted-foreground">Wallet available</p>
              <p className="text-xs font-bold">
                {loadingBalance ? '…' : formatUGX(withdrawable)}
              </p>
            </div>
          </div>

          <div>
            <Label className="text-xs font-semibold">Amount to pull back from wallet</Label>
            <Input
              type="number"
              min={0}
              value={amount}
              disabled={noClawback}
              onChange={(e) => setAmount(e.target.value)}
              className="mt-1"
            />
            {exceedsBalance && !noClawback && (
              <p className="text-[11px] text-destructive mt-1">
                Exceeds the agent&apos;s withdrawable balance of {formatUGX(withdrawable)}.
              </p>
            )}
          </div>

          <label className="flex items-start gap-2 rounded-lg border p-3 cursor-pointer">
            <Checkbox
              checked={noClawback}
              onCheckedChange={(v) => setNoClawback(!!v)}
              className="mt-0.5"
            />
            <span className="text-xs">
              <span className="font-semibold">Funds already returned</span> — reverse the advance
              record only, without debiting the wallet.
            </span>
          </label>

          <div>
            <Label className="text-xs font-semibold">Reason (required, min 10 chars)</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Advance disbursed in error on 24 Aug, reversing full principal"
              className="mt-1 min-h-[70px]"
            />
          </div>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>Keep advance</AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={handleSubmit}
            disabled={submitting || reason.trim().length < 10 || (!noClawback && exceedsBalance)}
          >
            {submitting ? (<><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Reversing…</>) : 'Reverse advance'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
