import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import { useQueryClient } from '@tanstack/react-query';
import { Zap } from 'lucide-react';

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  advance: {
    id: string;
    principal: number;
    outstanding_balance: number;
    cycle_days?: number;
    access_fee?: number;
  };
}

interface Preview {
  installment: number;
  arrears: number;
  paid_today: number;
  due_now: number;
  outstanding: number;
  available: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Pay now. The agent can pay at any time, including after today's deduction was taken. The figures come from the server (the same ones the daily
 * deduction uses). One payment intent = one idempotency key: a double-tap or a retry sends the same key and is not charged twice. The payment is also
 * tied to the "paid today" amount shown here, so if a deduction lands first the server refuses and we show the new figures instead.
 */
export function VoluntaryRepayAdvanceDialog({ open, onOpenChange, advance }: Props) {
  const qc = useQueryClient();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [amountText, setAmountText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Made once per payment intent. Kept across retries; replaced only after a payment is recorded or the figures change.
  const keyRef = useRef<string>(crypto.randomUUID());

  const loadPreview = useCallback(async () => {
    setLoading(true);
    const { data, error } = await invokeEdgeFunction<any>('voluntary-repay-advance', {
      body: { advance_id: advance.id, action: 'preview' },
      silent: true,
    });
    setLoading(false);
    if (error || !data) {
      setPreview(null);
      toast.error('Could not load your advance', { description: error?.message ?? 'Please try again.' });
      return;
    }
    const p: Preview = {
      installment: Number(data.installment) || 0,
      arrears: Number(data.arrears) || 0,
      paid_today: Number(data.paid_today) || 0,
      due_now: Number(data.due_now) || 0,
      outstanding: Number(data.outstanding) || 0,
      available: Number(data.available) || 0,
    };
    setPreview(p);
    const suggested = p.due_now > 0 ? p.due_now : p.installment;
    setAmountText(String(round2(Math.min(suggested, p.outstanding))));
  }, [advance.id]);

  useEffect(() => {
    if (!open) return;
    keyRef.current = crypto.randomUUID();
    void loadPreview();
  }, [open, loadPreview]);

  const amount = round2(Number(amountText) || 0);
  const overOutstanding = preview ? amount > preview.outstanding + 0.005 : false;
  const overBalance = preview ? amount > preview.available + 0.005 : false;
  const invalid = !preview || amount <= 0 || overOutstanding || overBalance;

  const submit = async () => {
    if (!preview || invalid || submitting) return;
    setSubmitting(true);
    const { data, error } = await invokeEdgeFunction<any>('voluntary-repay-advance', {
      body: { advance_id: advance.id, idempotency_key: keyRef.current, amount, expected_paid_today: preview.paid_today },
      silent: true,
    });
    setSubmitting(false);
    if (error || !data) {
      const msg = error?.message ?? 'Please try again.';
      toast.error('Payment not made', { description: `${msg} Nothing was taken unless it shows in your wallet.` });
      // The figures moved under us: show the new ones and start a fresh payment.
      if (/paid today is now|changed/i.test(msg)) {
        keyRef.current = crypto.randomUUID();
        void loadPreview();
      }
      return;
    }
    toast.success(data.duplicate ? 'This payment was already recorded' : 'Advance payment recorded', {
      description: `${formatUGX(data.amount_paid)} paid. Outstanding ${formatUGX(data.closing_balance)}.`,
    });
    keyRef.current = crypto.randomUUID();
    qc.invalidateQueries({ queryKey: ['my-issued-advances'] });
    qc.invalidateQueries({ queryKey: ['agent-balances'] });
    qc.invalidateQueries({ queryKey: ['user-available-balance'] });
    qc.invalidateQueries({ queryKey: ['wallet-view'] });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!submitting) onOpenChange(o); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-primary" /> Pay Now
          </DialogTitle>
          <DialogDescription>
            Pay toward your advance from your withdrawable wallet. What you pay today counts toward today's deduction, so you are not charged for it again.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="rounded-lg bg-muted/40 p-3 text-xs space-y-1">
            <div className="flex justify-between"><span className="text-muted-foreground">Daily installment</span><span className="font-bold tabular-nums">{preview ? formatUGX(preview.installment) : '…'}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Paid today</span><span className="font-bold tabular-nums">{preview ? formatUGX(preview.paid_today) : '…'}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Still due today</span><span className="font-bold tabular-nums">{preview ? formatUGX(preview.due_now) : '…'}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Outstanding</span><span className="font-bold tabular-nums">{preview ? formatUGX(preview.outstanding) : formatUGX(advance.outstanding_balance)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Your wallet (withdrawable)</span><span className="font-bold tabular-nums">{preview ? formatUGX(preview.available) : '…'}</span></div>
          </div>
          <div>
            <Label htmlFor="pay-now-amount" className="text-xs">Amount to pay (UGX)</Label>
            <Input
              id="pay-now-amount"
              type="number"
              inputMode="decimal"
              min={1}
              step="0.01"
              value={amountText}
              disabled={loading || submitting}
              onChange={(e) => setAmountText(e.target.value)}
            />
            {overOutstanding && <p className="mt-1 text-[11px] text-destructive">That is more than you owe.</p>}
            {!overOutstanding && overBalance && <p className="mt-1 text-[11px] text-destructive">That is more than your withdrawable balance.</p>}
            {preview && preview.due_now <= 0 && !overOutstanding && !overBalance && (
              <p className="mt-1 text-[11px] text-muted-foreground">Today's deduction is already covered. You can still pay more toward the advance.</p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button onClick={submit} disabled={loading || submitting || invalid}>
            {submitting ? 'Processing…' : `Pay ${formatUGX(amount)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
