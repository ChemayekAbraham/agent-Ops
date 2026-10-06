import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, Edit3, Loader2, Bike, AlertCircle } from 'lucide-react';

import { supabase } from '@/integrations/supabase/client';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { SPIRO_LEASE_PERIODS, spiroLeaseSchedule, spiroEffectiveFeePct } from '@/lib/spiroBikeLease';
import { useBikeCatalogCosts, bikeProfit, resolveBikeBasePrice } from '@/hooks/useBikeCatalogCosts';
import { useMotorBikeCatalog } from './MotorBikeCatalogDialog';

const db = supabase as any;

export interface BikeLeaseApplication {
  id: string;
  customer_id: string | null;
  client_name: string | null;
  client_phone: string | null;
  model_type: string | null;
  valuation_amount: number | null;
  payment_projection: number | null;
  lease_term_months: number | null;
  lease_daily_rate: number | null;
  amount_outstanding: number | null;
  amount_paid: number | null;
  order_status: string;
  rejection_reason: string | null;
  created_at: string;
  coo_approved_at: string | null;
  cfo_disbursed_at: string | null;
  lease_activated_at: string | null;
  disbursed_amount: number | null;
  tracking_reference: string | null;
}

interface Props {
  order: BikeLeaseApplication | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function EditBikeApplicationDialog({ order, open, onOpenChange, onSuccess }: Props) {
  const queryClient = useQueryClient();
  const { data: catalog = [] } = useMotorBikeCatalog();
  const supplierCostFor = useBikeCatalogCosts();

  const [model, setModel] = useState('');
  const [valuation, setValuation] = useState('');
  const [term, setTerm] = useState('12');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (order) {
      setModel(order.model_type || 'Spiro Ekoride');
      const baseVal = resolveBikeBasePrice(order.valuation_amount, order.lease_term_months, order.model_type, supplierCostFor(order.model_type));
      setValuation(String(Math.round(baseVal)));
      setTerm(String(order.lease_term_months || 12));
      setNote('');
    }
  }, [order, open]);

  const valuationNum = Math.max(0, Math.round(Number(valuation) || 0));
  const termNum = Math.max(1, parseInt(term, 10) || 12);
  const feePct = spiroEffectiveFeePct(termNum);
  const rate = feePct / 100;
  const perCredit = Math.round(valuationNum * rate);
  const monthly = termNum > 0 ? Math.round(valuationNum / termNum) : 0;

  const currentValNum = Number(order?.valuation_amount || 0);
  const currentTermNum = Number(order?.lease_term_months || 12);
  const currentFeePct = spiroEffectiveFeePct(currentTermNum);
  const currentCostPrice = supplierCostFor(order?.model_type);
  const currentDays = currentTermNum * 30;
  const currentDailyPay = currentDays > 0 ? Math.ceil(currentValNum / currentDays) : 0;
  const currentProfit = bikeProfit(currentValNum, currentCostPrice);
  const costPrice = supplierCostFor(model);
  const days = termNum * 30;
  const dailyPay = days > 0 ? Math.ceil(valuationNum / days) : 0;
  const profit = bikeProfit(valuationNum, costPrice);

  // Real-time schedule calculation
  const schedule = useMemo(() => {
    return spiroLeaseSchedule(termNum, valuationNum);
  }, [termNum, valuationNum]);

  // When model is picked from catalog, auto-fill base price if empty or changed
  const handleModelSelect = (selectedModelName: string) => {
    setModel(selectedModelName);
    const catalogItem = catalog.find((c) => c.item_name === selectedModelName);
    if (catalogItem && (!valuationNum || valuationNum === 0)) {
      setValuation(String(Math.round(catalogItem.unit_price)));
    }
  };

  const updateApplication = useMutation({
    mutationFn: async () => {
      if (!order) throw new Error('No application selected');
      if (valuationNum <= 0) throw new Error('Valuation must be greater than zero');

      const isApproved = order.order_status === 'approved';
      const paid = Number(order.amount_paid || 0);
      const newOutstanding = isApproved ? Math.max(0, valuationNum - paid) : valuationNum;

      const appendNote = note.trim()
        ? ` | Valuation adjusted to ${formatUGX(valuationNum)}: ${note.trim()}`
        : ` | Valuation adjusted to ${formatUGX(valuationNum)}`;

      const { error } = await db
        .from('merchandise_sales')
        .update({
          valuation_amount: valuationNum,
          total_amount: valuationNum,
          total_revenue: valuationNum,
          unit_price: valuationNum,
          model_type: model.trim() || 'Spiro bike',
          lease_term_months: termNum,
          payment_projection: perCredit,
          amount_outstanding: newOutstanding,
          admin_notes: (order.rejection_reason || '') + appendNote,
        })
        .eq('id', order.id);

      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(`Application updated: ${model} at ${formatUGX(valuationNum)} (${termNum} months)`);
      queryClient.invalidateQueries({ queryKey: ['bike-lease-queue'] });
      queryClient.invalidateQueries({ queryKey: ['bike-lease-eligibility-detail'] });
      queryClient.invalidateQueries({ queryKey: ['agent-products'] });
      onOpenChange(false);
      onSuccess?.();
    },
    onError: (err: any) => {
      toast.error(err.message || 'Failed to update application');
    },
  });

  if (!order) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'app-dialog-bottom-sheet',
          '!left-0 !right-0 !top-auto !bottom-0',
          '!translate-x-0 !translate-y-0',
          '!max-w-none !w-full',
          '!rounded-t-3xl !rounded-b-none',
          '!p-0 !gap-0',
          'h-[88dvh] max-h-[88dvh]',
          'flex flex-col overflow-hidden',
          'pointer-events-auto',
          'sm:!left-[50%] sm:!top-[50%] sm:!bottom-auto sm:!right-auto',
          'sm:!translate-x-[-50%] sm:!translate-y-[-50%]',
          'sm:!max-w-md sm:!w-full',
          'sm:!rounded-2xl',
          'sm:h-auto sm:max-h-[90dvh]'
        )}
      >
        <div className="sm:hidden flex justify-center pt-2.5 pb-1 shrink-0">
          <div className="h-1.5 w-12 rounded-full bg-muted-foreground/30" />
        </div>
        <DialogHeader className="px-4 sm:px-6 pt-2 sm:pt-4 pb-3 border-b border-border/50 shrink-0 pr-12 sm:pr-10 text-left">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Edit3 className="h-4 w-4 text-primary" />
            Edit Application Price &amp; Terms
          </DialogTitle>
          <DialogDescription className="text-xs">
            Modify the bike model, valuation price, or lease term directly for this application.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-6 space-y-4 text-xs overscroll-contain">
          {/* Applicant info card */}
          <div className="rounded-lg border bg-muted/40 p-3 space-y-1">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Applicant</span>
              <span className="font-semibold text-foreground">{order.client_name || 'Agent'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Phone Number</span>
              <span className="font-medium text-foreground">{order.client_phone || '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Bike Cost Price</span>
              <span className="font-semibold text-primary">
                {currentCostPrice == null ? 'Not in catalog' : formatUGX(currentCostPrice)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Our Profit</span>
              <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                {currentProfit == null ? 'Not in catalog' : formatUGX(currentProfit)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Est. Daily Pay</span>
              <span className="font-semibold text-foreground">
                {formatUGX(currentDailyPay)}/day
              </span>
            </div>
          </div>

          {/* Model selection */}
          <div className="space-y-1.5">
            <Label className="text-xs">Bike Model</Label>
            <div className="space-y-2">
              <Select value={model} onValueChange={handleModelSelect}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue placeholder="Select or keep current model" />
                </SelectTrigger>
                <SelectContent>
                  {catalog.length > 0 ? (
                    catalog.map((c) => (
                      <SelectItem key={c.id} value={c.item_name} className="text-xs">
                        {c.item_name} ({formatUGX(c.unit_price)})
                      </SelectItem>
                    ))
                  ) : (
                    <>
                      <SelectItem value="Spiro Ekoride" className="text-xs">Spiro Ekoride</SelectItem>
                      <SelectItem value="Spiro Ekocycle" className="text-xs">Spiro Ekocycle</SelectItem>
                      <SelectItem value="Spiro Commando" className="text-xs">Spiro Commando</SelectItem>
                      <SelectItem value="Spiro bike" className="text-xs">Spiro bike</SelectItem>
                    </>
                  )}
                </SelectContent>
              </Select>
              <Input
                placeholder="Or type custom model name"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
          </div>

          {/* Valuation Amount */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Application Valuation (UGX) *</Label>
              {catalog.length > 0 && (
                <div className="flex gap-1">
                  {catalog.slice(0, 3).map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className="text-[10px] text-primary hover:underline px-1 py-0.5 rounded bg-primary/10"
                      onClick={() => setValuation(String(Math.round(c.unit_price)))}
                    >
                      {c.item_name.split(' ')[1] || c.item_name}: {formatUGX(c.unit_price)}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <Input
              type="number"
              min={1000}
              step={1000}
              value={valuation}
              onChange={(e) => setValuation(e.target.value)}
              placeholder="e.g. 159600"
              className="h-9 text-xs font-semibold"
            />
          </div>

          {/* Lease term */}
          <div className="space-y-1.5">
            <Label className="text-xs">Lease Term (Months)</Label>
            <Select value={term} onValueChange={setTerm}>
              <SelectTrigger className="h-9 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SPIRO_LEASE_PERIODS.map((p) => (
                  <SelectItem key={p.months} value={String(p.months)} className="text-xs">
                    {p.months} {p.months === 1 ? 'month' : 'months'} (total charge {spiroEffectiveFeePct(p.months)}%)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Real-time calculated projection breakdown */}
          <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-primary">
              Updated Repayment Projection
            </p>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Bike Cost Price</span>
              <span className="font-bold text-primary">{costPrice == null ? 'Not in catalog' : formatUGX(costPrice)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Our Profit</span>
              <span className="font-bold text-emerald-600 dark:text-emerald-400">{profit == null ? 'Not in catalog' : formatUGX(profit)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Estimated Daily Pay</span>
              <span className="font-semibold text-foreground">{formatUGX(dailyPay)}/day</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Estimated Monthly</span>
              <span className="font-semibold text-foreground">{formatUGX(monthly)}/mo</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Access Fee ({termNum}m)</span>
              <span className="font-semibold text-foreground">{feePct}%</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Recovery per Credit ({feePct}%)</span>
              <span className="font-semibold text-foreground">{formatUGX(perCredit)}</span>
            </div>
          </div>

          {/* Optional reason / adjustment note */}
          <div className="space-y-1.5">
            <Label className="text-xs">Adjustment Note (Optional)</Label>
            <Textarea
              placeholder="e.g. Corrected valuation according to updated Spiro price list"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              className="text-xs resize-none"
            />
          </div>
        </div>

        <DialogFooter className="p-3 sm:p-4 border-t bg-card/50 shrink-0 gap-2 flex flex-col-reverse sm:flex-row sm:justify-end">
          <Button variant="outline" size="sm" className="h-9 text-xs w-full sm:w-auto justify-center" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-9 text-xs bg-primary hover:bg-primary/90 text-primary-foreground font-semibold w-full sm:w-auto justify-center"
            disabled={updateApplication.isPending || valuationNum <= 0}
            onClick={() => updateApplication.mutate()}
          >
            {updateApplication.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
            ) : (
              <Check className="h-3.5 w-3.5 mr-1.5" />
            )}
            Save Application Price
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
