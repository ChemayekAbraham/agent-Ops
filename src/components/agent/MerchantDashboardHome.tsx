import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  Wallet,
  PiggyBank,
  Landmark,
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowLeftRight,
  ChevronRight,
  Banknote,
  Sparkles,
  TrendingUp,
  CheckCircle2,
  Timer,
  History,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { hapticTap } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import { useNavigate } from 'react-router-dom';
import { MerchantFloatAvailableCard } from '@/components/agent/MerchantFloatAvailableCard';
import {
  MerchantPayoutNumbersGate,
  useMerchantPayoutNumbers,
} from '@/components/agent/MerchantPayoutNumbersGate';

interface Props {
  agentId: string;
  cashoutAgentId: string | null;
  withdrawableBalance: number;
  floatBalance: number;
  pendingCount: number;
  pendingCommission: number;
  handlesCash: boolean;
  onOpenCashPayouts: () => void;
  onDeposit: () => void;
  onWithdraw: () => void;
  onTransfer: () => void;
  onViewWallet: () => void;
  onViewStatement?: () => void;
}

/**
 * Merchant-only dashboard home. Replaces the standard agent home for users
 * with an active `cashout_agents` row. Layout:
 *   • Bento wallet card (Float + Withdrawable + Total)
 *   • Quick-action cluster (Deposit / Withdraw / Transfer)
 *   • Merchant Payouts CTA (live unclaimed queue)
 *   • Quick insights (7-day volume, success rate, avg ticket, pending commission)
 */
