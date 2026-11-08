import type { ComponentType } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Banknote, ChevronRight, HandCoins, KeyRound, Mail, Wallet } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useMerchantFloatPositions } from '@/hooks/useMerchantFloat';
import { formatUGX } from '@/lib/rentCalculations';

/**
 * The five daily-tool tiles on the Financial Ops overview. Each has a live status chip and one line of context.
 * Read-only: every figure comes from a query the console already runs (the merchant positions and the cash-code list
 * share their cache with the tools themselves), and a failed query shows no chip instead of a made-up one.
 */
type Tone = 'good' | 'warn' | 'info' | 'none';
const CHIP: Record<Exclude<Tone, 'none'>, string> = {
  good: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  warn: 'bg-amber-500/20 text-amber-800 dark:text-amber-300',
  info: 'bg-primary/10 text-primary',
};

function Tile({
  icon: Icon, title, chip, tone = 'none', sub, onClick,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  chip?: string | null;
  tone?: Tone;
  sub: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-h-[112px] items-start gap-3 rounded-2xl border border-border bg-card p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-bold text-foreground">{title}</span>
        {chip ? (
          <span className={`mt-1.5 inline-block max-w-full truncate rounded-md px-2 py-0.5 text-sm font-extrabold tabular-nums ${CHIP[tone === 'none' ? 'info' : tone]}`}>
            {chip}
          </span>
        ) : (
          <span className="mt-1.5 block h-6" aria-hidden />
        )}
        <span className="mt-1 block truncate text-xs text-muted-foreground">{sub}</span>
      </span>
      <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground/60 transition group-hover:translate-x-0.5 group-hover:text-primary" aria-hidden />
    </button>
  );
}

type CashCode = { status?: string; expires_at?: string | null };

function useLiveCashCodeCount() {
  return useQuery({
    queryKey: ['finops-overview-cash-codes-awaiting'],
    retry: false,
    staleTime: 30_000,
    refetchInterval: 60_000,
    queryFn: async () => {
      const call = supabase.rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: CashCode[] | null; error: unknown }>;
      const { data, error } = await call('fin_ops_recent_cash_codes', { p_limit: 50 });
      if (error) throw error;
      const now = Date.now();
      return (data ?? []).filter((r) => r.status === 'awaiting_code' && (!r.expires_at || new Date(r.expires_at).getTime() > now)).length;
    },
  });
}

export default function FinOpsOverviewTiles({
  activeWallets, payoutsPending, onOpenTool,
}: {
  activeWallets?: number;
  payoutsPending?: number;
  onOpenTool: (id: string) => void;
}) {
  const codes = useLiveCashCodeCount();
  const positions = useMerchantFloatPositions();
  const floatAvailable = positions.data
    ? positions.data.filter((p) => p.isActive).reduce((s, p) => s + (p.ledgerFloatHeld || 0), 0)
    : null;

  return (
    <section aria-label="Daily tools" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      <Tile
        icon={KeyRound}
        title="Cash Deposit Codes"
        chip={codes.data == null ? null : codes.data === 0 ? 'Active' : `${codes.data} awaiting`}
        tone={codes.data == null ? 'none' : codes.data === 0 ? 'good' : 'warn'}
        sub={codes.data == null ? 'Codes for cash handed in' : `${codes.data} pending code${codes.data === 1 ? '' : 's'}`}
        onClick={() => onOpenTool('cash_codes')}
      />
      <Tile
        icon={Mail}
        title="Email Transactions"
        sub="MTN, Airtel and bank, read from Gmail"
        onClick={() => onOpenTool('email_tx')}
      />
      <Tile
        icon={Wallet}
        title="Wallet Buckets"
        chip={activeWallets == null ? null : activeWallets.toLocaleString()}
        tone="info"
        sub="Wallets holding a balance"
        onClick={() => onOpenTool('wallet_buckets')}
      />
      <Tile
        icon={Banknote}
        title="Payout Queue"
        chip={payoutsPending == null ? null : payoutsPending.toLocaleString()}
        tone={payoutsPending ? 'warn' : 'good'}
        sub="Awaiting approval"
        onClick={() => onOpenTool('payout_queue')}
      />
      <Tile
        icon={HandCoins}
        title="Merchant Float"
        chip={floatAvailable == null ? null : formatUGX(floatAvailable)}
        tone="good"
        sub="Available to the payout engine"
        onClick={() => onOpenTool('merchant_float')}
      />
    </section>
  );
}
