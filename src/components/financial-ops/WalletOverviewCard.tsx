import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Wallet, Users, ShieldCheck, Banknote, Pause, Play, MinusCircle, ChevronRight, Scale, AlertTriangle, CheckCircle2, ArrowRightLeft } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { useFinOpsAutoRefresh, setFinOpsAutoRefresh } from '@/hooks/useFinOpsAutoRefresh';
import { Switch } from '@/components/ui/switch';
import { useWalletRealtime } from '@/hooks/useWalletRealtime';

interface WalletOverviewCardProps {
  /**
   * When provided, the hero body becomes a button that opens the Wallet
   * Deductions tool. The auto-refresh toggle and inner stat tiles still
   * stop propagation so they keep their independent behavior.
   */
  onOpenDeductions?: () => void;
  /**
   * Tapping the "X with balance" pill opens Wallet Deductions pre-loaded
   * with the "All with balance" preset so operators can immediately drill
   * into every wallet currently holding money.
   */
  onViewActiveWallets?: () => void;
  /**
   * Tapping the "Ledger drift" line opens the Reconciliation tool so the
   * operator can investigate / sweep the excess. Optional — when omitted
   * the drift line is informational only.
   */
  onOpenReconciliation?: () => void;
  /**
   * Tapping the "Ledger total" row opens the read-only Wallet Breakdown
   * so a manager can search every wallet by name, phone or balance range.
   */
  onOpenBreakdown?: () => void;
  /**
   * Tapping the Operations Float or Withdrawable tile drills into the
   * breakdown table focused on that specific bucket (filtered to wallets
   * holding that bucket and sorted by it).
   */
  onDrillBucket?: (bucket: 'float' | 'withdrawable') => void;
}

