import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Loader2, Landmark, Wallet, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';

export function PlatformVsWalletSummary() {
  const { data, isLoading } = useQuery({
    queryKey: ['cfo-platform-vs-wallets'],
    queryFn: async () => {
      const [walletTotalsRes, cashSummaryRes] = await Promise.all([
        supabase.rpc('get_wallet_totals'),
        supabase.rpc('get_platform_cash_summary'),
      ]);

      const totalWallets = Number((walletTotalsRes.data as any)?.total_balance ?? 0);
      const cashSummary = cashSummaryRes.data as any;
      const rev = Number(cashSummary?.total_revenue ?? 0);
      const costs = Number(cashSummary?.total_costs ?? 0);
      const platformCashIn = Number(cashSummary?.platform_cash_in ?? rev);
      const platformCashOut = Number(cashSummary?.platform_cash_out ?? costs);
      const platformNet = platformCashIn - platformCashOut;

      const walletCashIn = Number(cashSummary?.wallet_cash_in ?? 0);
      const walletCashOut = Number(cashSummary?.wallet_cash_out ?? 0);
      const ledgerNetWallets = walletCashIn - walletCashOut;
      const variance = totalWallets - ledgerNetWallets;

      return { totalWallets, platformNet, ledgerNetWallets, variance };
    },
    staleTime: 300_000,
    refetchOnWindowFocus: false,
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-6">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!data) return null;

  const { totalWallets, platformNet, variance } = data;
  const isBalanced = Math.abs(variance) < 100;

  return (
    <div className="space-y-2">
      {/* Stacked metric cards — clean and readable on all screens */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-3">
          <div className="p-2 rounded-lg bg-primary/10 shrink-0">
            <Wallet className="h-4 w-4 text-primary" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">User Wallets</p>
            <p className="text-base sm:text-lg font-bold font-mono tracking-tight truncate">
              {formatUGX(totalWallets)}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-3">
          <div className="p-2 rounded-lg bg-accent/10 shrink-0">
            <Landmark className="h-4 w-4 text-accent-foreground" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Platform Ledger</p>
            <p className={cn(
              "text-base sm:text-lg font-bold font-mono tracking-tight truncate",
              platformNet >= 0 ? "text-emerald-600" : "text-destructive"
            )}>
              {formatUGX(platformNet)}
            </p>
          </div>
        </div>
      </div>

      {/* Reconciliation status — compact inline */}
      <div className={cn(
        "flex items-center gap-2 rounded-lg px-3 py-2 text-[11px] font-medium",
        isBalanced
          ? "bg-emerald-500/8 text-emerald-600"
          : "bg-amber-500/8 text-amber-600"
      )}>
        {isBalanced ? (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="truncate">
          {isBalanced
            ? "Reconciled ✓"
            : `Variance: ${formatUGX(Math.abs(variance))}`}
        </span>
      </div>
    </div>
  );
}
