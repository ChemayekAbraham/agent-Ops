import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Smartphone, Info, Banknote, ChevronRight } from 'lucide-react';
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
  const queryClient = useQueryClient();
  const [openLine, setOpenLine] = useState<PhoneMoneyLine | null>(null);

  // Live: a new provider SMS (money in / out on the MTN or Airtel line) or a
  // cash-deposit verification instantly refreshes the figures instead of the
  // operator waiting for the next poll.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const invalidate = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['finops-phone-money-lines'] });
        queryClient.invalidateQueries({ queryKey: ['finops-cash-at-hand-total'] });
      }, 250);
    };
    const channel = supabase
      .channel('finops-phone-money-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'gmail_transactions' }, invalidate)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cash_deposit_verifications' }, invalidate)
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

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
    refetchInterval: autoRefresh ? 20_000 : false,
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
    refetchInterval: autoRefresh ? 20_000 : false,
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
    <div className="rounded-2xl border border-emerald-500/25 bg-gradient-to-br from-emerald-500/8 via-card to-card p-5 sm:p-6 min-w-0 flex flex-col h-full shadow-2xs relative">
      <div className="flex items-start justify-between gap-3 mb-4 min-w-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-10 w-10 rounded-xl bg-emerald-500/15 border border-emerald-500/25 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
            <Smartphone className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground truncate">
                Actual Money
              </p>
              <span className="hidden sm:inline-flex px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20">
                Phone Lines + Cash
              </span>
            </div>
            <p className="text-[10px] text-muted-foreground/80 mt-0.5">
              Real float available on mobile money lines
            </p>
          </div>
        </div>

        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" /> Verified Float
        </span>
      </div>

      <div className="my-1">
        <p className={`font-mono text-3xl sm:text-4xl font-black tabular-nums tracking-tight text-foreground break-all ${loading ? 'animate-pulse text-muted-foreground' : ''}`}>
          {loading ? '—' : formatUGX(total)}
        </p>
      </div>

      <div className="mt-4 pt-3.5 border-t border-border/80 space-y-2">
        {rows.map((r) => (
          <button
            key={r.label}
            type="button"
            onClick={() => setOpenLine(r.line)}
            aria-label={`View ${r.label} detailed statement`}
            className="w-full flex items-center justify-between gap-3 min-w-0 rounded-xl p-2.5 text-left bg-background/70 hover:bg-muted/70 active:bg-muted border border-border/70 transition-all hover:border-emerald-500/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              {r.logo ? (
                <span className="h-7 w-7 rounded-lg overflow-hidden shrink-0 border border-border bg-background p-0.5 flex items-center justify-center">
                  <img src={r.logo} alt={r.label} className="w-full h-full object-contain" loading="lazy" />
                </span>
              ) : (
                <span className="h-7 w-7 rounded-lg shrink-0 border border-border bg-emerald-500/10 flex items-center justify-center">
                  <Banknote className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                </span>
              )}
              <div className="min-w-0">
                <span className="text-sm font-semibold text-foreground truncate block">{r.label}</span>
                <span className="text-[10px] text-muted-foreground block">Tap for line statement</span>
              </div>
            </div>
            <span className="flex items-center gap-2 shrink-0">
              <span className="font-mono text-sm font-bold tabular-nums text-foreground">
                {loading ? '—' : formatUGX(r.amount)}
              </span>
              <ChevronRight className="h-4 w-4 text-muted-foreground/70" />
            </span>
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-[1rem]" />

      <div className="mt-4 rounded-xl bg-emerald-500/5 border border-emerald-500/15 p-3 flex gap-2.5">
        <Info className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Live float confirmed from provider transaction feeds and physically verified cash awaiting banking.
        </p>
      </div>

      <PhoneMoneyStatementSheet line={openLine} onOpenChange={(open) => !open && setOpenLine(null)} />
    </div>
  );
}
