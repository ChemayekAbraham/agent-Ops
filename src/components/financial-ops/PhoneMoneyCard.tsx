import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Smartphone, Banknote, ChevronRight, ArrowRight } from 'lucide-react';
import mtnLogoAsset from '@/assets/mtn-logo.png.asset.json';
import airtelLogoAsset from '@/assets/airtel-logo.png.asset.json';
import { formatUGX } from '@/lib/rentCalculations';
import { useFinOpsAutoRefresh } from '@/hooks/useFinOpsAutoRefresh';
import { PhoneMoneyStatementSheet, type PhoneMoneyLine } from './PhoneMoneyStatementSheet';

/**
 * Phone Money — the real balance sitting on the merchant MTN/Airtel lines
 * (parsed from the balance in each provider SMS) plus verified cash that has
 * been collected via deposit codes but not yet marked as banked.
 *
 * No target/ratio comparison — this card is purely "where is the float right now".
 */
export function PhoneMoneyCard() {
  const autoRefresh = useFinOpsAutoRefresh();
  const [openLine, setOpenLine] = useState<PhoneMoneyLine | null>(null);

  // Polled, not Realtime: the old listener was unfiltered on gmail_transactions
  // (about one new row a minute) and cash_deposit_verifications, and re-ran
  // both RPCs on every change (doc 147). With the FinOps auto-refresh toggle
  // off, the card still refreshes every 60s, since it used to stay live.
  const pollMs = autoRefresh ? 20_000 : 60_000;

  const { data: phone, isLoading: phoneLoading } = useQuery({
    queryKey: ['finops-phone-money-lines'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_phone_platform_reconciliation' as any);
      if (error) throw error;
      const d = (data ?? {}) as any;
      return {
        mtn: Number(d.mtn_balance ?? 0),
        airtel: Number(d.airtel_balance ?? 0),
        totalFloat: Number(d.total_float ?? 0),
      };
    },
    staleTime: 15_000,
    refetchInterval: pollMs,
  });

  // Cash at hand is role-gated inside the RPC; a denied call simply renders 0
  // rather than breaking the card for staff without finance roles.
  const { data: cash, isLoading: cashLoading } = useQuery({
    queryKey: ['finops-cash-at-hand-total'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_cash_at_hand_total' as any);
      if (error) throw error;
      const d = (data ?? {}) as any;
      return { total: Number(d.cash_at_hand_total ?? 0), count: Number(d.verified_count ?? 0) };
    },
    retry: false,
    staleTime: 15_000,
    refetchInterval: pollMs,
  });

  const loading = phoneLoading || cashLoading;
  const mtn = phone?.mtn ?? 0;
  const airtel = phone?.airtel ?? 0;
  const cashAtHand = cash?.total ?? 0;
  const total = (phone?.totalFloat ?? 0) + cashAtHand;

  const rows = [
    { label: 'MTN Money', amount: mtn, logo: mtnLogoAsset.url, line: 'mtn_momo' as PhoneMoneyLine },
    { label: 'Airtel Money', amount: airtel, logo: airtelLogoAsset.url, line: 'airtel_money' as PhoneMoneyLine },
    { label: 'Cash at Hand', amount: cashAtHand, logo: null as string | null, line: 'cash' as PhoneMoneyLine },
  ];

  return (
    <div className="rounded-xl border border-border bg-card p-5 sm:p-6 min-w-0 flex flex-col h-full shadow-2xs relative">
      <div className="flex items-start justify-between gap-3 mb-4 min-w-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-11 w-11 rounded-xl bg-primary/10 border border-primary/20 text-primary flex items-center justify-center shrink-0">
            <Smartphone className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2
              className="text-base font-bold tracking-tight text-foreground truncate"
              title="Live float confirmed from provider transaction feeds and physically verified cash awaiting banking."
            >
              Actual Money
            </h2>
            <p className="text-xs text-muted-foreground">Phone lines + cash</p>
          </div>
        </div>
      </div>

      <p className={`mt-4 font-mono text-3xl sm:text-4xl font-black tabular-nums tracking-tight text-foreground break-all ${loading ? 'animate-pulse text-muted-foreground' : ''}`}>
        {loading ? '—' : formatUGX(total)}
      </p>

      <div className="mt-5 border-t border-border/80">
        {rows.map((r) => (
          <button
            key={r.label}
            type="button"
            onClick={() => setOpenLine(r.line)}
            aria-label={`View ${r.label} detailed statement`}
            className="w-full flex items-center justify-between gap-3 min-w-0 min-h-[52px] py-2 text-left border-b border-border/60 hover:bg-muted/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm"
          >
            <div className="flex items-center gap-3 min-w-0">
              {r.logo ? (
                <span className="h-8 w-8 rounded-full overflow-hidden shrink-0 border border-border bg-background flex items-center justify-center">
                  <img src={r.logo} alt="" className="w-full h-full object-contain" loading="lazy" />
                </span>
              ) : (
                <span className="h-8 w-8 rounded-full shrink-0 border border-border bg-emerald-500/10 flex items-center justify-center">
                  <Banknote className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                </span>
              )}
              <span className="text-sm font-medium text-foreground truncate">{r.label}</span>
            </div>
            <span className="flex items-center gap-2 shrink-0">
              <span className="font-mono text-sm tabular-nums text-foreground">
                {loading ? '—' : formatUGX(r.amount)}
              </span>
              <ChevronRight className="h-4 w-4 text-muted-foreground/70" aria-hidden="true" />
            </span>
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-[0.5rem]" />

      <button
        type="button"
        onClick={() => setOpenLine('mtn_momo')}
        className="mt-3 inline-flex items-center justify-center gap-1.5 self-center rounded-lg px-3 py-2 text-xs font-semibold text-primary hover:bg-primary/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        View line statements <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
      </button>

      <PhoneMoneyStatementSheet line={openLine} onOpenChange={(open) => !open && setOpenLine(null)} />
    </div>
  );
}
