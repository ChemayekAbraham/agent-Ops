import { useEffect, useState } from 'react';
import { ShieldCheck, Info } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { onVouchUpdated } from '@/lib/vouchEvents';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

// Mirrors `welile_default_agent_vouch_floor_ugx()` in the database. Kept in
// sync with `EarnedVouchBreakdown` in AgentVouchHighlightCard.
const WELILE_VOUCH_FLOOR_UGX = 100_000;
const WELILE_VOUCH_MULTIPLIER = 2;

interface Props {
  aiId: string;
  className?: string;
}

interface VouchSnapshot {
  borrowing_limit_ugx: number;
  agent_earned_vouch_ugx: number;
}

/**
 * Shows the Welile-vouched amount for a borrower (looked up by AI ID), so
 * lending agents can see the trust-backed limit and the rent-collection
 * portion (2× collected rent) at a glance before lending.
 *
 * Reads the public `welile_trust_score_cache` row joined via AI ID. If the
 * borrower has no cache row yet (new user), the badge silently hides.
 */
export function BorrowerVouchBadge({ aiId, className }: Props) {
  const [snap, setSnap] = useState<VouchSnapshot | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  // Live-refresh when the underlying agent records a collection.
  useEffect(() => {
    return onVouchUpdated((d) => {
      if (!d.aiId || d.aiId.toUpperCase() === aiId?.toUpperCase()) {
        setRefreshTick((n) => n + 1);
      }
    });
  }, [aiId]);

  useEffect(() => {
    let cancelled = false;
    if (!aiId) return;

    (async () => {
      const { data } = await supabase
        .from('welile_trust_score_cache')
        .select('borrowing_limit_ugx, agent_earned_vouch_ugx')
        .eq('ai_id', aiId.toUpperCase())
        .maybeSingle();

      if (cancelled) return;
      if (data) {
        setSnap({
          borrowing_limit_ugx: Number(data.borrowing_limit_ugx) || 0,
          agent_earned_vouch_ugx: Number(data.agent_earned_vouch_ugx) || 0,
        });
      }
    })();

    return () => { cancelled = true; };
  }, [aiId, refreshTick]);

  if (!snap || snap.borrowing_limit_ugx <= 0) return null;

  const earned = snap.agent_earned_vouch_ugx;
  // Earned portion comes from 2× collected rent — derive collected for display.
  const collected = earned > 0 ? earned / WELILE_VOUCH_MULTIPLIER : 0;
  // Whatever the trust engine added on top of (floor + earned) — surface it
  // so the math in the tooltip always reconciles to the headline limit.
  const trustBoost = Math.max(
    0,
    snap.borrowing_limit_ugx - WELILE_VOUCH_FLOOR_UGX - earned,
  );

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10px] cursor-help',
              className,
            )}
          >
            <ShieldCheck className="h-3 w-3 text-emerald-700 dark:text-emerald-400" />
            <span className="font-bold text-emerald-700 dark:text-emerald-400 tabular-nums">
              Welile vouches {formatUGX(snap.borrowing_limit_ugx)}
            </span>
            {collected > 0 && (
              <span className="text-emerald-700/70 dark:text-emerald-400/70">
                · 2× of {formatUGX(collected)} collected
              </span>
            )}
            <Info className="h-3 w-3 text-emerald-700/60 dark:text-emerald-400/60" aria-hidden />
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs p-3 space-y-2">
          <p className="text-xs font-bold text-foreground">How Welile calculates this vouch</p>
          <p className="text-[11px] text-muted-foreground leading-snug">
            Welile vouches <span className="font-semibold text-foreground">2× the rent this agent has collected</span>,
            on top of a base floor every active agent gets.
          </p>
          <div className="space-y-1 pt-1 border-t border-border/60">
            <Row label="Welile base vouch" value={formatUGX(WELILE_VOUCH_FLOOR_UGX)} />
            <Row
              label={`Earned from collecting (${WELILE_VOUCH_MULTIPLIER}× ${formatUGX(collected)})`}
              value={formatUGX(earned)}
            />
            {trustBoost > 0 && (
              <Row label="Trust score boost" value={formatUGX(trustBoost)} />
            )}
            <div className="flex items-center justify-between pt-1 mt-1 border-t border-border/60">
              <span className="text-[11px] font-bold text-foreground">Effective Welile vouch</span>
              <span className="text-[11px] font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                {formatUGX(snap.borrowing_limit_ugx)}
              </span>
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[11px] text-muted-foreground leading-snug">{label}</span>
      <span className="text-[11px] font-semibold tabular-nums text-foreground">{value}</span>
    </div>
  );
}

export default BorrowerVouchBadge;