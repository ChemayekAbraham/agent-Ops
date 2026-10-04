import { useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { Send, Loader2, CheckCircle2, TrendingUp, Shield, Calendar, Zap } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { hapticTap } from '@/lib/haptics';

interface CreditAccessDrawSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  creditLimit: number;
}

const MONTHLY_RATE = 0.33;

function calcAccessFee(amount: number, months: number): number {
  return Math.round(amount * (Math.pow(1 + MONTHLY_RATE, months) - 1));
}

function formatUGX(amount: number): string {
  return `UGX ${Math.round(amount).toLocaleString()}`;
}

export function CreditAccessDrawSheet({ open, onOpenChange, userId, creditLimit }: CreditAccessDrawSheetProps) {
  const [durationMonths, setDurationMonths] = useState(1);
  const [amount, setAmount] = useState(creditLimit);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const { toast } = useToast();

  const accessFee = calcAccessFee(amount, durationMonths);
  const totalPayable = amount + accessFee;
  const durationDays = durationMonths * 30;
  const dailyCharge = Math.ceil(totalPayable / durationDays);
  const accessFeePercent = ((accessFee / amount) * 100).toFixed(1);

  const handleSubmit = async () => {
    if (submitting || submitted) return;
    hapticTap();
    setSubmitting(true);

    try {
      const { data: session } = await supabase.auth.getSession();
      if (!session?.session?.access_token) throw new Error('Please login first');

      const res = await supabase.functions.invoke('process-credit-draw', {
        body: { amount, duration_months: durationMonths },
      });

      if (res.error) throw new Error(res.error.message || 'Failed to process credit draw');
      if (res.data?.error) throw new Error(res.data.error);

      setSubmitted(true);
      toast({
        title: '⏳ Submitted for Approval',
        description: `Your UGX ${amount.toLocaleString()} request was sent to the CFO. You'll be notified once it's approved and credited.`,
      });
    } catch (err: any) {
      toast({ title: 'Failed', description: err.message, variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    if (!submitting) {
      onOpenChange(false);
      setTimeout(() => {
        setSubmitted(false);
        setDurationMonths(1);
      }, 300);
    }
  };

  const amountOptions = [0.25, 0.5, 0.75, 1].map(pct => ({
    label: `${Math.round(pct * 100)}%`,
    value: Math.round(creditLimit * pct),
  }));

  return (
    <Sheet open={open} onOpenChange={handleClose}>
      <SheetContent side="bottom" className="h-[85vh] rounded-t-3xl overflow-y-auto pb-8">
        <SheetHeader className="text-left pb-2">
          <SheetTitle className="text-lg font-bold flex items-center gap-2">
            <Zap className="h-5 w-5 text-warning" />
            {submitted ? '⏳ Submitted for Approval' : 'Access Credit'}
          </SheetTitle>
        </SheetHeader>

        {submitted ? (
          <div className="text-center py-8 space-y-3">
            <CheckCircle2 className="h-16 w-16 text-success mx-auto" />
            <p className="font-bold text-lg">Request Sent to CFO</p>
            <p className="text-sm text-muted-foreground">
              Your request for <strong>{formatUGX(amount)}</strong> is awaiting CFO approval.
              Once approved, it will be credited to your wallet.
            </p>
            <div className="p-3 rounded-xl bg-warning/10 border border-warning/20">
              <p className="text-xs font-bold text-warning">Daily Charge (if approved): {formatUGX(dailyCharge)}</p>
              <p className="text-[10px] text-muted-foreground">Auto-deducted from your wallet every day for {durationDays} days after approval</p>
            </div>
            <Button onClick={handleClose} className="rounded-xl mt-4">Done</Button>
          </div>
        ) : (
          <div className="space-y-4 mt-2">
            {/* Amount Selection */}
            <div className="p-4 rounded-2xl bg-primary/5 border border-primary/20 text-center space-y-3">
              <p className="text-xs text-muted-foreground">Access Amount</p>
              <p className="text-3xl font-black text-primary">{formatUGX(amount)}</p>
              <div className="flex gap-2 justify-center">
                {amountOptions.map(opt => (
                  <button
                    key={opt.label}
                    onClick={() => { hapticTap(); setAmount(opt.value); }}
                    className={`px-3 py-1.5 rounded-full text-xs font-bold transition-colors ${
                      amount === opt.value
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Duration */}
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="font-medium flex items-center gap-1"><Calendar className="h-3.5 w-3.5" /> Repayment Period</span>
                <Badge variant="secondary" className="font-bold">{durationMonths} month{durationMonths > 1 ? 's' : ''} ({durationDays} days)</Badge>
              </div>
              <Slider
                value={[durationMonths]}
                onValueChange={([v]) => setDurationMonths(v)}
                min={1}
                max={12}
                step={1}
                className="py-2"
              />
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>1 month</span>
                <span>12 months max</span>
              </div>
            </div>

            {/* Daily Charge Highlight */}
            <div className="p-4 rounded-2xl bg-warning/10 border-2 border-warning/30 text-center">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Your Daily Charge</p>
              <p className="text-2xl font-black text-warning">{formatUGX(dailyCharge)}</p>
              <p className="text-[10px] text-muted-foreground mt-1">Auto-deducted from wallet daily for {durationDays} days</p>
            </div>

            {/* Breakdown */}
            <div className="space-y-2 p-3 rounded-xl bg-muted/50 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground text-xs">Credit Amount</span>
                <span className="font-bold text-xs">{formatUGX(amount)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground text-xs">Access Fee (33%/mo × {durationMonths}mo = {accessFeePercent}%)</span>
                <span className="font-bold text-xs text-warning">+ {formatUGX(accessFee)}</span>
              </div>
              <Separator />
              <div className="flex justify-between">
                <span className="font-bold text-xs">Total Repayment</span>
                <span className="font-black text-sm">{formatUGX(totalPayable)}</span>
              </div>
            </div>

            {/* Compounding Warning */}
            <div className="p-3 rounded-xl bg-destructive/5 border border-destructive/20">
              <p className="text-[11px] text-muted-foreground">
                <Shield className="h-3.5 w-3.5 inline mr-1 text-destructive" />
                <strong>Important:</strong> If daily charges are missed, the outstanding balance compounds at 33% per month.
                Pay on time to avoid extra charges. If your wallet is low, your linked agent's wallet is charged.
              </p>
            </div>

            {/* Benefits */}
            <div className="p-3 rounded-xl bg-success/5 border border-success/20">
              <p className="text-xs font-bold text-success flex items-center gap-1">
                <TrendingUp className="h-3.5 w-3.5" /> Repay on time to grow your limit
              </p>
              <p className="text-[10px] text-muted-foreground mt-1">
                Each successful repayment increases your credit limit toward UGX 30,000,000
              </p>
            </div>

            <Button
              onClick={handleSubmit}
              disabled={submitting || amount <= 0}
              className="w-full gap-2 rounded-xl h-12 font-bold"
            >
              {submitting ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> Processing...</>
              ) : (
                <><Send className="h-4 w-4" /> Submit {formatUGX(amount)} for Approval</>
              )}
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
