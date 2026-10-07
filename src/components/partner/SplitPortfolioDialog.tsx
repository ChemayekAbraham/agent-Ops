import { useEffect, useState } from 'react';
import { Loader2, Scissors } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

export interface SplittablePortfolio {
  id: string;
  portfolio_code: string;
  investment_amount: number;
  created_at: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  portfolio: SplittablePortfolio | null;
  onSuccess?: () => void;
}

/**
 * Splits an active portfolio's principal into a new active portfolio with the same
 * contribution date and terms. No money moves and no email or notification is sent.
 */
export function SplitPortfolioDialog({ open, onOpenChange, portfolio, onSuccess }: Props) {
  const [amountInput, setAmountInput] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const principal = Math.round(Number(portfolio?.investment_amount) || 0);

  useEffect(() => {
    if (open) { setAmountInput(''); setReason(''); }
  }, [open, portfolio?.id]);

  const splitAmount = Math.round(Number(amountInput.replace(/[^0-9.]/g, '')) || 0);
  const remainder = principal - splitAmount;
  const amountValid = splitAmount > 0 && remainder >= 1;
  const reasonValid = reason.trim().length >= 10;

  const handleSplit = async () => {
    if (!portfolio || !amountValid || !reasonValid || saving) return;
    setSaving(true);
    try {
      const { data, error } = await supabase.rpc('split_portfolio_principal', {
        p_portfolio_id: portfolio.id,
        p_split_amount: splitAmount,
        p_reason: reason.trim(),
      });
      if (error) throw error;
      const res = (data || {}) as { new_portfolio_code?: string; split_amount?: number; remaining_amount?: number };
      toast.success(`Created ${res.new_portfolio_code} with ${formatUGX(Number(res.split_amount) || 0)}`, {
        description: `${formatUGX(Number(res.remaining_amount) || 0)} stays on ${portfolio.portfolio_code}.`,
      });
      onOpenChange(false);
      onSuccess?.();
    } catch (err: any) {
      toast.error('Split failed', { description: err?.message || 'Please try again.' });
    } finally {
      setSaving(false);
    }
  };

  const contribution = portfolio?.created_at
    ? new Date(portfolio.created_at).toLocaleDateString('en-UG', { day: 'numeric', month: 'short', year: 'numeric' })
    : '—';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Scissors className="h-4 w-4 text-primary" />
            Split Portfolio {portfolio?.portfolio_code}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Moves part of the principal into a new active portfolio with the same contribution
            date and terms. No money moves and the partner is not notified.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Current principal</p>
              <p className="text-base font-bold tabular-nums">{formatUGX(principal)}</p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Contribution date</p>
              <p className="text-base font-bold">{contribution}</p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-semibold">Amount for the new portfolio <span className="text-destructive">*</span></Label>
            <Input
              inputMode="numeric"
              value={amountInput}
              onChange={(e) => setAmountInput(e.target.value)}
              placeholder={`Less than ${principal.toLocaleString()}`}
              className="h-10 text-sm tabular-nums"
            />
            <div className="flex flex-wrap gap-1.5 pt-1">
              {[25, 50, 75].map((pct) => (
                <Button key={pct} type="button" variant="outline" size="sm" className="h-7 text-[10px]"
                  onClick={() => setAmountInput(String(Math.round((principal * pct) / 100)))}>
                  {pct}%
                </Button>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">New portfolio</span>
              <span className="font-bold tabular-nums">{formatUGX(Math.max(0, splitAmount))}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Stays on {portfolio?.portfolio_code}</span>
              <span className="font-bold tabular-nums">{formatUGX(Math.max(0, remainder))}</span>
            </div>
            <div className="flex items-center justify-between text-[10px] pt-1 border-t border-primary/20">
              <span className="text-muted-foreground">Total (equals principal)</span>
              <span className={`font-semibold tabular-nums ${amountValid ? 'text-success' : 'text-destructive'}`}>{formatUGX(principal)}</span>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-semibold">Reason <span className="text-destructive">*</span></Label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this portfolio being split? (min 10 characters)"
              className="min-h-[70px] text-sm" maxLength={500} />
            <p className="text-[10px] text-muted-foreground">{reason.trim().length}/500 characters</p>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button size="sm" className="gap-1.5" onClick={handleSplit} disabled={saving || !amountValid || !reasonValid}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Scissors className="h-3.5 w-3.5" />}
            Split {formatUGX(Math.max(0, splitAmount))}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
