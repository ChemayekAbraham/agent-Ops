import { useState, useEffect, useMemo } from 'react';
import { motion, useSpring } from 'framer-motion';
import {
  TrendingUp, Shield, Wallet, ChevronRight, Zap, Clock,
  AlertTriangle, CheckCircle2, BarChart3, PiggyBank, Activity,
  ArrowDownRight, ArrowUpRight, Droplets } from
'lucide-react';
import { useCurrency } from '@/hooks/useCurrency';
import { useOpportunitySummary } from '@/hooks/useOpportunitySummary';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { FundRentDialog } from './FundRentDialog';
import { InvestmentWithdrawButton } from './InvestmentWithdrawButton';
import { useAuth } from '@/hooks/useAuth';
import { useFunderApprovalStatus } from '@/hooks/useFunderApprovalStatus';
import { Lock } from 'lucide-react';

// ─── Animated counter ───
function AnimatedCounter({ value, className = '' }: {value: number;className?: string;}) {
  const [display, setDisplay] = useState(value);
  const spring = useSpring(value, { stiffness: 80, damping: 28 });

  useEffect(() => {spring.set(value);}, [value, spring]);
  useEffect(() => {
    const unsub = spring.on('change', (v) => setDisplay(Math.round(v)));
    return unsub;
  }, [spring]);

  const { formatAmount } = useCurrency();
  return <span className={className}>{formatAmount(display)}</span>;
}

// ─── Constants ───
const MONTHLY_RETURN_RATE = 0.15;
const DAILY_RETURN_RATE = MONTHLY_RETURN_RATE / 30;
const LIQUIDITY_WARNING_THRESHOLD = 0.15;
const LIQUIDITY_CAUTION_THRESHOLD = 0.20;

interface FundingPoolCardProps {
  fundedAmount: number; // user's funded capital
}

