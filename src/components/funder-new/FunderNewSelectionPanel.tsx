import { useEffect, useState } from 'react';
import { ArrowLeft, CheckCircle2, CircleDollarSign, Copy, Home, MapPin, MessageCircle, Loader2, Info, ShieldCheck, Trash2, Wallet, X, Share2, Link2, Send, HandCoins, TrendingUp, CalendarCheck } from 'lucide-react';
import { toast } from 'sonner';
import { normalizeE164OrNull } from '@/lib/phoneUtils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { formatDynamic } from '@/lib/currencyFormat';
import type { FunderNewCategory, FunderNewSelectionItem } from './types';
import { categoryLabel } from './utils';
import { SupportPlanExample } from '@/components/support-plan/SupportPlanExample';

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
    // at bottom-0 had Clear / the Support N homes button hidden underneath it.
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
          <Button variant="ghost" className="h-11 flex-none rounded-xl border border-destructive px-3 text-destructive hover:border-destructive" onClick={onClear}>
            <X className="h-4 w-4" />
            Clear
          </Button>
          <Button className="h-11 min-w-0 flex-1 rounded-xl px-3 lg:flex-none lg:px-8" onClick={onReview}>
            <CircleDollarSign className="h-4 w-4" aria-hidden />
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
            <DialogDescription className="text-sm text-muted-foreground leading-relaxed">
              Check the homes you picked. Nothing is submitted from this screen.
            </DialogDescription>
          </DialogHeader>
        </div>

        {/* Scrollable body */}
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overflow-x-hidden overscroll-contain px-4 py-4 sm:px-6 [-webkit-overflow-scrolling:touch]">
          {items[0] && <SalesSheet item={items[0]} />}

          {/* 1. House & tenant summary */}
          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Selected Homes ({items.length})
            </h3>
            <ul className="space-y-2">
              {items.map((item) => (
                <li
                  key={`${item.category}:${item.id}`}
                  className="flex items-start gap-3 rounded-2xl border border-border/70 bg-card p-3 shadow-2xs"
                >
                  {item.imageUrl ? (
                    <img src={item.imageUrl} alt={item.title} className="h-14 w-14 shrink-0 rounded-xl object-cover" />
                  ) : (
                    <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <Home className="h-6 w-6" />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm sm:text-base font-semibold text-foreground">{item.title}</p>
                    <Badge variant="outline" className="mt-1 rounded-full px-2 py-0 text-xs font-medium">
                      {categoryLabel(item.category)}
                    </Badge>
                    <p className="mt-1 break-words text-sm text-muted-foreground">{item.place}</p>
                    {item.tenantName ? (
                      <p className="mt-0.5 break-words text-sm text-foreground">Tenant: {item.tenantName}</p>
                    ) : null}
                    <p className="mt-1 text-base font-bold text-foreground">{formatDynamic(item.amount)}</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11 shrink-0 rounded-xl text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    aria-label={`Remove ${item.title}`}
                    onClick={() => onRemove(item)}
                  >
                    <Trash2 className="h-5 w-5" />
                  </Button>
                </li>
              ))}
            </ul>
          </section>

          {/* 2. Support amount / plan details */}
          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Plan details</h3>
            <div className="grid grid-cols-1 gap-2 min-[380px]:grid-cols-2">
              <div className="rounded-2xl bg-primary p-3.5 text-primary-foreground shadow-xs">
                <p className="text-xs font-semibold uppercase tracking-wider text-primary-foreground/75">Total Support</p>
                <p className="mt-1 break-words text-lg sm:text-xl font-bold tracking-tight">{formatDynamic(total)}</p>
              </div>
              <div className="rounded-2xl border border-border/70 bg-primary/5 p-3.5 shadow-2xs">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Monthly at 15%</p>
                <p className="mt-1 break-words text-lg sm:text-xl font-bold tracking-tight text-success">
                  {formatDynamic(monthlyAt15(total))}
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border/70 bg-muted/30 px-3.5 py-3 shadow-2xs min-[380px]:col-span-2">
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Available Balance</p>
                  <p className="mt-0.5 break-words text-base font-bold tracking-tight text-foreground">
                    {walletError || available === null ? 'Unavailable' : walletLoading ? 'Loading…' : formatDynamic(available)}
                  </p>
                </div>
                {shortfall !== null && (
                  <Badge
                    variant="outline"
                    className={cn(
                      'rounded-full border px-2.5 py-0.5 text-xs font-semibold shadow-2xs',
                      shortfall > 0
                        ? 'bg-warning/10 text-warning border-warning/30'
                        : 'bg-success/10 text-success border-success/30',
                    )}
                  >
                    {shortfall > 0 ? `${formatDynamic(shortfall)} short` : 'Fully covered'}
                  </Badge>
                )}
              </div>
            </div>
          </section>

          {/* 3. WhatsApp contacts */}
          {items.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">The people behind this home</h3>
              <div className="space-y-3">
                {items.map((item) => (
                  <HomeContacts key={`wa:${item.category}:${item.id}`} item={item} showTitle={items.length > 1} />
                ))}
              </div>
            </section>
          )}

          <div className="flex items-start gap-2.5 rounded-xl border border-border/60 bg-muted/30 p-3 text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="min-w-0 flex-1 text-sm leading-relaxed">
              Selecting and reviewing homes is planning only. Support starts after you confirm and the usual approval step is completed. Returns shown are estimates at the current 15% rate.
            </p>
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
  return `Help ${who} keep their home 🏠 Support their rent on Welile and earn 15% of the rent monthly for 12 months, with Welile's operational guarantee. See the plan: ${link}`;
}

