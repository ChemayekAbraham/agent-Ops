import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { RefreshCw, Loader2, CheckCircle2, AlertTriangle, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { normalizeMomoTid } from '@/lib/momoTid';
import { hapticTap } from '@/lib/haptics';
import { cn } from '@/lib/utils';

import { MERCHANT_QUEUE_STATUSES } from '@/lib/merchantPayoutQueue';
import { CLAIM_MESSAGES, outcomeFromClaimResponse, type ClaimRpcResponse } from '@/lib/merchantClaim';

const CASHOUT_QUEUE_STATUSES = MERCHANT_QUEUE_STATUSES as unknown as string[];

function last9(phone: string): string | null {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 9) return null;
  return digits.slice(-9);
}

interface Props {
  agentId: string;
  cashoutAgentId: string;
  onDone?: () => void;
}

/**
 * Reconcile-payment card for merchant agents. Covers the case where the app
 * reloaded (network hiccup, tab kill, cold start) after the merchant paid the
 * recipient but BEFORE they entered the TID in the normal claim flow — so the
 * withdrawal is stuck in the queue with no confirmation reference.
 *
 * The merchant types the recipient's name (label only), phone number and TID.
 * We resolve the phone to a profile, list their in-flight withdrawals, and
 * settle the chosen one through the same `approve-withdrawal` edge function
 * used by the standard confirm flow — so ledger, commission, and TID
 * uniqueness enforcement all go through the exact same server path.
 */
