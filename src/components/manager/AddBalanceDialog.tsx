import { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { invalidateOpsWallet } from '@/hooks/ops/useOpsDataLayer';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { Loader2, Plus, Minus, Wallet, Landmark, Banknote } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { extractFromErrorObject } from '@/lib/extractEdgeFunctionError';

interface AddBalanceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  userName: string;
  currentBalance: number;
  onSuccess?: () => void;
}

type AdjustmentType = 'credit' | 'debit';
// Which bucket of the user's wallet the money moves in/out of.
// 'withdrawable' = the user's own money (they can cash it out).
// 'float' = company-controlled operational float (e.g. agent rent-collection float).
type WalletBucket = 'withdrawable' | 'float';

export default function AddBalanceDialog({
  open,
  onOpenChange,
  userId,
  userName,
  currentBalance,
  onSuccess
}: AddBalanceDialogProps) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [type, setType] = useState<AdjustmentType>('credit');
  const [bucket, setBucket] = useState<WalletBucket>('withdrawable');
  const [bucketBalances, setBucketBalances] = useState<{ withdrawable: number; float: number }>({ withdrawable: 0, float: 0 });

  // Bucket-specific balances so the debit check and preview reflect the
  // actual bucket being touched, not the wallet's combined total.
  useEffect(() => {
    if (!open) return;
    supabase
      .from('wallets')
      .select('withdrawable_balance, float_balance')
      .eq('user_id', userId)
      .maybeSingle()
      .then(({ data }) => {
        setBucketBalances({
          withdrawable: Number(data?.withdrawable_balance ?? 0),
          float: Number(data?.float_balance ?? 0),
        });
      });
  }, [open, userId]);

  const selectedBucketBalance = bucket === 'float' ? bucketBalances.float : bucketBalances.withdrawable;

  const handleAdjustBalance = async () => {
    const amountNum = parseFloat(amount);

    if (isNaN(amountNum) || amountNum <= 0) {
      toast.error('Please enter a valid amount');
      return;
    }

    if (!reason.trim()) {
      toast.error('A reason is required for every adjustment');
      return;
    }

    if (type === 'debit' && amountNum > selectedBucketBalance) {
      toast.error(`Cannot debit more than the ${bucket} balance (${formatUGX(selectedBucketBalance)})`);
      return;
    }

    setLoading(true);

    try {
      // Direct, immediate credit/debit — no approval queue. Posts straight
      // through the same balanced double-entry ledger + Wallet Routing v2
      // mechanism (recipient_type) the CFO Direct Credit tool uses, so the
      // bucket chosen above actually lands (or leaves from) the money there
      // right away. cfo-direct-credit already enforces its own bucket-aware
      // solvency gate on debits (get_user_available_balance /
      // get_user_float_available_balance), so an insufficient-balance debit
      // is rejected server-side even if the client-side pre-check above
      // somehow drifted from the live balance.
      const { data, error } = await supabase.functions.invoke('cfo-direct-credit', {
        body: {
          target_user_id: userId,
          amount: amountNum,
          reason: reason.trim(),
          operation: type,
          recipient_type: bucket === 'float' ? 'operational_wallet' : 'user',
          // Float credits must use a category in the edge function's
          // FLOAT_ROUTE_CATEGORIES allow-list or it rejects the request.
          wallet_category: bucket === 'float' ? 'agent_float_deposit' : undefined,
          financial_impact: 'neutral',
          category_label: `Manager Wallet ${type === 'credit' ? 'Credit' : 'Debit'} (${bucket === 'float' ? 'Float' : 'Withdrawable'})`,
          manual_credit: true,
        },
      });
      if (error) throw new Error(await extractFromErrorObject(error, `Failed to ${type} wallet`));
      if ((data as any)?.error) throw new Error((data as any).error);

      toast.success(`UGX ${amountNum.toLocaleString()} ${type === 'credit' ? 'credited to' : 'debited from'} ${userName}'s ${bucket} balance`);

      // Ensure every consumer of the shared wallet cache refreshes immediately.
      invalidateOpsWallet(qc, userId);
      setAmount('');
      setReason('');
      setType('credit');
      setBucket('withdrawable');
      onOpenChange(false);
      onSuccess?.();
    } catch (error: any) {
      console.error('Error adjusting balance:', error);
      toast.error(error?.message || 'Failed to adjust balance. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const quickAmounts = [5000, 10000, 50000, 100000];
  const previewBalance = amount && parseFloat(amount) > 0
    ? type === 'credit'
      ? selectedBucketBalance + parseFloat(amount)
      : Math.max(0, selectedBucketBalance - parseFloat(amount))
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wallet className="h-5 w-5 text-primary" />
            Adjust Balance
          </DialogTitle>
          <DialogDescription>
            Credit or debit <strong>{userName}</strong>'s wallet.
            Withdrawable: <strong>{formatUGX(bucketBalances.withdrawable)}</strong> · Float: <strong>{formatUGX(bucketBalances.float)}</strong>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Credit / Debit Toggle */}
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant={type === 'credit' ? 'default' : 'outline'}
              className={`h-14 text-base font-bold gap-2 ${type === 'credit' ? 'bg-success hover:bg-success/90 text-white' : ''}`}
              onClick={() => setType('credit')}
            >
              <Plus className="h-5 w-5" />
              Credit
            </Button>
            <Button
              type="button"
              variant={type === 'debit' ? 'default' : 'outline'}
              className={`h-14 text-base font-bold gap-2 ${type === 'debit' ? 'bg-destructive hover:bg-destructive/90 text-white' : ''}`}
              onClick={() => setType('debit')}
            >
              <Minus className="h-5 w-5" />
              Debit
            </Button>
          </div>

          {/* Bucket Toggle — which pool of the wallet this touches */}
          <div className="space-y-2">
            <Label>Bucket</Label>
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant={bucket === 'withdrawable' ? 'default' : 'outline'}
                className="h-14 text-sm font-semibold gap-2 flex-col"
                onClick={() => setBucket('withdrawable')}
              >
                <Banknote className="h-4 w-4" />
                Withdrawable
                <span className="text-[10px] font-normal opacity-80">User-owned</span>
              </Button>
              <Button
                type="button"
                variant={bucket === 'float' ? 'default' : 'outline'}
                className="h-14 text-sm font-semibold gap-2 flex-col"
                onClick={() => setBucket('float')}
              >
                <Landmark className="h-4 w-4" />
                Float
                <span className="text-[10px] font-normal opacity-80">Operational</span>
              </Button>
            </div>
          </div>

          {/* Amount */}
          <div className="space-y-2">
            <Label htmlFor="amount">Amount (UGX)</Label>
            <Input
              id="amount"
              type="number"
              placeholder="Enter amount"
              value={amount}
              onChange={(e) => {
                const val = e.target.value;
                if (val === '' || (Number(val) >= 0 && !isNaN(Number(val)))) {
                  setAmount(val);
                }
              }}
              min={1}
              className="h-12 text-lg font-semibold"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            {quickAmounts.map((q) => (
              <Button
                key={q}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setAmount(q.toString())}
                className="flex-1 min-w-[70px]"
              >
                {formatUGX(q)}
              </Button>
            ))}
          </div>

          {/* Reason — required */}
          <div className="space-y-2">
            <Label htmlFor="reason">
              Reason <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="reason"
              placeholder="Why are you adjusting this balance? (required)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
            />
          </div>

          {/* Preview */}
          {previewBalance !== null && (
            <div className={`p-3 rounded-lg border ${type === 'credit' ? 'bg-success/10 border-success/30' : 'bg-destructive/10 border-destructive/30'}`}>
              <p className="text-sm text-muted-foreground">New {bucket} balance will be:</p>
              <p className={`text-lg font-bold ${type === 'credit' ? 'text-success' : 'text-destructive'}`}>
                {formatUGX(previewBalance)}
              </p>
              <p className="text-[10px] text-muted-foreground mt-1">
                Applied immediately — no approval step.
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleAdjustBalance}
            disabled={loading || !amount || parseFloat(amount) <= 0 || !reason.trim()}
            className={`gap-2 ${type === 'debit' ? 'bg-destructive hover:bg-destructive/90' : ''}`}
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : type === 'credit' ? (
              <Plus className="h-4 w-4" />
            ) : (
              <Minus className="h-4 w-4" />
            )}
            {type === 'credit' ? 'Credit Account' : 'Debit Account'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
