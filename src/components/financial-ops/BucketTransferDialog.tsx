import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { invalidateOpsWallet } from '@/hooks/ops/useOpsDataLayer';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ArrowRight, ArrowLeftRight, Loader2, Wallet, Banknote } from 'lucide-react';
import { toast } from 'sonner';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import { UserSearchPicker } from '@/components/cfo/UserSearchPicker';
import { formatUGX } from '@/lib/rentCalculations';

type Direction = 'withdrawable_to_float' | 'float_to_withdrawable';

interface BucketTransferDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Operator-only bucket correction dialog (CFO / Manager / Operations).
 *
 * Use case: an inbound deposit was routed to the wrong wallet bucket
 * (e.g. money landed in Personal Deposit / Withdrawable but was actually
 * operational float, or vice-versa). This dialog lets the operator move
 * the funds between the user's own buckets without touching the platform
 * ledger. The toggle switches the direction on demand.
 */
export default function BucketTransferDialog({ open, onOpenChange }: BucketTransferDialogProps) {
  const qc = useQueryClient();
  const [user, setUser] = useState<{ id: string; full_name: string } | null>(null);
  const [direction, setDirection] = useState<Direction>('withdrawable_to_float');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setUser(null);
      setDirection('withdrawable_to_float');
      setAmount('');
      setReason('');
      setSubmitting(false);
    }
  }, [open]);

  const { data: buckets, isLoading: bucketsLoading, refetch } = useQuery({
    queryKey: ['bucket-transfer-balances', user?.id],
    enabled: !!user?.id && open,
    queryFn: async () => {
      const { data, error } = await (supabase.from('wallets') as any)
        .select('withdrawable_balance, float_balance')
        .eq('user_id', user!.id)
        .maybeSingle();
      if (error) throw error;

      // Cached buckets can drift ABOVE the real ledger position. The ledger
      // (create_ledger_transaction) enforces the strict net, so gate on the
      // ledger-backed figure to avoid LEDGER_FAILED on submit.
      const { data: legs } = await (supabase.from('general_ledger') as any)
        .select('direction, amount, wallet_bucket')
        .eq('user_id', user!.id)
        .eq('ledger_scope', 'wallet')
        .in('wallet_bucket', ['withdrawable', 'float'])
        .limit(10000);
      let ledgerW = 0;
      let ledgerF = 0;
      for (const l of (legs ?? []) as any[]) {
        const signed = (l.direction === 'cash_in' ? 1 : -1) * Number(l.amount ?? 0);
        if (l.wallet_bucket === 'withdrawable') ledgerW += signed;
        else if (l.wallet_bucket === 'float') ledgerF += signed;
      }
      return {
        withdrawable: Number(data?.withdrawable_balance ?? 0),
        float: Number(data?.float_balance ?? 0),
        // Spendable = min(cache, ledger net), never below 0.
        withdrawableSpendable: Math.max(0, Math.min(Number(data?.withdrawable_balance ?? 0), ledgerW)),
        floatSpendable: Math.max(0, Math.min(Number(data?.float_balance ?? 0), ledgerF)),
      };
    },
    staleTime: 5_000,
  });

  const isW2F = direction === 'withdrawable_to_float';
  const fromLabel = isW2F ? 'Personal (Withdrawable)' : 'Operational Float';
  const toLabel = isW2F ? 'Operational Float' : 'Personal (Withdrawable)';
  // Gate on the strict ledger-backed spendable, not the (possibly drifted) cache.
  const fromBalance = buckets ? (isW2F ? buckets.withdrawableSpendable : buckets.floatSpendable) : 0;

  const numericAmount = Number(amount);
  const amountValid = Number.isFinite(numericAmount) && numericAmount > 0;
  const hasFunds = amountValid && fromBalance >= numericAmount;
  const reasonValid = reason.trim().length >= 10;
  const canSubmit = !!user && amountValid && hasFunds && reasonValid && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit || !user) return;
    setSubmitting(true);
    const { error } = await invokeEdgeFunction('ops-bucket-transfer', {
      body: {
        target_user_id: user.id,
        amount: numericAmount,
        direction,
        reason: reason.trim(),
      },
      errorTitle: 'Bucket transfer failed',
    });
    setSubmitting(false);
    if (error) return;

    toast.success('Funds moved', {
      description: `${formatUGX(numericAmount)} moved from ${fromLabel} to ${toLabel} for ${user.full_name}.`,
    });
    invalidateOpsWallet(qc, user.id);
    await refetch();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowLeftRight className="h-4 w-4 text-primary" /> Move Between Buckets
          </DialogTitle>
          <DialogDescription>
            Correct an accidental routing by moving funds between a user's
            Personal (Withdrawable) and Operational Float buckets.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>User</Label>
            <UserSearchPicker
              label=""
              selectedUser={user as any}
              onSelect={(u) => setUser(u ? { id: u.id, full_name: u.full_name } : null)}
              placeholder="Search by name, phone, or email…"
            />
          </div>

          {user && (
            <div className="rounded-lg border bg-muted/30 p-3 grid grid-cols-2 gap-3 text-xs">
              <div>
                <p className="text-muted-foreground flex items-center gap-1"><Banknote className="h-3 w-3" /> Personal</p>
                <p className="font-mono font-semibold text-sm">
                  {bucketsLoading ? '…' : formatUGX(buckets?.withdrawable ?? 0)}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground flex items-center gap-1"><Wallet className="h-3 w-3" /> Float</p>
                <p className="font-mono font-semibold text-sm">
                  {bucketsLoading ? '…' : formatUGX(buckets?.float ?? 0)}
                </p>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label>Direction</Label>
            <div className="flex items-center gap-2 rounded-lg border bg-card p-2">
              <div className="flex-1 text-center text-sm font-medium truncate">{fromLabel}</div>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="shrink-0 h-8 w-8"
                onClick={() =>
                  setDirection((d) =>
                    d === 'withdrawable_to_float' ? 'float_to_withdrawable' : 'withdrawable_to_float',
                  )
                }
                title="Swap direction"
              >
                <ArrowRight className="h-4 w-4" />
              </Button>
              <div className="flex-1 text-center text-sm font-medium truncate">{toLabel}</div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Tap the arrow to flip the direction.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="bt-amount">Amount (UGX)</Label>
            <Input
              id="bt-amount"
              type="number"
              inputMode="numeric"
              min={1}
              placeholder="e.g. 50000"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={submitting}
            />
            {amountValid && user && !hasFunds && (
              <p className="text-xs text-destructive">
                Insufficient {fromLabel} balance ({formatUGX(fromBalance)}).
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="bt-reason">Reason (≥ 10 characters, logged for audit)</Label>
            <Textarea
              id="bt-reason"
              rows={2}
              placeholder="e.g. User deposited to personal by mistake; moving to float."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={submitting}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Move {amountValid ? formatUGX(numericAmount) : 'funds'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
/**
 * Button launcher for the Recent Emails toolbar. Keeps state local so the
 * panel only needs to drop the component into its action row.
 */
export function BucketTransferLauncher() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="gap-2"
        onClick={() => setOpen(true)}
        title="Move funds between a user's Personal and Float buckets"
      >
        <ArrowLeftRight className="h-4 w-4" />
        Move Between Buckets
      </Button>
      <BucketTransferDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
