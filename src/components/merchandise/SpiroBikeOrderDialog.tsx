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
  SPIRO_LEASE_PERIODS,
  SPIRO_BIKE_BASE_PRICE,
  spiroLeaseGrid,
  spiroLeaseSchedule,
} from '@/lib/spiroBikeLease';
import { useMotorBikeCatalog } from '@/components/executive/agent-ops/MotorBikeCatalogDialog';

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
 * Agent-facing Spiro electric bike lease order: dynamic catalog base price,
 * any term from 1 to 24 months, and a 28% monthly reducing-balance charge —
 * principal split equally across the months, the charge taken only on the
 * principal still outstanding, so monthly and daily amounts fall each month.
 * Submitting sends the application to Agent Ops for eligibility review.
 */
export default function SpiroBikeOrderDialog({ open, onOpenChange, userId }: Props) {
  const queryClient = useQueryClient();
  const { data: catalog = [] } = useMotorBikeCatalog();

  const availableModels = useMemo(() => {
    const activeCatalog = catalog.filter((c) => c.is_active);
    if (activeCatalog.length > 0) {
      return activeCatalog.map((c) => ({
        model: c.item_name,
        note: c.description || 'Welile electric bike',
        price: c.unit_price,
      }));
    }
    return SPIRO_MODELS.map((m) => ({
      model: m.model,
      note: m.note,
      price: SPIRO_BIKE_BASE_PRICE,
    }));
  }, [catalog]);

  const [model, setModel] = useState<string>(SPIRO_MODELS[0].model);
  const [term, setTerm] = useState<string>('3');
  const [submitting, setSubmitting] = useState(false);

  const selectedModel = useMemo(
    () => availableModels.find((m) => m.model === model) ?? availableModels[0],
    [availableModels, model],
  );
  const termNum = parseInt(term, 10) || 3;
  const basePrice = selectedModel?.price ?? SPIRO_BIKE_BASE_PRICE;
  const schedule = useMemo(() => spiroLeaseSchedule(termNum, basePrice), [termNum, basePrice]);
  const grid = useMemo(() => spiroLeaseGrid(basePrice), [basePrice]);

  const submit = async () => {
    setSubmitting(true);
    const { error } = await db.rpc('agent_order_spiro_bike_lease', {
      p_model: model,
      p_valuation: schedule.total,
      p_lease_term_months: schedule.months,
      p_daily_rate: BIKE_RECOVERY_RATE,
      p_note: `Spiro bike lease — base ${formatUGX(schedule.base)}, ${schedule.monthlyRatePct}% monthly on the reducing balance, fees ${formatUGX(schedule.accessFee)}, total ${formatUGX(schedule.total)} over ${schedule.months} months; month 1 ${formatUGX(schedule.firstMonthly)} down to ${formatUGX(schedule.lastMonthly)}`,
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
            Choose your repayment period — the total repayable amount and daily payment update
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
                {availableModels.map((m) => (
                  <SelectItem key={m.model} value={m.model} className="text-sm">
                    {m.model} ({formatUGX(m.price)})
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
              <SelectContent className="max-h-64">
                {grid.map((row) => (
                  <SelectItem key={row.months} value={String(row.months)} className="text-sm">
                    {row.months} {row.months === 1 ? 'month' : 'months'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              Any period from 1 to 24 months.
            </p>
          </div>

          <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5 flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-primary">
                Daily payment
              </p>
              <p className="text-[11px] text-muted-foreground">
                Recovered from your wallet earnings daily.
              </p>
            </div>
            <p className="text-base font-bold text-foreground whitespace-nowrap">
              {formatUGX(schedule.firstDaily)}
              <span className="text-[11px] font-medium text-muted-foreground">/day</span>
            </p>
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
