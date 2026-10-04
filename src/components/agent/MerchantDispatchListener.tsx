import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  CLAIM_MESSAGES, outcomeFromClaimResponse, outcomeFromRpcError, reconcileClaim, withClaimUpserted,
  type ClaimOutcome, type ClaimRpcResponse, type ClaimStatusResponse,
} from '@/lib/merchantClaim';
import { useAuth } from '@/hooks/useAuth';
import { useIsMerchantAgent } from '@/hooks/useIsMerchantAgent';
import { useMerchantOnlineStatus } from '@/hooks/useMerchantOnlineStatus';
import { Button } from '@/components/ui/button';
import { formatUGX } from '@/lib/rentCalculations';
import { Banknote, MapPin, Clock, Hash, Navigation, X, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

interface DispatchCard {
  withdrawalId: string;
  amount: number;
  payoutMethod: string | null;
  reference: string;
  createdAt: string | null;
  expiresAt: string | null;
  customerName: string | null;
  area: string | null;
  latitude: number | null;
  longitude: number | null;
  claimed: boolean;
  kind: 'standard' | 'partner_returns';
}


function makeReference(id: string) {
  return `WD-${id.replace(/-/g, '').slice(0, 12).toUpperCase()}`;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Global, Uber-style incoming-withdrawal dispatch overlay for online merchant
 * agents. Appears on top of ANY screen the moment a request is dispatched to
 * this agent, with a live countdown, Accept and Ignore. First to Accept claims
 * it atomically; everyone else's card flips to "Already claimed".
 */
export function MerchantDispatchListener() {
  const { user } = useAuth();
  const { isMerchantAgent } = useIsMerchantAgent();
  const { isOnline } = useMerchantOnlineStatus();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [queue, setQueue] = useState<DispatchCard[]>([]);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const agentPos = useRef<{ lat: number; lng: number } | null>(null);
  const seen = useRef<Set<string>>(new Set());

  const active = isMerchantAgent && isOnline && !!user?.id;

  // Grab the agent's coarse location once so we can show distance.
  useEffect(() => {
    if (!active || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (p) => {
        agentPos.current = { lat: p.coords.latitude, lng: p.coords.longitude };
      },
      () => {},
      { enableHighAccuracy: false, timeout: 5000, maximumAge: 300000 },
    );
  }, [active]);

  // 1s ticker for the countdown.
  useEffect(() => {
    if (queue.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [queue.length]);

  const loadCard = useCallback(async (withdrawalId: string) => {
    if (seen.current.has(withdrawalId)) return;
    seen.current.add(withdrawalId);
    const { data, error } = await supabase.rpc('get_dispatch_context', {
      p_withdrawal_id: withdrawalId,
    });
    const ctx = data as Record<string, unknown> | null;
    if (error || !ctx || ctx.ok !== true) return;
    if (ctx.dispatch_claimed_by) return; // already taken before we rendered
    const expiresAt = (ctx.dispatch_expires_at as string | null) ?? null;
    if (expiresAt && new Date(expiresAt).getTime() < Date.now()) return; // expired
    const card: DispatchCard = {
      withdrawalId,
      amount: Number(ctx.amount) || 0,
      payoutMethod: (ctx.payout_method as string | null) ?? null,
      reference: makeReference(withdrawalId),
      createdAt: (ctx.created_at as string | null) ?? null,
      expiresAt,
      customerName: (ctx.customer_name as string | null) ?? null,
      area: ((ctx.city as string | null) || (ctx.address as string | null)) ?? null,
      latitude: ctx.latitude != null ? Number(ctx.latitude) : null,
      longitude: ctx.longitude != null ? Number(ctx.longitude) : null,
      claimed: false,
      kind: (ctx.dispatch_kind as string) === 'partner_returns' ? 'partner_returns' : 'standard',
    };
    setQueue((q) => (q.some((c) => c.withdrawalId === withdrawalId) ? q : [...q, card]));
  }, []);

  // Realtime: new per-agent dispatch rows + claim/expiry updates.
  useEffect(() => {
    if (!active || !user?.id) return;
    const channel = supabase
      .channel(`merchant-dispatch-${user.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'withdrawal_notification_log',
          filter: `recipient_id=eq.${user.id}`,
        },
        (payload) => {
          const row = payload.new as Record<string, unknown>;
          if (row.channel !== 'push') return;
          if (row.response !== 'pending') return;
          if (typeof row.withdrawal_id === 'string') void loadCard(row.withdrawal_id);
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'withdrawal_requests' },
        (payload) => {
          const row = payload.new as Record<string, unknown>;
          const id = row.id as string;
          const claimedBy = row.dispatch_claimed_by as string | null;
          if (claimedBy && claimedBy !== user.id) {
            setQueue((q) =>
              q.map((c) => (c.withdrawalId === id ? { ...c, claimed: true } : c)),
            );
            setTimeout(() => {
              setQueue((q) => q.filter((c) => c.withdrawalId !== id));
            }, 2500);
          }
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [active, user?.id, loadCard]);

  const dismiss = useCallback((id: string) => {
    setQueue((q) => q.filter((c) => c.withdrawalId !== id));
  }, []);

  const handleAccept = useCallback(
    async (card: DispatchCard) => {
      // accept_withdrawal_dispatch is a thin wrapper over the canonical claim
      // transaction (claim_withdrawal_verified): same locking, float
      // reservation, idempotency and response contract as the queue button.
      const toastId = `dispatch-${card.withdrawalId}`;
      setBusy(true);
      let outcome: ClaimOutcome;
      try {
        const { data, error } = await supabase.rpc('accept_withdrawal_dispatch', {
          p_withdrawal_id: card.withdrawalId,
        });
        outcome = error
          ? outcomeFromRpcError(error)
          : outcomeFromClaimResponse(data as unknown as ClaimRpcResponse);
      } catch {
        outcome = { kind: 'ambiguous' };
      }
      if (outcome.kind === 'ambiguous') {
        toast.loading(CLAIM_MESSAGES.checking, { id: toastId });
        outcome = await reconcileClaim(async () => {
          // Not in the generated types until they are regenerated after the migration.
          const { data, error } = await supabase.rpc('get_withdrawal_claim_status' as never, { p_withdrawal_id: card.withdrawalId } as never);
          if (error) throw error;
          return (data as unknown as ClaimStatusResponse) ?? null;
        });
      }
      setBusy(false);

      if (outcome.kind === 'claimed') {
        // Seed "Claimed by you" with the returned claim so the payouts page
        // opens on it without waiting for a list read.
        const claim = outcome.claim;
        if (claim?.assigned_cashout_agent_id) {
          qc.setQueryData(['cashout-my-active-claims', claim.assigned_cashout_agent_id], withClaimUpserted(claim));
        }
        toast.success(outcome.idempotent ? CLAIM_MESSAGES.alreadyYours : 'Claimed! Complete the payout now.', { id: toastId });
        dismiss(card.withdrawalId);
        navigate('/agent/cash-payouts');
        return;
      }
      if (outcome.kind === 'blocked_active_claim' || outcome.kind === 'unconfirmed') {
        // Either way the merchant must look at "Claimed by you" before anything else.
        if (outcome.kind === 'unconfirmed') toast.warning(outcome.message, { id: toastId, duration: 20_000 });
        else toast.error(outcome.message, { id: toastId });
        dismiss(card.withdrawalId);
        navigate('/agent/cash-payouts');
        return;
      }
      const message = 'message' in outcome ? outcome.message : CLAIM_MESSAGES.notClaimed;
      if (outcome.kind === 'rejected' && outcome.tone === 'info') toast.info(message, { id: toastId });
      else toast.error(message, { id: toastId });
      dismiss(card.withdrawalId);
    },
    [dismiss, navigate, qc],
  );

  const handleIgnore = useCallback(
    async (card: DispatchCard) => {
      void supabase.rpc('ignore_withdrawal_dispatch', { p_withdrawal_id: card.withdrawalId });
      dismiss(card.withdrawalId);
    },
    [dismiss],
  );

  if (!active || queue.length === 0) return null;

  const card = queue[0];
  const secondsLeft = card.expiresAt
    ? Math.max(0, Math.round((new Date(card.expiresAt).getTime() - now) / 1000))
    : null;

  // Auto-expire the front card when the countdown ends.
  if (secondsLeft === 0 && !card.claimed) {
    setTimeout(() => dismiss(card.withdrawalId), 0);
  }

  let distanceKm: number | null = null;
  if (agentPos.current && card.latitude != null && card.longitude != null) {
    distanceKm = haversineKm(
      agentPos.current.lat,
      agentPos.current.lng,
      card.latitude,
      card.longitude,
    );
  }

  const requestTime = card.createdAt
    ? new Date(card.createdAt).toLocaleTimeString('en-UG', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Africa/Kampala',
      })
    : '—';

  return (
    <div className="fixed inset-x-0 top-0 z-[120] flex justify-center px-3 pt-3 pointer-events-none">
      <div className="pointer-events-auto w-full max-w-sm animate-in slide-in-from-top-4 fade-in duration-300">
        <div className={cn(
          "overflow-hidden rounded-3xl border bg-card shadow-2xl",
          card.kind === 'partner_returns' ? "border-violet-500/40" : "border-primary/30",
        )}>
          {/* Header + countdown */}
          <div className={cn(
            "relative px-4 py-3 text-white",
            card.kind === 'partner_returns' ? "bg-violet-600" : "bg-primary",
          )}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white/70" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-card" />
                </span>
                <span className="text-sm font-bold uppercase tracking-wide">
                  {card.kind === 'partner_returns'
                    ? 'New Partner Returns Payout'
                    : 'New Withdrawal Request'}
                </span>
              </div>
              {secondsLeft != null && !card.claimed && (
                <div className="flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-1 text-xs font-bold tabular-nums">
                  <Clock className="h-3.5 w-3.5" />
                  {secondsLeft}s
                </div>
              )}
            </div>
            {card.kind === 'partner_returns' && (
              <p className="mt-1 text-[11px] font-medium text-white/90">
                Proxy-initiated · ROI / Partner Returns delivery
              </p>
            )}
            {queue.length > 1 && (
              <p className="mt-0.5 text-[11px] text-white/80">
                +{queue.length - 1} more waiting
              </p>
            )}
          </div>

          {card.claimed ? (
            <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
              <CheckCircle2 className="h-10 w-10 text-muted-foreground" />
              <p className="text-base font-semibold">Withdrawal already claimed</p>
              <p className="text-sm text-muted-foreground">
                Another agent took this one. Stay online for the next request.
              </p>
            </div>
          ) : (
            <>
              <div className="px-4 py-4">
                <div className="flex items-center gap-2 text-3xl font-extrabold tabular-nums">
                  <Banknote className="h-7 w-7 text-emerald-600" />
                  {formatUGX(card.amount)}
                </div>
                <p className="mt-0.5 text-xs uppercase tracking-wide text-muted-foreground">
                  {(card.payoutMethod || 'cash').replace(/_/g, ' ')} payout
                  {card.kind === 'partner_returns' ? ' · Partner Returns' : ''}
                </p>

                <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                  <div className="flex items-start gap-2">
                    <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <div className="min-w-0">
                      <p className="text-[11px] text-muted-foreground">Service area</p>
                      <p className="truncate font-medium">{card.area || 'Assigned area'}</p>
                    </div>
                  </div>
                  {distanceKm != null && (
                    <div className="flex items-start gap-2">
                      <Navigation className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                      <div className="min-w-0">
                        <p className="text-[11px] text-muted-foreground">Distance</p>
                        <p className="font-medium">{distanceKm.toFixed(1)} km</p>
                      </div>
                    </div>
                  )}
                  <div className="flex items-start gap-2">
                    <Clock className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <div className="min-w-0">
                      <p className="text-[11px] text-muted-foreground">Requested</p>
                      <p className="font-medium">{requestTime}</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-2">
                    <Hash className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <div className="min-w-0">
                      <p className="text-[11px] text-muted-foreground">Reference</p>
                      <p className="truncate font-medium">{card.reference}</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex gap-2 border-t border-border p-3">
                <Button
                  variant="outline"
                  className="flex-1 gap-1.5"
                  disabled={busy}
                  onClick={() => handleIgnore(card)}
                >
                  <X className="h-4 w-4" /> Ignore
                </Button>
                <Button
                  className="flex-[2] gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
                  disabled={busy || secondsLeft === 0}
                  onClick={() => handleAccept(card)}
                >
                  <CheckCircle2 className="h-4 w-4" /> Accept Withdrawal
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default MerchantDispatchListener;
