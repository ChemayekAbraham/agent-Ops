import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { BadgePercent, Home } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { hapticTap } from '@/lib/haptics';
import { useToast } from '@/hooks/use-toast';

const STORAGE_KEY = 'welile.tenant.monthlyRent';

export function getStoredMonthlyRent(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

interface AddMonthlyRentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Same percentage discount the tenant earned on bread (e.g. 0.05 for 5%). */
  discountPct: number;
  onSaved?: (rent: number) => void;
}

export function AddMonthlyRentDialog({ open, onOpenChange, discountPct, onSaved }: AddMonthlyRentDialogProps) {
  const { toast } = useToast();
  const [value, setValue] = useState<string>('');

  useEffect(() => {
    if (open) {
      const stored = getStoredMonthlyRent();
      setValue(stored ? String(stored) : '');
    }
  }, [open]);

  const rent = Number(value.replace(/[^\d]/g, '')) || 0;
  const pct = Math.max(0, Math.min(0.5, discountPct));
  const saving = Math.round(rent * pct);
  const newRent = Math.max(0, rent - saving);

  const handleSave = () => {
    if (rent <= 0) {
      toast({ title: 'Enter a valid rent amount', variant: 'destructive' });
      return;
    }
    hapticTap();
    try {
      window.localStorage.setItem(STORAGE_KEY, String(rent));
    } catch {
      /* ignore */
    }
    toast({
      title: 'Monthly rent saved',
      description: pct > 0
        ? `${Math.round(pct * 100)}% off — saves ${formatUGX(saving)} this month.`
        : `Saved ${formatUGX(rent)}. Earn bread credit to unlock a discount.`,
    });
    onSaved?.(rent);
    onOpenChange(false);
  };

  const handleClear = () => {
    try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    setValue('');
    toast({ title: 'Monthly rent cleared' });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Home className="h-5 w-5 text-emerald-600" />
            Add your monthly rent
          </DialogTitle>
          <DialogDescription>
            We'll apply your {Math.round(pct * 100)}% bread discount to it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <label className="block">
            <span className="text-xs font-medium text-muted-foreground">Monthly rent (UGX)</span>
            <Input
              inputMode="numeric"
              pattern="[0-9]*"
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value.replace(/[^\d]/g, ''))}
              placeholder="e.g. 450000"
              className="mt-1 text-lg font-semibold"
            />
          </label>

          {rent > 0 && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/30 dark:border-emerald-900 p-3 space-y-1">
              <p className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300 flex items-center gap-1">
                <BadgePercent className="h-3.5 w-3.5" /> {Math.round(pct * 100)}% off your rent
              </p>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs text-muted-foreground">New monthly rent</span>
                <span className="text-base font-extrabold text-foreground">{formatUGX(newRent)}</span>
              </div>
              {pct > 0 && (
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs text-muted-foreground">You save</span>
                  <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">{formatUGX(saving)} / month</span>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="flex gap-2 sm:justify-between">
          {getStoredMonthlyRent() !== null ? (
            <Button type="button" variant="ghost" size="sm" onClick={handleClear}>Clear</Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="button" size="sm" onClick={handleSave} disabled={rent <= 0}>Save rent</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}