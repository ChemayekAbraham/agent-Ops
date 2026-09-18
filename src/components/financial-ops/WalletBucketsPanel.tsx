import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Wallet, ArrowRightLeft, Home, Store, ChevronRight, Loader2, Smartphone, Banknote, Landmark } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { WalletBucketHoldersPanel, type HolderBucket } from './WalletBucketHoldersPanel';
import mtnLogoAsset from '@/assets/mtn-logo.png.asset.json';
import airtelLogoAsset from '@/assets/airtel-logo.png.asset.json';
import { PhoneMoneyStatementSheet, type PhoneMoneyLine } from './PhoneMoneyStatementSheet';
import { MerchantFloatEmailMovementsDialog } from './MerchantFloatEmailMovementsDialog';
import { BankEmailReconciliationPanel } from './BankEmailReconciliationPanel';



export type WalletBucketTool =
  | 'wallet_breakdown'
  | 'float_to_withdrawable'
  | 'funded_tenants'
  | 'merchant_float';

type BucketTotalKey =
  | 'withdrawable_total'
  | 'float_total'
  | 'landlord_float_total'
  | 'landlord_float_due_today_total'
  | 'merchant_float_total';

interface BucketTotals extends Record<BucketTotalKey, number> {
  computed_at: string;
}

interface WalletBucketsPanelProps {
  onOpenTool: (tool: WalletBucketTool) => void;
}

const BUCKETS = [
  {
    number: 1,
    id: 'wallet_breakdown' as WalletBucketTool,
    title: 'Withdrawable Wallet',
    desc: 'All user withdrawable balances across the platform.',
    icon: Wallet,
    totalKey: 'withdrawable_total' as BucketTotalKey,
    holder: 'withdrawable' as HolderBucket,
    tone: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
  },
  {
    number: 2,
    id: 'float_to_withdrawable' as WalletBucketTool,
    title: 'Operational Float',
    desc: 'Company float held in wallets and reclassification tools.',
    icon: ArrowRightLeft,
    totalKey: 'float_total' as BucketTotalKey,
    holder: 'float' as HolderBucket,
    tone: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
  },
  {
    number: 3,
    id: 'funded_tenants' as WalletBucketTool,
    title: 'Landlord Float',
    desc: 'Rent funded today, still owed to landlords.',
    icon: Home,
    totalKey: 'landlord_float_due_today_total' as BucketTotalKey,
    holder: 'landlord_float' as HolderBucket,
    tone: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20',
  },
  {
    number: 4,
    id: 'merchant_float' as WalletBucketTool,
    title: 'Merchant Float',
    desc: 'Cash-out merchant agent operational float requests.',
    icon: Store,
    totalKey: 'merchant_float_total' as BucketTotalKey,
    holder: 'merchant_float' as HolderBucket,
    tone: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
  },
];

