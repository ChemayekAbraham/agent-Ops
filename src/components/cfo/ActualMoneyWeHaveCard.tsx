import { useState } from 'react';
import { PiggyBank, ChevronRight, Loader2, Banknote, Landmark, Smartphone, Vault } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useActualMoneyHeld } from '@/hooks/useActualMoneyHeld';
import { PhoneMoneyStatementSheet, type PhoneMoneyLine } from '@/components/financial-ops/PhoneMoneyStatementSheet';
import { formatUGX } from '@/lib/rentCalculations';
import mtnLogoAsset from '@/assets/mtn-logo.png.asset.json';
import airtelLogoAsset from '@/assets/airtel-logo.png.asset.json';

interface Props {
  /** Ledger position figure, shown as a reference only — never added to the total. */
  ledgerPosition?: number;
  ledgerPositionUnavailable?: boolean;
}

/**
 * "Money We Have" — the actual money the company physically holds, taken from
 * the exact same source as the Financial Ops Wallet Buckets page (bucket 5),
 * so the two screens can never disagree. Every line drills through to the
 * movements that produced it.
 */
export function ActualMoneyWeHaveCard({ ledgerPosition, ledgerPositionUnavailable }: Props) {
  const [open, setOpen] = useState(false);
  const [line, setLine] = useState<PhoneMoneyLine | null>(null);
  const { data, isLoading, error } = useActualMoneyHeld();

  const rows: { label: string; amount: number; line: PhoneMoneyLine; logo?: string; icon?: React.ReactNode; hint: string }[] = [
    {
      label: 'MTN Money line',
      amount: data?.mtn ?? 0,
      line: 'mtn_momo',
      logo: mtnLogoAsset.url as string,
      hint: 'Balance on the MTN line, from provider transaction alerts',
    },
    {
      label: 'Airtel Money line',
      amount: data?.airtel ?? 0,
      line: 'airtel_money',
      logo: airtelLogoAsset.url as string,
      hint: 'Balance on the Airtel line, from provider transaction alerts',
    },
    {
      label: 'Cash at hand',
      amount: data?.cash ?? 0,
      line: 'cash',
      icon: <Banknote className="h-4 w-4 text-amber-600" />,
      hint: 'Verified cash collected by agents and not yet banked',
    },
    {
      label: 'Cash at bank',
      amount: data?.bankedCash ?? 0,
      line: 'banked_cash',
      icon: <Landmark className="h-4 w-4 text-sky-600" />,
      hint: `Real cash at bank — ${data?.bankedCashCount ?? 0} verified deposit(s) marked as banked by Financial Ops`,
    },
  ];

  const total = data?.total ?? 0;
  const headline = isLoading ? '—' : error ? 'Unavailable' : formatUGX(total);

  return (
    <>
      <div className="w-full rounded-2xl border border-border/70 bg-card shadow-sm transition-shadow hover:shadow-md">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-full text-left p-5 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="h-10 w-10 rounded-xl flex items-center justify-center shrink-0 bg-emerald-600">
              <PiggyBank className="h-5 w-5 text-emerald-50" />
            </div>
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted/60 shrink-0" aria-hidden>
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            </span>
          </div>

          <p className="mt-4 text-[11px] font-medium text-muted-foreground truncate">Money We Have</p>
          <p className="mt-1.5 text-[22px] leading-none sm:text-[26px] sm:leading-none font-bold tabular-nums tracking-tight text-foreground">
            {isLoading ? (
              <span className="inline-flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> UGX —
              </span>
            ) : (
              headline
            )}
          </p>
          <p className="mt-2.5 text-[11px] text-muted-foreground line-clamp-2">
            Actual money held — same figures as Financial Ops Wallet Buckets
          </p>
        </button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2.5 text-base">
              <span className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0 bg-emerald-600">
                <PiggyBank className="h-4 w-4 text-emerald-50" />
              </span>
              Money We Have
            </DialogTitle>
            <DialogDescription className="text-xs">
              Actual money we hold right now. Tap any line to see every movement behind it.
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-xl border border-border bg-muted/30 px-4 py-3">
            <p className="text-[11px] font-medium text-muted-foreground">Total money held</p>
            <p className="mt-1 text-xl sm:text-2xl font-bold tabular-nums tracking-tight text-foreground">{headline}</p>
          </div>

          <div className="space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Where it sits</p>
            {rows.map((r) => (
              <button
                key={r.line}
                type="button"
                onClick={() => setLine(r.line)}
                className="w-full flex items-center gap-3 py-2.5 border-b border-border/60 text-left hover:bg-muted/40 rounded-md px-1 transition-colors"
              >
                <span className="h-7 w-7 rounded-md bg-muted/60 flex items-center justify-center shrink-0 overflow-hidden">
                  {r.logo ? (
                    <img src={r.logo} alt="" className="h-5 w-5 object-contain" />
                  ) : (
                    r.icon ?? <Smartphone className="h-4 w-4" />
                  )}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-xs font-medium text-foreground truncate">{r.label}</span>
                  <span className="block text-[10px] text-muted-foreground truncate">{r.hint}</span>
                </span>
                <span className="text-xs font-semibold tabular-nums shrink-0">{formatUGX(r.amount)}</span>
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              </button>
            ))}
          </div>

          <div className="space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Reference — ledger bank reconciliation
            </p>
            <button
              type="button"
              onClick={() => setLine('bank')}
              className="w-full flex items-center gap-3 rounded-lg bg-muted/50 px-3 py-2.5 text-left hover:bg-muted/70 transition-colors"
            >
              <Landmark className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="flex-1 min-w-0">
                <span className="block text-xs font-semibold text-foreground">
                  {formatUGX(data?.bankLedger ?? 0)}
                </span>
                <span className="block text-[10px] text-muted-foreground">
                  Bank credits less debits since the reconciliation reset — shown for comparison only, not added to the total
                </span>
              </span>
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            </button>
          </div>

          {ledgerPosition !== undefined && (
            <div className="flex items-start gap-2 rounded-lg bg-muted/50 px-3 py-2.5 text-[11px] text-muted-foreground">
              <Vault className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>
                Ledger position for the same date is{' '}
                <span className="font-semibold text-foreground tabular-nums">
                  {ledgerPositionUnavailable ? '—' : formatUGX(ledgerPosition)}
                </span>{' '}
                (balance sheet A1 + A2 + A5). Shown for comparison only — the headline above is the actual money held.
              </span>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <PhoneMoneyStatementSheet line={line} onOpenChange={(o) => { if (!o) setLine(null); }} />
    </>
  );
}