export function buildWhatsAppShareUrl(message: string): string {
  return `https://wa.me/?text=${encodeURIComponent(message)}`;
}

const POINTS = [
  { icon: HandCoins, text: 'You support a tenant — you earn 15% of their rent.' },
  { icon: CalendarCheck, text: 'Support once, earn for 12 months.' },
  { icon: ShieldCheck, text: 'Welile provides an operational guarantee for every tenant you support.' },
];

const HOW_STEPS = [
  { icon: Wallet, text: 'Deposit to your Welile wallet' },
  { icon: TrendingUp, text: 'Tap Fund' },
  { icon: Send, text: 'Welile sends the money straight to the landlord.' },
];

function SalesSheet({ item }: { item: FunderNewSelectionItem }) {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const link = buildPlanShareLink(item, origin);
  const message = buildPlanShareMessage(item, link);
  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast.success('Link copied');
    } catch {
      toast.error('Could not copy the link');
    }
  };
  const nativeShare = async () => {
    try {
      await navigator.share({ title: 'Turn rent into an asset', text: message, url: link });
    } catch {
      /* user cancelled */
    }
  };

  return (
    <section className="space-y-6">
      <div className="aspect-video w-full overflow-hidden rounded-2xl bg-primary/10">
        {item.imageUrl ? (
          <img src={item.imageUrl} alt={item.title} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-primary">
            <Home className="h-12 w-12" />
            <span className="text-sm text-muted-foreground">Photo coming soon</span>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <h2 className="text-2xl font-bold tracking-tight">Turn rent into an asset</h2>
        <p className="text-base text-muted-foreground leading-relaxed">
          Support this tenant's rent once. Earn 15% of their rent every month for the next 12 months.
        </p>
      </div>

      <ul className="space-y-3">
        {POINTS.map((p) => (
          <li key={p.text} className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-success/15 text-success"><p.icon className="h-5 w-5" /></span>
            <span className="pt-1.5 text-base">{p.text}</span>
          </li>
        ))}
      </ul>

      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">How it works</h3>
        <ol className="space-y-2">
          {HOW_STEPS.map((step, i) => (
            <li key={step.text} className="flex items-center gap-3 rounded-2xl bg-muted/40 p-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">{i + 1}</span>
              <step.icon className="h-5 w-5 shrink-0 text-primary" />
              <span className="text-sm sm:text-base">{step.text}</span>
            </li>
          ))}
        </ol>
      </div>

      <SupportPlanExample fundingAmount={item.amount} />

      <div className="space-y-2">
        <a
          href={buildWhatsAppShareUrl(message)}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-success px-4 text-base font-semibold text-success-foreground shadow-sm hover:opacity-90"
        >
          <MessageCircle className="h-5 w-5" />
          Share on WhatsApp
        </a>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" className="h-11 rounded-xl text-sm" onClick={copyLink}>
            <Link2 className="h-4 w-4" />Copy link
          </Button>
          <Button variant="outline" className="h-11 rounded-xl text-sm" onClick={nativeShare} disabled={!canNativeShare}>
            <Share2 className="h-4 w-4" />Share
          </Button>
        </div>
      </div>
    </section>
  );
}
