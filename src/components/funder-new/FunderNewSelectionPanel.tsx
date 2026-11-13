import { lazy, Suspense, useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import { ArrowLeft, CheckCircle2, Copy, Home, MapPin, MessageCircle, Loader2, ShieldCheck, Trash2, Wallet, X, Send, TrendingUp, Sprout } from 'lucide-react';
import { toast } from 'sonner';
import { normalizeE164OrNull } from '@/lib/phoneUtils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { formatDynamic } from '@/lib/currencyFormat';
import type { FunderNewCategory, FunderNewSelectionItem } from './types';
import { categoryLabel } from './utils';
import { SupportPlanExample } from '@/components/support-plan/SupportPlanExample';
import { useOwnNewPortfolioRate } from '@/hooks/usePartnerQuoteRate';
import { formatRatePct, monthlyReturnFor } from '@/lib/partnerReturnPolicy';
import { LANDLORD_PAID_STEPS } from '@/lib/selfSupportDirect';
const SupporterAgreementViewModal = lazy(() => import('@/components/supporter/agreement/SupporterAgreementCard').then((m) => ({ default: m.SupporterAgreementViewModal })));
import { useFunderFloatHolds } from '@/hooks/useFunderSavedTabs';
import type { FunderSavedTab } from '@/lib/funderSavedTabs';

/**
 * Monthly Returns on a selection at the signed-in partner's OWN rate for a new portfolio
 * (partner_quote_rate 'me'): today's 15 while the switch has never been on, 10 for a new
 * partner after it, their own rate for an existing partner. null (loading or unknown) = no figure.
 */
function useMonthlyAtOwnRate(): (total: number) => number | null {
  const { rate } = useOwnNewPortfolioRate();
  return (total: number) => monthlyReturnFor(total, rate);
}

/**
 * What the caller reports back when "Confirm and support" is pressed.
 * Only `submitted: true` switches the confirmation into the success view —
 * a caller that does not actually post anything returns nothing, so the
 * screen never claims a support that was not recorded.
 */
export type FunderFundResult = {
  submitted: boolean;
  reference?: string | null;
  /** True only when the server moved the rent to the agent's landlord float. */
  releasedToAgent?: boolean;
  /** True when the portfolio activates only once the landlord is paid (show LANDLORD_PAID_STEPS). */
  activatesOnLandlordPaid?: boolean;
  /** House bookings are not a rent release. */
  supportKind?: 'rent' | 'house';
  landlordNames?: string[];
  rentRequestIds?: string[];
};

/** What the partner sees after a direct release. No operational review. */
const RELEASED_STEPS = [
  { title: 'With the agent', text: 'Your rent has gone to the agent, who will pay the landlord within 24 hours.' },
  { title: 'Landlord is paid', text: 'The agent pays the landlord from that float.' },
  { title: 'Track Rent profit share', text: 'Follow your supported homes and Rent profit share from your portfolio.' },
];

const RECORDED_STEPS = [
  { title: 'Support recorded', text: 'Your support is recorded. The rent has not moved to the agent yet.' },
  { title: 'Float covers the rent', text: 'When your float covers the rent and Welile Cover, it goes to the agent.' },
  { title: 'Track Rent profit share', text: 'Follow your supported homes and Rent profit share from your portfolio.' },
];

const HOUSE_STEPS = [
  { title: 'House support recorded', text: 'Your house support is recorded.' },
  { title: 'A tenant is placed', text: 'An agent places a tenant in the usual way.' },
  { title: 'Track Rent profit share', text: 'Follow your supported homes and Rent profit share from your portfolio.' },
];

/** Snapshot taken at submit time: the parent may clear the selection as soon
 *  as the support is posted, and the success view must still show real figures. */
type FunderReceipt = {
  count: number;
  total: number;
  balanceAfter: number;
  reference: string | null;
  releasedToAgent: boolean;
  activatesOnLandlordPaid: boolean;
  supportKind: 'rent' | 'house';
  landlordNames: string[];
  rentRequestIds: string[];
};

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
  const monthlyAt15 = useMonthlyAtOwnRate();
  const ownRatePct = formatRatePct(useOwnNewPortfolioRate().rate);
  if (items.length === 0 || !category) return null;
  const total = items.reduce((sum, item) => sum + item.amount, 0);

  return (
    // z-[60] keeps the bar above the app's other fixed bottom overlays, which
    // sit at z-40 and would otherwise swallow taps on Review.
    //
    // The bar is anchored above the floating bottom navigation instead of the
    // viewport edge: that pill (BottomRoleSwitcher / MobileBottomNav) is fixed
    // at 10px from the bottom, 68px tall, and paints at z-100, so a bar sitting
    // at bottom-0 had Clear / the Support N homes button hidden underneath it.
    // 10px inset + 68px pill + 8px breathing room = 86px, plus the device
    // bottom inset (which the pill is already lifted by). The pill shows at
    // every breakpoint, so this offset is deliberately not responsive-gated.
    <div className="funder-selection-sheet fixed inset-x-0 bottom-0 z-[110] w-full max-w-full overflow-hidden rounded-t-2xl border-t bg-card shadow-[0_-8px_30px_-12px_hsl(var(--primary)/0.35)] pb-[env(safe-area-inset-bottom,0px)]">
      <style>{`
        @keyframes funderSheetUp {
          0% { transform: translate3d(0,100%,0); }
          60% { transform: translate3d(0,-6px,0); }
          80% { transform: translate3d(0,2px,0); }
          100% { transform: translate3d(0,0,0); }
        }
        .funder-selection-sheet { animation: funderSheetUp 520ms cubic-bezier(0.22,1,0.36,1) both; will-change: transform; }
        @media (prefers-reduced-motion: reduce) { .funder-selection-sheet { animation: none; } }
      `}</style>
      <div className="flex justify-center pt-2" aria-hidden>
        <span className="h-1.5 w-10 rounded-full bg-muted-foreground/30" />
      </div>
      <div className="mx-auto flex w-full min-w-0 max-w-7xl flex-col gap-2 px-4 pb-2.5 pt-1.5 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">

        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
          <p className="text-sm font-semibold">
            {items.length} {items.length === 1 ? 'home' : 'homes'} selected
          </p>
          <p className="text-sm">
            <span className="text-muted-foreground">Total </span>
            <span className="font-semibold">{formatDynamic(total)}</span>
          </p>
          <p className="text-sm">
            <span className="text-muted-foreground">Monthly Rent profit share{ownRatePct ? ` (${ownRatePct})` : ''} </span>
            <span className="font-semibold text-success">{monthlyAt15(total) === null ? '—' : formatDynamic(monthlyAt15(total))}</span>
          </p>
        </div>
        <div className="flex min-w-0 gap-2">
          <Button variant="ghost" className="h-11 flex-none rounded-xl border border-destructive px-3 text-destructive hover:border-destructive" onClick={onClear}>
            <X className="h-4 w-4" />
            Clear
          </Button>
          <Button className="h-11 min-w-0 flex-1 rounded-xl px-3 lg:flex-none lg:px-8" onClick={onReview}>
            <Sprout className="h-4 w-4" aria-hidden />
            Support {items.length} {items.length === 1 ? 'home' : 'homes'}
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
  onOpenSavedTab,
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
  /** Opens Saved Items on a pill (the co-support float-hold line). */
  onOpenSavedTab?: (tab: FunderSavedTab) => void;
}) {
  const holds = useFunderFloatHolds(open);
  const monthlyAt15 = useMonthlyAtOwnRate();
  const ownRatePct = formatRatePct(useOwnNewPortfolioRate().rate);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<FunderReceipt | null>(null);
  const [contractOpen, setContractOpen] = useState(false);
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
      <DialogContent className="flex flex-col w-screen max-w-none h-[100dvh] max-h-none rounded-none border-0 p-0 gap-0 overflow-hidden bg-background sm:w-full sm:max-w-lg sm:h-auto sm:max-h-[90vh] sm:rounded-3xl sm:border sm:border-border/80 sm:shadow-2xl">
        {/* Top bar: visible Back + title */}
        <div className="flex shrink-0 items-start gap-2 border-b border-border/60 bg-background px-3 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] pr-12 sm:px-6 sm:pt-5">
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11 shrink-0 rounded-xl"
            aria-label="Back"
            onClick={() => onOpenChange(false)}
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <DialogHeader className="min-w-0 flex-1 space-y-0.5 pt-1 text-left">
            <DialogTitle className="text-lg sm:text-xl font-bold tracking-tight">Your support plan</DialogTitle>
            {/* Screen readers keep a description; nothing shows on screen. */}
            <DialogDescription className="sr-only">
              Review the homes you picked. Nothing is submitted from this screen.
            </DialogDescription>
          </DialogHeader>
        </div>

        {/* Scrollable body */}
        {/* App-style body: photo header, one summary card, then three tabs so nothing is stacked at once. */}
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain pb-6 [-webkit-overflow-scrolling:touch]">
          {items[0] && <PlanHero item={items[0]} more={items.length - 1} />}

          <div className="relative z-10 -mt-8 space-y-4 px-4 sm:px-6">
            {/* Summary card: what you put in, what you earn, and whether your float covers it. */}
            <section className="rounded-3xl border border-border/70 bg-card p-4 shadow-lg">
              <div className="grid grid-cols-2 gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-muted-foreground">You support</p>
                  <p className="mt-0.5 break-words text-xl font-bold tracking-tight">{formatDynamic(total)}</p>
                </div>
                <div className="min-w-0 border-l border-border/60 pl-3">
                  <p className="text-xs font-medium text-muted-foreground">You earn monthly</p>
                  <p className="mt-0.5 break-words text-xl font-bold tracking-tight text-success">
                    {monthlyAt15(total) === null ? '—' : formatDynamic(monthlyAt15(total))}
                  </p>
                  {ownRatePct ? <p className="text-xs text-muted-foreground">at {ownRatePct} a month</p> : null}
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-muted/50 px-3 py-2.5">
                <span className="flex min-w-0 items-center gap-2.5">
                  <Wallet className="h-5 w-5 shrink-0 text-primary" aria-hidden />
                  <span className="min-w-0">
                    <span className="block text-xs text-muted-foreground">Your float</span>
                    <span className="block whitespace-nowrap text-sm font-semibold">
                      {walletError || available === null ? 'Unavailable' : walletLoading ? 'Loading…' : formatDynamic(available)}
                    </span>
                    {holds.line ? (
                      holds.tab === 'co_support' && onOpenSavedTab ? (
                        <button type="button" onClick={() => onOpenSavedTab('co_support')} className="mt-0.5 block text-left text-[11px] leading-snug text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground">
                          {holds.line}
                        </button>
                      ) : (
                        <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{holds.line}</span>
                      )
                    ) : null}
                  </span>
                </span>
                {shortfall !== null && (
                  <span
                    className={cn(
                      'shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold',
                      shortfall > 0 ? 'bg-warning/15 text-warning' : 'bg-success/15 text-success',
                    )}
                  >
                    {shortfall > 0 ? `${formatDynamic(shortfall)} short` : 'Fully covered'}
                  </span>
                )}
              </div>
              <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
                Support once, earn for 12 months. Backed by Welile's operational guarantee.
              </p>
            </section>

            <Tabs defaultValue="homes" className="w-full">
              <TabsList className="grid h-11 w-full grid-cols-3 rounded-full bg-muted p-1">
                <TabsTrigger value="homes" className="rounded-full">
                  Homes{items.length > 1 ? ` (${items.length})` : ''}
                </TabsTrigger>
                <TabsTrigger value="people" className="rounded-full">People</TabsTrigger>
                <TabsTrigger value="how" className="rounded-full">How it works</TabsTrigger>
              </TabsList>

              {/* forceMount keeps every tab in the page (hidden when inactive) so screen readers and tests still find it. */}
              <TabsContent value="homes" forceMount className="mt-3 space-y-3 data-[state=inactive]:hidden">
                <ul className="divide-y divide-border/60 overflow-hidden rounded-3xl border border-border/70 bg-card">
                  {items.map((item) => (
                    <li key={`${item.category}:${item.id}`} className="flex items-center gap-3 p-3">
                      {item.imageUrl ? (
                        <img src={item.imageUrl} alt={item.title} className="h-12 w-12 shrink-0 rounded-xl object-cover" />
                      ) : (
                        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                          <Home className="h-5 w-5" />
                        </span>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-foreground">{item.title}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {item.tenantName ? `${item.tenantName} · ` : ''}{item.place}
                        </p>
                        <p className="mt-0.5 text-sm font-bold text-foreground">{formatDynamic(item.amount)}</p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-10 w-10 shrink-0 rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        aria-label={`Remove ${item.title}`}
                        onClick={() => onRemove(item)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
                <p className="px-1 text-xs leading-relaxed text-muted-foreground">
                  Nothing is charged until you confirm. When your float covers the rent, it goes to the agent, who pays the landlord within 24 hours. Rent profit share figures are estimates{ownRatePct ? ` at your current ${ownRatePct} rate` : ''}.
                </p>
              </TabsContent>

              <TabsContent value="people" forceMount className="mt-3 space-y-3 data-[state=inactive]:hidden">
                {items.map((item) => (
                  <HomeContacts key={`wa:${item.category}:${item.id}`} item={item} showTitle={items.length > 1} />
                ))}
              </TabsContent>

              <TabsContent value="how" forceMount className="mt-3 data-[state=inactive]:hidden">
                {items[0] && <HowItWorks item={items[0]} />}
              </TabsContent>
            </Tabs>
          </div>
        </div>

        {/* 4. Sticky main action */}
        {items.length > 0 ? (
          <div className="shrink-0 border-t border-border/60 bg-background px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-5">
            <Button
              className="h-12 w-full gap-2 rounded-xl bg-success text-base font-bold text-success-foreground shadow-md hover:bg-success/90 active:scale-[0.99] transition-all"
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
              <Wallet className="h-5 w-5" />
              {shortfall !== null && shortfall > 0 ? 'Top up Now' : 'Fund this plan'}
            </Button>
          </div>
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
                  {receipt.activatesOnLandlordPaid
                    ? LANDLORD_PAID_STEPS[0].text
                    : receipt.releasedToAgent
                    ? 'Your rent has gone to the agent, who will pay the landlord within 24 hours.'
                    : receipt.supportKind === 'house'
                      ? 'Your house support is recorded.'
                      : 'Your support is recorded. The rent has not moved to the agent yet.'}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-2 rounded-2xl border bg-muted/40 p-4 text-sm">
                <div className="flex justify-between gap-3"><span className="text-muted-foreground">{receipt.releasedToAgent ? 'Amount paid (rent + 2% Welile Cover)' : 'Support amount (rent + 2% Welile Cover)'}</span><span className="font-semibold">{formatDynamic(receipt.total)}</span></div>
                {receipt.landlordNames.length > 0 ? (
                  <div className="flex justify-between gap-3"><span className="text-muted-foreground">Landlord</span><span className="text-right font-semibold">{receipt.landlordNames.join(', ')}</span></div>
                ) : null}
                <div className="flex justify-between gap-3"><span className="text-muted-foreground">Estimated monthly Rent profit share</span><span className="font-semibold text-success">{monthlyAt15(receipt.total) === null ? '—' : formatDynamic(monthlyAt15(receipt.total))}</span></div>
                <div className="flex justify-between gap-3"><span className="text-muted-foreground">Operational float after</span><span className="font-semibold">{formatDynamic(receipt.balanceAfter)}</span></div>
                {receipt.reference ? (
                  <div className="flex justify-between gap-3"><span className="text-muted-foreground">Reference</span><span className="break-all text-right font-semibold">{receipt.reference}</span></div>
                ) : null}
              </div>

              {receipt.releasedToAgent && receipt.rentRequestIds.length > 0 ? (
                <DirectReleaseReceipts rentRequestIds={receipt.rentRequestIds} />
              ) : null}

              <div>
                <p className="text-sm font-semibold">What happens next</p>
                <ol className="mt-2 space-y-2">
                  {(receipt.activatesOnLandlordPaid ? LANDLORD_PAID_STEPS : receipt.releasedToAgent ? RELEASED_STEPS : receipt.supportKind === 'house' ? HOUSE_STEPS : RECORDED_STEPS).map((step, index) => (
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

              <Button className="h-11 w-full" onClick={() => setContractOpen(true)}>
                <FileText className="mr-2 h-4 w-4" /> View contract
              </Button>
              {contractOpen ? (
                <Suspense fallback={null}>
                  <SupporterAgreementViewModal open={contractOpen} onOpenChange={setContractOpen} defaultTab="full" />
                </Suspense>
              ) : null}

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
                <div className="flex justify-between gap-3"><span className="text-muted-foreground">Monthly Rent profit share{ownRatePct ? ` (${ownRatePct})` : ''}</span><span className="font-semibold text-success">{monthlyAt15(total) === null ? '—' : formatDynamic(monthlyAt15(total))}</span></div>
                <div className="flex justify-between gap-3"><span className="text-muted-foreground">Operational float after</span><span className="font-semibold">{formatDynamic(Math.max(0, (available ?? 0) - total))}</span></div>
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
                  disabled={submitting || walletLoading || !!walletError || available === null || (shortfall ?? 0) > 0}
                  onClick={async () => {
                    setSubmitting(true);
                    try {
                      const result = (await onFund?.(total, 0)) as FunderFundResult | undefined;
                      if (result?.submitted) {
                        // Stay on this dialog and flip it to the success view, so the
                        // result is on screen rather than in a toast that disappears.
                        // Names are snapshotted here: the parent may clear the selection
                        // as soon as the support is posted.
                        const landlordNames = (result.landlordNames && result.landlordNames.length > 0)
                          ? result.landlordNames
                          : items.map((item) => item.landlordName).filter((name): name is string => !!name && name.trim().length > 0);
                        setReceipt({
                          count: items.length,
                          total,
                          balanceAfter: Math.max(0, (available ?? 0) - total),
                          reference: result.reference ?? null,
                          releasedToAgent: result.releasedToAgent === true,
                          activatesOnLandlordPaid: result.activatesOnLandlordPaid === true,
                          supportKind: result.supportKind === 'house' ? 'house' : 'rent',
                          landlordNames,
                          rentRequestIds: result.rentRequestIds ?? items.filter((item) => item.category === 'ready').map((item) => item.id),
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

/**
 * Receipt from the verified-plan pack (PR 83). Only the receipt actions are
 * shown here. Tenant and agent phone numbers are not rendered.
 */
function DirectReleaseReceipts({ rentRequestIds }: { rentRequestIds: string[] }) {
  const [busyId, setBusyId] = useState<string | null>(null);

  const run = async (id: string, kind: 'download' | 'print') => {
    setBusyId(`${kind}:${id}`);
    try {
      const { fetchFunderVerifiedPlan } = await import('@/lib/funderVerifiedPlan');
      const { downloadFunderRentReceiptPdf, printFunderRentReceipt } = await import('@/lib/funderVerifiedPlanPdf');
      const result = await fetchFunderVerifiedPlan(id);
      if (result.state !== 'ready' || !result.plan.funding) {
        toast.error('The receipt is not ready yet. Your reference above is still valid.');
        return;
      }
      if (kind === 'download') await downloadFunderRentReceiptPdf(result.plan);
      else if (!printFunderRentReceipt(result.plan)) toast.error('Allow pop-ups to print, or use Download receipt.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not prepare the receipt.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-2">
      <p className="text-sm font-semibold">Receipt</p>
      {rentRequestIds.map((id) => (
        <div key={id} className="grid grid-cols-2 gap-2">
          <Button type="button" className="h-11 rounded-xl" disabled={busyId !== null} onClick={() => void run(id, 'download')}>
            {busyId === `download:${id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Download receipt
          </Button>
          <Button type="button" variant="outline" className="h-11 rounded-xl" disabled={busyId !== null} onClick={() => void run(id, 'print')}>
            Print receipt
          </Button>
        </div>
      ))}
    </div>
  );
}

export default FunderNewSelectionBar;

/** Digits-only international form (256…) for wa.me, or null when unusable. */
export function toWhatsAppDigits(phone?: string | null): string | null {
  if (!phone) return null;
  const e164 = normalizeE164OrNull(phone);
  return e164 ? e164.replace(/\D/g, '') : null;
}

function ContactRow({ label, name, phone, primary = false }: { label: string; name?: string | null; phone?: string | null; primary?: boolean }) {
  const digits = toWhatsAppDigits(phone);
  const copy = async () => {
    if (!phone) return;
    try {
      await navigator.clipboard.writeText(digits ? `+${digits}` : phone);
      toast.success(`${label} number copied`);
    } catch {
      toast.error('Could not copy the number');
    }
  };
  return (
    <div className="flex items-center justify-between gap-3 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className={cn('break-words text-foreground', primary ? 'text-lg font-bold' : 'text-sm font-medium')}>{name || 'Name not shared'}</p>
        {phone ? (
          <button
            type="button"
            onClick={copy}
            aria-label={`Copy ${label} number`}
            className="mt-0.5 inline-flex min-h-[44px] items-center gap-1.5 break-all text-left text-sm text-muted-foreground underline-offset-2 hover:underline"
          >
            {digits ? `+${digits}` : phone}
            <Copy className="h-3.5 w-3.5 shrink-0" />
          </button>
        ) : (
          <p className="mt-0.5 text-sm text-muted-foreground">Not available</p>
        )}
      </div>
      {digits && (
        <a
          href={`https://wa.me/${digits}`}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`WhatsApp ${label}`}
          className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-xl bg-success px-3.5 text-sm font-semibold text-success-foreground shadow-sm hover:opacity-90"
        >
          <MessageCircle className="h-4 w-4" />
          WhatsApp
        </a>
      )}
    </div>
  );
}

function HomeContacts({ item, showTitle }: { item: FunderNewSelectionItem; showTitle: boolean }) {
  const mapUrl =
    item.lat != null && item.lng != null
      ? `https://www.google.com/maps/search/?api=1&query=${item.lat},${item.lng}`
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.place)}`;
  return (
    <div className="rounded-2xl border border-primary/30 bg-primary/5 px-4 py-1">
      {showTitle && <p className="pt-2.5 text-sm font-semibold text-foreground break-words">{item.title}</p>}
      <div className="divide-y divide-border/50">
        <ContactRow primary label="Tenant" name={item.tenantName} phone={item.tenantPhone} />
        <ContactRow primary label="Landlord" name={item.landlordName} phone={item.landlordPhone} />
        <ContactRow label="Agent" name={item.agentName} phone={item.agentPhone} />
      </div>
      <div className="pb-3 pt-1">
        <Button asChild variant="outline" className="h-11 w-full gap-1.5 rounded-xl text-sm">
          <a href={mapUrl} target="_blank" rel="noopener noreferrer" className="w-full justify-center">
            <MapPin className="h-4 w-4 shrink-0 text-destructive" />
            <span className="truncate">{item.lat != null && item.lng != null ? 'Show house on map' : 'Show area on map'}</span>
          </a>
        </Button>
      </div>
    </div>
  );
}


/** Public link to this home's support plan — works for anyone, no sign-in needed to view. */
export function buildPlanShareLink(item: Pick<FunderNewSelectionItem, 'id' | 'category'>, origin: string): string {
  return `${origin.replace(/\/$/, '')}/support/${item.id}`;
}

/** Prefilled share text. Never carries phone numbers. */
export function buildPlanShareMessage(item: Pick<FunderNewSelectionItem, 'tenantName'>, link: string): string {
  const first = (item.tenantName || '').trim().split(/\s+/)[0];
  const who = first || 'a tenant';
  return `Help ${who} keep their home 🏠 Support their rent on Welile and earn monthly Rent profit share on the rent for 12 months, with Welile's operational guarantee. See the plan: ${link}`;
}

export function buildWhatsAppShareUrl(message: string): string {
  return `https://wa.me/?text=${encodeURIComponent(message)}`;
}

const HOW_STEPS = [
  { icon: Wallet, text: 'Deposit to your Welile wallet' },
  { icon: TrendingUp, text: 'Tap Fund' },
  { icon: Send, text: 'The rent goes to the agent, who pays the landlord within 24 hours.' },
];

/** Full-bleed photo header with the home's name over a soft gradient, like an app detail screen. */
function PlanHero({ item, more }: { item: FunderNewSelectionItem; more: number }) {
  return (
    <div className="relative aspect-[16/10] w-full overflow-hidden bg-primary/10 sm:aspect-video">
      {item.imageUrl ? (
        <img src={item.imageUrl} alt={item.title} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-primary">
          <Home className="h-12 w-12" aria-hidden />
        </div>
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/20 to-transparent" aria-hidden />
      <span className="absolute left-4 top-4 rounded-full bg-background/90 px-2.5 py-1 text-xs font-semibold text-foreground shadow-sm backdrop-blur sm:left-6">
        {categoryLabel(item.category)}
      </span>
      {more > 0 ? (
        <span className="absolute right-4 top-4 rounded-full bg-background/90 px-2.5 py-1 text-xs font-semibold text-foreground shadow-sm backdrop-blur sm:right-6">
          +{more} more
        </span>
      ) : null}
      <div className="absolute inset-x-0 bottom-10 px-4 text-white sm:px-6">
        <p className="text-xs font-medium uppercase tracking-wider text-white/80">Turn rent into an asset</p>
        <p className="mt-0.5 line-clamp-2 text-lg font-bold leading-snug">{item.title}</p>
        <p className="mt-0.5 flex items-center gap-1 truncate text-sm text-white/85">
          <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {item.place}
        </p>
      </div>
    </div>
  );
}

/** The "How it works" tab: three short steps as a timeline, then the worked example for this plan. */
function HowItWorks({ item }: { item: FunderNewSelectionItem }) {
  // Signed-in partner screen: the worked example is priced at the viewer's own rate (null = no figure).
  const { rate: ownRate } = useOwnNewPortfolioRate();

  return (
    <section className="space-y-5">
      <ol className="rounded-3xl border border-border/70 bg-card p-4">
        {HOW_STEPS.map((step, i) => (
          <li key={step.text} className="relative flex gap-3 pb-4 last:pb-0">
            {i < HOW_STEPS.length - 1 ? (
              <span className="absolute left-[15px] top-8 h-[calc(100%-2rem)] w-0.5 bg-primary/20" aria-hidden />
            ) : null}
            <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <step.icon className="h-4 w-4" aria-hidden />
            </span>
            <span className="min-w-0 pt-1 text-sm">
              <span className="font-semibold text-muted-foreground">Step {i + 1}. </span>
              {step.text}
            </span>
          </li>
        ))}
      </ol>

      <SupportPlanExample fundingAmount={item.amount} rate={ownRate} />
    </section>
  );
}
