import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { fetchAgentLedgerEarnings } from '@/lib/agentLedgerEarnings';
import { TrendingUp, Zap, Coins } from 'lucide-react';

interface Props {
  agentId: string;
}

export function EarningsForecastCard({ agentId }: Props) {
  const { data, isLoading } = useQuery({
    queryKey: ['agent-earnings-forecast', agentId],
    queryFn: async () => {
      // Fetch active rent requests + actual earnings in parallel
      // Earnings come from the ledger — agent_earnings stopped being written in July.
      const [requestsRes, earnings] = await Promise.all([
        supabase
          .from('rent_requests')
          .select('daily_repayment, total_repayment, amount_repaid')
          .eq('agent_id', agentId)
          .in('status', ['approved', 'disbursed', 'active']),
        fetchAgentLedgerEarnings(agentId),
      ]);

      const requests = requestsRes.data || [];

      const totalDailyCollectable = requests.reduce((s, r) => s + (r.daily_repayment || 0), 0);
      const totalOutstanding = requests.reduce((s, r) => s + Math.max(0, (r.total_repayment || 0) - (r.amount_repaid || 0)), 0);

      // 5% commission on daily collections
      const dailyCommission = totalDailyCollectable * 0.05;
      const monthlyPotential = dailyCommission * 30;

      // Actual earned commissions
      const totalCommissionEarned = earnings
        .filter(e => e.earning_type === 'commission' || e.earning_type === 'subagent_commission')
        .reduce((s, e) => s + Number(e.amount), 0);
      const totalBonusEarned = earnings
        .filter(e => e.earning_type !== 'commission' && e.earning_type !== 'subagent_commission')
        .reduce((s, e) => s + Number(e.amount), 0);
      const totalEarned = earnings.reduce((s, e) => s + Number(e.amount), 0);

      // Get streak multiplier
      const { data: streak } = await supabase
        .from('agent_collection_streaks')
        .select('streak_multiplier, current_streak')
        .eq('agent_id', agentId)
        .maybeSingle();

      const multiplier = Number(streak?.streak_multiplier || 1.0);

      return {
        dailyCollectable: totalDailyCollectable,
        dailyCommission,
        monthlyPotential: monthlyPotential * multiplier,
        totalOutstanding,
        multiplier,
        tenantCount: requests.length,
        totalEarned,
        totalCommissionEarned,
        totalBonusEarned,
      };
    },
    staleTime: 300000,
  });

  if (isLoading || !data) return null;
  if (data.tenantCount === 0 && data.totalEarned === 0) return null;

  return (
    <div className="rounded-xl border border-success/30 bg-success/5 p-3.5 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="p-2 rounded-lg bg-success/15">
            <TrendingUp className="h-4 w-4 text-success" />
          </div>
          <div>
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Earnings Forecast</p>
            <p className="font-bold text-lg text-success">{formatUGX(data.monthlyPotential)}<span className="text-[10px] text-muted-foreground font-normal">/mo</span></p>
          </div>
        </div>
        {data.multiplier > 1 && (
          <div className="flex items-center gap-1 px-2 py-1 rounded-lg bg-warning/10 border border-warning/20">
            <Zap className="h-3 w-3 text-warning" />
            <span className="text-[10px] font-bold text-warning">{data.multiplier.toFixed(2)}x</span>
          </div>
        )}
      </div>

      {/* Actual earned commissions — always visible */}
      {data.totalEarned > 0 && (
        <div className="rounded-lg border border-success/20 bg-success/5 p-2.5 flex items-center gap-2.5">
          <Coins className="h-4 w-4 text-success shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Total Earned</p>
            <p className="font-bold text-base text-success">{formatUGX(data.totalEarned)}</p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-[9px] text-muted-foreground">Commissions</p>
            <p className="text-xs font-semibold text-success">{formatUGX(data.totalCommissionEarned)}</p>
            {data.totalBonusEarned > 0 && (
              <>
                <p className="text-[9px] text-muted-foreground mt-0.5">Bonuses</p>
                <p className="text-xs font-semibold text-warning">{formatUGX(data.totalBonusEarned)}</p>
              </>
            )}
          </div>
        </div>
      )}

      {data.tenantCount > 0 && (
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg bg-background/60 p-2">
            <p className="font-bold text-sm">{formatUGX(data.dailyCommission)}</p>
            <p className="text-[9px] text-muted-foreground">Today's 5%</p>
          </div>
          <div className="rounded-lg bg-background/60 p-2">
            <p className="font-bold text-sm">{data.tenantCount}</p>
            <p className="text-[9px] text-muted-foreground">Active</p>
          </div>
          <div className="rounded-lg bg-background/60 p-2">
            <p className="font-bold text-sm text-destructive">{formatUGX(data.totalOutstanding)}</p>
            <p className="text-[9px] text-muted-foreground">To Collect</p>
          </div>
        </div>
      )}

      {data.totalOutstanding > 0 && (
        <p className="text-[10px] text-success font-medium text-center">
          💰 Collect today → earn {formatUGX(data.dailyCommission)} in commissions
        </p>
      )}
    </div>
  );
}
