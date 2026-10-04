import { useEffect, useRef, useState } from 'react';
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
import { Loader2, Send, Wheat, CheckCircle2, UserCheck, AlertCircle, Search, ArrowLeft, ArrowRight, Wallet, Copy, Hash, Minus, Plus, ArrowDownRight, Ticket, X, BadgePercent, Info } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useAvailableBalance } from '@/hooks/useAvailableBalance';
import { formatUGX } from '@/lib/rentCalculations';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import { broadcastBreadPriceChange } from '@/hooks/useBreadReceiptPrice';
import { applyCustomerWalletLedgerFilters, isCustomerWalletLedgerEntryVisible } from '@/lib/customerWalletHistory';

export const WELILE_BREAD_PRICE = 6500;
export const WELILE_BREAD_MAX_QTY = 50;
// 5% of any Welile receipt amount can be redeemed as a discount on the bread.
export const WELILE_BREAD_DISCOUNT_RATE = 0.05;
// We never let the bread go below this floor — keeps the transfer meaningful.
export const WELILE_BREAD_MIN_PAYABLE = 500;
const RECEIPT_STORAGE_KEY = 'welile.bread.receipt.v1';

interface BreadReceipt {
  number: string;
  amount: number;
  savedAt: number;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  availableBalance?: number;
  /**
   * Invoked when the user taps the "Top up" CTA on the zero-balance banner.
   * The dialog will close itself first so the parent can route to whatever
   * top-up surface it owns (e.g. the wallet sheet's Deposit flow).
   */
  onTopUp?: () => void;
}

interface ResolvedRecipient {
  id: string;
  full_name: string | null;
  phone: string | null;
}

type LookupState =
  | { status: 'idle' }
  | { status: 'searching' }
  | { status: 'found'; recipient: ResolvedRecipient }
  | { status: 'not_found' }
  | { status: 'self' }
  | { status: 'too_short' };

