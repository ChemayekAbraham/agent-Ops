import { useMyAngelShares } from '@/hooks/useMyAngelShares';
import { useCurrency } from '@/hooks/useCurrency';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Shield, TrendingUp, Gem, Clock, CheckCircle2, AlertCircle } from 'lucide-react';
import { format } from 'date-fns';
import { TOTAL_SHARES, PRICE_PER_SHARE } from '@/components/angel-pool/constants';

export function AngelSharesTab() {
  const { totalShares, totalInvested, poolOwnershipPct, companyOwnershipPct, records, valuations, hasShares, isLoading } = useMyAngelShares();
  const { formatAmount, formatAmountCompact } = useCurrency();

  if (isLoading) {
    return (
      <div className="space-y-3 p-1">
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-32 w-full rounded-xl" />
      </div>
    );
  }

  if (!hasShares) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <Gem className="h-10 w-10 text-muted-foreground/30 mb-3" />
        <p className="text-sm font-medium text-muted-foreground">No angel shares yet</p>
        <p className="text-xs text-muted-foreground/60 mt-1">Invest in the Angel Pool to own equity</p>
      </div>
    );
  }

  const confirmedCount = records.filter(r => r.status === 'confirmed').length;
  const pendingCount = records.filter(r => r.status !== 'confirmed').length;

  return (
    <div className="space-y-4">
      {/* Hero Card */}
      <div className="rounded-2xl bg-gradient-to-br from-[hsl(var(--primary))] via-[hsl(var(--primary)/0.85)] to-[hsl(var(--primary)/0.7)] p-5 text-primary-foreground relative overflow-hidden">
        <div className="absolute top-0 right-0 w-32 h-32 bg-white/5 rounded-full -translate-y-1/2 translate-x-1/2" />
        <div className="absolute bottom-0 left-0 w-20 h-20 bg-white/5 rounded-full translate-y-1/2 -translate-x-1/2" />

        <div className="relative z-10">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Shield className="h-4 w-4" />
              <span className="text-xs font-bold uppercase tracking-wider opacity-90">Angel Shareholding</span>
            </div>
            <Badge className="bg-white/20 text-white border-white/30 text-[7px] sm:text-[9px] font-bold backdrop-blur-sm px-1.5 sm:px-2.5 py-0.5">
              ✓ Verified Shareholder
            </Badge>
          </div>

          <div className="mb-4">
            <p className="text-[10px] uppercase tracking-wider opacity-70 font-medium">Total Shares</p>
            <p className="text-4xl font-black tracking-tight font-mono tabular-nums">
              {totalShares.toLocaleString()}
            </p>
            <p className="text-xs opacity-70 mt-0.5">
              of {TOTAL_SHARES.toLocaleString()} · UGX {PRICE_PER_SHARE.toLocaleString()}/share
            </p>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="bg-white/10 backdrop-blur-sm rounded-xl p-3 text-center">
              <p className="text-[8px] uppercase tracking-wider opacity-70 font-medium">Capital</p>
              <p className="text-sm font-extrabold mt-0.5 truncate font-mono tabular-nums"><p className="text-[10px] sm:text-sm font-extrabold mt-0.5 font-mono tabular-nums">{formatAmountCompact(totalInvested)}</p></p>
            </div>
            <div className="bg-white/10 backdrop-blur-sm rounded-xl p-3 text-center">
              <p className="text-[8px] uppercase tracking-wider opacity-70 font-medium">Pool %</p>
              <p className="text-sm font-extrabold mt-0.5 font-mono tabular-nums">{poolOwnershipPct.toFixed(2)}%</p>
            </div>
            <div className="bg-white/10 backdrop-blur-sm rounded-xl p-3 text-center">
              <p className="text-[8px] uppercase tracking-wider opacity-70 font-medium">Company %</p>
              <p className="text-sm font-extrabold mt-0.5 font-mono tabular-nums">{companyOwnershipPct.toFixed(4)}%</p>
            </div>
          </div>
        </div>
      </div>

      {/* Valuation Projections */}
      <div>
        <div className="flex items-center gap-2 mb-2.5">
          <TrendingUp className="h-3.5 w-3.5 text-success" />
          <p className="text-xs font-bold text-foreground uppercase tracking-wider">Future Value Projections</p>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {valuations.map((v) => (
            <div key={v.label} className="rounded-xl border border-border/40 bg-card p-3 text-center">
              <p className="text-[9px] text-muted-foreground font-semibold uppercase tracking-wider">At {v.label}</p>
              <p className="text-xs font-black text-success mt-1.5 font-mono tabular-nums truncate">
                ${Math.round(v.myValue).toLocaleString()}
              </p>
              <p className="text-[8px] text-muted-foreground mt-0.5 truncate font-mono">
                ≈ {formatAmount(v.myValueUGX)}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Investment History */}
      <div>
        <div className="flex items-center justify-between mb-2.5">
          <div className="flex items-center gap-2">
            <Clock className="h-3.5 w-3.5 text-primary" />
            <p className="text-xs font-bold text-foreground uppercase tracking-wider">Share History</p>
          </div>
          <div className="flex items-center gap-1.5">
            {confirmedCount > 0 && (
              <span className="text-[9px] font-medium text-success bg-success/10 px-1.5 py-0.5 rounded-full">{confirmedCount} confirmed</span>
            )}
            {pendingCount > 0 && (
              <span className="text-[9px] font-medium text-warning bg-warning/10 px-1.5 py-0.5 rounded-full">{pendingCount} pending</span>
            )}
          </div>
        </div>

        <div className="space-y-2">
          {records.map((r, idx) => {
            const isConfirmed = r.status === 'confirmed';
            return (
              <div
                key={r.id}
                className="rounded-xl border border-border/40 bg-card p-3 animate-fade-in"
                style={{ animationDelay: `${idx * 40}ms` }}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    {isConfirmed ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0" />
                    ) : (
                      <AlertCircle className="h-3.5 w-3.5 text-warning shrink-0" />
                    )}
                    <span className="text-[10px] text-muted-foreground font-mono">{format(new Date(r.created_at), 'dd MMM yyyy, HH:mm')}</span>
                  </div>
                  <Badge variant={isConfirmed ? 'success' : 'warning'} size="sm">
                    {r.status}
                  </Badge>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <p className="text-[7px] text-muted-foreground uppercase font-medium">Amount</p>
                    <p className="text-xs font-bold text-foreground font-mono tabular-nums truncate">{formatAmount(Number(r.amount))}</p>
                  </div>
                  <div>
                    <p className="text-[7px] text-muted-foreground uppercase font-medium">Shares</p>
                    <p className="text-xs font-bold text-foreground font-mono tabular-nums">{r.shares.toLocaleString()}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-[7px] text-muted-foreground uppercase font-medium">Ref</p>
                    <p className="text-[10px] font-semibold text-muted-foreground font-mono truncate">{r.reference_id || '—'}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