export function FundingPoolCard({ fundedAmount }: FundingPoolCardProps) {
  const { summary, loading } = useOpportunitySummary();
  const { formatAmount } = useCurrency();
  const [showFundDialog, setShowFundDialog] = useState(false);
  const { user } = useAuth();
  const { isApproved, status } = useFunderApprovalStatus(user?.id);

  // ─── Payout cycle (day of current month) ───
  const now = new Date();
  const cycleDay = now.getDate();
  const cycleDaysTotal = 30;
  const cycleProgress = Math.min(cycleDay / cycleDaysTotal * 100, 100);
  const payoutReady = cycleProgress >= 100;

  // ─── Financial calculations ───
  const monthlyProfit = fundedAmount * MONTHLY_RETURN_RATE;
  const dailyProfit = fundedAmount * DAILY_RETURN_RATE;
  const earnedThisCycle = dailyProfit * cycleDay;

  // Next payout = last day of current month
  const nextPayoutDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);

  // ─── Pool metrics (dynamic from opportunity summary) ───
  const poolTotal = summary ? Number(summary.total_rent_requested) : 0;

  const poolUtilized = useMemo(() => {
    // funded amount represents capital already deployed from this user
    return fundedAmount;
  }, [fundedAmount]);

  const poolAvailable = Math.max(poolTotal - poolUtilized, 0);
  const utilizationPct = poolTotal > 0 ? poolUtilized / poolTotal * 100 : 0;
  const liquidityPct = poolTotal > 0 ? poolAvailable / poolTotal : 1;

  const liquidityStatus: 'healthy' | 'caution' | 'warning' =
  liquidityPct < LIQUIDITY_WARNING_THRESHOLD ? 'warning' :
  liquidityPct < LIQUIDITY_CAUTION_THRESHOLD ? 'caution' : 'healthy';

  const liquidityConfig = {
    healthy: { label: 'Healthy', color: 'text-emerald-500', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', dot: 'bg-emerald-500' },
    caution: { label: 'Moderate', color: 'text-amber-500', bg: 'bg-amber-500/10', border: 'border-amber-500/30', dot: 'bg-amber-500' },
    warning: { label: 'Low Liquidity', color: 'text-red-500', bg: 'bg-red-500/10', border: 'border-red-500/30', dot: 'bg-red-500' }
  };

  const liq = liquidityConfig[liquidityStatus];

  if (loading) {
    return <div className="h-64 rounded-2xl bg-muted/30 animate-pulse" />;
  }

  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="rounded-2xl overflow-hidden shadow-lg border border-blue-200/40 dark:border-blue-900/40 bg-gradient-to-br from-white via-blue-50/30 to-blue-100/20 dark:from-card dark:via-blue-950/20 dark:to-blue-900/10">
        
        {/* ═══ HEADER ═══ */}
        <div className="px-5 pt-5 pb-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-gradient-to-br from-blue-500 to-blue-600 shadow-md shadow-blue-500/25">
              <PiggyBank className="h-5 w-5 text-white" />
            </div>
            <div>
              <h3 className="font-black text-foreground text-base tracking-tight">TOTAL RENT </h3>
              <p className="text-[11px] text-muted-foreground font-medium">Capital deployment & returns</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            
            <Badge variant="outline" className="text-[9px] px-2 py-0.5 border-emerald-500/40 text-emerald-600 bg-emerald-500/5 font-bold uppercase tracking-wider">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1 animate-pulse" />
              Active
            </Badge>
          </div>
        </div>

        {/* ═══ POOL BALANCE HERO ═══ */}
        <div className="px-5 pb-4">
          <p className="text-[10px] text-blue-600/70 dark:text-blue-400/70 font-bold uppercase tracking-widest mb-1">RENT NEEDED NOW</p>
          <p className="text-3xl font-black text-foreground tracking-tight leading-none">
            <AnimatedCounter value={poolTotal} />
          </p>
        </div>

        {/* ═══ POOL METRICS GRID ═══ */}
        <div className="mx-5 mb-4 grid grid-cols-1 sm:grid-cols-3 gap-2">
          <div className="rounded-xl bg-blue-500/8 dark:bg-blue-500/10 border border-blue-200/50 dark:border-blue-800/50 p-3 text-center">
            <Droplets className="h-3.5 w-3.5 text-blue-500 mx-auto mb-1" />
            <p className="text-sm font-black text-foreground leading-none">{formatAmount(poolAvailable)}</p>
            <p className="text-[9px] text-muted-foreground font-semibold mt-1">Available</p>
          </div>
          <div className="rounded-xl bg-blue-500/8 dark:bg-blue-500/10 border border-blue-200/50 dark:border-blue-800/50 p-3 text-center">
            <ArrowUpRight className="h-3.5 w-3.5 text-blue-600 mx-auto mb-1" />
            <p className="text-sm font-black text-foreground leading-none">{formatAmount(poolUtilized)}</p>
            <p className="text-[9px] text-muted-foreground font-semibold mt-1">Rent Needed</p>
          </div>
          <div className="rounded-xl bg-blue-500/8 dark:bg-blue-500/10 border border-blue-200/50 dark:border-blue-800/50 p-3 text-center">
            <BarChart3 className="h-3.5 w-3.5 text-blue-500 mx-auto mb-1" />
            <p className="text-sm font-black text-foreground leading-none">{utilizationPct.toFixed(1)}%</p>
            <p className="text-[9px] text-muted-foreground font-semibold mt-1">Utilization</p>
          </div>
        </div>

        {/* ═══ LIQUIDITY HEALTH BAR ═══ */}
        <div className="mx-5 mb-4">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">Liquidity Health</span>
            


            
          </div>
          <div className="h-2 rounded-full bg-muted/40 overflow-hidden">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${Math.min(liquidityPct * 100, 100)}%` }}
              transition={{ duration: 1, ease: 'easeOut' }}
              className={`h-full rounded-full ${
              liquidityStatus === 'healthy' ? 'bg-gradient-to-r from-emerald-400 to-emerald-500' :
              liquidityStatus === 'caution' ? 'bg-gradient-to-r from-amber-400 to-amber-500' :
              'bg-gradient-to-r from-red-400 to-red-500'}`
              } />
            
          </div>
        </div>

        {/* ═══ 30-DAY PAYOUT CYCLE ═══ */}
        <div className="mx-5 mb-4 rounded-xl border border-blue-200/50 dark:border-blue-800/40 bg-gradient-to-br from-blue-50/50 to-transparent dark:from-blue-950/30 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-blue-500" />
              <span className="text-xs font-bold text-foreground">Payout Cycle</span>
            </div>
            {payoutReady ?
            <Badge className="bg-emerald-500/15 text-emerald-600 border-emerald-500/30 text-[10px] font-bold gap-1">
                <CheckCircle2 className="h-3 w-3" />
                Payout Ready
              </Badge> :

            <span className="text-[10px] text-muted-foreground font-semibold">
                Day {cycleDay} of {cycleDaysTotal}
              </span>
            }
          </div>

          {/* Progress bar */}
          <div className="space-y-1.5">
            <div className="h-3 rounded-full bg-blue-100/60 dark:bg-blue-900/30 overflow-hidden relative">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${cycleProgress}%` }}
                transition={{ duration: 1.2, ease: 'easeOut' }}
                className={`h-full rounded-full ${
                payoutReady ?
                'bg-gradient-to-r from-emerald-400 to-emerald-500' :
                cycleProgress > 80 ?
                'bg-gradient-to-r from-blue-400 via-blue-500 to-amber-400' :
                'bg-gradient-to-r from-blue-400 to-blue-500'}`
                } />
              
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground font-semibold">
                {cycleProgress.toFixed(0)}% complete
              </span>
              <span className="text-[10px] text-blue-600 dark:text-blue-400 font-bold">
                Earned: {formatAmount(earnedThisCycle)}
              </span>
            </div>
          </div>

          {/* Next payout date */}
          {!payoutReady &&
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <Clock className="h-3 w-3" />
              <span>Next payout: <strong className="text-foreground">{nextPayoutDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</strong></span>
            </div>
          }
        </div>

        {/* ═══ RETURNS & TERMS ═══ */}
        <div className="px-5 pb-4 space-y-2">
          <div className="flex items-center justify-between py-2 border-b border-border/30">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <TrendingUp className="h-3.5 w-3.5 text-emerald-500" />
              <span className="font-medium">Monthly Return</span>
            </div>
            <span className="text-sm font-black text-emerald-600">15%</span>
          </div>
          <div className="flex items-center justify-between py-2 border-b border-border/30">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Zap className="h-3.5 w-3.5 text-blue-500" />
              <span className="font-medium">Deployment Speed</span>
            </div>
            <span className="text-xs font-bold text-foreground">24–72 hours</span>
          </div>
          <div className="flex items-center justify-between py-2 border-b border-border/30">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Wallet className="h-3.5 w-3.5 text-blue-500" />
              <span className="font-medium">Payouts</span>
            </div>
            <span className="text-xs font-bold text-foreground">Monthly to wallet</span>
          </div>
          <div className="flex items-center justify-between py-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Shield className="h-3.5 w-3.5 text-blue-500" />
              <span className="font-medium">Risk Control</span>
            </div>
            <span className="text-xs font-bold text-foreground">Verified & insured</span>
          </div>
        </div>

        {/* ═══ CTA ═══ */}
        <div className="px-5 pt-2 pb-4 space-y-3">
          <Button
            onClick={() => isApproved && setShowFundDialog(true)}
            disabled={liquidityStatus === 'warning' || !isApproved}
            className="w-full gap-2 rounded-xl font-bold h-12 text-sm bg-gradient-to-r from-purple-600 to-purple-500 hover:from-purple-700 hover:to-purple-600 shadow-lg shadow-purple-500/25 text-white">
            {isApproved ? (
              <>Support Tenant <ChevronRight className="h-4 w-4" /></>
            ) : (
              <><Lock className="h-4 w-4" /> {status === 'rejected' ? 'Verification Required' : 'Awaiting Verification'}</>
            )}
          </Button>

          <InvestmentWithdrawButton />

          <div className="flex items-center justify-center gap-3 text-[10px] text-muted-foreground pt-1">
            <span className="flex items-center gap-1">
              <Clock className="h-2.5 w-2.5" />
              Avg. cycle: 30 days
            </span>
            <span className="text-border">•</span>
            <span>Min: {formatAmount(50000)}</span>
          </div>

          <p className="text-[9px] text-muted-foreground/60 text-center leading-relaxed">
            Returns are projected based on historical performance. Capital is deployed into verified rent facilitation agreements managed by Welile with reserve protection.
          </p>
        </div>
      </motion.div>

      {/* ═══ EARNINGS BREAKDOWN ═══ */}
      {fundedAmount > 0 &&
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.15 }}
        className="rounded-2xl border border-blue-200/40 dark:border-blue-900/40 bg-gradient-to-br from-white to-blue-50/30 dark:from-card dark:to-blue-950/10 p-5 space-y-3 mt-4 shadow-sm">
        
          <div className="flex items-center gap-2 mb-1">
            <BarChart3 className="h-4 w-4 text-blue-500" />
            <h4 className="text-sm font-black text-foreground">Earnings Breakdown</h4>
          </div>

          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground font-medium flex items-center gap-1.5">
                <ArrowDownRight className="h-3 w-3 text-blue-500" />
                Your Funded Amount
              </span>
              <span className="text-sm font-black text-foreground">{formatAmount(fundedAmount)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground font-medium flex items-center gap-1.5">
                <TrendingUp className="h-3 w-3 text-emerald-500" />
                Monthly Profit (15%)
              </span>
              <span className="text-sm font-black text-emerald-600">{formatAmount(monthlyProfit)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground font-medium flex items-center gap-1.5">
                <Zap className="h-3 w-3 text-blue-500" />
                Daily Profit
              </span>
              <span className="text-sm font-bold text-foreground">{formatAmount(dailyProfit)}</span>
            </div>
            <div className="h-px bg-border/40" />
            <div className="flex items-center justify-between">
              <span className="text-xs text-foreground font-bold flex items-center gap-1.5">
                <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                Earned This Cycle
              </span>
              <span className="text-base font-black text-emerald-600">
                <AnimatedCounter value={earnedThisCycle} />
              </span>
            </div>
          </div>
        </motion.div>
      }

      {summary &&
      <FundRentDialog
        open={showFundDialog}
        onOpenChange={setShowFundDialog}
        summary={summary} />

      }
    </>);

}