import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Wallet, Banknote, MinusCircle, ChevronRight, AlertTriangle, CheckCircle2, ArrowRightLeft } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { useFinOpsAutoRefresh } from '@/hooks/useFinOpsAutoRefresh';
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
  // their cursor. The shared toggle (now in the page header) gates polling on
  // this card AND on the Verify Deposits hub at the same time.
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

  const withBalance = isLoading ? '—' : data?.activeWallets?.toLocaleString();
  const bucketTile = 'group text-left flex items-center gap-2.5 rounded-xl border border-border/80 bg-background/70 p-3 min-w-0';
  const bucketTileButton = `${bucketTile} transition-all hover:border-primary/50 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary`;

  const bucket = (
    key: 'float' | 'withdrawable',
    Icon: typeof Wallet,
    label: string,
    amount: number,
  ) => {
    const inner = (
      <>
        <span className="h-9 w-9 rounded-xl bg-primary/10 border border-primary/20 text-primary flex items-center justify-center shrink-0">
          <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium text-muted-foreground">{label}</span>
          <span className="block text-base font-black tabular-nums text-foreground whitespace-nowrap">
            {isLoading ? '—' : formatUGX(amount)}
          </span>
        </span>
        {onDrillBucket && (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-primary group-hover:translate-x-0.5 transition-all" aria-hidden="true" />
        )}
      </>
    );
    return onDrillBucket ? (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onDrillBucket(key); }}
        className={bucketTileButton}
        aria-label={`Drill down on ${label}`}
      >
        {inner}
      </button>
    ) : (
      <div className={bucketTile}>{inner}</div>
    );
  };

  return (
    <div
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? 'Open Wallet Deductions' : undefined}
      onClick={interactive ? handleOpen : undefined}
      onKeyDown={interactive ? handleKey : undefined}
      className={`rounded-2xl border border-border bg-card p-5 sm:p-6 ${
        interactive
          ? 'cursor-pointer transition-all hover:border-primary/50 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background'
          : ''
      } overflow-hidden h-full flex flex-col shadow-2xs relative`}
    >
      <div className="flex items-start justify-between gap-3 min-w-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-11 w-11 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0 border border-primary/20">
            <Wallet className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2
              className="text-base font-bold tracking-tight text-foreground truncate"
              title={data?.computedAt ? `As of ${data.computedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : undefined}
            >
              Total Money in All Wallets
            </h2>
            <div className="flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
              <span>{isLoading ? '—' : data?.walletCount?.toLocaleString()} wallets</span>
              <span aria-hidden="true">·</span>
              {onOpenBreakdown ? (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onOpenBreakdown(); }}
                  className="inline-flex items-center gap-0.5 rounded-md text-primary font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  aria-label="Open read-only wallet breakdown"
                >
                  {withBalance} with balance <ChevronRight className="h-3 w-3" aria-hidden="true" />
                </button>
              ) : onViewActiveWallets ? (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onViewActiveWallets(); }}
                  className="inline-flex items-center gap-0.5 rounded-md text-primary font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  aria-label="View all wallets with balance"
                >
                  {withBalance} with balance <ChevronRight className="h-3 w-3" aria-hidden="true" />
                </button>
              ) : (
                <span className="text-primary font-semibold">{withBalance} with balance</span>
              )}
            </div>
          </div>
        </div>
        {interactive && (
          <span
            className="hidden sm:inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary shrink-0"
            aria-hidden
          >
            <MinusCircle className="h-3 w-3" /> Tap to deduct
            <ChevronRight className="h-3 w-3" />
          </span>
        )}
      </div>

      <p className={`mt-4 text-3xl sm:text-4xl font-black tabular-nums tracking-tight break-all ${isLoading ? 'animate-pulse text-muted-foreground' : 'text-foreground'}`}>
        {isLoading ? '———' : formatUGX(data?.totalBalance ?? 0)}
      </p>

      {/* Bucket breakdown: Operations Float + Withdrawable */}
      <div onClick={(e) => e.stopPropagation()} className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
        {bucket('float', ArrowRightLeft, 'Operations Float', data?.totalFloat ?? 0)}
        {bucket('withdrawable', Banknote, 'Withdrawable', data?.totalWithdrawable ?? 0)}
      </div>

      <div className="flex-1 min-h-[0.75rem]" />

      {/* Strict ledger truth row (operator transparency) */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-muted/50 border border-border/70 px-3.5 py-2.5 text-xs"
      >
        <span className="flex items-center gap-2 min-w-0">
          <span className="text-muted-foreground">Ledger Total</span>
          <span className="font-mono tabular-nums font-bold text-foreground break-all">
            {strictLoading ? '———' : formatUGX(strict?.strictTotal ?? 0)}
          </span>
        </span>
        {strictLoading ? (
          <span className="text-muted-foreground">Checking ledger alignment…</span>
        ) : driftIsMaterial ? (
          <span className="flex flex-wrap items-center gap-x-1.5 text-primary font-medium">
            <AlertTriangle className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            <span>Drift: {formatUGX(strict?.totalDrift ?? 0)} across {strict?.driftedWallets} wallet(s)</span>
            {driftClickable && (
              <>
                <span aria-hidden="true">·</span>
                <button
                  type="button"
                  onClick={onOpenReconciliation}
                  className="font-bold text-primary underline underline-offset-2 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
                >
                  Reconcile
                </button>
              </>
            )}
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-primary font-medium">
            <CheckCircle2 className="h-4 w-4 text-primary" aria-hidden="true" />
            Ledger reconciled
          </span>
        )}
      </div>
    </div>
  );
}
