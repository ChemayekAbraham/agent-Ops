import { useState } from 'react';
import { HandCoins } from 'lucide-react';
import { useWallet } from '@/hooks/useWallet';
import { useAuth } from '@/hooks/useAuth';
import { useCurrency } from '@/hooks/useCurrency';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { formatUGX } from '@/lib/rentCalculations';
import { extractEdgeFunctionError } from '@/lib/extractEdgeFunctionError';
import type { OpportunitySummary } from '@/hooks/useOpportunitySummary';

interface FundRentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  summary: OpportunitySummary;
}

export function FundRentDialog({ open, onOpenChange, summary }: FundRentDialogProps) {
  const { wallet } = useWallet();
  const { user } = useAuth();
  const { formatAmount } = useCurrency();
  const { toast } = useToast();

  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [successInfo, setSuccessInfo] = useState<{
    monthlyReward: number;
    firstPayoutDate: string;
    referenceId: string;
  } | null>(null);

  const walletBalance = wallet?.balance ?? 0;
  const amountNum = Number(amount) || 0;
  const exceedsBalance = amountNum > walletBalance;
  const exceedsRequested = amountNum > summary.total_rent_requested;
  const isValid = amountNum > 0 && !exceedsBalance && !exceedsRequested;

  const handleFundSubmit = async () => {
    if (!user || !isValid) return;

    setSubmitting(true);
    try {
      const response = await supabase.functions.invoke('fund-rent-pool', {
        body: { amount: amountNum, summary_id: summary.id },
      });

      if (response.error || response.data?.error) {
        const msg = await extractEdgeFunctionError(response);
        throw new Error(msg);
      }

      const data = response.data;

      setSuccessInfo({
        monthlyReward: data.monthly_reward,
        firstPayoutDate: data.first_payout_date,
        referenceId: data.reference_id,
      });

      // Notify dashboard to refresh contribution totals
      window.dispatchEvent(new CustomEvent('supporter-contribution-changed'));

      toast({
        title: 'Submitted for approval',
        description: `${formatUGX(amountNum)} committed. Partner Operations will review it — your money stays in your wallet until the portfolio is approved.`,
      });
    } catch (err: any) {
      console.error('[FundRentDialog] Fund error:', err);
      toast({
        title: 'Transfer failed',
        description: err?.message || 'Please try again later.',
        variant: 'destructive',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = (val: boolean) => {
    if (!val) {
      setAmount('');
      setSuccessInfo(null);
    }
    onOpenChange(val);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-sm" stable>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HandCoins className="h-5 w-5 text-primary" />
            Fund Rent Requests
          </DialogTitle>
        </DialogHeader>

        {successInfo ? (
          <div className="space-y-4">
            <div className="px-4 py-4 rounded-xl bg-green-500/10 border border-green-500/30 space-y-2">
              <p className="text-sm font-bold text-green-700 dark:text-green-400">✅ Investment Confirmed!</p>
              <p className="text-xs text-muted-foreground">
                You will receive <span className="font-black text-foreground">15% monthly</span> ({formatUGX(successInfo.monthlyReward)}) 
                every <span className="font-bold">30 days</span> for <span className="font-bold">12 months</span>.
              </p>
              <p className="text-xs text-muted-foreground">
                📅 First payout: <span className="font-bold text-foreground">{successInfo.firstPayoutDate}</span>
              </p>
              <p className="text-xs text-muted-foreground">
                🔖 Ref: <span className="font-mono font-bold">{successInfo.referenceId}</span>
              </p>
            </div>

            <div className="px-4 py-3 rounded-xl bg-amber-500/10 border border-amber-500/30">
              <p className="text-xs text-amber-700 dark:text-amber-400 font-semibold">
                📋 Investment Withdrawal: To withdraw your investment, submit a 90-day advance notice request from your dashboard.
              </p>
            </div>

            <Button onClick={() => handleClose(false)} className="w-full rounded-xl font-bold h-11">
              Done
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Wallet balance */}
            <div className="px-4 py-3 rounded-xl bg-muted/50">
              <p className="text-xs text-muted-foreground font-semibold">Your Wallet Balance</p>
              <p className="text-xl font-black text-foreground">{formatUGX(walletBalance)}</p>
            </div>

            {/* Amount input */}
            <div className="space-y-1.5">
              <label className="text-sm font-bold text-foreground">Amount to Fund (UGX)</label>
              <Input
                type="number"
                inputMode="numeric"
                placeholder="e.g. 500000"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                className="text-lg font-bold h-12"
              />
              {exceedsBalance && amountNum > 0 && (
                <p className="text-xs text-destructive font-semibold">
                  Insufficient balance. You need {formatUGX(amountNum - walletBalance)} more.
                </p>
              )}
              {exceedsRequested && amountNum > 0 && (
                <p className="text-xs text-destructive font-semibold">
                  Amount exceeds total rent requested ({formatAmount(summary.total_rent_requested)}).
                </p>
              )}
            </div>

            {/* 15% monthly reward info */}
            {amountNum > 0 && (
              <div className="px-4 py-3 rounded-xl bg-primary/10 border border-primary/20 space-y-1">
                <p className="text-xs font-bold text-primary">💰 15% Monthly Reward</p>
                <p className="text-xs text-muted-foreground">
                  ⏳ Funds work for at least <span className="font-bold">30 days</span> before the first payout.
                </p>
                <p className="text-xs text-muted-foreground">
                  You'll receive <span className="font-black text-foreground">{formatUGX(Math.round(amountNum * 0.15))}</span> every{' '}
                  <span className="font-bold">30 days</span> for 12 months.
                </p>
                <p className="text-xs text-muted-foreground">
                  Total earnings: <span className="font-black text-foreground">{formatUGX(Math.round(amountNum * 0.15 * 12))}</span>
                </p>
              </div>
            )}

            {/* Deposit prompt or submit */}
            {exceedsBalance && amountNum > 0 ? (
              <Button
                variant="outline"
                className="w-full gap-2 rounded-xl font-bold border-2 border-amber-500/50 text-amber-600 hover:bg-amber-500/10 h-11"
                onClick={() => {
                  handleClose(false);
                  window.dispatchEvent(new CustomEvent('open-deposit'));
                }}
              >
                💳 Deposit to Wallet First
              </Button>
            ) : (
              <Button
                onClick={handleFundSubmit}
                disabled={!isValid || submitting}
                className="w-full gap-2 rounded-xl font-bold h-11"
              >
                {submitting ? 'Submitting…' : `Fund ${amountNum > 0 ? formatUGX(amountNum) : ''}`}
              </Button>
            )}

            <p className="text-[10px] text-muted-foreground text-center">
              Funds are deducted instantly from your wallet
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
