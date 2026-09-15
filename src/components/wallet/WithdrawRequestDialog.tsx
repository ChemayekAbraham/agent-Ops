import { useState, useEffect, useRef } from 'react';
import { WithdrawalStepTracker } from './WithdrawalStepTracker';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ArrowDownToLine, Wallet, Loader2, CheckCircle, AlertCircle, Phone, Building2, Banknote, Clock, CheckCircle2, Sparkles, Shield, TrendingDown, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { UGANDA_BANKS } from '@/lib/ugandaBanks';
import { CashAgentSelector, type SelectedCashAgent } from './CashAgentSelector';
import { AlertTriangle } from 'lucide-react';
import { useWithdrawContext } from '@/hooks/useWithdrawContext';
import { Lock } from 'lucide-react';

interface WithdrawRequestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  walletBalance?: number;
  onSuccess?: () => void;
  prefillAmount?: number;
  prefillReason?: string;
  prefillPayout?: {
    payoutMode?: 'mtn' | 'airtel' | 'bank' | 'cash';
    momoNumber?: string;
    momoName?: string;
    bankName?: string;
    bankAccountName?: string;
    bankAccountNumber?: string;
  } | null;
  linkedParty?: string;
  lockAmount?: boolean;
  /**
   * Proxy payouts: the destination is dictated by the payment details saved on
   * the partner's portfolio, so the agent may READ but never RE-KEY it — same
   * treatment as `lockAmount`. Prevents a proxy agent substituting their own
   * (or any third party's) phone number for the partner's.
   */
  lockPayoutDetails?: boolean;
  /** Where the locked details came from, shown to the agent for confidence. */
  payoutSourceLabel?: string;
}

type PayoutMode = 'mtn' | 'airtel' | 'bank' | 'cash';

const WORKING_HOURS = { start: 8, end: 17, saturdayEnd: 13 };

const checkWorkingHours = (): { isOpen: boolean; message: string; nextOpen: string } => {
  // Withdrawals are now available 24/7
  return { isOpen: true, message: '', nextOpen: '' };
};

const PAYOUT_OPTIONS: { value: PayoutMode; label: string; sublabel: string; icon: string; accent: string; ring: string }[] = [
  { value: 'mtn', label: 'MTN', sublabel: 'MoMo', icon: '📱', accent: 'from-yellow-400/20 to-yellow-500/5 border-yellow-400/40', ring: 'ring-yellow-400' },
  { value: 'airtel', label: 'Airtel', sublabel: 'Money', icon: '📱', accent: 'from-red-400/20 to-red-500/5 border-red-400/40', ring: 'ring-red-400' },
  { value: 'bank', label: 'Bank', sublabel: 'Transfer', icon: '🏦', accent: 'from-blue-400/20 to-blue-500/5 border-blue-400/40', ring: 'ring-blue-400' },
  { value: 'cash', label: 'Cash', sublabel: 'Agent', icon: '💵', accent: 'from-emerald-400/20 to-emerald-500/5 border-emerald-400/40', ring: 'ring-emerald-400' },
];

import { formatDynamic } from '@/lib/currencyFormat';
const formatCurrency = formatDynamic;

// ─── Recipient session guard ──────────────────────────────────────────────
// Stops a single user from spamming Financial Ops with multiple identical
// pending withdrawals (e.g. five UGX 22,500 requests to the same MoMo
// number) by re-opening the dialog after a refresh, switching tabs, or
// just nervously tapping again. Layer 2 (the server trigger) is the real
// safety net; this layer just gives the user immediate, friendly feedback
// without a network round-trip.
const RECENT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const recentStorageKey = (userId: string) => `welile:withdraw:recent:${userId}`;
const ACTIVE_DUPLICATE_STATUSES = ['pending', 'requested', 'manager_approved', 'cfo_approved', 'processing'];

type RecentRecipientEntry = {
  amount: number;
  submittedAt: number; // ms epoch
  recipientLabel: string;
};

function readRecentRecipients(userId: string): Record<string, RecentRecipientEntry> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = sessionStorage.getItem(recentStorageKey(userId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, RecentRecipientEntry>;
    // Self-prune anything older than the window so the map doesn't grow
    // unbounded across long sessions.
    const cutoff = Date.now() - RECENT_WINDOW_MS;
    const cleaned: Record<string, RecentRecipientEntry> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v && typeof v.submittedAt === 'number' && v.submittedAt > cutoff) {
        cleaned[k] = v;
      }
    }
    return cleaned;
  } catch {
    return {};
  }
}

function writeRecentRecipient(
  userId: string,
  key: string,
  entry: RecentRecipientEntry,
): void {
  if (typeof window === 'undefined') return;
  try {
    const current = readRecentRecipients(userId);
    current[key] = entry;
    sessionStorage.setItem(recentStorageKey(userId), JSON.stringify(current));
  } catch {
    /* sessionStorage full / disabled — non-fatal */
  }
}

function deleteRecentRecipient(userId: string, key: string): void {
  if (typeof window === 'undefined') return;
  try {
    const current = readRecentRecipients(userId);
    delete current[key];
    sessionStorage.setItem(recentStorageKey(userId), JSON.stringify(current));
  } catch {
    /* sessionStorage full / disabled — non-fatal */
  }
}

function buildRecipientKey(args: {
  payoutMode: 'mtn' | 'airtel' | 'bank' | 'cash';
  momoNumber: string;
  bankName: string;
  bankAccountNumber: string;
}): { key: string; label: string } | null {
  const { payoutMode, momoNumber, bankName, bankAccountNumber } = args;
  if (payoutMode === 'mtn' || payoutMode === 'airtel') {
    const normalised = momoNumber.replace(/\D/g, '');
    if (!normalised) return null;
    return {
      key: `momo:${payoutMode}:${normalised}`,
      label: `${payoutMode.toUpperCase()} ${momoNumber.trim()}`,
    };
  }
  if (payoutMode === 'bank') {
    if (!bankAccountNumber.trim()) return null;
    return {
      key: `bank:${(bankName || '').toLowerCase()}:${bankAccountNumber.trim()}`,
      label: `${bankName || 'bank'} A/C ${bankAccountNumber.trim()}`,
    };
  }
  if (payoutMode === 'cash') {
    return { key: 'cash:Nearest Agent', label: 'Cash at agent' };
  }
  return null;
}

function formatRelativeMinutes(submittedAt: number): string {
  const minutes = Math.max(1, Math.round((Date.now() - submittedAt) / 60000));
  return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
}

