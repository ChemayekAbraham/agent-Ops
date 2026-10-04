import { useMemo, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Progress } from '@/components/ui/progress';
import { toast } from 'sonner';
import { Loader2, AlertTriangle, TrendingUp, CheckCircle2 } from 'lucide-react';
import { format } from 'date-fns';
import {
  formatUGX,
  calculateAccessFee,
  frequencyLabel,
  installmentCount,
  periodDays,
  type RepaymentFrequency,
} from '@/lib/agentAdvanceCalculations';

export interface TopupEligibility {
  eligible: boolean;
  reason: string | null;
  has_active_advance: boolean;
  advance_id?: string;
  principal?: number;
  outstanding_balance?: number;
  total_payable?: number;
  repaid_amount?: number;
  repaid_percent?: number;
  behind?: boolean;
  expected_repaid_to_date?: number;
  status?: string;
  monthly_rate?: number;
  repayment_frequency?: RepaymentFrequency;
  installment_amount?: number;
  cycle_days?: number;
  issued_at?: string;
  expires_at?: string;
  max_topup?: number;
  min_topup?: number;
}

export function useTopupEligibility(agentId?: string, enabled = true) {
  return useQuery({
    queryKey: ['advance-topup-eligibility', agentId],
    queryFn: async (): Promise<TopupEligibility | null> => {
      if (!agentId) return null;
      const { data, error } = await supabase.rpc('agent_advance_topup_eligibility' as any, {
        p_agent_id: agentId,
      } as any);
      if (error) throw error;
      return (data as unknown as TopupEligibility) ?? null;
    },
    enabled: !!agentId && enabled,
  });
}

/**
 * Agent-facing top-up request. Replaces the "new advance" path while an
 * advance is still running: the top-up merges into the existing advance,
 * inheriting its rate and repayment frequency and extending the schedule.
 */
