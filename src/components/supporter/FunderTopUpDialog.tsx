import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Phone, Building2, Banknote, Check, Wallet, TrendingUp } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { hapticTap } from '@/lib/haptics';
import DepositFlow from '@/components/payments/DepositFlow';

type Method = 'mtn' | 'airtel' | 'bank' | 'cash';

const METHODS: { id: Method; label: string; desc: string; icon: typeof Phone }[] = [
  { id: 'mtn', label: 'MTN MoMo', desc: 'Pay via MTN Mobile Money', icon: Phone },
  { id: 'airtel', label: 'Airtel Money', desc: 'Pay via Airtel Money', icon: Phone },
  { id: 'bank', label: 'Bank Transfer', desc: 'Transfer from your bank account', icon: Building2 },
  { id: 'cash', label: 'Cash Deposit', desc: 'Deposit cash with Welile', icon: Banknote },
];

interface FunderTopUpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Number of houses the funder selected. */
  houseCount: number;
  /** Total capital owed to landlords for the selection. */
  capitalRequired: number;
  /** Projected monthly earning across the selection. */
  monthlyEarning: number;
  walletBalance: number;
}

export function FunderTopUpDialog({
  open,
  onOpenChange,
  houseCount,
  capitalRequired,
  monthlyEarning,
  walletBalance,
}: FunderTopUpDialogProps) {
  const shortfall = Math.max(0, capitalRequired - walletBalance);
  const [method, setMethod] = useState<Method | null>(null);
  const [amount, setAmount] = useState('');
  const [showDeposit, setShowDeposit] = useState(false);

  useEffect(() => {
    if (open) {
      setMethod(null);
      setAmount(shortfall > 0 ? String(shortfall) : String(capitalRequired));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const numericAmount = useMemo(() => {
    const n = parseInt(amount.replace(/[^0-9]/g, ''), 10);
    return Number.isFinite(n) ? n : 0;
  }, [amount]);

  const canContinue = !!method && numericAmount >= 500;

  const handleContinue = () => {
    hapticTap();
    if (!canContinue) return;
    onOpenChange(false);
    setShowDeposit(true);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md p-0 overflow-hidden">
          <DialogHeader className="px-5 pt-5 pb-3">
            <DialogTitle className="text-base font-black tracking-tight">Top up your wallet</DialogTitle>
            <DialogDescription className="text-[11px]">
              Add money to pay the landlords of your {houseCount} selected{' '}
              {houseCount === 1 ? 'house' : 'houses'}.
            </DialogDescription>
          </DialogHeader>

          <div className="px-5 pb-5 space-y-4 max-h-[70vh] overflow-y-auto">
            {/* Selection summary */}
            <div className="rounded-2xl border border-primary/20 bg-primary/5 p-3.5 space-y-2">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-muted-foreground">Capital to landlords</span>
                <span className="font-black text-foreground">{formatUGX(capitalRequired)}</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-muted-foreground">Wallet balance</span>
                <span className="font-bold text-foreground">{formatUGX(walletBalance)}</span>
              </div>
              <div className="flex items-center justify-between text-[11px] pt-1.5 border-t border-primary/20">
                <span className="text-muted-foreground">Still needed</span>
                <span className="font-black text-primary">{formatUGX(shortfall)}</span>
              </div>
              <div className="flex items-center gap-1.5 pt-1 text-[10px] text-muted-foreground">
                <TrendingUp className="h-3 w-3 text-success" />
                Projected earning {formatUGX(monthlyEarning)} / month
              </div>
            </div>

            {/* Amount */}
            <div className="space-y-1.5">
              <label className="text-[11px] font-semibold text-muted-foreground">Amount to add (UGX)</label>
              <Input
                type="text"
                inputMode="numeric"
                value={numericAmount > 0 ? numericAmount.toLocaleString() : ''}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0"
                className="h-12 text-lg font-bold"
              />
              {numericAmount > 0 && numericAmount < 500 && (
                <p className="text-[10px] text-destructive font-medium">Minimum top-up is UGX 500</p>
              )}
            </div>

            {/* Payment method */}
            <div className="space-y-2">
              <p className="text-[11px] font-semibold text-muted-foreground">Payment method</p>
              <div className="grid grid-cols-1 gap-2">
                {METHODS.map((m) => {
                  const selected = method === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => { hapticTap(); setMethod(m.id); }}
                      aria-pressed={selected}
                      className={`w-full flex items-center gap-3 rounded-xl border p-3 text-left transition-colors touch-manipulation ${
                        selected
                          ? 'border-primary bg-primary/10 ring-2 ring-primary/25'
                          : 'border-border/60 bg-card hover:bg-muted/50'
                      }`}
                    >
                      <span className="p-2 rounded-lg bg-muted shrink-0">
                        <m.icon className="h-4 w-4 text-foreground" />
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-xs font-bold text-foreground">{m.label}</span>
                        <span className="block text-[10px] text-muted-foreground">{m.desc}</span>
                      </span>
                      {selected && <Check className="h-4 w-4 text-primary shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </div>

            <Button
              onClick={handleContinue}
              disabled={!canContinue}
              className="w-full h-12 rounded-2xl text-sm font-bold gap-2 uppercase tracking-wide"
            >
              <Wallet className="h-4 w-4" />
              Continue to payment
            </Button>
            <p className="text-[9px] text-muted-foreground/80 text-center leading-relaxed">
              Funds stay in your wallet until you fund the selected houses.
            </p>
          </div>
        </DialogContent>
      </Dialog>

      <DepositFlow
        open={showDeposit}
        onOpenChange={setShowDeposit}
        walletBalance={walletBalance}
        allowedPurposes={['partnership_deposit']}
        defaultPurpose="partnership_deposit"
        lockPurpose
        defaultAmount={numericAmount}
        defaultChannel={method === 'mtn' || method === 'airtel' ? 'momo' : method === 'bank' ? 'bank' : 'cash'}
        defaultMomoProvider={method === 'airtel' ? 'airtel' : 'mtn'}
      />
    </>
  );
}

export default FunderTopUpDialog;
