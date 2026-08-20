import { useState, useEffect, useRef } from 'react';
import StepperModal, { Step } from './StepperModal';
import ConfirmSummaryCard from './ConfirmSummaryCard';
import ProcessingScreen from './ProcessingScreen';
import ReceiptCard from './ReceiptCard';
import WithdrawalStatusTracker from './WithdrawalStatusTracker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatCurrency, SUPPORTED_CURRENCIES } from '@/lib/paymentMethods';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Wallet, TrendingUp, Lock, Phone, Building2, Banknote, BadgeCheck } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { invalidateOpsWallet } from '@/hooks/ops/useOpsDataLayer';
import { computeLedgerAvailable } from '@/lib/computeLedgerAvailable';
import { resolveWithdrawCap } from '@/lib/withdrawAvailability';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { UGANDA_BANKS, PAYOUT_METHODS } from '@/lib/ugandaBanks';
import { useSavedPayoutMethods, type SavedPayoutMethod } from '@/hooks/useSavedPayoutMethods';
import { Checkbox } from '@/components/ui/checkbox';
import { Trash2, Star } from 'lucide-react';
import { downloadWithdrawalReceiptPdf, shareWithdrawalReceiptPdf } from '@/lib/withdrawalReceiptPdf';
import { useLanguage } from '@/hooks/useLanguage';
import { WITHDRAWAL_REASON_OPTIONS, OTHER_WITHDRAWAL_REASON } from '@/lib/cashoutAgentConfig';
import { useWithdrawContext, invalidateWithdrawContext } from '@/hooks/useWithdrawContext';
import { AlertTriangle } from 'lucide-react';

/**
 * Maps a Ugandan mobile-money number to its provider based on the operator
 * prefix. Returns null when the prefix is unknown so we don't override the
 * user's manual choice on incomplete input.
 * - MTN: 077, 078, 076, 079, 039
 * - Airtel: 070, 074, 075
 */
function detectMomoProvider(raw: string): 'MTN' | 'Airtel' | null {
  const digits = raw.replace(/\D/g, '');
  // Normalise +2567xxxx → 07xxxx
  const normalised = digits.startsWith('256') ? `0${digits.slice(3)}` : digits;
  if (normalised.length < 3) return null;
  const prefix = normalised.slice(0, 3);
  if (['077', '078', '076', '079', '039'].includes(prefix)) return 'MTN';
  if (['070', '074', '075'].includes(prefix)) return 'Airtel';
  return null;
}

const MIN_WITHDRAWAL = 1000;

interface WithdrawFlowProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  availableBalance?: number;
  roiBalance?: number;
  onSuccess?: () => void;
  /**
   * Optional pre-fill for the amount step. When set (and > 0), the amount
   * input starts at this value the next time the dialog opens — used by the
   * merchant "Withdraw All" shortcut on `MerchantWithdrawableCard`.
   */
  initialAmount?: number;
  /**
   * When true, `availableBalance` is treated as the authoritative cap and
   * the flow will NOT clamp it against the strict wallet-cache figure.
   * Used by `MerchantWithdrawableCard` so cash-out commission drives the
   * withdrawal UI even when other wallet activity (e.g. portfolio top-ups)
   * has consumed part of the mixed withdrawable bucket.
   */
  trustAvailableBalance?: boolean;
  defaultWithdrawalReason?: string;
}

const STEPS: Step[] = [
  { id: 'source', title: 'Select Source' },
  { id: 'amount', title: 'Amount' },
  { id: 'payout', title: 'Payout Mode' },
  { id: 'details', title: 'Details' },
  { id: 'security', title: 'Verify' },
  { id: 'process', title: 'Processing' },
];

