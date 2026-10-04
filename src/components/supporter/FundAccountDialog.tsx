import { useRef, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatUGX } from '@/lib/rentCalculations';
import { Wallet, Sparkles, AlertCircle, Plus, CheckCircle2, CalendarClock } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const QUICK_AMOUNTS = [50_000, 100_000, 200_000, 500_000, 1_000_000];

interface FundAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountName: string;
  accountId: string;
  walletBalance: number;
  currentBalance?: number;
  onFund: (accountId: string, amount: number) => Promise<void>;
  onDeposit?: () => void;
}

export function FundAccountDialog({ 
  open, 
  onOpenChange, 
  accountName, 
  accountId, 
  walletBalance,
  currentBalance = 0,
  onFund,
  onDeposit,
}: FundAccountDialogProps) {
  const [amount, setAmount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [confirmedAmount, setConfirmedAmount] = useState<number | null>(null);
  // Hard, synchronous lock — blocks a second tap before React paints `disabled`,
  // preventing race-condition double top-ups / wallet double-deduction.
  const submitLock = useRef(false);

  const handleFund = async () => {
    if (amount <= 0 || amount > walletBalance) return;
    if (submitLock.current || loading) return; // guard against rapid re-taps

    submitLock.current = true;
    setLoading(true);
    try {
      const submitted = amount;
      await onFund(accountId, submitted);
      // Success — show the "applies on next payout" banner instead of closing.
      setConfirmedAmount(submitted);
      setAmount(0);
    } finally {
      setLoading(false);
      submitLock.current = false;
    }
  };

  const isValid = amount > 0 && amount <= walletBalance;
  const remainingBalance = walletBalance - amount;
  const newPortfolioBalance = currentBalance + amount;
  const monthlyReturn = newPortfolioBalance * 0.15;
  const noFunds = walletBalance <= 0;

  const handleClose = (v: boolean) => {
    if (!v) {
      setAmount(0);
      setConfirmedAmount(null);
    }
    onOpenChange(v);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wallet className="h-5 w-5 text-primary" />
            Top Up Investment
          </DialogTitle>
        </DialogHeader>

        {confirmedAmount !== null ? (
          /* ---- Success state: transfer request submitted, pending Partner Ops ---- */
          <div className="space-y-4 py-4">
            <div className="flex flex-col items-center text-center gap-2">
              <div className="h-14 w-14 rounded-full bg-success/15 flex items-center justify-center">
                <CheckCircle2 className="h-7 w-7 text-success" />
              </div>
              <p className="text-lg font-black">Request for {formatUGX(confirmedAmount)} submitted</p>
              <p className="text-sm text-muted-foreground">
                Your transfer to <span className="font-semibold">{accountName}</span> is now awaiting Partner Ops approval.
              </p>
            </div>

            <div className="flex items-start gap-2 p-3 rounded-xl bg-primary/10 border border-primary/20">
              <CalendarClock className="h-4 w-4 text-primary shrink-0 mt-0.5" />
              <p className="text-xs text-foreground">
                No funds have left your wallet yet. The money stays in your wallet and is only
                moved <span className="font-bold">once Partner Ops approves</span> this transfer.
              </p>
            </div>

            <Button className="w-full" onClick={() => handleClose(false)}>
              Done
            </Button>
          </div>
        ) : (
        <div className="space-y-3 py-2">
          {/* Account Info */}
          <div className="p-3 rounded-xl bg-primary/10 border border-primary/20">
            <p className="text-xs text-muted-foreground">Funding account</p>
            <p className="font-bold text-lg">{accountName}</p>
          </div>

          {/* Wallet Balance */}
          <div className="p-3 rounded-xl bg-muted/50">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Wallet className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Wallet Balance</span>
              </div>
              <span className="font-bold">{formatUGX(walletBalance)}</span>
            </div>
            {amount > 0 && amount <= walletBalance && (
              <div className="flex items-center justify-between mt-1.5 pt-1.5 border-t border-border/50">
                <span className="text-xs text-muted-foreground">After top-up</span>
                <span className="text-xs font-bold text-muted-foreground">{formatUGX(remainingBalance)}</span>
              </div>
            )}
          </div>

          {/* No funds state */}
          {noFunds ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 p-3 rounded-xl bg-warning/10 border border-warning/20 text-warning text-sm">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>No funds in your wallet. Deposit money first to top up your investment.</span>
              </div>
              {onDeposit && (
                <Button onClick={() => { onOpenChange(false); onDeposit(); }} className="w-full gap-2">
                  <Plus className="h-4 w-4" />
                  Deposit to Wallet
                </Button>
              )}
            </div>
          ) : (
            <>
              {/* Amount Input */}
              <div className="space-y-3">
                <Label>Amount to Top Up</Label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground font-medium">
                    UGX
                  </span>
                  <Input
                    type="text"
                    value={amount > 0 ? amount.toLocaleString() : ''}
                    placeholder="Enter amount"
                    onChange={(e) => {
                      const value = parseInt(e.target.value.replace(/,/g, '')) || 0;
                      setAmount(Math.max(0, value));
                    }}
                    className="pl-12 text-lg font-bold h-12 text-center"
                  />
                </div>

                {/* Quick Amount Buttons */}
                <div className="flex flex-wrap gap-2">
                  {QUICK_AMOUNTS.filter(a => a <= walletBalance).map((qa) => (
                    <button
                      key={qa}
                      type="button"
                      onClick={() => setAmount(qa)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${
                        amount === qa
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-muted/50 text-foreground border-border/60 hover:bg-accent/40'
                      }`}
                    >
                      {formatUGX(qa)}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setAmount(walletBalance)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${
                      amount === walletBalance
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-muted/50 text-foreground border-border/60 hover:bg-accent/40'
                    }`}
                  >
                    Max
                  </button>
                </div>
              </div>

              {/* Insufficient Balance Warning */}
              {amount > walletBalance && (
                <div className="flex items-center gap-2 p-3 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive text-sm">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <div>
                    <span>Insufficient wallet balance.</span>
                    {onDeposit && (
                      <button
                        type="button"
                        onClick={() => { onOpenChange(false); onDeposit(); }}
                        className="ml-1 text-primary font-medium hover:underline"
                      >
                        Deposit more
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* ROI Preview */}
              <AnimatePresence mode="wait">
                {isValid && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="p-3 rounded-xl bg-gradient-to-br from-success/10 to-emerald-500/10 border border-success/20 space-y-2">
                      {/* Current → New Portfolio Balance */}
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">Current Portfolio</span>
                        <span className="text-sm font-bold">{formatUGX(currentBalance)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">After Top-up</span>
                        <span className="text-sm font-black text-success">{formatUGX(newPortfolioBalance)}</span>
                      </div>
                      {/* Projected return - small */}
                      <div className="flex items-center justify-between pt-1.5 border-t border-success/15">
                        <span className="text-[10px] text-success/70 flex items-center gap-1">
                          <Sparkles className="h-3 w-3" />
                          Projected return (15%/mo)
                        </span>
                        <span className="text-xs font-bold text-success">{formatUGX(monthlyReturn)}/mo</span>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Approval notice — funds only move after Partner Ops approves */}
              <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20">
                <AlertCircle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                <p className="text-[11px] leading-snug text-foreground">
                  This sends a <span className="font-bold">transfer request to Partner Ops</span>. No money
                  leaves your wallet now — the funds stay in your wallet until the request is approved.
                </p>
              </div>
            </>
          )}
        </div>
        )}

        {confirmedAmount === null && !noFunds && (
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => handleClose(false)} disabled={loading}>
              Cancel
            </Button>
            <Button 
              onClick={handleFund} 
              disabled={!isValid || loading}
              className="gap-2 bg-gradient-to-r from-primary to-violet-500"
            >
              {loading ? (
                'Submitting...'
              ) : (
                <>
                  <Wallet className="h-4 w-4" />
                  Request Transfer {isValid ? formatUGX(amount) : ''}
                </>
              )}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