export function MerchantDashboardHome({
  agentId,
  cashoutAgentId,
  withdrawableBalance,
  floatBalance,
  pendingCount,
  pendingCommission,
  handlesCash,
  onOpenCashPayouts,
  onDeposit,
  onWithdraw,
  onTransfer,
  onViewWallet,
  onViewStatement,
}: Props) {
  const total = withdrawableBalance + floatBalance;
  const navigate = useNavigate();

  // Hard gate: no merchant activity at all until the float number and the
  // personal-money number are on record and different from each other.
  const { data: payoutNumbers, isLoading: numbersLoading } = useMerchantPayoutNumbers(agentId);

  // 7-day merchant activity — derived from the payouts this merchant actually
  // settled (withdrawal_requests), not from push-notification logs. Push logs
  // only exist for push-dispatched offers, so merchants who claimed from the
  // queue saw zero volume even after paying real money out.
  const { data: insights } = useQuery({
    queryKey: ['merchant-home-insights', agentId, cashoutAgentId],
    staleTime: 60_000,
    refetchOnMount: 'always',
    queryFn: async () => {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const mine = cashoutAgentId
        ? `processed_by.eq.${agentId},assigned_cashout_agent_id.eq.${cashoutAgentId}`
        : `processed_by.eq.${agentId}`;
      const { data } = await supabase
        .from('withdrawal_requests')
        .select('amount, status, processed_at, payout_proof_path')
        .eq('status', 'completed')
        .or(mine)
        .gte('processed_at', since)
        .limit(1000);
      const settled = (data ?? []) as any[];
      const volume = settled.reduce((s: number, r: any) => s + Number(r.amount || 0), 0);
      const withProof = settled.filter((r: any) => !!r.payout_proof_path).length;
      const successRate = settled.length
        ? Math.round((withProof / settled.length) * 100)
        : null;
      const avg = settled.length ? Math.round(volume / settled.length) : 0;
      return {
        volume,
        successRate,
        avg,
        acceptedCount: settled.length,
      };
    },
  });

  const successPct = insights?.successRate ?? null;

  if (numbersLoading) {
    return (
      <div className="rounded-3xl border border-border/60 bg-card p-6 text-sm text-muted-foreground">
        Checking your payout numbers…
      </div>
    );
  }

  if (payoutNumbers && !payoutNumbers.complete) {
    return <MerchantPayoutNumbersGate agentId={agentId} existing={payoutNumbers} />;
  }

  return (
    <div className="space-y-5">
      {/* Quick actions */}
      <section>
        <h2 className="mb-2 px-1 text-sm font-bold text-foreground">What do you want to do?</h2>
        <div className="grid grid-cols-2 gap-3">
          <QuickAction
            icon={<ArrowDownToLine className="h-5 w-5" />}
            label="Add money"
            hint="Put money into your wallet"
            onClick={onDeposit}
          />
          <QuickAction
            icon={<ArrowUpFromLine className="h-5 w-5" />}
            label="Take out money"
            hint="Send your money to you"
            onClick={onWithdraw}
          />
          <QuickAction
            icon={<ArrowLeftRight className="h-5 w-5" />}
            label="Send money"
            hint="Move it to someone else"
            onClick={onTransfer}
          />
          <QuickAction
            icon={<Landmark className="h-5 w-5" />}
            label="See my records"
            hint="Money in and money out"
            onClick={onViewStatement ?? onViewWallet}
          />
          <QuickAction
            icon={<Sparkles className="h-5 w-5" />}
            label="Invite & earn"
            hint="Share your link, earn UGX 10,000"
            onClick={() => navigate('/merchant-agent-referrals')}
          />
        </div>
      </section>


      {/* Shared payout float + this merchant's settlement position */}
      <MerchantFloatAvailableCard />

      {/* Merchant Payouts CTA */}
      <motion.button
        onClick={() => {
          hapticTap();
          onOpenCashPayouts();
        }}
        whileTap={{ scale: 0.97 }}
        className="relative w-full overflow-hidden rounded-3xl border border-amber-400/40 bg-gradient-to-br from-amber-500 to-orange-500 p-5 text-left shadow-xl shadow-amber-500/20"
        style={{ WebkitTapHighlightColor: 'transparent' }}
      >
        <div className="pointer-events-none absolute inset-0 -translate-x-full animate-[shimmer_2.8s_infinite] bg-gradient-to-r from-transparent via-white/25 to-transparent" />
        <div className="relative z-10 flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-white/30 bg-white/20 backdrop-blur-md">
              <Banknote className="h-7 w-7 text-white" />
            </div>
            <div className="min-w-0">
              <p className="text-base font-bold text-white">People waiting for their money</p>
              <div className="mt-1 flex items-center gap-2">
                {pendingCount > 0 ? (
                  <>
                    <span className="relative flex h-2 w-2">
                      <span className="absolute inset-0 animate-ping rounded-full bg-white/80" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-card" />
                    </span>
                    <p className="truncate text-xs text-white/90">
                      {pendingCount} {pendingCount === 1 ? 'person is' : 'people are'} waiting to be paid
                    </p>
                  </>
                ) : (
                  <p className="truncate text-xs text-white/90">
                    Nobody is waiting right now · Mobile money, bank{handlesCash ? ' or cash' : ''}
                  </p>
                )}
              </div>
            </div>
          </div>
          <div className="inline-flex shrink-0 items-center gap-1 rounded-xl border border-white/30 bg-white/10 px-4 py-2.5 text-xs font-bold text-white backdrop-blur-md">
            Pay now
            <ChevronRight className="h-4 w-4" />
          </div>
        </div>
      </motion.button>

      {/* Quick Insights */}
      <section className="rounded-3xl border border-border/60 bg-card p-5">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-bold">How you did this week</h3>
          </div>
          <span className="text-[11px] font-medium text-muted-foreground">
            Last 7 days
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <InsightTile
            label="Money you paid out"
            hint="Total in the last 7 days"
            value={formatUGX(insights?.volume ?? 0)}
            icon={<TrendingUp className="h-3.5 w-3.5" />}
            accent="bg-emerald-500"
            progress={insights?.volume ? Math.min(100, Math.round((insights.volume / 5_000_000) * 100)) : 0}
          />
          <InsightTile
            label="Usual payment size"
            hint="Average of each payout"
            value={formatUGX(insights?.avg ?? 0)}
            icon={<Banknote className="h-3.5 w-3.5" />}
            accent="bg-indigo-500"
            progress={insights?.avg ? Math.min(100, Math.round((insights.avg / 200_000) * 100)) : 0}
          />
          <InsightTile
            label="Receipts you added"
            hint="Payouts with proof attached"
            value={successPct === null ? '—' : `${successPct}%`}
            icon={<CheckCircle2 className="h-3.5 w-3.5" />}
            accent={successPct !== null && successPct >= 80 ? 'bg-emerald-500' : 'bg-amber-500'}
            progress={successPct ?? 0}
          />
          <InsightTile
            label="Your pay coming"
            hint="Commission not yet paid to you"
            value={formatUGX(pendingCommission ?? 0)}
            icon={<Timer className="h-3.5 w-3.5" />}
            accent="bg-amber-500"
            progress={pendingCommission ? Math.min(100, Math.round((pendingCommission / 50_000) * 100)) : 0}
          />
        </div>
      </section>

      {/* Transaction history CTA */}
      <motion.button
        type="button"
        onClick={() => {
          hapticTap();
          navigate('/agent/transaction-history');
        }}
        whileTap={{ scale: 0.97 }}
        className="flex w-full items-center justify-between gap-4 rounded-3xl border border-border/60 bg-card p-4 text-left transition-all hover:border-primary/40"
        style={{ WebkitTapHighlightColor: 'transparent' }}
      >
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <History className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-bold text-foreground">Everyone you have paid</p>
            <p className="truncate text-xs text-muted-foreground">
              Name, phone, amount, date and payment code
            </p>
          </div>
        </div>
        <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
      </motion.button>

    </div>
  );
}