// --- Pending idempotency key persistence -------------------------------
// The parent may unmount this dialog on close (or while refreshing), which
// would discard the in-flight `client_request_id` and let a nervous agent
// generate a brand-new key for what is really the SAME submission after a
// network error. Persist the in-flight key in sessionStorage keyed by
// (user, linkedParty) — same mechanism as the recipient session guard — so
// a close + reopen + resubmit replays the original key and collapses into
// one row via the (user_id, client_request_id) unique index.
const pendingKeyStorageKey = (userId: string, linkedParty: string) =>
  `welile:withdraw:pendingkey:${userId}:${linkedParty}`;

function readPendingClientRequestId(userId: string, linkedParty: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(pendingKeyStorageKey(userId, linkedParty));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { key: string; at: number };
    if (!parsed?.key || typeof parsed.at !== 'number') return null;
    if (Date.now() - parsed.at > RECENT_WINDOW_MS) return null;
    return parsed.key;
  } catch {
    return null;
  }
}

function writePendingClientRequestId(userId: string, linkedParty: string, key: string): void {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.setItem(
      pendingKeyStorageKey(userId, linkedParty),
      JSON.stringify({ key, at: Date.now() }),
    );
  } catch { /* non-fatal */ }
}

function clearPendingClientRequestId(userId: string, linkedParty: string): void {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.removeItem(pendingKeyStorageKey(userId, linkedParty));
  } catch { /* non-fatal */ }
}

// The proxy prefill reason carries a machine-readable route token
// ("| Route: portfolio <uuid>") stamped by ProxyPartnerFunds. Recover it so
// the server-side intent_key can pin to that portfolio's payout cycle, the
// same shape AgentProxyWithdrawalDialog sends. Falls back to a partner route,
// which compute_withdrawal_intent_key handles via its month-bucketed branch.
function derivePayoutRouteRef(reason: string, linkedParty: string): string {
  const match = /Route:\s*portfolio\s+([0-9a-fA-F-]{36})/.exec(reason || '');
  if (match) return `portfolio:${match[1]}`;
  return `partner:${linkedParty}`;
}

// Normalise a Ugandan MoMo number into the strict local 0XXXXXXXXX form the
// payout validator expects. Prefilled numbers (from portfolios / saved
// methods / profiles) come in many shapes — "+256 779 007902", "256779007902",
// "O754464086" (letter O), "070344565" (9 digits) — all of which fail the
// strict regex and silently swap the active Withdraw button for a greyed
// "Fill payout details" fallback. Normalising here keeps the button visible.
function normalizeUgMomoNumber(raw: string): string {
  if (!raw) return '';
  // Letter O/o → 0, then strip everything except digits and a leading +.
  let s = raw.replace(/[Oo]/g, '0').trim();
  s = s.replace(/[^\d+]/g, '');
  // Country-code forms → local 0-prefixed.
  if (s.startsWith('+256')) s = '0' + s.slice(4);
  else if (s.startsWith('256') && s.length >= 12) s = '0' + s.slice(3);
  // Bare 9-digit national number (missing leading 0) → prepend 0.
  if (/^[1-9]\d{8}$/.test(s)) s = '0' + s;
  return s;
}

