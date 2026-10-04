import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Wallet, Users, Clock, AlertCircle, ArrowRight, HandCoins, Home, Coins, ChevronRight } from 'lucide-react';
import { useCurrency } from '@/hooks/useCurrency';
import { hapticTap } from '@/lib/haptics';
import { WalletBucketDetailSheet, type BucketType } from './WalletBucketDetailSheet';

interface AgentMoneyMapCardProps {
  withdrawable: number;
  float: number;
  advance?: number;
  pendingHolds?: number;
}

/**
 * Big-font, plain-language breakdown of where an agent's money sits and how
 * it moves. Shown right under the purple total-balance card so an ordinary
 * person can understand at a glance: what's mine, what belongs to tenants,
 * what is on hold, what I owe.
 */
export function AgentMoneyMapCard({ withdrawable, float, advance = 0, pendingHolds = 0 }: AgentMoneyMapCardProps) {
  const { formatAmount } = useCurrency();
  const total = withdrawable + float;
  const [openBucket, setOpenBucket] = useState<BucketType | null>(null);

  const open = (b: BucketType) => { hapticTap(); setOpenBucket(b); };

  return (
    <>
    <Card className="border-border/50 shadow-sm overflow-hidden">
      <CardContent className="p-0">
        {/* Header */}
        <div className="px-5 pt-5 pb-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
            Where your money sits
          </p>
          <h3 className="text-lg font-black text-foreground mt-1">My Money Map</h3>
        </div>

        {/* Two big buckets */}
        <div className="px-5 space-y-3">
          {/* Yours to keep — withdrawable */}
          <button
            type="button"
            onClick={() => open('withdrawable')}
            className="w-full text-left rounded-2xl border-2 border-emerald-500/30 bg-emerald-500/5 p-4 active:scale-[0.99] active:bg-emerald-500/10 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
            aria-label="View 'Yours to keep' details"
          >
            <div className="flex items-start gap-3">
              <div className="h-11 w-11 rounded-xl bg-emerald-500/15 flex items-center justify-center shrink-0">
                <HandCoins className="h-6 w-6 text-emerald-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                  Yours to keep
                </p>
                <p className="text-[26px] sm:text-[30px] font-black text-foreground tabular-nums leading-tight truncate">
                  {formatAmount(withdrawable)}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Your commission &amp; bonuses. You can withdraw this.
                </p>
                <p className="text-[11px] font-bold text-emerald-700 dark:text-emerald-400 mt-1.5 inline-flex items-center gap-0.5">
                  Tap to see details <ChevronRight className="h-3 w-3" />
                </p>
              </div>
              <ChevronRight className="h-5 w-5 text-emerald-600/70 shrink-0 mt-2" />
            </div>
          </button>

          {/* Tenant collections — float */}
          <button
            type="button"
            onClick={() => open('float')}
            className="w-full text-left rounded-2xl border-2 border-sky-500/30 bg-sky-500/5 p-4 active:scale-[0.99] active:bg-sky-500/10 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/40"
            aria-label="View 'Tenant collections' details"
          >
            <div className="flex items-start gap-3">
              <div className="h-11 w-11 rounded-xl bg-sky-500/15 flex items-center justify-center shrink-0">
                <Users className="h-6 w-6 text-sky-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-bold uppercase tracking-wider text-sky-700 dark:text-sky-400">
                  Tenant collections
                </p>
                <p className="text-[26px] sm:text-[30px] font-black text-foreground tabular-nums leading-tight truncate">
                  {formatAmount(float)}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Money tenants gave you. Must pay their rent — you cannot withdraw it.
                </p>
                <p className="text-[11px] font-bold text-sky-700 dark:text-sky-400 mt-1.5 inline-flex items-center gap-0.5">
                  Tap to see details <ChevronRight className="h-3 w-3" />
                </p>
              </div>
              <ChevronRight className="h-5 w-5 text-sky-600/70 shrink-0 mt-2" />
            </div>
          </button>

          {/* Pending hold (only if any) */}
          {pendingHolds > 0 && (
            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4 flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-amber-500/15 flex items-center justify-center shrink-0">
                <Clock className="h-5 w-5 text-amber-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-400">
                  On hold — withdrawal being processed
                </p>
                <p className="text-xl font-black text-foreground tabular-nums">
                  {formatAmount(pendingHolds)}
                </p>
              </div>
            </div>
          )}

          {/* Advance owed (only if any) */}
          {advance > 0 && (
            <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4 flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-destructive/15 flex items-center justify-center shrink-0">
                <AlertCircle className="h-5 w-5 text-destructive" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-bold uppercase tracking-wider text-destructive">
                  You owe Welile (advance)
                </p>
                <p className="text-xl font-black text-foreground tabular-nums">
                  {formatAmount(advance)}
                </p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Recovered automatically from your next deposits.
                </p>
              </div>
            </div>
          )}

          {/* Total line */}
          <div className="flex items-center justify-between rounded-xl bg-muted/60 px-4 py-3">
            <div className="flex items-center gap-2">
              <Wallet className="h-4 w-4 text-muted-foreground" />
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Total in wallet
              </p>
            </div>
            <p className="text-base font-black text-foreground tabular-nums">{formatAmount(total)}</p>
          </div>
        </div>

        {/* How money moves — simple visual */}
        <div className="mt-4 border-t border-border/50 bg-muted/30 px-5 py-4">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground mb-3">
            How your money moves
          </p>
          <div className="flex items-center justify-between gap-1">
            <Step icon={<Users className="h-4 w-4" />} label="Collect from tenant" tone="sky" />
            <ArrowRight className="h-4 w-4 text-muted-foreground/50 shrink-0" />
            <Step icon={<Home className="h-4 w-4" />} label="Pay rent" tone="primary" />
            <ArrowRight className="h-4 w-4 text-muted-foreground/50 shrink-0" />
            <Step icon={<Coins className="h-4 w-4" />} label="Earn 10% commission" tone="emerald" />
          </div>
          <p className="text-[11px] text-muted-foreground mt-3 leading-snug">
            Every shilling you allocate to a tenant's rent pays you <span className="font-bold text-foreground">10% commission</span> instantly and grows your Agent Advance limit by <span className="font-bold text-foreground">2×</span>.
          </p>
        </div>
      </CardContent>
    </Card>

    <WalletBucketDetailSheet
      open={openBucket !== null}
      onOpenChange={(o) => { if (!o) setOpenBucket(null); }}
      bucket={openBucket ?? 'withdrawable'}
      balance={openBucket === 'float' ? float : withdrawable}
    />
    </>
  );
}

function Step({ icon, label, tone }: { icon: React.ReactNode; label: string; tone: 'sky' | 'primary' | 'emerald' }) {
  const toneClass =
    tone === 'sky'
      ? 'bg-sky-500/15 text-sky-600'
      : tone === 'emerald'
      ? 'bg-emerald-500/15 text-emerald-600'
      : 'bg-primary/15 text-primary';
  return (
    <div className="flex flex-col items-center gap-1.5 flex-1 min-w-0">
      <div className={`h-9 w-9 rounded-xl flex items-center justify-center ${toneClass}`}>{icon}</div>
      <p className="text-[10px] font-semibold text-foreground text-center leading-tight">{label}</p>
    </div>
  );
}