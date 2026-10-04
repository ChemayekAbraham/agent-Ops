import { useEffect, useState } from 'react';
import { ShieldCheck, Sparkles, TrendingUp, Trophy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { useConfetti } from '@/components/Confetti';
import { hapticTap } from '@/lib/haptics';
import { cn } from '@/lib/utils';

interface VouchHistoryRow {
  delta_ugx: number | string;
  previous_effective_limit_ugx: number | string;
  new_effective_limit_ugx: number | string;
  collection_amount: number | string | null;
  metadata: { capped?: boolean; max_cap_ugx?: number } | null;
}

interface Props {
  agentId: string;
  collectionId: string;
  collectedAmount: number;
  /** Called when user taps "See my vouch" — navigates to their AI ID profile */
  onOpenProfile: () => void;
  /** Called when user taps "Continue" — proceeds to existing summary */
  onContinue: () => void;
}

/**
 * Celebration screen rendered immediately after a successful agent collection.
 *
 * Reads the in-transaction `agent_vouch_limit_history` row written by
 * `trg_recompute_agent_vouch_on_collection`. The row is normally already
 * available on the first read; we add a tiny backoff for safety.
 *
 * Communicates the constitution: "rent collection is the #2 trust pillar
 * after Supporter Portfolio". This is the moment the agent feels Welile
 * vouching for them — 2× the amount they just collected.
 */
export function CollectionVouchCelebration({
  agentId,
  collectionId,
  collectedAmount,
  onOpenProfile,
  onContinue,
}: Props) {
  const [row, setRow] = useState<VouchHistoryRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [animatedDelta, setAnimatedDelta] = useState(0);
  const { fireSuccess } = useConfetti();

  // Fetch the audit row written by the trigger. Small retry in case the
  // PostgREST read races with replication on hot connections.
  useEffect(() => {
    let cancelled = false;
    let attempts = 0;

    const fetchRow = async () => {
      while (!cancelled && attempts < 4) {
        attempts += 1;
        const { data } = await supabase
          .from('agent_vouch_limit_history')
          .select('delta_ugx, previous_effective_limit_ugx, new_effective_limit_ugx, collection_amount, metadata')
          .eq('collection_id', collectionId)
          .eq('agent_id', agentId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (cancelled) return;
        if (data) {
          setRow(data as VouchHistoryRow);
          setLoading(false);
          // Notify any mounted vouch/trust UI to refresh with the precise delta.
          try {
            const { emitVouchUpdated } = await import('@/lib/vouchEvents');
            const { generateWelileAiId } = await import('@/lib/welileAiId');
            emitVouchUpdated({
              agentId,
              aiId: generateWelileAiId(agentId),
              collectionId,
              deltaUgx: Number((data as VouchHistoryRow).delta_ugx ?? 0),
            });
          } catch {}
          return;
        }
        await new Promise((r) => setTimeout(r, 250 * attempts));
      }
      if (!cancelled) setLoading(false);
    };

    fetchRow();
    return () => { cancelled = true; };
  }, [agentId, collectionId]);

  const delta = Number(row?.delta_ugx ?? 0);
  const newLimit = Number(row?.new_effective_limit_ugx ?? 0);
  const capped = !!row?.metadata?.capped;

  // Count-up + confetti once row is loaded
  useEffect(() => {
    if (loading || delta <= 0) return;
    hapticTap();
    fireSuccess();
    const start = performance.now();
    const duration = 900;
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3);
      setAnimatedDelta(Math.round(delta * eased));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [loading, delta, fireSuccess]);

  if (loading) {
    return (
      <div className="text-center py-8 space-y-3">
        <div className="mx-auto h-12 w-12 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
        <p className="text-sm text-muted-foreground">Updating your Welile vouch…</p>
      </div>
    );
  }

  // Capped state — agent has already maxed the vouch ceiling
  if (capped && delta <= 0) {
    return (
      <div className="text-center py-4 space-y-4">
        <div className="mx-auto h-20 w-20 rounded-full bg-gradient-to-br from-amber-500 to-amber-700 flex items-center justify-center shadow-lg shadow-amber-500/30">
          <Trophy className="h-10 w-10 text-white" />
        </div>
        <div>
          <p className="text-xs uppercase tracking-widest font-bold text-amber-700 dark:text-amber-400">
            Top Tier Reached
          </p>
          <p className="text-2xl font-black mt-1">{formatUGX(newLimit)}</p>
          <p className="text-sm text-muted-foreground mt-1">
            You've reached Welile's maximum vouch ceiling. Keep collecting to defend your tier.
          </p>
        </div>
        <CelebrationActions onOpenProfile={onOpenProfile} onContinue={onContinue} />
      </div>
    );
  }

  // No-delta safety net — show a calm "noted" state, never a broken UI
  if (delta <= 0) {
    return (
      <div className="text-center py-4 space-y-4">
        <div className="mx-auto h-16 w-16 rounded-full bg-emerald-500/15 flex items-center justify-center">
          <ShieldCheck className="h-8 w-8 text-emerald-600" />
        </div>
        <div>
          <p className="text-sm font-semibold">Collection recorded</p>
          <p className="text-xs text-muted-foreground mt-1">
            Welile vouches <span className="font-semibold text-foreground">{formatUGX(newLimit)}</span> for you
          </p>
        </div>
        <CelebrationActions onOpenProfile={onOpenProfile} onContinue={onContinue} />
      </div>
    );
  }

  // Standard celebration — Welile just doubled the collection into vouch
  return (
    <div className="relative text-center py-4 space-y-4">
      <div className="mx-auto h-20 w-20 rounded-full bg-gradient-to-br from-emerald-500 to-emerald-700 flex items-center justify-center shadow-lg shadow-emerald-500/40 animate-in zoom-in-50 duration-500">
        <ShieldCheck className="h-10 w-10 text-white" />
      </div>

      <div>
        <p className="text-[11px] uppercase tracking-[0.2em] font-bold text-emerald-700 dark:text-emerald-400 flex items-center justify-center gap-1.5">
          <Sparkles className="h-3 w-3" />
          Welile Vouched For You
          <Sparkles className="h-3 w-3" />
        </p>
        <p className="text-5xl font-black bg-gradient-to-r from-emerald-500 to-emerald-700 bg-clip-text text-transparent mt-2 tabular-nums">
          +{formatUGX(animatedDelta)}
        </p>
        <p className="text-xs text-muted-foreground mt-1">added to your vouch limit</p>
      </div>

      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3 mx-2">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-muted-foreground">You collected</span>
          <span className="font-bold tabular-nums">{formatUGX(collectedAmount)}</span>
        </div>
        <div className="flex items-center justify-between text-[11px] mt-1">
          <span className="text-muted-foreground">Welile vouched 2×</span>
          <span className="font-bold text-emerald-700 dark:text-emerald-400 tabular-nums">
            +{formatUGX(delta)}
          </span>
        </div>
        <div className="border-t border-emerald-500/20 my-2" />
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold">New vouch limit</span>
          <span className="font-black text-emerald-700 dark:text-emerald-400 tabular-nums">
            {formatUGX(newLimit)}
          </span>
        </div>
      </div>

      <div className="rounded-xl bg-muted/40 p-2.5 mx-2">
        <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5 flex items-center justify-center gap-1">
          <TrendingUp className="h-3 w-3" />
          Your Trust Pillars
        </p>
        <ol className="text-[11px] space-y-1 text-left">
          <li className="flex items-center gap-1.5">
            <span className="font-bold text-muted-foreground w-3">1.</span>
            <span className="text-muted-foreground">Supporter Portfolio</span>
          </li>
          <li className={cn(
            'flex items-center gap-1.5 rounded px-1.5 py-1 -mx-1.5',
            'bg-emerald-500/10 border border-emerald-500/30',
          )}>
            <span className="font-black text-emerald-700 dark:text-emerald-400 w-3">2.</span>
            <span className="font-bold text-foreground">Rent Collection</span>
            <span className="ml-auto text-[9px] uppercase tracking-wider font-bold text-emerald-700 dark:text-emerald-400">
              You
            </span>
          </li>
          <li className="flex items-center gap-1.5">
            <span className="font-bold text-muted-foreground w-3">3.</span>
            <span className="text-muted-foreground">Verification &amp; GPS</span>
          </li>
          <li className="flex items-center gap-1.5">
            <span className="font-bold text-muted-foreground w-3">4.</span>
            <span className="text-muted-foreground">Wallet behaviour</span>
          </li>
        </ol>
      </div>

      <CelebrationActions onOpenProfile={onOpenProfile} onContinue={onContinue} />
    </div>
  );
}

function CelebrationActions({ onOpenProfile, onContinue }: { onOpenProfile: () => void; onContinue: () => void }) {
  return (
    <div className="flex flex-col sm:flex-row gap-2 px-2">
      <Button variant="outline" onClick={onOpenProfile} className="flex-1 h-11">
        See my vouch
      </Button>
      <Button onClick={onContinue} className="flex-1 h-11 bg-emerald-600 hover:bg-emerald-700">
        Continue
      </Button>
    </div>
  );
}

export default CollectionVouchCelebration;