import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { ArrowRight, Wallet, TrendingDown, Landmark, Loader2 } from 'lucide-react';

interface TreasuryImpactBannerProps {
  payoutAmount: number;
}

export function TreasuryImpactBanner({ payoutAmount }: TreasuryImpactBannerProps) {
  const { data, isLoading } = useQuery({
    queryKey: ['treasury-impact-cash-position'],
    queryFn: async () => {
      // Same two sources the CFO Overview reports from, so a payout decision and
      // the Overview can never show different numbers:
      //   Money We Have  -> get_treasury_cash_position (A1 + A5, balance-sheet basis)
      //   Money We Owe   -> get_wallet_totals.total_balance
      // This used to call get_treasury_snapshot, a flat SUM(cash_in - cash_out)
      // over every ledger_scope='platform' row. That sweeps in liability legs
      // (cash_custody_payable) and custody/float offsets, which are not treasury
      // cash, and it read wallets.balance directly instead of the wallet totals
      // cache — so both halves of this banner disagreed with the Overview.
      const [cashRes, walletRes] = await Promise.all([
        supabase.rpc('get_treasury_cash_position', {}),
        supabase.rpc('get_wallet_totals'),
      ]);
      if (cashRes.error) throw cashRes.error;
      if (walletRes.error) throw walletRes.error;

      // Payout capacity is company cash we can actually use: A1 Cash and Bank
      // only. Cash in custody (A5) has no verified banking event, so it is
      // never treated as available cash here.
      const cash = cashRes.data as unknown as {
        total_cash?: number | string;
        available_company_cash?: number | string;
      } | null;
      const wallets = walletRes.data as unknown as { total_balance?: number | string } | null;
      return {
        totalCash: Number(cash?.available_company_cash ?? cash?.total_cash ?? 0),

        walletTotal: Number(wallets?.total_balance ?? 0),
      };
    },
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading treasury…
      </div>
    );
  }

  const totalCash = data?.totalCash || 0;
  const remaining = totalCash - payoutAmount;
  const walletTotal = data?.walletTotal || 0;
  const isRisky = remaining < walletTotal;

  // Sign-preserving — identical to the Overview's formatter. The previous
  // Math.abs() version rendered a negative treasury position as a positive
  // number, turning a deficit into an apparent surplus on the approval screen.
  const fmt = (n: number) =>
    `${n < 0 ? '-' : ''}UGX ${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.abs(n))}`;

  return (
    <div className={`rounded-lg p-3 space-y-2 text-sm border ${isRisky ? 'bg-destructive/10 border-destructive/30' : 'bg-muted/50 border-border'}`}>
      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
        Treasury Impact
      </p>
      <div className="flex items-center gap-2 flex-wrap text-xs sm:text-sm">
        <div className="flex items-center gap-1.5">
          <Landmark className="h-4 w-4 text-primary shrink-0" />
          <div>
            <p className="text-[10px] text-muted-foreground leading-none">We Have</p>
            <p className={`font-bold ${totalCash < 0 ? 'text-destructive' : ''}`}>{fmt(totalCash)}</p>
          </div>
        </div>

        <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />

        <div className="flex items-center gap-1.5">
          <TrendingDown className="h-4 w-4 text-orange-500 shrink-0" />
          <div>
            <p className="text-[10px] text-muted-foreground leading-none">This Payout</p>
            <p className="font-bold text-orange-600">−{fmt(Math.abs(payoutAmount))}</p>
          </div>
        </div>

        <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />

        <div className="flex items-center gap-1.5">
          <Wallet className={`h-4 w-4 shrink-0 ${isRisky ? 'text-destructive' : 'text-emerald-500'}`} />
          <div>
            <p className="text-[10px] text-muted-foreground leading-none">We Keep</p>
            <p className={`font-bold ${isRisky ? 'text-destructive' : 'text-emerald-600'}`}>
              {fmt(remaining)}
            </p>
          </div>
        </div>
      </div>

      {isRisky && (
        <p className="text-[10px] text-destructive font-medium">
          ⚠️ After this payout, remaining cash ({fmt(remaining)}) will be less than user wallets ({fmt(walletTotal)}).
        </p>
      )}
    </div>
  );
}
