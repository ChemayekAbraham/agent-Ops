import { useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { BadgePercent, CheckCircle2, Hash, Wallet, X, WifiOff, ArrowLeft, Gift, Store, Copy, Ticket, Share2 } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { toast } from 'sonner';
import {
  PARTNER_SELLERS,
  createClaim,
  getActiveClaim,
  cancelClaim,
  buildShareUrl,
  type BreadClaim,
} from '@/lib/welileBreadClaims';
import { appendBreadReceiptHistory } from '@/hooks/useBreadReceiptPrice';

/**
 * WelileReceiptDialog
 *
 * The flagship tenant action: enter a Welile receipt number + amount from
 * any seller, redeem 5% of that amount as a discount on the daily bread.
 *
 * Designed to be ordinary-mind simple, mobile-first, and to work fully
 * offline — the applied receipt is cached in localStorage and survives
 * reloads and connectivity drops.
 */

export const WELILE_BREAD_PRICE = 6500;
export const WELILE_BREAD_DISCOUNT_RATE = 0.05;
export const WELILE_BREAD_MIN_PAYABLE = 500;
const RECEIPT_STORAGE_KEY = 'welile.bread.receipt.v1';
const LAST_SELLER_STORAGE_KEY = 'welile.bread.lastSeller.v1';
import { broadcastBreadPriceChange } from '@/hooks/useBreadReceiptPrice';

function emitReceiptChange() {
  broadcastBreadPriceChange();
}

interface BreadReceipt {
  number: string;
  amount: number;
  savedAt: number;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function WelileReceiptDialog({ open, onOpenChange }: Props) {
  const [receiptNumber, setReceiptNumber] = useState('');
  const [receiptAmountInput, setReceiptAmountInput] = useState('');
  const [applied, setApplied] = useState<BreadReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  // When non-null, the user has validated their entries and is being asked
  // to confirm before we persist + apply the 5% discount.
  const [pendingConfirm, setPendingConfirm] = useState<{
    number: string;
    amount: number;
  } | null>(null);
  // Seller chosen for the claim code (mall / bakery / supermarket).
  const [sellerId, setSellerId] = useState<string>(() => {
    if (typeof window === 'undefined') return PARTNER_SELLERS[0].id;
    try {
      const saved = localStorage.getItem(LAST_SELLER_STORAGE_KEY);
      if (saved && PARTNER_SELLERS.some((s) => s.id === saved)) return saved;
    } catch {
      /* ignore */
    }
    return PARTNER_SELLERS[0].id;
  });
  // Step gate: tenant must pick where the receipt is from BEFORE entering it.
  const [sellerLocked, setSellerLocked] = useState<boolean>(false);
  // Free-text search to make picking from a long partner list painless.
  const [sellerSearch, setSellerSearch] = useState('');
  // Active one-time claim code, if any.
  const [claim, setClaim] = useState<BreadClaim | null>(null);
  const [online, setOnline] = useState<boolean>(
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );

  // Hydrate cached receipt on open.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setPendingConfirm(null);
    setSellerSearch('');
    try {
      const raw = localStorage.getItem(RECEIPT_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as BreadReceipt;
      if (parsed?.number && typeof parsed.amount === 'number' && parsed.amount > 0) {
        setApplied(parsed);
      }
    } catch {
      /* ignore */
    }
    // Surface any still-active claim so the user can re-show the code.
    const active = getActiveClaim();
    setClaim(active);
    // If a claim is already active, keep its seller locked in.
    if (active) {
      setSellerId(active.sellerId);
      setSellerLocked(true);
    } else {
      // Pre-fill last selected seller (if any) but keep the picker step
      // visible so the tenant can confirm or change it.
      try {
        const saved = localStorage.getItem(LAST_SELLER_STORAGE_KEY);
        if (saved && PARTNER_SELLERS.some((s) => s.id === saved)) {
          setSellerId(saved);
        }
      } catch {
        /* ignore */
      }
      setSellerLocked(false);
    }
  }, [open]);

  // Remember the seller whenever the tenant changes the selection.
  useEffect(() => {
    if (!sellerId) return;
    try {
      localStorage.setItem(LAST_SELLER_STORAGE_KEY, sellerId);
    } catch {
      /* ignore */
    }
  }, [sellerId]);

  // Track connectivity for the offline badge.
  useEffect(() => {
    const onChange = () => setOnline(navigator.onLine);
    window.addEventListener('online', onChange);
    window.addEventListener('offline', onChange);
    return () => {
      window.removeEventListener('online', onChange);
      window.removeEventListener('offline', onChange);
    };
  }, []);

  const grossAmount = WELILE_BREAD_PRICE; // single bread reference price
  // Total redeemable credit from this receipt (5%). When credit ≥ one bread
  // price, the user earns whole free Rent Fees and any remainder rolls over to
  // the next bread they buy.
  const totalCredit = applied
    ? Math.round(applied.amount * WELILE_BREAD_DISCOUNT_RATE)
    : 0;
  const rollover = useMemo(() => {
    const freeBreads = Math.floor(totalCredit / grossAmount);
    const remainderCredit = totalCredit - freeBreads * grossAmount;
    // Remainder applied to the next bread, but never below the floor price.
    const nextBreadDiscount = Math.min(
      remainderCredit,
      Math.max(0, grossAmount - WELILE_BREAD_MIN_PAYABLE),
    );
    const nextBreadPrice = Math.max(
      WELILE_BREAD_MIN_PAYABLE,
      grossAmount - nextBreadDiscount,
    );
    return { freeBreads, remainderCredit, nextBreadDiscount, nextBreadPrice };
  }, [totalCredit, grossAmount]);
  // Back-compat for the existing single-bread headline.
  const discountAmount = rollover.freeBreads > 0
    ? grossAmount - WELILE_BREAD_MIN_PAYABLE === 0
      ? grossAmount
      : grossAmount - WELILE_BREAD_MIN_PAYABLE + 0 // not used when free Rent Fees exist
    : rollover.nextBreadDiscount;
  const reducedPrice = rollover.freeBreads > 0 ? 0 : rollover.nextBreadPrice;

  // Step 1 — validate inputs, then move to the confirmation panel.
  const reviewBeforeApply = () => {
    setError(null);
    const num = receiptNumber.trim();
    const amt = Number(receiptAmountInput.replace(/[,\s]/g, ''));
    if (num.length < 3) {
      setError('Enter the full receipt number');
      return;
    }
    if (!Number.isFinite(amt) || amt <= 0) {
      setError('Enter a valid receipt amount');
      return;
    }
    setPendingConfirm({ number: num, amount: amt });
  };

  // Step 2 — persist & apply once the user confirms.
  const confirmApply = () => {
    if (!pendingConfirm) return;
    const { number: num, amount: amt } = pendingConfirm;
    const next: BreadReceipt = { number: num, amount: amt, savedAt: Date.now() };
    setApplied(next);
    setReceiptNumber('');
    setReceiptAmountInput('');
    setPendingConfirm(null);
    try {
      localStorage.setItem(RECEIPT_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* offline-safe: discount still applies in-memory */
    }
    appendBreadReceiptHistory(next);
    emitReceiptChange();
    const credit = Math.round(amt * WELILE_BREAD_DISCOUNT_RATE);
    const free = Math.floor(credit / WELILE_BREAD_PRICE);
    const remainder = credit - free * WELILE_BREAD_PRICE;
    toast.success(
      free > 0 ? `${free}× free Rent Fees${free > 1 ? 's' : ''} earned` : 'Receipt applied',
      {
        description:
          free > 0
            ? `5% of ${formatUGX(amt)} = ${formatUGX(credit)} credit · ${formatUGX(remainder)} rolls to next bread`
            : `5% of ${formatUGX(amt)} = ${formatUGX(credit)} off`,
        duration: 4500,
      },
    );
  };

  const remove = () => {
    setApplied(null);
    setError(null);
    try {
      localStorage.removeItem(RECEIPT_STORAGE_KEY);
    } catch {
      /* noop */
    }
    emitReceiptChange();
    if (claim) {
      cancelClaim(claim.code);
      setClaim(null);
    }
  };

  const issueClaimCode = () => {
    if (!applied) return;
    try {
      const next = createClaim({
        receiptNumber: applied.number,
        receiptAmount: applied.amount,
        sellerId,
      });
      setClaim(next);
      toast.success('Claim code ready', {
        description: `Show ${next.code} at ${next.sellerName}`,
      });
    } catch (e) {
      toast.error('Could not create claim code');
    }
  };

  const copyCode = async () => {
    if (!claim) return;
    try {
      await navigator.clipboard.writeText(claim.code);
      toast.success('Code copied');
    } catch {
      /* noop */
    }
  };

  const cancelActiveClaim = () => {
    if (!claim) return;
    cancelClaim(claim.code);
    setClaim(null);
    toast.message('Claim code cancelled');
  };

  /**
   * Share the active claim with anyone (friend, family, neighbour) so
   * they can pick up the discounted/free Rent Fees at the chosen partner
   * store. Uses the native share sheet (WhatsApp, SMS, etc.) with a
   * clipboard fallback.
   */
  const shareClaim = async () => {
    if (!claim) return;
    const priceLine =
      claim.freeBreads > 0
        ? `${claim.freeBreads}× FREE bread 🍞`
        : `bread for only ${formatUGX(claim.payableForNext)} (was ${formatUGX(grossAmount)})`;
    const url = buildShareUrl(claim);
    const message =
      `🎁 I'm sending you bread on Welile!\n\n` +
      `Pick it up at: ${claim.sellerName}\n` +
      `Show this code at the till: ${claim.code}\n` +
      `You get: ${priceLine}\n\n` +
      `Open the link to view the code & store:\n${url}\n\n` +
      `Code expires in 30 minutes. No account needed — just walk in.`;
    try {
      if (typeof navigator !== 'undefined' && (navigator as any).share) {
        await (navigator as any).share({
          title: 'Free bread from Welile',
          text: message,
          url,
        });
        toast.success('Shared');
        return;
      }
      await navigator.clipboard.writeText(message);
      toast.success('Message copied — paste it to anyone');
    } catch {
      /* user dismissed share sheet — no error */
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-0 overflow-hidden gap-0">
        {/* Minimal header */}
        <DialogHeader className="px-5 pt-5 pb-3 border-b border-border">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-xl bg-emerald-600 text-white flex items-center justify-center shadow-sm">
              <BadgePercent className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-base font-semibold leading-tight">
                Welile Receipt
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground leading-snug">
                Save 5% on your Rent Fees with any receipt
              </DialogDescription>
            </div>
            {!online && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-amber-100 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200 text-[10px] font-semibold px-2 py-0.5"
                title="Works offline"
              >
                <WifiOff className="h-3 w-3" /> Offline
              </span>
            )}
          </div>
        </DialogHeader>

        <div className="px-5 py-5 space-y-5">
          {/* Price headline — always visible, before/after */}
          <div className="rounded-2xl border border-border bg-muted/40 p-4">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
              Today's Bread
            </p>
            <div className="mt-1 flex items-baseline gap-3 flex-wrap">
              {rollover.freeBreads > 0 ? (
                <>
                  <span className="text-3xl font-extrabold text-emerald-700 dark:text-emerald-400 tabular-nums">
                    FREE
                  </span>
                  <span className="text-sm line-through text-muted-foreground tabular-nums">
                    {formatUGX(grossAmount)}
                  </span>
                  <span className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-950/40 rounded-full px-2 py-0.5">
                    {rollover.freeBreads}× free Rent Fees
                  </span>
                </>
              ) : discountAmount > 0 ? (
                <>
                  <span className="text-3xl font-extrabold text-emerald-700 dark:text-emerald-400 tabular-nums">
                    {formatUGX(reducedPrice)}
                  </span>
                  <span className="text-sm line-through text-muted-foreground tabular-nums">
                    {formatUGX(grossAmount)}
                  </span>
                  <span className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-950/40 rounded-full px-2 py-0.5">
                    −{formatUGX(discountAmount)}
                  </span>
                </>
              ) : (
                <span className="text-3xl font-extrabold text-foreground tabular-nums">
                  {formatUGX(grossAmount)}
                </span>
              )}
            </div>
            {rollover.freeBreads > 0 && rollover.nextBreadDiscount > 0 && (
              <p className="mt-2 text-[11px] text-emerald-800 dark:text-emerald-300">
                Plus {formatUGX(rollover.nextBreadDiscount)} rolls over to your next bread
                ({formatUGX(rollover.nextBreadPrice)} instead of {formatUGX(grossAmount)}).
              </p>
            )}
          </div>

          {/* Applied receipt card OR confirmation panel OR input form */}
          {applied ? (
            <div className="rounded-2xl border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 p-4 space-y-3">
              <div className="flex items-start gap-3">
                {rollover.freeBreads > 0 ? (
                  <Gift className="h-5 w-5 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                ) : (
                  <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-emerald-900 dark:text-emerald-100">
                    {rollover.freeBreads > 0
                      ? `${rollover.freeBreads}× free Rent Fees${rollover.freeBreads > 1 ? 's' : ''} earned`
                      : 'Receipt applied'}
                  </p>
                  <p className="font-mono text-sm font-bold text-emerald-950 dark:text-emerald-50 truncate">
                    {applied.number}
                  </p>
                  <p className="text-[11px] text-emerald-800/80 dark:text-emerald-200/80 mt-0.5">
                    {formatUGX(applied.amount)} receipt · 5% = {formatUGX(totalCredit)} credit
                    {rollover.freeBreads > 0 && rollover.remainderCredit > 0 && (
                      <> · {formatUGX(rollover.remainderCredit)} rolls to next bread</>
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={remove}
                  className="h-8 w-8 rounded-full flex items-center justify-center text-emerald-800 dark:text-emerald-200 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 transition-colors"
                  aria-label="Remove receipt"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Claim-code section: pick where to redeem, then show the
                  one-time 6-digit code the seller will enter. */}
              {claim ? (
                <div className="rounded-xl bg-white dark:bg-emerald-950/50 border border-emerald-300 dark:border-emerald-800 p-4 space-y-3">
                  <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-emerald-800 dark:text-emerald-300">
                    <Ticket className="h-3.5 w-3.5" />
                    Show this code at the till
                  </div>
                  <div className="text-center select-all">
                    <div className="text-4xl font-extrabold tracking-[0.4em] text-emerald-700 dark:text-emerald-300 tabular-nums">
                      {claim.code}
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {claim.sellerName} · expires in 30 min
                    </p>
                  </div>
                  <div className="rounded-lg bg-emerald-100/60 dark:bg-emerald-900/40 p-2.5 text-[11px] text-emerald-900 dark:text-emerald-100 leading-snug text-center">
                    {claim.freeBreads > 0
                      ? `Cashier charges ${formatUGX(0)} — ${claim.freeBreads}× free Rent Fees`
                      : `Cashier charges ${formatUGX(claim.payableForNext)} (was ${formatUGX(grossAmount)})`}
                  </div>
                  <Button
                    type="button"
                    size="lg"
                    onClick={shareClaim}
                    className="w-full bg-emerald-600 hover:bg-emerald-700 text-white"
                  >
                    <Share2 className="h-4 w-4" />
                    Send this bread to someone
                  </Button>
                  <p className="text-[11px] text-center text-muted-foreground -mt-1">
                    They show the code at {claim.sellerName} — no account needed
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <Button type="button" variant="outline" size="lg" onClick={copyCode}>
                      <Copy className="h-4 w-4" />
                      Copy code
                    </Button>
                    <Button
                      type="button"
                      size="lg"
                      variant="outline"
                      onClick={cancelActiveClaim}
                    >
                      <X className="h-4 w-4" />
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <Label
                    htmlFor="welile-bread-seller"
                    className="text-xs font-semibold text-foreground inline-flex items-center gap-1.5"
                  >
                    <Store className="h-3.5 w-3.5" />
                    Where will you claim it?
                  </Label>
                  <select
                    id="welile-bread-seller"
                    value={sellerId}
                    onChange={(e) => setSellerId(e.target.value)}
                    className="w-full h-11 rounded-lg border border-input bg-background px-3 text-base"
                  >
                    {PARTNER_SELLERS.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} — {s.city}
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    onClick={issueClaimCode}
                    className="w-full bg-emerald-600 hover:bg-emerald-700 text-white"
                    size="lg"
                  >
                    <Ticket className="h-4 w-4" />
                    {rollover.freeBreads > 0
                      ? `Get claim code — ${rollover.freeBreads}× free Rent Fees`
                      : `Get claim code — pay ${formatUGX(reducedPrice)}`}
                  </Button>
                  <p className="text-[11px] text-center text-muted-foreground">
                    A one-time 6-digit code · works offline
                  </p>
                </div>
              )}
            </div>
          ) : pendingConfirm ? (
            (() => {
              const previewCredit = Math.round(
                pendingConfirm.amount * WELILE_BREAD_DISCOUNT_RATE,
              );
              const previewFree = Math.floor(previewCredit / grossAmount);
              const previewRemainder = previewCredit - previewFree * grossAmount;
              const previewNextDiscount = Math.min(
                previewRemainder,
                Math.max(0, grossAmount - WELILE_BREAD_MIN_PAYABLE),
              );
              const previewNextPrice = Math.max(
                WELILE_BREAD_MIN_PAYABLE,
                grossAmount - previewNextDiscount,
              );
              return (
                <div className="rounded-2xl border border-emerald-300 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/20 p-4 space-y-4">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-emerald-800 dark:text-emerald-300">
                      Confirm your receipt
                    </p>
                    <p className="text-xs text-emerald-900/80 dark:text-emerald-100/80 mt-0.5">
                      Please double-check before we apply your 5% credit.
                    </p>
                  </div>

                  <dl className="space-y-2 text-sm">
                    <div className="flex items-start justify-between gap-3">
                      <dt className="text-muted-foreground">Receipt number</dt>
                      <dd className="font-mono font-semibold text-foreground text-right break-all">
                        {pendingConfirm.number}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-muted-foreground">Receipt amount</dt>
                      <dd className="font-semibold text-foreground tabular-nums">
                        {formatUGX(pendingConfirm.amount)}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-muted-foreground">Total credit (5%)</dt>
                      <dd className="font-semibold text-emerald-700 dark:text-emerald-400 tabular-nums">
                        {formatUGX(previewCredit)}
                      </dd>
                    </div>
                    {previewFree > 0 && (
                      <div className="flex items-center justify-between gap-3">
                        <dt className="text-muted-foreground">Free Rent Fees</dt>
                        <dd className="font-semibold text-emerald-700 dark:text-emerald-400 tabular-nums">
                          {previewFree}× free
                        </dd>
                      </div>
                    )}
                    {previewNextDiscount > 0 && (
                      <div className="flex items-center justify-between gap-3">
                        <dt className="text-muted-foreground">Rolls to next bread</dt>
                        <dd className="font-semibold text-emerald-700 dark:text-emerald-400 tabular-nums">
                          −{formatUGX(previewNextDiscount)}
                        </dd>
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-3 pt-2 border-t border-emerald-200 dark:border-emerald-800">
                      <dt className="font-semibold text-foreground">
                        {previewFree > 0 ? 'Next bread you pay' : "You'll pay"}
                      </dt>
                      <dd className="text-lg font-extrabold text-emerald-700 dark:text-emerald-400 tabular-nums">
                        {formatUGX(previewNextPrice)}
                      </dd>
                    </div>
                  </dl>

                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setPendingConfirm(null)}
                      size="lg"
                    >
                      <ArrowLeft className="h-4 w-4" />
                      Edit
                    </Button>
                    <Button
                      type="button"
                      onClick={confirmApply}
                      className="bg-emerald-600 hover:bg-emerald-700 text-white"
                      size="lg"
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      Confirm
                    </Button>
                  </div>
                </div>
              );
            })()
          ) : !sellerLocked ? (
            (() => {
              const q = sellerSearch.trim().toLowerCase();
              const list = q
                ? PARTNER_SELLERS.filter(
                    (s) =>
                      s.name.toLowerCase().includes(q) ||
                      s.city.toLowerCase().includes(q) ||
                      s.type.toLowerCase().includes(q),
                  )
                : PARTNER_SELLERS;
              return (
                <div className="space-y-3">
                  <div className="space-y-1">
                    <Label className="text-xs font-semibold text-foreground inline-flex items-center gap-1.5">
                      <Store className="h-3.5 w-3.5" />
                      Where is your receipt from?
                    </Label>
                    <p className="text-[11px] text-muted-foreground">
                      Pick the mall, supermarket or bakery first — then we'll ask
                      for the receipt number.
                    </p>
                  </div>
                  <Input
                    value={sellerSearch}
                    onChange={(e) => setSellerSearch(e.target.value)}
                    placeholder="Search Victoria Mall, S&S, bakery…"
                    className="h-11 text-base"
                    inputMode="search"
                  />
                  <ul className="max-h-64 overflow-y-auto rounded-xl border border-border divide-y divide-border bg-card">
                    {list.length === 0 && (
                      <li className="px-4 py-6 text-center text-xs text-muted-foreground">
                        No partner found. Try another name.
                      </li>
                    )}
                    {list.map((s) => {
                      const active = s.id === sellerId;
                      return (
                        <li key={s.id}>
                          <button
                            type="button"
                            onClick={() => setSellerId(s.id)}
                            className={
                              'w-full flex items-center justify-between gap-3 px-4 py-3 text-left transition-colors ' +
                              (active
                                ? 'bg-emerald-50 dark:bg-emerald-950/40'
                                : 'hover:bg-muted/50')
                            }
                            aria-pressed={active}
                          >
                            <div className="min-w-0">
                              <p className="font-semibold text-sm truncate">
                                {s.name}
                              </p>
                              <p className="text-[11px] text-muted-foreground capitalize">
                                {s.type} · {s.city}
                              </p>
                            </div>
                            {active && (
                              <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0" />
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  <Button
                    type="button"
                    onClick={() => setSellerLocked(true)}
                    disabled={!sellerId}
                    className="w-full bg-emerald-600 hover:bg-emerald-700 text-white"
                    size="lg"
                  >
                    Continue with this seller
                  </Button>
                  <p className="text-[11px] text-center text-muted-foreground">
                    Step 1 of 2 · Pick seller, then enter receipt
                  </p>
                </div>
              );
            })()
          ) : (
            <div className="space-y-3">
              {/* Locked-in seller pill, with a tap-to-change action. */}
              {(() => {
                const seller = PARTNER_SELLERS.find((s) => s.id === sellerId);
                if (!seller) return null;
                return (
                  <div className="flex items-center justify-between gap-3 rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/20 px-3 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Store className="h-4 w-4 text-emerald-700 dark:text-emerald-300 shrink-0" />
                      <div className="min-w-0">
                        <p className="text-[10px] uppercase tracking-wider font-semibold text-emerald-700 dark:text-emerald-300">
                          Receipt from
                        </p>
                        <p className="text-sm font-semibold truncate">
                          {seller.name} — {seller.city}
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSellerLocked(false)}
                      className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300 underline underline-offset-2"
                    >
                      Change
                    </button>
                  </div>
                );
              })()}
              <div className="space-y-1.5">
                <Label
                  htmlFor="welile-receipt-number"
                  className="text-xs font-semibold text-foreground"
                >
                  Receipt number
                </Label>
                <div className="relative">
                  <Hash className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="welile-receipt-number"
                    value={receiptNumber}
                    onChange={(e) => setReceiptNumber(e.target.value)}
                    placeholder="e.g. RCT-12345"
                    className="pl-9 h-12 text-base font-mono"
                    inputMode="text"
                    autoFocus
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label
                  htmlFor="welile-receipt-amount"
                  className="text-xs font-semibold text-foreground"
                >
                  Receipt amount (UGX)
                </Label>
                <Input
                  id="welile-receipt-amount"
                  value={receiptAmountInput}
                  onChange={(e) => setReceiptAmountInput(e.target.value)}
                  placeholder="e.g. 10000"
                  className="h-12 text-base tabular-nums"
                  inputMode="numeric"
                />
                <p className="text-[11px] text-muted-foreground">
                  We take 5% of this as a discount on your Rent Fees.
                </p>
              </div>

              {error && (
                <p className="text-xs font-medium text-destructive" role="alert">
                  {error}
                </p>
              )}

              <Button
                type="button"
                onClick={reviewBeforeApply}
                disabled={!receiptNumber.trim() || !receiptAmountInput.trim()}
                className="w-full bg-emerald-600 hover:bg-emerald-700 text-white"
                size="lg"
              >
                <BadgePercent className="h-4 w-4" />
                Review discount
              </Button>

              <p className="text-[11px] text-center text-muted-foreground">
                Works offline · Saved on this device
              </p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
