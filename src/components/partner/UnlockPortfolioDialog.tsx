import { useEffect, useState } from 'react';
import { Loader2, LockOpen } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { LockablePortfolio } from '@/components/partner/LockPortfolioDialog';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  portfolio: LockablePortfolio | null;
  onSuccess?: () => void;
}

/** Unlocks a locked portfolio so it becomes active again. Server enforces roles, reason and audit. */
export function UnlockPortfolioDialog({ open, onOpenChange, portfolio, onSuccess }: Props) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (open) setReason(''); }, [open, portfolio?.id]);

  const reasonValid = reason.trim().length >= 10;

  const handleUnlock = async () => {
    if (!portfolio || !reasonValid || saving) return;
    setSaving(true);
    try {
      const { data, error } = await (supabase as any).rpc('unlock_portfolio', {
        p_portfolio_id: portfolio.id,
        p_reason: reason.trim(),
      });
      if (error) throw error;
      const next = (data as { next_roi_date?: string } | null)?.next_roi_date;
      toast.success(`Portfolio ${portfolio.portfolio_code} unlocked`, {
        description: next
          ? `It is active again. Returns resume from ${new Date(next + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}.`
          : 'It is active again.',
      });
      onOpenChange(false);
      onSuccess?.();
    } catch (err: any) {
      toast.error('Unlock failed', { description: err?.message || 'Please try again.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <LockOpen className="h-4 w-4 text-success" />
            Unlock Portfolio {portfolio?.portfolio_code}
          </DialogTitle>
          <DialogDescription className="text-xs">
            The portfolio becomes active and starts earning Returns again from the next payout day.
            No Returns are paid for the time it was locked.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Principal</p>
            <p className="text-lg font-bold tabular-nums">{formatUGX(Math.round(Number(portfolio?.investment_amount) || 0))}</p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold">Reason <span className="text-destructive">*</span></Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this portfolio being unlocked? (min 10 characters)"
              className="min-h-[70px] text-sm"
              maxLength={500}
            />
            <p className="text-[10px] text-muted-foreground">{reason.trim().length}/500 characters</p>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button size="sm" className="gap-1.5" onClick={handleUnlock} disabled={saving || !reasonValid}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LockOpen className="h-3.5 w-3.5" />}
            Unlock portfolio
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