function BentoBalance({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  hint: string;
}) {
  return (
    <div className="rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur-lg transition-all active:scale-[0.98]">
      <div className="mb-2.5 flex items-center gap-1.5 opacity-80">
        {icon}
        <span className="text-[10px] font-bold uppercase tracking-wider">{label}</span>
      </div>
      <p className="truncate text-lg font-bold tabular-nums leading-tight">
        {formatUGX(value)}
      </p>
      <p className="mt-1 truncate text-[10px] opacity-60">{hint}</p>
    </div>
  );
}

function QuickAction({
  icon,
  label,
  hint,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={() => {
        hapticTap();
        onClick();
      }}
      className="group flex items-center gap-3 rounded-3xl border border-border/60 bg-card p-4 text-left transition-all hover:border-primary/40 active:scale-95"
      style={{ WebkitTapHighlightColor: 'transparent' }}
    >
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/20 transition-transform group-active:rotate-6">
        {icon}
      </div>
      <span className="min-w-0">
        <span className="block truncate text-sm font-bold text-foreground">{label}</span>
        {hint && (
          <span className="block truncate text-[11px] text-muted-foreground">{hint}</span>
        )}
      </span>
    </button>
  );
}

function InsightTile({
  label,
  hint,
  value,
  icon,
  accent,
  progress,
}: {
  label: string;
  hint?: string;
  value: string;
  icon: React.ReactNode;
  accent: string;
  progress: number;
}) {
  return (
    <div className="rounded-2xl bg-muted/40 p-3.5">
      <div className="mb-1 flex items-center gap-1.5 text-muted-foreground">
        {icon}
        <span className="text-[11px] font-semibold leading-tight">{label}</span>
      </div>
      <p className="truncate text-lg font-bold tabular-nums text-foreground">{value}</p>
      {hint && <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{hint}</p>}
      <div className="mt-2.5 h-1 w-full overflow-hidden rounded-full bg-background/80">
        <div
          className={cn('h-full rounded-full transition-all', accent)}
          style={{ width: `${Math.max(4, Math.min(100, progress))}%` }}
        />
      </div>
    </div>
  );
}

export default MerchantDashboardHome;