export function ShareBreadDialog({ open, onOpenChange, availableBalance, onTopUp }: Props) {
  const { user } = useAuth();
  const { profile } = useProfile();
  // Always derive a live, ledger-backed withdrawable inside the dialog so the
  // zero-balance gate stays accurate even if the parent's prop is stale
  // (e.g. after a top-up that posted to the ledger while this dialog was
  // mounted). Falls back to the prop on first paint.
  const { available: liveAvailable, refresh: refreshAvailable, loading: balanceLoading } = useAvailableBalance();
  const effectiveBalance =
    typeof liveAvailable === 'number' ? liveAvailable : availableBalance;
  const myLast9 = (profile?.phone ?? '').replace(/\D/g, '').slice(-9);
  const [step, setStep] = useState<'pick' | 'review'>('pick');
  const [phone, setPhone] = useState('');
  const [qty, setQty] = useState(1);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [lookup, setLookup] = useState<LookupState>({ status: 'idle' });
  const [reference, setReference] = useState<string | null>(null);

  // ===== Welile-Receipt discount (works offline) =====
  // The user can paste any Welile receipt number + amount they hold; 5% of
  // that amount is applied as a one-shot discount on the bread price. The
  // entry is cached in localStorage so it survives reloads / offline use.
  const [receiptNumber, setReceiptNumber] = useState('');
  const [receiptAmountInput, setReceiptAmountInput] = useState('');
  const [appliedReceipt, setAppliedReceipt] = useState<BreadReceipt | null>(null);
  const [receiptError, setReceiptError] = useState<string | null>(null);

  // Hydrate any previously-applied receipt when the dialog opens.
  useEffect(() => {
    if (!open) return;
    try {
      const raw = localStorage.getItem(RECEIPT_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as BreadReceipt;
      if (parsed?.number && typeof parsed.amount === 'number' && parsed.amount > 0) {
        setAppliedReceipt(parsed);
      }
    } catch {
      /* ignore corrupt cache */
    }
  }, [open]);

  const applyReceipt = () => {
    setReceiptError(null);
    const num = receiptNumber.trim();
    const amt = Number(receiptAmountInput.replace(/[,\s]/g, ''));
    if (num.length < 3) {
      setReceiptError('Enter the full receipt number');
      return;
    }
    if (!Number.isFinite(amt) || amt <= 0) {
      setReceiptError('Enter a valid receipt amount');
      return;
    }
    const next: BreadReceipt = { number: num, amount: amt, savedAt: Date.now() };
    setAppliedReceipt(next);
    setReceiptNumber('');
    setReceiptAmountInput('');
    try {
      localStorage.setItem(RECEIPT_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable — discount still applies in-memory */
    }
    broadcastBreadPriceChange();
    toast.success('Receipt applied', {
      description: `5% of ${formatUGX(amt)} = ${formatUGX(Math.round(amt * WELILE_BREAD_DISCOUNT_RATE))} off`,
      duration: 4000,
    });
  };

  const clearReceipt = () => {
    setAppliedReceipt(null);
    setReceiptError(null);
    try {
      localStorage.removeItem(RECEIPT_STORAGE_KEY);
    } catch {
      /* noop */
    }
    broadcastBreadPriceChange();
  };

  // Force a fresh withdrawable read every time the dialog opens. The hook
  // also live-subscribes to wallet/ledger changes, so a top-up that posts
  // while the dialog is open will automatically lift the zero-balance gate.
  useEffect(() => {
    if (open) void refreshAvailable();
  }, [open, refreshAvailable]);

  // Detect a withdrawable increase while the dialog is open (e.g. a top-up
  // landed in the ledger) and surface a receipt-style toast so the user
  // knows the zero-balance gate has been lifted in real time.
  //
  // Guards (so a single top-up never fires more than one toast):
  //  1. `prevBalanceRef` — last balance we observed; only `>` triggers.
  //  2. `lastToastBalanceRef` — the exact balance we last toasted for, so
  //     repeated re-renders with the same number stay silent even if the
  //     baseline ref gets perturbed.
  //  3. `lastToastAtRef` — short 1.5s cooldown that absorbs back-to-back
  //     ledger inserts belonging to the same top-up batch.
  const prevBalanceRef = useRef<number | null>(null);
  const lastToastBalanceRef = useRef<number | null>(null);
  const lastToastAtRef = useRef<number>(0);
  useEffect(() => {
    if (!open) {
      // Reset all baselines whenever the dialog closes so the next open
      // starts from a clean slate.
      prevBalanceRef.current = null;
      lastToastBalanceRef.current = null;
      lastToastAtRef.current = 0;
      return;
    }
    if (typeof effectiveBalance !== 'number') return;
    const prev = prevBalanceRef.current;
    if (prev !== null && effectiveBalance > prev) {
      const now = Date.now();
      const sameAsLastToast = lastToastBalanceRef.current === effectiveBalance;
      const withinCooldown = now - lastToastAtRef.current < 1500;
      if (!sameAsLastToast && !withinCooldown) {
        const delta = effectiveBalance - prev;
        toast.success('Wallet topped up', {
          description: `+${formatUGX(delta)} · New withdrawable: ${formatUGX(effectiveBalance)}`,
          duration: 5000,
        });
        lastToastBalanceRef.current = effectiveBalance;
        lastToastAtRef.current = now;
      }
    }
    prevBalanceRef.current = effectiveBalance;
  }, [open, effectiveBalance]);

  // Inline "Recent wallet changes" — last few cash-in entries (top-ups,
  // commissions, transfers in) so the user can see exactly which credit
  // lifted them out of zero balance. Re-fetched when the dialog opens and
  // whenever the live withdrawable changes (which already debounces against
  // wallet/ledger realtime events).
  type RecentCredit = {
    id: string;
    amount: number;
    category: string;
    description: string | null;
    transaction_date: string;
  };
  const [recentCredits, setRecentCredits] = useState<RecentCredit[]>([]);
  // Signature of the last fetched row set (sorted ledger ids joined). Used
  // to skip state updates when a rapid balance refresh returns the same
  // ledger rows we already have — prevents render churn and ensures no
  // duplicate visual flicker even if multiple realtime events fire in the
  // same tick.
  const lastCreditsSigRef = useRef<string>('');
  useEffect(() => {
    if (!open || !user) {
      if (!open) {
        setRecentCredits([]);
        lastCreditsSigRef.current = '';
      }
      return;
    }
    let cancelled = false;
    (async () => {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data } = await applyCustomerWalletLedgerFilters(supabase
        .from('general_ledger')
        .select('id, amount, category, description, transaction_date, classification, source_table, reference_id')
        .eq('user_id', user.id)
        .eq('direction', 'cash_in')
        .gte('transaction_date', since))
        .order('transaction_date', { ascending: false })
        .limit(3);
      if (cancelled) return;
      const next = ((data ?? []) as RecentCredit[]).filter(isCustomerWalletLedgerEntryVisible);
      // Compare against the previous fetch by ledger-id signature. If the
      // exact same rows came back (rapid back-to-back refreshes around a
      // single top-up batch), skip the setState entirely.
      const sig = next
        .map((r) => r.id)
        .slice()
        .sort()
        .join('|');
      if (sig === lastCreditsSigRef.current) return;
      lastCreditsSigRef.current = sig;
      setRecentCredits(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, user, effectiveBalance]);

  const formatRecentTime = (iso: string): string => {
    const d = new Date(iso);
    const diffMs = Date.now() - d.getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return d.toLocaleDateString();
  };
  const creditLabel = (c: RecentCredit): string => {
    const map: Record<string, string> = {
      wallet_deposit: 'Top-up',
      wallet_transfer: 'Rent Fees received',
      welile_bread: 'Rent Fees received',
      agent_commission: 'Commission',
      agent_commission_payout: 'Commission',
      referral_bonus: 'Referral bonus',
      roi_wallet_credit: 'Returns',
    };
    return map[c.category] || (c.description ? c.description : 'Wallet credit');
  };

  const reset = () => {
    setStep('pick');
    setPhone('');
    setQty(1);
    setSending(false);
    setSent(false);
    setLookup({ status: 'idle' });
    setReference(null);
  };

  // Debounced recipient lookup by phone (last 9 digits)
  useEffect(() => {
    const cleaned = phone.replace(/\D/g, '');
    if (cleaned.length === 0) {
      setLookup({ status: 'idle' });
      return;
    }
    if (cleaned.length < 9) {
      setLookup({ status: 'too_short' });
      return;
    }

    const last9 = cleaned.slice(-9);
    // Instant self-check — block before hitting the DB so the user gets
    // immediate feedback even on slow networks.
    if (myLast9 && last9 === myLast9) {
      setLookup({ status: 'self' });
      return;
    }
    setLookup({ status: 'searching' });
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, phone')
        .ilike('phone', `%${last9}`)
        .limit(1);
      if (cancelled) return;
      if (error || !data || data.length === 0) {
        setLookup({ status: 'not_found' });
        return;
      }
      const recipient = data[0] as ResolvedRecipient;
      if (user && recipient.id === user.id) {
        setLookup({ status: 'self' });
        return;
      }
      setLookup({ status: 'found', recipient });
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [phone, user, myLast9]);

  const handleSend = async () => {
    // Defensive guard — should be unreachable because the Send button is
    // disabled in the 'self' state, but if a user races the picker we
    // still refuse the transfer locally before the edge function runs.
    if (lookup.status === 'self') {
      toast.error("You can't send a Welile Rent Fees to your own wallet.");
      return;
    }
    if (lookup.status !== 'found') {
      toast.error('Pick a valid Welile recipient first');
      return;
    }
    if (!user) {
      toast.error('Please sign in');
      return;
    }
    // Final belt-and-suspenders self-check using the resolved recipient id.
    if (lookup.recipient.id === user.id) {
      toast.error("You can't send a Welile Rent Fees to your own wallet.");
      return;
    }
    // Refusing to send while we're still verifying the live withdrawable
    // prevents a stale zero-balance check from letting through (or blocking)
    // a transfer based on an outdated cached value.
    if (balanceLoading) {
      toast.error('Still verifying your wallet balance — try again in a moment.');
      return;
    }
    // Hard zero-balance gate: a user with zero (or unknown-but-non-positive)
    // withdrawable balance is never allowed to send a Welile Rent Fees.
    if (typeof effectiveBalance === 'number' && effectiveBalance <= 0) {
      toast.error("You can't send a Welile Rent Fees with zero withdrawable balance. Top up your wallet first.");
      return;
    }
    if (typeof effectiveBalance === 'number' && effectiveBalance < totalAmount) {
      toast.error(`Insufficient balance. You need ${formatUGX(totalAmount)}`);
      return;
    }

    setSending(true);
    try {
      const { data, error } = await supabase.functions.invoke('wallet-transfer', {
        body: {
          recipient_id: lookup.recipient.id,
          amount: totalAmount,
          // Canonical descriptions are set server-side for both legs so the
          // sender and receiver wallet statements stay consistent.
          transfer_kind: 'welile_bread',
          bread_qty: qty,
          description: appliedReceipt && discountAmount > 0
            ? `Welile Rent Fees x${qty} (${formatUGX(totalAmount)}) · receipt ${appliedReceipt.number} −${formatUGX(discountAmount)}`
            : `Welile Rent Fees x${qty} (${formatUGX(totalAmount)})`,
        },
      });
      if (error) throw error;
      const payload = (data ?? {}) as { error?: string; transfer_reference?: string; reference?: string };
      if (payload.error) throw new Error(payload.error);

      const ref =
        payload.transfer_reference ||
        payload.reference ||
        `WB-${Date.now().toString(36).toUpperCase()}`;
      setReference(ref);
      setSent(true);

      const name = lookup.recipient.full_name?.trim() || 'recipient';
      const shortRef = ref.slice(0, 8).toUpperCase();
      // Receipt-style toast
      toast.success(`🍞 ${qty > 1 ? `${qty} Welile Rent Fees` : 'Welile Rent Fees'} delivered`, {
        description:
          `${formatUGX(totalAmount)} → ${name}\n` +
          `Ref: ${shortRef}`,
        duration: 6000,
        action: {
          label: 'Copy ref',
          onClick: () => {
            navigator.clipboard?.writeText(ref).catch(() => {});
            toast.success('Reference copied');
          },
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to send Welile Rent Fees';
      // Receipt-style failure toast
      toast.error('Welile Rent Fees failed', {
        description: `${formatUGX(totalAmount)} · ${msg}`,
        duration: 7000,
      });
    } finally {
      setSending(false);
    }
  };

  const canSend = lookup.status === 'found' && !sending;
  const grossAmount = WELILE_BREAD_PRICE * qty;
  const rawDiscount = appliedReceipt
    ? Math.round(appliedReceipt.amount * WELILE_BREAD_DISCOUNT_RATE)
    : 0;
  // Cap the discount so the user always pays at least the floor.
  const discountAmount = Math.min(
    rawDiscount,
    Math.max(0, grossAmount - WELILE_BREAD_MIN_PAYABLE),
  );
  const totalAmount = Math.max(WELILE_BREAD_MIN_PAYABLE, grossAmount - discountAmount);
  // Hard zero-balance gate. Treat unknown balance as not-zero (don't lock the
  // user out if the parent never passed it). Once we know it's <= 0, ALL
  // sending paths are blocked.
  const zeroBalance =
    typeof effectiveBalance === 'number' && effectiveBalance <= 0;
  const insufficient =
    typeof effectiveBalance === 'number' && effectiveBalance < totalAmount;
  const balanceAfter =
    typeof effectiveBalance === 'number' ? effectiveBalance - totalAmount : null;

  const decQty = () => setQty((q) => Math.max(1, q - 1));
  const incQty = () => setQty((q) => Math.min(WELILE_BREAD_MAX_QTY, q + 1));

  // === Recipient display helpers ===
  // Keep these pure & self-contained so the same formatting is used in both
  // the picker card and the review card.
  const recipientFullName =
    lookup.status === 'found' ? lookup.recipient.full_name?.trim() || '' : '';
  const recipientFirstName =
    recipientFullName.split(/\s+/)[0] || 'Welile user';
  const recipientInitial = (recipientFirstName[0] || 'W').toUpperCase();

  // Format a Ugandan-style phone number into readable groups without ever
  // dropping digits. Falls back to the raw value if it doesn't look like a
  // 9–13 digit number so we never silently mangle international formats.
  const formatPhone = (raw?: string | null): string => {
    if (!raw) return '';
    const trimmed = raw.trim();
    const digits = trimmed.replace(/\D/g, '');
    if (digits.length < 9 || digits.length > 13) return trimmed;
    // Local 0XXXXXXXXX (10) → 0XXX XXX XXX
    if (digits.length === 10 && digits.startsWith('0')) {
      return `${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
    }
    // International 256XXXXXXXXX (12) → +256 XXX XXX XXX
    if (digits.length === 12 && digits.startsWith('256')) {
      return `+256 ${digits.slice(3, 6)} ${digits.slice(6, 9)} ${digits.slice(9)}`;
    }
    // Generic last-9 grouping → … XXX XXX XXX
    const last9 = digits.slice(-9);
    const prefix = digits.slice(0, digits.length - 9);
    const grouped = `${last9.slice(0, 3)} ${last9.slice(3, 6)} ${last9.slice(6)}`;
    return prefix ? `+${prefix} ${grouped}` : grouped;
  };
  const recipientPhoneFormatted =
    lookup.status === 'found'
      ? formatPhone(lookup.recipient.phone) || formatPhone(phone)
      : '';

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setTimeout(reset, 300);
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {step === 'review' && !sent && (
              <button
                type="button"
                onClick={() => setStep('pick')}
                className="-ml-1 p-1 rounded-md hover:bg-muted/50"
                aria-label="Back to recipient picker"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            <Wheat className="h-5 w-5 text-amber-600" />
            {sent ? 'Welile Rent Fees sent' : step === 'review' ? 'Confirm & Send' : 'Share Welile Rent Fees'}
          </DialogTitle>
          <DialogDescription>
            {sent
              ? 'Your Welile Rent Fees is on its way.'
              : step === 'review'
              ? 'Review the details below. This action is final once you tap Send.'
              : `Send fresh Welile Rent Fees (${formatUGX(WELILE_BREAD_PRICE)} each) to any Welile user.`}
          </DialogDescription>
        </DialogHeader>

        {sent ? (
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="flex flex-col items-center gap-3 py-6"
          >
            <CheckCircle2 className="h-14 w-14 text-success" />
            <p className="font-semibold">Welile Rent Fees delivered</p>
            <p className="text-sm text-muted-foreground text-center">
              {qty > 1
                ? `${qty} Welile Rent Fees (${formatUGX(totalAmount)})`
                : formatUGX(totalAmount)}{' '}
              has been credited to the recipient's wallet.
            </p>
            {reference && (
              <div className="w-full mt-2 rounded-xl border border-border bg-muted/40 px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Hash className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Transfer reference
                      </p>
                      <p className="text-xs font-mono font-semibold text-foreground truncate">
                        {reference}
                      </p>
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 shrink-0"
                    onClick={() => {
                      navigator.clipboard?.writeText(reference).catch(() => {});
                      toast.success('Reference copied');
                    }}
                  >
                    <Copy className="h-3.5 w-3.5 mr-1" />
                    Copy
                  </Button>
                </div>
              </div>
            )}
            <Button
              type="button"
              variant="outline"
              className="mt-2"
              onClick={() => {
                onOpenChange(false);
                setTimeout(reset, 300);
              }}
            >
              Done
            </Button>
          </motion.div>
        ) : step === 'pick' ? (
          <div className="space-y-4 pt-2">
            <div className="rounded-xl border border-amber-200 dark:border-amber-900/50 bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-950/30 dark:to-orange-950/30 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold text-amber-900/80 dark:text-amber-200/90 uppercase tracking-wider">Welile Rent Fees</p>
                  {discountAmount > 0 ? (
                    <>
                      <div className="flex items-baseline gap-2">
                        <p className="text-2xl sm:text-3xl font-extrabold text-emerald-700 dark:text-emerald-300 tabular-nums leading-tight drop-shadow-sm">
                          {formatUGX(totalAmount)}
                        </p>
                        <p className="text-sm font-semibold text-amber-900/60 dark:text-amber-200/60 line-through tabular-nums">
                          {formatUGX(grossAmount)}
                        </p>
                      </div>
                      <p className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300 mt-0.5 tabular-nums">
                        Receipt discount −{formatUGX(discountAmount)}
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-2xl sm:text-3xl font-extrabold text-amber-950 dark:text-amber-100 tabular-nums leading-tight drop-shadow-sm">
                        {formatUGX(totalAmount)}
                      </p>
                      <p className="text-xs font-medium text-amber-900/80 dark:text-amber-200/80 mt-0.5 tabular-nums">
                        {qty} × {formatUGX(WELILE_BREAD_PRICE)}
                      </p>
                    </>
                  )}
                </div>
                <span className="text-4xl" role="img" aria-label="bread">🍞</span>
              </div>
            </div>

            {/* === Welile Receipt → 5% bread discount (works offline) === */}
            <div className="rounded-xl border-2 border-emerald-300 dark:border-emerald-800 bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-950/40 dark:to-teal-950/40 p-3.5 shadow-sm">
              <div className="flex items-center gap-2 mb-2">
                <div className="h-7 w-7 rounded-lg bg-emerald-600 flex items-center justify-center shrink-0">
                  <BadgePercent className="h-4 w-4 text-white" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-emerald-950 dark:text-emerald-100 leading-tight">
                    Got a Welile receipt? Save 5%
                  </p>
                  <p className="text-[11px] text-emerald-900/80 dark:text-emerald-200/80 leading-tight">
                    One-shot: 5% of the receipt comes off your whole order, no matter how many breads.
                  </p>
                </div>
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      aria-label="How the discount is calculated"
                      className="h-7 w-7 rounded-full flex items-center justify-center text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/50 shrink-0"
                    >
                      <Info className="h-4 w-4" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    side="bottom"
                    align="end"
                    className="w-[280px] text-xs leading-relaxed space-y-2 border-emerald-300 dark:border-emerald-800"
                  >
                    <p className="font-bold text-sm text-emerald-900 dark:text-emerald-100">
                      How the 5% discount works
                    </p>
                    <ol className="list-decimal pl-4 space-y-1 text-foreground/90">
                      <li>
                        We take <span className="font-semibold">5%</span> of the receipt amount you entered.
                        E.g. {formatUGX(10000)} receipt → {formatUGX(500)} off.
                      </li>
                      <li>
                        That UGX amount is a <span className="font-semibold">one-shot</span> discount on the
                        whole order — it does <span className="italic">not</span> multiply by quantity.
                      </li>
                      <li>
                        So your <span className="font-semibold">effective per-bread price</span> =
                        (gross − discount) ÷ quantity. More breads spread the same discount over more units,
                        making each one cheaper.
                      </li>
                      <li>
                        Order total can never drop below {formatUGX(WELILE_BREAD_MIN_PAYABLE)}; any extra
                        discount is capped.
                      </li>
                    </ol>
                    <p className="text-[11px] text-muted-foreground pt-1 border-t border-border">
                      One receipt per order. Remove it any time with the ✕ button.
                    </p>
                  </PopoverContent>
                </Popover>
              </div>

              {appliedReceipt ? (
                <div className="rounded-lg bg-white/80 dark:bg-emerald-950/40 border border-emerald-300 dark:border-emerald-700 px-3 py-2.5 space-y-2">
                  <div className="flex items-center gap-2">
                    <Ticket className="h-4 w-4 text-emerald-700 dark:text-emerald-300 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-mono font-semibold text-emerald-950 dark:text-emerald-100 truncate">
                        {appliedReceipt.number}
                      </p>
                      <p className="text-[11px] text-emerald-800 dark:text-emerald-200 tabular-nums">
                        Receipt {formatUGX(appliedReceipt.amount)} · 5% = {formatUGX(rawDiscount)}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      onClick={clearReceipt}
                      aria-label="Remove receipt"
                      className="text-emerald-800 dark:text-emerald-200 hover:bg-emerald-100 dark:hover:bg-emerald-900/50"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>

                  {/* How the discount lands on the current quantity */}
                  <div className="rounded-md bg-emerald-100/70 dark:bg-emerald-900/40 px-2.5 py-2 text-[11px] tabular-nums space-y-1">
                    <div className="flex items-center justify-between text-emerald-900 dark:text-emerald-100">
                      <span>{qty} × {formatUGX(WELILE_BREAD_PRICE)}</span>
                      <span className="font-semibold">{formatUGX(grossAmount)}</span>
                    </div>
                    <div className="flex items-center justify-between text-emerald-800 dark:text-emerald-200">
                      <span>Receipt discount (one-shot)</span>
                      <span className="font-semibold">−{formatUGX(discountAmount)}</span>
                    </div>
                    <div className="border-t border-emerald-300/70 dark:border-emerald-700/70 my-0.5" />
                    <div className="flex items-center justify-between text-emerald-950 dark:text-emerald-50 font-bold">
                      <span>You pay</span>
                      <span>{formatUGX(totalAmount)}</span>
                    </div>
                    <div className="flex items-center justify-between text-[10px] text-emerald-800/80 dark:text-emerald-200/80 pt-0.5">
                      <span className="flex items-center gap-1">
                        Effective per bread
                        <Popover>
                          <PopoverTrigger asChild>
                            <button
                              type="button"
                              aria-label="Why per-bread price changes with quantity"
                              className="h-3.5 w-3.5 rounded-full flex items-center justify-center text-emerald-700 dark:text-emerald-300 hover:text-emerald-900 dark:hover:text-emerald-100"
                            >
                              <Info className="h-3 w-3" />
                            </button>
                          </PopoverTrigger>
                          <PopoverContent
                            side="top"
                            align="start"
                            className="w-[260px] text-xs leading-relaxed space-y-1.5 border-emerald-300 dark:border-emerald-800"
                          >
                            <p className="font-semibold text-emerald-900 dark:text-emerald-100">
                              Why this changes with quantity
                            </p>
                            <p className="text-foreground/90">
                              The {formatUGX(discountAmount)} discount is shared across all{' '}
                              <span className="font-semibold">{qty}</span> bread{qty > 1 ? 's' : ''}:
                            </p>
                            <p className="font-mono text-[11px] tabular-nums text-foreground bg-muted/60 rounded px-2 py-1">
                              ({formatUGX(grossAmount)} − {formatUGX(discountAmount)}) ÷ {qty} ={' '}
                              {formatUGX(Math.round(totalAmount / qty))}
                            </p>
                            <p className="text-[11px] text-muted-foreground">
                              Add more breads → same flat discount → lower price each.
                            </p>
                          </PopoverContent>
                        </Popover>
                      </span>
                      <span>
                        {formatUGX(Math.round(totalAmount / qty))}
                        {qty > 1 && (
                          <span className="text-emerald-700/70 dark:text-emerald-300/70">
                            {' '}(was {formatUGX(WELILE_BREAD_PRICE)})
                          </span>
                        )}
                      </span>
                    </div>
                  </div>

                  {discountAmount < rawDiscount ? (
                    <p className="text-[11px] font-medium text-amber-800 dark:text-amber-300 flex items-start gap-1 leading-snug">
                      <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
                      <span>
                        Discount capped — order can't go below {formatUGX(WELILE_BREAD_MIN_PAYABLE)}.
                        {qty < WELILE_BREAD_MAX_QTY && ' Add more breads to use the full 5%.'}
                      </span>
                    </p>
                  ) : (
                    <p className="text-[11px] text-emerald-800/90 dark:text-emerald-200/90 leading-snug">
                      Same {formatUGX(discountAmount)} off whether you send 1 or {WELILE_BREAD_MAX_QTY} breads — more breads, bigger per-bread saving.
                    </p>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label htmlFor="bread-receipt-num" className="text-[11px] font-semibold text-emerald-900 dark:text-emerald-200">
                        Receipt number
                      </Label>
                      <Input
                        id="bread-receipt-num"
                        type="text"
                        inputMode="text"
                        autoComplete="off"
                        placeholder="e.g. RCT-9821"
                        value={receiptNumber}
                        onChange={(e) => setReceiptNumber(e.target.value)}
                        className="h-9 mt-1 bg-card dark:bg-emerald-950/40 border-emerald-300 dark:border-emerald-700"
                        disabled={sending}
                      />
                    </div>
                    <div>
                      <Label htmlFor="bread-receipt-amt" className="text-[11px] font-semibold text-emerald-900 dark:text-emerald-200">
                        Receipt amount (UGX)
                      </Label>
                      <Input
                        id="bread-receipt-amt"
                        type="number"
                        inputMode="numeric"
                        min={1}
                        placeholder="e.g. 10000"
                        value={receiptAmountInput}
                        onChange={(e) => setReceiptAmountInput(e.target.value)}
                        className="h-9 mt-1 bg-card dark:bg-emerald-950/40 border-emerald-300 dark:border-emerald-700 tabular-nums"
                        disabled={sending}
                      />
                    </div>
                  </div>
                  {receiptError && (
                    <p className="text-[11px] font-medium text-destructive flex items-center gap-1">
                      <AlertCircle className="h-3 w-3" />
                      {receiptError}
                    </p>
                  )}
                  <Button
                    type="button"
                    onClick={applyReceipt}
                    disabled={sending || !receiptNumber.trim() || !receiptAmountInput.trim()}
                    className="w-full h-9 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold"
                  >
                    <BadgePercent className="h-4 w-4" />
                    Apply 5% discount
                  </Button>
                </div>
              )}
            </div>

            {/* Quantity stepper */}
            <div className="flex items-center justify-between rounded-xl border border-border bg-card p-3">
              <div>
                <p className="text-sm font-semibold text-foreground">How many breads?</p>
                <p className="text-[11px] text-muted-foreground">Up to {WELILE_BREAD_MAX_QTY} per send</p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-9 w-9"
                  onClick={decQty}
                  disabled={qty <= 1 || sending}
                  aria-label="Decrease quantity"
                >
                  <Minus className="h-4 w-4" />
                </Button>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={WELILE_BREAD_MAX_QTY}
                  value={qty}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10);
                    if (Number.isNaN(n)) {
                      setQty(1);
                      return;
                    }
                    setQty(Math.min(WELILE_BREAD_MAX_QTY, Math.max(1, n)));
                  }}
                  disabled={sending}
                  className="h-9 w-14 text-center font-semibold"
                  aria-label="Number of breads"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-9 w-9"
                  onClick={incQty}
                  disabled={qty >= WELILE_BREAD_MAX_QTY || sending}
                  aria-label="Increase quantity"
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="bread-phone">Recipient phone number</Label>
              <Input
                id="bread-phone"
                type="tel"
                inputMode="tel"
                placeholder="0700 000 000"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                disabled={sending}
                autoFocus
              />

              {/* Lookup status — single source of truth for who will receive the bread */}
              <div aria-live="polite" className="min-h-[44px]">
                {lookup.status === 'idle' && (
                  <p className="text-xs text-muted-foreground">
                    Recipient must have a Welile account.
                  </p>
                )}
                {lookup.status === 'too_short' && (
                  <p className="text-xs text-muted-foreground">
                    Keep typing the full phone number…
                  </p>
                )}
                {lookup.status === 'searching' && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Search className="h-3.5 w-3.5 animate-pulse" />
                    Looking up Welile user…
                  </div>
                )}
                {lookup.status === 'not_found' && (
                  <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                    <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span>No Welile user with this phone. Ask them to sign up first.</span>
                  </div>
                )}
                {lookup.status === 'self' && (
                  <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning-foreground">
                    <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span>
                      That's your own phone number. You can't send a Welile Rent Fees to yourself — pick a different recipient.
                    </span>
                  </div>
                )}
                {lookup.status === 'found' && (
                  <motion.div
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex items-start gap-3 rounded-xl border border-success/40 bg-success/5 px-3 py-2.5"
                  >
                    <div className="h-10 w-10 rounded-full bg-success/15 flex items-center justify-center shrink-0 relative">
                      <span className="text-sm font-bold text-success">
                        {recipientInitial}
                      </span>
                      <span className="absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full bg-success flex items-center justify-center ring-2 ring-background">
                        <UserCheck className="h-2.5 w-2.5 text-success-foreground" />
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-foreground leading-tight">
                        Sending to{' '}
                        <span className="text-success">{recipientFirstName}</span>
                      </p>
                      {recipientFullName && recipientFullName !== recipientFirstName && (
                        <p className="text-[11px] text-muted-foreground truncate">
                          {recipientFullName}
                        </p>
                      )}
                      <p className="text-xs font-mono font-medium text-foreground mt-0.5 break-all">
                        {recipientPhoneFormatted || 'Verified Welile account'}
                      </p>
                    </div>
                  </motion.div>
                )}
              </div>
            </div>

            {zeroBalance ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive">
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold">Your withdrawable balance is UGX 0</p>
                    <p className="opacity-80">
                      Top up your wallet to send a Welile Rent Fees.
                    </p>
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  className="mt-2.5 w-full h-9 gap-1.5"
                  onClick={() => {
                    // Close this dialog first, then hand off to the parent so
                    // the wallet/top-up surface owns the next step.
                    onOpenChange(false);
                    setTimeout(() => {
                      if (onTopUp) onTopUp();
                      else window.dispatchEvent(new CustomEvent('open-wallet-topup'));
                    }, 200);
                  }}
                >
                  <Wallet className="h-3.5 w-3.5" />
                  Top up wallet
                </Button>
              </div>
            ) : (
              typeof effectiveBalance === 'number' && (
                <p className="text-xs text-muted-foreground">
                  Your withdrawable balance:{' '}
                  <span className="font-semibold text-foreground">{formatUGX(effectiveBalance)}</span>
                </p>
              )
            )}

            {/* Recent wallet changes — last cash-in legs from the ledger so
                the user can see what credited their wallet most recently
                (top-up, commission, bread received). Hidden when there is
                nothing to show, to keep the dialog compact. */}
            {recentCredits.length > 0 && (
              <div className="rounded-xl border border-border bg-muted/40 px-3 py-2.5">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                  Recent wallet changes
                </p>
                <ul className="space-y-1">
                  {recentCredits.map((c) => (
                    <li
                      key={c.id}
                      className="flex items-center justify-between gap-2 text-xs"
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        <ArrowDownRight className="h-3.5 w-3.5 text-success shrink-0" />
                        <span className="text-foreground font-medium truncate">
                          {creditLabel(c)}
                        </span>
                        <span className="text-muted-foreground shrink-0">
                          · {formatRecentTime(c.transaction_date)}
                        </span>
                      </div>
                      <span className="font-semibold text-success shrink-0">
                        +{formatUGX(Number(c.amount) || 0)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <Button
              onClick={() => setStep('review')}
              disabled={lookup.status !== 'found' || zeroBalance || balanceLoading}
              className="w-full h-12 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white font-semibold gap-2"
            >
              {balanceLoading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Checking balance…
                </>
              ) : (
                <>
                  Continue to review
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </Button>
          </div>
        ) : (
          /* === REVIEW STEP === */
          <motion.div
            key="review"
            initial={{ opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            className="space-y-4 pt-2"
          >
            {/* Item summary */}
            <div className="rounded-xl border border-amber-200 dark:border-amber-900/50 bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-950/30 dark:to-orange-950/30 p-4">
              <div className="flex items-center gap-3">
                <span className="text-3xl" role="img" aria-label="bread">🍞</span>
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    {qty > 1 ? `${qty} Welile Rent Fees` : 'Welile Rent Fees'} · Fresh today
                  </p>
                  <div className="flex items-baseline gap-2">
                    <p className={`text-xl sm:text-2xl font-extrabold tabular-nums leading-tight ${discountAmount > 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-950 dark:text-amber-100'}`}>
                      {formatUGX(totalAmount)}
                    </p>
                    {discountAmount > 0 && (
                      <p className="text-xs font-semibold text-amber-900/60 dark:text-amber-200/60 line-through tabular-nums">
                        {formatUGX(grossAmount)}
                      </p>
                    )}
                  </div>
                  {qty > 1 && (
                    <p className="text-xs font-medium text-amber-900/80 dark:text-amber-200/80 tabular-nums">
                      {qty} × {formatUGX(WELILE_BREAD_PRICE)}
                    </p>
                  )}
                  {discountAmount > 0 && appliedReceipt && (
                    <p className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300 tabular-nums mt-0.5">
                      Receipt {appliedReceipt.number} −{formatUGX(discountAmount)}
                    </p>
                  )}
                </div>
              </div>
            </div>

            {/* Recipient row */}
            {lookup.status === 'found' && (
              <div className="rounded-xl border border-border bg-card p-3 sm:p-4">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                  Recipient
                </p>
                <div className="flex items-start gap-3">
                  <div className="h-11 w-11 rounded-full bg-success/15 flex items-center justify-center shrink-0 relative">
                    <span className="text-base font-bold text-success">
                      {recipientInitial}
                    </span>
                    <span className="absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full bg-success flex items-center justify-center ring-2 ring-card">
                      <UserCheck className="h-2.5 w-2.5 text-success-foreground" />
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    {/* First name takes the spotlight; full name (if longer) is shown as a small hint and is the only text allowed to truncate. */}
                    <p className="text-base font-bold text-foreground leading-tight">
                      {recipientFirstName}
                    </p>
                    {recipientFullName && recipientFullName !== recipientFirstName && (
                      <p className="text-[11px] text-muted-foreground truncate">
                        {recipientFullName}
                      </p>
                    )}
                    {/* Full phone — never truncated; wraps on narrow screens. */}
                    <p className="text-sm font-mono font-medium text-foreground mt-1 break-all">
                      {recipientPhoneFormatted || phone}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Balance impact */}
            <div className="rounded-xl border border-border bg-card p-3 space-y-2">
              <div className="flex items-center gap-2 mb-1">
                <Wallet className="h-4 w-4 text-muted-foreground" />
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Your wallet
                </p>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Withdrawable now</span>
                <span className="font-semibold text-foreground">
                  {typeof effectiveBalance === 'number' ? formatUGX(effectiveBalance) : '—'}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {qty > 1 ? `${qty} Welile Rent Fees` : 'Welile Rent Fees'} cost
                </span>
                <span className="font-semibold text-destructive">
                  − {formatUGX(totalAmount)}
                </span>
              </div>
              <div className="border-t border-border my-1" />
              <div className="flex items-center justify-between text-sm">
                <span className="text-foreground font-medium">Withdrawable after</span>
                <span
                  className={`font-bold ${
                    insufficient ? 'text-destructive' : 'text-success'
                  }`}
                >
                  {balanceAfter !== null ? formatUGX(Math.max(balanceAfter, 0)) : '—'}
                </span>
              </div>
            </div>

            {insufficient && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>
                  Not enough withdrawable balance. Top up your wallet to send a Welile Rent Fees.
                </span>
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <Button
                type="button"
                variant="outline"
                onClick={() => setStep('pick')}
                disabled={sending}
                className="flex-1 h-12"
              >
                <ArrowLeft className="h-4 w-4 mr-1" />
                Back
              </Button>
              <Button
                onClick={handleSend}
                disabled={!canSend || insufficient || zeroBalance || balanceLoading}
                className="flex-[2] h-12 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white font-semibold gap-2"
              >
                {sending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Sending…
                  </>
                ) : balanceLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Checking balance…
                  </>
                ) : (
                  <>
                    <Send className="h-4 w-4" />
                    Confirm & Send
                  </>
                )}
              </Button>
            </div>
          </motion.div>
        )}
      </DialogContent>
    </Dialog>
  );
}