export function WalletBucketsPanel({ onOpenTool }: WalletBucketsPanelProps) {
  const [selected, setSelected] = useState<{ holder: HolderBucket; tool: WalletBucketTool } | null>(null);
  const [openLine, setOpenLine] = useState<PhoneMoneyLine | null>(null);
  const [openMerchantEmails, setOpenMerchantEmails] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['wallet-bucket-totals'],
    queryFn: async (): Promise<BucketTotals> => {
      const { data, error } = await supabase.rpc('get_wallet_bucket_totals' as any);
      if (error) throw error;
      const d = (data ?? {}) as any;
      return {
        withdrawable_total: Number(d.withdrawable_total ?? 0),
        float_total: Number(d.float_total ?? 0),
        landlord_float_total: Number(d.landlord_float_total ?? 0),
        landlord_float_due_today_total: Number(d.landlord_float_due_today_total ?? 0),
        merchant_float_total: Number(d.merchant_float_total ?? 0),
        computed_at: d.computed_at ?? new Date().toISOString(),
      };
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: false,
  });

  // 5th bucket: real money on the merchant MTN/Airtel lines (parsed from email
  // transactions) plus verified cash at hand not yet banked.
  const { data: actual, isLoading: actualLoading, error: actualError } = useQuery({
    queryKey: ['wallet-bucket-actual-float'],
    queryFn: async () => {
      const [phoneRes, cashRes, bankRes] = await Promise.all([
        supabase.rpc('get_phone_platform_reconciliation' as any),
        supabase.rpc('get_cash_at_hand_total' as any),
        supabase.rpc('get_money_at_bank_reconciliation' as any),
      ]);
      if (phoneRes.error) throw phoneRes.error;
      if (bankRes.error) throw bankRes.error;
      const p = (phoneRes.data ?? {}) as any;
      const c = (cashRes.data ?? {}) as any;
      const b = (bankRes.data ?? {}) as any;
      const mtn = Number(p.mtn_balance ?? 0);
      const airtel = Number(p.airtel_balance ?? 0);
      const cash = Number(c.cash_at_hand_total ?? 0);
      const bank = Number(b.money_at_bank_total ?? 0);
      return { mtn, airtel, cash, bank, total: Number(p.total_float ?? mtn + airtel) + cash + bank };
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: false,
  });

  const totalFor = (key: BucketTotalKey) => Number(data?.[key] ?? 0);

  const actualRows = [
    { label: 'MTN Money', amount: actual?.mtn ?? 0, logo: mtnLogoAsset.url as string | null, line: 'mtn_momo' as PhoneMoneyLine },
    { label: 'Airtel Money', amount: actual?.airtel ?? 0, logo: airtelLogoAsset.url as string | null, line: 'airtel_money' as PhoneMoneyLine },
    { label: 'Cash at Hand', amount: actual?.cash ?? 0, logo: null, line: 'cash' as PhoneMoneyLine },
    { label: 'Money at Bank — Bayo Mercy account', amount: actual?.bank ?? 0, logo: null, line: 'bank' as PhoneMoneyLine },
  ];


  if (selected) {
    return (
      <WalletBucketHoldersPanel
        bucket={selected.holder}
        onBack={() => setSelected(null)}
        onOpenFullTool={() => onOpenTool(selected.tool)}
      />
    );
  }

  return (
    <>
      <div className="space-y-5">
      <div>
        <h2 className="text-xl sm:text-2xl font-bold tracking-tight flex items-center gap-2.5">
          <Wallet className="h-6 w-6 text-primary" />
          Wallet Buckets
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Choose a bucket to review, manage, or drill into the ledger.
        </p>
      </div>

      <div className="grid gap-3">
        {BUCKETS.map((b) => {
          const Icon = b.icon;
          const total = totalFor(b.totalKey);
          return (
            <button
              key={b.id}
              onClick={() => setSelected({ holder: b.holder, tool: b.id })}
              className="group text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-2xl"
              aria-label={`Open ${b.title}`}
            >
              <Card className="overflow-hidden border border-border bg-card transition-all hover:border-primary/30 hover:shadow-sm">
                <CardContent className="p-4 sm:p-5">
                  <div className="flex items-center gap-4">
                    <div className={`h-12 w-12 rounded-xl flex items-center justify-center shrink-0 border ${b.tone}`}>
                      <Icon className="h-5 w-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold tabular-nums text-muted-foreground/80 w-5">
                          {b.number}.
                        </span>
                        <p className="text-sm sm:text-base font-semibold text-foreground">
                          {b.title}
                        </p>
                      </div>
                      <p className={cn(
                        "text-xs font-bold font-mono mt-0.5 ml-7",
                        error ? "text-destructive" : "text-primary"
                      )}>
                        {isLoading ? (
                          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            UGX —
                          </span>
                        ) : error ? (
                          'Unavailable'
                        ) : (
                          formatUGX(total)
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5 ml-7">
                        {b.desc}
                      </p>
                    </div>
                    <div className="shrink-0">
                      <ChevronRight className="h-5 w-5 text-muted-foreground group-hover:text-primary transition-colors" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </button>
          );
        })}

        {/* 5. Actual Float — email transaction balances + cash at hand */}
        <Card className="overflow-hidden border border-border bg-card">
          <CardContent className="p-4 sm:p-5">
            <div className="flex items-center gap-4">
              <div className="h-12 w-12 rounded-xl flex items-center justify-center shrink-0 border bg-teal-500/10 text-teal-600 dark:text-teal-400 border-teal-500/20">
                <Smartphone className="h-5 w-5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold tabular-nums text-muted-foreground/80 w-5">5.</span>
                  <p className="text-sm sm:text-base font-semibold text-foreground">Actual Float (Money We Hold)</p>
                </div>
                <p className={cn('text-xs font-bold font-mono mt-0.5 ml-7', actualError ? 'text-destructive' : 'text-primary')}>
                  {actualLoading ? (
                    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      UGX —
                    </span>
                  ) : actualError ? (
                    'Unavailable'
                  ) : (
                    formatUGX(actual?.total ?? 0)
                  )}
                </p>
                 <p className="text-xs text-muted-foreground mt-0.5 ml-7">
                   MTN + Airtel line balances, verified cash at hand, and the balance managed in Bayo Mercy’s bank account.
                 </p>
              </div>
            </div>

            <div className="mt-4 pt-4 border-t border-border space-y-2">
              {actualRows.map((r) => (
                <div key={r.label}>
                  <button
                    type="button"
                    onClick={() => setOpenLine(r.line)}
                    aria-label={`View ${r.label} statement`}
                    className="w-full flex items-center justify-between gap-3 rounded-lg px-1 py-1.5 text-left hover:bg-muted/50 transition-colors"
                  >
                    <span className="flex items-center gap-2.5 min-w-0">
                      {r.logo ? (
                      <span className="h-6 w-6 rounded-md overflow-hidden shrink-0 border border-border bg-background">
                        <img src={r.logo} alt={r.label} className="w-full h-full object-cover" loading="lazy" />
                      </span>
                    ) : r.line === 'bank' ? (
                      <span className="h-6 w-6 rounded-md shrink-0 border border-border bg-sky-500/10 flex items-center justify-center">
                        <Landmark className="h-3.5 w-3.5 text-sky-600 dark:text-sky-400" />
                      </span>
                    ) : (
                      <span className="h-6 w-6 rounded-md shrink-0 border border-border bg-emerald-500/10 flex items-center justify-center">
                        <Banknote className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                      </span>
                      )}
                      <span className="text-sm text-foreground truncate">{r.label}</span>
                    </span>
                    <span className="flex items-center gap-1.5 shrink-0">
                      <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
                        {actualLoading ? '—' : formatUGX(r.amount)}
                      </span>
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                    </span>
                  </button>
                  {r.line === 'bank' && <BankEmailReconciliationPanel />}
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={() => setOpenMerchantEmails(true)}
              className="mt-3 w-full flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-left hover:bg-muted/60 transition-colors"
            >
              <span className="flex items-center gap-2.5 min-w-0">
                <span className="h-6 w-6 rounded-md shrink-0 border border-amber-500/20 bg-amber-500/10 flex items-center justify-center">
                  <Store className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm text-foreground">Money sent to merchant agents</span>
                  <span className="block text-[11px] text-muted-foreground">
                    Email extraction of every manual MTN/Airtel send, per merchant
                  </span>
                </span>
              </span>
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </button>
          </CardContent>
        </Card>
      </div>
      </div>

      <PhoneMoneyStatementSheet line={openLine} onOpenChange={(open) => !open && setOpenLine(null)} />
      <MerchantFloatEmailMovementsDialog open={openMerchantEmails} onOpenChange={setOpenMerchantEmails} />
    </>
  );
}
