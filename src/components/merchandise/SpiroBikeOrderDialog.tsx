import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Bike, Loader2 } from 'lucide-react';

import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatUGX } from '@/lib/rentCalculations';
import spiroBikeAsset from '@/assets/spiro-bike.jpg.asset.json';
import {
  BIKE_RECOVERY_RATE,
  SPIRO_BIKE_BASE_PRICE,
  SPIRO_LEASE_PERIODS,
  spiroLeaseGrid,
  spiroLeaseSchedule,
} from '@/lib/spiroBikeLease';

const db = supabase as any;

/** Spiro models offered to agents. */
export const SPIRO_MODELS = [
  { model: 'Spiro Ekoride', note: 'City commuter · swappable battery' },
  { model: 'Spiro Ekocycle', note: 'Long range · higher payload' },
  { model: 'Spiro Commando', note: 'Heavy duty · field & upcountry routes' },
] as const;

/** Repayment periods available to agents. */
export const LEASE_TERMS = SPIRO_LEASE_PERIODS.map((p) => p.months);

export { BIKE_RECOVERY_RATE };

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId?: string;
}

/**
 * Agent-facing Spiro electric bike lease order: fixed UGX 120,000 base price,
 * an access fee that depends on the repayment period (3m 33%, 6m 36%, 9m 39%,
 * 12m 42%) and a dynamic monthly repayment schedule. Submitting sends the
 * application to Agent Ops for eligibility review.
 */
export default function SpiroBikeOrderDialog({ open, onOpenChange, userId }: Props) {
  const queryClient = useQueryClient();
  const [model, setModel] = useState<string>(SPIRO_MODELS[0].model);
  const [term, setTerm] = useState<string>('3');
  const [submitting, setSubmitting] = useState(false);

  const selectedModel = useMemo(
    () => SPIRO_MODELS.find((m) => m.model === model) ?? SPIRO_MODELS[0],
    [model],
  );
  const termNum = parseInt(term, 10) || 3;
  const schedule = useMemo(() => spiroLeaseSchedule(termNum), [termNum]);
  const grid = useMemo(() => spiroLeaseGrid(), []);

  const submit = async () => {
    setSubmitting(true);
    const { error } = await db.rpc('agent_order_spiro_bike_lease', {
      p_model: model,
      p_valuation: schedule.total,
      p_lease_term_months: schedule.months,
      p_daily_rate: BIKE_RECOVERY_RATE,
      p_note: `Spiro bike lease — base ${formatUGX(schedule.base)}, access fee ${schedule.feePct}% (${formatUGX(schedule.accessFee)}), total ${formatUGX(schedule.total)} over ${schedule.months} months at ${formatUGX(schedule.monthly)} per month`,
    });
    setSubmitting(false);
    if (error) {
      toast.error(error.message || 'Could not submit your Spiro bike order');
      return;
    }
    toast.success('Order submitted for review. Agent Ops will confirm your eligibility.');
    onOpenChange(false);
    queryClient.invalidateQueries({ queryKey: ['my-bike-lease-orders', userId] });
    queryClient.invalidateQueries({ queryKey: ['my-merchandise-plans', userId] });
    queryClient.invalidateQueries({ queryKey: ['my-merchandise-deductions', userId] });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bike className="h-4 w-4 text-primary" /> Order a Welile Spiro Bike
          </DialogTitle>
          <DialogDescription className="text-xs">
            Choose your repayment period — the total access fee and total repayable amount update
            automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <img
            src={spiroBikeAsset.url}
            alt="Welile Spiro electric bike"
            loading="lazy"
            className="w-full h-36 sm:h-40 object-cover rounded-lg border border-border"
          />

          <div className="space-y-1">
            <Label className="text-xs">Bike model</Label>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger className="h-9 text-sm">
                <SelectValue placeholder="Select a model" />
              </SelectTrigger>
              <SelectContent>
                {SPIRO_MODELS.map((m) => (
                  <SelectItem key={m.model} value={m.model} className="text-sm">
                    {m.model}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">{selectedModel.note}</p>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Repayment period</Label>
            <Select value={term} onValueChange={setTerm}>
              <SelectTrigger className="h-9 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {grid.map((row) => (
                  <SelectItem key={row.months} value={String(row.months)} className="text-sm">
                    {row.months} months · {row.feePct}% access fee
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 space-y-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-primary">
              Your repayment schedule
            </p>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Bike price</span>
              <span className="font-semibold">{formatUGX(schedule.base)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Access fee ({schedule.feePct}%)</span>
              <span className="font-semibold">{formatUGX(schedule.accessFee)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Total repayable</span>
              <span className="font-bold">{formatUGX(schedule.total)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Monthly repayment</span>
              <span className="font-bold">
                {formatUGX(schedule.monthly)} × {schedule.months}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground pt-1">
              Repayments are recovered from your wallet earnings —{' '}
              {Math.round(BIKE_RECOVERY_RATE * 100)}% up to 4 times a day. Ownership transfers once
              the balance reaches zero.
            </p>
          </div>

          <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">
              All periods
            </p>
            <div className="space-y-0.5">
              {grid.map((row) => (
                <div key={row.months} className="flex justify-between text-[11px]">
                  <span className={row.months === schedule.months ? 'font-semibold' : 'text-muted-foreground'}>
                    {row.months} months ({row.feePct}%)
                  </span>
                  <span className={row.months === schedule.months ? 'font-semibold' : ''}>
                    {formatUGX(row.monthly)} / month · {formatUGX(row.total)} total
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
            {submitting ? 'Submitting…' : 'Submit Order for Review'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