export function WalletOverviewCard({ onOpenDeductions, onViewActiveWallets, onOpenReconciliation, onOpenBreakdown, onDrillBucket }: WalletOverviewCardProps = {}) {
  // Operators reviewing a deposit don't want the screen reshuffling under
  // their cursor. The shared toggle gates polling on this card AND on the
  // Verify Deposits hub at the same time.
  const autoRefresh = useFinOpsAutoRefresh();

  // Money moving anywhere on the platform (ledger insert, wallet row change,
  // deduction) instantly invalidates these three queries so the headline
  // figures track cash in / cash out instead of waiting for the next poll.
  useWalletRealtime(undefined, [
    ['finops-wallet-overview'],
    ['finops-wallet-overview-strict'],
    ['finops-wallet-overview-queues'],
  ]);

  const { data, isLoading } = useQuery({
    queryKey: ['finops-wallet-overview'],
    queryFn: async () => {
      // Server-side RPC bypasses RLS and the 1000-row limit
      const { data, error } = await supabase.rpc('get_wallet_totals');
      if (error) throw error;
      const d = data as any;
      return {
        totalBalance: Number(d.total_balance ?? 0),
        walletCount: Number(d.total_wallets ?? 0),
        activeWallets: Number(d.active_wallets ?? 0),
        totalFloat: Number(d.total_float ?? 0),
        totalWithdrawable: Number(d.total_withdrawable ?? 0),
        computedAt: d.computed_at ? new Date(d.computed_at) : null,
      };
    },
    staleTime: 15_000,
    refetchInterval: autoRefresh ? 20_000 : false,
  });

  // Strict ledger companion to the cached headline above. Surfaces the
  // true ledger position so Fin Ops sees, side-by-side, how much phantom
  // cache is sitting above the real liability. This query is independent —
  // if it fails or is slow the cached headline is never blocked.
  const { data: strict, isLoading: strictLoading } = useQuery({
    queryKey: ['finops-wallet-overview-strict'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_wallet_totals_strict');
      if (error) throw error;
      const d = data as any;
      return {
        strictTotal: Number(d?.strict_total ?? 0),
        driftedWallets: Number(d?.drifted_wallets ?? 0),
        totalDrift: Number(d?.total_drift ?? 0),
      };
    },
    staleTime: 15_000,
    refetchInterval: autoRefresh ? 20_000 : false,
  });

  // Live counters that drive the two big action buttons. We only need
  // the *count* of pending items, not the rows themselves, so we use
  // head-only queries (cheap, RLS-respecting). Sequential awaits keep
  // the inferred PostgREST union from blowing up `Promise.all`'s tuple.
  const { data: queues } = useQuery({
    queryKey: ['finops-wallet-overview-queues'],
    queryFn: async () => {
      const userDeposits = await supabase
        .from('deposit_requests')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending');
      const fieldDeposits = await supabase
        .from('field_deposit_batches')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending_finops_verification');
      const withdrawals = await supabase
        .from('withdrawal_requests')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending');
      return {
        depositsPending: (userDeposits.count ?? 0) + (fieldDeposits.count ?? 0),
        payoutsPending: withdrawals.count ?? 0,
      };
    },
    refetchInterval: autoRefresh ? 20_000 : false,
    staleTime: 10_000,
  });

  const interactive = !!onOpenDeductions;

  const handleOpen = () => {
    if (onOpenDeductions) onOpenDeductions();
  };

  const handleKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!interactive) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleOpen();
    }
  };

  // Drift > 100 UGX is the same tolerance the SQL function uses to count
  // a wallet as "drifted". Below that we treat it as reconciled noise.
  const driftIsMaterial = (strict?.totalDrift ?? 0) > 100 || (strict?.driftedWallets ?? 0) > 0;
  const driftClickable = driftIsMaterial && !!onOpenReconciliation;

  return (
    <div
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? 'Open Wallet Deductions' : undefined}
      onClick={interactive ? handleOpen : undefined}
      onKeyDown={interactive ? handleKey : undefined}
      className={`rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/10 via-card to-card p-5 sm:p-6 ${
        interactive
          ? 'cursor-pointer transition-all hover:border-primary/50 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background'
          : ''
      } overflow-hidden h-full flex flex-col shadow-2xs relative`}
    >
      <div className="flex items-start justify-between gap-3 mb-4 min-w-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-10 w-10 rounded-xl bg-primary/15 text-primary flex items-center justify-center shrink-0 border border-primary/25">
            <Wallet className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground truncate">
                Total Money in All Wallets
              </p>
              <span className="hidden sm:inline-flex px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-primary/15 text-primary border border-primary/20">
                Ledger Total
              </span>
            </div>
            {data?.computedAt && (
              <p className="text-[10px] text-muted-foreground/80 mt-0.5">
                As of {data.computedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {interactive && (
            <span
              className="hidden sm:inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary"
              aria-hidden
            >
              <MinusCircle className="h-3 w-3" /> Tap to deduct
              <ChevronRight className="h-3 w-3" />
            </span>
          )}

          {/* Auto-refresh toggle — paused state surfaces clearly so operators
              never wonder why a number is stale. */}
          <label
            onClick={(e) => e.stopPropagation()}
            className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground cursor-pointer select-none shrink-0 bg-background/60 hover:bg-background border border-border/80 px-2.5 py-1 rounded-full transition-colors"
            title={
              autoRefresh
                ? 'Auto-refresh is on. Pause to keep the screen stable while you review.'
                : 'Auto-refresh is paused. Numbers will not update until you resume.'
            }
          >
            {autoRefresh ? (
              <Play className="h-3 w-3 text-emerald-600 dark:text-emerald-400 fill-emerald-600/30" />
            ) : (
              <Pause className="h-3 w-3 text-amber-500 fill-amber-500/30" />
            )}
            <span className="uppercase tracking-wider font-semibold text-[10px]">
              {autoRefresh ? 'Live' : 'Paused'}
            </span>
            <Switch
              checked={autoRefresh}
              onCheckedChange={setFinOpsAutoRefresh}
              aria-label="Toggle auto-refresh"
              className="scale-75 origin-right"
            />
          </label>
        </div>
      </div>

      <div className="my-1">
        <p className={`text-3xl sm:text-4xl font-black tabular-nums tracking-tight break-all ${isLoading ? 'animate-pulse text-muted-foreground' : 'text-foreground'}`}>
          {isLoading ? '———' : formatUGX(data?.totalBalance ?? 0)}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5 font-medium">
          <Users className="h-3.5 w-3.5 text-muted-foreground/80" />
          {isLoading ? '—' : data?.walletCount?.toLocaleString()} wallets
        </span>
        <span className="text-muted-foreground/40">·</span>
        {onOpenBreakdown ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onOpenBreakdown(); }}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-primary font-semibold hover:bg-primary/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label="Open read-only wallet breakdown"
          >
            {isLoading ? '—' : data?.activeWallets?.toLocaleString()} with balance
            <ChevronRight className="h-3 w-3" />
          </button>
        ) : onViewActiveWallets ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onViewActiveWallets(); }}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-primary font-semibold hover:bg-primary/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label="View all wallets with balance"
          >
            {isLoading ? '—' : data?.activeWallets?.toLocaleString()} with balance
            <ChevronRight className="h-3 w-3" />
          </button>
        ) : (
          <span className="text-primary font-semibold">
            {isLoading ? '—' : data?.activeWallets?.toLocaleString()} with balance
          </span>
        )}
      </div>

      {/* ─── Bucket Breakdown: Float + Withdrawable ─── */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="mt-4 grid grid-cols-2 gap-2.5"
      >
        {onDrillBucket ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDrillBucket('float'); }}
            className="group text-left rounded-xl bg-background/70 backdrop-blur-sm border border-border/80 p-3 transition-all hover:border-primary/50 hover:bg-primary/5 hover:shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label="Drill down on Operations Float"
          >
            <div className="flex items-center justify-between gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              <span className="flex items-center gap-1.5"><ArrowRightLeft className="h-3 w-3 text-primary/80" /> Operations Float</span>
              <ChevronRight className="h-3 w-3 text-muted-foreground group-hover:text-primary group-hover:translate-x-0.5 transition-all" />
            </div>
            <p className="text-base sm:text-lg font-black tabular-nums mt-1 text-foreground break-all">
              {isLoading ? '—' : formatUGX(data?.totalFloat ?? 0)}
            </p>
          </button>
        ) : (
          <div className="rounded-xl bg-background/70 backdrop-blur-sm border border-border/80 p-3">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              <ArrowRightLeft className="h-3 w-3 text-primary/80" /> Operations Float
            </div>
            <p className="text-base sm:text-lg font-black tabular-nums mt-1 text-foreground break-all">
              {isLoading ? '—' : formatUGX(data?.totalFloat ?? 0)}
            </p>
          </div>
        )}
        {onDrillBucket ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDrillBucket('withdrawable'); }}
            className="group text-left rounded-xl bg-background/70 backdrop-blur-sm border border-border/80 p-3 transition-all hover:border-primary/50 hover:bg-primary/5 hover:shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label="Drill down on Withdrawable"
          >
            <div className="flex items-center justify-between gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              <span className="flex items-center gap-1.5"><Banknote className="h-3 w-3 text-primary/80" /> Withdrawable</span>
              <ChevronRight className="h-3 w-3 text-muted-foreground group-hover:text-primary group-hover:translate-x-0.5 transition-all" />
            </div>
            <p className="text-base sm:text-lg font-black tabular-nums mt-1 text-foreground break-all">
              {isLoading ? '—' : formatUGX(data?.totalWithdrawable ?? 0)}
            </p>
          </button>
        ) : (
          <div className="rounded-xl bg-background/70 backdrop-blur-sm border border-border/80 p-3">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              <Banknote className="h-3 w-3 text-primary/80" /> Withdrawable
            </div>
            <p className="text-base sm:text-lg font-black tabular-nums mt-1 text-foreground break-all">
              {isLoading ? '—' : formatUGX(data?.totalWithdrawable ?? 0)}
            </p>
          </div>
        )}
      </div>

      {/* ─── Strict ledger truth row (operator transparency) ─── */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="mt-3.5 pt-3 border-t border-border/80 space-y-1.5"
      >
        <div className="flex items-center justify-between gap-2 text-[11px] min-w-0">
          <span className="flex items-center gap-1.5 text-muted-foreground min-w-0">
            <Scale className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="uppercase tracking-wider font-semibold truncate">Ledger Total</span>
          </span>
          <span className="font-mono tabular-nums font-bold text-foreground break-all text-right">
            {strictLoading ? '———' : formatUGX(strict?.strictTotal ?? 0)}
          </span>
        </div>

        {strictLoading ? (
          <p className="text-[10px] text-muted-foreground">Checking ledger alignment…</p>
        ) : driftIsMaterial ? (
          driftClickable ? (
            <button
              type="button"
              onClick={onOpenReconciliation}
              className="flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400 font-semibold hover:underline text-left bg-amber-500/10 border border-amber-500/20 px-2.5 py-1 rounded-lg w-full transition-colors"
            >
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
              <span className="flex-1 truncate">
                Drift: {formatUGX(strict?.totalDrift ?? 0)} across {strict?.driftedWallets} wallet(s) — reconcile
              </span>
              <ChevronRight className="h-3.5 w-3.5 shrink-0" />
            </button>
          ) : (
            <p className="flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400 font-semibold bg-amber-500/10 border border-amber-500/20 px-2.5 py-1 rounded-lg">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
              <span>Drift: {formatUGX(strict?.totalDrift ?? 0)} across {strict?.driftedWallets} wallet(s)</span>
            </p>
          )
        ) : (
          <p className="flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
            <span>Ledger reconciled</span>
          </p>
        )}
      </div>

      {/* ─── Two live key stats that mirror the two action buttons below ─── */}
      <div className="grid grid-cols-2 gap-2.5 mt-3.5 pt-3.5 border-t border-border/80">
        <div
          onClick={(e) => e.stopPropagation()}
          className="rounded-xl bg-background/70 backdrop-blur-sm border border-border/80 p-3"
        >
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
            <ShieldCheck className="h-3.5 w-3.5 text-primary" /> Awaiting verification
          </div>
          <p className="text-xl sm:text-2xl font-black tabular-nums mt-1 text-foreground">
            {queues?.depositsPending ?? '—'}
          </p>
          <p className="text-[10px] text-muted-foreground mt-0.5">user + field deposits</p>
        </div>
        <div
          onClick={(e) => e.stopPropagation()}
          className="rounded-xl bg-background/70 backdrop-blur-sm border border-border/80 p-3"
        >
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
            <Banknote className="h-3.5 w-3.5 text-destructive" /> Awaiting payout
          </div>
          <p className="text-xl sm:text-2xl font-black tabular-nums mt-1 text-foreground">
            {queues?.payoutsPending ?? '—'}
          </p>
          <p className="text-[10px] text-muted-foreground mt-0.5">withdrawal requests</p>
        </div>
      </div>
    </div>
  );
}
