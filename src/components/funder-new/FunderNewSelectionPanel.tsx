import { useEffect, useState } from 'react';
import { CheckCircle2, Home, Loader2, Info, ShieldCheck, Trash2, Wallet, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { formatDynamic } from '@/lib/currencyFormat';
import type { FunderNewCategory, FunderNewSelectionItem } from './types';
import { categoryLabel } from './utils';

const MONTHLY_RATE = 0.15;

const monthlyAt15 = (total: number) => Math.round(total * MONTHLY_RATE);

/**
 * What the caller reports back when "Confirm and support" is pressed.
 * Only `submitted: true` switches the confirmation into the success view —
 * a caller that does not actually post anything returns nothing, so the
 * screen never claims a support that was not recorded.
 */
export type FunderFundResult = { submitted: boolean; reference?: string | null };

/** Same three steps the "How support works" dialog promises, in order. */
const NEXT_STEPS = [
  { title: 'Operational review', text: 'The team verifies your booking and completes the normal approval step.' },
  { title: 'Support becomes active', text: 'Once approved, the homes you funded go live through the existing process.' },
  { title: 'Track it in your portfolio', text: 'Follow your supported homes and Returns from your portfolio.' },
];

/** Snapshot taken at submit time: the parent may clear the selection as soon
 *  as the support is posted, and the success view must still show real figures. */
type FunderReceipt = { count: number; total: number; balanceAfter: number; reference: string | null };

/** Sticky bar — rendered only while at least one compatible home is selected. */
export function FunderNewSelectionBar({
  items,
  category,
  onClear,
  onReview,
}: {
  items: FunderNewSelectionItem[];
  category: FunderNewCategory | null;
  onClear: () => void;
  onReview: () => void;
}) {
  if (items.length === 0 || !category) return null;
  const total = items.reduce((sum, item) => sum + item.amount, 0);

  return (
    // z-[60] keeps the bar above the app's other fixed bottom overlays, which
    // sit at z-40 and would otherwise swallow taps on Review.
    //
    // The bar is anchored above the floating bottom navigation instead of the
    // viewport edge: that pill (BottomRoleSwitcher / MobileBottomNav) is fixed
    // at 10px from the bottom, 68px tall, and paints at z-100, so a bar sitting
    // at bottom-0 had Clear / Review support plan hidden underneath it.
    // 10px inset + 68px pill + 8px breathing room = 86px, plus the device
    // bottom inset (which the pill is already lifted by). The pill shows at
    // every breakpoint, so this offset is deliberately not responsive-gated.
    <div className="fixed inset-x-0 bottom-0 z-[110] w-full max-w-full overflow-hidden border-t bg-card shadow-[0_-8px_30px_-12px_hsl(var(--primary)/0.35)] pb-[env(safe-area-inset-bottom,0px)]">
      <div className="mx-auto flex w-full min-w-0 max-w-7xl flex-col gap-2 px-4 py-2.5 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">

        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
          <p className="text-sm font-semibold">
            {items.length} {items.length === 1 ? 'home' : 'homes'} selected
          </p>
          <p className="text-sm">
            <span className="text-muted-foreground">Total </span>
            <span className="font-semibold">{formatDynamic(total)}</span>
          </p>
          <p className="text-sm">
            <span className="text-muted-foreground">Monthly at 15% </span>
            <span className="font-semibold text-success">{formatDynamic(monthlyAt15(total))}</span>
          </p>
        </div>
        <div className="flex min-w-0 gap-2">
          <Button variant="ghost" className="h-11 flex-none rounded-xl px-3 text-destructive" onClick={onClear}>
            <X className="h-4 w-4" />
            Clear
          </Button>
          <Button className="h-11 min-w-0 flex-1 rounded-xl px-3 lg:flex-none lg:px-8" onClick={onReview}>
            <ShieldCheck className="h-4 w-4" />
            Review support plan
          </Button>
        </div>
      </div>
    </div>
  );
}

export function FunderNewReviewDialog({
  open,
  onOpenChange,
  items,
  available,
  walletLoading,
  walletError,
  onRemove,
  onFund,
  onTopUp,
  onViewPortfolio,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: FunderNewSelectionItem[];
  available: number | null;
  walletLoading: boolean;
  walletError: unknown;
  onRemove: (item: FunderNewSelectionItem) => void;
  /** Called with the total and the shortfall (0 when the balance covers it). */
  onFund?: (total: number, shortfall: number) => void | FunderFundResult | Promise<void | FunderFundResult>;
  /** Called when the balance is too low; defaults to opening the deposit dialog. */
  onTopUp?: (shortfall: number) => void;
  /** Opens the supporter's own portfolio list from the success view. */
  onViewPortfolio?: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<FunderReceipt | null>(null);
  const total = items.reduce((sum, item) => sum + item.amount, 0);
  const shortfall = available === null ? null : Math.max(0, total - available);

  // A fresh review always starts on the confirm step, never on a stale success view.
  useEffect(() => {
    if (open) {
      setReceipt(null);
      setConfirmOpen(false);
    }
  }, [open]);

  const closeAll = () => {
    setConfirmOpen(false);
    setReceipt(null);
    onOpenChange(false);
  };


  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex flex-col w-screen max-w-none h-[100dvh] max-h-none rounded-none border-0 p-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] gap-3 overflow-y-auto overflow-x-hidden bg-background sm:grid sm:w-full sm:max-w-lg sm:h-auto sm:max-h-[90vh] sm:rounded-3xl sm:border sm:border-border/80 sm:p-6 sm:gap-4 sm:shadow-2xl">
        <DialogHeader className="pr-6 text-left">
          <DialogTitle className="text-base sm:text-xl font-bold tracking-tight">Your support plan</DialogTitle>
          <DialogDescription className="text-xs sm:text-sm text-muted-foreground mt-0.5 leading-relaxed">
            Check the homes you picked. Nothing is submitted from this screen.
          </DialogDescription>
        </DialogHeader>

        {/* Financial Overview: Re-structured 2-column + full-width coverage layout */}
        <div className="grid grid-cols-2 gap-2 sm:gap-2.5">
          {/* Card 1: Total Support */}
          <div className="flex flex-col justify-between rounded-2xl bg-primary p-3 sm:p-4 text-primary-foreground shadow-xs">
            <p className="text-[10px] sm:text-xs font-semibold uppercase tracking-wider text-primary-foreground/75">
              Total Support
            </p>
            <p className="mt-1 text-base sm:text-xl font-bold tracking-tight truncate">
              {formatDynamic(total)}
            </p>
          </div>

          {/* Card 2: Monthly Returns */}
          <div className="flex flex-col justify-between rounded-2xl border border-border/70 bg-primary/5 p-3 sm:p-4 shadow-2xs">
            <p className="text-[10px] sm:text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Monthly at 15%
            </p>
            <p className="mt-1 text-base sm:text-xl font-bold tracking-tight text-emerald-600 dark:text-emerald-400 truncate">
              {formatDynamic(monthlyAt15(total))}
            </p>
          </div>

          {/* Card 3: Wallet Balance & Coverage Status */}
          <div className="col-span-2 flex items-center justify-between gap-2 rounded-2xl border border-border/70 bg-muted/30 px-3.5 py-2.5 sm:py-3 shadow-2xs">
            <div className="min-w-0 flex-1">
              <p className="text-[10px] sm:text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Available Balance
              </p>
              <p className="mt-0.5 text-sm sm:text-base font-bold tracking-tight text-foreground truncate">
                {walletError || available === null ? 'Unavailable' : walletLoading ? 'Loading…' : formatDynamic(available)}
              </p>
            </div>
            {shortfall !== null && (
              <div className="shrink-0">
                <Badge
                  variant="outline"
                  className={cn(
                    "text-[11px] sm:text-xs font-semibold px-2 sm:px-2.5 py-0.5 rounded-full border shadow-2xs",
                    shortfall > 0
                      ? "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30"
                      : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30"
                  )}
                >
                  {shortfall > 0 ? `${formatDynamic(shortfall)} short` : 'Fully covered'}
                </Badge>
              </div>
            )}
          </div>
        </div>

        {/* Selected Homes List */}
        <div className="space-y-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground px-0.5">
            Selected Homes ({items.length})
          </p>
          <ul className="space-y-2 sm:max-h-52 sm:overflow-y-auto pr-0.5">
            {items.map((item) => (
              <li
                key={`${item.category}:${item.id}`}
                className="flex items-center gap-2.5 sm:gap-3 rounded-2xl border border-border/70 bg-card p-2.5 sm:p-3 shadow-2xs"
              >
                {item.imageUrl ? (
                  <img
                    src={item.imageUrl}
                    alt={item.title}
                    className="h-11 w-11 sm:h-12 sm:w-12 shrink-0 rounded-xl object-cover"
                  />
                ) : (
                  <span className="flex h-11 w-11 sm:h-12 sm:w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <Home className="h-5 w-5" />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <p className="min-w-0 truncate text-xs sm:text-sm font-semibold text-foreground">
                      {item.title}
                    </p>
                    <Badge variant="outline" className="text-[9px] sm:text-[10px] px-1.5 py-0 h-4 rounded-full font-medium shrink-0">
                      {categoryLabel(item.category)}
                    </Badge>
                  </div>
                  <p className="truncate text-[11px] sm:text-xs text-muted-foreground mt-0.5">{item.place}</p>
                  <p className="mt-0.5 text-xs sm:text-sm font-bold text-foreground">{formatDynamic(item.amount)}</p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-xl"
                  aria-label={`Remove ${item.title}`}
                  onClick={() => onRemove(item)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        </div>

        {/* Regulatory & Information Notice */}
        <div className="mt-auto sm:mt-0 flex items-start gap-2.5 rounded-xl border border-border/60 bg-muted/30 p-2.5 sm:p-3 text-xs text-muted-foreground leading-relaxed">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <p className="min-w-0 flex-1 text-[11px] sm:text-xs">
            Selecting and reviewing homes is planning only. Support starts after you confirm and the usual approval step is completed. Returns shown are estimates at the current 15% rate.
          </p>
        </div>

        {items.length > 0 ? (
          <Button
            className="h-11 sm:h-12 w-full gap-2 bg-emerald-600 text-sm sm:text-base font-bold text-white hover:bg-emerald-700 rounded-xl shadow-md active:scale-[0.99] transition-all"
            disabled={walletLoading || available === null}
            onClick={() => {
              if (shortfall !== null && shortfall > 0) {
                onOpenChange(false);
                if (onTopUp) onTopUp(shortfall);
                else window.dispatchEvent(new Event('open-deposit'));
              } else if (onFund) {
                setConfirmOpen(true);
                onOpenChange(false);
              }
            }}
          >
            <Wallet className="h-4 w-4" />
            {shortfall !== null && shortfall > 0 ? 'Top up Now' : 'Fund this plan'}
          </Button>
        ) : null}
      </DialogContent>

      <Dialog
        open={confirmOpen}
        onOpenChange={(o) => {
          if (submitting) return;
          setConfirmOpen(o);
          if (!o) setReceipt(null);
        }}
      >
        <DialogContent className="w-[calc(100vw-1rem)] sm:w-full max-w-md max-h-[90vh] overflow-y-auto overflow-x-hidden p-3.5 sm:p-6 rounded-2xl sm:rounded-3xl border border-border/80 bg-background shadow-2xl">
          {receipt ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <CheckCircle2 className="h-5 w-5 flex-none text-success" />
                  Support submitted
                </DialogTitle>
                <DialogDescription>
                  Your support for {receipt.count === 1 ? 'one home' : `${receipt.count} homes`} is in. Nothing else is needed from you right now.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-2 rounded-2xl border bg-muted/40 p-4 text-sm">
                <div className="flex justify-between gap-3"><span className="text-muted-foreground">Total support</span><span className="font-semibold">{formatDynamic(receipt.total)}</span></div>
                <div className="flex justify-between gap-3"><span className="text-muted-foreground">Estimated monthly Returns</span><span className="font-semibold text-success">{formatDynamic(monthlyAt15(receipt.total))}</span></div>
                <div className="flex justify-between gap-3"><span className="text-muted-foreground">Balance after</span><span className="font-semibold">{formatDynamic(receipt.balanceAfter)}</span></div>
                {receipt.reference ? (
                  <div className="flex justify-between gap-3"><span className="text-muted-foreground">Booking reference</span><span className="break-all text-right font-semibold">{receipt.reference}</span></div>
                ) : null}
              </div>

              <div>
                <p className="text-sm font-semibold">What happens next</p>
                <ol className="mt-2 space-y-2">
                  {NEXT_STEPS.map((step, index) => (
                    <li key={step.title} className="flex gap-3 rounded-2xl border bg-primary/5 p-3">
                      <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">{index + 1}</span>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold">{step.title}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{step.text}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>

              <div className="flex gap-2">
                <Button variant="outline" className="h-11 flex-1" onClick={closeAll}>Done</Button>
                {onViewPortfolio ? (
                  <Button
                    className="h-11 flex-1 bg-emerald-600 text-white hover:bg-emerald-700"
                    onClick={() => {
                      // Capture the handler first: closing the dialog can unmount this branch.
                      const openPortfolio = onViewPortfolio;
                      closeAll();
                      openPortfolio();
                    }}
                  >
                    View my portfolios
                  </Button>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Confirm your support</DialogTitle>
                <DialogDescription>Please review this summary. Support is only submitted when you confirm.</DialogDescription>
              </DialogHeader>
              <div className="space-y-2 rounded-2xl border bg-muted/40 p-4 text-sm">
                <div className="flex justify-between gap-3"><span className="text-muted-foreground">Homes</span><span className="font-semibold">{items.length}</span></div>
                <div className="flex justify-between gap-3"><span className="text-muted-foreground">Total support</span><span className="font-semibold">{formatDynamic(total)}</span></div>
                <div className="flex justify-between gap-3"><span className="text-muted-foreground">Monthly at 15%</span><span className="font-semibold text-success">{formatDynamic(monthlyAt15(total))}</span></div>
                <div className="flex justify-between gap-3"><span className="text-muted-foreground">Balance after</span><span className="font-semibold">{formatDynamic(Math.max(0, (available ?? 0) - total))}</span></div>
              </div>
              <ul className="max-h-40 space-y-1 overflow-y-auto text-sm">
                {items.map((item) => (
                  <li key={`c:${item.category}:${item.id}`} className="flex justify-between gap-3">
                    <span className="truncate">{item.title}</span>
                    <span className="flex-none font-medium">{formatDynamic(item.amount)}</span>
                  </li>
                ))}
              </ul>
              <div className="flex gap-2">
                <Button variant="outline" className="h-11 flex-1" disabled={submitting} onClick={() => setConfirmOpen(false)}>Cancel</Button>
                <Button
                  className="h-11 flex-1 bg-emerald-600 text-white hover:bg-emerald-700"
                  disabled={submitting}
                  onClick={async () => {
                    setSubmitting(true);
                    try {
                      const result = (await onFund?.(total, 0)) as FunderFundResult | undefined;
                      if (result?.submitted) {
                        // Stay on this dialog and flip it to the success view, so the
                        // result is on screen rather than in a toast that disappears.
                        setReceipt({
                          count: items.length,
                          total,
                          balanceAfter: Math.max(0, (available ?? 0) - total),
                          reference: result.reference ?? null,
                        });
                      } else {
                        setConfirmOpen(false);
                        onOpenChange(false);
                      }
                    } catch {
                      // The caller already reported the error; keep the summary open.
                    } finally {
                      setSubmitting(false);
                    }
                  }}
                >
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Confirm and support
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}

export default FunderNewSelectionBar;