export function WithdrawRequestDialog({ open, onOpenChange, walletBalance = 0, onSuccess, prefillAmount, prefillReason, prefillPayout, linkedParty, lockAmount = false, lockPayoutDetails = false, payoutSourceLabel }: WithdrawRequestDialogProps) {
  const { user } = useAuth();
  const [amount, setAmount] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [partnerName, setPartnerName] = useState<string | null>(null);
  const withdrawCtx = useWithdrawContext(user?.id);
  const withdrawalsPaused = withdrawCtx.gates.withdrawalsPaused;
  const { restrictedHeld } = withdrawCtx.wallet;
  const [workingHoursStatus, setWorkingHoursStatus] = useState(checkWorkingHours());
  const [pendingAmount, setPendingAmount] = useState(0);
  const isSubmittingRef = useRef(false);
  const clientRequestIdRef = useRef<string | null>(null);
  const amountSectionRef = useRef<HTMLDivElement | null>(null);
  const payoutSectionRef = useRef<HTMLDivElement | null>(null);
  const reasonSectionRef = useRef<HTMLDivElement | null>(null);
  const [pulseTarget, setPulseTarget] = useState<null | 'amount' | 'payout' | 'reason'>(null);

  const focusMissing = () => {
    let target: 'amount' | 'payout' | 'reason' | null = null;
    let node: HTMLDivElement | null = null;
    if (!payoutMode || !isPayoutValid()) { target = 'payout'; node = payoutSectionRef.current; }
    else if (reason.trim().length < 10) { target = 'reason'; node = reasonSectionRef.current; }
    else if (amount < 500) { target = 'amount'; node = amountSectionRef.current; }
    if (node) {
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setPulseTarget(target);
      setTimeout(() => setPulseTarget(null), 1600);
    }
  };

  const [payoutMode, setPayoutMode] = useState<PayoutMode | null>(null);
  const [momoNumber, setMomoNumber] = useState('');
  // Locked destination: only when the caller both asked for the lock AND
  // supplied the resolved details, so we never lock an empty form.
  const payoutLocked = lockPayoutDetails && !!prefillPayout;
  const [momoName, setMomoName] = useState('');
  const [bankName, setBankName] = useState('');
  const [bankAccountName, setBankAccountName] = useState('');
  const [bankAccountNumber, setBankAccountNumber] = useState('');
  const [reason, setReason] = useState('');
  const [activeDuplicate, setActiveDuplicate] = useState<RecentRecipientEntry | null>(null);
  const [selectedCashAgent, setSelectedCashAgent] = useState<SelectedCashAgent | null>(null);

  // Clear any chosen cash agent if the user switches payout method.
  useEffect(() => {
    if (payoutMode !== 'cash') setSelectedCashAgent(null);
  }, [payoutMode]);

  // Prefill from proxy partner funds
  useEffect(() => {
    if (open && prefillAmount && prefillAmount > 0) {
      setAmount(prefillAmount);
    }
    if (open && prefillReason) {
      setReason(prefillReason);
    }
  }, [open, prefillAmount, prefillReason]);

  // When opened with portfolio-attached payment details (proxy partner
  // withdrawal), pre-populate the destination so the agent doesn't re-key.
  useEffect(() => {
    if (!open || !prefillPayout) return;
    if (prefillPayout.payoutMode) setPayoutMode(prefillPayout.payoutMode);
    if (prefillPayout.momoNumber !== undefined) setMomoNumber(normalizeUgMomoNumber(prefillPayout.momoNumber));
    if (prefillPayout.momoName !== undefined) setMomoName(prefillPayout.momoName);
    if (prefillPayout.bankName !== undefined) setBankName(prefillPayout.bankName);
    if (prefillPayout.bankAccountName !== undefined) setBankAccountName(prefillPayout.bankAccountName);
    if (prefillPayout.bankAccountNumber !== undefined) setBankAccountNumber(prefillPayout.bankAccountNumber);
  }, [open, prefillPayout]);
  const [fetchingProfile, setFetchingProfile] = useState(false);

  useEffect(() => {
    if (open) setWorkingHoursStatus(checkWorkingHours());
  }, [open]);

  // Reset the confirmation gate whenever the dialog opens/closes.
  useEffect(() => {
    setConfirming(false);
  }, [open]);

  // Proxy mode: resolve who this withdrawal is actually for, so the agent sees
  // the partner's real name in the header and in the confirmation step.
  useEffect(() => {
    if (!open || !linkedParty) { setPartnerName(null); return; }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('profiles')
        .select('full_name')
        .eq('id', linkedParty)
        .maybeSingle();
      if (!cancelled) setPartnerName((data as any)?.full_name ?? null);
    })();
    return () => { cancelled = true; };
  }, [open, linkedParty]);

  // Restore any in-flight idempotency key for this partner on (re)open, so a
  // close-and-reopen after a network failure retries with the SAME key.
  useEffect(() => {
    if (!open || !user || !linkedParty) return;
    if (clientRequestIdRef.current) return;
    const pending = readPendingClientRequestId(user.id, linkedParty);
    if (pending) clientRequestIdRef.current = pending;
  }, [open, user, linkedParty]);

  // Fetch pending withdrawal amounts to prevent over-requesting
  useEffect(() => {
    const fetchPending = async () => {
      if (!user || !open) { setPendingAmount(0); return; }
      // For proxy-partner withdrawals (linkedParty set), the wallet balance
      // passed in is the per-partner ROI amount, NOT the agent's own wallet.
      // Subtracting unrelated pending wallet withdrawals would incorrectly
      // zero out the available balance. Skip the pending check here — the
      // per-partner balance is already authoritative.
      if (linkedParty) { setPendingAmount(0); return; }
      try {
        const { data } = await supabase
          .from('withdrawal_requests')
          .select('amount')
          .eq('user_id', user.id)
          .in('status', ['pending', 'requested', 'manager_approved']);
        const total = (data || []).reduce((sum: number, r: any) => sum + Number(r.amount), 0);
        setPendingAmount(total);
      } catch { setPendingAmount(0); }
    };
    fetchPending();
  }, [user, open, linkedParty]);


  useEffect(() => {
    const fetchSavedNumber = async () => {
      if (!user || !open) return;
      // If the caller pre-filled payout details (e.g. proxy partner withdraw
      // sourced from the portfolio's saved payment route), don't overwrite
      // them with the agent's own saved MoMo number.
      if (prefillPayout) return;
      setFetchingProfile(true);
      try {
        const { data: profile } = await supabase
          .from('profiles')
          .select('mobile_money_number, mobile_money_provider')
          .eq('id', user.id)
          .maybeSingle();
        if (profile?.mobile_money_number) {
          setMomoNumber(profile.mobile_money_number);
          const p = profile.mobile_money_provider as PayoutMode;
          if (p === 'mtn' || p === 'airtel') setPayoutMode(p);
        }
      } catch (error) {
        console.error('Error fetching profile:', error);
      } finally {
        setFetchingProfile(false);
      }
    };
    fetchSavedNumber();
  }, [user, open, prefillPayout]);

  const isPayoutValid = () => {
    if (!payoutMode) return false;
    if (payoutMode === 'mtn' || payoutMode === 'airtel') {
      const ugandaPhoneRegex = /^(0[0-9]{9}|\+256[0-9]{9})$/;
      return ugandaPhoneRegex.test(momoNumber.trim()) && momoName.trim().length >= 2;
    }
    if (payoutMode === 'bank')
      return !!bankName && bankAccountName.trim().length >= 2 && bankAccountNumber.trim().length >= 5;
    if (payoutMode === 'cash') return !!selectedCashAgent;
    return true;
  };

  // 100% of available wallet balance (incl. all commission earnings) is withdrawable.
  // Only constraint: telco-imposed UGX 500 minimum per transaction.
  const availableBalance = Math.max(0, walletBalance - pendingAmount);
  const meetsMinBalance = availableBalance >= 500;
  const isFormValid = meetsMinBalance && amount >= 500 && amount <= availableBalance && isPayoutValid() && reason.trim().length >= 10 && workingHoursStatus.isOpen;

  useEffect(() => {
    let cancelled = false;
    const verifyRecentRecipient = async () => {
      setActiveDuplicate(null);
      if (!open || !user || !payoutMode) return;
      const info = buildRecipientKey({ payoutMode, momoNumber, bankName, bankAccountNumber });
      if (!info) return;
      const recent = readRecentRecipients(user.id)[info.key];
      if (!recent || Date.now() - recent.submittedAt >= RECENT_WINDOW_MS) return;
      try {
        let query = supabase
          .from('withdrawal_requests')
          .select('id, amount, created_at')
          .eq('user_id', user.id)
          .eq('amount', recent.amount)
          .in('status', ACTIVE_DUPLICATE_STATUSES)
          .gte('created_at', new Date(recent.submittedAt - 60_000).toISOString())
          .limit(1);

        if (payoutMode === 'mtn' || payoutMode === 'airtel') {
          query = query
            .eq('mobile_money_provider', payoutMode)
            .eq('mobile_money_number', momoNumber.trim());
        } else if (payoutMode === 'bank') {
          query = query
            .eq('bank_name', bankName)
            .eq('bank_account_number', bankAccountNumber.trim());
        } else {
          query = query.eq('payout_method', 'cash');
        }

        const { data } = await query;
        if (cancelled) return;
        if ((data || []).length > 0) {
          setActiveDuplicate({ ...recent, recipientLabel: info.label });
        } else {
          deleteRecentRecipient(user.id, info.key);
        }
      } catch {
        if (!cancelled) setActiveDuplicate({ ...recent, recipientLabel: info.label });
      }
    };
    verifyRecentRecipient();
    return () => { cancelled = true; };
  }, [open, user, payoutMode, momoNumber, bankName, bankAccountNumber]);

  // Live look-up of the current recipient against the in-session map.
  // Drives the inline notice on the form so the user is warned BEFORE
  // they hit Submit. Recomputes whenever the recipient inputs change.
  const recentRecipientMatch = activeDuplicate;

  const handleSubmit = async () => {
    if (!user) { toast.error('Please log in first'); return; }
    // Re-entrant guard: prevent double-tap / rapid double submission
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;

    // Force a fresh read of the platform-wide gate (paused/frozen) right
    // before submitting — this dialog's cached copy can now live up to 5
    // minutes (see useWithdrawContext), so don't trust whatever was true
    // when the dialog opened. The actual balance check below already uses
    // the caller-supplied walletBalance prop, not this cache.
    const freshGates = await withdrawCtx.refetch();
    if (freshGates.data?.gates.withdrawalsPaused) {
      toast.error(freshGates.data.gates.blockReason ?? 'Withdrawals are currently paused');
      isSubmittingRef.current = false;
      return;
    }

    const currentStatus = checkWorkingHours();
    if (!currentStatus.isOpen) { toast.error(currentStatus.message); setWorkingHoursStatus(currentStatus); isSubmittingRef.current = false; return; }
    if (availableBalance < 500) { toast.error('Available balance must be at least UGX 500'); isSubmittingRef.current = false; return; }
    if (amount < 500) { toast.error('Minimum withdrawal is UGX 500'); isSubmittingRef.current = false; return; }
    if (amount > availableBalance) { toast.error(`Insufficient available balance. You have UGX ${pendingAmount.toLocaleString()} in pending withdrawals.`); isSubmittingRef.current = false; return; }
    if (!isPayoutValid()) { toast.error('Please complete payout details'); isSubmittingRef.current = false; return; }

    // ─── Recipient session guard ────────────────────────────────────────
    // Catches the "submit five identical withdrawals to the same number"
    // pattern before it ever hits the network. Server-side trigger
    // (`prevent_duplicate_pending_withdrawal`) is the real safety net for
    // cross-tab / cleared-storage attempts.
    const recipientInfo = buildRecipientKey({
      payoutMode: payoutMode as 'mtn' | 'airtel' | 'bank' | 'cash',
      momoNumber,
      bankName,
      bankAccountNumber,
    });
    if (recipientInfo) {
      const recent = readRecentRecipients(user.id);
      const existing = recent[recipientInfo.key];
      if (existing && activeDuplicate && Date.now() - existing.submittedAt < RECENT_WINDOW_MS) {
        const sameAmount = existing.amount === amount;
        if (sameAmount) {
          // Hard block — explicit confirm required.
          const proceed = window.confirm(
            `You already submitted UGX ${existing.amount.toLocaleString()} to ` +
              `${recipientInfo.label} ${formatRelativeMinutes(existing.submittedAt)}. ` +
              `That request is still waiting for operator approval.\n\n` +
              `Sending the same amount again will create a duplicate that operations may reject.\n\n` +
              `Tap OK only if you really mean to send another UGX ${amount.toLocaleString()} to the same recipient.`,
          );
          if (!proceed) {
            toast.info('Duplicate blocked — your earlier request is still pending.');
            isSubmittingRef.current = false;
            return;
          }
        } else {
          // Soft warn — different amount but same recipient very recently.
          const proceed = window.confirm(
            `You sent UGX ${existing.amount.toLocaleString()} to ` +
              `${recipientInfo.label} ${formatRelativeMinutes(existing.submittedAt)}.\n\n` +
              `Continue with this new UGX ${amount.toLocaleString()} request?`,
          );
          if (!proceed) {
            isSubmittingRef.current = false;
            return;
          }
        }
      }
    }

    setLoading(true);
    // Stable idempotency key for the lifetime of this submission attempt.
    // Reused across network retries so the DB unique index on (user_id, client_request_id)
    // collapses any duplicate inserts into a single row.
    if (!clientRequestIdRef.current) {
      clientRequestIdRef.current =
        (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    const clientRequestId = clientRequestIdRef.current;
    // Persist BEFORE the insert attempt so an unmount (network hang, dialog
    // closed by the user) can't lose the key.
    if (linkedParty) writePendingClientRequestId(user.id, linkedParty, clientRequestId);
    const MAX_RETRIES = 2;
    let lastError: any = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const isMomo = payoutMode === 'mtn' || payoutMode === 'airtel';
        // Proxy Partner Custody v2: when this dialog is opened on behalf of a
        // partner (linkedParty set), the row is partner-owned for visibility,
        // but approval resolves `agent_id` as the funding wallet and debits
        // the proxy agent only. NEVER set `linked_party` for new proxy rows —
        // that's the legacy v1 shape that pins the hold to the agent's wallet.
        const isProxy = !!linkedParty;
        let submittedWithdrawalId: string | null = null;
        const { data: insertedWithdrawal, error } = await supabase.from('withdrawal_requests').insert({
          user_id: isProxy ? linkedParty! : user.id,
          // The raiser is ALWAYS recorded. A blank raiser used to read as
          // "raised on someone else's behalf" in the creation-time
          // destination gate, silently skipping it for self-service rows.
          initiated_by: user.id,
          ...(isProxy
            ? {
                agent_id: user.id,
                beneficiary_id: linkedParty,
                proxy_partner_id: linkedParty,
                auto_dispatched: false,
              }
            : {}),
          amount,
          status: 'pending' as const,
          mobile_money_number: isMomo ? momoNumber.trim() : null,
          mobile_money_provider: isMomo ? payoutMode : null,
          mobile_money_name: isMomo ? momoName.trim() : null,
          payout_method: payoutMode === 'bank' ? 'bank_transfer' : payoutMode === 'cash' ? 'cash' : 'mobile_money',
          bank_name: payoutMode === 'bank' ? bankName : null,
          bank_account_name: payoutMode === 'bank' ? bankAccountName.trim() : null,
          bank_account_number: payoutMode === 'bank' ? bankAccountNumber.trim() : null,
          agent_location: payoutMode === 'cash'
            ? (selectedCashAgent
                ? [selectedCashAgent.agent_name, selectedCashAgent.district]
                    .filter(Boolean).join(' · ')
                : 'Nearest Agent')
            : null,
          preferred_cashout_agent_id: payoutMode === 'cash' ? (selectedCashAgent?.cashout_agent_id ?? null) : null,
          reason: isProxy
            ? `[Proxy initiated by agent ${user.id}] ${reason.trim()}`
            : reason.trim(),
          client_request_id: clientRequestId,
          payout_route_ref: isProxy && linkedParty
            ? derivePayoutRouteRef(reason, linkedParty)
            : null,
        } as any).select('id').maybeSingle();
        submittedWithdrawalId = insertedWithdrawal?.id ?? null;
        if (error) {
          // 23505 = unique_violation. Means a previous attempt already committed
          // this exact submission server-side. Treat as success.
          if ((error as any).code === '23505') {
            // Two distinct cases share this code:
            //   1. Idempotency key collision → genuine duplicate of *this*
            //      submission (network retry). Treat as success.
            //   2. Our `prevent_duplicate_pending_withdrawal` trigger fired
            //      → user already has another pending request for the same
            //      recipient + amount in the last 10 min. Block, surface a
            //      friendly message, and stop the success flow.
            const msg = String((error as any).message || '');
            if (msg.includes('DUPLICATE_PENDING_WITHDRAWAL')) {
              toast.error(
                `You just requested UGX ${amount.toLocaleString()} to this recipient a few minutes ago. ` +
                  `To avoid double payouts, wait about 15 minutes (or for the earlier request to be settled) ` +
                  `before requesting the same amount again.`,
                { duration: 8000 },
              );
              setLoading(false);
              isSubmittingRef.current = false;
              setConfirming(false);
              clientRequestIdRef.current = null;
              if (linkedParty) clearPendingClientRequestId(user.id, linkedParty);
              return;
            }
            console.info('[WithdrawRequestDialog] Duplicate suppressed by idempotency key');
            const { data: existingWithdrawal } = await supabase
              .from('withdrawal_requests')
              .select('id')
              .eq('client_request_id', clientRequestId)
              .maybeSingle();
            submittedWithdrawalId = existingWithdrawal?.id ?? null;
          } else {
            throw error;
          }
        }

        // No wallet deduction or ledger insert here — that happens at approval time
        // via the approve-withdrawal edge function (ledger-first architecture)

        // Don't overwrite the agent's saved MoMo on a proxy withdrawal —
        // those payout details belong to the partner.
        if (!isProxy && (payoutMode === 'mtn' || payoutMode === 'airtel')) {
          await supabase.from('profiles').update({ mobile_money_number: momoNumber.trim(), mobile_money_provider: payoutMode }).eq('id', user.id);
        }

        // NOTE: Returns Disbursement Confirmation email is NOT sent here.
        // It is sent by the `approve-withdrawal` edge function only after the
        // merchant agent confirms payment, so partners are never emailed for
        // a release/rejected/unconfirmed payout.

        if (!isProxy && submittedWithdrawalId) {
          const { error: smsError } = await supabase.functions.invoke('notify-withdrawal-submitted', {
            body: { withdrawal_id: submittedWithdrawalId },
          });
          if (smsError) {
            console.warn('[WithdrawRequestDialog] Withdrawal submission SMS failed:', smsError);
          }
        }

        setSuccess(true);
        toast.success('Withdrawal request submitted! 🎉');
        onSuccess?.();
        // Record this recipient in the session map so a re-open within
        // 10 minutes triggers the guard above.
        if (recipientInfo) {
          writeRecentRecipient(user.id, recipientInfo.key, {
            amount,
            submittedAt: Date.now(),
            recipientLabel: recipientInfo.label,
          });
        }
        setLoading(false);
        isSubmittingRef.current = false;
        clientRequestIdRef.current = null;
        if (linkedParty) clearPendingClientRequestId(user.id, linkedParty);
        return;
      } catch (error: any) {
        lastError = error;
        const isNetworkError = error instanceof TypeError && error.message === 'Failed to fetch';
        if (isNetworkError && attempt < MAX_RETRIES - 1) {
          await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 1000));
          continue;
        }
        break;
      }
    }

    console.error('Error submitting withdrawal request:', lastError);
    const isNetworkError = lastError instanceof TypeError && lastError.message === 'Failed to fetch';
    toast.error(isNetworkError ? 'Network error — check your internet and try again' : (lastError?.message || 'Failed to submit request'));
    setLoading(false);
    isSubmittingRef.current = false;
    // Keep clientRequestIdRef so a manual retry by the user re-uses the same key
    setConfirming(false);
  };

  const handleClose = () => {
    setAmount(0);
    setReason('');
    setSuccess(false);
    setConfirming(false);
    setSelectedCashAgent(null);
    onOpenChange(false);
  };

  const selectedOption = PAYOUT_OPTIONS.find(o => o.value === payoutMode);
  const isProxyMode = !!linkedParty;
  const recipientLabel = partnerName || 'this partner';
  // Same destination facts as the transfer preview card, shown in full for confirmation.
  const maskTail = (v: string) => v || '';
  const destinationLine = (payoutMode === 'mtn' || payoutMode === 'airtel')
    ? `${selectedOption?.label ?? 'Mobile Money'} · ${maskTail(momoNumber.trim())}`
    : payoutMode === 'bank'
      ? `${bankName || 'Bank'} · ${maskTail(bankAccountNumber.trim())}`
      : payoutMode === 'cash'
        ? `Cash · ${selectedCashAgent?.agent_name || 'Cash at agent'}`
        : '—';

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md max-h-[92vh] overflow-y-auto p-0 border-0 bg-transparent shadow-2xl" stable>
        {/* Gradient header */}
        <div className="relative overflow-hidden rounded-t-xl bg-gradient-to-br from-primary via-primary/90 to-primary/70 px-6 pt-6 pb-5">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-white/10 via-transparent to-transparent" />
          <div className="absolute -top-10 -right-10 w-40 h-40 rounded-full bg-white/5 blur-2xl" />
          <div className="absolute -bottom-8 -left-8 w-32 h-32 rounded-full bg-white/5 blur-xl" />
          
          <DialogHeader className="relative z-10">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-white/15 backdrop-blur-sm">
                <ArrowDownToLine className="h-5 w-5 text-white" />
              </div>
              <div>
                <DialogTitle className="text-white text-lg font-bold tracking-tight">
                  {isProxyMode ? `Withdraw for ${recipientLabel}` : 'Withdraw Money'}
                </DialogTitle>
                <p className="text-white/70 text-xs mt-0.5">Fast · Secure · Instant notifications</p>
              </div>
            </div>
          </DialogHeader>

          {/* Balance pill */}
          <div
            className="relative z-10 mt-4 flex items-center justify-between p-3 rounded-xl bg-white/10 backdrop-blur-md border border-white/20 animate-fade-in"
          >
            <div className="flex items-center gap-2">
              <Wallet className="h-4 w-4 text-white/80" />
              <span className="text-white/70 text-xs font-medium">Available Balance</span>
            </div>
            <div className="text-right">
              <span className="text-white text-xl font-black tracking-tight">{formatCurrency(availableBalance)}</span>
              {pendingAmount > 0 && (
                <p className="text-white/50 text-[10px]">{formatCurrency(pendingAmount)} pending</p>
              )}
            </div>
          </div>
        </div>

        {/* Content area */}
        <div className="bg-background rounded-b-xl px-5 pb-6 pt-5 space-y-5">
          {withdrawalsPaused ? (
            <div className="py-6 space-y-4 animate-fade-in">
              <div className="mx-auto w-16 h-16 rounded-full bg-amber-500/15 flex items-center justify-center">
                <AlertTriangle className="h-8 w-8 text-amber-500" />
              </div>
              <div className="text-center space-y-2">
                <h3 className="text-lg font-bold text-foreground">Withdrawals Temporarily Paused</h3>
                <p className="text-sm text-muted-foreground">
                  Wallet withdrawals are currently disabled while our team completes a scheduled review.
                  Your balance is safe and rent collection, deposits, and transfers continue as normal.
                </p>
                <p className="text-xs text-muted-foreground">
                  Please try again shortly — we'll reopen withdrawals as soon as the review is complete.
                </p>
              </div>
              <Button className="w-full" variant="outline" onClick={handleClose}>
                Close
              </Button>
            </div>
          ) : success ? (
            <div className="space-y-5 py-2 animate-scale-in">
              <div className="text-center space-y-3">
                <div className="mx-auto w-20 h-20 rounded-full bg-gradient-to-br from-success/20 to-success/5 flex items-center justify-center animate-scale-in">
                  <CheckCircle className="h-10 w-10 text-success" />
                </div>
                <div className="animate-fade-in">
                  <h3 className="text-xl font-bold text-foreground">Request Submitted!</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    We're processing <strong className="text-foreground">{formatCurrency(amount)}</strong>
                  </p>
                </div>
              </div>

              <div className="p-4 rounded-2xl border border-border bg-muted/30 text-center animate-fade-in">
                <p className="text-sm text-muted-foreground">
                  ⏳ Awaiting approval — you'll be notified once it's processed. Thank you for your patience!
                </p>
              </div>

              <Button onClick={handleClose} className="w-full h-12 rounded-xl text-base font-bold">
                Done
              </Button>
            </div>
          ) : confirming ? (
            <div className="space-y-5 py-2 animate-scale-in">
              <div className="text-center space-y-1">
                <h3 className="text-lg font-bold text-foreground">Confirm this withdrawal</h3>
                <p className="text-xs text-muted-foreground">
                  Check the amount and the recipient before sending.
                </p>
              </div>

              <div className="p-4 rounded-2xl border border-primary/20 bg-primary/5 text-center space-y-2">
                <p className="text-3xl font-black text-primary tracking-tight">{formatCurrency(amount)}</p>
                <p className="text-sm font-semibold text-foreground">to {recipientLabel}</p>
                <p className="text-xs text-muted-foreground">via {destinationLine}</p>
              </div>

              <div className="p-3 rounded-xl bg-warning/10 border border-warning/20 text-[11px] text-muted-foreground">
                ⚠️ This moves <strong className="text-foreground">{recipientLabel}</strong>'s money on their behalf.
                Once sent, it goes to Financial Ops for approval.
              </div>

              <div className="flex gap-3">
                <Button
                  variant="outline"
                  onClick={() => setConfirming(false)}
                  disabled={loading}
                  className="flex-1 h-12 rounded-xl font-bold border-border/50"
                >
                  Go back
                </Button>
                <Button
                  onClick={handleSubmit}
                  disabled={loading}
                  className="flex-1 gap-2 h-12 rounded-xl font-bold bg-gradient-to-r from-primary to-primary/80 shadow-lg shadow-primary/20"
                >
                  {loading ? (
                    <><Loader2 className="h-4 w-4 animate-spin" /> Processing…</>
                  ) : (
                    <><ArrowDownToLine className="h-4 w-4" /> Confirm &amp; Send</>
                  )}
                </Button>
              </div>
            </div>
          ) : (
            <>
              {/* Alerts */}
              {!workingHoursStatus.isOpen && (
                <div className="p-4 rounded-2xl bg-warning/10 border border-warning/20 space-y-1.5 animate-fade-in">
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-warning shrink-0" />
                    <p className="text-sm font-bold text-foreground">Outside Working Hours</p>
                  </div>
                  <p className="text-xs text-muted-foreground">{workingHoursStatus.message}</p>
                  <p className="text-xs">Next: <strong className="text-foreground">{workingHoursStatus.nextOpen}</strong></p>
                  <p className="text-[10px] text-muted-foreground/60 pt-1 border-t border-warning/10">🕐 Mon–Fri 8AM–5PM · Sat 8AM–1PM EAT</p>
                </div>
              )}


              {!meetsMinBalance && (
                <div className="flex items-start gap-3 p-4 rounded-2xl bg-destructive/10 border border-destructive/20">
                  <TrendingDown className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-bold text-foreground">Insufficient available balance</p>
                    <p className="text-xs text-muted-foreground">You need at least <strong>UGX 500</strong> available to withdraw</p>
                  </div>
                </div>
              )}

              {restrictedHeld > 0 && (
                <div className="flex items-start gap-3 p-4 rounded-2xl bg-warning/10 border border-warning/30">
                  <Lock className="h-5 w-5 text-warning shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <p className="text-sm font-bold text-foreground">
                      {formatCurrency(restrictedHeld)} held from bonus earnings
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Referral, listing and registration bonuses unlock only after your invitee posts a rent request, or has a house / landlord / LC1 verified — within 3 days of the bonus. Un-matured amounts expire after 3 days.
                    </p>
                  </div>
                </div>
              )}

              {/* ── PAYOUT METHOD ── */}
              <div
                ref={payoutSectionRef}
                className={`space-y-3 rounded-2xl transition-shadow ${pulseTarget === 'payout' ? 'ring-4 ring-primary/40 ring-offset-2 ring-offset-background' : ''}`}
              >
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-primary" />
                  <Label className="text-sm font-bold text-foreground">
                    {payoutLocked ? 'Where this money goes' : 'Where should we send your money?'}
                  </Label>
                </div>
                {payoutLocked && (
                  <div className="flex items-start gap-2 p-3 rounded-xl bg-primary/5 border border-primary/20">
                    <Lock className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                    <p className="text-[11px] text-muted-foreground leading-snug">
                      These payment details come from {payoutSourceLabel || 'the saved payment details'} and cannot be
                      changed here — just like the amount. To correct them, ask Partner Ops to update the saved
                      payment details first.
                    </p>
                  </div>
                )}
                <div className="grid grid-cols-4 gap-2.5">
                  {PAYOUT_OPTIONS.map((opt, i) => {
                    const selected = payoutMode === opt.value;
                    if (payoutLocked && !selected) return null;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        disabled={payoutLocked}
                        onClick={() => { if (payoutLocked) return; setPayoutMode(prev => prev === opt.value ? null : opt.value); }}
                        className={`relative flex flex-col items-center justify-center rounded-2xl border-2 p-3 min-h-[80px] transition-all touch-manipulation ${payoutLocked ? 'cursor-default' : 'active:scale-95'} ${
                          selected
                            ? `bg-gradient-to-b ${opt.accent} ${opt.ring} ring-2 shadow-lg`
                            : 'border-border bg-card hover:border-muted-foreground/30 hover:shadow-sm'
                        }`}
                      >
                        {selected && (
                          <div className="absolute -top-1 -right-1 animate-scale-in">
                            <CheckCircle2 className="h-4 w-4 text-primary drop-shadow-sm" />
                          </div>
                        )}
                        <span className="text-2xl leading-none">{opt.icon}</span>
                        <span className="text-[11px] font-bold mt-1.5 text-foreground">{opt.label}</span>
                        <span className="text-[9px] text-muted-foreground leading-none">{opt.sublabel}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* ── INLINE PAYOUT DETAILS ── */}
              {payoutMode && (
                <div className="animate-fade-in">
                    <div className="space-y-3 p-4 rounded-2xl bg-muted/30 border border-border/50">
                      <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
                        {selectedOption?.label} Details
                      </p>

                      {recentRecipientMatch && (
                        <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50">
                          <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                          <div className="text-[11px] leading-snug text-amber-900 dark:text-amber-200">
                            <p className="font-semibold">
                              You already sent UGX {recentRecipientMatch.amount.toLocaleString()} to {recentRecipientMatch.recipientLabel} {formatRelativeMinutes(recentRecipientMatch.submittedAt)}.
                            </p>
                            <p className="opacity-90 mt-0.5">
                              That request is still pending operator approval. Re-submitting may create a duplicate.
                            </p>
                          </div>
                        </div>
                      )}

                      {(payoutMode === 'mtn' || payoutMode === 'airtel') && (
                        <>
                          <div className="space-y-1.5">
                            <Label className="text-xs font-semibold text-foreground">
                              {payoutMode === 'mtn' ? 'MTN' : 'Airtel'} Number
                            </Label>
                            <div className="relative">
                              <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                              <Input
                                type="tel"
                                inputMode="tel"
                                placeholder="e.g. 0770 123 456"
                                value={momoNumber}
                                onChange={(e) => { if (payoutLocked) return; setMomoNumber(e.target.value); }}
                                readOnly={payoutLocked}
                                className={`h-12 pl-10 rounded-xl text-base font-medium ${payoutLocked ? 'bg-muted/60 cursor-not-allowed' : ''}`}
                                disabled={fetchingProfile}
                              />
                            </div>
                            {payoutLocked && (
                              <p className="text-[10px] text-muted-foreground">Locked to the partner's saved number.</p>
                            )}
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs font-semibold text-foreground">Registered Name</Label>
                            <Input
                              placeholder="As it appears on MoMo"
                              value={momoName}
                              onChange={(e) => { if (payoutLocked) return; setMomoName(e.target.value); }}
                              readOnly={payoutLocked}
                              className={`h-12 rounded-xl text-base font-medium ${payoutLocked ? 'bg-muted/60 cursor-not-allowed' : ''}`}
                            />
                          </div>
                        </>
                      )}

                      {payoutMode === 'bank' && (
                        <>
                          <div className="space-y-1.5">
                            <Label className="text-xs font-semibold text-foreground">Bank</Label>
                            <Select value={bankName} onValueChange={(v) => { if (payoutLocked) return; setBankName(v); }} disabled={payoutLocked}>
                              <SelectTrigger className={`h-12 rounded-xl ${payoutLocked ? 'bg-muted/60' : ''}`}>
                                <SelectValue placeholder="Select your bank…" />
                              </SelectTrigger>
                              <SelectContent className="max-h-60 z-[200]" position="popper" sideOffset={4}>
                                {UGANDA_BANKS.map((b) => (
                                  <SelectItem key={b} value={b}>{b}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs font-semibold text-foreground">Account Holder</Label>
                            <div className="relative">
                              <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                              <Input
                                placeholder="Full name on account"
                                value={bankAccountName}
                                onChange={(e) => { if (payoutLocked) return; setBankAccountName(e.target.value); }}
                                readOnly={payoutLocked}
                                className={`h-12 pl-10 rounded-xl text-base font-medium ${payoutLocked ? 'bg-muted/60 cursor-not-allowed' : ''}`}
                              />
                            </div>
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs font-semibold text-foreground">Account Number</Label>
                            <div className="relative">
                              <Banknote className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                              <Input
                                placeholder="e.g. 9030012345678"
                                value={bankAccountNumber}
                                onChange={(e) => { if (payoutLocked) return; setBankAccountNumber(e.target.value); }}
                                readOnly={payoutLocked}
                                className={`h-12 pl-10 rounded-xl text-base font-medium ${payoutLocked ? 'bg-muted/60 cursor-not-allowed' : ''}`}
                              />
                            </div>
                          </div>
                        </>
                      )}

                      {payoutMode === 'cash' && (
                        <div className="space-y-3">
                          <CashAgentSelector
                            selected={selectedCashAgent}
                            onSelect={setSelectedCashAgent}
                          />
                          {selectedCashAgent && (
                            <div className="p-3 rounded-xl bg-success/5 border border-success/20">
                              <p className="text-xs text-muted-foreground">
                                Collect your cash from <strong className="text-foreground">{selectedCashAgent.agent_name}</strong>
                                {selectedCashAgent.district ? ` in ${selectedCashAgent.district}` : ''} with your ID after approval.
                              </p>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                </div>
              )}

              {/* ── REASON FOR WITHDRAWAL ── */}
              {payoutMode && isPayoutValid() && (
                <div
                  ref={reasonSectionRef as any}
                  className={`space-y-2 rounded-2xl p-1 transition-shadow animate-fade-in ${pulseTarget === 'reason' ? 'ring-4 ring-primary/40 ring-offset-2 ring-offset-background' : ''}`}
                >
                  <Label className="text-sm font-bold text-foreground flex items-center gap-2">
                    <FileText className="h-4 w-4 text-primary" />
                    Why are you withdrawing?
                  </Label>
                  <Textarea
                    placeholder="Include reason and phone number or A/C"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    className="min-h-[70px] rounded-xl text-sm"
                  />
                  {reason.length > 0 && reason.trim().length < 10 && (
                    <p className="text-[10px] text-destructive">Reason must be at least 10 characters</p>
                  )}
                </div>
              )}

              {isPayoutValid() && meetsMinBalance && workingHoursStatus.isOpen && (
                  <div
                    ref={amountSectionRef as any}
                    className={`space-y-4 rounded-2xl p-1 transition-shadow animate-fade-in ${pulseTarget === 'amount' ? 'ring-4 ring-primary/40 ring-offset-2 ring-offset-background' : ''}`}
                  >
                    <div className="h-px bg-gradient-to-r from-transparent via-border to-transparent" />

                    <Label className="text-sm font-bold text-foreground flex items-center gap-2">
                      <span>💰</span> How much?
                    </Label>

                    <div className="relative">
                      <span className="absolute left-4 top-1/2 -translate-y-1/2 text-sm text-muted-foreground font-bold">UGX</span>
                      <Input
                        type="number"
                        inputMode="numeric"
                        placeholder="0"
                        value={amount || ''}
                        onChange={(e) => {
                          if (!lockAmount) setAmount(Math.min(Number(e.target.value), walletBalance));
                        }}
                        min={500}
                        max={walletBalance}
                        readOnly={lockAmount}
                        className="h-14 pl-14 text-2xl font-black rounded-2xl bg-muted/30 border-border/50 text-center"
                      />
                    </div>

                    <Slider
                      value={[amount]}
                      onValueChange={([v]) => {
                        if (!lockAmount) setAmount(v);
                      }}
                      max={walletBalance}
                      min={500}
                      step={500}
                      disabled={lockAmount}
                      className="py-1"
                    />

                    {/* Quick chips */}
                    <div className="grid grid-cols-4 gap-2">
                      {[0.25, 0.5, 0.75, 1].map((fraction) => {
                        const quickAmount = Math.max(500, Math.floor(walletBalance * fraction));
                        const isActive = amount === quickAmount;
                        return (
                          <Button
                            key={fraction}
                            variant={isActive ? 'default' : 'outline'}
                            size="sm"
                            onClick={() => {
                              if (!lockAmount) setAmount(quickAmount);
                            }}
                            disabled={lockAmount}
                            className={`h-10 rounded-xl font-bold touch-manipulation text-xs ${
                              isActive ? '' : 'border-border/50'
                            }`}
                          >
                            {fraction === 1 ? '💯 All' : `${fraction * 100}%`}
                          </Button>
                        );
                      })}
                    </div>

                    {/* Transfer preview card */}
                    {amount >= 500 && (
                        <div className="p-4 rounded-2xl bg-gradient-to-br from-primary/5 via-primary/3 to-transparent border border-primary/15 space-y-2 animate-scale-in">
                          <div className="flex items-center justify-between">
                            <p className="text-xs text-muted-foreground font-medium">You'll receive</p>
                            <p className="text-xs text-muted-foreground">
                              via <strong className="text-foreground">{selectedOption?.label}</strong>
                            </p>
                          </div>
                          <p className="text-3xl font-black text-primary tracking-tight">{formatCurrency(amount)}</p>
                          <div className="flex items-center justify-between pt-1 border-t border-primary/10">
                            <span className="text-[10px] text-muted-foreground">
                              {(payoutMode === 'mtn' || payoutMode === 'airtel') && momoNumber ? `📱 ${momoNumber}` : ''}
                              {payoutMode === 'bank' && bankName ? `🏦 ${bankName}` : ''}
                              {payoutMode === 'cash' ? `💵 ${selectedCashAgent?.agent_name || 'Cash at agent'}` : ''}
                            </span>
                            <span className="text-[10px] text-muted-foreground">
                              Remaining: {formatCurrency(walletBalance - amount)}
                            </span>
                          </div>
                        </div>
                    )}
                  </div>
              )}

              {/* ── ACTIONS ── */}
              <div className="pt-2 flex gap-3">
                <Button variant="outline" onClick={handleClose} className="flex-1 h-12 rounded-xl font-bold border-border/50">
                  Cancel
                </Button>
                {isFormValid ? (
                  <Button
                    onClick={() => { if (isProxyMode) setConfirming(true); else handleSubmit(); }}
                    disabled={loading}
                    className="flex-1 gap-2 h-12 rounded-xl font-bold bg-gradient-to-r from-primary to-primary/80 shadow-lg shadow-primary/20 hover:shadow-primary/30 transition-shadow"
                  >
                    {loading ? (
                      <><Loader2 className="h-4 w-4 animate-spin" /> Processing…</>
                    ) : (
                      <><ArrowDownToLine className="h-4 w-4" /> Withdraw</>
                    )}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    onClick={focusMissing}
                    className="flex-1 h-12 rounded-xl font-bold opacity-70 bg-muted text-muted-foreground hover:opacity-90 hover:bg-muted"
                  >
                    {!payoutMode
                      ? 'Select payout method ↑'
                      : !isPayoutValid()
                      ? 'Fill payout details ↑'
                      : reason.trim().length < 10
                      ? 'Add reason (10+ chars) ↑'
                      : amount < 500
                      ? 'Enter amount ↓'
                      : 'Withdraw'
                    }
                  </Button>
                )}
              </div>

              {/* Trust footer */}
              <div className="flex items-center justify-center gap-2 pt-1">
                <Shield className="h-3 w-3 text-muted-foreground/40" />
                <p className="text-[9px] text-muted-foreground/40 font-medium tracking-wide">
                  256-BIT ENCRYPTED · 4-STAGE APPROVAL · INSTANT NOTIFICATIONS
                </p>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
