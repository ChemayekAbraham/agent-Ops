import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Wallet, ArrowRightLeft, Home, Store, ChevronRight, Loader2, Smartphone, Banknote } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { WalletBucketHoldersPanel, type HolderBucket } from './WalletBucketHoldersPanel';
import mtnLogoAsset from '@/assets/mtn-logo.png.asset.json';
import airtelLogoAsset from '@/assets/airtel-logo.png.asset.json';
import { PhoneMoneyStatementSheet, type PhoneMoneyLine } from './PhoneMoneyStatementSheet';


export type WalletBucketTool =
  | 'wallet_breakdown'
  | 'float_to_withdrawable'
  | 'funded_tenants'
  | 'merchant_float';

type BucketTotalKey =
  | 'withdrawable_total'
  | 'float_total'
  | 'landlord_float_total'
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
    desc: 'Money reserved for landlord payouts and funded tenants.',
    icon: Home,
    totalKey: 'landlord_float_total' as BucketTotalKey,
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
        merchant_float_total: Number(d.merchant_float_total ?? 0),
        computed_at: d.computed_at ?? new Date().toISOString(),
      };
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: false,
  });

  const totalFor = (key: BucketTotalKey) => Number(data?.[key] ?? 0);

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
      </div>
    </div>
  );
}
