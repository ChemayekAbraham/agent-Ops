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
import { advanceControlCode, advanceControlMessage, withNewMoney } from '@/lib/advanceControls';

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
  // Set when the database refused the top-up because it matches a balance the agent already carries elsewhere.
  const [possibleTransfer, setPossibleTransfer] = useState<string | null>(null);

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
    // a money movement is never retried automatically: a lost reply would re-send a top-up that already went through
    retry: false,
    mutationFn: async (newMoney: boolean = false) => {
      const { data, error } = await supabase.rpc('apply_advance_topup' as any, {
        p_advance_id: advance.id,
        p_amount: amt,
        p_extend_days: days,
        p_request_id: null,
        p_reason: withNewMoney(reason, newMoney),
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
      setPossibleTransfer(null);
      onOpenChange(false);
      onSuccess?.();
      return data;
    },
    onError: (err: any) => {
      const code = advanceControlCode(err?.message);
      if (code === 'possible_transfer') {
        setPossibleTransfer(advanceControlMessage(err.message));
        return;
      }
      const msg = code === 'duplicate_submission'
        ? 'This top-up was just submitted. Check the advance before trying again.'
        : code ? advanceControlMessage(err.message) : parseRpcError(err);
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
              onChange={(e) => { setAmount(e.target.value); setPossibleTransfer(null); }}
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

        {possibleTransfer && (
          <div role="alert" className="rounded-xl border border-amber-500/50 bg-amber-500/10 p-3 space-y-2 text-xs">
            <p className="font-semibold">This looks like a transfer, not a new payout</p>
            <p>{possibleTransfer}</p>
            <p className="text-muted-foreground">
              To move an existing balance, close that advance with Transfer instead: nothing is paid out. Only continue if
              the agent is genuinely receiving new money.
            </p>
            <div className="flex flex-wrap gap-2 justify-end">
              <Button size="sm" variant="outline" onClick={() => setPossibleTransfer(null)} disabled={topupMutation.isPending}>Go back</Button>
              <Button size="sm" variant="destructive" disabled={!canSubmit || topupMutation.isPending}
                onClick={() => { setSubmitError(null); topupMutation.mutate(true); }}>
                This is new money: pay {formatUGX(amt)}
              </Button>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={topupMutation.isPending}>
            Cancel
          </Button>
          <Button onClick={() => { setSubmitError(null); topupMutation.mutate(false); }} disabled={!canSubmit || topupMutation.isPending || !!possibleTransfer} className="gap-2">
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
