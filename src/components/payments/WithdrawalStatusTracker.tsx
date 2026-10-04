import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Check, Clock, ShieldCheck, Banknote, X, Loader2, AlertTriangle, Timer, Info, RotateCw, ScrollText, ChevronDown, ChevronUp } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { format, addMinutes } from 'date-fns';
import { formatCurrency } from '@/lib/paymentMethods';
import { cn } from '@/lib/utils';

interface WithdrawalStatusTrackerProps {
  /** withdrawal_requests.id — the actual UUID, not the REQ-XXXX shortcode. */
  requestId: string;
  /** Display amount on the receipt header. */
  amount: number;
  currency?: string;
  /** "MTN — 0770…" style label for the destination. */
  recipientLabel: string;
  /** REQ-XXXX shortcode shown to the user. */
  reference: string;
  onClose: () => void;
  /** Optional — when supplied, a "Retry" button appears once a withdrawal
   * has been stuck >24h. The parent should cancel/clear the current request
   * and route the user back to the amount/method step so they can resubmit. */
  onRetry?: () => void;
}

type WithdrawalRow = {
  status: string;
  created_at: string;
  manager_approved_at: string | null;
  fin_ops_approved_at: string | null;
  cfo_approved_at: string | null;
  processed_at: string | null;
  rejection_reason: string | null;
  transaction_id: string | null;
  coo_approved_at?: string | null;
  fin_ops_verified_at?: string | null;
  dispatched_at?: string | null;
  processing_started_at?: string | null;
  updated_at?: string | null;
};

/** Maps the raw `status` text to a 3-stage UI tracker. Anything not in the
 * happy-path (rejected/cancelled) is rendered with its own terminal style. */
const STAGES: { id: 'submitted' | 'review' | 'disbursed'; label: string; description: string; Icon: typeof Clock }[] = [
  { id: 'submitted', label: 'Submitted', description: 'Your request is in the queue.', Icon: Clock },
  { id: 'review', label: 'Financial Ops review', description: 'A reviewer is verifying your details.', Icon: ShieldCheck },
  { id: 'disbursed', label: 'Funds released', description: 'Money sent to your destination.', Icon: Banknote },
];