export default function WithdrawFlow({
  open,
  onOpenChange,
  availableBalance = 0,
  roiBalance = 0,
  onSuccess,
  initialAmount,
  trustAvailableBalance = false,
  defaultWithdrawalReason = WITHDRAWAL_REASON_OPTIONS[0].value,
}: WithdrawFlowProps) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { language } = useLanguage();
  // Unified withdrawal context — single source of truth for paused flag,
  // KYC daily limits, frozen accounts and server-computed `canSubmit`.
  // Migrating both dialogs onto this hook eliminates gate drift where one
  // dialog enforced a rule the other missed (e.g. the payout-freeze bug).
  const withdrawCtx = useWithdrawContext(user?.id);
  const [currentStep, setCurrentStep] = useState(0);
  const [source, setSource] = useState<'available' | 'roi'>('available');
  const [amount, setAmount] = useState(100000);
  // Reason / purpose the user selects for this withdrawal. The stored reason
  // determines which payout category the request maps to, so it reaches a
  // Cash-Out Agent authorized for that category.
  const [reasonPreset, setReasonPreset] = useState<string>(defaultWithdrawalReason);
  const [reasonCustom, setReasonCustom] = useState('');
  const effectiveReason =
    reasonPreset === OTHER_WITHDRAWAL_REASON ? reasonCustom.trim() : reasonPreset;
  // Honor the caller's `initialAmount` prefill (e.g. merchant "Withdraw All")
  // every time the dialog transitions to open.
  useEffect(() => {
    if (open && typeof initialAmount === 'number' && initialAmount > 0) {
      setAmount(Math.floor(initialAmount));
    }
    if (open) {
      setReasonPreset(defaultWithdrawalReason);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialAmount, defaultWithdrawalReason]);
  const [currency, setCurrency] = useState('UGX');
  // Saved payout destinations — persisted across withdrawals so users
  // don't re-type MoMo / bank details every time.
  const savedMethods = useSavedPayoutMethods();
  const [selectedSavedId, setSelectedSavedId] = useState<string | null>(null);
  const [saveAsNew, setSaveAsNew] = useState(true);
  const [savedNickname, setSavedNickname] = useState('');

  // Payout mode state
  const [payoutMode, setPayoutMode] = useState<'mobile_money' | 'bank_transfer' | 'cash'>('mobile_money');

  // Mobile Money details
  const [momoNumber, setMomoNumber] = useState('');
  const [momoName, setMomoName] = useState('');
  const [momoProvider, setMomoProvider] = useState<'MTN' | 'Airtel'>('MTN');
  // Locked withdrawal destination saved by the user in Settings →
  // Withdrawal account. When present, the mobile-money fields are
  // prefilled and read-only so payouts always land on the one verified
  // account bound to this user.
  const [lockedMomo, setLockedMomo] = useState<{
    number: string;
    name: string;
    provider: 'MTN' | 'Airtel';
  } | null>(null);

  // Bank details
  const [bankName, setBankName] = useState('');
  const [bankAccountName, setBankAccountName] = useState('');
  const [bankAccountNumber, setBankAccountNumber] = useState('');

  const [isProcessing, setIsProcessing] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  // Withdrawal receipts start as `pending` because Financial Ops must
  // approve and disburse before the request is truly successful.
  const [paymentStatus, setPaymentStatus] = useState<'pending' | 'success' | 'failed'>('pending');
  const [lastFailureMessage, setLastFailureMessage] = useState<string | null>(null);
  // Real DB UUID of the new withdrawal_requests row. Drives the live
  // status tracker subscription on the success step.
  const [createdRequestId, setCreatedRequestId] = useState<string | null>(null);
  const [withdrawalRef, setWithdrawalRef] = useState('');
  // Cash pickup code (WPO-XXXXX) — generated by submit_withdrawal_request
  // at REQUEST time for cash withdrawals. Shown prominently above the
  // amount on the receipt screen and emailed to the Financial Ops inbox.
  const [cashPickupCode, setCashPickupCode] = useState<string | null>(null);
  // User must re-type the WPO code (delivered via email) on the
  // confirmation screen before the cash withdrawal request is
  // considered complete. This proves the user actually has the code
  // before they walk to an agent — so a lost/un-checked email surfaces
  // immediately instead of at the pickup counter.
  const [cashCodeInput, setCashCodeInput] = useState('');
  const [cashCodeAcknowledged, setCashCodeAcknowledged] = useState(false);
  const [cashCodeError, setCashCodeError] = useState<string | null>(null);
  // ─── Resend code (cash pickup) ──────────────────────────────────────
  // A fresh WPO code can only be issued once the current one has expired
  // OR a cooldown has elapsed. The RPC `resend_payout_code` is the
  // authoritative guard; this client-side cooldown is purely UX so the
  // button visibly counts down instead of round-tripping to a rejection.
  const RESEND_COOLDOWN_SECONDS = 90;
  const [codeIssuedAt, setCodeIssuedAt] = useState<number | null>(null);
  const [resendingCode, setResendingCode] = useState(false);
  const [resendTick, setResendTick] = useState(() => Date.now());
  // Server-confirmed submission timestamp. Set the moment the
  // withdrawal_requests insert returns successfully so the success
  // receipt can display the exact processed date/time.
  const [submittedAt, setSubmittedAt] = useState<Date | null>(null);

  // ─── Duplicate-submission guards ────────────────────────────────────
  // 1. Re-entrant lock: blocks double-tap on slow phones before the
  //    network round-trip even starts.
  // 2. Stable client_request_id: reused across network retries so the DB
  //    unique partial index `(user_id, client_request_id)` collapses any
  //    accidental duplicates into a single row.
  // 3. Friendly handling of the server-side DUPLICATE_PENDING_WITHDRAWAL
  //    trigger error so the user sees a clear message instead of a raw
  //    Postgres exception (which they typically respond to by tapping
  //    again, making the problem worse).
  const isSubmittingRef = useRef(false);
  const clientRequestIdRef = useRef<string | null>(null);

  // Withdrawable = withdrawable_balance + advance_balance (advance is recoverable
  // user money). Float is operational/company money and stays locked.
  const [floatBalance, setFloatBalance] = useState<number>(0);
  const [advanceBalance, setAdvanceBalance] = useState<number>(0);
  const [userRoles, setUserRoles] = useState<string[]>([]);
  // Agent collection performance gate: agents with active tenants whose
  // today's collection performance is below 20% cannot withdraw from the
  // withdrawable/available bucket. Landlord-float payouts use a separate
  // flow (AgentLandlordPayoutFlow) and are not affected.
  const [perfToday, setPerfToday] = useState<{
    active_count: number;
    expected_daily: number;
    paid_today: number;
    today_pct: number;
  } | null>(null);
  // Global temporary bypass — CFO/ops can flip
  // `system_config.agent_perf_gate_disabled_until` to disable the 20% gate
  // for a window. Mirrors the server-side short-circuit in
  // `enforce_agent_perf_withdrawal`.
  const [perfGateBypassed, setPerfGateBypassed] = useState(false);
  // Ledger-true `available` from get_user_available_balance — the
  // ONLY figure we trust to gate the withdraw button. Cached
  // wallets.balance can drift above this; we always take the lesser.
  const [ledgerAvailable, setLedgerAvailable] = useState<number | null>(null);
  // Strict-validation state — gates the Continue/Confirm buttons. The
  // ledger snapshot expires after STALE_MS so users can't sit on the
  // amount screen for minutes and submit against an outdated balance.
  const [validating, setValidating] = useState(false);
  const [ledgerCheckedAt, setLedgerCheckedAt] = useState<number | null>(null);
  const STALE_MS = 30_000;
  const isStale =
    ledgerCheckedAt === null || Date.now() - ledgerCheckedAt > STALE_MS;

  // The "available" source is the LESSER of (caller-supplied wallet
  // available, ledger-true available). Advance bucket is debt — NOT
  // withdrawable money — so it is excluded.
  // Single authoritative cap. `ledgerAvailable === null` means UNKNOWN
  // (read failed / not fetched yet) — it falls back to the figure the wallet
  // UI is already showing and the server RPC stays the final gate. It must
  // never collapse to zero (root cause of the "Available: UGX 0" report).
  const trueAvailable = resolveWithdrawCap({
    uiAvailable: availableBalance,
    ledgerAvailable,
    trustUiAvailable: trustAvailableBalance,
  });
  // Daily withdrawal limits removed globally (2026-08-10). The only cap is
  // the caller-supplied or ledger-true available balance.
  const rawMax = source === 'available' ? trueAvailable : roiBalance;
  const maxAmount = rawMax;

  // 20% daily-collection withdrawal gate REMOVED (2026-08-01) — agents can
  // withdraw regardless of today's collection performance. Kept as a constant
  // false so the surrounding plumbing stays intact for a future replacement.
  const isPerfLocked = false;

  /** Force-fetch the strict ledger balance from the server, bypassing
   *  any cached values. Updates `ledgerAvailable` + `ledgerCheckedAt`. */
  const refetchLedger = async (): Promise<number | null> => {
    if (!user) return null;
    setValidating(true);
    try {
      const fresh = await computeLedgerAvailable(user.id);
      setLedgerAvailable(fresh.available);
      setLedgerCheckedAt(Date.now());
      return fresh.available;
    } catch (e) {
      // Keep the last known-good snapshot. A failed verification is NOT a
      // zero balance — returning null tells callers "unknown".
      console.warn('[WithdrawFlow] ledger refetch failed', e);
      return null;
    } finally {
      setValidating(false);
    }
  };

  useEffect(() => {
    if (!open || !user) return;
    let cancelled = false;
    (async () => {
      const [walletRes, rolesRes, ledger, perfRes] = await Promise.all([
        supabase
          .from('wallets')
          .select('float_balance, advance_balance')
          .eq('user_id', user.id)
          .maybeSingle(),
        supabase
          .from('user_roles')
          .select('role')
          .eq('user_id', user.id),
        // Inline ledger compute — get_user_available_balance RPC is unreliable
        // (historically returned 0 because of a direction-value mismatch).
        // We compute the same numbers client-side so the WITHDRAW max always
        // matches what the server-side gate will actually allow.
        computeLedgerAvailable(user.id).catch(() => null),
        supabase
          .from('v_agent_daily_eligibility' as any)
          .select('active_count, expected_daily, paid_today, today_pct')
          .eq('agent_id', user.id)
          .maybeSingle(),
      ]);
      if (cancelled) return;
      // Fire-and-forget bypass check; failure defaults to gate ON.
      supabase.rpc('is_agent_perf_gate_disabled' as any).then(({ data }) => {
        if (!cancelled) setPerfGateBypassed(Boolean(data));
      });
      setFloatBalance(Number(walletRes.data?.float_balance ?? 0));
      setAdvanceBalance(Number(walletRes.data?.advance_balance ?? 0));
      setUserRoles((rolesRes.data ?? []).map((r: any) => r.role));
      if (ledger) setLedgerAvailable(ledger.available);
      if (ledger) setLedgerCheckedAt(Date.now());
      const pr: any = perfRes?.data;
      if (pr) {
        setPerfToday({
          active_count: Number(pr.active_count) || 0,
          expected_daily: Number(pr.expected_daily) || 0,
          paid_today: Number(pr.paid_today) || 0,
          // v_agent_daily_eligibility returns today_pct as a 0-1 fraction. We
          // store it as-is; `perfPct` below multiplies by 100 for the 20%
          // gate + display. (Multiplying here too caused a x100 double-count
          // that made every agent look 100x their real score, so the "under
          // 20%" warning card never rendered — see finding.)
          today_pct: Number(pr.today_pct) || 0,
        });
      } else {
        setPerfToday(null);
      }
    })();
    return () => { cancelled = true; };
  }, [open, user]);

  // Anti-cache: re-fetch ledger every time the user lands on the
  // Amount step (1) or the final Verify step (4). The Confirm button
  // stays disabled until the fresh figure lands.
  useEffect(() => {
    if (!open || !user) return;
    if (currentStep === 1 || currentStep === 4) {
      refetchLedger();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep, open, user]);

  // Keep the ledger snapshot fresh on the Verify (Confirm) step. Without this,
  // the `isStale` gate (STALE_MS = 30s) silently disables the Confirm button if
  // the user takes more than 30 seconds to type their PIN, leaving them with a
  // button that "does nothing". We re-fetch every 20s while sitting on step 4
  // — but ONLY while the tab is visible. When the user switches tabs/apps the
  // poll pauses (saves API quota + battery on mobile) and resumes immediately
  // on focus with a fresh fetch so the snapshot is current the moment they
  // return to the Confirm screen.
  useEffect(() => {
    if (!open || !user || currentStep !== 4) return;

    let interval: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (interval !== null) return;
      interval = setInterval(() => { refetchLedger(); }, 20_000);
    };
    const stop = () => {
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        // Catch up immediately on return, then resume polling.
        refetchLedger();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onVisibility);
    window.addEventListener('blur', onVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onVisibility);
      window.removeEventListener('blur', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, user, currentStep]);

  // Debounced re-validation as the user types a new amount — keeps
  // the maxAmount and inline error in sync without spamming the API.
  useEffect(() => {
    if (!open || !user || currentStep !== 1) return;
    const t = setTimeout(() => { refetchLedger(); }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount]);

  // Load the user's locked withdrawal account whenever the flow opens.
  useEffect(() => {
    if (!open || !user?.id) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('profiles')
        .select('mobile_money_number, mobile_money_name, mobile_money_provider')
        .eq('id', user.id)
        .maybeSingle();
      if (cancelled) return;
      const num = (data?.mobile_money_number ?? '').trim();
      const nm = (data?.mobile_money_name ?? '').trim();
      if (!num || !nm) {
        setLockedMomo(null);
        return;
      }
      const prov: 'MTN' | 'Airtel' =
        (data?.mobile_money_provider ?? '').toLowerCase() === 'airtel' ? 'Airtel' : 'MTN';
      setLockedMomo({ number: num, name: nm, provider: prov });
      setMomoNumber(num);
      setMomoName(nm);
      setMomoProvider(prov);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, user?.id]);

  const handleReset = () => {
    setLockedMomo(null);
    setCurrentStep(0);
    setSource('available');
    setAmount(100000);
    setCurrency('UGX');
    setPayoutMode('mobile_money');
    setReasonPreset(defaultWithdrawalReason);
    setReasonCustom('');
    setMomoNumber('');
    setMomoName('');
    setMomoProvider('MTN');
    setBankName('');
    setBankAccountName('');
    setBankAccountNumber('');
    setIsProcessing(false);
    setIsComplete(false);
    setWithdrawalRef('');
    setSelectedSavedId(null);
    setSaveAsNew(true);
    setSavedNickname('');
    setCashPickupCode(null);
    setCodeIssuedAt(null);
    setResendingCode(false);
    setCashCodeInput('');
    setCashCodeAcknowledged(false);
    setCashCodeError(null);
  };

  // Drive the resend cooldown countdown once a cash code is on screen.
  useEffect(() => {
    if (!cashPickupCode || codeIssuedAt === null) return;
    const id = setInterval(() => setResendTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [cashPickupCode, codeIssuedAt]);

  const resendRemaining = codeIssuedAt === null
    ? 0
    : Math.max(0, RESEND_COOLDOWN_SECONDS - Math.floor((resendTick - codeIssuedAt) / 1000));

  // Request a fresh pickup code. The RPC only issues one when the previous
  // code is expired or the cooldown has elapsed — otherwise it tells us how
  // long to wait, which we mirror into the local countdown.
  const handleResendCode = async () => {
    if (!createdRequestId || resendingCode || resendRemaining > 0) return;
    setResendingCode(true);
    try {
      const { data, error } = await supabase.rpc('resend_payout_code' as any, {
        p_withdrawal_request_id: createdRequestId,
      });
      if (error) throw error;
      const res = (data ?? {}) as {
        success?: boolean;
        code?: string;
        payout_code?: string;
        retry_after_seconds?: number;
        message?: string;
      };
      if (res.success && res.payout_code) {
        setCashPickupCode(res.payout_code);
        setCodeIssuedAt(Date.now());
        toast.success('New code issued — read this one to Financial Ops');
        try {
          supabase.functions.invoke('send-transactional-email', {
            body: {
              templateName: 'cash-withdrawal-code',
              idempotencyKey: `cash-code-resend-${createdRequestId}-${res.payout_code}`,
              purpose: 'transactional',
              data: {
                payoutCode: res.payout_code,
                amountUgx: amount,
                userName: (user as any)?.user_metadata?.full_name || user?.email || 'Welile user',
                userPhone: (user as any)?.phone || (user as any)?.user_metadata?.phone || '',
                requestReference: withdrawalRef,
                agentLocation: 'Nearest Agent',
                requestedAt: new Date().toISOString(),
              },
            },
          }).catch((e) => console.warn('[WithdrawFlow] resend code email failed', e));
        } catch (e) {
          console.warn('[WithdrawFlow] resend code email dispatch threw', e);
        }
      } else if (res.code === 'cooldown_active') {
        const wait = Math.max(0, Number(res.retry_after_seconds) || 0);
        // Re-anchor the countdown so the button reflects the server's wait.
        setCodeIssuedAt(Date.now() - (RESEND_COOLDOWN_SECONDS - wait) * 1000);
        toast.message(res.message || `Your current code is still valid. Try again in ${wait}s.`);
      } else {
        toast.error(res.message || 'Could not issue a new code right now.');
      }
    } catch (e: any) {
      toast.error(e?.message || 'Could not issue a new code right now.');
    } finally {
      setResendingCode(false);
    }
  };

  /**
   * Pre-fill the destination form from a saved payout method. Switches
   * payoutMode to match the saved row, then hydrates the relevant fields.
   * Marks the row as "selected" so we skip re-creating it on submit.
   */
  const applySavedMethod = (m: SavedPayoutMethod) => {
    setSelectedSavedId(m.id);
    setSaveAsNew(false);
    setPayoutMode(m.payout_mode);
    if (m.payout_mode === 'mobile_money') {
      setMomoProvider((m.momo_provider as 'MTN' | 'Airtel') ?? 'MTN');
      setMomoNumber(m.momo_number ?? '');
      setMomoName(m.momo_name ?? '');
    } else if (m.payout_mode === 'bank_transfer') {
      setBankName(m.bank_name ?? '');
      setBankAccountName(m.bank_account_name ?? '');
      setBankAccountNumber(m.bank_account_number ?? '');
    }
  };

  /** Clear the saved-method selection so edits don't silently mutate it. */
  const clearSavedSelection = () => {
    if (selectedSavedId) {
      setSelectedSavedId(null);
      setSaveAsNew(true);
    }
  };

  const handleClose = () => {
    onOpenChange(false);
    setTimeout(handleReset, 300);
  };

  const canProceed = () => {
    // Global gates — apply on every step. Server-computed so a paused
    // platform / frozen account / exhausted daily count blocks the flow
    // uniformly across every dialog.
    if (!withdrawCtx.isLoading && !withdrawCtx.gates.canSubmit) {
      // Special case: on step 0 (Source) we still want to allow closing /
      // navigating; the disable-Next behavior is enough.
      return false;
    }
    // Agent performance gate — blocks step 0 and 1 for the "available"
    // (personal wallet) source. Landlord-float payouts use a separate
    // flow and are exempt. Threshold: today_pct < 20% with active tenants.
    switch (currentStep) {
      case 0: return true;
      case 1:
        // Mirror the Confirm-step pattern: keep Continue tappable even when
        // the live ledger check is still loading / failed / stale. We refetch
        // inside handleNext and surface a clear inline error if the amount is
        // actually invalid. Silent-disable was the #1 cause of "the button
        // does nothing" reports.
        return (
          amount >= MIN_WITHDRAWAL &&
          // If we have a verified ledger figure, enforce it. If we don't
          // (RPC slow/failed), let the tap through — handleNext will refetch
          // and either advance or show a real error.
          (ledgerAvailable === null || amount <= maxAmount)
        );
      case 2: return !!payoutMode;
      case 3: {
        // A reason is required — custom reason must not be blank.
        if (!effectiveReason) return false;
        if (payoutMode === 'mobile_money') return momoNumber.trim().length >= 9 && momoName.trim().length >= 2;
        if (payoutMode === 'bank_transfer') return !!bankName && bankAccountName.trim().length >= 2 && bankAccountNumber.trim().length >= 5;
        if (payoutMode === 'cash') return true;
        return false;
      }
      case 4:
        // NOTE: we intentionally do NOT block on `validating` or `isStale`
        // here. If the snapshot is stale when the user taps Confirm, the
        // `handleNext` handler will transparently refetch the ledger and
        // then proceed — so the button must remain clickable.
        return (
          ledgerAvailable !== null &&
          amount <= maxAmount
        );
      default: return false;
    }
  };

  const getPayoutSummary = () => {
    if (payoutMode === 'mobile_money') return `${momoProvider} - ${momoNumber}`;
    if (payoutMode === 'bank_transfer') return `${bankName.split(' ').slice(0, 2).join(' ')} - ${bankAccountNumber}`;
    return 'Cash Pickup at Office';
  };

  const getPayoutName = () => {
    if (payoutMode === 'mobile_money') return momoName;
    if (payoutMode === 'bank_transfer') return bankAccountName;
    return 'Cash Collection';
  };

  /**
   * Build the canonical receipt payload used by both the Download and
   * Share buttons on the success step. Centralised so the fee
   * breakdown stays consistent between the two paths.
   */
  const buildReceiptPayload = () => {
    const methodLabel =
      payoutMode === 'mobile_money'
        ? 'Mobile Money'
        : payoutMode === 'bank_transfer'
        ? 'Bank Transfer'
        : 'Cash Pickup';

    // Welile currently charges no platform withdrawal fee. We still
    // surface zero-valued breakdown lines on the PDF (rendered by the
    // receipt generator when `feeBreakdown` is empty) so users get an
    // auditable record that nothing was deducted. If/when a platform
    // service fee or operator charge is applied at approval time, push
    // entries here with `{ label, amount }` and they will appear as
    // itemised deductions on the PDF.
    const feeBreakdown: Array<{ label: string; amount: number }> = [];

    return {
      reference: withdrawalRef || 'PENDING',
      amount,
      currency,
      recipient: getPayoutSummary(),
      method: methodLabel,
      date: submittedAt ?? new Date(),
      status: 'Pending disbursement',
      feeBreakdown,
      language,
    };
  };

  const processWithdrawal = async (): Promise<boolean> => {
    if (!user) return false;
    if (isSubmittingRef.current) return false;
    isSubmittingRef.current = true;
    setLastFailureMessage(null);

    try {
      // FINAL LEDGER GATE — recompute ledger truth right before submission.
      // Cached props may be stale; the ledger is the source of truth.
      try {
        const freshAvailable = trustAvailableBalance ? availableBalance : await refetchLedger();
        // UNKNOWN (verification failed) → do NOT block the user with a
        // fabricated "Available: UGX 0". Defer to the server-side
        // `submit_withdrawal_request` gate, which is authoritative.
        const verified = trustAvailableBalance || freshAvailable !== null;
        const freshLedger = resolveWithdrawCap({
          uiAvailable: availableBalance,
          ledgerAvailable: trustAvailableBalance ? null : freshAvailable,
          trustUiAvailable: trustAvailableBalance,
        });
        if (verified && source === 'available' && amount > freshLedger) {
          const message = `Insufficient funds. Available: UGX ${freshLedger.toLocaleString()}, requested: UGX ${amount.toLocaleString()}.`;
          setPaymentStatus('failed');
          setLastFailureMessage(message);
          toast.error(
            message,
            { duration: 8000 },
          );
          isSubmittingRef.current = false;
          return false;
        }
      } catch (e) {
        console.warn('[WithdrawFlow] ledger pre-check failed, proceeding to server gate', e);
      }

      if (!clientRequestIdRef.current) {
        clientRequestIdRef.current =
          (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      }
      // Server-side validation gate. The RPC re-checks authorization,
      // amount bounds, payout-method fields, and ledger-backed available
      // balance — so the flow stays safe even without a client PIN.
      const { data: rpcData, error: rpcError } = await supabase.rpc(
        'submit_withdrawal_request',
        {
          p_amount: amount,
          p_payout_method: payoutMode,
          p_mobile_money_number: payoutMode === 'mobile_money' ? momoNumber.trim() : null,
          p_mobile_money_name: payoutMode === 'mobile_money' ? momoName.trim() : null,
          p_mobile_money_provider: payoutMode === 'mobile_money' ? momoProvider.toLowerCase() : null,
          p_bank_name: payoutMode === 'bank_transfer' ? bankName.trim() : null,
          p_bank_account_number: payoutMode === 'bank_transfer' ? bankAccountNumber.trim() : null,
          p_bank_account_name: payoutMode === 'bank_transfer' ? bankAccountName.trim() : null,
          p_client_request_id: clientRequestIdRef.current,
          p_reason: effectiveReason || null,
        },
      );

      const result = (rpcData ?? null) as
        | { success: boolean; code: string; message?: string; request_id?: string; available?: number; payout_code?: string | null }
        | null;

      // RPC returned a structured rejection — surface friendly toast + stop.
      if (!rpcError && result && result.success === false) {
        const code = result.code;
        const msg = result.message || 'Withdrawal rejected.';
        if (code === 'insufficient_funds') {
          await refetchLedger();
        }
        if (code === 'forbidden') {
          setPaymentStatus('failed');
          setLastFailureMessage('Your account is linked to a proxy agent, so withdrawals must be processed by your assigned agent.');
          toast.error('Withdrawals are routed via your assigned agent', {
            description:
              'Your account is linked to a proxy agent, so you cannot submit a withdrawal directly. Contact your assigned agent — they will process the cash-out on your behalf.',
            duration: 10000,
          });
        } else if (code === 'duplicate_pending') {
          setPaymentStatus('failed');
          setLastFailureMessage(msg);
          toast.error(msg, { duration: 8000 });
          clientRequestIdRef.current = null;
        } else {
          setPaymentStatus('failed');
          setLastFailureMessage(msg);
          toast.error(msg, { duration: 8000 });
        }
        isSubmittingRef.current = false;
        return false;
      }

      if (rpcError) {
        const requestError: any = rpcError;
        // 23505 = unique_violation. Two distinct cases:
        //   1. Idempotency key collision → genuine network retry of *this*
        //      submission. Treat as success (the row already exists).
        //   2. Trigger `prevent_duplicate_pending_withdrawal` fired → the
        //      user already has an identical request waiting. Show a
        //      friendly message and stop, do NOT throw.
        // Server-side ledger gate (trigger) raised P0001 with a
        // "Ledger mismatch detected" message — surface as a clear
        // insufficient-funds toast and stop.
        const rawMsg = String((requestError as any).message || '');
        const errCode = (requestError as any).code as string | undefined;
        // RLS denial — almost always means this user has an active proxy
        // agent assignment, so they cannot self-submit withdrawals. The
        // funds must be released by their assigned proxy agent.
        if (
          errCode === '42501' ||
          /row-level security|violates row-level security policy/i.test(rawMsg)
        ) {
          setPaymentStatus('failed');
          setLastFailureMessage('Your account is linked to a proxy agent, so withdrawals must be processed by your assigned agent.');
          toast.error('Withdrawals are routed via your assigned agent', {
            description:
              'Your account is linked to a proxy agent, so you cannot submit a withdrawal directly. Contact your assigned agent — they will process the cash-out on your behalf.',
            duration: 10000,
          });
          isSubmittingRef.current = false;
          return false;
        }
        if (rawMsg.includes('Ledger mismatch detected')) {
          setPaymentStatus('failed');
          setLastFailureMessage('Ledger mismatch detected. Refresh your balance and try again.');
          toast.error(
            'Ledger mismatch detected. Transaction aborted. Refresh your balance and try again.',
            { duration: 8000 },
          );
          // Force a fresh ledger read so the UI reflects truth.
          await refetchLedger();
          isSubmittingRef.current = false;
          return false;
        }
        if ((requestError as any).code === '23505') {
          const msg = String((requestError as any).message || '');
          if (msg.includes('DUPLICATE_PENDING_WITHDRAWAL')) {
            const duplicateMessage = `You just requested UGX ${amount.toLocaleString()} to this recipient a few minutes ago. To avoid double payouts, wait about 15 minutes (or for the earlier request to be settled) before requesting the same amount again.`;
            setPaymentStatus('failed');
            setLastFailureMessage(duplicateMessage);
            toast.error(
              duplicateMessage,
              { duration: 8000 },
            );
            // Reset so a different recipient/amount can be tried.
            clientRequestIdRef.current = null;
            isSubmittingRef.current = false;
            return false;
          }
          // Idempotency key collision — the original insert already
          // succeeded server-side. Surface a soft success and stop.
          toast.success('Withdrawal already submitted.');
          isSubmittingRef.current = false;
          return true;
        }
        throw new Error(requestError.message || 'Failed to submit withdrawal request');
      }

      // Stable request ID derived from the DB UUID. NOT a transaction ID —
      // the real provider TID is entered by Financial Ops at approval time.
      const newId = result?.request_id ?? null;
      const requestId = newId
        ? `REQ-${String(newId).replace(/-/g, '').slice(0, 12).toUpperCase()}`
        : '';
      setWithdrawalRef(requestId);
      setCreatedRequestId(newId);
      setSubmittedAt(new Date());
      const pickupCode = result?.payout_code ?? null;
      if (payoutMode === 'cash' && pickupCode && newId) {
        setCashPickupCode(pickupCode);
        setCodeIssuedAt(Date.now());
        try {
          supabase.functions.invoke('send-transactional-email', {
            body: {
              templateName: 'cash-withdrawal-code',
              idempotencyKey: `cash-code-${newId}`,
              purpose: 'transactional',
              data: {
                payoutCode: pickupCode,
                amountUgx: amount,
                userName: (user as any)?.user_metadata?.full_name || user?.email || 'Welile user',
                userPhone: (user as any)?.phone || (user as any)?.user_metadata?.phone || '',
                requestReference: requestId,
                agentLocation: 'Nearest Agent',
                requestedAt: new Date().toISOString(),
              },
            },
          }).catch((e) => console.warn('[WithdrawFlow] cash code email failed', e));
        } catch (e) {
          console.warn('[WithdrawFlow] cash code email dispatch threw', e);
        }
      }
      // IMPORTANT: a withdrawal is NOT successful until Financial Ops
      // approves and disburses. Keep status as `pending` and let the
      // realtime tracker flip it to success when the DB row updates.
      setPaymentStatus('pending');
      toast.success(
        'Withdrawal request submitted. Funds will be released once Financial Ops approves.',
      );
      // Pending withdrawals reduce spendable balance immediately (pending_holds
      // in the strict view). Nudge the shared ops-wallet cache so every hero
      // card / withdrawal gate on this session sees the reduced figure.
      if (user?.id) invalidateOpsWallet(qc, user.id);
      if (user?.id) invalidateWithdrawContext(qc, user.id);
      onSuccess?.();

      // Confirmation SMS to the requester (server-side, idempotent). Fire-and-
      // forget — never block or fail the submission on an SMS hiccup.
      if (newId) {
        try {
          supabase.functions
            .invoke('notify-withdrawal-submitted', { body: { withdrawal_id: newId } })
            .catch((e) => console.warn('[WithdrawFlow] submit SMS dispatch failed', e));
        } catch (e) {
          console.warn('[WithdrawFlow] submit SMS dispatch threw', e);
        }
      }

      // Persist destination so the user doesn't re-type next time. Skip
      // for cash pickup (no destination details to save) and skip when
      // they reused an existing saved method (just bump last_used_at).
      try {
        if (selectedSavedId) {
          savedMethods.touch.mutate(selectedSavedId);
        } else if (saveAsNew && payoutMode !== 'cash') {
          await savedMethods.create.mutateAsync({
            payout_mode: payoutMode,
            nickname: savedNickname.trim() || null,
            momo_provider: payoutMode === 'mobile_money' ? momoProvider : null,
            momo_number: payoutMode === 'mobile_money' ? momoNumber.trim() : null,
            momo_name: payoutMode === 'mobile_money' ? momoName.trim() : null,
            bank_name: payoutMode === 'bank_transfer' ? bankName : null,
            bank_account_name: payoutMode === 'bank_transfer' ? bankAccountName.trim() : null,
            bank_account_number: payoutMode === 'bank_transfer' ? bankAccountNumber.trim() : null,
            is_default: false,
          });
        }
      } catch (saveErr) {
        console.warn('[WithdrawFlow] Could not save payout method (non-blocking):', saveErr);
      }

      // Disbursement confirmation email is sent by the approval pipeline,
      // NOT here — funds aren't actually out yet.
      // Submission committed — release the idempotency key so the next
      // intentional withdrawal gets a fresh one.
      clientRequestIdRef.current = null;
      return true;
    } catch (error: any) {
      console.error('Withdrawal failed:', error);
      setPaymentStatus('failed');
      const message = error.message || 'Withdrawal failed. Please try again.';
      setLastFailureMessage(message);
      toast.error(message);
      // Keep clientRequestIdRef so a manual retry from the user collapses
      // into the same row server-side via the unique index.
      return false;
    } finally {
      isSubmittingRef.current = false;
    }
  };

  const handleNext = async (): Promise<void | false> => {
    // ── Step 1 (Amount): if our ledger snapshot is missing/stale, refetch
    // before advancing. Show a real error instead of letting the stepper
    // silently swallow the tap. This is the counterpart to the Confirm-step
    // logic below and the reason `canProceed()` no longer hard-blocks here.
    if (currentStep === 1) {
      if (ledgerAvailable === null || isStale || validating) {
        const fresh = await refetchLedger();
        const freshMax =
          source === 'available'
            ? (trustAvailableBalance
                ? availableBalance
                : fresh !== null
                  ? Math.min(availableBalance, fresh)
                  : availableBalance)
            : roiBalance;
        if (fresh === null && ledgerAvailable === null) {
          toast.error(
            'Could not verify your live balance. Check your connection and try again.',
            { duration: 6000 },
          );
          return false;
        }
        if (amount > freshMax) {
          toast.error(
            `Insufficient funds. Available: UGX ${freshMax.toLocaleString()}.`,
            { duration: 6000 },
          );
          return false;
        }
      }
      return; // let the stepper advance to step 2
    }
    if (currentStep === 4) {
      // If our ledger snapshot is stale (or actively refreshing), don't
      // silently no-op — refresh first, then continue with the freshest
      // numbers. This makes Confirm "always work" from the user's POV.
      if (isStale || validating) {
        const fresh = await refetchLedger();
        const freshLedger = trustAvailableBalance
          ? availableBalance
          : fresh !== null
            ? fresh
            : trueAvailable;
        if (source === 'available' && amount > freshLedger) {
          toast.error(
            `Insufficient funds after refresh. Available: UGX ${freshLedger.toLocaleString()}.`,
            { duration: 8000 },
          );
          return false;
        }
      }

      // Force a fresh read of the platform-wide gate (paused/frozen/daily-
      // count) right before submitting — useWithdrawContext's cache can
      // now live up to 5 minutes, so don't trust whatever was true when
      // this flow opened. The balance figure itself is unaffected — that's
      // refetchLedger()/isStale above, a separate mechanism.
      const freshCtx = await withdrawCtx.refetch();
      if (freshCtx.data && !freshCtx.data.gates.canSubmit) {
        toast.error(freshCtx.data.gates.blockReason ?? 'Withdrawals are currently blocked', { duration: 8000 });
        return false;
      }

      // Event-driven completion: enter the Processing screen and submit to
      // the server NOW. We DO NOT rely on ProcessingScreen's animation
      // timer — the screen is just a "working…" indicator. As soon as the
      // server confirms (success OR failure), we react.
      setCurrentStep(5);
      setIsProcessing(true);
      setPaymentStatus('pending');
      const ok = await processWithdrawal();
      setIsProcessing(false);
      if (ok) {
        // Server confirmed — immediately show the live status receipt.
        setIsComplete(true);
      } else {
        // Server rejected or threw — bounce back to Verify so the user
        // can retry. `paymentStatus` is already 'failed' (set inside
        // processWithdrawal), and the idempotency key is preserved so a
        // retry collapses server-side.
        setCurrentStep(4);
      }
      // We managed currentStep ourselves; veto the stepper's auto-advance.
      return false;
    }
  };

  const renderStep = () => {
    switch (currentStep) {
      case 0:
        return (
          <div className="space-y-4">
            {!withdrawCtx.isLoading && !withdrawCtx.gates.canSubmit && (
              <div className="rounded-lg border-2 border-destructive bg-destructive/10 p-4 space-y-1">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-destructive" />
                  <h4 className="font-bold text-destructive">Withdrawal blocked</h4>
                </div>
                <p className="text-sm text-destructive/90">
                  {withdrawCtx.gates.blockReason ?? 'You cannot submit a withdrawal right now.'}
                </p>
              </div>
            )}
            <Label>Withdraw From</Label>
            <div className="space-y-3">
              <Card 
                className={`p-4 cursor-pointer transition-all ${source === 'available' ? 'ring-2 ring-primary border-primary' : 'hover:border-primary/50'}`}
                onClick={() => setSource('available')}
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                    <Wallet className="w-5 h-5 text-primary" />
                  </div>
                  <div className="flex-1">
                    <h4 className="font-semibold">Available to Withdraw</h4>
                    <p className="text-sm text-muted-foreground">
                      {advanceBalance > 0
                        ? `Withdrawable + Advance combined`
                        : 'Ready to withdraw'}
                    </p>
                  </div>
                  <span className="font-bold text-lg">{formatCurrency(trueAvailable, 'UGX')}</span>
                </div>
              </Card>
            </div>

            {(floatBalance > 0 || advanceBalance > 0) && (
              <div className="rounded-lg border border-dashed border-border bg-muted/30 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-foreground">Wallet bucket breakdown</p>
                  {userRoles.length > 1 && (
                    <span className="text-[10px] text-muted-foreground">
                      {userRoles.length} active roles
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">💰 Ledger-backed withdrawable</span>
                  <span className="font-medium text-foreground">{formatCurrency(trueAvailable, 'UGX')}</span>
                </div>
                {advanceBalance > 0 && (
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">📋 Advance (liability — not withdrawable)</span>
                    <span className="font-medium text-destructive">{formatCurrency(advanceBalance, 'UGX')}</span>
                  </div>
                )}
                {floatBalance > 0 && (
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">🔒 Operational Float (locked)</span>
                    <span className="font-medium text-muted-foreground">{formatCurrency(floatBalance, 'UGX')}</span>
                  </div>
                )}
                <p className="text-[10px] text-muted-foreground leading-relaxed pt-1 border-t border-border/40">
                  Only <span className="font-semibold text-foreground">Ledger-backed withdrawable</span> can be paid out. <span className="font-semibold text-foreground">Advance</span> is money you owe Welile, and <span className="font-semibold text-foreground">Operational Float</span> is company money reserved for agent/partner operations — neither can be withdrawn.
                </p>
              </div>
            )}
          </div>
        );

      case 1:
        return (
          <div className="space-y-6">
            <div className="space-y-2">
              <Label>Currency</Label>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SUPPORTED_CURRENCIES.map((curr) => (
                    <SelectItem key={curr} value={curr}>{curr}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="amount">Withdrawal Amount</Label>
              <Input
                id="amount"
                type="number"
                inputMode="numeric"
                value={amount === 0 ? '' : amount}
                onChange={(e) => {
                  // Allow the field to be fully cleared while typing — don't
                  // slam a persistent "0" back in on every keystroke.
                  const raw = e.target.value;
                  if (raw === '') {
                    setAmount(0);
                    return;
                  }
                  const v = Number(raw);
                  if (Number.isFinite(v)) setAmount(v);
                }}
                placeholder="0"
                max={maxAmount}
                min={MIN_WITHDRAWAL}
                className="text-2xl h-14 font-bold text-center"
                aria-invalid={amount > 0 && (amount < MIN_WITHDRAWAL || amount > maxAmount)}
              />
              <p className="text-xs text-muted-foreground text-center">
                Withdraw between {formatCurrency(MIN_WITHDRAWAL, currency)} and{' '}
                {formatCurrency(maxAmount, currency)}
              </p>
              {/* Inline validation — fires the moment the user crosses a
                  boundary so they don't tap Continue and get a silent no-op. */}
              {amount > 0 && amount < MIN_WITHDRAWAL && (
                <p className="text-xs text-destructive text-center font-medium">
                  Minimum withdrawal is {formatCurrency(MIN_WITHDRAWAL, currency)}
                </p>
              )}
              {amount > maxAmount && (
                <p className="text-xs text-destructive text-center font-medium">
                  Insufficient funds — exceeds available balance ({formatCurrency(maxAmount, currency)})
                </p>
              )}
              {/* Live ledger sync indicator — gates Continue */}
              <p className="text-[11px] text-center text-muted-foreground">
                {validating
                  ? 'Checking live ledger balance…'
                  : isStale
                    ? 'Balance may be stale — re-checking…'
                    : `Verified against live ledger · ${formatCurrency(maxAmount, currency)} available`}
              </p>
              {/* Zero-fee assurance — Welile wallet has no withdrawal fees,
                  so users see the full amount on the other side. */}
              <div className="flex items-center justify-center gap-2 text-xs font-semibold text-emerald-600 bg-emerald-500/5 border border-emerald-500/20 rounded-lg py-2">
                <BadgeCheck className="h-4 w-4" />
                Zero fees · You receive the full {formatCurrency(amount || 0, currency)}
              </div>
            </div>

            <div className="grid grid-cols-4 gap-2">
              {[0.25, 0.5, 0.75, 1].map((pct) => (
                <Button
                  key={pct}
                  variant={amount === Math.round(maxAmount * pct) ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setAmount(Math.round(maxAmount * pct))}
                >
                  {pct * 100}%
                </Button>
              ))}
            </div>
          </div>
        );

      // ═══ NEW: PAYOUT MODE SELECTION ═══
      case 2:
        return (
          <div className="space-y-4">
            <div className="text-center mb-2">
              <h3 className="font-semibold text-lg">How do you want to receive?</h3>
              <p className="text-sm text-muted-foreground mt-1">
                Choose your preferred payout method
              </p>
            </div>

            <div className="space-y-3">
              {PAYOUT_METHODS.filter((method) => method.value !== 'cash').map((method) => (
                <Card
                  key={method.value}
                  className={`p-4 cursor-pointer transition-all ${
                    payoutMode === method.value
                      ? 'ring-2 ring-primary border-primary bg-primary/5'
                      : 'hover:border-primary/50'
                  }`}
                  onClick={() => setPayoutMode(method.value as any)}
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center text-xl ${
                      method.value === 'mobile_money' ? 'bg-yellow-500/10' :
                      method.value === 'bank_transfer' ? 'bg-blue-500/10' :
                      'bg-emerald-500/10'
                    }`}>
                      {method.icon}
                    </div>
                    <div className="flex-1">
                      <h4 className="font-semibold">{method.label}</h4>
                      <p className="text-xs text-muted-foreground">
                        {method.value === 'mobile_money' && 'MTN or Airtel Mobile Money'}
                        {method.value === 'bank_transfer' && 'Direct bank deposit'}
                      </p>
                    </div>
                    {payoutMode === method.value && (
                      <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center">
                        <span className="text-white text-xs">✓</span>
                      </div>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          </div>
        );

      // ═══ PAYOUT DETAILS ═══
      case 3:
        // Filter saved methods to those compatible with the chosen payout
        // mode. Cash has no destination details to save, so the picker is
        // hidden in that case.
        const compatibleSaved = (savedMethods.data ?? []).filter(
          (m) => m.payout_mode === payoutMode,
        );
        return (
          <div className="space-y-5">
            {payoutMode !== 'cash' && !(payoutMode === 'mobile_money' && lockedMomo) && compatibleSaved.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-sm">Saved {payoutMode === 'mobile_money' ? 'mobile money' : 'bank'} destinations</Label>
                  {selectedSavedId && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={clearSavedSelection}
                    >
                      Use new
                    </Button>
                  )}
                </div>
                <div className="space-y-2 pr-1">
                  {compatibleSaved.map((m) => {
                    const isActive = selectedSavedId === m.id;
                    const title =
                      m.nickname?.trim() ||
                      (m.payout_mode === 'mobile_money'
                        ? `${m.momo_provider ?? ''} · ${m.momo_name ?? ''}`.trim()
                        : `${m.bank_name ?? ''} · ${m.bank_account_name ?? ''}`.trim());
                    const subtitle =
                      m.payout_mode === 'mobile_money'
                        ? m.momo_number ?? ''
                        : m.bank_account_number ?? '';
                    return (
                      <Card
                        key={m.id}
                        className={`p-3 cursor-pointer transition-all ${
                          isActive
                            ? 'ring-2 ring-primary border-primary bg-primary/5'
                            : 'hover:border-primary/50'
                        }`}
                        onClick={() => applySavedMethod(m)}
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center text-base">
                            {m.payout_mode === 'mobile_money' ? '📱' : '🏦'}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <p className="font-semibold text-sm truncate">{title || 'Saved method'}</p>
                              {m.is_default && (
                                <Star className="h-3 w-3 text-amber-500 fill-amber-500 shrink-0" />
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground truncate">{subtitle}</p>
                          </div>
                          <button
                            type="button"
                            aria-label="Delete saved method"
                            className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (confirm('Remove this saved destination?')) {
                                if (selectedSavedId === m.id) clearSavedSelection();
                                savedMethods.remove.mutate(m.id);
                              }
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </Card>
                    );
                  })}
                </div>
                <div className="relative py-1">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t border-border/60" />
                  </div>
                  <div className="relative flex justify-center text-[10px] uppercase tracking-wider">
                    <span className="bg-background px-2 text-muted-foreground">
                      or enter new details
                    </span>
                  </div>
                </div>
              </div>
            )}

            {payoutMode === 'mobile_money' && lockedMomo && (
              <div className="space-y-3">
                <div className="text-center mb-1">
                  <h3 className="font-semibold text-lg">📱 Mobile Money Details</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    Funds are paid to your registered withdrawal account
                  </p>
                </div>
                <Card className="p-4 space-y-2 bg-muted/40">
                  <div className="flex items-center justify-between">
                    <span className="text-xs uppercase tracking-wider text-muted-foreground">Number</span>
                    <span className="font-bold tracking-wide">{lockedMomo.number}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs uppercase tracking-wider text-muted-foreground">Provider</span>
                    <span className="font-semibold">{lockedMomo.provider}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs uppercase tracking-wider text-muted-foreground">Name</span>
                    <span className="font-semibold text-right truncate">{lockedMomo.name}</span>
                  </div>
                </Card>
                <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                  <Lock className="h-3.5 w-3.5" />
                  Locked to your account. To change it, go to Settings →
                  Withdrawal account.
                </p>
              </div>
            )}

            {payoutMode === 'mobile_money' && !lockedMomo && (
              <>
                <div className="text-center mb-2">
                  <h3 className="font-semibold text-lg">📱 Mobile Money Details</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    Enter the mobile money number to receive funds
                  </p>
                </div>

                <div className="space-y-2">
                  <Label>Mobile Money Provider</Label>
                  <RadioGroup
                    value={momoProvider}
                    onValueChange={(v) => setMomoProvider(v as 'MTN' | 'Airtel')}
                    className="flex gap-4"
                  >
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="MTN" id="withdraw-mtn" />
                      <Label htmlFor="withdraw-mtn" className="font-medium text-yellow-600 cursor-pointer">MTN</Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="Airtel" id="withdraw-airtel" />
                      <Label htmlFor="withdraw-airtel" className="font-medium text-red-600 cursor-pointer">Airtel</Label>
                    </div>
                  </RadioGroup>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="momo-number">Mobile Money Number</Label>
                  <div className="relative">
                    <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="momo-number"
                      type="tel"
                      placeholder="e.g. 0770123456"
                      value={momoNumber}
                      onChange={(e) => {
                        const v = e.target.value;
                        clearSavedSelection();
                        setMomoNumber(v);
                        // Auto-correct provider from operator prefix —
                        // prevents the #1 disbursement failure (wrong network).
                        const detected = detectMomoProvider(v);
                        if (detected && detected !== momoProvider) {
                          setMomoProvider(detected);
                          toast.info(`Detected ${detected} number — provider switched.`);
                        }
                      }}
                      className="h-12 text-base pl-10"
                    />
                  </div>
                  {momoNumber && !detectMomoProvider(momoNumber) && momoNumber.replace(/\D/g, '').length >= 3 && (
                    <p className="text-[10px] text-amber-600">
                      Unrecognised prefix — double-check the number matches the provider above.
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="momo-name">Registered Name (as shown on Mobile Money)</Label>
                  <Input
                    id="momo-name"
                    type="text"
                    placeholder="e.g. JOHN DOE"
                    value={momoName}
                    onChange={(e) => { clearSavedSelection(); setMomoName(e.target.value); }}
                    className="h-12 text-base"
                  />
                </div>
              </>
            )}

            {payoutMode === 'bank_transfer' && (
              <>
                <div className="text-center mb-2">
                  <h3 className="font-semibold text-lg">🏦 Bank Account Details</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    Enter the bank account to receive your funds
                  </p>
                </div>

                <div className="space-y-2">
                  <Label>Bank Name</Label>
                  <Select value={bankName} onValueChange={(v) => { clearSavedSelection(); setBankName(v); }}>
                    <SelectTrigger className="h-12">
                      <SelectValue placeholder="Select your bank..." />
                    </SelectTrigger>
                    <SelectContent className="max-h-60">
                      {UGANDA_BANKS.map(b => (
                        <SelectItem key={b} value={b}>{b}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Account Holder Name</Label>
                  <div className="relative">
                    <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      type="text"
                      placeholder="e.g. JOHN DOE"
                      value={bankAccountName}
                      onChange={(e) => { clearSavedSelection(); setBankAccountName(e.target.value); }}
                      className="h-12 text-base pl-10"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Account Number</Label>
                  <div className="relative">
                    <Banknote className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      type="text"
                      placeholder="e.g. 9030012345678"
                      value={bankAccountNumber}
                      onChange={(e) => { clearSavedSelection(); setBankAccountNumber(e.target.value); }}
                      className="h-12 text-base pl-10"
                    />
                  </div>
                </div>
              </>
            )}

            {payoutMode !== 'cash' && !selectedSavedId && (
              <div className="rounded-lg border border-border/60 bg-muted/20 p-3 space-y-3">
                <label className="flex items-start gap-2 cursor-pointer">
                  <Checkbox
                    checked={saveAsNew}
                    onCheckedChange={(v) => setSaveAsNew(v === true)}
                    className="mt-0.5"
                  />
                  <div className="flex-1">
                    <p className="text-sm font-medium">Save this destination for next time</p>
                    <p className="text-xs text-muted-foreground">
                      Skip re-typing on your next withdrawal.
                    </p>
                  </div>
                </label>
                {saveAsNew && (
                  <Input
                    type="text"
                    placeholder="Nickname (optional, e.g. My MTN, Stanbic salary)"
                    value={savedNickname}
                    onChange={(e) => setSavedNickname(e.target.value)}
                    className="h-10 text-sm"
                  />
                )}
              </div>
            )}

            {payoutMode === 'cash' && (
              <div className="space-y-4">
                <div className="text-center mb-2">
                  <h3 className="font-semibold text-lg">💵 Cash Pickup</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    You will collect your funds at the office
                  </p>
                </div>

                <Card className="p-4 bg-emerald-500/5 border-emerald-500/20">
                  <div className="space-y-2 text-sm">
                    <p className="font-bold text-foreground">How it works:</p>
                    <ol className="list-decimal list-inside space-y-1 text-muted-foreground text-xs">
                      <li>Your request will be reviewed by a manager</li>
                      <li>Once approved, you'll be notified</li>
                      <li>Visit the office with your ID to collect</li>
                    </ol>
                  </div>
                </Card>
              </div>
            )}

            {/* Reason / purpose — determines the payout category and which
                Cash-Out Agents can process this withdrawal. */}
            <div className="space-y-2 pt-2 border-t border-border/60">
              <Label>Reason for withdrawal</Label>
              <Select value={reasonPreset} onValueChange={setReasonPreset}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a reason" />
                </SelectTrigger>
                <SelectContent>
                  {WITHDRAWAL_REASON_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                  <SelectItem value={OTHER_WITHDRAWAL_REASON}>Other (specify)</SelectItem>
                </SelectContent>
              </Select>
              {reasonPreset === OTHER_WITHDRAWAL_REASON && (
                <Input
                  value={reasonCustom}
                  onChange={(e) => setReasonCustom(e.target.value)}
                  placeholder="Enter your reason"
                  maxLength={200}
                />
              )}
              <p className="text-[11px] text-muted-foreground">
                Helps route your withdrawal to the right payout desk.
              </p>
            </div>
          </div>
        );

      case 4:
        return (
          <div className="space-y-6 text-center">
            {paymentStatus === 'failed' && (
              <div
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-left text-xs text-destructive"
              >
                {lastFailureMessage || 'Last attempt did not go through.'} Tap Confirm to retry — your request will be reused if it actually reached our servers.
              </div>
            )}
            <div className="w-16 h-16 mx-auto rounded-full bg-primary/10 flex items-center justify-center">
              <Lock className="w-8 h-8 text-primary" />
            </div>
            
            <div>
              <h3 className="font-semibold text-lg">Confirm Withdrawal</h3>
              <p className="text-sm text-muted-foreground mt-1">
                Review the details below and tap Confirm to submit.
              </p>
            </div>

            {/* Always surface ledger freshness — explains why Confirm may
                feel slow, and reassures the user we just checked. */}
            {(() => {
              const secsAgo = ledgerCheckedAt
                ? Math.max(0, Math.round((Date.now() - ledgerCheckedAt) / 1000))
                : null;
              const refreshLabel =
                secsAgo === null
                  ? 'never'
                  : secsAgo < 5
                  ? 'just now'
                  : secsAgo < 60
                  ? `${secsAgo}s ago`
                  : `${Math.round(secsAgo / 60)}m ago`;

              let reason: string | null = null;
              if (validating) {
                reason = 'Re-checking your available balance with the ledger…';
              } else if (isStale) {
                reason =
                  'Your balance snapshot is stale. Tapping Confirm will refresh it first, then proceed automatically.';
              } else if (ledgerAvailable === null) {
                reason = 'Waiting for your ledger balance to load…';
              } else if (amount > maxAmount) {
                reason = `Amount exceeds your available balance (UGX ${maxAmount.toLocaleString()}).`;
              }

              return (
                <div
                  role="status"
                  aria-live="polite"
                  className="rounded-md border border-border bg-muted/30 px-3 py-2 text-left space-y-1"
                >
                  {reason && (
                    <p className="text-xs text-foreground">{reason}</p>
                  )}
                  <p className="text-[11px] text-muted-foreground flex items-center justify-between gap-2">
                    <span>Balance checked: {refreshLabel}</span>
                    <button
                      type="button"
                      onClick={() => refetchLedger()}
                      disabled={validating}
                      className="underline underline-offset-2 hover:text-foreground disabled:opacity-50"
                    >
                      {validating ? 'Refreshing…' : 'Refresh now'}
                    </button>
                  </p>
                </div>
              );
            })()}

            <ConfirmSummaryCard
              title="Withdrawal Summary"
              items={[
                { label: 'Wallet', value: source === 'available' ? '💼 Available Balance' : '📈 Returns Earnings' },
                { label: 'Amount', value: formatCurrency(amount, currency), highlight: true },
                { label: 'Payout Mode', value: payoutMode === 'mobile_money' ? '📱 Mobile Money' : payoutMode === 'bank_transfer' ? '🏦 Bank Transfer' : '💵 Cash Pickup' },
                { label: 'To', value: getPayoutSummary() },
                { label: 'Name', value: getPayoutName() },
                { label: 'Reason', value: effectiveReason || '—' },
              ]}
              fees={[
                { label: 'Withdrawal fee', value: 'Free' },
                { label: 'Available balance', value: formatCurrency(maxAmount, currency) },
                {
                  label: 'Balance after withdrawal',
                  value: formatCurrency(Math.max(0, maxAmount - amount), currency),
                },
              ]}
              total={{ label: "You'll Receive", value: formatCurrency(amount, currency) }}
              showSecurityNote={false}
            />
          </div>
        );

      case 5:
        if (isProcessing) {
          // No animated timer — we leave the spinner up until the actual
          // server submission (kicked off in handleNext) resolves and
          // flips `isProcessing` to false.
          return <ProcessingScreen autoProgress={false} />;
        }
        // Submission failed before a row was created — fall back to the
        // legacy receipt so the user can see the failure + retry.
        if (!createdRequestId || paymentStatus === 'failed') {
          return (
            <ReceiptCard
              status={paymentStatus === 'pending' ? 'pending' : paymentStatus}
              amount={amount}
              currency={currency}
              fees={0}
              recipient={getPayoutSummary()}
              reference={withdrawalRef || 'PENDING'}
              method={payoutMode === 'mobile_money' ? 'Mobile Money' : payoutMode === 'bank_transfer' ? 'Bank Transfer' : 'Cash Pickup'}
              date={new Date()}
              onDownload={() => {}}
              onShare={() => {}}
              onTryAgain={() => setCurrentStep(2)}
              onChangeMethod={() => setCurrentStep(2)}
              onContactSupport={() => {}}
              onClose={handleClose}
            />
          );
        }
        // Live status tracker — subscribes to withdrawal_requests and
        // updates Submitted → Ops review → Disbursed in realtime, with a
        // self-cancel button while still pending.
        return (
          <div className="space-y-4">
            {payoutMode === 'cash' && cashPickupCode && (
              <div className="rounded-xl border-2 border-amber-500/50 bg-amber-50 dark:bg-amber-500/10 p-4 text-center space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-700">
                  Your withdrawal code — read it to Financial Ops
                </p>
                <p className="font-mono text-3xl font-bold tracking-[0.2em] text-amber-900 dark:text-amber-200">
                  {cashPickupCode}
                </p>
                <p className="text-xs text-amber-800 dark:text-amber-200">
                  Read this code to Financial Ops to release {formatCurrency(amount, currency)}.
                  Your wallet is reduced the moment they enter it. A copy was also emailed to you.
                </p>
                <div className="flex items-center justify-center gap-2 mt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      try {
                        navigator.clipboard?.writeText(cashPickupCode);
                        toast.success('Code copied');
                      } catch {
                        /* clipboard unavailable — code is still visible on screen */
                      }
                    }}
                  >
                    Copy code
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={resendingCode || resendRemaining > 0}
                    onClick={() => void handleResendCode()}
                  >
                    {resendingCode
                      ? 'Sending…'
                      : resendRemaining > 0
                        ? `Resend in ${resendRemaining}s`
                        : 'Resend code'}
                  </Button>
                </div>
                <p className="text-[10px] text-amber-700/80 dark:text-amber-200/70">
                  A new code can be issued once this one expires or after a short wait.
                </p>
              </div>
            )}
            {/* Server-confirmed receipt — shown immediately after the
                withdrawal_requests insert returns. Contains the
                reference ID, processed date/time and verified amount.
                Disbursement status continues to update live below. */}
            {(
              <>
              <ReceiptCard
              status="pending"
              amount={amount}
              currency={currency}
              fees={0}
              recipient={getPayoutSummary()}
              reference={withdrawalRef || 'PENDING'}
              method={payoutMode === 'mobile_money' ? 'Mobile Money' : payoutMode === 'bank_transfer' ? 'Bank Transfer' : 'Cash Pickup'}
              date={submittedAt ?? new Date()}
              onDownload={async () => {
                try {
                  await downloadWithdrawalReceiptPdf(buildReceiptPayload());
                  toast.success('Receipt downloaded');
                } catch (e) {
                  console.error('[WithdrawFlow] receipt PDF failed', e);
                  toast.error('Could not generate PDF receipt');
                }
              }}
              onShare={async () => {
                const payload = buildReceiptPayload();
                try {
                  const shared = await shareWithdrawalReceiptPdf(payload);
                  if (!shared) {
                    // Platform can't share files (desktop Chrome, etc.) —
                    // fall back to a normal download so the user still
                    // gets the file and can share it manually.
                    await downloadWithdrawalReceiptPdf(payload);
                    toast.info('Sharing not supported here — receipt downloaded instead.');
                  }
                } catch (e) {
                  console.error('[WithdrawFlow] receipt share failed', e);
                  toast.error('Could not share receipt');
                }
              }}
            />
            <WithdrawalStatusTracker
              requestId={createdRequestId}
              amount={amount}
              currency={currency}
              recipientLabel={getPayoutSummary()}
              reference={withdrawalRef || 'PENDING'}
              onClose={handleClose}
              onRetry={() => {
                // 24h-stuck retry: clear the tracker state and drop the
                // user back at the method-selection step so they can
                // resubmit with the same recipient details intact.
                setCreatedRequestId(null);
                setPaymentStatus('pending');
                clientRequestIdRef.current = null;
                setCurrentStep(2);
                toast.info('Previous request cancelled. Confirm the details to resubmit.');
              }}
            />
              </>
            )}
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <StepperModal
      open={open}
      onOpenChange={handleClose}
      title="Withdraw Funds"
      steps={STEPS}
      currentStep={currentStep}
      onStepChange={(next) => {
        // When the user navigates back to edit amount/method/details after a
        // failed submission, clear the stale 'failed' banner. The next
        // Confirm attempt will re-set the status honestly.
        if (next < currentStep && paymentStatus === 'failed') {
          setPaymentStatus('pending');
          setLastFailureMessage(null);
        }
        setCurrentStep(next);
      }}
      canGoNext={canProceed()}
      onNext={handleNext}
      showNavigation={currentStep < 5 && !isProcessing && !isComplete}
      nextLabel={currentStep === 4 ? 'Confirm Withdrawal' : 'Continue'}
      nextBusy={currentStep === 4 && validating}
      nextBusyLabel="Refreshing balance…"
      isProcessing={isProcessing}
      isComplete={isComplete}
    >
      {renderStep()}
    </StepperModal>
  );
}