export function MerchantReconcilePaymentCard({ agentId, cashoutAgentId, onDone }: Props) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [tid, setTid] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const phoneKey = last9(phone) ?? '';
  const tidNorm = normalizeMomoTid(tid);

  // Merchant float balance — reconciliation still debits the merchant's
  // Welile float bucket (the cash they physically dispensed to the recipient),
  // so surface the current float and block submissions that would overdraw it.
  const { data: merchantFloat = 0 } = useQuery({
    queryKey: ['merchant-reconcile-float', agentId],
    enabled: !!agentId,
    staleTime: 15_000,
    queryFn: async () => {
      const { data } = await supabase
        .from('wallets')
        .select('float_balance')
        .eq('user_id', agentId)
        .maybeSingle();
      return Number((data as any)?.float_balance ?? 0);
    },
  });

  // Resolve the phone → profile, then list this recipient's in-flight
  // withdrawal requests with no TID yet. Only enabled once we have a plausible
  // 9-digit local phone.
  const { data: candidates = [], isFetching: loadingCandidates, refetch } = useQuery({
    queryKey: ['merchant-reconcile-candidates', phoneKey],
    enabled: phoneKey.length === 9,
    staleTime: 15_000,
    queryFn: async () => {
      const formats = [phoneKey, `0${phoneKey}`, `256${phoneKey}`, `+256${phoneKey}`];
      const { data: profs } = await supabase
        .from('profiles')
        .select('id, full_name, phone')
        .in('phone', formats)
        .limit(4);
      if (!profs || profs.length === 0) return [];
      const ids = profs.map((p: any) => p.id);
      const { data: rows } = await supabase
        .from('withdrawal_requests')
        .select('id, amount, status, payment_method, created_at, dispatched_at, user_id, transaction_id, assigned_cashout_agent_id, mobile_money_number, mobile_money_name')
        .in('user_id', ids)
        .in('status', CASHOUT_QUEUE_STATUSES)
        .is('transaction_id', null)
        .is('processed_at', null)
        .is('fin_ops_reference', null)
        .order('created_at', { ascending: false })
        .limit(20);
      const map = new Map<string, any>(profs.map((p: any) => [p.id, p]));
      return (rows || []).map((r: any) => ({ ...r, profile: map.get(r.user_id) }));
    },
  });

  // Pre-flight TID uniqueness — mirrors the server-side guard so we can block
  // the operator before we try to hit the edge function.
  const { data: tidConflict } = useQuery({
    queryKey: ['merchant-reconcile-tid', tidNorm],
    enabled: tidNorm.length >= 6,
    staleTime: 10_000,
    queryFn: async () => {
      const { data } = await supabase
        .from('withdrawal_requests')
        .select('id, status')
        .eq('transaction_id', tid.trim())
        .limit(1)
        .maybeSingle();
      return data ?? null;
    },
  });

  const chosen = useMemo(
    () => candidates.find((c: any) => c.id === selectedId) || null,
    [candidates, selectedId],
  );

  const chosenAmount = Number(chosen?.amount ?? 0);
  const insufficientFloat = !!chosen && chosenAmount > merchantFloat;

  const canSubmit =
    !!chosen &&
    tidNorm.length >= 6 &&
    !tidConflict &&
    !insufficientFloat &&
    !submitting;

  const handleSubmit = async () => {
    if (!chosen) {
      toast.error('Pick the withdrawal to reconcile.');
      return;
    }
    if (tidNorm.length < 6) {
      toast.error('Enter a valid TID.');
      return;
    }
    if (tidConflict) {
      toast.error('That TID is already recorded on another withdrawal.');
      return;
    }
    if (insufficientFloat) {
      toast.error('Not enough merchant float to cover this reconciliation.');
      return;
    }
    setSubmitting(true);
    try {
      // If the row isn't claimed by this merchant yet, claim it first so
      // approve-withdrawal accepts us as the settling merchant — through the
      // one canonical claim transaction (float reservation, one-active-claim,
      // idempotent retry), never a direct table write.
      if (chosen.assigned_cashout_agent_id !== cashoutAgentId) {
        const { data: claimRes, error: claimErr } = await supabase.rpc('claim_withdrawal_verified', {
          p_withdrawal_id: chosen.id,
          p_momo_number: chosen.mobile_money_number ?? null,
          p_momo_name: chosen.mobile_money_name ?? null,
        });
        if (claimErr) throw new Error(claimErr.message || 'Could not claim this withdrawal.');
        const claimed = outcomeFromClaimResponse(claimRes as unknown as ClaimRpcResponse);
        if (claimed.kind !== 'claimed') {
          throw new Error('message' in claimed ? claimed.message : CLAIM_MESSAGES.notClaimed);
        }
      }

      const { data, error } = await supabase.functions.invoke('approve-withdrawal', {
        body: {
          withdrawal_id: chosen.id,
          reference: tid.trim(),
          payment_method: chosen.payment_method || 'mobile_money',
          acting_as_merchant: true,
          reconciliation: true,
          reconciliation_note: name.trim() ? `Reconciled for ${name.trim()}` : 'Reconciled by merchant',
        },
      });
      if (error || (data as any)?.error) {
        throw new Error((data as any)?.error || error?.message || 'Failed to reconcile.');
      }
      toast.success(`Reconciled ${formatUGX(chosen.amount)} for ${chosen.profile?.full_name || 'recipient'}.`);
      setName('');
      setPhone('');
      setTid('');
      setSelectedId(null);
      refetch();
      onDone?.();
    } catch (e: any) {
      toast.error(e?.message || 'Reconcile failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="rounded-3xl border border-border/60 bg-card p-5">
      <div className="mb-4 flex items-center gap-2">
        <div className="flex h-9 w-9 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <RefreshCw className="h-4 w-4" />
        </div>
        <div>
          <h3 className="text-sm font-bold">Reconcile a payment</h3>
          <p className="text-xs text-muted-foreground">
            App reloaded before you entered the TID? Match a paid recipient to their pending withdrawal here.
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <label className="block">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Recipient name (as on MoMo)
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Aguma Christopher"
            className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm outline-none focus:border-primary"
          />
        </label>

        <label className="block">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Recipient phone
          </span>
          <input
            inputMode="tel"
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value);
              setSelectedId(null);
            }}
            placeholder="0772…"
            className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm outline-none focus:border-primary"
          />
        </label>

        {/* Candidate withdrawals */}
        {phoneKey.length === 9 && (
          <div className="rounded-2xl border border-border/60 bg-muted/30 p-2">
            {loadingCandidates ? (
              <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Looking up pending withdrawals…
              </div>
            ) : candidates.length === 0 ? (
              <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
                <AlertTriangle className="h-3.5 w-3.5" />
                No pending withdrawal found for this phone.
              </div>
            ) : (
              <ul className="divide-y divide-border/50">
                {candidates.map((c: any) => {
                  const selected = c.id === selectedId;
                  const claimedByMe = c.assigned_cashout_agent_id === cashoutAgentId;
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => {
                          hapticTap();
                          setSelectedId(c.id);
                        }}
                        className={cn(
                          'flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left transition',
                          selected ? 'bg-primary/10' : 'hover:bg-muted/60',
                        )}
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold">
                            {c.profile?.full_name || 'Unknown'} · {formatUGX(c.amount)}
                          </p>
                          <p className="truncate text-[11px] text-muted-foreground">
                            {c.payment_method || 'mobile_money'} · {c.status}
                            {claimedByMe ? ' · claimed by you' : ''}
                          </p>
                        </div>
                        {selected && <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        <label className="block">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Transaction ID (TID)
          </span>
          <input
            value={tid}
            onChange={(e) => setTid(e.target.value)}
            placeholder="e.g. MP40781351736"
            className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm outline-none focus:border-primary"
          />
          {tidNorm.length > 0 && tidNorm.length < 6 && (
            <p className="mt-1 text-[11px] text-amber-600">TID looks too short.</p>
          )}
          {tidConflict && (
            <p className="mt-1 text-[11px] font-semibold text-destructive">
              This TID is already recorded on another withdrawal — cannot reuse.
            </p>
          )}
        </label>

        {/* Merchant float disclosure — reconciliation debits the merchant's
            Welile float for the exact payout amount, matching the standard
            payout flow. Make that visible so the operator knows before submit. */}
        <div
          className={cn(
            'flex items-start gap-2 rounded-2xl border p-3 text-[11px]',
            insufficientFloat
              ? 'border-destructive/40 bg-destructive/5 text-destructive'
              : 'border-border/60 bg-muted/30 text-muted-foreground',
          )}
        >
          <Wallet className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="space-y-0.5">
            <p className="font-semibold">
              Your float: {formatUGX(merchantFloat)}
            </p>
            {chosen ? (
              insufficientFloat ? (
                <p>
                  Reconciling will try to deduct {formatUGX(chosenAmount)} from your float —
                  not enough. Ask the CFO/treasury to top up before reconciling.
                </p>
              ) : (
                <p>
                  Reconciling will deduct {formatUGX(chosenAmount)} from your float
                  (the cash you already dispensed). Float after: {formatUGX(merchantFloat - chosenAmount)}.
                </p>
              )
            ) : (
              <p>Pick a withdrawal above to see the float that will be deducted.</p>
            )}
          </div>
        </div>

        <motion.button
          type="button"
          whileTap={{ scale: 0.97 }}
          disabled={!canSubmit}
          onClick={handleSubmit}
          className={cn(
            'flex w-full items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-bold transition',
            canSubmit
              ? 'bg-primary text-primary-foreground shadow-lg shadow-primary/20'
              : 'bg-muted text-muted-foreground',
          )}
        >
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Reconciling…
            </>
          ) : (
            <>Reconcile payment</>
          )}
        </motion.button>
      </div>
    </section>
  );
}

export default MerchantReconcilePaymentCard;