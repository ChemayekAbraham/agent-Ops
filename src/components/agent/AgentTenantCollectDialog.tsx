"use client";
import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, Banknote, AlertCircle, CheckCircle2, Wallet, TrendingUp, WifiOff, ShieldAlert, Unlock, MessageSquare, RefreshCw, XCircle, Info } from 'lucide-react';
import { toast } from 'sonner';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useAgentBalances } from '@/hooks/useAgentBalances';
import { invalidateCreditAccessLimit, useCreditAccessLimit, formatCreditAmount } from '@/hooks/useCreditAccessLimit';
import { formatUGX } from '@/lib/rentCalculations';
import { extractFromErrorObject } from '@/lib/extractEdgeFunctionError';
import { useOffline } from '@/contexts/OfflineContext';
import { CommissionCelebration } from './CommissionCelebration';
import { captureOfflineDraft } from '@/lib/offlineCollectionDrafts';
import { setCriticalFlowActive } from '@/lib/criticalFlowGuard';
import { logCollectionError } from '@/lib/logCollectionError';
import AgentContactLocationGate from './AgentContactLocationGate';
import { useRequireContactLocation } from '@/hooks/useRequireContactLocation';
import { useAgentCollectContext, useInvalidateArrears } from '@/hooks/useAgentArrears';
import {
  hasArrears,
  splitPayment,
  arrearsHeadline,
  totalDueNow,
  isPartialPayment,
  paymentShortfall,
} from '@/lib/arrearsAllocation';

/**
 * Translate raw RPC / Postgres errors into something an agent can act on.
 * Two flavours:
 *  - structured `error_code` from `agent_allocate_tenant_payment`
 *  - raw constraint message ("new row for relation 'wallets' violates check
 *    constraint 'wallets_balance_check'") that bubbles up from the wallet
 *    sole-writer trigger when the cached balance is stale.
 */
function tidMessage(balance: number, requested: number): string {
  return `You can collect up to ${formatUGX(balance)}. Deposit ${formatUGX(Math.max(0, requested - balance))} more to continue.`;
}

function humanizeAllocationError(
  message: string,
  code?: string,
  details?: {
    strict_float?: number | null;
    cached_float?: number | null;
    requested?: number | null;
    expected_amount?: number | null;
    shortfall_amount?: number | null;
  },
): string {
  if (code === 'COMMISSION_LEDGER_INCONSISTENT') {
    return 'Float allocation paused — your commission ledger is out of balance. Support has been notified and will reconcile your wallet shortly.';
  }

  if (code === 'INSUFFICIENT_FLOAT') {
    const strict = Number(details?.strict_float ?? 0);
    const cached = Number(details?.cached_float ?? 0);
    const requested = Number(details?.requested ?? 0);
    const available = Math.max(0, Math.min(strict, cached));
    const shortBy = Math.max(0, requested - available);
    const parts = [
      `Insufficient wallet float to allocate ${formatUGX(requested)}.`,
      `Available wallet float: ${formatUGX(available)}${shortBy > 0 ? ` (short by ${formatUGX(shortBy)})` : ''}.`,
    ];
    if (Number.isFinite(strict) && strict !== cached) {
      parts.push(`Verified ledger float: ${formatUGX(strict)} · Cached: ${formatUGX(cached)}.`);
    }
    parts.push('Top up Agent Float Allocation, then retry.');
    return parts.join(' ');
  }

  if (code === 'DAILY_FLOAT_CAP_EXCEEDED') {
    return `${message} If you have genuinely collected more cash than your float allows today, ask Finance to top up your float.`;
  }

  if (code === 'DUPLICATE_SUBMISSION_SUSPECTED') {
    return `${message} If this tenant genuinely made a second payment, wait a moment and refresh their balance before retrying.`;
  }
  const m = (message || '').toLowerCase();
  if (m.includes('wallets_balance_check') || m.includes('violates check constraint')) {
    return 'Your wallet float is temporarily out of sync with the ledger. We have flagged this for review — please retry in a moment.';
  }
  if (m.includes('amount exceeds outstanding')) {
    // Already a clean message from the RPC — leave it.
    return message;
  }
  if (m.includes('rent request not found')) {
    return 'This rent plan could not be located. Please refresh and try again.';
  }
  return message;
}

interface AgentTenantCollectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenant: { id: string; full_name: string; phone: string } | null;
  rentRequestId: string;
  outstandingBalance: number;
  onSuccess?: () => void;
}

