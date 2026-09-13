import { useMemo } from 'react';
import { TrendingUp, ChevronRight } from 'lucide-react';

interface RentPlanSummaryProps {
  /** Current rent limit the tenant qualifies for (UGX). Will come from backend RPC. */
  rentLimit?: number;
  /** Amount currently used / outstanding (UGX). */
  usedAmount?: number;
  /** Tenant's payment behaviour score 0-100. Drives limit increases. */
  behaviourScore?: number;
  /** Optional click handler to navigate to full rent plan details. */
  onViewDetails?: () => void;
}

const formatUGX = (n: number) =>
  `UGX ${n.toLocaleString('en-UG', { maximumFractionDigits: 0 })}`;

/**
 * Rent Plan summary card — shows the tenant their current rent limit,
 * how much they've used, and a behaviour-based progress indicator
 * showing the path to a higher limit.
 *
 * Placeholder data is used until backend RPCs are connected.
 */
export function RentPlanSummaryCard({
  rentLimit = 0,
  usedAmount = 0,
  behaviourScore = 0,
  onViewDetails,
}: RentPlanSummaryProps) {
  const usagePct = useMemo(
    () => (rentLimit > 0 ? Math.min(100, Math.round((usedAmount / rentLimit) * 100)) : 0),
    [rentLimit, usedAmount],
  );

  const scoreLabel = useMemo(() => {
    if (behaviourScore >= 80) return 'Excellent';
    if (behaviourScore >= 60) return 'Good';
    if (behaviourScore >= 40) return 'Fair';
    return 'Building';
  }, [behaviourScore]);

  const hasData = rentLimit > 0;

  return (
    <button
      type="button"
      onClick={onViewDetails}
      className="w-full rounded-xl border border-border/40 bg-card p-4 text-left transition-colors active:bg-muted/50"
    >
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-bold uppercase tracking-wider text-foreground">
          Your Rent Plan
        </p>
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
      </div>

      {hasData ? (
        <>
          {/* Limit + usage */}
          <div className="flex items-end justify-between mb-2">
            <div>
              <p className="text-2xl font-bold tabular-nums">{formatUGX(rentLimit)}</p>
              <p className="text-[11px] text-muted-foreground">Rent limit</p>
            </div>
            <div className="text-right">
              <p className="text-sm font-semibold tabular-nums">{formatUGX(usedAmount)}</p>
              <p className="text-[11px] text-muted-foreground">Used</p>
            </div>
          </div>

          {/* Usage bar */}
          <div className="h-1.5 rounded-full bg-muted overflow-hidden mb-3">
            <div
              className="h-full rounded-full bg-foreground/70 transition-all duration-500"
              style={{ width: `${usagePct}%` }}
            />
          </div>

          {/* Behaviour score */}
          <div className="flex items-center gap-2">
            <TrendingUp className="h-3.5 w-3.5 text-emerald-600" />
            <p className="text-[11px] text-muted-foreground">
              Payment behaviour: <span className="font-semibold text-foreground">{scoreLabel}</span>
              <span className="text-muted-foreground/60"> · {behaviourScore}/100</span>
            </p>
          </div>
        </>
      ) : (
        /* Empty state — no backend data yet */
        <div className="py-2">
          <p className="text-sm text-muted-foreground">
            Your rent plan details will appear here once your account is set up.
          </p>
          <p className="text-[11px] text-muted-foreground/60 mt-1">
            Pay on time to unlock higher rent limits.
          </p>
        </div>
      )}
    </button>
  );
}
