import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useAgentLandlordFloat } from '@/hooks/useAgentLandlordFloat';
import { formatUGX } from '@/lib/rentCalculations';
import { Landmark, ArrowRight, Loader2, TrendingUp, History, ShieldCheck, KeyRound } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

interface AgentLandlordFloatCardProps {
  onPayLandlord: () => void;
  onOpenRecovery?: () => void;
  onOpenHistory?: () => void;
  onOpenStatusTracker?: () => void;
  onOpenOtpAudit?: () => void;
}

export function AgentLandlordFloatCard({ onPayLandlord, onOpenRecovery, onOpenHistory, onOpenStatusTracker, onOpenOtpAudit }: AgentLandlordFloatCardProps) {
  const { user } = useAuth();

  // Spendable float, not the gross custody balance. `agent_landlord_float.balance`
  // still counts allocations the 24h idle recall has pulled back
  // (status `return_pending`), so reading it raw showed an agent money that was
  // already reversed and that the payout backend would refuse. The RPC applies
  // the same deductions the backend enforces — recalled allocations and float
  // ring-fenced by a verified-but-unpaid payout.
  const { availableBalance, isLoading } = useAgentLandlordFloat();

  const { data: pendingCount = 0 } = useQuery({
    queryKey: ['agent-float-pending-count', user?.id],
    queryFn: async () => {
      if (!user) return 0;
      const { count } = await supabase
        .from('agent_float_withdrawals')
        .select('id', { count: 'exact', head: true })
        .eq('agent_id', user.id)
        .in('status', ['pending_agent_ops', 'agent_ops_approved']);
      return count || 0;
    },
    enabled: !!user,
  });

  const balance = availableBalance;
  // Only float the agent can actually spend counts as having float. A recalled
  // or fully ring-fenced allocation falls back to the "CFO will fund this"
  // state rather than advertising an amount the payout will reject.
  const hasFloat = availableBalance > 0;

  return (
    <div className="rounded-2xl border-2 border-[#9234EA]/30 bg-[#9234EA]/5 overflow-hidden">
      {/* Main Pay Button */}
      <button
        onClick={onPayLandlord}
        className="w-full p-4 hover:bg-[#9234EA]/5 touch-manipulation active:opacity-80 text-left"
      >
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-[#9234EA]/15 shrink-0">
            <Landmark className="h-5 w-5 text-[#9234EA]" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-[11px] text-muted-foreground dark:text-white font-medium uppercase tracking-wider">Landlord Payout Float</p>
              {pendingCount > 0 && (
                <Badge variant="secondary" className="text-[9px] px-1.5 py-0">
                  {pendingCount} pending
                </Badge>
              )}
            </div>
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground dark:text-white mt-1" />
            ) : hasFloat ? (
              <p className="font-bold text-xl text-foreground dark:text-white truncate mt-0.5">{formatUGX(balance)}</p>
            ) : (
              <p className="font-bold text-sm text-foreground dark:text-white mt-0.5">Pay Landlord via MoMo</p>
            )}
            <p className="text-[10px] text-muted-foreground dark:text-white">
              {hasFloat ? 'Sent by Welile CFO · spend only on landlord MoMo payouts' : 'CFO will fund this when a landlord payout is due. Pay landlord → Upload receipt + GPS'}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-xs text-[#9234EA] dark:text-white font-semibold">Pay</span>
            <ArrowRight className="h-4 w-4 text-[#9234EA] dark:text-white" />
          </div>
        </div>
      </button>

      {/* Quick Action Strip */}
      <div className="border-t border-[#9234EA]/20 grid grid-cols-4 divide-x divide-[#9234EA]/20">
        <button
          onClick={onOpenRecovery}
          className="flex items-center justify-center gap-1.5 py-2 text-[10px] font-medium text-muted-foreground dark:text-white hover:text-[#9234EA] dark:hover:text-white hover:bg-[#9234EA]/5 transition-colors touch-manipulation"
        >
          <TrendingUp className="h-3 w-3" />
          Recovery
        </button>
        <button
          onClick={onOpenStatusTracker}
          className="flex items-center justify-center gap-1.5 py-2 text-[10px] font-medium text-muted-foreground dark:text-white hover:text-[#9234EA] dark:hover:text-white hover:bg-[#9234EA]/5 transition-colors touch-manipulation"
        >
          <ShieldCheck className="h-3 w-3" />
          Status
        </button>
        <button
          onClick={onOpenOtpAudit}
          className="flex items-center justify-center gap-1.5 py-2 text-[10px] font-medium text-muted-foreground dark:text-white hover:text-[#9234EA] dark:hover:text-white hover:bg-[#9234EA]/5 transition-colors touch-manipulation"
        >
          <KeyRound className="h-3 w-3" />
          OTP Log
        </button>
        <button
          onClick={onOpenHistory}
          className="flex items-center justify-center gap-1.5 py-2 text-[10px] font-medium text-muted-foreground dark:text-white hover:text-[#9234EA] dark:hover:text-white hover:bg-[#9234EA]/5 transition-colors touch-manipulation"
        >
          <History className="h-3 w-3" />
          History
        </button>
      </div>
    </div>
  );
}