export function AgentTenantCollectDialog({
  open, onOpenChange, tenant, rentRequestId, outstandingBalance, onSuccess,
}: AgentTenantCollectDialogProps) {
  const { user } = useAuth();
  const locGate = useRequireContactLocation(tenant?.id ?? null, 'tenant', tenant?.full_name);
  const { floatBalance, refetch: refetchBalances } = useAgentBalances(user?.id);
  const { limit: creditLimit } = useCreditAccessLimit(user?.id);
  const queryClient = useQueryClient();
  const { isOnline } = useOffline();
  const [amount, setAmount] = useState<number>(0);
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [confirming, setConfirming] = useState(false);
  const [celebrationOpen, setCelebrationOpen] = useState(false);
  const [celebrationData, setCelebrationData] = useState<{ commission: number; amount: number } | null>(null);
  const [draftSaved, setDraftSaved] = useState<{ provisional_receipt_no: string; amount: number } | null>(null);
  const [rpcError, setRpcError] = useState<string | null>(null);
  const [tidBlock, setTidBlock] = useState<{ requested: number; balance: number } | null>(null);
  // When the agent taps "Do it later" on the location gate, we let them
  // proceed to the allocation form instead of closing the whole flow.
  const [locationSkipped, setLocationSkipped] = useState(false);
  // Best-effort tenant SMS status for the allocation notification, so the
  // agent can see if it failed and manually resend from the success view.
  const [smsStatus, setSmsStatus] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  const [smsResending, setSmsResending] = useState(false);
  const [partialReason, setPartialReason] = useState('');
  // Today's expected amount AND this plan's arrears context in ONE round trip.
  // `expected_today` is computed server-side by the same `agent_expected_collection`
  // helper the allocation RPC uses, so the screen and the gate keep one
  // definition — no duplicated fee arithmetic here.
  const { data: collectCtx } = useAgentCollectContext(rentRequestId, open);
  const invalidateArrears = useInvalidateArrears();
  const behind = hasArrears(collectCtx);

  useEffect(() => {
    if (open) {
      setAmount(0);
      setNotes('');
      setResult(null);
      setConfirming(false);
      setDraftSaved(null);
      setRpcError(null);
      setTidBlock(null);
      setSmsStatus('idle');
      setSmsResending(false);
      setPartialReason('');
      refetchBalances();
    }
  }, [open]);

  // While the tenant-collection dialog is open, suppress iOS PWA full
  // cache invalidation and SW skipWaiting. Otherwise switching to MoMo /
  // Messages for the agent OTP looks like the app refreshed mid-flow.
  useEffect(() => {
    if (!open) return;
    setCriticalFlowActive('agent-tenant-collect', true);
    return () => setCriticalFlowActive('agent-tenant-collect', false);
  }, [open]);

  const maxAllowable = Math.max(0, Math.min(outstandingBalance, floatBalance));
  // Read-only: float backed by verified deposits (what the server actually checks).
  const { data: tidData, refetch: refetchTid } = useQuery({
    queryKey: ['agent-tid-backed-float', user?.id],
    enabled: !!user?.id && open,
    staleTime: 15_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_tid_backed_float')
        .select('balance')
        .eq('agent_id', user!.id)
        .maybeSingle();
      if (error) throw error;
      return Number(data?.balance ?? 0);
    },
  });
  const tidBalance: number | null = tidData ?? null;
  // The server's own figure wins right after a rejection.
  const effectiveTid = tidBlock ? tidBlock.balance : tidBalance;
  const tidLocked = !!tidBlock && tidBlock.requested === amount && (tidBalance === null || tidBalance === tidBlock.balance);
  const tidWarning =
    effectiveTid !== null && amount > effectiveTid && amount > 0
      ? tidMessage(effectiveTid, amount)
      : null;
  // Final-settlement rule: normally UGX 100 minimum, but when the tenant owes
  // less than 100 the agent must still be able to clear the last shillings.
  const minAllowed = outstandingBalance > 0 ? Math.min(100, outstandingBalance) : 100;
  const canAllocate = floatBalance >= minAllowed && outstandingBalance >= minAllowed && outstandingBalance > 0;
  // Partial collections are ALLOWED and simply tracked — no gate, no forced
  // confirmation, no mandatory reason. The reason box stays as an optional note
  // so Operations still gets context in the Partial Collections view.
  const expected = Math.max(0, Number(collectCtx?.expected_today ?? 0));
  // Judged against EVERYTHING owed — the unpaid earlier days plus what is still
  // open on today — capped at the outstanding balance, exactly as the server
  // now stamps the receipt. Measuring against today alone reported a tenant
  // five days behind as "paid in full" the moment one day's money arrived.
  const totalDue = Math.min(totalDueNow(collectCtx), maxAllowable);
  const isPartial = isPartialPayment(collectCtx, amount, maxAllowable);
  const shortfall = paymentShortfall(collectCtx, amount, maxAllowable);
  const isValid = amount >= minAllowed && amount <= maxAllowable;
  // How the server will apply this payment: oldest unpaid days first, then
  // today, then ahead. Preview only — the RPC does the real allocation.
  const split = splitPayment(collectCtx, amount);

  // Auto-suggest the EXPECTED amount (not the maximum) so the default action is
  // a complete collection. Falls back to the old behaviour when unknown.
  useEffect(() => {
    if (!open || amount !== 0 || maxAllowable < minAllowed) return;
    const suggestion = expected > 0 ? Math.min(expected, maxAllowable) : maxAllowable;
    if (suggestion >= minAllowed) setAmount(suggestion);
  }, [open, maxAllowable, minAllowed, expected]);



  const handleAllocate = async () => {
    // Defensive logging — previously this handler appeared to "fail
    // silently" because the click never reached it (nested Dialog
    // portal blocked pointer events on some iOS PWA versions). The
    // confirmation Dialog is now a sibling of the parent so each gets
    // its own overlay layer. Logs stay so any regression is visible.
    console.log('[AgentTenantCollectDialog] Confirm clicked', {
      hasUser: !!user, isValid, hasTenant: !!tenant, amount,
    });
    if (!user || !isValid || !tenant) {
      console.warn('[AgentTenantCollectDialog] Confirm aborted — guard failed', {
        hasUser: !!user, isValid, hasTenant: !!tenant, amount, maxAllowable, floatBalance,
      });
      return;
    }
    setLoading(true);
    setRpcError(null);
    const submittedAt = new Date().toISOString();
    // Progressive feedback so Chrome users on slow networks don't feel
    // the app has frozen. Two toasts at 4s and 10s, cancelled on resolve.
    const slowToast = setTimeout(() => {
      toast.loading('Still processing… holding your float steady.', {
        id: 'allocate-progress',
      });
    }, 4000);
    const verySlowToast = setTimeout(() => {
      toast.loading('Network is slow — waiting a few more seconds. Do NOT tap again.', {
        id: 'allocate-progress',
      });
    }, 10000);
    try {
      // This is a financial mutation: issue it exactly once and wait for the
      // authoritative response. A client timeout or automatic retry can
      // duplicate an allocation when the server commits but the response is
      // lost on a weak mobile connection.
      //
      // A stalled mobile connection can leave this fetch pending forever —
      // that is what looked like "Confirm fails silently" (spinner never
      // resolves, no toast). We cap the wait, then RECONCILE against the
      // server instead of retrying, so a committed allocation is reported as
      // success and never allocated twice.
      //
      // client_ref: a fresh id per Confirm click, so if this exact network
      // call is ever resent (browser/service-worker replay, a double-fired
      // handler) the server returns the original receipt instead of a second
      // collection + a second commission payout.
      const clientRef = crypto.randomUUID();
      const rpcPromise = supabase.rpc('agent_allocate_tenant_payment', {
          p_agent_id: user.id,
          p_tenant_id: tenant.id,
          p_rent_request_id: rentRequestId,
          p_amount: amount,
          p_notes: notes.trim() || null,
          // Tracking only — partials are never blocked.
          p_partial_confirmed: true,
          p_partial_reason: isPartial ? partialReason.trim() || null : null,
          p_client_ref: clientRef,

        });
      const STALL_MS = 45000;
      const raced = await Promise.race([
        rpcPromise,
        new Promise<'stalled'>((resolve) => setTimeout(() => resolve('stalled'), STALL_MS)),
      ]);

      if (raced === 'stalled') {
        // Ask the server what actually happened. If the row exists, the money
        // moved — treat as success and refresh rather than letting the agent
        // tap Confirm again.
        const { data: rows } = await supabase
          .from('agent_collections')
          .select('id, amount, created_at').is('reversed_at', null)
          .eq('agent_id', user.id)
          .eq('tenant_id', tenant.id)
          .eq('amount', amount)
          .gte('created_at', submittedAt)
          .limit(1);

        if (rows && rows.length > 0) {
          setConfirming(false);
          refetchBalances();
          invalidateCreditAccessLimit(user.id);
          queryClient.invalidateQueries({ queryKey: ['agent-capacity-map'] });
          queryClient.invalidateQueries({ queryKey: ['agent-rent-capacity-fleet'] });
          // Day attribution changed too, so the arrears split must be re-read.
          invalidateArrears({ rentRequestId, agentId: user.id });
          toast.success('Payment already recorded', {
            description: `${formatUGX(amount)} for ${tenant.full_name} went through. Do not send it again.`,
          });
          onSuccess?.();
          onOpenChange(false);
          return;
        }

        // Critical: the agent may be holding cash the system has no record of.
        logCollectionError({
          phase: 'allocate_stalled',
          severity: 'critical',
          message: `Request stalled after ${STALL_MS}ms and no matching collection was found on reconcile`,
          errorCode: 'NETWORK_STALLED',
          tenantId: tenant.id,
          rentRequestId,
          amount,
          clientRef,
          context: { stall_ms: STALL_MS, submitted_at: submittedAt },
        });

        throw new Error(
          'The network stalled before we got a confirmation. This payment was NOT recorded. Refresh the tenant balance and try again.',
        );
      }

      const { data, error } = raced;

      if (error) {
        const message = await extractFromErrorObject(error, 'Allocation failed');
        console.error('[AgentTenantCollectDialog] allocation RPC failed:', message, error);
        logCollectionError({
          phase: 'allocate',
          message,
          errorCode: (error as { code?: string })?.code ?? null,
          tenantId: tenant.id,
          rentRequestId,
          amount,
          clientRef,
        });
        throw new Error(humanizeAllocationError(message));
      }

      const res = data as any;
      if (!res?.success || res?.error) {
        const rawMsg = res?.error || 'Allocation failed. Please try again.';
        const message = res?.error_code
          ? humanizeAllocationError(rawMsg, res.error_code, {
              strict_float: res?.strict_float ?? res?.metadata?.strict_float,
              cached_float: res?.cached_float ?? res?.metadata?.cached_float,
              requested: res?.entered_amount ?? res?.requested ?? amount,
              expected_amount: res?.expected_amount ?? expected,
              shortfall_amount: res?.shortfall_amount ?? shortfall,

            })
          : humanizeAllocationError(rawMsg);
        console.error('[AgentTenantCollectDialog] allocation rejected:', res);
        if (res?.error_code === 'INSUFFICIENT_TID_BACKED_FLOAT') {
          const bal = Math.max(0, Number(res?.tid_backed_balance ?? 0));
          const req = Number(res?.requested ?? amount);
          setTidBlock({ requested: req, balance: bal });
          throw new Error(tidMessage(bal, req));
        }
        logCollectionError({
          phase: 'allocate_rejected',
          // A rejection the engine understood is a warning; the agent can act on
          // it. An unlabelled one is an error, because nobody planned for it.
          severity: res?.error_code ? 'warning' : 'error',
          message: String(rawMsg),
          errorCode: res?.error_code ?? null,
          tenantId: tenant.id,
          rentRequestId,
          amount,
          clientRef,
          context: {
            strict_float: res?.strict_float ?? res?.metadata?.strict_float ?? null,
            cached_float: res?.cached_float ?? res?.metadata?.cached_float ?? null,
            expected_amount: res?.expected_amount ?? expected ?? null,
          },
        });
        throw new Error(message);
      }

      setResult(res);
      setConfirming(false);
      refetchBalances();
      // Refresh the agent's "advance you can access" card so the new
      // allocation (and its commission/bonus) is reflected immediately.
      invalidateCreditAccessLimit(user.id);
      // Today vs Expected report (self-card + executive fleet panel) is
      // driven by `repayments` rows the RPC just inserted — invalidate
      // BOTH cached queries so the new allocation shows up immediately.
      queryClient.invalidateQueries({ queryKey: ['agent-capacity-map'] });
      queryClient.invalidateQueries({ queryKey: ['agent-rent-capacity-fleet'] });
      // The RPC also attributed this payment to specific days - re-read the
      // arrears context so a second collection never shows a stale split.
      invalidateArrears({ rentRequestId, agentId: user.id });

      // 🎉 Trigger commission celebration — pure UI, no DB calls
      // Source priority: API response → fallback to client-side 10% estimate
      const earnedCommission = Number(res?.commission?.credited_commission)
        || Math.round(amount * 0.10);
      if (earnedCommission > 0) {
        setCelebrationData({ commission: earnedCommission, amount });
        setCelebrationOpen(true);
      }

      toast.success('Payment allocated!', {
        description: `${formatUGX(amount)} moved from wallet float for ${tenant.full_name}`,
      });

      // Fire-and-forget: email the agent a friendly receipt + today's report
      // + their current wallet capacity. Never blocks the allocation flow.
      try {
        supabase.functions
          .invoke('send-agent-payment-receipt-email', {
            body: {
              agent_id: user.id,
              tenant_id: tenant.id,
              rent_request_id: rentRequestId,
              amount,
              commission: earnedCommission,
              allocation_id: res?.collection_id || res?.tracking_id || null,
            },
          })
          .catch((e) => console.warn('[AgentTenantCollectDialog] receipt email failed', e));
      } catch (e) {
        console.warn('[AgentTenantCollectDialog] receipt email dispatch failed', e);
      }

      // Fire-and-forget: send the tenant a branded SMS card linking
      // to their live "Rent Money You Can Get" page. Never blocks the
      // allocation flow — failures are logged client-side and surfaced
      // as a non-blocking toast hint.
      if (tenant.phone) {
        // Fire-and-forget initial best-effort send; status is tracked so the
        // success view can offer a manual resend if it fails.
        void sendAllocationSms({
          paidAmount: amount,
          remaining: Math.max(0, outstandingBalance - amount),
        });
      }
    } catch (err: any) {
      const raw = err instanceof Error ? err.message : 'Allocation failed. Please try again.';
      const rawLower = raw.toLowerCase();
      const msg =
        rawLower.includes('failed to fetch') ||
        rawLower.includes('networkerror') ||
        rawLower.includes('load failed')
          ? 'Connection dropped before confirmation was received. Refresh the tenant balance before trying again so the payment is not allocated twice.'
          : raw;
      // Keep the user IN the confirming view and show the reason inline so
      // they can act on it (reduce amount, top up float, etc.) instead of
      // experiencing it as a "button does nothing" failure.
      setRpcError(msg);
      toast.error('Allocation failed', { description: msg });
    } finally {
      clearTimeout(slowToast);
      clearTimeout(verySlowToast);
      toast.dismiss('allocate-progress');
      setLoading(false);
    }
  };

  const handleClose = () => {
    if (result || draftSaved) onSuccess?.();
    setLocationSkipped(false);
    onOpenChange(false);
  };

  // Send (or resend) the branded allocation SMS to the tenant. Tracks
  // status so the success view can show "sent / failed" and offer a
  // manual resend if the initial best-effort attempt failed.
  const sendAllocationSms = async (opts: {
    paidAmount: number;
    remaining: number;
    isResend?: boolean;
  }): Promise<boolean> => {
    if (!tenant?.phone) return false;
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const shareUrl = origin ? `${origin}/limit/${tenant.id}` : null;
    if (opts.isResend) setSmsResending(true);
    else setSmsStatus('sending');
    try {
      const { error, data } = await supabase.functions.invoke('send-rent-access-sms', {
        body: {
          tenant_id: tenant.id,
          tenant_name: tenant.full_name,
          tenant_phone: tenant.phone,
          share_url: shareUrl,
          allocation_amount: opts.paidAmount,
          paid_amount: opts.paidAmount,
          remaining_balance: opts.remaining,
          mode: 'allocation',
        },
      });
      const ok = !error && Boolean(data?.success);
      setSmsStatus(ok ? 'sent' : 'failed');
      if (user) {
        void import('@/lib/rentAccessShareAudit').then(({ recordRentAccessShare }) =>
          recordRentAccessShare({
            agentId: user.id,
            tenantId: tenant.id,
            tenantName: tenant.full_name,
            tenantPhone: tenant.phone,
            channel: 'sms',
            limitAmount: null,
            shareUrl,
            success: ok,
            errorMessage: error?.message ?? (ok ? null : 'carrier_rejected'),
            metadata: {
              mode: 'allocation',
              allocation_amount: opts.paidAmount,
              auto: !opts.isResend,
              resend: Boolean(opts.isResend),
            },
          }),
        );
      }
      if (opts.isResend) {
        if (ok) toast.success('SMS resent to tenant');
        else toast.error('SMS resend failed', { description: 'The carrier rejected the message. Try again shortly.' });
      } else if (!ok) {
        console.warn('[AgentTenantCollectDialog] auto SMS failed', error, data);
      }
      return ok;
    } catch (e) {
      console.warn('[AgentTenantCollectDialog] SMS send threw', e);
      setSmsStatus('failed');
      if (opts.isResend) toast.error('SMS resend failed');
      return false;
    } finally {
      if (opts.isResend) setSmsResending(false);
    }
  };

  const handleSaveOfflineDraft = async () => {
    if (!user || !tenant || amount < minAllowed) return;
    setLoading(true);
    try {
      const draft = await captureOfflineDraft({
        agent_id: user.id,
        tenant_id: tenant.id,
        tenant_name: tenant.full_name,
        rent_request_id: rentRequestId,
        amount,
        notes,
      });
      setDraftSaved({ provisional_receipt_no: draft.provisional_receipt_no, amount });
      toast.success('Saved on your phone', {
        description: `Receipt ${draft.provisional_receipt_no}. Add proof when back online.`,
      });
    } catch (err: any) {
      console.error('[AgentTenantCollectDialog] offline draft save failed:', err);
      toast.error('Could not save draft', {
        description: err?.message || 'Please try again.',
      });
    } finally {
      setLoading(false);
    }
  };

  if (!tenant) return null;

  // Force agent to capture the tenant's location BEFORE the collect dialog mounts.
  // "Do it later" skips the gate for this session so the agent can still
  // allocate the tenant's repayment.
  if (open && locGate.needsCapture && !locationSkipped) {
    return (
      <AgentContactLocationGate
        open
        targetId={tenant.id}
        targetRole="tenant"
        targetName={tenant.full_name}
        blocking={false}
        onComplete={() => locGate.onCaptured()}
        onCancel={() => setLocationSkipped(true)}
      />
    );
  }

  return (
    <>
    <Dialog open={open} onOpenChange={(o) => { if (!o && !loading) handleClose(); }}>
      <DialogContent
        className={
          // Mobile: true bottom sheet (slides from bottom, ~88vh, internal
          // scroll, sticky header). Desktop: standard centered card.
          [
            "app-dialog-bottom-sheet",
            "!left-0 !right-0 !top-auto !bottom-0",
            "!translate-x-0 !translate-y-0",
            "!max-w-none !w-full",
            "!rounded-t-3xl !rounded-b-none",
            "!p-0 !gap-0",
            "h-[88vh]",
            "flex flex-col overflow-hidden",
            "pointer-events-auto",
            "sm:!left-[50%] sm:!top-[50%] sm:!bottom-auto sm:!right-auto",
            "sm:!translate-x-[-50%] sm:!translate-y-[-50%]",
            "sm:!max-w-md sm:!w-full",
            "sm:!rounded-2xl",
            "sm:h-auto sm:max-h-[90vh]",
          ].join(" ")
        }
        onInteractOutside={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        <div className="sm:hidden flex justify-center pt-2 pb-1 shrink-0">
          <div className="h-1.5 w-12 rounded-full bg-muted-foreground/30" />
        </div>
        <DialogHeader className="shrink-0 px-5 pt-2 pb-3 border-b border-border/50 bg-background">
          <DialogTitle className="flex items-center gap-2 text-base text-left">
            {confirming ? (
              <>
                <AlertCircle className="h-5 w-5 text-warning" />
                Confirm Payment
              </>
            ) : (
              <>
                <Banknote className="h-5 w-5 text-success" />
                Pay for {tenant.full_name}
              </>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-3 overscroll-contain pb-[calc(env(safe-area-inset-bottom)+16px)]">
        {/* Body: on the entry form it's the educational "how it grows" card.
            On the Confirm Payment step it switches to a live readout of the
            agent's current borrow limit and the impact of THIS allocation. */}
        {confirming ? (() => {
          const CAP = 30_000_000;
          const current = Math.min(creditLimit.totalLimit, CAP);
          const headroom = Math.max(0, CAP - current);
          const boost = Math.min(Math.round(amount * 2), headroom);
          const next = current + boost;
          return (
            <div className="rounded-2xl p-3.5 bg-gradient-to-br from-purple-600 via-purple-700 to-fuchsia-700 text-white shadow-lg shadow-purple-900/20 border border-purple-400/30">
              <div className="text-[10px] uppercase tracking-wider font-bold text-purple-100/90">
                Money you can borrow
              </div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-2xl font-black font-mono leading-none">{formatCreditAmount(current).trim()}</span>
                {boost > 0 && (
                  <span className="text-[11px] font-bold text-emerald-200">+ {formatCreditAmount(boost).trim()}</span>
                )}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-1.5 text-center">
                <div className="rounded-lg bg-white/10 px-2 py-1.5">
                  <div className="text-[9px] text-purple-100/80 font-medium uppercase tracking-wider">This allocation adds</div>
                  <div className="text-[12px] font-extrabold">+ {formatCreditAmount(boost).trim()}</div>
                </div>
                <div className="rounded-lg bg-white/15 px-2 py-1.5 ring-1 ring-white/25">
                  <div className="text-[9px] text-purple-100/80 font-medium uppercase tracking-wider">New borrow limit</div>
                  <div className="text-[12px] font-extrabold">{formatCreditAmount(next).trim()}</div>
                </div>
              </div>
              {boost === 0 && headroom === 0 && (
                <p className="text-[10px] text-purple-100/80 mt-1.5">You're already at the UGX 30M cap.</p>
              )}
            </div>
          );
        })() : (
        <div className="rounded-2xl p-3.5 bg-gradient-to-br from-purple-600 via-purple-700 to-fuchsia-700 text-white shadow-lg shadow-purple-900/20 border border-purple-400/30">
          <div className="flex items-start gap-3">
            <div className="h-9 w-9 rounded-xl bg-white/15 backdrop-blur flex items-center justify-center shrink-0 ring-1 ring-white/20">
              <TrendingUp className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[10px] uppercase tracking-wider font-bold text-purple-100/90">
                How your Agent Advance grows
              </div>
              <div className="text-[13px] font-semibold leading-snug mt-0.5">
                Every shilling you allocate to a tenant&apos;s rent adds{' '}
                <span className="font-extrabold">2×</span> that amount to your Agent Advance limit.
              </div>
              <div className="mt-2 grid grid-cols-3 gap-1.5 text-center">
                <div className="rounded-lg bg-white/10 px-1.5 py-1">
                  <div className="text-[9px] text-purple-100/80 font-medium">You allocate</div>
                  <div className="text-[11px] font-bold">UGX 100K</div>
                </div>
                <div className="rounded-lg bg-white/10 px-1.5 py-1">
                  <div className="text-[9px] text-purple-100/80 font-medium">Limit grows by</div>
                  <div className="text-[11px] font-bold">+ UGX 200K</div>
                </div>
                <div className="rounded-lg bg-white/15 px-1.5 py-1 ring-1 ring-white/25">
                  <div className="text-[9px] text-purple-100/80 font-medium">Max cap</div>
                  <div className="text-[11px] font-bold">UGX 30M</div>
                </div>
              </div>
            </div>
          </div>
        </div>
        )}

        {draftSaved ? (
          /* ───── Offline draft saved (provisional receipt) ───── */
          <div className="space-y-4 py-2">
            <div className="flex flex-col items-center gap-2 text-center">
              <div className="w-14 h-14 rounded-full bg-warning/15 flex items-center justify-center">
                <WifiOff className="h-7 w-7 text-warning" />
              </div>
              <h3 className="text-lg font-bold">Saved on your phone</h3>
              <p className="text-xs text-muted-foreground max-w-[280px]">
                This payment record is on this device only. It will be sent to Welile Operations once you go online and add proof.
              </p>
            </div>

            <div className="bg-muted/30 rounded-xl p-3 space-y-1.5 text-sm border-2 border-dashed border-warning/40">
              <p className="text-[10px] uppercase tracking-wider text-warning font-bold">Provisional receipt</p>
              <p className="font-mono text-base font-bold">{draftSaved.provisional_receipt_no}</p>
              <div className="flex justify-between text-xs pt-1">
                <span className="text-muted-foreground">Amount</span>
                <span className="font-mono font-bold">{formatUGX(draftSaved.amount)}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Tenant</span>
                <span className="font-semibold">{tenant.full_name}</span>
              </div>
              <p className="text-[10px] text-muted-foreground pt-1 border-t border-border/40 mt-1">
                Tell the tenant: <span className="italic">"Welile will confirm by SMS once I upload proof."</span>
              </p>
            </div>

            <div className="flex items-start gap-2 rounded-xl bg-primary/5 border border-primary/20 p-3">
              <ShieldAlert className="h-4 w-4 text-primary shrink-0 mt-0.5" />
              <p className="text-[11px] text-muted-foreground">
                When you have data, open <span className="font-semibold">Pending Sync</span> on your dashboard, attach a photo or signature, then submit.
              </p>
            </div>

            <Button onClick={handleClose} className="w-full h-12 font-bold">Done</Button>
          </div>
        ) : confirming ? (
          /* ───── Confirmation View (in same dialog overlay — fixes iOS PWA silent-click bug) ───── */
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground text-center">
              Double-check the amount before allocating. This cannot be undone.
            </p>

            <div className="bg-muted/40 rounded-xl p-4 space-y-2.5 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tenant</span>
                <span className="font-bold">{tenant.full_name}</span>
              </div>
              <div className="flex justify-between items-baseline border-t border-border/40 pt-2.5">
                <span className="text-muted-foreground">Amount</span>
                <span className="font-mono font-black text-2xl text-primary">{formatUGX(amount)}</span>
              </div>
              {expected > 0 && (
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Expected</span>
                  <span className="font-mono">{formatUGX(expected)}</span>
                </div>
              )}
              {isPartial && (
                <div className="flex justify-between text-xs">
                  <span className="text-warning font-semibold">Shortfall (partial)</span>
                  <span className="font-mono font-bold text-warning">−{formatUGX(shortfall)}</span>
                </div>
              )}

              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Float after</span>
                <span className="font-mono">{formatUGX(floatBalance - amount)}</span>
              </div>

              {/* Where this exact amount lands. Mirrors the server's oldest-day-first
                  allocation; the three lines always add back to Amount. */}
              {behind && (
                <div className="border-t border-border/40 pt-2 space-y-1.5">
                  <p className="text-[11px] font-bold text-warning-foreground">
                    {arrearsHeadline(collectCtx, formatUGX)}
                  </p>
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">
                      → Older unpaid days
                      {split.daysCleared > 0 && (
                        <span className="text-[10px] text-muted-foreground/80">
                          {' '}(clears {split.daysCleared} of {split.daysBehind})
                        </span>
                      )}
                    </span>
                    <span className="font-mono font-bold text-warning">{formatUGX(split.toArrears)}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">→ Today</span>
                    <span className="font-mono">{formatUGX(split.toToday)}</span>
                  </div>
                  {split.toFuture > 0 && (
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">→ Paid ahead</span>
                      <span className="font-mono">{formatUGX(split.toFuture)}</span>
                    </div>
                  )}
                  {split.nothingLandsOnToday && (
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      The older days take all of it, so today stays open. The money is not lost — it
                      has cleared the days behind.
                    </p>
                  )}
                </div>
              )}
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Tenant still owes</span>
                <span className="font-mono">{formatUGX(outstandingBalance - amount)}</span>
              </div>
              <div className="flex justify-between text-xs border-t border-border/40 pt-2">
                <span className="text-success font-semibold">Your commission (10%)</span>
                <span className="font-mono font-bold text-success">+{formatUGX(Math.round(amount * 0.10))}</span>
              </div>
              {(() => {
                const CAP = 30_000_000;
                const current = Math.min(creditLimit.totalLimit, CAP);
                const headroom = Math.max(0, CAP - current);
                const boost = Math.min(Math.round(amount * 2), headroom);
                const next = current + boost;
                return (
                  <>
                    <div className="flex justify-between text-xs border-t border-border/40 pt-2">
                      <span className="text-muted-foreground">Your Advance (now)</span>
                      <span className="font-mono">{formatCreditAmount(current).trim()}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-primary font-semibold">New Advance limit</span>
                      <span className="font-mono font-bold text-primary">
                        {formatCreditAmount(next).trim()}
                        {boost > 0 && (
                          <span className="ml-1 text-success">(+{formatCreditAmount(boost).trim()})</span>
                        )}
                      </span>
                    </div>
                  </>
                );
              })()}
            </div>

            {rpcError && (
              <div className="rounded-xl bg-destructive/10 border border-destructive/30 p-3 flex items-start gap-2">
                <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                <div className="text-[11px] text-destructive leading-relaxed">
                  <p className="font-semibold mb-0.5">Could not complete allocation</p>
                  <p className="text-destructive/90">{rpcError}</p>
                  <p className="text-destructive/70 mt-1">Tap Edit to change the amount, or top up your float and try again.</p>
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                className="flex-1 h-12"
                onClick={() => { setRpcError(null); setConfirming(false); }}
                disabled={loading}
                style={{ touchAction: 'manipulation' }}
              >
                Edit
              </Button>
              <Button
                type="button"
                className="flex-1 h-12 font-bold"
                onClick={handleAllocate}
                disabled={loading || tidLocked}
                style={{ touchAction: 'manipulation' }}
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <CheckCircle2 className="h-4 w-4 mr-2" />}
                Confirm
              </Button>
            </div>
          </div>
        ) : !isOnline && !result ? (
          /* ───── Offline capture form ───── */
          <div className="space-y-3">
            <div className="rounded-xl bg-warning/10 border border-warning/30 p-3 flex items-start gap-2">
              <WifiOff className="h-4 w-4 text-warning shrink-0 mt-0.5" />
              <div className="text-[11px]">
                <p className="font-semibold text-warning-foreground">Offline mode — record only</p>
                <p className="text-muted-foreground">Saved on this phone. Float won't change yet. You'll add proof and submit when you go online.</p>
              </div>
            </div>

            <div className="rounded-xl bg-destructive/5 border border-destructive/20 p-3 text-center">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{tenant.full_name} Owes (last known)</p>
              <p className="text-xl font-bold text-destructive font-mono">{formatUGX(outstandingBalance)}</p>
            </div>

            <div>
              <Label className="text-xs">Amount Collected (UGX) *</Label>
              <Input
                type="number"
                inputMode="numeric"
                placeholder="e.g. 13000"
                value={amount || ''}
                onChange={e => setAmount(Number(e.target.value))}
                min={minAllowed}
                max={outstandingBalance || undefined}
                className="h-12 text-lg font-mono font-bold"
              />
            </div>

            <div>
              <Label className="text-xs">Notes (optional)</Label>
              <Textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="e.g. Paid in cash at the shop"
                className="text-xs min-h-[60px]"
              />
            </div>

            <div className="flex gap-2 pt-1">
              <Button variant="outline" onClick={handleClose} className="flex-1 h-11" disabled={loading}>
                Cancel
              </Button>
              <Button
                onClick={handleSaveOfflineDraft}
                disabled={amount < minAllowed || loading}
                className="flex-1 h-11 font-bold"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save Draft'}
              </Button>
            </div>
          </div>
        ) : result ? (
          /* ───── Success View ───── */
          <div className="space-y-4 py-2">
            <div className="flex flex-col items-center gap-2">
              <div className="w-14 h-14 rounded-full bg-success/15 flex items-center justify-center">
                <CheckCircle2 className="h-7 w-7 text-success" />
              </div>
              <h3 className="text-lg font-bold">Payment Allocated!</h3>
              <p className="text-xs text-muted-foreground">Ref: {result.tracking_id}</p>
            </div>

            {/* 🎯 NEW ADVANCE LIMIT UNLOCKED — hero card */}
            {(() => {
              const CAP = 30_000_000;
              const previousLimit = Math.min(creditLimit.totalLimit, CAP);
              const headroom = Math.max(0, CAP - previousLimit);
              const boost = Math.min(Math.round(result.amount * 2), headroom);
              const newLimit = previousLimit + boost;
              return (
                <div className="rounded-2xl p-4 bg-gradient-to-br from-purple-600 via-purple-700 to-fuchsia-700 text-white shadow-lg shadow-purple-900/20 border border-purple-400/30 space-y-3">
                  <div className="flex items-center gap-2">
                    <div className="h-8 w-8 rounded-lg bg-white/15 backdrop-blur flex items-center justify-center shrink-0 ring-1 ring-white/20">
                      <Unlock className="h-4 w-4" />
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wider font-bold text-purple-100/90">New Advance Limit Unlocked</p>
                      <p className="text-xs text-purple-100/80">You can now borrow more</p>
                    </div>
                  </div>
                  <div className="text-center py-1">
                    <p className="text-3xl font-black font-mono leading-none">{formatCreditAmount(newLimit).trim()}</p>
                    {boost > 0 ? (
                      <p className="text-sm font-bold text-emerald-300 mt-1">+{formatCreditAmount(boost).trim()} from this allocation</p>
                    ) : (
                      <p className="text-sm font-bold text-purple-200 mt-1">At UGX 30M cap</p>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg bg-white/10 px-2 py-1.5 text-center">
                      <p className="text-[9px] text-purple-100/70 uppercase tracking-wider">Before</p>
                      <p className="text-xs font-bold">{formatCreditAmount(previousLimit).trim()}</p>
                    </div>
                    <div className="rounded-lg bg-white/15 px-2 py-1.5 text-center ring-1 ring-white/25">
                      <p className="text-[9px] text-purple-100/70 uppercase tracking-wider">After</p>
                      <p className="text-xs font-bold">{formatCreditAmount(newLimit).trim()}</p>
                    </div>
                  </div>
                </div>
              );
            })()}

            <div className="bg-muted/30 rounded-xl p-3 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Amount</span>
                <span className="font-mono font-bold">{formatUGX(result.amount)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tenant</span>
                <span className="font-semibold">{tenant.full_name}</span>
              </div>
              <div className="border-t border-border/40 pt-2 mt-2">
                <div className="flex justify-between">
                  <span className="text-muted-foreground flex items-center gap-1"><Wallet className="h-3 w-3" /> Float Before</span>
                  <span className="font-mono">{formatUGX(result.float_before)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground flex items-center gap-1"><Wallet className="h-3 w-3" /> Float After</span>
                  <span className="font-mono font-bold">{formatUGX(result.float_after)}</span>
                </div>
              </div>
              <div className="border-t border-border/40 pt-2 mt-2">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Still Owes</span>
                  <span className={`font-mono font-bold ${result.outstanding_remaining > 0 ? 'text-destructive' : 'text-success'}`}>
                    {result.outstanding_remaining > 0 ? formatUGX(result.outstanding_remaining) : 'Fully Paid ✓'}
                  </span>
                </div>
              </div>
              {result.commission && (
                <div className="border-t border-border/40 pt-2 mt-2">
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground flex items-center gap-1"><TrendingUp className="h-3 w-3 text-success" /> Commission Earned</span>
                    <span className="font-mono font-bold text-success">
                      {formatUGX(result.commission?.credited_commission || Math.round(result.amount * 0.10))}
                    </span>
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-0.5">10% instantly credited to your Agent Wallet</p>
                </div>
              )}
              {result.commission_balance !== undefined && (
                <div className="border-t border-border/40 pt-2 mt-2">
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground text-xs">🔒 Commission Untouched</span>
                    <span className="font-mono text-xs text-muted-foreground">{formatUGX(result.commission_balance)}</span>
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-0.5">Float-only deduction — commission compartment preserved.</p>
                </div>
              )}
            </div>

            {/* Tenant SMS notification status + manual resend */}
            {tenant.phone ? (
              <div className="rounded-xl border border-border/60 bg-muted/30 p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium flex items-center gap-1.5">
                    <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
                    Tenant SMS
                  </span>
                  {smsStatus === 'sending' && (
                    <span className="text-[11px] font-medium text-muted-foreground flex items-center gap-1">
                      <Loader2 className="h-3 w-3 animate-spin" /> Sending…
                    </span>
                  )}
                  {smsStatus === 'sent' && (
                    <span className="text-[11px] font-medium text-success flex items-center gap-1">
                      <CheckCircle2 className="h-3 w-3" /> Sent
                    </span>
                  )}
                  {smsStatus === 'failed' && (
                    <span className="text-[11px] font-medium text-destructive flex items-center gap-1">
                      <XCircle className="h-3 w-3" /> Failed
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-muted-foreground leading-snug">
                  {smsStatus === 'failed'
                    ? `We couldn't reach ${tenant.phone}. Tap resend to try again.`
                    : smsStatus === 'sent'
                      ? `Payment confirmation sent to ${tenant.phone}.`
                      : `Sending payment confirmation to ${tenant.phone}.`}
                </p>
                <Button
                  variant={smsStatus === 'failed' ? 'default' : 'outline'}
                  size="sm"
                  className="w-full h-9"
                  disabled={smsResending || smsStatus === 'sending'}
                  onClick={() =>
                    sendAllocationSms({
                      paidAmount: Number(result.amount) || 0,
                      remaining: Math.max(0, Number(result.outstanding_remaining) || 0),
                      isResend: true,
                    })
                  }
                >
                  {smsResending ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                  ) : (
                    <RefreshCw className="h-4 w-4 mr-1.5" />
                  )}
                  {smsStatus === 'failed' ? 'Resend SMS' : 'Resend SMS'}
                </Button>
              </div>
            ) : (
              <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
                <p className="text-[10px] text-muted-foreground flex items-center gap-1.5">
                  <MessageSquare className="h-3.5 w-3.5" />
                  No phone on file for this tenant — SMS not sent.
                </p>
              </div>
            )}

            <Button onClick={handleClose} className="w-full h-12 font-bold">Done</Button>
          </div>
        ) : (
          /* ───── Allocation Form ───── */
          <div className="space-y-3">
            {/* Float balance */}
            <div className="rounded-xl bg-primary/5 border border-primary/20 p-3 flex items-center gap-3">
              <Wallet className="h-5 w-5 text-primary shrink-0" />
              <div className="flex-1">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Your Wallet Float</p>
                <p className="text-lg font-bold font-mono text-primary">{formatUGX(floatBalance)}</p>
              </div>
              {tidBalance !== null && (
                <div className="text-right">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider flex items-center justify-end gap-1">
                    Available to collect
                    <TooltipProvider delayDuration={150}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button type="button" aria-label="What is Available to collect?" className="inline-flex">
                            <Info className="h-3 w-3" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-[240px] text-xs">
                          Only float from verified MoMo/Airtel deposits can fund collections.
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </p>
                  <p className="text-lg font-bold font-mono">{formatUGX(tidBalance)}</p>
                </div>
              )}
            </div>

            {/* Outstanding balance */}
            <div className="rounded-xl bg-destructive/5 border border-destructive/20 p-3 text-center">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{tenant.full_name} Owes</p>
              <p className="text-xl font-bold text-destructive font-mono">{formatUGX(outstandingBalance)}</p>
            </div>

            {/* Expected collection for this tenant */}
            {expected > 0 && (
              <div className="rounded-xl bg-primary/5 border border-primary/20 p-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Expected from this tenant</p>
                  <p className="text-lg font-bold font-mono text-primary">{formatUGX(expected)}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setAmount(Math.min(expected, maxAllowable))}
                  disabled={Math.min(expected, maxAllowable) < minAllowed}
                  className="px-3 py-2 rounded-lg text-xs font-bold bg-primary text-primary-foreground disabled:opacity-50"
                  style={{ touchAction: 'manipulation', minHeight: '36px' }}
                >
                  Collect full
                </button>
              </div>
            )}

            {/* Behind on earlier days. The screen still offers only today's
                amount — this explains where the money will actually land. */}
            {behind && (
              <div className="rounded-xl bg-warning/10 border border-warning/40 p-3 flex items-start gap-2">
                <AlertCircle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
                <div className="text-[11px] leading-relaxed">
                  <p className="font-bold text-warning-foreground">
                    {arrearsHeadline(collectCtx, formatUGX)}
                  </p>
                  <p className="text-muted-foreground">
                    Older unpaid days are settled first, so part of whatever you collect will go to
                    them before it counts for today. Nothing extra is charged — this is the same
                    money, just applied oldest first.
                  </p>
                </div>
              </div>
            )}

            {!canAllocate && floatBalance < minAllowed && (
              <div className="flex items-center gap-2 bg-destructive/10 border border-destructive/20 rounded-xl p-3">
                <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
                <p className="text-xs text-destructive">Your wallet float is empty. Top up Agent Float Allocation before paying tenant rent.</p>
              </div>
            )}

            {canAllocate && floatBalance < outstandingBalance && (
              <div className="flex items-start gap-2 bg-warning/10 border border-warning/30 rounded-xl p-3">
                <AlertCircle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
                <p className="text-xs text-warning-foreground">
                  You can pay up to <span className="font-mono font-bold">{formatUGX(maxAllowable)}</span> right now (limited by your float). The tenant will still owe the rest.
                </p>
              </div>
            )}

            {/* Amount */}
            <div>
              <Label className="text-xs">Amount (UGX) *</Label>
              <Input
                type="number"
                placeholder="e.g. 13000"
                value={amount || ''}
                onChange={e => setAmount(Number(e.target.value))}
                min={minAllowed}
                max={maxAllowable}
                className="h-12 text-lg font-mono font-bold"
                style={{ fontSize: '18px' }}
              />
              {amount > outstandingBalance && (
                <div className="flex items-center gap-1.5 mt-1">
                  <AlertCircle className="h-3 w-3 text-destructive" />
                  <p className="text-[10px] text-destructive">Cannot exceed what they owe</p>
                </div>
              )}
              {amount > floatBalance && amount <= outstandingBalance && (
                <div className="flex items-center gap-1.5 mt-1">
                  <AlertCircle className="h-3 w-3 text-destructive" />
                  <p className="text-[10px] text-destructive">Exceeds your wallet float balance</p>
                </div>
              )}
              {tidWarning && (
                <div className="flex items-start gap-1.5 mt-1">
                  <AlertCircle className="h-3 w-3 text-warning shrink-0 mt-0.5" />
                  <p className="text-[10px] text-warning">
                    {tidWarning}{' '}
                    <button
                      type="button"
                      className="underline font-semibold"
                      onClick={() => {
                        onOpenChange(false);
                        window.dispatchEvent(new CustomEvent('open-deposit'));
                      }}
                    >
                      Deposit float
                    </button>
                    {tidLocked && (
                      <>
                        {' · '}
                        <button type="button" className="underline font-semibold" onClick={() => { void refetchTid(); }}>
                          Refresh balance
                        </button>
                      </>
                    )}
                  </p>
                </div>
              )}
              {amount > 0 && amount <= maxAllowable && (
                <div className="mt-1 space-y-0.5">
                  <p className="text-[10px] text-muted-foreground">
                    Remaining debt: <span className="font-mono font-bold">{formatUGX(outstandingBalance - amount)}</span>
                  </p>
                  <p className="text-[10px] text-success font-semibold">
                    Commission: +{formatUGX(Math.round(amount * 0.10))} (10%)
                  </p>
                </div>
              )}
            </div>

            {/* Partial collection — allowed, tracked, never blocked */}
            {isPartial && (
              <div className="rounded-xl bg-warning/10 border border-warning/40 p-3 space-y-3">
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
                  <div className="text-[11px] leading-relaxed">
                    <p className="font-bold text-warning-foreground">
                      Short by {formatUGX(shortfall)} — this is a partial collection
                    </p>
                    <p className="text-muted-foreground">
                      {tenant.full_name} owes {formatUGX(totalDue)} right now. You can still record this
                      amount — it will be tracked as a partial collection for Operations follow-up.
                    </p>
                  </div>
                </div>

                <div>
                  <Label className="text-[11px]">Why is it short? (optional)</Label>
                  <Textarea
                    value={partialReason}
                    onChange={e => setPartialReason(e.target.value)}
                    placeholder="e.g. Tenant paid part in cash, promised balance tomorrow"
                    maxLength={300}
                    rows={2}
                    className="text-xs"
                  />
                </div>
              </div>
            )}


            {/* Quick amount buttons — always clamped to maxAllowable */}
            <div className="flex gap-2 flex-wrap">
              {Array.from(new Set([
                maxAllowable,
                Math.min(maxAllowable, Math.ceil(outstandingBalance / 2)),
                Math.min(maxAllowable, 10000),
                Math.min(maxAllowable, 20000),
                Math.min(maxAllowable, 50000),
              ]))
                .filter(v => v >= minAllowed)
                .slice(0, 4)
                .map(val => (
                  <button
                    key={val}
                    onClick={() => setAmount(val)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition-all ${
                      amount === val ? 'bg-primary text-primary-foreground' : 'bg-muted/60 text-foreground'
                    }`}
                    style={{ touchAction: 'manipulation', minHeight: '36px' }}
                  >
                    {val === maxAllowable && val < outstandingBalance ? `Max ${formatUGX(val)}` : val === outstandingBalance ? 'Full' : formatUGX(val)}
                  </button>
                ))}
            </div>

            {/* Notes */}
            <div>
              <Label className="text-xs">Notes (optional)</Label>
              <Textarea
                placeholder="e.g. Month of April rent"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                maxLength={300}
                rows={2}
              />
            </div>

            {/* Submit → opens confirmation */}
            <Button
              className="w-full h-12 text-base font-bold"
              onClick={() => setConfirming(true)}
              disabled={!isValid || loading || tidLocked}
            >
              <Banknote className="h-4 w-4 mr-2" />
              Review {formatUGX(amount || 0)}
            </Button>
          </div>
        )}
        </div>
      </DialogContent>
    </Dialog>

      {/* 🎉 Commission Celebration — pure UI, no DB calls */}
      {celebrationData && (
        <CommissionCelebration
          open={celebrationOpen}
          onOpenChange={setCelebrationOpen}
          commissionAmount={celebrationData.commission}
          paymentAmount={celebrationData.amount}
          tenantName={tenant.full_name}
        />
      )}
    </>
  );
}
