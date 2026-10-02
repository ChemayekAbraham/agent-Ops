import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2, Percent, TrendingUp, FileText, AlertCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatUGX } from '@/lib/rentCalculations';
import {
  setBikeLeaseMonthlyRate,
  fetchBikeLeaseSchedule,
  type BikeLeaseRecord,
  type BikeLeaseInstallment,
} from '@/hooks/useBikeLeases';

interface Props {
  lease: BikeLeaseRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

/**
 * Dialog for COO / CFO to set or adjust the monthly reducing-balance
 * interest rate on a Spiro bike lease. Changing the rate creates a new
 * schedule version and preserves the old one for history. A mandatory
 * reason field is recorded in the audit log.
 */
export function BikeLeaseRateDialog({ lease, open, onOpenChange, onSuccess }: Props) {
  const queryClient = useQueryClient();

  const [ratePct, setRatePct] = useState('');
  const [reason, setReason] = useState('');

  // Sync when opening a new lease
  const [lastLeaseId, setLastLeaseId] = useState<string | null>(null);
  if (lease && lease.lease_id !== lastLeaseId) {
    setLastLeaseId(lease.lease_id);
    setRatePct(String(lease.monthly_rate_pct ?? 0));
    setReason('');
  }

  const parsedRate = parseFloat(ratePct);
  const rateValid = Number.isFinite(parsedRate) && parsedRate >= 0 && parsedRate <= 20;
  const rateChanged = rateValid && parsedRate !== (lease?.monthly_rate_pct ?? 0);
  const reasonValid = reason.trim().length >= 10;

  // Preview: existing schedule
  const { data: currentSchedule = [], isLoading: scheduleLoading } = useQuery<BikeLeaseInstallment[]>({
    queryKey: ['bike-lease-schedule', lease?.lease_id],
    enabled: !!lease?.lease_id && open,
    queryFn: () => fetchBikeLeaseSchedule(lease!.lease_id),
  });

  // Compute preview totals for the new rate
  const basePrice = Number(lease?.valuation_amount || 0);
  const termMonths = Number(lease?.lease_term_months || 12);
  const principalPerMonth = termMonths > 0 ? Math.round(basePrice / termMonths) : 0;

  const previewRows = rateValid
    ? Array.from({ length: termMonths }, (_, i) => {
        const openingBalance = basePrice - principalPerMonth * i;
        const interest = Math.round(openingBalance * (parsedRate / 100));
        const installment = principalPerMonth + interest;
        const closing = openingBalance - principalPerMonth;
        return { month: i + 1, openingBalance, interest, installment, closing };
      })
    : [];

  const previewTotal = previewRows.reduce((s, r) => s + r.installment, 0);
  const previewTotalInterest = previewRows.reduce((s, r) => s + r.interest, 0);
  const currentTotal = currentSchedule.reduce((s, r) => s + r.installment_amount, 0);
  const currentTotalInterest = currentSchedule.reduce((s, r) => s + r.interest_due, 0);

  const save = useMutation({
    mutationFn: async () => {
      if (!lease) throw new Error('No lease selected');
      return setBikeLeaseMonthlyRate(lease.lease_id, parsedRate, reason.trim());
    },
    onSuccess: () => {
      toast.success(`Monthly rate set to ${parsedRate}% — new schedule generated.`);
      queryClient.invalidateQueries({ queryKey: ['bike-lease-queue'] });
      queryClient.invalidateQueries({ queryKey: ['bike-lease-schedule', lease?.lease_id] });
      queryClient.invalidateQueries({ queryKey: ['my-bike-lease-orders'] });
      onOpenChange(false);
      onSuccess?.();
    },
    onError: (e: any) => toast.error(e.message || 'Could not update the monthly rate'),
  });

  if (!lease) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-1.5rem)] max-w-[calc(100vw-1.5rem)] sm:w-full sm:max-w-lg max-h-[90dvh] overflow-y-auto overflow-x-hidden p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <TrendingUp className="h-4 w-4 text-primary" /> Set Monthly Rate
          </DialogTitle>
          <DialogDescription className="text-xs">
            Adjust the monthly reducing-balance interest rate for{' '}
            <span className="font-semibold text-foreground">{lease.client_name || 'this agent'}</span>'s lease
            ({lease.model_type || 'Spiro bike'}, {termMonths} months).
            A new repayment schedule will be generated and the old one preserved for audit.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3.5">
          {/* Current vs new rate */}
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg border bg-muted/30 p-2.5 space-y-1 text-xs">
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Current rate</p>
              <p className="text-sm font-bold text-foreground">{lease.monthly_rate_pct ?? 0}%<span className="text-[10px] font-normal text-muted-foreground ml-1">/month</span></p>
            </div>
            <div className="rounded-lg border bg-muted/30 p-2.5 space-y-1 text-xs">
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Base value</p>
              <p className="text-sm font-bold text-primary">{formatUGX(basePrice)}</p>
            </div>
          </div>

          {/* Rate input */}
          <div className="space-y-1">
            <Label className="text-xs flex items-center gap-1.5">
              <Percent className="h-3 w-3 text-muted-foreground" /> New monthly rate (0% – 20%)
            </Label>
            <Input
              type="number"
              min={0}
              max={20}
              step={0.5}
              value={ratePct}
              onChange={(e) => setRatePct(e.target.value)}
              className="h-9 text-sm"
              placeholder="e.g. 5"
            />
            {!rateValid && ratePct !== '' && (
              <p className="text-[10px] text-destructive flex items-center gap-1">
                <AlertCircle className="h-3 w-3" /> Rate must be between 0% and 20%.
              </p>
            )}
          </div>

          {/* Reason */}
          <div className="space-y-1">
            <Label className="text-xs flex items-center gap-1.5">
              <FileText className="h-3 w-3 text-muted-foreground" /> Reason for rate change (min. 10 chars)
            </Label>
            <Textarea
              rows={2}
              placeholder="e.g. COO approved 5% monthly rate based on agent's strong collection performance"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="text-sm"
            />
          </div>

          {/* Impact preview */}
          {rateValid && rateChanged && (
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2.5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-primary">
                Schedule preview at {parsedRate}%
              </p>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="space-y-0.5">
                  <p className="text-[10px] text-muted-foreground">Total interest</p>
                  <p className="font-bold text-foreground">{formatUGX(previewTotalInterest)}</p>
                  {currentTotalInterest > 0 && (
                    <p className="text-[10px] text-muted-foreground">
                      was {formatUGX(currentTotalInterest)}
                    </p>
                  )}
                </div>
                <div className="space-y-0.5">
                  <p className="text-[10px] text-muted-foreground">Total repayable</p>
                  <p className="font-bold text-primary">{formatUGX(previewTotal)}</p>
                  {currentTotal > 0 && (
                    <p className="text-[10px] text-muted-foreground">
                      was {formatUGX(currentTotal)}
                    </p>
                  )}
                </div>
              </div>

              {/* Mini schedule table */}
              <div className="rounded-lg border border-border overflow-hidden">
                <div className="max-h-48 overflow-y-auto">
                  <table className="w-full text-[11px]">
                    <thead className="sticky top-0 bg-muted/60">
                      <tr className="text-muted-foreground">
                        <th className="text-left font-medium px-2 py-1.5">Month</th>
                        <th className="text-right font-medium px-2 py-1.5">Balance</th>
                        <th className="text-right font-medium px-2 py-1.5">Interest</th>
                        <th className="text-right font-medium px-2 py-1.5">Instalment</th>
                      </tr>
                    </thead>
                    <tbody>
                      {previewRows.map((row) => (
                        <tr key={row.month} className="border-t border-border/60">
                          <td className="px-2 py-1.5 font-medium">{row.month}</td>
                          <td className="px-2 py-1.5 text-right">{formatUGX(row.openingBalance)}</td>
                          <td className="px-2 py-1.5 text-right">{formatUGX(row.interest)}</td>
                          <td className="px-2 py-1.5 text-right font-semibold">{formatUGX(row.installment)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* Existing schedule summary */}
          {currentSchedule.length > 0 && !rateChanged && (
            <div className="rounded-lg border bg-muted/30 p-2.5 space-y-1 text-xs">
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                Current schedule ({currentSchedule.length} instalments)
              </p>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Total repayable</span>
                <span className="font-semibold">{formatUGX(currentTotal)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Total interest</span>
                <span className="font-semibold">{formatUGX(currentTotalInterest)}</span>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 pt-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={save.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={save.isPending || !rateValid || !rateChanged || !reasonValid}
          >
            {save.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
            ) : (
              <TrendingUp className="h-4 w-4 mr-1.5" />
            )}
            {save.isPending ? 'Saving…' : `Set Rate to ${rateValid ? parsedRate : '—'}%`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
