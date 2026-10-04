import { Card, CardContent } from '@/components/ui/card';
import { formatUGX } from '@/lib/rentCalculations';
import { useAgentEarnings } from '@/hooks/useAgentEarnings';
import { Coins, TrendingUp } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Compact earnings summary for the agent dashboard.
 * Shows available rewards (commission ready to withdraw) alongside
 * lifetime total earnings — replaces the removed "Verify & Earn" entry
 * point with a passive at-a-glance summary.
 */
export function EarningsSummaryCard() {
  const { availableToWithdraw, totalEarnings, loading } = useAgentEarnings();

  return (
    <Card className="border-primary/20 bg-gradient-to-br from-primary/5 to-transparent">
      <CardContent className="p-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Coins className="h-3.5 w-3.5 text-primary" />
              <span className="text-[11px] font-medium uppercase tracking-wide">Available rewards</span>
            </div>
            {loading ? (
              <Skeleton className="h-6 w-24" />
            ) : (
              <span className="text-lg font-bold text-foreground">{formatUGX(availableToWithdraw)}</span>
            )}
          </div>

          <div className="flex flex-col gap-1.5 border-l border-border/60 pl-3">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <TrendingUp className="h-3.5 w-3.5 text-primary" />
              <span className="text-[11px] font-medium uppercase tracking-wide">Total earnings</span>
            </div>
            {loading ? (
              <Skeleton className="h-6 w-24" />
            ) : (
              <span className="text-lg font-bold text-foreground">{formatUGX(totalEarnings)}</span>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}