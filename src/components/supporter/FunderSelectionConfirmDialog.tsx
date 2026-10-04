import { useState, useEffect } from 'react';
import { Lock, Wallet, TrendingUp, CalendarDays } from 'lucide-react';
import { format } from 'date-fns';
import { formatUGX } from '@/lib/rentCalculations';
import type { FunderEarnings } from '@/lib/funderEarnings';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';

export interface ConfirmHouse {
  id: string;
  title: string;
  region: string;
  district?: string | null;
  monthly_rent: number;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  houses: ConfirmHouse[];
  totals: FunderEarnings;
  walletBalance: number;
  /** Called when the funder confirms — locks the selection and moves to funding. */
  onConfirm: () => void;
}

export function FunderSelectionConfirmDialog({
  open,
  onOpenChange,
  houses,
  totals,
  walletBalance,
  onConfirm,
}: Props) {
  const [agreed, setAgreed] = useState(false);
  const shortfall = Math.max(0, totals.capital - walletBalance);

  useEffect(() => {
    if (open) setAgreed(false);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-3 space-y-1">
          <DialogTitle className="text-base font-black flex items-center gap-2">
            <Lock className="h-4 w-4 text-primary" />
            Confirm and lock your selection
          </DialogTitle>
          <DialogDescription className="text-xs">
            Review the houses you are supporting. Locking holds this selection while you reserve funds.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[42vh] px-5">
          <ul className="space-y-2 pb-3">
            {houses.map((h) => (
              <li
                key={h.id}
                className="flex items-start justify-between gap-3 rounded-xl border border-border/60 bg-muted/30 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-xs font-bold text-foreground truncate">{h.title}</p>
                  <p className="text-[10px] text-muted-foreground truncate">
                    {[h.district, h.region].filter(Boolean).join(', ')}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-xs font-black text-foreground">{formatUGX(h.monthly_rent)}</p>
                  <p className="text-[9px] text-success font-semibold">
                    +{formatUGX(Math.round(h.monthly_rent * 0.15))}/mo
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </ScrollArea>

        <div className="px-5 py-3 space-y-2.5 border-t border-border/60">
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <CalendarDays className="h-3.5 w-3.5 text-primary" />
            Move-in {format(totals.startDate, 'd MMM yyyy')} · {totals.daysInTerm} days to{' '}
            {format(totals.endDate, 'd MMM yyyy')}
          </div>

          <div className="grid grid-cols-3 gap-2">
            {[
              { label: 'Daily', value: totals.daily },
              { label: 'Weekly', value: totals.weekly },
              { label: '12 months', value: totals.annual },
            ].map((m) => (
              <div key={m.label} className="rounded-xl bg-primary/5 border border-primary/15 py-1.5 text-center">
                <p className="text-[11px] font-black text-primary leading-tight">{formatUGX(m.value)}</p>
                <p className="text-[8px] text-muted-foreground font-medium">{m.label}</p>
              </div>
            ))}
          </div>

          <div className="space-y-1 pt-0.5">
            <Row label="Capital to landlords" value={formatUGX(totals.capital)} strong />
            <Row label="Wallet balance" value={formatUGX(walletBalance)} />
            <Row
              label={shortfall > 0 ? 'To add to wallet' : 'Covered by wallet'}
              value={shortfall > 0 ? formatUGX(shortfall) : 'Fully funded'}
              strong
            />
          </div>

          <label className="flex items-start gap-2.5 rounded-xl border border-border/60 bg-muted/30 p-2.5 cursor-pointer">
            <Checkbox
              checked={agreed}
              onCheckedChange={(v) => setAgreed(v === true)}
              className="mt-0.5"
              aria-label="Confirm and lock this selection"
            />
            <span className="text-[10px] leading-relaxed text-muted-foreground">
              I confirm these {houses.length} {houses.length === 1 ? 'house' : 'houses'} and understand my
              selection will be locked while I reserve {formatUGX(totals.capital)} in my wallet to pay the
              landlords.
            </span>
          </label>
        </div>

        <div className="px-5 pb-5 pt-1 flex gap-2">
          <Button variant="outline" className="flex-1 h-11 rounded-xl text-xs font-bold" onClick={() => onOpenChange(false)}>
            Keep editing
          </Button>
          <Button
            className="flex-1 h-11 rounded-xl text-xs font-bold gap-2"
            disabled={!agreed || houses.length === 0}
            onClick={onConfirm}
          >
            {shortfall > 0 ? <Wallet className="h-4 w-4" /> : <TrendingUp className="h-4 w-4" />}
            {shortfall > 0 ? 'Lock & add funds' : 'Lock & reserve'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between text-[10px] text-muted-foreground">
      <span>{label}</span>
      <span className={strong ? 'font-black text-foreground' : 'font-bold text-foreground'}>{value}</span>
    </div>
  );
}
