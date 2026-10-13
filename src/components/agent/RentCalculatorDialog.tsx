import { useMemo, useState } from 'react';
import { Calculator } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { calculateRentRepayment } from '@/lib/rentCalculations';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';

const DURATIONS = [30, 60, 90] as const;

export default function RentCalculatorDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [raw, setRaw] = useState('');
  const [days, setDays] = useState<(typeof DURATIONS)[number]>(30);
  const amount = parseInt(raw.replace(/\D/g, ''), 10) || 0;
  const calc = useMemo(() => (amount > 0 ? calculateRentRepayment(amount, days) : null), [amount, days]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-md max-h-[90dvh] overflow-y-auto rounded-2xl p-5 sm:p-6">
        <DialogHeader className="text-left">
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary"><Calculator className="h-4 w-4" /></span>
            Rent calculator
          </DialogTitle>
          <DialogDescription className="text-xs">See what a tenant repays each day for a Rent Plan.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="calc-rent" className="text-xs">Monthly rent (UGX)</Label>
            <Input id="calc-rent" inputMode="numeric" placeholder="e.g. 300,000" value={amount ? amount.toLocaleString('en-US') : ''} onChange={e => setRaw(e.target.value)} className="h-11 text-base" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Repayment period</Label>
            <div className="grid grid-cols-3 gap-2">
              {DURATIONS.map(d => (
                <Button key={d} type="button" variant={d === days ? 'default' : 'outline'} onClick={() => setDays(d)} className="h-10 text-xs">{d} days</Button>
              ))}
            </div>
          </div>

          <div className={cn('rounded-xl border border-border bg-muted/40 p-4', !calc && 'opacity-60')}>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Daily repayment</p>
            <p className="text-2xl font-bold text-primary">{calc ? formatUGX(calc.dailyRepayment) : formatUGX(0)}</p>
            <dl className="mt-3 space-y-1.5 text-xs">
              <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Rent</dt><dd>{formatUGX(calc?.rentAmount ?? 0)}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Access fee</dt><dd>{formatUGX(calc?.accessFee ?? 0)}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Request fee</dt><dd>{formatUGX(calc?.requestFee ?? 0)}</dd></div>
              <div className="flex justify-between gap-3 border-t border-border pt-1.5 font-semibold"><dt>Total to repay</dt><dd>{formatUGX(calc?.totalRepayment ?? 0)}</dd></div>
            </dl>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
