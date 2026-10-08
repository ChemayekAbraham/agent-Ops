import { useState, useEffect, useRef } from 'react';
import airtelLogo from '@/assets/airtel-logo.jpeg.asset.json';
import { useCurrency } from '@/hooks/useCurrency';
import { useNavigate } from 'react-router-dom';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Loader2, CheckCircle2, Phone, Calendar, Clock, Hash, AlertCircle, History, Building2, Banknote, Upload, Receipt, Copy, ShieldAlert, ClipboardPaste, Camera, X, ImageIcon, ChevronLeft, Info } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import OperationalFloatTenantAllocator, {
  encodeAllocationsNote,
  decodeAllocationsFromNote,
  type TenantAllocation,
} from './OperationalFloatTenantAllocator';
import DepositReferenceMatcher, { type MatchResult } from './DepositReferenceMatcher';
import CashWithFinancialOpsDeposit from './CashWithFinancialOpsDeposit';
import AllocationEditDiffPanel from './AllocationEditDiffPanel';
import {
  safeDepositPurpose,
  ALLOWED_DEPOSIT_PURPOSES as SHARED_ALLOWED_DEPOSIT_PURPOSES,
  type DepositPurpose as SharedDepositPurpose,
} from '@/lib/depositPurposeGuard';
import { parseSMS } from '@/utils/smsParser';
import { cn } from '@/lib/utils';
import { validateDepositReference } from '@/lib/depositReferenceValidator';
import { archiveToDrive } from '@/lib/archiveToDrive';
import { useHorizontalSwipe } from '@/hooks/useHorizontalSwipe';
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard';
import savingsBroAsset from '@/assets/Savings-bro.svg.asset.json';
import mtnLogoAsset from '@/assets/mtn-logo.png.asset.json';
import airtelLogoAsset from '@/assets/airtel-logo.jpg.asset.json';
import equityLogoAsset from '@/assets/equity-logo.jpg.asset.json';

/**
 * Extract a Mobile Money / bank reference from arbitrary SMS text.
 * Looks for the first matching token by priority:
 *   1. MTN MoMo "MP" + 8-14 digits
 *   2. Airtel "TID" + 6-15 digits
 *   3. Generic bank "FT" + 8-14 chars
 * Returns the uppercased token or null if nothing recognisable was found.
 */
function extractTidFromText(raw: string): string | null {
  if (!raw) return null;
  const s = raw.toUpperCase().replace(/\s+/g, ' ');
  const mtn = s.match(/\bMP\d{6,16}\b/);
  if (mtn) return mtn[0];
  const airtel = s.match(/\bTID\d{4,18}\b/);
  if (airtel) return airtel[0];
  const bank = s.match(/\bFT[A-Z0-9]{6,18}\b/);
  if (bank) return bank[0];
  return null;
}

type DepositChannel = 'momo' | 'bank' | 'agent_cash' | 'cash';
type DepositPurpose = SharedDepositPurpose;

/**
 * Allowlist that mirrors the Postgres `deposit_purpose` enum exactly.
 * Used as the FINAL gate in handleSubmit so an empty string or any
 * stale/legacy value can never reach the database (which would otherwise
 * raise the cryptic `invalid input value for enum deposit_purpose: ""`
 * error and leave the agent staring at a dead Confirm button).
 */
const ALLOWED_DEPOSIT_PURPOSES: readonly DepositPurpose[] = SHARED_ALLOWED_DEPOSIT_PURPOSES;

interface DepositFlowProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  walletBalance?: number;
  /** Pre-select a deposit purpose (e.g. 'operational_float' for agents). */
  defaultPurpose?: DepositPurpose;
  /** Restrict the purpose grid to only these options. */
  allowedPurposes?: DepositPurpose[];
  /** Hide the purpose grid behind a "Change purpose" link. */
  lockPurpose?: boolean;
  /**
   * Force a mandatory purpose-choice screen BEFORE the channel/form.
   * When true: no defaultPurpose is applied, and the user must explicitly
   * pick a purpose (from allowedPurposes) before continuing. Eliminates
   * the "tap-through and mis-bucket" failure mode for agents.
   */
  requirePurposeChoice?: boolean;
  /**
   * Edit mode: when set, the dialog loads the given pending deposit
   * request, prefills every field (including the per-tenant allocation
   * breakdown decoded from `notes`), and the submit handler issues an
   * UPDATE instead of an INSERT. Only `status='pending'` rows are
   * editable — anything reviewed/approved/rejected falls back to a
   * read-only toast and closes.
   */
  editRequestId?: string | null;
  /**
   * Optional handoff from the dashboard "Collect from receipt/reference"
   * entry point. When supplied, the dialog opens straight on the
   * Operational Float form with the matched amount, per-tenant
   * allocations, reference, and channel pre-applied — no need for the
   * agent to re-paste the TID into the in-form matcher.
   */
  prefillFromMatch?: MatchResult | null;
  /** Pre-fill the amount field (UGX) and skip straight to the form. */
  defaultAmount?: number;
  /** Pre-select the payment channel (skips the channel picker). */
  defaultChannel?: DepositChannel;
  /** Pre-select the mobile money provider when `defaultChannel` is 'momo'. */
  defaultMomoProvider?: 'mtn' | 'airtel';
}

const DEPOSIT_PURPOSES: { id: DepositPurpose; label: string; emoji: string; desc: string }[] = [
  { id: 'operational_float', emoji: '🏘️', label: 'Operational Float', desc: 'Cash collected from tenants in the field' },
  { id: 'personal_deposit', emoji: '💰', label: 'Personal Deposit', desc: 'Your own money top-up' },
  { id: 'partnership_deposit', emoji: '🤝', label: 'Supporter Wallet Top-Up', desc: 'Top up your supporter wallet. Funds stay in your wallet until you choose to fund tenants or build a portfolio.' },
  { id: 'personal_rent_repayment', emoji: '🏠', label: 'Personal Rent Repayment', desc: 'Paying your own rent' },
  { id: 'other', emoji: '📝', label: 'Other', desc: 'Specify your own reason' },
];

const MERCHANT_CODES = {
  mtn: '090777',
  airtel: '4380664',
};

const MERCHANT_NAME = 'WELILE TECHNOLOGIES LIMITTED';

const BANK_DETAILS = {
  bankName: 'Equity Bank Uganda',
  branch: 'Entebbe Branch',
  accountName: 'WELILE TECHNOLOGIES LIMITED',
  accountNumber: '1046203375259',
  currency: 'UGX',
  swiftCode: 'EQBLUGKA',
};

const QUICK_AMOUNTS = [50000, 100000, 250000, 500000];

/** Deposit limits in UGX (raw, never formatted). Mirrored in the UI hint
 *  under the amount input so users see exactly what's enforced. */
const MIN_DEPOSIT = 500;
const MAX_DEPOSIT = 1_000_000_000;