export default function WithdrawalStatusTracker({
  requestId,
  amount,
  currency = 'UGX',
  recipientLabel,
  reference,
  onClose,
  onRetry,
}: WithdrawalStatusTrackerProps) {
  const [row, setRow] = useState<WithdrawalRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const [queueAhead, setQueueAhead] = useState<number | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);

  // Initial fetch + realtime subscription so the user sees Ops approve LIVE.
  useEffect(() => {
    let alive = true;
    (async () => {
      const { data } = await supabase
        .from('withdrawal_requests')
        .select('status, created_at, manager_approved_at, fin_ops_approved_at, cfo_approved_at, coo_approved_at, fin_ops_verified_at, dispatched_at, processing_started_at, processed_at, rejection_reason, transaction_id, updated_at')
        .eq('id', requestId)
        .maybeSingle();
      if (!alive) return;
      setRow((data as WithdrawalRow) ?? null);
      setLoading(false);
    })();

    const channel = supabase
      .channel(`withdrawal-${requestId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'withdrawal_requests', filter: `id=eq.${requestId}` },
        (payload) => {
          setRow(payload.new as WithdrawalRow);
        },
      )
      .subscribe();

    return () => {
      alive = false;
      supabase.removeChannel(channel);
    };
  }, [requestId]);

  // Compute how many pending requests are ahead of this one in the queue.
  // Refreshes whenever the row's created_at becomes available or status flips
  // out of pending (we stop estimating once it's in review/disbursed).
  useEffect(() => {
    if (!row?.created_at) return;
    if (row.status !== 'pending') {
      setQueueAhead(null);
      return;
    }
    let alive = true;
    (async () => {
      const { count } = await supabase
        .from('withdrawal_requests')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending')
        .lt('created_at', row.created_at);
      if (!alive) return;
      setQueueAhead(count ?? 0);
    })();
    return () => {
      alive = false;
    };
  }, [row?.created_at, row?.status]);

  const status = row?.status ?? 'pending';
  const isCancelled = status === 'cancelled';
  const isRejected = status === 'rejected';
  const isDisbursed = status === 'paid' || status === 'disbursed' || status === 'completed';
  // Heuristic for "Ops is reviewing" — any operational approval timestamp set
  // counts as having moved past the queue.
  const inReview =
    !!row?.manager_approved_at || !!row?.fin_ops_approved_at || !!row?.cfo_approved_at;

  const stageIndex = isDisbursed ? 2 : inReview ? 1 : 0;

  /** ETA heuristic (only while still pending — once Ops starts, real
   * timestamps tell the story). Assumes a Financial Ops throughput of
   * ~6–20 minutes per request including verification + disbursement, plus
   * a small floor so we never promise "instant". Hard-capped at 24h to
   * match the messaging in stage #2. */
  const computeEta = () => {
    if (queueAhead == null) return null;
    const minMinutes = Math.min(15 + queueAhead * 6, 24 * 60);
    const maxMinutes = Math.min(120 + queueAhead * 20, 24 * 60);
    const base = row?.created_at ? new Date(row.created_at) : new Date();
    return {
      minMinutes,
      maxMinutes,
      from: addMinutes(base, minMinutes),
      to: addMinutes(base, maxMinutes),
    };
  };
  const eta = !isDisbursed && !isRejected && !isCancelled && !inReview ? computeEta() : null;

  const fmtRange = (mins: number) => {
    if (mins < 60) return `${mins} min`;
    const h = mins / 60;
    return h % 1 === 0 ? `${h} hr` : `${h.toFixed(1)} hr`;
  };

  /** Plain-English explanation for why a withdrawal is taking longer than
   * the original ETA. Triggers when:
   *   - submitted >2h ago and still in the queue (not yet picked up), OR
   *   - in review for >1h (manual checks taking time).
   * We pick the most likely reason from a small heuristic ladder so the
   * user sees something specific (high volume / off-hours / manual checks)
   * instead of a generic "please wait". */
  const getDelayReason = (): { title: string; body: string } | null => {
    if (isDisbursed || isRejected || isCancelled || !row?.created_at) return null;
    const createdAt = new Date(row.created_at);
    const ageMin = (Date.now() - createdAt.getTime()) / 60000;

    const reviewStartedAt =
      row.manager_approved_at ?? row.fin_ops_approved_at ?? row.cfo_approved_at;
    const reviewAgeMin = reviewStartedAt
      ? (Date.now() - new Date(reviewStartedAt).getTime()) / 60000
      : 0;

    const queueDelay = !inReview && ageMin > 120;
    const reviewDelay = inReview && reviewAgeMin > 60;
    if (!queueDelay && !reviewDelay) return null;

    // EAT (UTC+3) hour-of-day for off-hours messaging.
    const eatHour = (new Date().getUTCHours() + 3) % 24;
    const isOffHours = eatHour < 8 || eatHour >= 18;
    const isWeekend = [0, 6].includes(new Date().getDay());

    if (reviewDelay) {
      if (amount >= 1_000_000) {
        return {
          title: 'Extra verification on a large amount',
          body: 'Withdrawals above UGX 1,000,000 get a second manual review for your safety. Funds release as soon as the reviewer signs off.',
        };
      }
      return {
        title: 'Manual review in progress',
        body: 'A Financial Ops reviewer is verifying your destination details against our payout providers. This usually wraps up within an hour.',
      };
    }

    // Queue delay
    if (isOffHours || isWeekend) {
      return {
        title: 'Outside business hours',
        body: 'Financial Ops runs reviews 08:00–18:00 EAT on weekdays. Your request will be picked up as soon as the next reviewer comes online.',
      };
    }
    if (queueAhead != null && queueAhead >= 10) {
      return {
        title: 'High withdrawal volume',
        body: `There are ${queueAhead} requests ahead of yours right now. Reviewers are working through the queue in order — yours will move up shortly.`,
      };
    }
    return {
      title: 'Taking a little longer than usual',
      body: 'Reviewers are catching up on the queue. Your request stays in place — no need to resubmit.',
    };
  };
  const delayReason = getDelayReason();

  /** Derives a chronological audit trail from the per-stage timestamp
   * columns on `withdrawal_requests`. These columns ARE the backend
   * audit trail — every approval gate stamps its own column when it
   * mutates the row, so rendering them in time order gives the user
   * the full lifecycle without exposing the (manager-only) audit_logs
   * table. */
  const auditTrail = (() => {
    if (!row) return [];
    const events: { at: string; label: string; tone: 'submit' | 'review' | 'pay' | 'terminal' }[] = [];
    const push = (at: string | null | undefined, label: string, tone: typeof events[number]['tone']) => {
      if (at) events.push({ at, label, tone });
    };
    push(row.created_at, 'Request submitted to Financial Ops', 'submit');
    push(row.manager_approved_at ?? null, 'Manager approval recorded', 'review');
    push(row.coo_approved_at ?? null, 'COO approval recorded', 'review');
    push(row.cfo_approved_at ?? null, 'CFO approval recorded', 'review');
    push(row.fin_ops_verified_at ?? null, 'Financial Ops verified destination', 'review');
    push(row.fin_ops_approved_at ?? null, 'Financial Ops approved payout', 'review');
    push(row.processing_started_at ?? null, 'Payout processing started', 'pay');
    push(row.dispatched_at ?? null, 'Dispatched to payout provider', 'pay');
    push(row.processed_at ?? null,
      isRejected ? 'Request rejected' :
      isCancelled ? 'Request cancelled' :
      'Funds released to destination',
      'terminal');
    // Fallback terminal stamp if the row flipped state without a processed_at
    // (e.g. user cancel). updated_at is the next-best signal.
    if ((isRejected || isCancelled) && !row.processed_at && row.updated_at) {
      push(row.updated_at, isRejected ? 'Request rejected' : 'Request cancelled', 'terminal');
    }
    return events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  })();

  /** Stuck = still non-terminal after 24h. Unlocks both the cancel and
   * retry escape hatches so the user is never trapped on a frozen request. */
  const ageMinutes = row?.created_at
    ? (Date.now() - new Date(row.created_at).getTime()) / 60000
    : 0;
  const isStuck =
    !isDisbursed && !isRejected && !isCancelled && ageMinutes >= 24 * 60;

  const handleCancel = async () => {
    const msg = isStuck
      ? 'Cancel this stuck withdrawal and unlock your funds? You can submit a fresh request right after.'
      : 'Cancel this withdrawal request? You can submit a new one anytime.';
    if (!confirm(msg)) return;
    setCancelling(true);
    // For stuck (>24h) requests we also allow cancelling rows that have
    // partially advanced through ops but never reached disbursement. The
    // server-side RLS still ultimately decides whether the update lands.
    const allowedStatuses = isStuck
      ? ['pending', 'approved', 'processing']
      : ['pending'];
    const { error } = await supabase
      .from('withdrawal_requests')
      .update({ status: 'cancelled' })
      .eq('id', requestId)
      .in('status', allowedStatuses);
    setCancelling(false);
    if (error) {
      toast.error(
        isStuck
          ? 'Could not cancel automatically. Please contact support to release this request.'
          : 'Could not cancel — Financial Ops may already be processing it.',
      );
      return;
    }
    toast.success('Withdrawal cancelled.');
  };

  const handleRetry = async () => {
    if (!onRetry) return;
    if (!confirm('Cancel this stuck request and start a fresh withdrawal with the same details?')) return;
    setCancelling(true);
    // Best-effort cancel of the stuck row so we don't leave duplicates open.
    await supabase
      .from('withdrawal_requests')
      .update({ status: 'cancelled' })
      .eq('id', requestId)
      .in('status', ['pending', 'approved', 'processing']);
    setCancelling(false);
    onRetry();
  };

  if (loading) {
    return (
      <div className="py-12 text-center">
        <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Header — amount + ref */}
      <Card className="p-5 text-center bg-gradient-to-br from-primary/5 to-primary/10 border-primary/20">
        <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">
          {isDisbursed ? 'Disbursed' : isRejected ? 'Rejected' : isCancelled ? 'Cancelled' : 'Pending approval'}
        </p>
        <p className="text-3xl font-bold mt-1">{formatCurrency(amount, currency)}</p>
        <p className="text-xs text-muted-foreground mt-2">to {recipientLabel}</p>
        <p className="text-[10px] font-mono text-muted-foreground mt-2">Ref: {reference}</p>
      </Card>

      {/* Estimated payout window — queue-aware, only while still pending. */}
      {eta && (
        <div className="flex items-start gap-3 p-3 rounded-lg border border-primary/20 bg-primary/5">
          <Timer className="h-4 w-4 text-primary shrink-0 mt-0.5" />
          <div className="flex-1 text-xs">
            <p className="font-semibold text-foreground">
              Estimated payout in {fmtRange(eta.minMinutes)} – {fmtRange(eta.maxMinutes)}
            </p>
            <p className="text-muted-foreground mt-0.5">
              Around {format(eta.from, 'MMM d, HH:mm')} – {format(eta.to, 'MMM d, HH:mm')}
              {queueAhead != null && (
                <> · {queueAhead === 0 ? 'You\'re next in the queue' : `${queueAhead} request${queueAhead === 1 ? '' : 's'} ahead of you`}</>
              )}
            </p>
          </div>
        </div>
      )}

      {/* Delay explanation — shown when the request is running past its ETA
          so the user understands *why* without having to ask support. */}
      {delayReason && (
        <div className="flex items-start gap-3 p-3 rounded-lg border border-amber-500/30 bg-amber-500/5">
          <Info className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
          <div className="flex-1 text-xs">
            <p className="font-semibold text-foreground">{delayReason.title}</p>
            <p className="text-muted-foreground mt-0.5">{delayReason.body}</p>
          </div>
        </div>
      )}

      {/* Rejected / cancelled banners */}
      {isRejected && (
        <div className="flex items-start gap-2 p-3 rounded-lg border border-destructive/30 bg-destructive/5">
          <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
          <div className="text-xs">
            <p className="font-semibold text-destructive">Request rejected</p>
            {row?.rejection_reason && (
              <p className="text-muted-foreground mt-0.5">{row.rejection_reason}</p>
            )}
          </div>
        </div>
      )}
      {isCancelled && (
        <div className="flex items-start gap-2 p-3 rounded-lg border border-border bg-muted/30">
          <X className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
          <p className="text-xs text-muted-foreground">You cancelled this request. Submit a new withdrawal anytime.</p>
        </div>
      )}

      {/* 3-stage tracker (hidden once terminal state is rejected/cancelled) */}
      {!isRejected && !isCancelled && (
        <div className="space-y-3">
          {STAGES.map((stage, i) => {
            const completed = i < stageIndex;
            const active = i === stageIndex && !isDisbursed;
            const done = i === stageIndex && isDisbursed;
            const Icon = stage.Icon;
            const stageTime =
              i === 0 ? row?.created_at :
              i === 1 ? (row?.manager_approved_at ?? row?.fin_ops_approved_at ?? row?.cfo_approved_at) :
              row?.processed_at;
            return (
              <div key={stage.id} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <div
                    className={cn(
                      'w-8 h-8 rounded-full flex items-center justify-center transition-colors',
                      completed || done ? 'bg-emerald-500 text-white' :
                      active ? 'bg-primary/15 text-primary ring-2 ring-primary/40 animate-pulse' :
                      'bg-muted text-muted-foreground',
                    )}
                  >
                    {completed || done ? <Check className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
                  </div>
                  {i < STAGES.length - 1 && (
                    <div className={cn('w-px flex-1 my-1', completed ? 'bg-emerald-500' : 'bg-border')} style={{ minHeight: 24 }} />
                  )}
                </div>
                <div className="flex-1 pb-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className={cn('text-sm font-semibold', (completed || active || done) && 'text-foreground', !(completed || active || done) && 'text-muted-foreground')}>
                      {stage.label}
                    </p>
                    {stageTime && (
                      <span className="text-[10px] text-muted-foreground font-mono">
                        {format(new Date(stageTime), 'MMM d, HH:mm')}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{stage.description}</p>
                  {active && i === 1 && (
                    <p className="text-[10px] text-primary mt-1 font-medium">May take up to 24 hours. Sometimes instant depending on volume.</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Disbursement TID once available */}
      {isDisbursed && row?.transaction_id && (
        <div className="p-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 text-xs">
          <p className="text-muted-foreground">Provider transaction ID</p>
          <p className="font-mono font-semibold text-emerald-700 break-all">{row.transaction_id}</p>
        </div>
      )}

      {/* 24h-stuck escape hatch — explains the unlock before showing the buttons. */}
      {isStuck && (
        <div className="flex items-start gap-3 p-3 rounded-lg border border-destructive/30 bg-destructive/5">
          <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
          <div className="flex-1 text-xs">
            <p className="font-semibold text-foreground">Still processing after 24 hours</p>
            <p className="text-muted-foreground mt-0.5">
              You can cancel this request to free your balance, or retry to submit a fresh withdrawal with the same details.
            </p>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 flex-wrap">
        {(isStuck || (status === 'pending' && !inReview)) && (
          <Button
            variant="outline"
            className="flex-1 text-destructive hover:bg-destructive/5 border-destructive/30"
            onClick={handleCancel}
            disabled={cancelling}
          >
            {cancelling ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <X className="h-4 w-4 mr-2" />}
            Cancel request
          </Button>
        )}
        {isStuck && onRetry && (
          <Button
            variant="outline"
            className="flex-1"
            onClick={handleRetry}
            disabled={cancelling}
          >
            <RotateCw className="h-4 w-4 mr-2" />
            Retry withdrawal
          </Button>
        )}
        <Button onClick={onClose} className="flex-1">Done</Button>
      </div>

      <p className="text-[10px] text-center text-muted-foreground">
        🔔 We'll notify you the moment Financial Ops approves and funds are released.
      </p>

      {/* Audit trail — collapsible chronological log of every backend
          status update on this withdrawal request. */}
      {auditTrail.length > 0 && (
        <div className="rounded-lg border border-border bg-muted/20">
          <button
            type="button"
            onClick={() => setAuditOpen((v) => !v)}
            className="w-full flex items-center justify-between gap-2 px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted/40 transition-colors"
          >
            <span className="flex items-center gap-2">
              <ScrollText className="h-3.5 w-3.5 text-muted-foreground" />
              Audit trail ({auditTrail.length} {auditTrail.length === 1 ? 'event' : 'events'})
            </span>
            {auditOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
          {auditOpen && (
            <ol className="px-3 pb-3 pt-1 space-y-2">
              {auditTrail.map((evt, i) => (
                <li key={`${evt.at}-${i}`} className="flex gap-2 items-start text-[11px]">
                  <span
                    className={cn(
                      'mt-1 h-1.5 w-1.5 rounded-full shrink-0',
                      evt.tone === 'submit' && 'bg-primary',
                      evt.tone === 'review' && 'bg-amber-500',
                      evt.tone === 'pay' && 'bg-sky-500',
                      evt.tone === 'terminal' && (isRejected || isCancelled ? 'bg-destructive' : 'bg-emerald-500'),
                    )}
                  />
                  <div className="flex-1 flex items-baseline justify-between gap-2">
                    <span className="text-foreground">{evt.label}</span>
                    <span className="font-mono text-muted-foreground shrink-0">
                      {format(new Date(evt.at), 'MMM d, HH:mm:ss')}
                    </span>
                  </div>
                </li>
              ))}
              {row?.transaction_id && (
                <li className="pt-1 mt-1 border-t border-border text-[10px] text-muted-foreground font-mono break-all">
                  Provider TID: {row.transaction_id}
                </li>
              )}
              <li className="pt-1 text-[10px] text-muted-foreground font-mono break-all">
                Request ID: {requestId}
              </li>
            </ol>
          )}
        </div>
      )}
    </div>
  );
}