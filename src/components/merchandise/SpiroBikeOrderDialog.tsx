import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Bike, Loader2, ShieldCheck, FileText, ChevronDown, ChevronUp } from 'lucide-react';

import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
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
  SPIRO_LEASE_PERIODS,
  spiroLeaseSchedule,
} from '@/lib/spiroBikeLease';
import {
  useMotorBikeCatalog,
  parseDisabledTerms,
  cleanDescription,
  DEFAULT_MOTORBIKES,
} from '@/components/executive/agent-ops/MotorBikeCatalogDialog';

const db = supabase as any;

/** Spiro models offered to agents. */
export const SPIRO_MODELS = [
  { model: 'Spiro Ekoride', note: 'City commuter · swappable battery' },
  { model: 'Spiro Ekocycle', note: 'Long range · higher payload' },
  { model: 'Spiro Commando', note: 'Heavy duty · field & upcountry routes' },
] as const;

/** Repayment periods available to agents. */
export const LEASE_TERMS = SPIRO_LEASE_PERIODS.map((p) => p.months);

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
        note: cleanDescription(c.description) || 'Welile electric bike',
        price: c.unit_price,
        disabledTerms: parseDisabledTerms(c.description),
      }));
    }
    return DEFAULT_MOTORBIKES.map((m) => ({
      model: m.item_name,
      note: cleanDescription(m.description) || 'Welile electric bike',
      price: m.unit_price,
      disabledTerms: parseDisabledTerms(m.description),
    }));
  }, [catalog]);

  const [model, setModel] = useState<string>(SPIRO_MODELS[0].model);
  const [term, setTerm] = useState<string>('3');
  const [submitting, setSubmitting] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [showTerms, setShowTerms] = useState(false);

  const selectedModel = useMemo(
    () => availableModels.find((m) => m.model === model) ?? availableModels[0],
    [availableModels, model],
  );
  const parsedTerm = parseInt(term, 10);
  const termValid = Number.isFinite(parsedTerm) && parsedTerm >= 1 && parsedTerm <= 24;
  const termNum = Math.min(24, Math.max(1, parsedTerm || 3));

  const basePrice = selectedModel?.price ?? 0;
  const schedule = useMemo(() => spiroLeaseSchedule(termNum, basePrice), [termNum, basePrice]);
  const isTermDisabled = Boolean(selectedModel?.disabledTerms?.has(termNum));

  // If the current term is disabled for this model, select the first allowed period
  useEffect(() => {
    if (selectedModel?.disabledTerms?.has(termNum)) {
      const firstAllowed = SPIRO_LEASE_PERIODS.find((p) => !selectedModel.disabledTerms.has(p.months));
      if (firstAllowed) {
        setTerm(String(firstAllowed.months));
      }
    }
  }, [selectedModel]);

  const submit = async () => {
    if (!acceptedTerms) {
      toast.error('Please accept the Lease Terms & Conditions to submit your order.');
      return;
    }
    if (isTermDisabled) {
      toast.error(`The ${termNum}-month lease period is not available for this bike model.`);
      return;
    }
    setSubmitting(true);
    const { error } = await db.rpc('agent_order_spiro_bike_lease', {
      p_model: model,
      p_valuation: schedule.base,
      p_lease_term_months: schedule.months,
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
            Choose your repayment period — the total repayable amount updates automatically.
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

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Repayment period (months)</Label>
              {isTermDisabled && (
                <span className="text-[11px] font-semibold text-destructive">Period disabled by manager</span>
              )}
            </div>

            {/* Quick selection chips for standard periods */}
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              {SPIRO_LEASE_PERIODS.map((p) => {
                const isDisabled = selectedModel?.disabledTerms?.has(p.months);
                const isSelected = termNum === p.months;
                return (
                  <button
                    key={p.months}
                    type="button"
                    disabled={isDisabled}
                    onClick={() => setTerm(String(p.months))}
                    className={`h-7 px-2.5 rounded-md text-xs font-medium border transition-colors ${
                      isDisabled
                        ? 'opacity-40 cursor-not-allowed bg-muted text-muted-foreground line-through border-transparent'
                        : isSelected
                        ? 'bg-primary text-primary-foreground border-primary shadow-xs'
                        : 'bg-card text-foreground border-border hover:bg-muted/70'
                    }`}
                    title={isDisabled ? `${p.months} months disabled by manager` : `${p.months} months`}
                  >
                    {p.months}m
                  </button>
                );
              })}
            </div>

            <Input
              type="number"
              min={1}
              max={24}
              value={term}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === '') {
                  setTerm(raw);
                  return;
                }
                const n = parseInt(raw, 10);
                if (Number.isNaN(n)) return;
                setTerm(String(Math.min(24, Math.max(1, n))));
              }}
              className={`h-9 text-sm ${isTermDisabled ? 'border-destructive focus-visible:ring-destructive' : ''}`}
            />
            {isTermDisabled ? (
              <p className="text-[11px] text-destructive font-medium">
                ⚠ The {termNum}-month lease period is not available for this bike model. Please select an allowed period.
              </p>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                Pick a standard period above or type any period from 1 to 24 months.
              </p>
            )}
          </div>

          <div className="rounded-lg border border-primary/30 bg-primary/5 px-3.5 py-3 space-y-2.5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-primary">
                  Total payable
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {termValid
                    ? `Over ${schedule.months} month${schedule.months === 1 ? '' : 's'} (${schedule.monthlyRatePct}% monthly reducing balance).`
                    : 'Enter a period from 1 to 24 months.'}
                </p>
              </div>
              <p className="text-base font-bold text-foreground whitespace-nowrap">
                {termValid ? formatUGX(schedule.total) : '—'}
              </p>
            </div>
            <div className="border-t border-primary/15 pt-2 text-[11px] text-muted-foreground leading-snug">
              <span className="font-semibold text-foreground">Repayment Schedule:</span> The daily payment plan is triggered only after your bike lease application is approved and activated. Daily deductions adjust downward each month on a reducing-balance basis.
            </div>
          </div>

          {/* Terms & Conditions Section */}
          <div className="rounded-lg border border-border/80 bg-muted/30 p-3 space-y-2.5 text-xs">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 font-semibold text-foreground">
                <ShieldCheck className="h-4 w-4 text-primary" />
                <span>Lease Terms & Conditions</span>
              </div>
              <button
                type="button"
                onClick={() => setShowTerms((prev) => !prev)}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline cursor-pointer"
              >
                {showTerms ? 'Hide details' : 'View details'}
                {showTerms ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </button>
            </div>

            {showTerms ? (
              <div className="space-y-2 border-t border-border/60 pt-2 text-[11px] text-muted-foreground leading-relaxed">
                <div className="flex items-start gap-2">
                  <FileText className="h-3.5 w-3.5 text-primary shrink-0 mt-0.5" />
                  <p>
                    <strong className="text-foreground">Logbook & Title Custody:</strong> The physical Spiro logbook and registration remain in Welile's exclusive legal custody as collateral throughout the lease period.
                  </p>
                </div>
                <div className="flex items-start gap-2">
                  <FileText className="h-3.5 w-3.5 text-primary shrink-0 mt-0.5" />
                  <p>
                    <strong className="text-foreground">Daily Commission Sweeps:</strong> Once your bike lease is approved and activated, daily repayments are recovered from your agent wallet commission earnings on a reducing-balance schedule without overdrafting.
                  </p>
                </div>
                <div className="flex items-start gap-2">
                  <FileText className="h-3.5 w-3.5 text-primary shrink-0 mt-0.5" />
                  <p>
                    <strong className="text-foreground">Full Settlement & Ownership:</strong> Upon full balance clearance (0 UGX), a certified <em>Certificate of Full Settlement</em> is automatically issued, and the logbook is officially transferred to you.
                  </p>
                </div>
              </div>
            ) : null}

            <div className="flex items-start gap-2.5 pt-1">
              <Checkbox
                id="spiro-terms"
                checked={acceptedTerms}
                onCheckedChange={(checked) => setAcceptedTerms(checked === true)}
                className="mt-0.5"
              />
              <label
                htmlFor="spiro-terms"
                className="text-[11px] leading-tight text-foreground/90 cursor-pointer select-none"
              >
                I agree to the Spiro Motorbike Lease Terms, including daily commission sweeps upon lease approval and Welile's custody of the logbook until final settlement.
              </label>
            </div>
          </div>

        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting || !termValid || !acceptedTerms || isTermDisabled}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
            {submitting ? 'Submitting…' : isTermDisabled ? 'Period Unavailable' : 'Submit Order for Review'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