export default function DepositFlow({ open, onOpenChange, defaultPurpose, allowedPurposes, lockPurpose, requirePurposeChoice, editRequestId, prefillFromMatch, defaultAmount, defaultChannel, defaultMomoProvider }: DepositFlowProps) {
  const navigate = useNavigate();
  const { roles } = useAuth();
  /**
   * Agents are field cash collectors first. Per company policy, a deposit
   * landing in their wallet should be Operational Float (company money,
   * float bucket) by default — NOT Personal Deposit (which would land in
   * withdrawable). Agents can still submit a personal top-up, but only
   * after explicitly confirming via the in-form gate so the choice is
   * intentional and auditable.
   */
  const isAgent = Array.isArray(roles) && roles.includes('agent' as any);
  // Stamped on the audit blob when an agent acknowledges the personal-money gate.
  const [agentPersonalConfirmedAt, setAgentPersonalConfirmedAt] = useState<string | null>(null);
  // Pending switch the agent has clicked but not yet confirmed/cancelled.
  const [pendingPersonalChoice, setPendingPersonalChoice] = useState<boolean>(false);
  /**
   * Universal purpose-capture rule: if a caller didn't pre-select a purpose
   * AND didn't explicitly request the gate, we still force the gate. This
   * guarantees EVERY dashboard (tenant, agent, supporter, landlord, …)
   * captures an explicit deposit purpose — never an empty / inferred one.
   * Callers that pin a purpose via `defaultPurpose` (e.g. supporter top-up)
   * keep their existing skip-the-gate behaviour.
   */
  const mustChoosePurpose = requirePurposeChoice || !defaultPurpose;
  const [step, setStep] = useState<'purpose' | 'channel' | 'form' | 'submitting' | 'success'>(
    mustChoosePurpose ? 'purpose' : 'channel'
  );
  const [channel, setChannel] = useState<DepositChannel>('momo');
  const [momoProvider, setMomoProvider] = useState<'mtn' | 'airtel'>('mtn');
  const [amount, setAmount] = useState('');
  const [transactionId, setTransactionId] = useState('');
  const [receiptNumber, setReceiptNumber] = useState('');
  const [agentName, setAgentName] = useState('');
  const [transactionDate, setTransactionDate] = useState('');
  const [transactionTime, setTransactionTime] = useState('');
  const [reason, setReason] = useState('');
  const [depositPurpose, setDepositPurpose] = useState<DepositPurpose | ''>(
    mustChoosePurpose ? '' : (defaultPurpose ?? '')
  );
  const [showPurposeGrid, setShowPurposeGrid] = useState<boolean>(!lockPurpose);
  /**
   * Closure-bypass override for the silent-recovery path. When the user
   * clicks Confirm with an empty `depositPurpose` but `defaultPurpose +
   * lockPurpose` are set, we want to submit immediately without waiting
   * for React to flush `setDepositPurpose(...)`. Functions called from
   * the same tick still see the OLD `depositPurpose` via closure, so
   * `validateForm`/`computeBlockReason`/`handleSubmit` all consult this
   * ref first and treat its value as the effective purpose for one
   * submit. Cleared right after the submit is consumed.
   */
  const purposeOverrideRef = useRef<DepositPurpose | null>(null);
  const [bankSlipFile, setBankSlipFile] = useState<File | null>(null);
  // Object URL for the local slip preview thumbnail. Revoked on cleanup
  // so we don't leak blob memory across multiple re-uploads.
  const [bankSlipPreview, setBankSlipPreview] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [tidError, setTidError] = useState('');
  /**
   * The DOM id of the field that's currently failing validation. Set
   * when the agent taps Confirm with a missing/invalid field so we can
   * paint that input with a red ring (not just toast + scroll). Cleared
   * the moment the offending field becomes valid (computed live from
   * `computeBlockReason()` — no manual clearing needed on every onChange).
   */
  const [errorFieldId, setErrorFieldId] = useState<string | null>(null);
  /**
   * Full diagnostics for the last failed submit attempt. Surfaced as a
   * persistent in-form panel (not just a toast) so the user can read the
   * raw edge-function / database response, copy it for support, and see
   * an HTTP status code when one is available. Cleared on next submit,
   * on successful submit, or when the user dismisses the panel.
   */
  const [submitError, setSubmitError] = useState<{
    message: string;
    status?: number | string;
    code?: string;
    details?: string;
    hint?: string;
    body?: string;
    raw: string;
    at: string;
  } | null>(null);
  const [showRawError, setShowRawError] = useState(false);
  /**
   * Controls the "Paste SMS" sheet. When open, the agent pastes the
   * full SMS body into a textarea and we parse it on submit. Far more
   * reliable than `navigator.clipboard.readText()` which Safari, in-app
   * browsers, and most Android WebViews silently deny.
   */
  const [smsPasteOpen, setSmsPasteOpen] = useState(false);
  const [smsPasteText, setSmsPasteText] = useState('');
  const [smsConfirmStep, setSmsConfirmStep] = useState(false);
  /**
   * Per-tenant breakdown for an Operational Float deposit. The agent
   * collected one bulk amount in the field, dropped it at the merchant
   * code under one TID, and now needs to tell us *which tenants* it came
   * from. Empty for non-op-float deposits.
   */
  const [tenantAllocations, setTenantAllocations] = useState<TenantAllocation[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  /**
   * Agent's explicit choice for Operational Float drops:
   *   • 'pending' — haven't picked yet, show the chooser card.
   *   • 'no'      — bulk float drop, no per-tenant breakdown.
   *   • 'yes'     — wants to tag each tenant individually.
   *
   * Many field agents don't see/understand the per-tenant allocator,
   * so we surface a clear binary choice instead of dropping them
   * straight into the allocator. Auto-set to 'yes' when allocations
   * already exist (edit mode, matcher prefill).
   */
  const [breakdownChoice, setBreakdownChoice] = useState<'pending' | 'no' | 'yes'>('pending');
  /**
   * Edit-mode snapshot of the per-tenant breakdown as it was when the
   * dialog opened. Used purely for the in-form "Original vs Updated"
   * diff panel so the agent can eyeball every change before saving.
   * Reset to [] for fresh deposits and on close.
   */
  const [originalAllocations, setOriginalAllocations] = useState<TenantAllocation[]>([]);
  const [originalAmount, setOriginalAmount] = useState<number | null>(null);
  // Audit: capture the exact moment the user picked the purpose + which UI surface asked them.
  const [purposeChosenAt, setPurposeChosenAt] = useState<string | null>(null);
  const [purposeEntryPoint, setPurposeEntryPoint] = useState<'gate' | 'default' | 'in_form'>(
    mustChoosePurpose ? 'gate' : (defaultPurpose ? 'default' : 'in_form')
  );
  /**
   * Edit-mode bookkeeping. `editLoading` flips on while we hydrate the
   * existing row from `deposit_requests`; the dialog shows a small
   * "Loading…" state to avoid flashing an empty form. We snapshot the
   * original allocations payload so handleSubmit can re-encode notes the
   * same way it was created (and so we can detect "nothing changed").
   */
  // Either the parent supplied an edit target (UserDepositRequests "Edit
  // allocations" button) OR the in-form Reference Matcher discovered a
  // pending deposit and asked us to flip into edit mode for that row.
  const [matchedEditId, setMatchedEditId] = useState<string | null>(null);
  const activeEditId = editRequestId ?? matchedEditId;
  const isEditMode = !!activeEditId;
  const [editLoading, setEditLoading] = useState(false);
  // Status of the row being edited — 'pending' goes through a direct
  // RLS-restricted UPDATE; 'rejected' goes through the
  // resubmit_rejected_deposit RPC (which flips status back to pending).
  const [editStatus, setEditStatus] = useState<'pending' | 'rejected' | null>(null);

  /**
   * Live duplicate-TID check. Whenever the agent finishes typing/pasting
   * a transaction id (or receipt number), we run the same indexed lookup
   * the submit-time guard uses and surface the conflicting row's status
   * through the standard inline blocker. Replaces the old "older than 7
   * days" date heuristic, which rejected perfectly valid SMS just because
   * the agent uploaded them late.
   */
  const [duplicateTidStatus, setDuplicateTidStatus] = useState<string | null>(null);
  // Cash-with-Financial-Ops code deposit (separate self-contained dialog).
  const [showFinOpsCashDeposit, setShowFinOpsCashDeposit] = useState(false);

  /**
   * Edit-mode fallback bookkeeping.
   *
   * When the Reference Matcher tells us "I found a pending deposit, flip
   * into edit mode for it", we stash two things:
   *
   *   • `pendingMatchFallbackRef` — the ref / amount / provider hint that
   *     should be applied IF the hydrator can't actually open the row
   *     (deleted, already approved, network blip, RLS).
   *   • `preEditSnapshotRef` — the agent's in-progress allocations,
   *     amount and TID, captured at the instant we requested the flip.
   *     If the flip fails we restore this so the agent doesn't lose
   *     their work — we just pre-fill the reference and amount on top
   *     of what they already had.
   */
  const pendingMatchFallbackRef = useRef<{
    reference: string;
    amount: number;
    providerHint?: 'mtn' | 'airtel' | 'bank';
  } | null>(null);
  const preEditSnapshotRef = useRef<{
    allocations: typeof tenantAllocations;
    amount: string;
    transactionId: string;
    receiptNumber: string;
  } | null>(null);

  /**
   * Restore the agent's in-progress state and pre-fill ref + amount from
   * the stashed match. Used when edit-mode hydration fails for any
   * reason. Idempotent — safe to call once per failed flip.
   */
  const applyMatchFallback = (failureReason: string) => {
    const fallback = pendingMatchFallbackRef.current;
    const snapshot = preEditSnapshotRef.current;
    pendingMatchFallbackRef.current = null;
    preEditSnapshotRef.current = null;
    if (!fallback) return false;

    // Drop edit mode so the form treats this as a fresh deposit again.
    setMatchedEditId(null);

    // Restore the agent's previous allocations + entered amount/ref.
    if (snapshot) {
      setTenantAllocations(snapshot.allocations);
      if (snapshot.amount) setAmount(snapshot.amount);
      if (snapshot.transactionId) setTransactionId(snapshot.transactionId);
      if (snapshot.receiptNumber) setReceiptNumber(snapshot.receiptNumber);
    }

    // Pre-fill amount only if the agent hadn't typed one — never clobber
    // a number they already entered.
    const hadAmount = !!(snapshot?.amount && parseFloat(snapshot.amount) > 0);
    if (!hadAmount && fallback.amount > 0) {
      setAmount(String(fallback.amount));
    }

    // Pre-fill the reference into the right field for the active channel.
    if (fallback.providerHint === 'mtn' || fallback.providerHint === 'airtel') {
      setChannel('momo');
      setMomoProvider(fallback.providerHint);
      setTransactionId(fallback.reference);
    } else if (fallback.providerHint === 'bank') {
      setChannel('bank');
      setTransactionId(fallback.reference);
    } else {
      // Unknown provider — leave channel as-is and put the ref in the
      // currently-active field so the agent sees it.
      setTransactionId(fallback.reference);
    }

    toast.message('Kept your current allocations', {
      description: `${failureReason} — pre-filled the reference (${fallback.reference})${fallback.amount > 0 && !hadAmount ? ` and amount (${fallback.amount.toLocaleString()})` : ''} so you can continue.`,
      duration: 6000,
    });
    return true;
  };

  /**
   * Generate / clean up a preview blob URL whenever the slip file changes.
   * PDFs don't render in <img>, so we just keep the filename badge for those.
   */
  useEffect(() => {
    if (!bankSlipFile || !bankSlipFile.type.startsWith('image/')) {
      setBankSlipPreview(null);
      return;
    }
    const url = URL.createObjectURL(bankSlipFile);
    setBankSlipPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [bankSlipFile]);

  // Resolve the current user once so the allocator can scope its tenant
  // search without each render hitting auth.getUser().
  useEffect(() => {
    let cancelled = false;
    supabase.auth.getUser().then(({ data }) => {
      if (!cancelled) setCurrentUserId(data?.user?.id ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /* ─── Draft autosave / restore ───
   * Smartphone users frequently background the app (incoming call, SMS to
   * copy the MoMo confirmation, switching to MyMTN). Losing typed amount /
   * TID / reason on every interruption was the #1 friction point in the
   * deposit flow. We persist a per-user snapshot to localStorage on every
   * relevant change and silently rehydrate the next time the dialog opens.
   *
   * Skipped in edit mode (we already prefill from the DB row) and when the
   * caller pins `lockPurpose` (top-up flows that pre-decide the purpose). */
  const draftKey = currentUserId
    ? `welile.depositDraft.${currentUserId}`
    : null;
  const draftSuppressRef = useRef(false);
  const draftRestoredRef = useRef(false);
  const clearDraft = () => {
    draftSuppressRef.current = true;
    if (draftKey) {
      try { localStorage.removeItem(draftKey); } catch { /* quota / safari */ }
    }
  };

  // Restore once per dialog opening.
  useEffect(() => {
    if (!open) { draftRestoredRef.current = false; draftSuppressRef.current = false; return; }
    if (draftRestoredRef.current) return;
    if (!draftKey || isEditMode || lockPurpose) return;
    let raw: string | null = null;
    try { raw = localStorage.getItem(draftKey); } catch { return; }
    if (!raw) { draftRestoredRef.current = true; return; }
    try {
      const d = JSON.parse(raw) as Record<string, unknown>;
      // Drafts older than 7 days are stale — discard.
      const savedAt = typeof d._savedAt === 'number' ? d._savedAt : 0;
      if (Date.now() - savedAt > 7 * 24 * 60 * 60 * 1000) {
        localStorage.removeItem(draftKey);
        draftRestoredRef.current = true;
        return;
      }
      if (typeof d.step === 'string' && ['purpose', 'channel', 'form'].includes(d.step)) {
        setStep(d.step as 'purpose' | 'channel' | 'form');
      }
      if (typeof d.channel === 'string') setChannel(d.channel as DepositChannel);
      if (d.momoProvider === 'mtn' || d.momoProvider === 'airtel') setMomoProvider(d.momoProvider);
      if (typeof d.amount === 'string') setAmount(d.amount);
      if (typeof d.transactionId === 'string') setTransactionId(d.transactionId);
      if (typeof d.receiptNumber === 'string') setReceiptNumber(d.receiptNumber);
      if (typeof d.agentName === 'string') setAgentName(d.agentName);
      if (typeof d.transactionDate === 'string') setTransactionDate(d.transactionDate);
      if (typeof d.transactionTime === 'string') setTransactionTime(d.transactionTime);
      if (typeof d.reason === 'string') setReason(d.reason);
      if (typeof d.depositPurpose === 'string') setDepositPurpose(d.depositPurpose as DepositPurpose | '');
      if (typeof d.breakdownChoice === 'string' && ['pending', 'no', 'yes'].includes(d.breakdownChoice)) {
        setBreakdownChoice(d.breakdownChoice as 'pending' | 'no' | 'yes');
      }
      if (typeof d.agentPersonalConfirmedAt === 'string') setAgentPersonalConfirmedAt(d.agentPersonalConfirmedAt);
      if (typeof d.purposeChosenAt === 'string') setPurposeChosenAt(d.purposeChosenAt);
      if (d.purposeEntryPoint === 'gate' || d.purposeEntryPoint === 'default' || d.purposeEntryPoint === 'in_form') {
        setPurposeEntryPoint(d.purposeEntryPoint);
      }
      toast.info('Draft restored', {
        description: 'We kept what you typed last time. Edit anything to update.',
        duration: 3500,
      });
    } catch { /* malformed JSON — ignore */ }
    draftRestoredRef.current = true;
  }, [open, draftKey, isEditMode, lockPurpose]);

  // Autosave — fires on every keystroke. Debounced via microtask coalesce
  // (React batches state updates so this runs at most once per commit).
  useEffect(() => {
    if (!open || !draftKey || isEditMode) return;
    if (draftSuppressRef.current) return;
    if (step === 'submitting' || step === 'success') return;
    // Avoid saving an empty shell before the user has typed anything.
    const hasContent = amount || transactionId || receiptNumber || agentName || reason || depositPurpose;
    if (!hasContent) return;
    try {
      localStorage.setItem(draftKey, JSON.stringify({
        step, channel, momoProvider, amount, transactionId, receiptNumber,
        agentName, transactionDate, transactionTime, reason, depositPurpose,
        breakdownChoice, agentPersonalConfirmedAt, purposeChosenAt, purposeEntryPoint,
        _savedAt: Date.now(),
      }));
    } catch { /* quota / safari private mode — silent */ }
  }, [
    open, draftKey, isEditMode, step, channel, momoProvider, amount,
    transactionId, receiptNumber, agentName, transactionDate, transactionTime,
    reason, depositPurpose, breakdownChoice, agentPersonalConfirmedAt,
    purposeChosenAt, purposeEntryPoint,
  ]);

  /**
   * Read the clipboard, parse the full deposit-confirmation SMS, and
   * auto-fill amount, transaction ID, date, and time in one tap.
   *
   * Any field the parser can't confidently extract is left untouched so
   * the agent can correct it manually. If the four required fields
   * aren't all present we surface a hard error toast and focus the
   * first missing field — `computeBlockReason()` keeps the Confirm
   * button disabled until everything is filled.
   */
  /**
   * Parse a raw SMS body (pasted by the agent into the SMS sheet) and
   * apply every field we can confidently extract. Returns true when all
   * four required fields landed so the caller can close the sheet.
   */
  const applyPastedSms = (text: string): boolean => {
    if (!text.trim()) {
      toast.error('Paste the SMS text first');
      return false;
    }
    const parsed = parseSMS(text);

      // Auto-detect MoMo provider from the TID prefix so the format
      // validator picks the right rule (MP… vs TID…).
      let detectedProvider: 'mtn' | 'airtel' | null = null;
      if (parsed.transactionId?.startsWith('MP')) detectedProvider = 'mtn';
      else if (parsed.transactionId?.startsWith('TID')) detectedProvider = 'airtel';
      else if (parsed.transactionId && /^\d{8,18}$/.test(parsed.transactionId)) detectedProvider = 'mtn';
      if (channel === 'momo' && detectedProvider) {
        setMomoProvider(detectedProvider);
      }

      if (parsed.amount) setAmount(String(parsed.amount));
      if (parsed.transactionId) {
        setTransactionId(parsed.transactionId);
        if (channel === 'momo') {
          validateTid(parsed.transactionId, detectedProvider ?? momoProvider);
        }
      }
      if (parsed.date) setTransactionDate(parsed.date);
      if (parsed.time) setTransactionTime(parsed.time);

      const missing: string[] = [];
      if (!parsed.amount) missing.push('amount');
      if (!parsed.transactionId) missing.push('transaction ID');
      if (!parsed.date) missing.push('date');
      if (!parsed.time) missing.push('time');

      if (missing.length === 0) {
        toast.success(
          `Pasted: UGX ${parsed.amount!.toLocaleString()} · ${parsed.transactionId} · ${parsed.date} ${parsed.time}`,
        );
        return true;
      } else if (missing.length === 4) {
        const tid = extractTidFromText(text);
        if (tid) {
          setTransactionId(tid);
          if (channel === 'momo') validateTid(tid);
          toast.warning('Only the TID was detected — please fill amount, date and time manually');
        } else {
          toast.error('Could not parse this SMS. Paste the full confirmation message.');
        }
        setErrorFieldId('deposit-amount');
        return false;
      } else {
        toast.error(`SMS missing: ${missing.join(', ')}. Fill the remaining fields manually.`);
        const firstMissing = missing[0];
        const fieldId =
          firstMissing === 'amount' ? 'deposit-amount'
          : firstMissing === 'transaction ID' ? 'deposit-tid'
          : firstMissing === 'date' ? 'deposit-date'
          : 'deposit-time';
        setErrorFieldId(fieldId);
        return false;
      }
  };

  /**
   * Opens the SMS paste sheet. Best-effort pre-fills the textarea from
   * the clipboard if the browser allows; otherwise leaves it empty for
   * a manual paste.
   */
  const handleOpenSmsPaste = async () => {
    setSmsPasteText('');
    setSmsPasteOpen(true);
    try {
      const text = await navigator.clipboard.readText();
      if (text?.trim()) setSmsPasteText(text);
    } catch {
      /* clipboard blocked — agent will paste manually */
    }
  };

  /** Copy a single value to the clipboard with a confirmation toast. */
  const copyValue = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`Copied ${label}`);
    } catch {
      toast.error('Failed to copy');
    }
  };

  // Re-apply default when dialog re-opens
  useEffect(() => {
    // Reset agent personal-money confirmation every time the dialog opens.
    if (open) {
      setAgentPersonalConfirmedAt(null);
      setPendingPersonalChoice(false);
    }
    // ── Agent default → Operational Float ──
    // For users with the agent role who didn't get a parent-pinned purpose
    // and aren't being forced through the explicit gate, pre-select
    // Operational Float and skip straight to the channel step. Agents can
    // still switch to Personal Deposit on the form, but only via the
    // explicit confirmation gate (handled below in the in-form grid).
    if (open && isAgent && !defaultPurpose && !requirePurposeChoice) {
      setDepositPurpose('operational_float');
      setReason('Operational Float');
      setShowPurposeGrid(true);
      setPurposeChosenAt(new Date().toISOString());
      setPurposeEntryPoint('default');
      setStep('channel');
      return;
    }
    if (open && mustChoosePurpose) {
      // Force a fresh choice every time the dialog opens
      setStep('purpose');
      setDepositPurpose('');
      setReason('');
      setShowPurposeGrid(false);
      setPurposeChosenAt(null);
      setPurposeEntryPoint('gate');
      return;
    }
    if (open && defaultPurpose) {
      setDepositPurpose(defaultPurpose);
      const purposeLabel = DEPOSIT_PURPOSES.find(p => p.id === defaultPurpose)?.label;
      if (purposeLabel && defaultPurpose !== 'other') setReason(purposeLabel);
      setShowPurposeGrid(!lockPurpose);
      setPurposeChosenAt(new Date().toISOString());
      setPurposeEntryPoint('default');
    }
  }, [open, defaultPurpose, lockPurpose, mustChoosePurpose, isAgent, requirePurposeChoice]);

  /**
   * Handoff hydration from the dashboard "Collect from receipt/reference"
   * entry. The dashboard already ran the matcher, so we land on the
   * Operational Float form with everything pre-applied — amount, per-tenant
   * allocations, channel/provider, and the pasted reference.
   *
   * Runs only on dialog open transitions to avoid clobbering edits the
   * agent makes after landing on the form.
   */
  useEffect(() => {
    if (!open || !prefillFromMatch || editRequestId) return;
    const m = prefillFromMatch;
    setDepositPurpose('operational_float');
    setReason('Operational Float');
    setShowPurposeGrid(false);
    setStep('form');
    setPurposeChosenAt(new Date().toISOString());
    setPurposeEntryPoint('default');
    if (m.amount > 0) setAmount(String(m.amount));
    if (m.allocations?.length) {
      setTenantAllocations(m.allocations);
      setBreakdownChoice('yes');
    }
    if (m.providerHint === 'mtn' || m.providerHint === 'airtel') {
      setChannel('momo');
      setMomoProvider(m.providerHint);
      if (m.reference) setTransactionId(m.reference);
    } else if (m.providerHint === 'bank') {
      setChannel('bank');
      if (m.reference) setTransactionId(m.reference);
    } else if (m.reference) {
      // Unknown provider — still attach the ref to the TID field as a
      // safe default so the agent doesn't have to re-type it.
      setTransactionId(m.reference);
    }
  }, [open, prefillFromMatch, editRequestId]);

  /**
   * Caller-supplied prefill (amount + payment method). Used by flows that
   * already collected those details, e.g. the funder house top-up modal.
   */
  useEffect(() => {
    if (!open || editRequestId || prefillFromMatch) return;
    if (defaultAmount && defaultAmount > 0) setAmount(String(Math.round(defaultAmount)));
    if (defaultChannel) {
      setChannel(defaultChannel);
      if (defaultChannel === 'momo' && defaultMomoProvider) setMomoProvider(defaultMomoProvider);
      if (defaultPurpose) setStep('form');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultAmount, defaultChannel, defaultMomoProvider]);

  /**
   * Edit-mode hydration. When the dialog opens with an `editRequestId`,
   * load the existing pending row, decode the allocations tail off the
   * notes column, and prefill every field so the agent can adjust amounts
   * without re-typing the TID, date, channel, etc.
   *
   * Read-only safeguard: if the row is no longer pending (Financial Ops
   * already touched it) we surface a toast and close — editing an
   * approved/reviewed deposit would silently desync the ledger.
   */
  useEffect(() => {
    if (!open || !activeEditId) return;
    let cancelled = false;
    (async () => {
      setEditLoading(true);
      try {
        const { data, error } = await supabase
          .from('deposit_requests')
          .select('*')
          .eq('id', activeEditId)
          .maybeSingle();
        if (error) throw error;
        if (!data) {
          // Row vanished between the matcher's lookup and our hydrate
          // (deleted, RLS change). Try the keep-allocations fallback
          // before closing so the agent doesn't lose their work.
          if (!applyMatchFallback("Couldn't reopen that deposit")) {
            toast.error('Deposit request not found');
            onOpenChange(false);
          }
          return;
        }
        // Allow editing 'pending' (in-queue tweak) and 'rejected'
        // (resubmit after FinOps bounce). Anything else (approved /
        // reviewed) is locked — touching it would desync the ledger.
        if (data.status !== 'pending' && data.status !== 'rejected') {
          if (!applyMatchFallback('That deposit is already under review')) {
            toast.error('This deposit is already under review and can no longer be edited');
            onOpenChange(false);
          }
          return;
        }
        if (cancelled) return;

        // Hydrate succeeded — discard the fallback bookkeeping.
        pendingMatchFallbackRef.current = null;
        preEditSnapshotRef.current = null;

        // Remember which lane this row is on; the submit handler picks
        // between the direct UPDATE (pending) and the resubmit RPC
        // (rejected) based on this.
        setEditStatus(data.status === 'rejected' ? 'rejected' : 'pending');

        // Channel + provider — derive from stored `provider` enum
        const prov = String(data.provider || '');
        if (prov === 'mtn' || prov === 'airtel') {
          setChannel('momo');
          setMomoProvider(prov);
        } else if (prov === 'bank_transfer') {
          setChannel('bank');
        } else if (prov === 'cash_deposit') {
          setChannel('cash');
        } else if (prov === 'agent_cash') {
          setChannel('agent_cash');
        }

        setAmount(String(data.amount ?? ''));

        // Reference: bank/momo go in transactionId, cash/agent_cash in receiptNumber (RCT-prefixed)
        const ref = String(data.transaction_id || '');
        if (prov === 'cash_deposit' || prov === 'agent_cash') {
          setReceiptNumber(ref.replace(/^RCT/i, ''));
        } else {
          setTransactionId(ref);
        }

        // Date / time
        if (data.transaction_date) {
          const d = new Date(data.transaction_date);
          setTransactionDate(d.toISOString().split('T')[0]);
          setTransactionTime(d.toTimeString().slice(0, 5));
        }

        // Purpose
        const audit = (data.purpose_audit ?? null) as { chosen_purpose?: string } | null;
        const purpose = (data.deposit_purpose ?? audit?.chosen_purpose ?? '') as DepositPurpose | '';
        if (purpose) {
          setDepositPurpose(purpose);
          const label = DEPOSIT_PURPOSES.find((p) => p.id === purpose)?.label;
          if (label && purpose !== 'other') setReason(label);
          setShowPurposeGrid(false);
          setStep('form');
        }

        // Decode allocations tail off notes; restore reason text from the
        // human-readable head if present (strip leading "Purpose: …" tag).
        const { cleanNote, allocations: decoded } = decodeAllocationsFromNote(data.notes);
        if (decoded && decoded.length) {
          setTenantAllocations(decoded);
          // Snapshot — must be a deep copy so later edits don't mutate
          // the "original" reference and quietly hide the diff.
          setOriginalAllocations(decoded.map((a) => ({ ...a })));
          setBreakdownChoice('yes');
        } else {
          // Editing a deposit that was submitted as a bulk drop — keep
          // the agent on the same path instead of forcing them back to
          // the chooser.
          setBreakdownChoice('no');
        }
        setOriginalAmount(Number(data.amount ?? 0));
        if (cleanNote) {
          // notes look like "Purpose: X | <reason> | Agent: Y | Bank slip: Z"
          const parts = cleanNote.split('|').map((s) => s.trim()).filter(Boolean);
          const reasonPart = parts.find(
            (p) => !/^purpose:/i.test(p) && !/^agent:/i.test(p) && !/^bank slip:/i.test(p),
          );
          if (reasonPart && (purpose === 'other' || !purpose)) {
            setReason(reasonPart);
          }
          const agentPart = parts.find((p) => /^agent:/i.test(p));
          if (agentPart) setAgentName(agentPart.replace(/^agent:\s*/i, ''));
        }
      } catch (err: any) {
        console.error('[DepositFlow] edit hydrate failed', err);
        if (!applyMatchFallback("Couldn't load that deposit")) {
          toast.error('Could not load deposit for editing', { description: err?.message });
          onOpenChange(false);
        }
      } finally {
        if (!cancelled) setEditLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeEditId]);

  /**
   * Live "is this TID already registered?" check. Debounced 400ms,
   * skipped in edit mode and while the TID format is invalid. Hits the
   * same indexed query the submit-time guard runs so the UX preview and
   * the final gate stay in lock-step.
   */
  useEffect(() => {
    if (isEditMode) { setDuplicateTidStatus(null); return; }
    if (tidError) { setDuplicateTidStatus(null); return; }
    const ref =
      channel === 'agent_cash' || channel === 'cash'
        ? (receiptNumber.trim() ? `RCT${receiptNumber.trim().toUpperCase()}` : '')
        : transactionId.trim().toUpperCase();
    if (!ref || ref.length < 4) { setDuplicateTidStatus(null); return; }
    let ignored = false;
    const t = setTimeout(async () => {
      try {
        // Single source of truth — calls the edge fn that mirrors the
        // `guard_deposit_reference_uniqueness` trigger, including the
        // notes-substring rule the inline ilike used to miss.
        const result = await validateDepositReference(ref);
        if (ignored) return;
        if (!result.valid && result.conflict) {
          setDuplicateTidStatus(result.conflict.status);
        } else {
          setDuplicateTidStatus(null);
        }
      } catch {
        if (!ignored) setDuplicateTidStatus(null);
      }
    }, 400);
    return () => { ignored = true; clearTimeout(t); };
  }, [transactionId, receiptNumber, channel, momoProvider, tidError, isEditMode]);

  const validateTid = (value: string, provider?: 'mtn' | 'airtel') => {
    const upper = value.trim().toUpperCase();
    const prov = provider ?? momoProvider;
    if (!upper) { setTidError(''); return; }
    if (prov === 'mtn' && !upper.startsWith('MP') && !/^\d{8,18}$/.test(upper)) {
      setTidError("MTN TIDs must start with 'MP' or be the numeric ID from your SMS (e.g. MP39665905645 or 40473329892)");
    } else if (prov === 'airtel' && !upper.startsWith('TID')) {
      setTidError("Airtel TIDs must start with 'TID' (e.g. TID144205097399)");
    } else {
      setTidError('');
    }
  };

  const isTidValid = () => {
    if (channel !== 'momo') return true;
    const upper = transactionId.trim().toUpperCase();
    if (!upper) return false;
    if (momoProvider === 'mtn') return upper.startsWith('MP') || /^\d{8,18}$/.test(upper);
    if (momoProvider === 'airtel') return upper.startsWith('TID');
    return true;
  };

  const { formatAmount: formatCurrency } = useCurrency();

  const getProviderLabel = () => {
    if (channel === 'momo') return momoProvider === 'mtn' ? 'MTN MoMo' : 'Airtel Money';
    if (channel === 'bank') return 'Bank Transfer';
    if (channel === 'cash') return 'Cash Deposit';
    return 'Agent Cash';
  };

  const getReferenceId = () => {
    if (channel === 'agent_cash' || channel === 'cash') return receiptNumber.trim() ? `RCT${receiptNumber.trim().toUpperCase()}` : '';
    return transactionId.trim().toUpperCase();
  };

  /**
   * Single source of truth for "why can't this form be submitted right now?".
   * Returns null when the form is good to go, otherwise an object with the
   * user-facing message AND the DOM id of the field that needs attention so
   * the Confirm button can scroll/focus the right input.
   *
   * IMPORTANT: every block path used by validateForm() MUST go through here
   * so the inline hint above the button and the toast stay in lock-step —
   * that's what kills the "the button does nothing" perception.
   */
  const computeBlockReason = (): { message: string; fieldId: string } | null => {
    const effectiveDepositPurpose = (purposeOverrideRef.current || depositPurpose) as DepositPurpose | '';
    const amt = parseFloat(amount);
    if (!amount || !Number.isFinite(amt) || amt <= 0) {
      return { message: 'Enter a valid amount', fieldId: 'deposit-amount' };
    }
    if (amt < MIN_DEPOSIT) {
      return { message: `Minimum deposit is ${formatCurrency(MIN_DEPOSIT)}`, fieldId: 'deposit-amount' };
    }
    if (amt > MAX_DEPOSIT) {
      return { message: `Maximum deposit is ${formatCurrency(MAX_DEPOSIT)}`, fieldId: 'deposit-amount' };
    }
    if (channel === 'momo' && !transactionId.trim()) {
      return {
        message: momoProvider === 'mtn'
          ? "Enter your MTN MoMo TID from the SMS ('MP…' or numeric ID, e.g. MP39665905645 or 40473329892)"
          : "Enter your Airtel Money TID from the SMS (starts with 'TID', e.g. TID144205097399)",
        fieldId: 'deposit-tid',
      };
    }
    if (channel === 'bank' && !transactionId.trim()) {
      return { message: 'Enter the bank reference number from your transfer receipt', fieldId: 'deposit-tid' };
    }
    if (channel === 'agent_cash' && !receiptNumber.trim()) {
      return { message: 'Enter the receipt number the agent gave you', fieldId: 'deposit-receipt' };
    }
    if (channel === 'agent_cash' && !agentName.trim()) {
      return { message: "Enter the agent's name", fieldId: 'deposit-agent-name' };
    }
    if (channel === 'cash' && !receiptNumber.trim()) {
      return { message: 'Enter the cash deposit receipt number', fieldId: 'deposit-receipt' };
    }
    if (channel === 'momo') {
      const rawTid = transactionId.trim().toUpperCase();
      if (momoProvider === 'mtn' && !rawTid.startsWith('MP') && !/^\d{8,18}$/.test(rawTid)) {
        return { message: "MTN TIDs must start with 'MP' or be the numeric ID from your SMS (e.g. MP39665905645 or 40473329892)", fieldId: 'deposit-tid' };
      }
      if (momoProvider === 'airtel' && !rawTid.startsWith('TID')) {
        return { message: "Airtel TIDs must start with 'TID' (e.g. TID144205097399)", fieldId: 'deposit-tid' };
      }
    }
    if (!transactionDate) {
      return { message: 'Select the transaction date', fieldId: 'deposit-date' };
    }
    if (!transactionTime) {
      return { message: 'Enter the transaction time', fieldId: 'deposit-time' };
    }
    if (!effectiveDepositPurpose) {
      return { message: 'Select the deposit purpose', fieldId: 'deposit-purpose' };
    }
    if (effectiveDepositPurpose === 'other' && !reason.trim()) {
      return { message: 'Enter the reason for this deposit', fieldId: 'deposit-reason' };
    }
    // Personal Deposit: confirmation is now implicit by selecting the tile —
    // no separate confirm step. `handleSubmit` stamps the timestamp as a
    // safety net before insert, so we don't block here.
    if (effectiveDepositPurpose === 'operational_float' && breakdownChoice === 'pending' && (parseFloat(amount) || 0) > 0) {
      return {
        message: 'Choose: deposit with or without a tenant breakdown',
        fieldId: 'deposit-breakdown-choice',
      };
    }
    if (effectiveDepositPurpose === 'operational_float' && breakdownChoice === 'yes' && tenantAllocations.length > 0) {
      const sum = tenantAllocations.reduce((s, a) => s + (a.amount || 0), 0);
      const total = parseFloat(amount);
      if (tenantAllocations.some((a) => !a.amount || a.amount <= 0)) {
        return {
          message: 'Each tenant in the breakdown needs an amount greater than 0',
          fieldId: 'deposit-tenant-allocator',
        };
      }
      if (Math.abs(sum - total) > 1) {
        return {
          message: `Tenant breakdown (UGX ${sum.toLocaleString()}) must equal deposit total (UGX ${total.toLocaleString()})`,
          fieldId: 'deposit-tenant-allocator',
        };
      }
    }
    if (transactionDate && transactionTime) {
      const txDate = new Date(`${transactionDate}T${transactionTime}`);
      const now = new Date();
      if (txDate > now) {
        return { message: 'Transaction date cannot be in the future', fieldId: 'deposit-date' };
      }
    }
    if (duplicateTidStatus) {
      return {
        message: `This Transaction ID is already registered (status: ${duplicateTidStatus}). Each TID can only be used once.`,
        fieldId: 'deposit-tid',
      };
    }
    return null;
  };

  const validateForm = () => {
    const blocked = computeBlockReason();
    if (blocked) {
      toast.error(blocked.message);
      return false;
    }
    return true;
  };

  const handleSubmit = async () => {
    if (!validateForm()) return;
    setSubmitError(null);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        toast.error('Please log in');
        setStep('form');
        setIsSubmitting(false);
        return;
      }
      // FINAL purpose gate. Even though `validateForm` already checks
      // `depositPurpose`, state-update races (prefill effect, agent default
      // effect, or a stale `handleClose` reset) have been observed letting
      // an empty string slip through and hit the Postgres enum, surfacing
      // as "invalid input value for enum deposit_purpose: """ in the logs
      // and a totally dead Confirm button on the agent's phone. Belt &
      // braces: recompute, validate against the enum allowlist, and abort
      // cleanly with a friendly toast if anything is off.
      const effectivePurpose: DepositPurpose | '' =
        (purposeOverrideRef.current ||
          depositPurpose ||
          defaultPurpose ||
          (isAgent ? 'operational_float' : '')) as DepositPurpose | '';
      // Coerce to a guaranteed-valid enum value. If the caller / state
      // race somehow produced an empty/invalid purpose, we fall back to
      // 'other' instead of aborting — the agent's tap is never lost,
      // and Postgres never sees `''` (which would raise
      // `invalid input value for enum deposit_purpose: ""`).
      const safePurpose: DepositPurpose = safeDepositPurpose(effectivePurpose);
      // Override consumed; clear so subsequent submits use real state.
      purposeOverrideRef.current = null;
      // Personal Deposit safety net: stamp the confirmation timestamp
      // here if it wasn't already set when the tile was tapped. The DB
      // constraint `agent_personal_deposit_requires_confirmation` rejects
      // rows without it, so we never want to send one through unstamped.
      const effectivePersonalConfirmedAt =
        isAgent && safePurpose === 'personal_deposit'
          ? agentPersonalConfirmedAt ?? new Date().toISOString()
          : null;
      if (
        isAgent &&
        safePurpose === 'personal_deposit' &&
        !agentPersonalConfirmedAt
      ) {
        setAgentPersonalConfirmedAt(effectivePersonalConfirmedAt);
      }
      // Only flip into the submitting state AFTER the auth check passes —
      // otherwise an unauthed user gets the spinner stuck forever (root
      // cause of the "Confirm deposit button is dead" complaint when a
      // session has lapsed).
      setIsSubmitting(true);
      setStep('submitting');

      const txDateTime = new Date(`${transactionDate}T${transactionTime}`);
      const normalizedRef = getReferenceId();

      // 🛡️ DUPLICATE GUARD — check if this Transaction ID / receipt has
      // already been submitted (and isn't rejected/cancelled/failed) so we
      // don't double-post the same SMS or receipt. Cheap, indexed lookup
      // (`idx_deposit_requests_tid_provider_active`). If the network blip
      // here, fall through and let the DB unique index / Financial Ops
      // catch it — never block on a transient error.
      if (normalizedRef && !isEditMode) {
        try {
          const result = await validateDepositReference(normalizedRef);
          if (!result.valid) {
            toast.error('Duplicate transaction blocked', {
              description: result.message,
              duration: 8000,
            });
            setStep('form');
            setIsSubmitting(false);
            return;
          }
        } catch {
          // Soft-fail — don't block on a transient lookup error; the DB
          // and Financial Ops review remain the final guardrails.
        }
      }

      // Upload bank slip if provided
      let bankSlipUrl: string | null = null;
      if (channel === 'bank' && bankSlipFile) {
        const ext = bankSlipFile.name.split('.').pop();
        const path = `bank-slips/${user.id}/${Date.now()}.${ext}`;
        const { error: uploadErr } = await supabase.storage
          .from('deposit-proofs')
          .upload(path, bankSlipFile, { upsert: true });
        if (!uploadErr) {
          const { data: urlData } = supabase.storage.from('deposit-proofs').getPublicUrl(path);
          bankSlipUrl = urlData?.publicUrl || null;
          // Offsite backup: mirror the bank slip into the Google Drive vault.
          archiveToDrive('deposit-proofs', path, 'receipt');
        }
      }

      const providerValue = channel === 'momo' ? momoProvider : channel === 'bank' ? 'bank_transfer' : channel === 'cash' ? 'cash_deposit' : 'agent_cash';
      const purposeLabel = DEPOSIT_PURPOSES.find(p => p.id === safePurpose)?.label || safePurpose;
      const baseNotes = [
        `Purpose: ${purposeLabel}`,
        reason.trim() ? reason.trim() : '',
        channel === 'agent_cash' ? `Agent: ${agentName.trim()}` : '',
        bankSlipUrl ? `Bank slip: ${bankSlipUrl}` : '',
      ].filter(Boolean).join(' | ');

      // For Operational Float drops, append the per-tenant breakdown to
      // notes as a structured tail. Financial Ops parses this and shows a
      // tenant-by-tenant table at approval time.
      const notes =
        safePurpose === 'operational_float' && breakdownChoice === 'yes' && tenantAllocations.length > 0
          ? encodeAllocationsNote(baseNotes, tenantAllocations)
          : baseNotes;

      if (isEditMode && activeEditId) {
        if (editStatus === 'rejected') {
          // RESUBMIT — the row was rejected by Financial Ops. Go through
          // the SECURITY DEFINER RPC which validates ownership, flips
          // status back to 'pending', clears rejection_reason, and stamps
          // a resubmission entry into purpose_audit.resubmissions[].
          const { error: rpcError } = await supabase.rpc(
            'resubmit_rejected_deposit',
            {
              p_id: activeEditId,
              p_payload: {
                amount: parseFloat(amount),
                provider: providerValue,
                transaction_id: normalizedRef,
                transaction_date: txDateTime.toISOString(),
                notes,
                deposit_purpose: safePurpose,
              },
            } as any,
          );
          if (rpcError) throw rpcError;
          toast.success('Resubmitted — Financial Ops will review again');
        } else {
          // UPDATE — restricted by RLS to the owner's own pending row.
          // Status is intentionally NOT touched; the row stays 'pending' so
          // Financial Ops still owns the next move. We do, however, stamp
          // an `edited_at`-style breadcrumb into purpose_audit so reviewers
          // can see the row was reopened by the agent.
          const { error: updError } = await supabase
            .from('deposit_requests')
            .update({
              amount: parseFloat(amount),
              provider: providerValue,
              transaction_id: normalizedRef,
              transaction_date: txDateTime.toISOString(),
              notes,
              deposit_purpose: safePurpose,
              purpose_audit: {
                chosen_purpose: safePurpose,
                chosen_at: purposeChosenAt ?? new Date().toISOString(),
                chosen_by: user.id,
                entry_point: purposeEntryPoint,
                required_choice: !!requirePurposeChoice,
                last_edited_at: new Date().toISOString(),
                is_agent: isAgent,
                agent_personal_confirmed_at:
                  effectivePersonalConfirmedAt,
              },
            } as any)
            .eq('id', activeEditId)
            .eq('status', 'pending'); // hard guard: never overwrite a reviewed row
          if (updError) throw updError;
          toast.success('Deposit updated — Financial Ops will see your changes');
        }
      } else {
        const { data: inserted, error: depositError } = await supabase
          .from('deposit_requests')
          .insert({
            user_id: user.id,
            amount: parseFloat(amount),
            status: 'pending',
            provider: providerValue,
            transaction_id: normalizedRef,
            transaction_date: txDateTime.toISOString(),
            notes,
            deposit_purpose: safePurpose,
            purpose_audit: {
              chosen_purpose: safePurpose,
              chosen_at: purposeChosenAt ?? new Date().toISOString(),
              chosen_by: user.id,
              entry_point: purposeEntryPoint,
              required_choice: !!requirePurposeChoice,
              is_agent: isAgent,
              agent_personal_confirmed_at:
                effectivePersonalConfirmedAt,
            },
          } as any)
          .select('id')
          .single();

        if (depositError) throw depositError;

        // ── Instant auto-verify ────────────────────────────────────────────
        // Server-side `try_link_gmail_for_deposit` either:
        //  • `linked`                       → email matched right now,
        //    invoke approve-deposit immediately.
        //  • `duplicate_already_credited`   → same TID was already credited
        //    from a prior auto-matched email; the pending row was
        //    auto-cancelled. Tell the user (no double charge, no dangling
        //    pending row).
        //  • `no_match` / anything else     → fall through to normal
        //    pending-review flow (matcher cron will pick it up later).
        let outcome: string = 'no_match';
        try {
          const newId = (inserted as any)?.id as string | undefined;
          if (newId) {
            const { data: linkRes } = await (supabase.rpc as any)(
              'try_link_gmail_for_deposit',
              { p_deposit_id: newId },
            );
            outcome = (linkRes as any)?.outcome ?? 'no_match';

            if (outcome === 'linked') {
              const { data: session } = await supabase.auth.getSession();
              const token = session?.session?.access_token;
              const { error: invErr } = await supabase.functions.invoke(
                'approve-deposit',
                {
                  body: {
                    deposit_request_id: newId,
                    action: 'approve',
                    access_token: token,
                    auto_approved: true,
                    auto_match_method: 'tid',
                  },
                },
              );
              if (invErr) outcome = 'no_match';
            }
          }
        } catch (autoErr) {
          console.warn('[deposit] instant auto-verify failed', autoErr);
        }

        if (outcome === 'linked') {
          toast.success('Deposit auto-verified ⚡', {
            description: 'We matched your mobile-money confirmation instantly.',
          });
        } else if (outcome === 'duplicate_already_credited') {
          toast.success('Already credited ✓', {
            description:
              'This transaction was auto-verified from your mobile-money receipt earlier. No duplicate created.',
          });
        } else {
          toast.success('Deposit submitted for verification');
        }
      }
      // Draft fulfilled — wipe so the next deposit starts blank.
      clearDraft();
      setStep('success');
    } catch (error: any) {
      console.error('Deposit error:', error);
      const msg = String(error?.message ?? '');
      let friendly = 'Please try again or contact support.';
      if (msg.includes('invalid input value for enum deposit_purpose')) {
        friendly = 'Deposit purpose was missing — please pick a purpose and try again.';
      } else if (msg.includes('agent_personal_deposit_requires_confirmation')) {
        friendly = 'Confirm this is your personal money before submitting a Personal Deposit.';
      } else if (error?.code === '23505' || msg.toLowerCase().includes('duplicate')) {
        friendly = 'This transaction reference has already been used.';
      } else if (msg) {
        friendly = msg;
      }
      // Pull as much diagnostic info as we can off whatever was thrown —
      // PostgREST errors expose code/details/hint, Functions errors expose
      // a Response on `context`, and plain throws have only a message.
      let status: number | string | undefined =
        error?.status ?? error?.context?.status ?? error?.statusCode;
      let body: string | undefined;
      try {
        const ctx = error?.context;
        if (ctx && typeof ctx.text === 'function') {
          body = await ctx.clone().text();
        } else if (typeof ctx === 'string') {
          body = ctx;
        } else if (ctx && typeof ctx === 'object') {
          body = JSON.stringify(ctx, null, 2);
        }
      } catch {
        /* ignore body extraction failures */
      }
      let raw = '';
      try {
        raw = JSON.stringify(
          error,
          Object.getOwnPropertyNames(error ?? {}),
          2,
        );
      } catch {
        raw = String(error);
      }
      setSubmitError({
        message: friendly,
        status,
        code: error?.code,
        details: error?.details,
        hint: error?.hint,
        body,
        raw,
        at: new Date().toISOString(),
      });
      setShowRawError(false);
      toast.error('Failed to submit deposit', { description: friendly });
      setStep('form');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    setStep(mustChoosePurpose ? 'purpose' : 'channel');
    setIsSubmitting(false);
    purposeOverrideRef.current = null;
    setChannel('momo');
    setMomoProvider('mtn');
    setAmount('');
    setTransactionId('');
    setReceiptNumber('');
    setAgentName('');
    setTransactionDate('');
    setTransactionTime('');
    setReason('');
    setDepositPurpose(mustChoosePurpose ? '' : (defaultPurpose ?? ''));
    setShowPurposeGrid(!lockPurpose);
    setBankSlipFile(null);
    setTenantAllocations([]);
    setOriginalAllocations([]);
    setOriginalAmount(null);
    setMatchedEditId(null);
    setEditStatus(null);
    setBreakdownChoice('pending');
    setErrorFieldId(null);
    setSubmitError(null);
    setShowRawError(false);
    onOpenChange(false);
  };

  const today = new Date().toISOString().split('T')[0];
  // Allow generous backdating (up to 90 days) so users can record deposits
  // they made in the field days/weeks ago. Future dates remain blocked.
  const sevenDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  /**
   * Tailwind class snippet to paint a field red when it's the current
   * blocker. The destructive ring catches the eye even after the toast
   * fades, and the matching aria-invalid is picked up by screen readers
   * so this works for assistive tech too.
   */
  const errClass = (id: string) =>
    errorFieldId === id
      ? 'border-destructive ring-2 ring-destructive/40 focus-visible:ring-destructive'
      : '';

  /* ─── Unsaved-changes guard ───
   * Surfaces a confirm dialog when a user taps Back / Close / swipes-back
   * after typing into the deposit form. Edits are also draft-saved to
   * localStorage, so the dialog reassures users that leaving doesn't lose
   * their work — they get explicit "Keep editing" vs "Leave anyway". */
  const hasUnsavedChanges = (): boolean => {
    if (isEditMode) return false; // edit mode already loaded from DB
    if (step === 'success' || step === 'submitting') return false;
    return !!(
      amount.trim() ||
      transactionId.trim() ||
      receiptNumber.trim() ||
      agentName.trim() ||
      reason.trim() ||
      bankSlipFile ||
      (tenantAllocations && tenantAllocations.length > 0)
    );
  };
  const [confirmIntent, setConfirmIntent] = useState<'back' | 'close' | null>(null);
  // Surface the deposit form's dirty state to the global agent Back pill /
  // hardware Back so they also prompt before discarding pending edits.
  useUnsavedChangesGuard(hasUnsavedChanges);
  const requestBack = () => {
    if (hasUnsavedChanges()) setConfirmIntent('back');
    else setStep('channel');
  };
  const requestClose = () => {
    if (hasUnsavedChanges()) setConfirmIntent('close');
    else handleClose();
  };

  /* ─── Swipe navigation ───
   * Swipe right → go to previous step (same as the header back chevron).
   * Swipe left  → advance to the next step IF the user has already made the
   *               required selection (purpose chosen, channel chosen).
   * Never auto-submits from the form step — a swipe should never spend
   * money. The form's Deposit button remains the only commit affordance.
   * Disabled on submitting / success so users can't accidentally rewind a
   * completed deposit. */
  const swipeBack = () => {
    if (step === 'form') requestBack();
    else if (step === 'channel' && mustChoosePurpose && depositPurpose) setStep('purpose');
  };
  const swipeForward = () => {
    if (step === 'purpose' && depositPurpose) setStep('channel');
    else if (step === 'channel' && channel) setStep('form');
  };
  const swipeHandlers = useHorizontalSwipe({
    onSwipeRight: step === 'submitting' || step === 'success' ? undefined : swipeBack,
    onSwipeLeft: step === 'submitting' || step === 'success' ? undefined : swipeForward,
  });

  return (
    <>
    <Dialog open={open} onOpenChange={(next) => { if (!next) requestClose(); }}>
      {/*
        Mobile-first dialog shell.
        On phones: full screen (no rounded corners, no margins) so everything
        the user reads/taps is at thumb-friendly distance and the keyboard
        doesn't squash the form. On tablet/desktop: classic centered card.
        The body becomes a scroll region between a sticky header (title +
        step + back) and a sticky footer (the primary action) — never
        chase a button hidden below the fold.
      */}
      <DialogContent
        className="p-0 gap-0 sm:max-w-md w-screen h-svh sm:h-auto sm:max-h-[90vh] sm:rounded-2xl rounded-none overflow-y-auto flex flex-col"
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        {/* Hero illustration */}
        <div className="flex justify-center pt-4 pb-2 bg-background">
          <img
            src={savingsBroAsset.url}
            alt="Savings illustration"
            className="h-28 w-auto object-contain"
          />
        </div>
        {/* Header (scrolls with content) */}
        <DialogHeader className="px-4 py-3 border-b bg-background space-y-0">
          <div className="flex items-center gap-3">
            {/* Step-aware back: only shown when there's somewhere to go back to. */}
            {step === 'form' && (
              <button
                type="button"
                onClick={requestBack}
                aria-label="Back to payment method"
                aria-keyshortcuts="Alt+ArrowLeft"
                className="-ml-1 h-11 w-11 rounded-full flex items-center justify-center hover:bg-muted active:bg-muted active:scale-90 transition-transform duration-75 touch-manipulation focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <ChevronLeft className="h-6 w-6" aria-hidden="true" />
              </button>
            )}
            {step === 'channel' && mustChoosePurpose && depositPurpose && (
              <button
                type="button"
                onClick={() => setStep('purpose')}
                aria-label="Back to choose purpose"
                className="-ml-1 h-11 w-11 rounded-full flex items-center justify-center hover:bg-muted active:bg-muted active:scale-90 transition-transform duration-75 touch-manipulation focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <ChevronLeft className="h-6 w-6" aria-hidden="true" />
              </button>
            )}
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-base font-semibold leading-tight">
                {isEditMode ? 'Edit deposit' : 'Deposit to wallet'}
              </DialogTitle>
              {/* Tiny step caption — plain language, no jargon. */}
              {!editLoading && step !== 'submitting' && step !== 'success' && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  {step === 'purpose'
                    ? 'Step 1 of 3 · What is this for?'
                    : step === 'channel'
                      ? `Step ${mustChoosePurpose ? '2' : '1'} of ${mustChoosePurpose ? '3' : '2'} · How are you paying?`
                      : `Step ${mustChoosePurpose ? '3' : '2'} of ${mustChoosePurpose ? '3' : '2'} · Enter details`}
                </p>
              )}
            </div>
          </div>
        </DialogHeader>
        {/* Body */}
        <div className="px-4 py-4" {...swipeHandlers}>

        {editLoading ? (
          <div className="py-12 text-center space-y-3">
            <Loader2 className="h-8 w-8 animate-spin mx-auto text-primary" />
            <p className="text-muted-foreground text-sm">Loading deposit details…</p>
          </div>
        ) : step === 'success' ? (
          <div className="py-6 space-y-5">
            {/* Success badge */}
            <div className="text-center space-y-2">
              <div className="w-14 h-14 mx-auto bg-success/15 rounded-full flex items-center justify-center">
                <CheckCircle2 className="h-7 w-7 text-success" />
              </div>
              <h3 className="text-lg font-semibold">
                {isEditMode ? 'Changes saved' : 'Deposit submitted'}
              </h3>
              {!isEditMode && parseFloat(amount) > 0 && (
                <p className="text-sm text-muted-foreground">
                  We received your request for{' '}
                  <span className="font-semibold text-foreground">{formatCurrency(parseFloat(amount))}</span>
                </p>
              )}
            </div>

            {/* 3-step tracker — gives users certainty about where the deposit
                sits in the Financial Ops verification pipeline. Addresses the
                "I deposited but can't see it anywhere" complaint (FIX-43). */}
            <div className="rounded-xl border bg-muted/30 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                What happens next
              </p>
              <ol className="space-y-3">
                <li className="flex items-start gap-3">
                  <div className="mt-0.5 h-6 w-6 rounded-full bg-success text-success-foreground flex items-center justify-center shrink-0">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold leading-tight">Submitted</p>
                    <p className="text-xs text-muted-foreground mt-0.5">Just now — recorded with your reference</p>
                  </div>
                </li>
                <li className="flex items-start gap-3">
                  <div className="mt-0.5 h-6 w-6 rounded-full bg-warning/20 text-warning flex items-center justify-center shrink-0 ring-2 ring-warning/30">
                    <Clock className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold leading-tight">Awaiting Financial Ops verification</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Usually reviewed within a few hours. You'll see it under <span className="font-medium text-foreground">View history</span> with status <span className="font-medium text-foreground">Pending</span>.
                    </p>
                  </div>
                </li>
                <li className="flex items-start gap-3">
                  <div className="mt-0.5 h-6 w-6 rounded-full bg-muted text-muted-foreground flex items-center justify-center shrink-0">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold leading-tight text-muted-foreground">Wallet credited</p>
                    <p className="text-xs text-muted-foreground mt-0.5">As soon as Financial Ops approves, the funds land in your wallet.</p>
                  </div>
                </li>
              </ol>
            </div>

            <div className="space-y-2">
              <Button
                className="w-full"
                onClick={() => { handleClose(); navigate('/deposit-history'); }}
              >
                <History className="h-4 w-4 mr-2" /> Track this deposit
              </Button>
              <Button variant="outline" onClick={handleClose} className="w-full">Done</Button>
            </div>
          </div>
        ) : step === 'submitting' ? (
          <div className="py-12 text-center space-y-4">
            <Loader2 className="h-10 w-10 animate-spin mx-auto text-primary" />
            <p className="text-muted-foreground">
              {isEditMode ? 'Saving changes… please wait' : 'Sending your deposit… please wait'}
            </p>
          </div>
        ) : step === 'purpose' ? (
          /* ─── Mandatory Purpose Choice (agents) ───
           * Smartphone-first, plain-language gate. We DON'T frame this as a
           * scary warning anymore — most agents bounced off the original
           * banner and assumed the deposit button was broken. */
          <div className="space-y-3">
            <div className="space-y-1 px-1">
              <p className="text-base font-semibold text-foreground">What is this money for?</p>
              <p className="text-xs text-muted-foreground">
                Tap one to continue. You can change it on the next screen if you pick the wrong one.
              </p>
            </div>
            <div className="grid gap-2.5">
              {DEPOSIT_PURPOSES
                .filter((p) => !allowedPurposes || allowedPurposes.includes(p.id))
                .map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      // Agent gate: tapping "Personal Deposit" on the
                      // dedicated full-screen purpose card IS the explicit
                      // confirmation the DB requires. Stamp the
                      // confirmation timestamp here so the submit doesn't
                      // later fail with `agent_personal_deposit_requires_confirmation`.
                      if (isAgent && p.id === 'personal_deposit') {
                        setAgentPersonalConfirmedAt(new Date().toISOString());
                      }
                      setDepositPurpose(p.id);
                      if (p.id !== 'other') setReason(p.label);
                      else setReason('');
                      setShowPurposeGrid(false);
                      setPurposeChosenAt(new Date().toISOString());
                      setPurposeEntryPoint('gate');
                      setStep('channel');
                    }}
                    className="flex items-center gap-3 p-4 min-h-[88px] rounded-2xl border-2 border-border text-left transition-all hover:border-primary hover:bg-primary/5 active:scale-[0.98] touch-manipulation"
                  >
                    <span className="text-4xl shrink-0">{p.emoji}</span>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-base leading-tight">{p.label}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{p.desc}</p>
                    </div>
                    <span aria-hidden className="text-muted-foreground text-lg">›</span>
                  </button>
                ))}
            </div>
          </div>
        ) : step === 'channel' ? (
          /* ─── Channel Selection ─── */
          <div className="space-y-3">
            {mustChoosePurpose && depositPurpose && (
              <div className="flex items-start gap-2 p-2.5 rounded-lg bg-muted/50 text-xs">
                <span className="text-base">{DEPOSIT_PURPOSES.find(p => p.id === depositPurpose)?.emoji}</span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-foreground">{DEPOSIT_PURPOSES.find(p => p.id === depositPurpose)?.label}</p>
                  <p className="text-muted-foreground text-xs">Tap back at the top to change.</p>
                </div>
              </div>
            )}
            <div className="grid gap-2.5">
              {[
                { id: 'cash' as DepositChannel, provider: null, icon: Building2, label: 'Cash with Financial Ops', desc: 'Hand cash to the company desk — instant via receipt code', tone: 'border-blue-500/40 bg-blue-500/5 hover:border-blue-500' },
                { id: 'momo' as DepositChannel, provider: 'mtn' as const, icon: Phone, label: 'MTN MoMo', desc: 'Pay via MTN Mobile Money', tone: 'border-[hsl(var(--warning))]/40 bg-[hsl(var(--warning))]/5 hover:border-[hsl(var(--warning))]' },
                { id: 'momo' as DepositChannel, provider: 'airtel' as const, icon: Phone, label: 'Airtel Money', desc: 'Pay via Airtel Money', tone: 'border-destructive/40 bg-destructive/5 hover:border-destructive' },
                { id: 'bank' as DepositChannel, provider: null, icon: Building2, label: 'Bank transfer', desc: 'Equity Bank Uganda', tone: 'border-blue-500/40 bg-blue-500/5 hover:border-blue-500' },
              ].map((ch, idx) => (
                <button
                  key={idx}
                  onClick={() => {
                    if (ch.id === 'cash') {
                      setShowFinOpsCashDeposit(true);
                      return;
                    }
                    setChannel(ch.id);
                    if (ch.provider) setMomoProvider(ch.provider);
                    setStep('form');
                  }}
                  className={`flex items-center gap-3 p-4 min-h-[76px] rounded-2xl border-2 text-left transition-all active:scale-[0.98] touch-manipulation ${ch.tone}`}
                >
                  <div className="w-11 h-11 rounded-xl bg-background flex items-center justify-center shrink-0 shadow-sm overflow-hidden">
                    {ch.provider === 'mtn' ? (
                      <img
                        src={mtnLogoAsset.url}
                        alt="MTN"
                        className="h-full w-full object-cover"
                      />
                    ) : ch.provider === 'airtel' ? (
                      <img
                        src={airtelLogoAsset.url}
                        alt="Airtel"
                        className="h-full w-full object-cover"
                      />
                    ) : ch.id === 'bank' ? (
                      <img
                        src={equityLogoAsset.url}
                        alt="Equity Bank"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <ch.icon className="h-5 w-5 text-foreground" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-base leading-tight">{ch.label}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{ch.desc}</p>
                  </div>
                  <span aria-hidden className="text-muted-foreground text-lg">›</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          /* ─── Form ─── */
          <div className="space-y-4 w-full max-w-full pb-2">
            {/* Selected method chip — quieter than a back link, since the
                sticky header already handles back navigation. */}
            <div className="flex items-center gap-2 text-xs">
              <span className="px-2 py-1 rounded-full bg-muted text-muted-foreground font-medium">
                {getProviderLabel()}
              </span>
            </div>

            {/* ─── Detailed submit error panel ─────────────────────────
                Shows the full edge-function / database response so users
                (and support) can see exactly what failed instead of a
                disappearing toast. */}
            {submitError && (
              <div
                role="alert"
                className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 space-y-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-destructive">
                      Deposit didn’t go through
                    </p>
                    <p className="text-xs text-foreground/90 mt-0.5 break-words">
                      {submitError.message}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => { setSubmitError(null); setShowRawError(false); }}
                    aria-label="Dismiss error"
                    className="text-muted-foreground hover:text-foreground text-xs px-2 py-1 rounded hover:bg-muted shrink-0"
                  >
                    ✕
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5 text-[10px]">
                  {submitError.status !== undefined && (
                    <span className="px-2 py-0.5 rounded-full bg-destructive/10 text-destructive font-mono">
                      HTTP {submitError.status}
                    </span>
                  )}
                  {submitError.code && (
                    <span className="px-2 py-0.5 rounded-full bg-muted text-foreground font-mono">
                      code: {submitError.code}
                    </span>
                  )}
                  <span className="px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-mono">
                    {new Date(submitError.at).toLocaleTimeString()}
                  </span>
                </div>
                {(submitError.details || submitError.hint) && (
                  <div className="text-xs text-foreground/80 space-y-0.5">
                    {submitError.details && (
                      <p><span className="font-semibold">Details:</span> {submitError.details}</p>
                    )}
                    {submitError.hint && (
                      <p><span className="font-semibold">Hint:</span> {submitError.hint}</p>
                    )}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={() => { if (!isSubmitting) handleSubmit(); }}
                    className="text-[11px] font-semibold px-3 py-1.5 rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {isSubmitting ? 'Retrying…' : 'Retry now'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowRawError(v => !v)}
                    className="text-[11px] underline text-muted-foreground hover:text-foreground"
                  >
                    {showRawError ? 'Hide full response' : 'Show full response'}
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const payload = [
                          `Time: ${submitError.at}`,
                          submitError.status !== undefined ? `Status: ${submitError.status}` : null,
                          submitError.code ? `Code: ${submitError.code}` : null,
                          `Message: ${submitError.message}`,
                          submitError.details ? `Details: ${submitError.details}` : null,
                          submitError.hint ? `Hint: ${submitError.hint}` : null,
                          submitError.body ? `\nBody:\n${submitError.body}` : null,
                          `\nRaw:\n${submitError.raw}`,
                        ].filter(Boolean).join('\n');
                        await navigator.clipboard.writeText(payload);
                        toast.success('Error details copied');
                      } catch {
                        toast.error('Could not copy');
                      }
                    }}
                    className="text-[11px] font-semibold px-3 py-1.5 rounded-md border border-border bg-background hover:bg-muted"
                  >
                    Copy error
                  </button>
                </div>
                {showRawError && (
                  <div className="space-y-1.5">
                    {submitError.body && (
                      <div>
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                          Response body
                        </p>
                        <pre className="text-[11px] leading-snug bg-background border border-border rounded-md p-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono">
                          {submitError.body}
                        </pre>
                      </div>
                    )}
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                        Raw error
                      </p>
                      <pre className="text-[11px] leading-snug bg-background border border-border rounded-md p-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono">
                        {submitError.raw}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ─── MoMo Instructions (Tab-Based) ─── */}
            {channel === 'momo' && (
              <div className="space-y-3">
                {/* Provider Tabs */}
                <div className="grid grid-cols-1 xs:grid-cols-2 sm:grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => { setMomoProvider('mtn'); validateTid(transactionId, 'mtn'); }}
                    className={`flex items-center justify-center gap-2 p-2.5 rounded-xl border-2 transition-all font-semibold text-sm ${momoProvider === 'mtn' ? 'border-[hsl(var(--warning))] bg-[hsl(var(--warning))]/10 shadow-sm' : 'border-border hover:border-[hsl(var(--warning))]/50'}`}
                  >
                    <img
                      src={mtnLogoAsset.url}
                      alt="MTN MoMo logo"
                      className="w-7 h-7 rounded-full object-cover"
                      loading="lazy"
                    />
                    MTN MoMo
                  </button>
                  <button
                    type="button"
                    onClick={() => { setMomoProvider('airtel'); validateTid(transactionId, 'airtel'); }}
                    className={`flex items-center justify-center gap-2 p-2.5 rounded-xl border-2 transition-all font-semibold text-sm ${momoProvider === 'airtel' ? 'border-destructive bg-destructive/10 shadow-sm' : 'border-border hover:border-destructive/50'}`}
                  >
                    <img
                      src={airtelLogo.url}
                      alt="Airtel Money logo"
                      className="w-7 h-7 rounded-full object-cover"
                      loading="lazy"
                    />
                    Airtel Money
                  </button>
                </div>

                {/* Merchant ID — prominent with copy */}
                <div className="p-3 bg-muted/60 rounded-xl text-center space-y-1">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">Merchant ID</p>
                  <div className="flex items-center justify-center gap-2">
                    <p className="text-2xl font-mono font-bold tracking-widest">{MERCHANT_CODES[momoProvider]}</p>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(MERCHANT_CODES[momoProvider]);
                          toast.success(`Copied ${MERCHANT_CODES[momoProvider]}`);
                        } catch { toast.error('Failed to copy'); }
                      }}
                      className="p-1.5 rounded-lg hover:bg-muted transition-colors"
                    >
                      <Copy className="h-4 w-4 text-muted-foreground" />
                    </button>
                  </div>
                  <p className="text-xs text-primary font-medium">{MERCHANT_NAME}</p>
                </div>

                {/* Timeline Steps */}
                <div className="pl-3">
                  {(momoProvider === 'mtn' ? [
                    'Dial *165*3#',
                    'Choose "Pay with MoMo"',
                    `Enter Merchant ID: ${MERCHANT_CODES.mtn}`,
                    'Enter amount & confirm with PIN',
                  ] : [
                    'Dial *185*9#',
                    'Select "Pay Merchant"',
                    `Enter Merchant ID: ${MERCHANT_CODES.airtel}`,
                    'Enter amount & confirm with PIN',
                  ]).map((s, i, arr) => (
                    <div key={i} className="flex gap-3 items-start">
                      <div className="flex flex-col items-center">
                        <div className={`w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${momoProvider === 'mtn' ? 'bg-[hsl(var(--warning))] text-[hsl(var(--warning-foreground))]' : 'bg-destructive text-destructive-foreground'}`}>
                          {i + 1}
                        </div>
                        {i < arr.length - 1 && <div className="w-px h-4 bg-border" />}
                      </div>
                      <p className="text-xs text-muted-foreground pt-0.5 pb-2">{s}</p>
                    </div>
                  ))}
                </div>

              </div>
            )}

            {/* ─── Bank Instructions ─── */}
            {channel === 'bank' && (
              <div className="p-4 bg-blue-500/5 rounded-xl border border-blue-500/20 space-y-2">
                <h4 className="font-semibold text-sm flex items-center gap-2"><Building2 className="h-4 w-4 text-blue-600" /> Bank Details</h4>
                <div className="grid gap-1.5 text-xs">
                  {[
                    ['Bank', BANK_DETAILS.bankName],
                    ['Branch', BANK_DETAILS.branch],
                    ['Account Name', BANK_DETAILS.accountName],
                    ['Account No.', BANK_DETAILS.accountNumber],
                    ['Currency', BANK_DETAILS.currency],
                    ['SWIFT Code', BANK_DETAILS.swiftCode],
                  ].map(([label, value]) => (
                    <div key={label} className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-0.5 sm:gap-2">
                      <span className="text-muted-foreground shrink-0">{label}</span>
                      <div className="flex items-center gap-1.5 min-w-0 sm:justify-end">
                        <span className="font-mono font-semibold sm:text-right break-all">{value}</span>
                        <button
                          type="button"
                          aria-label={`Copy ${label}`}
                          onClick={() => copyValue(String(value), label)}
                          className="p-1 rounded hover:bg-blue-500/10 text-muted-foreground hover:text-blue-600 transition-colors shrink-0"
                        >
                          <Copy className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ─── Agent Cash Instructions ─── */}
            {channel === 'agent_cash' && (
              <div className="p-3 bg-emerald-500/5 rounded-lg border border-emerald-500/20">
                <h4 className="font-medium text-xs mb-1 flex items-center gap-1.5">
                  <Receipt className="h-3.5 w-3.5 text-emerald-600" /> Agent Cash Deposit
                </h4>
                <p className="text-xs text-muted-foreground">
                  Enter the receipt number from the physical receipt your agent gave you.
                </p>
              </div>
            )}

            {/* ─── Cash Deposit Instructions ─── */}
            {channel === 'cash' && (
              <div className="p-3 bg-violet-500/5 rounded-lg border border-violet-500/20">
                <h4 className="font-medium text-xs mb-1 flex items-center gap-1.5">
                  <Receipt className="h-3.5 w-3.5 text-violet-600" /> Cash Deposit
                </h4>
                <p className="text-xs text-muted-foreground">
                  Enter the receipt number you received when you deposited cash.
                </p>
              </div>
            )}

            {/* ─── Amount ─── */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">How much?</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground font-medium text-sm pointer-events-none">UGX</span>
                <Input
                  type="number"
                  inputMode="decimal"
                  placeholder="0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  min={MIN_DEPOSIT}
                  max={MAX_DEPOSIT}
                  id="deposit-amount"
                  aria-invalid={
                    errorFieldId === 'deposit-amount' ||
                    !!amount &&
                    Number.isFinite(parseFloat(amount)) &&
                    (parseFloat(amount) < MIN_DEPOSIT || parseFloat(amount) > MAX_DEPOSIT)
                  }
                  className={`text-2xl font-bold tabular-nums h-14 pl-14 pr-3 ${errClass('deposit-amount')}`}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Between {formatCurrency(MIN_DEPOSIT)} and {formatCurrency(MAX_DEPOSIT)}
              </p>
              {!!amount && Number.isFinite(parseFloat(amount)) && parseFloat(amount) > 0 && parseFloat(amount) < MIN_DEPOSIT && (
                <p className="text-xs text-destructive font-medium">
                  Minimum is {formatCurrency(MIN_DEPOSIT)}
                </p>
              )}
              {!!amount && Number.isFinite(parseFloat(amount)) && parseFloat(amount) > MAX_DEPOSIT && (
                <p className="text-xs text-destructive font-medium">
                  Maximum is {formatCurrency(MAX_DEPOSIT)}
                </p>
              )}
              <div className="grid grid-cols-3 gap-2 pt-1">
                {QUICK_AMOUNTS.map((amt) => (
                  <Button
                    key={amt}
                    type="button"
                    variant={amount === String(amt) ? 'default' : 'outline'}
                    className="text-sm h-11 font-medium"
                    onClick={() => setAmount(String(amt))}
                  >
                    {formatCurrency(amt)}
                  </Button>
                ))}
              </div>
            </div>

            {/* ─── Reference / TID / Receipt ─── */}
            {/* {channel !== 'agent_cash' && channel !== 'cash' ? (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-xs flex items-center gap-1.5">
                    <Hash className="h-3.5 w-3.5" />
                    {channel === 'bank' ? 'Bank Reference Number' : 'Transaction ID'} <span className="text-destructive">*</span>
                  </Label>
                  <button
                    type="button"
                    onClick={handleOpenSmsPaste}
                    className="text-sm font-semibold text-primary-foreground bg-primary inline-flex items-center gap-2 px-4 py-2 rounded-lg shadow-sm hover:bg-primary/90 active:scale-[0.98] transition"
                  >
                    <ClipboardPaste className="h-4 w-4" />
                    Paste from SMS
                  </button>
                </div>
                <div className="relative">
                  <Input
                    type="text"
                    inputMode="text"
                    id="deposit-tid"
                    placeholder={
                      channel === 'bank'
                        ? 'e.g. FT24123456789'
                        : momoProvider === 'mtn'
                          ? 'e.g. MP39665905645 or 40473329892'
                          : 'e.g. TID144205097399'
                    }
                    value={transactionId}
                    onChange={(e) => {
                      const val = e.target.value;
                      setTransactionId(val);
                      if (channel === 'momo') validateTid(val);
                    }}
                    className={`font-mono text-sm pr-9 ${errClass('deposit-tid')} ${channel === 'momo' && tidError ? 'border-destructive focus:ring-destructive' : channel === 'momo' && transactionId.trim() && !tidError ? 'border-emerald-500 focus:ring-emerald-500' : ''}`}
                  />
                  {transactionId.trim() && (
                    <button
                      type="button"
                      aria-label="Copy transaction ID"
                      onClick={() => copyValue(transactionId.trim().toUpperCase(), 'TID')}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                {channel === 'momo' && tidError && (
                  <p className="text-xs text-destructive flex items-center gap-1">
                    <AlertCircle className="h-3 w-3" /> {tidError}
                  </p>
                )}
                {channel === 'momo' && transactionId.trim() && !tidError && (
                  <p className="text-xs text-emerald-600 flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3" /> Valid TID format
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  {channel === 'bank'
                    ? 'Find this on your bank receipt or transfer confirmation'
                    : 'Enter the exact TID from your payment confirmation SMS — or tap "Paste from SMS" above'}
                </p>
              </div>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label className="text-xs flex items-center gap-1.5">
                    <Receipt className="h-3.5 w-3.5" /> Receipt Number *
                  </Label>
                  <div className="flex items-center rounded-lg border border-border overflow-hidden">
                    <span className="px-2.5 py-2 bg-muted text-muted-foreground font-mono text-xs font-semibold border-r border-border select-none">
                      RCT
                    </span>
                    <Input
                      type="text"
                      id="deposit-receipt"
                      placeholder="e.g. WEL-00001 or leave blank for auto"
                      value={receiptNumber}
                      onChange={(e) => setReceiptNumber(e.target.value)}
                      className={`font-mono border-0 focus:ring-0 rounded-l-none text-sm ${errClass('deposit-receipt')}`}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {channel === 'agent_cash' ? 'From the physical receipt the agent gave you' : 'From your cash deposit receipt'}
                  </p>
                </div>
                {channel === 'agent_cash' && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">Agent Name *</Label>
                    <Input id="deposit-agent-name" placeholder="Name of the agent who received cash" value={agentName} onChange={(e) => setAgentName(e.target.value)} className={`h-10 text-sm ${errClass('deposit-agent-name')}`} />
                  </div>
                )}
              </>
            )} */}


            {/* ─── Bank slip upload (optional) ─── */}
            {channel === 'bank' && (
              <div className="space-y-1.5">
                <Label className="text-xs flex items-center gap-1.5">
                  <Upload className="h-3.5 w-3.5" /> Bank Deposit Slip (optional)
                </Label>

                {!bankSlipFile ? (
                  // Two side-by-side actions: open the camera (mobile) or
                  // pick from gallery / files. Camera capture is a no-op on
                  // desktop and falls back to the file picker.
                  <div className="grid grid-cols-2 gap-2">
                    <label className="flex flex-col items-center justify-center gap-1 h-20 rounded-lg border-2 border-dashed border-border hover:border-primary/60 hover:bg-primary/5 cursor-pointer transition-colors">
                      <Camera className="h-5 w-5 text-muted-foreground" />
                      <span className="text-xs font-medium text-muted-foreground">Take photo</span>
                      <input
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="hidden"
                        onChange={(e) => setBankSlipFile(e.target.files?.[0] || null)}
                      />
                    </label>
                    <label className="flex flex-col items-center justify-center gap-1 h-20 rounded-lg border-2 border-dashed border-border hover:border-primary/60 hover:bg-primary/5 cursor-pointer transition-colors">
                      <ImageIcon className="h-5 w-5 text-muted-foreground" />
                      <span className="text-xs font-medium text-muted-foreground">Pick from gallery</span>
                      <input
                        type="file"
                        accept="image/*,.pdf"
                        className="hidden"
                        onChange={(e) => setBankSlipFile(e.target.files?.[0] || null)}
                      />
                    </label>
                  </div>
                ) : (
                  <div className="flex items-center gap-3 p-2 rounded-lg border border-border bg-muted/30">
                    {bankSlipPreview ? (
                      <img
                        src={bankSlipPreview}
                        alt="Bank slip preview"
                        className="h-16 w-16 rounded object-cover border border-border shrink-0"
                      />
                    ) : (
                      <div className="h-16 w-16 rounded bg-background border border-border flex items-center justify-center shrink-0">
                        <Upload className="h-5 w-5 text-muted-foreground" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium truncate">{bankSlipFile.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {(bankSlipFile.size / 1024).toFixed(0)} KB · {bankSlipFile.type || 'file'}
                      </p>
                      <p className="text-xs text-emerald-600 mt-0.5">Ready to attach</p>
                    </div>
                    <button
                      type="button"
                      aria-label="Remove slip"
                      onClick={() => setBankSlipFile(null)}
                      className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors shrink-0"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  Helps Financial Ops verify your deposit faster. Image or PDF, up to ~5 MB.
                </p>
              </div>
            )}

            {/* ─── Date & Time ─── */}
            {/* <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label className="text-xs flex items-center gap-1"><Calendar className="h-3.5 w-3.5" /> Date</Label>
                <Input id="deposit-date" type="date" value={transactionDate} onChange={(e) => setTransactionDate(e.target.value)} min={sevenDaysAgo} max={today} className={`h-10 text-xs ${errClass('deposit-date')}`} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> Time</Label>
                <Input id="deposit-time" type="time" value={transactionTime} onChange={(e) => setTransactionTime(e.target.value)} className={`h-10 text-xs ${errClass('deposit-time')}`} />
              </div>
            </div> */}


            {/* ─── Deposit Purpose ─── */}
            <div id="deposit-purpose" className={`space-y-2 scroll-mt-4 rounded-md ${errorFieldId === 'deposit-purpose' ? 'ring-2 ring-destructive/40 p-2 -m-2 border border-destructive/40' : ''}`}>
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <Label className="text-xs flex items-center gap-1"><AlertCircle className="h-3.5 w-3.5" /> Deposit Purpose *</Label>
                {lockPurpose && depositPurpose && (
                  <button
                    type="button"
                    onClick={() => setShowPurposeGrid((s) => !s)}
                    className="text-xs text-primary font-medium underline-offset-2 hover:underline"
                  >
                    {showPurposeGrid ? 'Hide options' : 'Change purpose'}
                  </button>
                )}
              </div>
              {lockPurpose && depositPurpose && !showPurposeGrid && (
                <div className="flex items-start gap-2 p-2.5 rounded-xl border-2 border-primary bg-primary/10">
                  <span className="text-base shrink-0">{DEPOSIT_PURPOSES.find(p => p.id === depositPurpose)?.emoji}</span>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-xs">{DEPOSIT_PURPOSES.find(p => p.id === depositPurpose)?.label}</p>
                    <p className="text-xs text-muted-foreground break-words">
                      {DEPOSIT_PURPOSES.find(p => p.id === depositPurpose)?.desc}
                    </p>
                  </div>
                </div>
              )}
              {/* Defensive visibility: if depositPurpose is empty for any
                  reason (state-update race after handleClose, prefill effect
                  hasn't run yet, etc.) ALWAYS show the picker — otherwise
                  the user gets a "pick a purpose" toast with no purpose
                  field on screen to pick from. */}
              {(showPurposeGrid || !lockPurpose || !depositPurpose) && (
                <>
                {!depositPurpose && (
                  <p
                    className={`text-xs ${
                      errorFieldId === 'deposit-purpose'
                        ? 'text-destructive font-medium'
                        : 'text-muted-foreground'
                    }`}
                  >
                    Pick what this money is for to continue.
                  </p>
                )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {DEPOSIT_PURPOSES.filter(p => !allowedPurposes || allowedPurposes.includes(p.id)).map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      // Agent: selecting Personal Deposit auto-stamps the
                      // required confirmation timestamp — no second confirm
                      // step. The grid itself is the explicit choice.
                      if (isAgent && p.id === 'personal_deposit') {
                        setAgentPersonalConfirmedAt(new Date().toISOString());
                        setPendingPersonalChoice(false);
                      }
                      setDepositPurpose(p.id);
                      if (p.id !== 'other') setReason(p.label);
                      else setReason('');
                      if (lockPurpose) setShowPurposeGrid(false);
                      setPurposeChosenAt(new Date().toISOString());
                      setPurposeEntryPoint((prev) => (prev === 'gate' ? 'gate' : 'in_form'));
                      // Switching away from personal_deposit clears any prior
                      // confirmation so toggling back will gate again.
                      if (p.id !== 'personal_deposit' && agentPersonalConfirmedAt) {
                        setAgentPersonalConfirmedAt(null);
                      }
                    }}
                    className={`flex items-start gap-2 p-2.5 rounded-xl border-2 text-left transition-all text-xs ${
                      depositPurpose === p.id
                        ? 'border-primary bg-primary/10 shadow-sm'
                        : 'border-border hover:border-primary/40'
                    }`}
                  >
                    <span className="text-base shrink-0">{p.emoji}</span>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold break-words">{p.label}</p>
                      <p className="text-xs text-muted-foreground break-words line-clamp-2">{p.desc}</p>
                    </div>
                  </button>
                ))}
              </div>
                </>
              )}
              {isAgent && pendingPersonalChoice && (
                <div className="rounded-xl border-2 border-warning bg-warning/10 p-3 space-y-2.5">
                  <div className="flex items-start gap-2">
                    <ShieldAlert className="h-4 w-4 text-warning shrink-0 mt-0.5" />
                    <div className="space-y-1">
                      <p className="text-xs font-semibold text-foreground">
                        Confirm: this is your own money
                      </p>
                      <p className="text-xs text-muted-foreground leading-snug">
                        Personal Deposit lands in your <span className="font-semibold">withdrawable balance</span>, not your operational float. Use this only for your own salary or personal top-ups — <span className="font-semibold">never</span> for cash collected from tenants.
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-2 pt-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="flex-1 h-9"
                      onClick={() => setPendingPersonalChoice(false)}
                    >
                      Cancel — keep as Float
                    </Button>
                    <Button
                      type="button"
                      variant="default"
                      size="sm"
                      className="flex-1 h-9 bg-warning text-warning-foreground hover:bg-warning/90"
                      onClick={() => {
                        const now = new Date().toISOString();
                        setAgentPersonalConfirmedAt(now);
                        setPendingPersonalChoice(false);
                        setDepositPurpose('personal_deposit');
                        setReason('Personal Deposit');
                        if (lockPurpose) setShowPurposeGrid(false);
                        setPurposeChosenAt(now);
                        setPurposeEntryPoint('in_form');
                      }}
                    >
                      Yes, this is my own money
                    </Button>
                  </div>
                </div>
              )}
              {depositPurpose === 'operational_float' && (
                <div className="flex items-start gap-2 p-2 bg-primary/5 rounded-lg border border-primary/20">
                  <AlertCircle className="h-3.5 w-3.5 text-primary shrink-0 mt-0.5" />
                  <p className="text-xs text-muted-foreground">
                    This deposit will be credited as <span className="font-semibold text-primary">Company Operations Float</span> — restricted to landlord disbursements only. Not withdrawable as personal funds.
                  </p>
                </div>
              )}
              {depositPurpose === 'operational_float' && currentUserId && (
                <>
                  {/* === Breakdown choice card === */}
                  <div id="deposit-breakdown-choice" className={`space-y-2 scroll-mt-4 rounded-md ${errorFieldId === 'deposit-breakdown-choice' ? 'ring-2 ring-destructive/40 p-2 -m-2 border border-destructive/40' : ''}`}>
                    <Label className="text-sm font-semibold">
                      How are you depositing this float?
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Pick one. You can change your mind below.
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setBreakdownChoice('no');
                          setTenantAllocations([]);
                        }}
                        className={`text-left rounded-xl border-2 p-3 transition-all ${
                          breakdownChoice === 'no'
                            ? 'border-primary bg-primary/10'
                            : 'border-border hover:border-primary/50 hover:bg-primary/5'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <Banknote className="h-4 w-4 text-primary" />
                          <span className="font-semibold text-sm">Just deposit (no breakdown)</span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                          Drop the lump sum into your float. No tenant tagging.
                        </p>
                      </button>
                      <button
                        type="button"
                        onClick={() => setBreakdownChoice('yes')}
                        className={`text-left rounded-xl border-2 p-3 transition-all ${
                          breakdownChoice === 'yes'
                            ? 'border-primary bg-primary/10'
                            : 'border-border hover:border-primary/50 hover:bg-primary/5'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <Receipt className="h-4 w-4 text-primary" />
                          <span className="font-semibold text-sm">Deposit with tenant breakdown</span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                          Tag each tenant who paid so they get credited instantly.
                        </p>
                      </button>
                    </div>
                    {breakdownChoice === 'no' && (
                      <div className="flex items-start gap-2 p-2 bg-muted/40 rounded-lg border border-border">
                        <AlertCircle className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                        <p className="text-xs text-muted-foreground">
                          No tenant breakdown — this will be recorded as a bulk float drop. You can allocate to tenants later from your wallet history.
                        </p>
                      </div>
                    )}
                  </div>

                  {breakdownChoice === 'yes' && !isEditMode && (
                    <DepositReferenceMatcher
                      agentId={currentUserId}
                      currentAmount={parseFloat(amount) || 0}
                      highlight={
                        // Lump-sum path: agent typed an amount but
                        // hasn't started tagging tenants yet. Make the
                        // auto-build CTA the obvious next step.
                        (parseFloat(amount) || 0) > 0 &&
                        tenantAllocations.length === 0
                      }
                      onApplyMatch={(m: MatchResult) => {
                        // Path A: matched a pending deposit row → flip
                        // the dialog into edit mode for that row. The
                        // hydrator effect will repopulate every field.
                        if (m.editDepositId) {
                          // Snapshot the agent's in-progress work + stash
                          // the match so we can restore + pre-fill if the
                          // hydrator fails (row gone, already approved,
                          // network blip, etc.).
                          preEditSnapshotRef.current = {
                            allocations: tenantAllocations.map(a => ({ ...a })),
                            amount,
                            transactionId,
                            receiptNumber,
                          };
                          pendingMatchFallbackRef.current = {
                            reference: m.reference,
                            amount: m.amount,
                            providerHint: m.providerHint,
                          };
                          if (m.reference) setTransactionId(m.reference);
                          if (m.providerHint === 'mtn' || m.providerHint === 'airtel') {
                            setChannel('momo');
                            setMomoProvider(m.providerHint);
                          } else if (m.providerHint === 'bank') {
                            setChannel('bank');
                          }
                          setMatchedEditId(m.editDepositId);
                          return;
                        }
                        // Path B: matched a bundle of unattached
                        // collections → prefill the form with the sum,
                        // the allocations, and the pasted reference.
                        if (m.amount > 0) setAmount(String(m.amount));
                        if (m.allocations.length) {
                          setTenantAllocations(m.allocations);
                          setBreakdownChoice('yes');
                        }
                        if (m.reference) {
                          if (channel === 'momo') {
                            setTransactionId(m.reference);
                            validateTid(m.reference);
                          } else if (channel === 'bank') {
                            setTransactionId(m.reference);
                          } else {
                            setReceiptNumber(m.reference.replace(/^RCT/i, ''));
                          }
                        }
                        if (m.providerHint === 'mtn' || m.providerHint === 'airtel') {
                          setChannel('momo');
                          setMomoProvider(m.providerHint);
                          validateTid(m.reference, m.providerHint);
                        } else if (m.providerHint === 'bank') {
                          setChannel('bank');
                        }
                      }}
                    />
                  )}
                  {breakdownChoice === 'yes' && (
                    <div id="deposit-tenant-allocator" className={`scroll-mt-4 rounded-md ${errorFieldId === 'deposit-tenant-allocator' ? 'ring-2 ring-destructive/40 p-2 -m-2 border border-destructive/40' : ''}`}>
                      <OperationalFloatTenantAllocator
                        agentId={currentUserId}
                        totalAmount={parseFloat(amount) || 0}
                        allocations={tenantAllocations}
                        onChange={setTenantAllocations}
                      />
                    </div>
                  )}
                  {/*
                    Edit-mode diff panel — surfaces the original
                    per-tenant amounts (as captured when the dialog
                    opened) next to the in-progress edits, so the agent
                    can eyeball every change before saving. Hidden for
                    fresh deposits and when nothing has actually moved.
                  */}
                  {breakdownChoice === 'yes' && isEditMode && (
                    <AllocationEditDiffPanel
                      original={originalAllocations}
                      updated={tenantAllocations}
                      originalAmount={originalAmount}
                      updatedAmount={parseFloat(amount) || 0}
                    />
                  )}
                  {breakdownChoice === 'yes' && (() => {
                    const total = parseFloat(amount) || 0;
                    const sum = tenantAllocations.reduce((s, a) => s + (a.amount || 0), 0);
                    const diff = total - sum;
                    if (tenantAllocations.length === 0 || total <= 0) return null;
                    if (Math.abs(diff) <= 1) {
                      return (
                        <div className="flex items-start gap-2 p-2.5 rounded-lg border border-success/30 bg-success/10">
                          <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0 mt-0.5" />
                          <p className="text-xs text-success-foreground">
                            Breakdown balanced — UGX {sum.toLocaleString()} across {tenantAllocations.length} tenant{tenantAllocations.length === 1 ? '' : 's'}.
                          </p>
                        </div>
                      );
                    }
                    return (
                      <div className="flex items-start gap-2 p-2.5 rounded-lg border border-destructive/30 bg-destructive/10">
                        <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
                        <div className="text-xs text-destructive space-y-0.5">
                          <p className="font-semibold">
                            Breakdown does not match deposit total — submission blocked.
                          </p>
                          <p>
                            Allocated <span className="font-semibold">UGX {sum.toLocaleString()}</span> of{' '}
                            <span className="font-semibold">UGX {total.toLocaleString()}</span>.{' '}
                            {diff > 0
                              ? <>You still need to allocate <span className="font-semibold">UGX {diff.toLocaleString()}</span>.</>
                              : <>You are over by <span className="font-semibold">UGX {Math.abs(diff).toLocaleString()}</span> — reduce a tenant's amount.</>}
                          </p>
                        </div>
                      </div>
                    );
                  })()}
                </>
              )}
              {depositPurpose === 'other' && (
                <Input id="deposit-reason" placeholder="Specify your reason..." value={reason} onChange={(e) => setReason(e.target.value)} className={`h-10 text-sm ${errClass('deposit-reason')}`} />
              )}
            </div>


          </div>
        )}

        {/* Pay Now USSD Button — placed at the bottom of the sheet */}
        {channel === 'momo' && amount && parseFloat(amount) > 0 && (
          <a
            href={
              momoProvider === 'mtn'
                ? `tel:*165*3*${MERCHANT_CODES.mtn}*${amount}%23`
                : `tel:*185*9*${MERCHANT_CODES.airtel}*${amount}%23`
            }
            // Native anchor — iOS Safari (and most Android in-app
            // webviews) refuse to launch the dialer from a
            // programmatic `window.location.href = "tel:"`. A real
            // <a href="tel:..."> is the only reliable way.
            onClick={() => {
              try {
                navigator.clipboard.writeText(MERCHANT_CODES[momoProvider]);
              } catch {}
              setTimeout(() => {
                toast.info(`Merchant ID: ${MERCHANT_CODES[momoProvider]} copied!`, {
                  duration: 10000,
                  action: {
                    label: 'Copy',
                    onClick: () => navigator.clipboard.writeText(MERCHANT_CODES[momoProvider]),
                  },
                });
              }, 500);
            }}
            className={`mx-4 mb-4 w-[calc(100%-2rem)] h-11 inline-flex items-center justify-center rounded-md font-semibold text-sm transition-colors ${momoProvider === 'mtn' ? 'bg-[hsl(var(--warning))] text-[hsl(var(--warning-foreground))] hover:bg-[hsl(var(--warning))]/90' : 'bg-destructive text-destructive-foreground hover:bg-destructive/90'}`}
          >
            <Phone className="h-4 w-4 mr-2" />
            Call {momoProvider === 'mtn' ? `*165*3*${MERCHANT_CODES.mtn}*${amount}#` : `*185*9*${MERCHANT_CODES.airtel}*${amount}#`}
          </a>
        )}

        {/* /scroll body */}
        </div>
      </DialogContent>
    </Dialog>
    {smsPasteOpen && (
      <div
        className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center bg-black/60 p-0 sm:p-4"
        style={{ pointerEvents: 'auto' }}
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            setSmsPasteOpen(false);
            setSmsConfirmStep(false);
          }
        }}
      >
      <div
        className="w-full sm:max-w-md bg-background rounded-t-2xl sm:rounded-2xl shadow-xl max-h-[90vh] overflow-y-auto p-4 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 text-base font-semibold">
          <ClipboardPaste className="h-4 w-4 text-primary" />
          {smsConfirmStep ? 'Confirm extracted details' : 'Paste your SMS'}
        </div>
        {!smsConfirmStep ? (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Paste the full payment confirmation SMS below. We'll auto-fill
            the amount, transaction ID, date and time.
          </p>
          <Textarea
            value={smsPasteText}
            onChange={(e) => setSmsPasteText(e.target.value)}
            placeholder={'e.g. "You have received UGX 50,000. TID144205097399 on 04/05/2026 at 14:32"'}
            rows={6}
            className="font-mono text-xs"
            autoFocus
          />
          {(() => {
            const trimmed = smsPasteText.trim();
            if (!trimmed) return null;
            const preview = parseSMS(trimmed);
            const found = [preview.amount, preview.transactionId, preview.date, preview.time].filter(Boolean).length;
            return (
              <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1.5">
                <div className="flex items-center justify-between">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Live preview
                  </p>
                  <span className={cn(
                    "text-[10px] font-medium px-2 py-0.5 rounded-full",
                    found === 4 ? "bg-success/15 text-success" : found > 0 ? "bg-amber-500/15 text-amber-700" : "bg-destructive/15 text-destructive"
                  )}>
                    {found}/4 detected
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                  <div>
                    <p className="text-[10px] text-muted-foreground">Amount</p>
                    <p className={cn("font-mono font-semibold", !preview.amount && "text-muted-foreground/60")}>
                      {preview.amount ? `UGX ${preview.amount.toLocaleString()}` : '—'}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] text-muted-foreground">Transaction ID</p>
                    <p className={cn("font-mono font-semibold truncate", !preview.transactionId && "text-muted-foreground/60")}>
                      {preview.transactionId || '—'}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] text-muted-foreground">Date</p>
                    <p className={cn("font-mono font-semibold", !preview.date && "text-muted-foreground/60")}>
                      {preview.date || '—'}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] text-muted-foreground">Time</p>
                    <p className={cn("font-mono font-semibold", !preview.time && "text-muted-foreground/60")}>
                      {preview.time || '—'}
                    </p>
                  </div>
                </div>
              </div>
            );
          })()}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={() => setSmsPasteOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="flex-1"
              onClick={() => setSmsConfirmStep(true)}
              disabled={!smsPasteText.trim()}
            >
              Review →
            </Button>
          </div>
        </div>
        ) : (() => {
          const preview = parseSMS(smsPasteText.trim());
          const found = [preview.amount, preview.transactionId, preview.date, preview.time].filter(Boolean).length;
          const Row = ({ label, value }: { label: string; value: string | null | undefined }) => (
            <div className="flex items-center justify-between gap-3 py-2 border-b border-border last:border-0">
              <span className="text-xs text-muted-foreground">{label}</span>
              <span className={cn("text-sm font-mono font-semibold text-right truncate", !value && "text-muted-foreground/60 font-normal")}>
                {value || 'Not detected'}
              </span>
            </div>
          );
          return (
            <div className="space-y-3">
              <div className={cn(
                "rounded-lg border p-3",
                found === 4 ? "border-success/40 bg-success/5" : "border-amber-300 bg-amber-50"
              )}>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                  {found}/4 fields detected
                </p>
                <Row label="Amount" value={preview.amount ? `UGX ${preview.amount.toLocaleString()}` : null} />
                <Row label="Transaction ID" value={preview.transactionId} />
                <Row label="Date" value={preview.date} />
                <Row label="Time" value={preview.time} />
              </div>
              {found < 4 && (
                <p className="text-[11px] text-amber-700">
                  Some fields couldn't be read. You can still confirm — missing fields will be left blank for you to fill manually.
                </p>
              )}
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1"
                  onClick={() => setSmsConfirmStep(false)}
                >
                  ← Back
                </Button>
                <Button
                  type="button"
                  className="flex-1"
                  onClick={() => {
                    const ok = applyPastedSms(smsPasteText);
                    if (ok) {
                      setSmsPasteText('');
                      setSmsConfirmStep(false);
                      // Defer close to next tick so Radix's focus-restore
                      // doesn't race with the parent dialog's outside-interaction
                      // handler on touch devices (mobile Confirm & fill bug).
                      setTimeout(() => setSmsPasteOpen(false), 0);
                    }
                  }}
                >
                  Confirm & fill
                </Button>
              </div>
            </div>
          );
        })()}
      </div>
      </div>
    )}
    {/* Unsaved-changes confirm — only mounts when a user tries to back out
        with content typed. Mobile-friendly: stacked full-width buttons. */}
    <AlertDialog
      open={confirmIntent !== null}
      onOpenChange={(o) => { if (!o) setConfirmIntent(null); }}
    >
      <AlertDialogContent className="sm:max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {confirmIntent === 'close' ? 'Leave deposit?' : 'Go back?'}
          </AlertDialogTitle>
          <AlertDialogDescription>
            You have unsaved details. Don't worry — we'll keep a draft so you
            can pick up where you left off. Leave anyway?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex-col-reverse sm:flex-row gap-2">
          <AlertDialogCancel className="h-12 mt-0 text-base font-semibold touch-manipulation">
            Keep editing
          </AlertDialogCancel>
          <AlertDialogAction
            className="h-12 text-base font-semibold touch-manipulation"
            onClick={() => {
              const intent = confirmIntent;
              setConfirmIntent(null);
              if (intent === 'back') setStep('channel');
              else if (intent === 'close') handleClose();
            }}
          >
            Leave anyway
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <CashWithFinancialOpsDeposit
      open={showFinOpsCashDeposit}
      onOpenChange={setShowFinOpsCashDeposit}
      onSuccess={() => { setShowFinOpsCashDeposit(false); onOpenChange(false); }}
    />
    </>
  );
}
