import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Bike, Loader2 } from 'lucide-react';

import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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

const db = supabase as any;

/** Spiro models offered to agents with their indicative valuation (UGX). */
export const SPIRO_MODELS = [
  { model: 'Spiro Ekoride', valuation: 4_800_000, note: 'City commuter · swappable battery' },
  { model: 'Spiro Ekocycle', valuation: 6_200_000, note: 'Long range · higher payload' },
  { model: 'Spiro Commando', valuation: 7_500_000, note: 'Heavy duty · field & upcountry routes' },
] as const;

/** Lease terms available to agents. */
export const LEASE_TERMS = [6, 12, 18, 24] as const;

/** Share of every wallet credit applied to the bike lease. */
export const BIKE_RECOVERY_RATE = 0.15;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId?: string;
}

/**
 * Agent-facing Spiro electric bike lease application: model selection,
 * bike valuation and lease terms. The application is submitted for internal
 * review and bike release. The detailed recovery projection lives on the Agent Ops
 * Motor Bikes page.
 */
export default function SpiroBikeOrderDialog({ open, onOpenChange, userId }: Props) {
  const queryClient = useQueryClient();
  const [model, setModel] = useState<string>(SPIRO_MODELS[0].model);
  const [valuation, setValuation] = useState<string>(String(SPIRO_MODELS[0].valuation));
  const [term, setTerm] = useState<string>('12');
  const [submitting, setSubmitting] = useState(false);

  const selectedModel = useMemo(
    () => SPIRO_MODELS.find((m) => m.model === model) ?? SPIRO_MODELS[0],
    [model],
  );
  const valuationNum = Math.max(0, Math.round(Number(valuation || 0) || 0));
  const termNum = Math.max(1, parseInt(term, 10) || 12);
  const monthlyEquivalent = valuationNum > 0 ? Math.round(valuationNum / termNum) : 0;

  const pickModel = (value: string) => {
    setModel(value);
    const found = SPIRO_MODELS.find((m) => m.model === value);
    if (found) setValuation(String(found.valuation));
  };

  const submit = async () => {
    if (valuationNum < 100_000) {
      toast.error('Bike valuation must be at least UGX 100,000');
      return;
    }
    setSubmitting(true);
    const { error } = await db.rpc('agent_order_spiro_bike_lease', {
      p_model: model,
      p_valuation: valuationNum,
      p_lease_term_months: termNum,
      p_daily_rate: BIKE_RECOVERY_RATE,
      p_note: null,
    });
    setSubmitting(false);
    if (error) {
      toast.error(error.message || 'Could not submit your Spiro bike application');
      return;
    }
    toast.success('Application submitted. It will be reviewed internally.');
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
            <Bike className="h-4 w-4 text-primary" /> Apply for a Spiro electric bike
          </DialogTitle>
          <DialogDescription className="text-xs">
            Choose a model and lease term. Marketing confirms the final price, then the bike
            is released and your lease is activated.
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
            <Select value={model} onValueChange={pickModel}>
              <SelectTrigger className="h-9 text-sm">
                <SelectValue placeholder="Select a model" />
              </SelectTrigger>
              <SelectContent>
                {SPIRO_MODELS.map((m) => (
                  <SelectItem key={m.model} value={m.model} className="text-sm">
                    {m.model} · {formatUGX(m.valuation)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">{selectedModel.note}</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Bike valuation (UGX)</Label>
              <Input
                type="number"
                min={100000}
                step={50000}
                inputMode="numeric"
                value={valuation}
                onChange={(e) => setValuation(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">Marketing confirms the final price.</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Lease term</Label>
              <Select value={term} onValueChange={setTerm}>
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LEASE_TERMS.map((t) => (
                    <SelectItem key={t} value={String(t)} className="text-sm">
                      {t} months
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                {monthlyEquivalent > 0 ? `≈ ${formatUGX(monthlyEquivalent)} / month` : 'Choose a term'}
              </p>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 space-y-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Lease terms
            </p>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Bike valuation</span>
              <span className="font-semibold">{formatUGX(valuationNum)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Lease term</span>
              <span className="font-semibold">{termNum} months</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Wallet recovery rate</span>
              <span className="font-semibold">{Math.round(BIKE_RECOVERY_RATE * 100)}% per credit</span>
            </div>
            <p className="text-[11px] text-muted-foreground pt-1">
              The bike stays under lease until the valuation is fully recovered from your wallet
              earnings — {Math.round(BIKE_RECOVERY_RATE * 100)}% up to 4 times a day. Ownership
              transfers once the balance reaches zero.
            </p>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting || valuationNum < 100_000}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
            {submitting ? 'Submitting…' : 'Submit application'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
