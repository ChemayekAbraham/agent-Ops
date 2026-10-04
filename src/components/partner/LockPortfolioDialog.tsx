import { useEffect, useState } from 'react';
import { Loader2, Lock } from 'lucide-react';
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

export interface LockablePortfolio {
  id: string;
  portfolio_code: string;
  investment_amount: number;
  status: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  portfolio: LockablePortfolio | null;
  onSuccess?: () => void;
}

/**
 * Locks a partner portfolio's capital — either the full principal or a split
 * (part locked, remainder stays active and keeps earning).
 *
 * Balancing: a partial lock is executed server-side as a split, so the locked
 * portfolio + the remaining portfolio always add up to the original principal.
 */
export function LockPortfolioDialog({ open, onOpenChange, portfolio, onSuccess }: Props) {
  const [mode, setMode] = useState<'full' | 'split'>('full');
  const [amountInput, setAmountInput] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const principal = Math.round(Number(portfolio?.investment_amount) || 0);

  useEffect(() => {
    if (open) {
      setMode('full');
      setAmountInput('');
      setReason('');
    }
  }, [open, portfolio?.id]);

  const lockAmount = mode === 'full' ? principal : Math.round(Number(amountInput.replace(/[^0-9.]/g, '')) || 0);
  const remainder = principal - lockAmount;
  const amountValid = lockAmount > 0 && lockAmount <= principal;
  const reasonValid = reason.trim().length >= 10;

  const handleLock = async () => {
    if (!portfolio || !amountValid || !reasonValid || saving) return;
    setSaving(true);
    try {
      const { data, error } = await supabase.rpc('lock_portfolio_principal', {
        p_portfolio_id: portfolio.id,
        p_locked_amount: lockAmount,
        p_reason: reason.trim(),
      });
      if (error) throw error;
      const res = (data || {}) as { mode?: string; locked_amount?: number; remaining_amount?: number; locked_portfolio_code?: string };
      toast.success(
        res.mode === 'partial'
          ? `Locked ${formatUGX(Number(res.locked_amount) || 0)} as ${res.locked_portfolio_code}`
          : `Portfolio ${portfolio.portfolio_code} fully locked`,
        {
          description: res.mode === 'partial'
            ? `${formatUGX(Number(res.remaining_amount) || 0)} remains active and keeps earning. Books balanced.`
            : 'Returns accrual has stopped for this portfolio.',
        },
      );
      onOpenChange(false);
      onSuccess?.();
    } catch (err: any) {
      toast.error('Lock failed', { description: err?.message || 'Please try again.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Lock className="h-4 w-4 text-amber-600" />
            Lock Portfolio {portfolio?.portfolio_code}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Locked capital stops earning returns immediately. A split lock keeps the
            remaining capital active — the two always add up to the original principal.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Current principal</p>
            <p className="text-lg font-bold tabular-nums">{formatUGX(principal)}</p>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant={mode === 'full' ? 'default' : 'outline'}
              size="sm"
              className="h-10 text-xs"
              onClick={() => setMode('full')}
            >
              Lock full principal
            </Button>
            <Button
              type="button"
              variant={mode === 'split' ? 'default' : 'outline'}
              size="sm"
              className="h-10 text-xs"
              onClick={() => setMode('split')}
            >
              Split the lock
            </Button>
          </div>

          {mode === 'split' && (
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Amount to lock <span className="text-destructive">*</span></Label>
              <Input
                inputMode="numeric"
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                placeholder={`Max ${principal.toLocaleString()}`}
                className="h-10 text-sm tabular-nums"
              />
              <div className="flex flex-wrap gap-1.5 pt-1">
                {[25, 50, 75].map((pct) => (
                  <Button
                    key={pct}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 text-[10px]"
                    onClick={() => setAmountInput(String(Math.round((principal * pct) / 100)))}
                  >
                    {pct}%
                  </Button>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Locked (stops earning)</span>
              <span className="font-bold tabular-nums">{formatUGX(Math.max(0, lockAmount))}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Remains active</span>
              <span className="font-bold tabular-nums">{formatUGX(Math.max(0, remainder))}</span>
            </div>
            <div className="flex items-center justify-between text-[10px] pt-1 border-t border-amber-500/20">
              <span className="text-muted-foreground">Total (must equal principal)</span>
              <span className={`font-semibold tabular-nums ${amountValid ? 'text-emerald-600' : 'text-destructive'}`}>
                {formatUGX(principal)}
              </span>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-semibold">Reason <span className="text-destructive">*</span></Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this capital being locked? (min 10 characters)"
              className="min-h-[70px] text-sm"
              maxLength={500}
            />
            <p className="text-[10px] text-muted-foreground">{reason.trim().length}/500 characters</p>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="bg-amber-600 hover:bg-amber-700 gap-1.5"
            onClick={handleLock}
            disabled={saving || !amountValid || !reasonValid}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Lock className="h-3.5 w-3.5" />}
            {mode === 'full' ? 'Lock full principal' : `Lock ${formatUGX(Math.max(0, lockAmount))}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}