export function AdvanceTopupRequestPanel({ onSubmitted }: { onSubmitted?: () => void }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: elig, isLoading, refetch } = useTopupEligibility(user?.id);

  const [amount, setAmount] = useState('');
  const [extendDays, setExtendDays] = useState('30');
  const [reason, setReason] = useState('');

  const topup = Math.max(0, parseInt(amount) || 0);
  const days = Math.max(0, parseInt(extendDays) || 0);
  const rate = Number(elig?.monthly_rate ?? 0.33);
  const frequency = (elig?.repayment_frequency ?? 'daily') as RepaymentFrequency;
  const maxTopup = Number(elig?.max_topup ?? 0);
  const minTopup = Number(elig?.min_topup ?? 10000);

  const preview = useMemo(() => {
    if (!elig?.has_active_advance || topup <= 0 || days <= 0) return null;
    const fee = calculateAccessFee(topup, days, rate);
    const newOutstanding = Number(elig.outstanding_balance ?? 0) + topup + fee;
    const newCycle = Number(elig.cycle_days ?? 30) + days;
    const elapsed = elig.issued_at
      ? Math.max(0, Math.floor((Date.now() - new Date(elig.issued_at).getTime()) / 86400000))
      : 0;
    const remainingDays = Math.max(1, newCycle - elapsed);
    const installments = Math.max(1, Math.ceil(remainingDays / periodDays(frequency)));
    const installment = Math.ceil(newOutstanding / installments);
    const newEnd = new Date(
      Math.max(new Date(elig.expires_at ?? Date.now()).getTime(), Date.now()) + days * 86400000,
    );
    return { fee, newOutstanding, newCycle, installment, installments, newEnd };
  }, [elig, topup, days, rate, frequency]);

  const overMax = topup > maxTopup;
  const underMin = topup > 0 && topup < minTopup;

  const submitMutation = useMutation({
    mutationFn: async () => {
      if (!user?.id) throw new Error('Not authenticated');
      const fresh = await refetch();
      const e = fresh.data;
      if (!e?.eligible) throw new Error(e?.reason || 'You are not eligible for a top-up right now');
      if (topup < Number(e.min_topup ?? 10000)) throw new Error(`Minimum top-up is ${formatUGX(Number(e.min_topup ?? 10000))}`);
      if (topup > Number(e.max_topup ?? 0)) throw new Error(`Top-up cannot exceed ${formatUGX(Number(e.max_topup ?? 0))} (90% of your current advance)`);
      if (days <= 0) throw new Error('Enter how many days to extend by');
      if (reason.trim().length < 10) throw new Error('Reason must be at least 10 characters');

      const fee = calculateAccessFee(topup, days, Number(e.monthly_rate ?? 0.33));
      const freq = (e.repayment_frequency ?? 'daily') as RepaymentFrequency;
      const total = topup + fee;
      const perPeriod = Math.ceil(total / installmentCount(days, freq));

      const { error } = await supabase.from('agent_advance_requests').insert({
        agent_id: user.id,
        request_kind: 'topup',
        parent_advance_id: e.advance_id,
        extend_days: days,
        principal: topup,
        cycle_days: days,
        monthly_rate: Number(e.monthly_rate ?? 0.33),
        access_fee: fee,
        registration_fee: 0,
        total_payable: total,
        daily_payment: perPeriod,
        repayment_frequency: freq,
        reason: reason.trim(),
        status: 'pending',
      } as any);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Top-up request submitted for review');
      setAmount('');
      setReason('');
      queryClient.invalidateQueries({ queryKey: ['my-advance-requests'] });
      queryClient.invalidateQueries({ queryKey: ['advance-topup-eligibility'] });
      onSubmitted?.();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-10 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (!elig?.has_active_advance) {
    return (
      <div className="rounded-2xl border border-border/60 bg-muted/40 p-4 text-sm text-muted-foreground">
        You have no ongoing advance to top up.
      </div>
    );
  }

  const repaidPct = Number(elig.repaid_percent ?? 0);

  return (
    <div className="space-y-4">
      {/* Current advance summary */}
      <div className="rounded-2xl border border-border/60 bg-card p-4">
        <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Current advance</p>
        <div className="mt-2 grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-[11px] text-muted-foreground">Principal</p>
            <p className="font-bold text-foreground">{formatUGX(Number(elig.principal ?? 0))}</p>
          </div>
          <div>
            <p className="text-[11px] text-muted-foreground">Outstanding</p>
            <p className="font-bold text-foreground">{formatUGX(Number(elig.outstanding_balance ?? 0))}</p>
          </div>
          <div>
            <p className="text-[11px] text-muted-foreground">Rate (inherited)</p>
            <p className="font-bold text-foreground">{Math.round(rate * 100)}% monthly</p>
          </div>
          <div>
            <p className="text-[11px] text-muted-foreground">Repayment</p>
            <p className="font-bold text-foreground">{frequencyLabel(frequency)}</p>
          </div>
        </div>
        <div className="mt-3">
          <div className="flex items-center justify-between text-[11px] font-semibold">
            <span className="text-muted-foreground">Repaid {repaidPct.toFixed(1)}% · need 30%</span>
            <span className="text-foreground">{formatUGX(Number(elig.repaid_amount ?? 0))}</span>
          </div>
          <Progress value={Math.min(100, repaidPct)} className="mt-1 h-2" />
        </div>
      </div>

      {!elig.eligible && (
        <div className="flex gap-2 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-3">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
          <div className="text-xs text-foreground">
            <p className="font-bold">Top-up not available yet</p>
            <p className="mt-0.5 text-muted-foreground">{elig.reason}</p>
            {elig.behind && (
              <p className="mt-1 text-muted-foreground">
                Expected repaid by today: {formatUGX(Number(elig.expected_repaid_to_date ?? 0))} · you have repaid{' '}
                {formatUGX(Number(elig.repaid_amount ?? 0))}.
              </p>
            )}
          </div>
        </div>
      )}

      {elig.eligible && (
        <>
          <div className="flex gap-2 rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-3">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
            <p className="text-xs text-foreground">
              You qualify for a top-up of up to <span className="font-bold">{formatUGX(maxTopup)}</span> (90% of your
              current advance). It merges into this advance at the same {Math.round(rate * 100)}% rate.
            </p>
          </div>

          <div>
            <label className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Top-up amount (UGX)</label>
            <Input
              inputMode="numeric"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))}
              placeholder={`Up to ${maxTopup}`}
              className="mt-1"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Min {formatUGX(minTopup)} · Max {formatUGX(maxTopup)}
            </p>
            {overMax && <p className="mt-1 text-[11px] font-semibold text-red-500">Exceeds 90% of your current advance.</p>}
            {underMin && <p className="mt-1 text-[11px] font-semibold text-red-500">Below the minimum top-up.</p>}
          </div>

          <div>
            <label className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Extend schedule by (days)</label>
            <Input
              inputMode="numeric"
              value={extendDays}
              onChange={(e) => setExtendDays(e.target.value.replace(/\D/g, ''))}
              className="mt-1"
            />
            <div className="mt-2 flex flex-wrap gap-2">
              {[7, 14, 30, 60, 90].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setExtendDays(String(d))}
                  className={`rounded-full border px-3 py-1 text-[11px] font-bold ${
                    days === d ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'
                  }`}
                >
                  +{d}d
                </button>
              ))}
            </div>
          </div>

          {preview && (
            <div className="rounded-2xl border border-primary/30 bg-primary/5 p-4">
              <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-primary">
                <TrendingUp className="h-3.5 w-3.5" /> After top-up
              </div>
              <div className="mt-2 space-y-1.5 text-sm">
                <Row label="Access fee on top-up" value={formatUGX(preview.fee)} />
                <Row label="New total outstanding" value={formatUGX(preview.newOutstanding)} bold />
                <Row label={`New ${frequencyLabel(frequency).toLowerCase()} payment`} value={formatUGX(preview.installment)} bold />
                <Row label="New end date" value={format(preview.newEnd, 'dd MMM yyyy')} />
              </div>
            </div>
          )}

          <div>
            <label className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Reason</label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why do you need this top-up? (at least 10 characters)"
              className="mt-1"
              rows={3}
            />
          </div>

          <Button
            className="w-full"
            disabled={submitMutation.isPending || topup <= 0 || overMax || underMin || days <= 0 || reason.trim().length < 10}
            onClick={() => submitMutation.mutate()}
          >
            {submitMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Submit top-up request
          </Button>
        </>
      )}
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground text-[12px]">{label}</span>
      <span className={bold ? 'font-bold text-foreground' : 'text-foreground'}>{value}</span>
    </div>
  );
}
