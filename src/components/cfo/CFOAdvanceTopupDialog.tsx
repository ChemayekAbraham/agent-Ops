import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
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
import { Textarea } from '@/components/ui/textarea';
import { Loader2, Plus } from 'lucide-react';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { FieldError, FormErrorBanner, reasonError, parseRpcError } from '@/components/shared/FormFeedback';
import { toast } from 'sonner';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  advance: any;
  onSuccess?: () => void;
}

const MIN_TOPUP = 10000;

/**
 * CFO / manager direct top-up on an ongoing agent advance.
 *
 * The standard agent-side eligibility rules (>=30% repaid, on schedule) are
 * waived here, so the database requires a written reason of at least 10
 * characters — it is stored on the top-up row and in the audit trail.
 */
export default function CFOAdvanceTopupDialog({ open, onOpenChange, advance, onSuccess }: Props) {
  const [amount, setAmount] = useState('');
  const [extendDays, setExtendDays] = useState('30');
  const [reason, setReason] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);

  const principal = Number(advance?.principal ?? 0);
  const monthlyRate = Number(advance?.monthly_rate ?? 0.33);
  const amt = Number(amount);
  const days = Number(extendDays);

  const amountError = useMemo(() => {
    if (!amount) return null;
    if (!Number.isFinite(amt) || amt < MIN_TOPUP) return `Minimum top-up is ${formatUGX(MIN_TOPUP)}.`;
    if (amt > principal) return `Top-up cannot exceed the current principal (${formatUGX(principal)}).`;
    return null;
  }, [amount, amt, principal]);

  const daysError = useMemo(() => {
    if (!extendDays) return null;
    if (!Number.isFinite(days) || days <= 0) return 'Extension days must be greater than zero.';
    return null;
  }, [extendDays, days]);

  const reasonMsg = reason.length > 0 ? reasonError(reason) : null;

  const accessFee = useMemo(() => {
    if (!Number.isFinite(amt) || amt <= 0 || !Number.isFinite(days) || days <= 0) return 0;
    return Math.round(amt * (Math.pow(1 + monthlyRate, days / 30) - 1));
  }, [amt, days, monthlyRate]);

  const newOutstanding = Number(advance?.outstanding_balance ?? 0) + (Number.isFinite(amt) ? amt : 0) + accessFee;

  const canSubmit =
    !amountError && !daysError && !!amount && !!extendDays && reasonError(reason) === null;

  const topupMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('apply_advance_topup' as any, {
        p_advance_id: advance.id,
        p_amount: amt,
        p_extend_days: days,
        p_request_id: null,
        p_reason: reason.trim(),
        p_override_eligibility: true,
      } as any);
      if (error) throw error;
      return data as any;
    },
    onSuccess: (data) => {
      toast.success(`Top-up of ${formatUGX(amt)} applied and credited to the agent's wallet`);
      setAmount('');
      setReason('');
      setExtendDays('30');
      setSubmitError(null);
      onOpenChange(false);
      onSuccess?.();
      return data;
    },
    onError: (err) => {
      const msg = parseRpcError(err);
      setSubmitError(msg);
      toast.error(msg);
    },
  });

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!topupOpenBusy(topupMutation.isPending)) onOpenChange(next); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Top up this advance</DialogTitle>
          <DialogDescription>
            {advance?.profiles?.full_name || 'Agent'} — current principal {formatUGX(principal)}, outstanding{' '}
            {formatUGX(Number(advance?.outstanding_balance ?? 0))}. A reason is required and stored in the audit trail.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <FormErrorBanner message={submitError} />

          <div>
            <Label className="text-xs">Top-up amount (UGX)</Label>
            <Input
              type="number"
              inputMode="numeric"
              placeholder="e.g. 50000"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="h-11"
            />
            <FieldError message={amountError} />
            <p className="text-[11px] text-muted-foreground mt-1">
              Minimum {formatUGX(MIN_TOPUP)} · maximum {formatUGX(principal)}
            </p>
          </div>

          <div>
            <Label className="text-xs">Extend schedule by (days)</Label>
            <Input
              type="number"
              inputMode="numeric"
              value={extendDays}
              onChange={(e) => setExtendDays(e.target.value)}
              className="h-11"
            />
            <FieldError message={daysError} />
          </div>

          <div>
            <Label className="text-xs">Reason (required, 10+ characters)</Label>
            <Textarea
              placeholder="Why is this top-up being approved outside the standard rules?"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
            />
            <FieldError message={reasonMsg} />
          </div>

          {Number.isFinite(amt) && amt >= MIN_TOPUP && !daysError && (
            <div className="rounded-xl border border-border bg-muted/40 p-3 space-y-1 text-xs">
              <div className="flex justify-between"><span className="text-muted-foreground">Access fee added</span><span className="font-semibold">{formatUGX(accessFee)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">New principal</span><span className="font-semibold">{formatUGX(principal + amt)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">New outstanding</span><span className="font-semibold">{formatUGX(newOutstanding)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Cycle extended by</span><span className="font-semibold">{days} days</span></div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={topupMutation.isPending}>
            Cancel
          </Button>
          <Button onClick={() => { setSubmitError(null); topupMutation.mutate(); }} disabled={!canSubmit || topupMutation.isPending} className="gap-2">
            {topupMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Apply top-up
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function topupOpenBusy(pending: boolean) {
  return pending;
}
