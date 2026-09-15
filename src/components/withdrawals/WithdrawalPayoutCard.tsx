import { useState, useMemo, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import {
  Banknote, CheckCircle2, Loader2, Building2, Clock, Smartphone,
  UserCheck, ArrowRight, Phone, CreditCard, ChevronDown, XCircle,
  Copy, AlertTriangle, ClipboardPaste, Upload, X as XIcon, FileText, Lock,
  ShieldCheck,
} from 'lucide-react';
import { parsePayoutConfirmationSms } from '@/utils/smsParser';
import { usePayoutsUiEnabled } from '@/hooks/usePayoutsUiEnabled';
import { humanizeWithdrawalError } from '@/lib/withdrawalErrorText';
import {
  beginAuthCriticalSection,
  endAuthCriticalSection,
  armAuthCriticalSection,
  disarmAuthCriticalSection,
} from '@/lib/staleSessionDetector';

export interface WithdrawalPayoutCardProps {
  withdrawal: any;
  isClaimed?: boolean;
  isClaimedByOther?: boolean;
  onClaim?: (confirm?: { momoNumber?: string | null; momoName?: string | null }) => void;
  onComplete?: (data: {
    id: string;
    reference: string;
    method: string;
    sms?: string;
    proofUrl?: string;
    proofType?: string;
    proofPath?: string;
    proofBucket?: string;
    proofUploadedBy?: string;
  }) => void | Promise<any>;
  /** ID of the withdrawal currently being claimed (for per-request loading) */
  claimingId?: string | null;
  /** ID of the withdrawal currently being completed (for per-request loading) */
  completingId?: string | null;
  /** Read-only mode: hide Claim/Confirm actions (used by CFO viewer) */
  readOnly?: boolean;
}

export function WithdrawalPayoutCard({
  withdrawal,
  isClaimed = false,
  isClaimedByOther = false,
  onClaim,
  onComplete,
  claimingId = null,
  completingId = null,
  readOnly = false,
}: WithdrawalPayoutCardProps) {
  const { enabled: payoutsUiEnabled } = usePayoutsUiEnabled();
  const { isExempt: isLegacyExempt } = useWithdrawalVerificationExemption(withdrawal?.id);
  const [reference, setReference] = useState('');



  // Raw confirmation SMS the merchant agent pastes after sending the money.
  // We parse out the TID (auto-fills the reference) and the sent amount, then
  // enforce that the sent amount matches the amount the user requested.
  const [pastedSms, setPastedSms] = useState('');
  // Uploaded proof-of-payment file (photo of receipt / bank slip / MoMo screenshot).
  // Required for bank & cash offline payouts; optional for MoMo (which has SMS).
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [proofUploading, setProofUploading] = useState(false);
  const [proofUrl, setProofUrl] = useState<string | null>(null);
  const [proofPath, setProofPath] = useState<string | null>(null);
  // A merchant's active claim must reveal the customer and payment controls
  // immediately. Requiring a second tap left some mobile users looking at the
  // collapsed summary while the server correctly blocked another claim.
  const [open, setOpen] = useState(isClaimed);
  // Specific, inline reason the LAST confirmation attempt was rejected by the
  // server (amount mismatch / TID mismatch / unreadable). Drives the retry
  // prompt so the agent knows exactly what to fix and can paste again.
  const [completeError, setCompleteError] = useState<string | null>(null);
  const [confirmClaimOpen, setConfirmClaimOpen] = useState(false);
  const [claimDetailsConfirmed, setClaimDetailsConfirmed] = useState(false);
  const [enteredPayoutName, setEnteredPayoutName] = useState('');
  const [mismatchAcknowledged, setMismatchAcknowledged] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState<string>('');
  const [rejectNotes, setRejectNotes] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const qc = useQueryClient();

  useEffect(() => {
    if (isClaimed) setOpen(true);
  }, [isClaimed, withdrawal.id]);

  // ── Reload-proof proof state ───────────────────────────────────────────────
  // On mobile, opening the camera/gallery frequently makes the browser discard
  // and re-create the page. When that happens this component remounts with
  // empty state, so an already-uploaded proof looks "missing" and the agent
  // cannot confirm. We therefore persist the uploaded storage path locally and
  // also recover it from Cloud storage on mount.
  const proofStorageKey = `welile:payout-proof:${withdrawal.id}`;

  function persistProof(path: string | null, url: string | null, name?: string) {
    try {
      if (!path) localStorage.removeItem(proofStorageKey);
      else localStorage.setItem(proofStorageKey, JSON.stringify({ path, url, name, at: Date.now() }));
    } catch { /* private mode / quota — non-fatal */ }
  }
  const [recoveredProofName, setRecoveredProofName] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (proofPath || proofUrl) return;
      // 1) Local breadcrumb written the moment the upload succeeded.
      let path: string | null = null;
      let name: string | undefined;
      try {
        const raw = localStorage.getItem(proofStorageKey);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed?.path) { path = parsed.path; name = parsed.name; }
        }
      } catch { /* ignore */ }

      // 2) Fallback: ask storage directly — covers a reload that happened
      //    after the upload but before the breadcrumb could be written.
      if (!path) {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user?.id) return;
        const { data: files } = await supabase.storage
          .from('payment-proofs')
          .list(`${user.id}/payout-proofs`, { limit: 100, sortBy: { column: 'created_at', order: 'desc' } });
        const match = (files ?? []).find(f => f.name.startsWith(`${withdrawal.id}-`));
        if (match) {
          path = `${user.id}/payout-proofs/${match.name}`;
          name = match.name;
        }
      }
      if (!path || cancelled) return;

      const { data: signed } = await supabase.storage
        .from('payment-proofs')
        .createSignedUrl(path, 60 * 60 * 24 * 365);
      if (cancelled || !signed?.signedUrl) return;
      setProofPath(path);
      setProofUrl(signed.signedUrl);
      setRecoveredProofName(name ?? path.split('/').pop() ?? 'proof');
      persistProof(path, signed.signedUrl, name);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withdrawal.id]);

  const REJECT_REASONS = [
    'Customer no-show',
    'Wrong amount',
    'ID mismatch',
    'Suspected fraud',
    'Recipient details invalid',
    'Other',
  ];

  async function handleReject() {
    if (!rejectReason) return;
    const composed = `${rejectReason}${rejectNotes.trim() ? ` — ${rejectNotes.trim()}` : ''}`;
    if (composed.length < 10) {
      toast.error('Please add a few more details (min 10 characters total)');
      return;
    }
    setRejecting(true);
    try {
      // Merchant Agent reject = RELEASE the claim back into the queue so
      // another agent (or Financial Ops) can pick it up. We do NOT mark the
      // withdrawal itself as rejected — that's a Financial Ops decision.
      // The withdrawal stays in its original status (pending / approved) and
      // simply returns to the unclaimed pool. We log the release reason for
      // audit so repeated releases by the same agent can be flagged.
      const { data: { user } } = await supabase.auth.getUser();
      const { error: relErr } = await supabase
        .from('withdrawal_requests')
        .update({
          assigned_cashout_agent_id: null,
          dispatched_at: null,
        } as any)
        .eq('id', withdrawal.id);
      if (relErr) throw relErr;

      // Audit the release (mandatory 10+ char reason already enforced above).
      try {
        await supabase.from('audit_logs').insert({
          user_id: user?.id ?? null,
          action_type: 'merchant_payout_released',
          table_name: 'withdrawal_requests',
          record_id: withdrawal.id,
          reason: composed.slice(0, 500),
          metadata: {
            amount: Number(withdrawal.amount || 0),
            payout_method: withdrawal.payout_method,
            previous_status: withdrawal.status,
            released_at: new Date().toISOString(),
          },
        });
      } catch (auditErr) {
        console.warn('[withdrawal-release] audit log failed', auditErr);
      }

      // Notify the recipient (on the MoMo number they wanted to be paid on,
      // falling back to their profile phone) that their request returned to
      // the queue. Fire-and-forget — never block the release on the SMS.
      supabase.functions
        .invoke('notify-withdrawal-released', {
          body: { withdrawal_id: withdrawal.id, reason: 'manual' },
        })
        .catch((e) => console.warn('[withdrawal-release] notify failed', e));

      toast.success('Released back to queue · another agent can pick it up');
      setRejectOpen(false);
      setRejectReason('');
      setRejectNotes('');
      qc.invalidateQueries({ queryKey: ['cashout-agent-all-withdrawals'] });
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setRejecting(false);
    }
  }

  const method = withdrawal.payout_method || 'cash';
  const isMoMo = ['mobile_money', 'mtn_mobile_money', 'airtel_money'].includes(method);
  const isBank = method === 'bank_transfer';
  const isCash = !isMoMo && !isBank;

  const methodLabel = isBank ? 'Bank Transfer' : isMoMo ? 'Mobile Money' : 'Cash';
  const MethodIcon = isBank ? Building2 : isMoMo ? Smartphone : Banknote;

  // Resolve the recipient name through every available signal so proxy /
  // partner payouts never collapse to the literal "Unknown". For proxy partner
  // withdrawals the requesting `user_id` is the agent, so the actual payee lives
  // on the linked partner profile and the registered payout name.
  const recipientName =
    (withdrawal.profiles?.full_name || '').trim()
    || (withdrawal.linked_party_profile?.full_name || '').trim()
    || (withdrawal.partner_name || '').trim()
    || (withdrawal.mobile_money_name || '').trim()
    || (withdrawal.bank_account_name || '').trim()
    || 'Unknown';
  const recipientPhone =
    withdrawal.profiles?.phone
    || withdrawal.linked_party_profile?.phone
    || '—';

  const momoNumber = withdrawal.mobile_money_number || recipientPhone;
  const momoRegisteredName = withdrawal.mobile_money_name || '';

  // ── Pre-claim privacy gate ────────────────────────────────────────────────
  // Merchant agents MUST NOT see the recipient's phone number, MoMo number,
  // registered name, bank account, or full name BEFORE claiming — otherwise
  // they can pay the customer off-platform (via their personal MTN/Airtel SIM)
  // and never claim the request in-app, leaving the ledger un-settled. All
  // sensitive fields are masked until the withdrawal is claimed (or the card
  // is opened in a read-only reviewer view like the CFO viewer).
  const revealed = isClaimed || readOnly;
  const maskPhone = (p?: string | null) => {
    const digits = (p || '').replace(/\D/g, '');
    if (!digits) return '•••••••';
    return `••• ••• ••${digits.slice(-3)}`;
  };
  const maskName = (n?: string | null) => {
    const s = (n || '').trim();
    if (!s) return 'Hidden';
    const parts = s.split(/\s+/);
    const initials = parts.slice(0, 2).map((p) => (p[0] || '').toUpperCase()).join('');
    return `${initials || '••'} •••`;
  };
  const maskAccount = (a?: string | null) => {
    const digits = (a || '').replace(/\s+/g, '');
    if (!digits) return '•••••••';
    return `•••• ${digits.slice(-3)}`;
  };
  const displayRecipientName = revealed ? recipientName : maskName(recipientName);
  const displayRecipientPhone = revealed ? recipientPhone : maskPhone(recipientPhone);
  const displayMomoNumber = revealed ? momoNumber : maskPhone(momoNumber);
  const displayMomoName = revealed ? momoRegisteredName : (momoRegisteredName ? maskName(momoRegisteredName) : '');
  const displayBankAccount = revealed ? (withdrawal.bank_account_number || '—') : maskAccount(withdrawal.bank_account_number);
  const displayBankName = revealed ? (withdrawal.bank_account_name || '—') : (withdrawal.bank_account_name ? maskName(withdrawal.bank_account_name) : 'Hidden');

  // Normalize names for a forgiving comparison (case-insensitive, collapse
  // whitespace, ignore punctuation) so only meaningful differences flag.
  const normalizeName = (s: string) =>
    (s || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  const enteredNameTrimmed = enteredPayoutName.trim();
  const hasEnteredName = enteredNameTrimmed.length > 0;
  const nameMismatch =
    isMoMo &&
    !!momoRegisteredName &&
    hasEnteredName &&
    normalizeName(enteredNameTrimmed) !== normalizeName(momoRegisteredName);

  function copyToClipboard(value: string, label: string) {
    const v = (value || '').toString().trim();
    if (!v || v === '—') return;
    // Strip whitespace only for numeric fields (number/account); keep spaces in names.
    const isNumericField = /number|account|contact|code/i.test(label);
    const payload = isNumericField ? v.replace(/\s+/g, '') : v;
    navigator.clipboard?.writeText(payload)
      .then(() => toast.success(`${label} copied`))
      .catch(() => toast.error('Could not copy'));
  }

  // Has it been claimed by SOMEONE (me or other) and not yet completed?
  const isAwaitingPayment =
    !!withdrawal.assigned_cashout_agent_id &&
    withdrawal.status !== 'completed' &&
    withdrawal.status !== 'approved';

  // How long ago was it claimed? (for stale-claim warning)
  const claimedMinutesAgo = withdrawal.dispatched_at
    ? Math.floor((Date.now() - new Date(withdrawal.dispatched_at).getTime()) / 60000)
    : null;
  const isStale = claimedMinutesAgo !== null && claimedMinutesAgo >= 15;

  // What the merchant agent earns for processing this payout.
  // Matches approve-withdrawal: gross commission = round(amount * 0.005) = 0.5%.
  // No platform/service fee is deducted from the agent's commission, so the
  // net earning equals the gross commission. These figures are derived here so
  // the breakdown shown in the claim dialog reconciles 1:1 with what is credited.
  const payoutAmount = Math.max(0, Number(withdrawal.amount || 0));
  const COMMISSION_RATE = 0.005; // 0.5%
  const grossCommission = Math.round(payoutAmount * COMMISSION_RATE);
  const platformServiceFee = 0; // Welile takes no cut from the agent commission
  const agentEarning = Math.max(0, grossCommission - platformServiceFee);

  // ── Parse the pasted confirmation SMS ─────────────────────────────────────
  // The merchant pastes the raw "you have sent…" SMS from their MTN/Airtel/bank
  // app. We extract the TID and the sent amount so the agent can't fat-finger
  // the reference and so we can prove the amount they sent equals the amount the
  // user requested. The DB reference guard remains the authoritative gate.
  const parsedSms = useMemo(
    () => (pastedSms.trim() ? parsePayoutConfirmationSms(pastedSms) : null),
    [pastedSms],
  );
  const parsedTid = parsedSms?.transactionId ?? null;
  const parsedAmount = parsedSms?.amount ?? null;
  const parsedPhone = parsedSms?.phone ?? null;
  const parsedDate = parsedSms?.date ?? null;
  const parsedTime = parsedSms?.time ?? null;
  const hasPastedSms = pastedSms.trim().length > 0;
  const amountMatches = parsedAmount != null && parsedAmount === payoutAmount;
  const amountMismatch = parsedAmount != null && parsedAmount !== payoutAmount;

  // Structured client-side parse log — one line whenever the pasted SMS
  // changes — so support can reproduce/debug failures from the browser
  // console without needing the raw message. No raw SMS body is logged.
  useEffect(() => {
    if (!hasPastedSms) return;
    console.info('[payout] sms_parse', {
      withdrawal_id: withdrawal.id ?? null,
      payout_method: withdrawal.payout_method ?? null,
      extracted_amount: parsedAmount,
      extracted_tid: parsedTid,
      requested_amount: payoutAmount,
      sms_length: pastedSms.length,
      amount_pattern_matched: parsedAmount != null,
      tid_pattern_matched: parsedTid != null,
      amount_matches_expected: amountMatches,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pastedSms]);

  // ── Retry workflow ────────────────────────────────────────────────────────
  // Wipe the pasted SMS + auto-filled reference so the agent gets a clean slate
  // to paste the correct confirmation message again.
  function clearPaste() {
    setPastedSms('');
    setReference('');
    setCompleteError(null);
  }

  // Reset the uploaded proof file/URL after a successful confirm or on manual
  // clear. Keeps the UI in a clean state for the next payout in this card.
  function clearProof() {
    setProofFile(null);
    setProofUrl(null);
    setProofPath(null);
    setRecoveredProofName(null);
    persistProof(null, null);
  }

  // Upload the proof to Cloud storage under the agent's own folder (RLS gate).
  // Returns the public URL and stored path, or throws with a friendly message.
  async function uploadProofFile(file: File): Promise<{
    url: string; type: string; path: string; bucket: string; uploadedBy: string;
  }> {
    // Read the session from local storage instead of calling `auth.getUser()`:
    // that is a network round-trip which, right after the phone camera closes,
    // frequently comes back 401 (expired token / no radio) and used to trip the
    // stale-session detector into signing the merchant out mid-upload.
    const { data: { session } } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user?.id) throw new Error('You must be signed in to upload proof.');
    beginAuthCriticalSection();
    try {
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
    const path = `${user.id}/payout-proofs/${withdrawal.id}-${Date.now()}.${ext}`;
    const { error: upErr } = await supabase.storage
      .from('payment-proofs')
      .upload(path, file, { upsert: true, contentType: file.type || undefined });
    if (upErr) throw new Error(upErr.message || 'Failed to upload proof.');
    // `payment-proofs` is a PRIVATE bucket — public URLs return object-not-found
    // when auditors/CFOs later try to open the proof. We persist the storage
    // PATH as the authoritative reference (never expires) and keep a long-lived
    // signed URL only for backward compatibility with older readers.
    const { data: signed, error: signErr } = await supabase.storage
      .from('payment-proofs')
      .createSignedUrl(path, 60 * 60 * 24 * 365); // 1 year
    if (signErr || !signed?.signedUrl) {
      throw new Error(signErr?.message || 'Failed to generate proof link.');
    }
    return {
      url: signed.signedUrl,
      type: file.type || `image/${ext}`,
      path,
      bucket: 'payment-proofs',
      uploadedBy: user.id,
    };
    } finally {
      endAuthCriticalSection();
    }
  }

  // Submit the payout and, on server-side rejection, surface the SPECIFIC reason
  // inline (instead of only a transient toast) so the agent can fix and retry.
  async function handleConfirmPaid() {
    setCompleteError(null);
    try {
      // PROOF IS MANDATORY FOR EVERY PAYOUT CHANNEL (bank, cash and MoMo).
      // Without a proof image the wallet must NOT be debited — the server
      // enforces the same rule (PROOF_REQUIRED).
      if (!proofFile && !proofUrl) {
        setCompleteError('Upload a photo of the payment proof (bank slip, receipt, MoMo confirmation) before confirming. Without proof the payout cannot be completed and the customer wallet stays untouched.');
        return;
      }
      let uploaded = proofUrl
        ? {
            url: proofUrl,
            type: proofFile?.type || 'image/jpeg',
            path: proofPath ?? undefined,
            bucket: proofPath ? 'payment-proofs' : undefined,
            uploadedBy: undefined as string | undefined,
          }
        : null;
      if (proofFile && !proofUrl) {
        setProofUploading(true);
        try {
          uploaded = await uploadProofFile(proofFile);
          setProofUrl(uploaded.url);
          setProofPath(uploaded.path);
          persistProof(uploaded.path, uploaded.url, proofFile.name);
        } finally {
          setProofUploading(false);
        }
      }
      await onComplete?.({
        id: withdrawal.id,
        reference,
        method: methodLabel,
        sms: pastedSms.trim() || undefined,
        proofUrl: uploaded?.url,
        proofType: uploaded?.type,
        proofPath: uploaded?.path,
        proofBucket: uploaded?.bucket,
        proofUploadedBy: uploaded?.uploadedBy,
      });
      clearProof();
    } catch (e: any) {
      setCompleteError(
        humanizeWithdrawalError(
          e?.message || 'Payout could not be confirmed. Check the details and try again.',
          recipientName,
        ),
      );
    }
  }

  // ── What is the user actually withdrawing? ────────────────────────────────
  // Mirror the classification used by the approve-withdrawal SMS so the merchant
  // agent sees the same purpose the recipient is told about. NOT every payout is
  // a partnership (ROI) return — it can be a landlord float payout or a plain
  // wallet cash-out.
  const _reasonLc = (typeof withdrawal.reason === 'string' ? withdrawal.reason : '').toLowerCase();
  const isProxyReason = _reasonLc.includes('proxy');
  const purpose: { label: string; className: string } = (() => {
    if (_reasonLc.startsWith('landlord float payout') || _reasonLc.includes('landlord float')) {
      return { label: 'Landlord payout', className: 'bg-blue-500/15 text-blue-600 dark:text-blue-400' };
    }
    if (
      _reasonLc.includes('portfolio') ||
      _reasonLc.includes('partnership') ||
      _reasonLc.includes('roi') ||
      _reasonLc.includes('return')
    ) {
      return { label: 'Partnership return', className: 'bg-purple-500/15 text-purple-600 dark:text-purple-400' };
    }
    return { label: 'Wallet withdrawal', className: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' };
  })();

  // Record exactly what the agent confirmed at claim time so it can be
  // reviewed later (which number / which registered name they accepted,
  // whether the typed name mismatched, and if they acknowledged it).
  async function recordClaimConfirmation() {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const confirmedName = isMoMo
        ? (enteredNameTrimmed || momoRegisteredName || recipientName)
        : (isBank ? (withdrawal.bank_account_name || recipientName) : recipientName);
      const confirmedNumber = isMoMo
        ? momoNumber
        : (isBank ? (withdrawal.bank_account_number || '—') : recipientPhone);
      const reason = `Merchant confirmed payout to ${confirmedNumber} (${confirmedName || 'name not provided'})`;
      await supabase.from('audit_logs').insert({
        user_id: user?.id ?? null,
        action_type: 'merchant_payout_claim_confirmed',
        table_name: 'withdrawal_requests',
        record_id: withdrawal.id,
        reason: reason.slice(0, 500),
        metadata: {
          payout_method: method,
          amount: Number(withdrawal.amount || 0),
          confirmed_momo_number: isMoMo ? momoNumber : null,
          registered_momo_name: isMoMo ? (momoRegisteredName || null) : null,
          agent_entered_screen_name: isMoMo ? (enteredNameTrimmed || null) : null,
          name_mismatch: !!nameMismatch,
          mismatch_acknowledged: nameMismatch ? !!mismatchAcknowledged : null,
          confirmed_account_number: isBank ? (withdrawal.bank_account_number || null) : null,
          confirmed_account_name: isBank ? (withdrawal.bank_account_name || null) : null,
          confirmed_at: new Date().toISOString(),
        },
      });
    } catch (auditErr) {
      console.warn('[withdrawal-claim] confirmation audit log failed', auditErr);
    }
  }

  return (
    <Card className={`rounded-2xl ${isClaimedByOther && !readOnly ? 'opacity-50' : ''}`}>
      <Collapsible open={open} onOpenChange={setOpen}>
        {/* Collapsed header — name + amount */}
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="w-full text-left p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 hover:bg-muted/40 transition-colors rounded-t-2xl"
          >
            <div className="min-w-0 flex-1 w-full">
              <p className="font-bold text-lg truncate leading-tight">{displayRecipientName}</p>
              {/* Payout target at a glance — visible before claiming/expanding */}
              {isMoMo && revealed && (
                <p className="text-sm font-mono font-semibold text-foreground/80 truncate mt-0.5">
                  {momoNumber}
                  {momoRegisteredName ? <span className="font-sans font-medium"> · {momoRegisteredName}</span> : ''}
                </p>
              )}
              {isMoMo && !revealed && (
                <p className="text-xs font-medium text-muted-foreground truncate mt-0.5 inline-flex items-center gap-1">
                  <Lock className="h-3 w-3" /> Number hidden — claim to reveal
                </p>
              )}
              <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                <Badge variant="secondary" className="text-xs gap-1 h-5 px-2 max-w-full">
                  <MethodIcon className="h-3 w-3 shrink-0" />
                  <span className="truncate">{methodLabel}</span>
                </Badge>
                {/* What the user is withdrawing — visible before claiming */}
                <Badge className={`text-xs h-5 px-2 font-semibold border-0 max-w-full ${purpose.className}`}>
                  <span className="truncate">
                    {purpose.label}
                    {isProxyReason ? ' · on behalf' : ''}
                  </span>
                </Badge>
                {/* AWAITING PAYMENT — shown to claiming agent AND to read-only viewers (CFO)
                    so a stuck/sitting claim is always visible, no matter how long ago. */}
                {isAwaitingPayment && (
                  <Badge
                    className={`text-xs h-5 px-2 gap-1 max-w-full ${
                      isStale
                        ? 'bg-destructive text-destructive-foreground hover:bg-destructive'
                        : 'bg-warning text-warning-foreground hover:bg-warning'
                    }`}
                  >
                    <Clock className="h-3 w-3 shrink-0" />
                    <span className="truncate">
                      {isStale && claimedMinutesAgo !== null
                        ? `AWAITING PAYMENT · ${claimedMinutesAgo}m`
                        : 'AWAITING PAYMENT'}
                    </span>
                  </Badge>
                )}
                {isClaimedByOther && !readOnly && (
                  <Badge variant="outline" className="text-xs h-5 px-2 text-muted-foreground">
                    Taken
                  </Badge>
                )}
                {withdrawal?.payout_proof_verification_status && (
                  <Badge
                    variant="outline"
                    className={`text-xs h-5 px-2 gap-1 max-w-full ${
                      withdrawal.payout_proof_verification_status === 'match'
                        ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30'
                        : withdrawal.payout_proof_verification_status === 'mismatch'
                        ? 'bg-destructive/15 text-destructive border-destructive/30'
                        : 'bg-muted text-muted-foreground border-border'
                    }`}
                  >
                    <ShieldCheck className="h-3 w-3 shrink-0" />
                    <span className="truncate">
                      {withdrawal.payout_proof_verification_status === 'match'
                        ? 'Proof Photo Verified'
                        : withdrawal.payout_proof_verification_status === 'mismatch'
                        ? 'Proof Mismatch'
                        : 'Proof Unverifiable'}
                    </span>
                  </Badge>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0 w-full sm:w-auto justify-between sm:justify-end">
              <div className="flex flex-col items-start sm:items-end">
                <p className="font-bold text-xl text-primary tabular-nums leading-tight">{formatUGX(withdrawal.amount)}</p>
                {!isClaimed && !isClaimedByOther && agentEarning > 0 && (
                  <span className="inline-flex items-center gap-1 mt-0.5 rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-bold text-success tabular-nums">
                    + You earn {formatUGX(agentEarning)}
                  </span>
                )}
              </div>
              <ChevronDown className={`h-5 w-5 text-muted-foreground transition-transform shrink-0 ${open ? 'rotate-180' : ''}`} />
            </div>
          </button>
        </CollapsibleTrigger>

        {/* Expanded body */}
        <CollapsibleContent>
          <CardContent className="px-4 pb-4 pt-0 space-y-3">
            {isLegacyExempt && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
                <p className="text-xs text-amber-700 dark:text-amber-300 leading-snug">
                  Legacy queue exemption — payout verification waived for this existing request only.
                  All other payment checks still apply.
                </p>
              </div>
            )}
            {/* Contact + status row */}

            <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground flex-wrap">
              <span className="inline-flex items-center gap-1">
                <Phone className="h-4 w-4" />
                {displayRecipientPhone}
              </span>
              <span className="inline-flex items-center gap-1">
                <Clock className="h-4 w-4" />
                {format(new Date(withdrawal.created_at), 'MMM d, HH:mm')}
              </span>
            </div>

            {/* Recipient Payout Details — hidden until CLAIMED so the merchant
                agent cannot pay the recipient off-platform (from their personal
                SIM) without booking the payout through the system. */}
            {!revealed ? (
              <div className="rounded-xl border-2 border-dashed border-primary/40 bg-primary/5 p-4 text-sm space-y-2">
                <p className="font-bold text-xs uppercase tracking-wider text-primary flex items-center gap-1.5">
                  <Lock className="h-3.5 w-3.5" /> Payout details locked
                </p>
                <p className="text-sm text-foreground/80 leading-snug">
                  The Mobile Money number, registered name and account holder are hidden until you <strong>Claim</strong> this withdrawal.
                </p>
                <p className="text-xs text-muted-foreground leading-snug">
                  This protects the platform from off-book payouts. Only claim if you are ready to send the money in-app right now.
                </p>
              </div>
            ) : (
            <div className="rounded-xl border-2 border-primary/30 bg-primary/5 p-3.5 space-y-3 text-sm">
              <p className="font-bold text-xs uppercase tracking-wider text-primary flex items-center gap-1">
                <CreditCard className="h-3.5 w-3.5" />
                Pay out to
              </p>

              {isMoMo && (
                <>
                  <Badge variant="secondary" className="gap-1 h-6 px-2.5 text-xs font-semibold">
                    <Smartphone className="h-3.5 w-3.5" />
                    {withdrawal.mobile_money_provider || methodLabel}
                  </Badge>

                  {/* Number — large, prominent tap-to-copy button */}
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Mobile Money Number</p>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(momoNumber, 'Number')}
                      className="mt-1 w-full flex items-center justify-between gap-2 sm:gap-3 rounded-xl border-2 border-primary/40 bg-background px-3 sm:px-3.5 py-2.5 text-left transition-colors hover:bg-primary/10 active:scale-[0.99]"
                      title="Tap to copy number"
                    >
                      <span className="min-w-0 flex-1 font-mono font-extrabold text-lg sm:text-2xl leading-none tracking-wide tabular-nums break-all">{momoNumber}</span>
                      <span className="shrink-0 inline-flex items-center gap-1 text-xs font-bold uppercase tracking-wide text-primary">
                        <Copy className="h-4 w-4" /> Copy
                      </span>
                    </button>
                  </div>

                  {/* Registered name — large, one-tap copy + verify reminder */}
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Registered name on this number</p>
                    {momoRegisteredName ? (
                      <>
                        <button
                          type="button"
                          onClick={() => copyToClipboard(momoRegisteredName, 'Name')}
                          className="mt-1 w-full flex items-center justify-between gap-2 sm:gap-3 rounded-xl border-2 border-primary/40 bg-background px-3 sm:px-3.5 py-2.5 text-left transition-colors hover:bg-primary/10 active:scale-[0.99]"
                          title="Tap to copy name"
                        >
                          <span className="min-w-0 flex-1 font-extrabold text-base sm:text-lg leading-tight break-words">{momoRegisteredName}</span>
                          <span className="shrink-0 inline-flex items-center gap-1 text-xs font-bold uppercase tracking-wide text-primary">
                            <Copy className="h-4 w-4" /> Copy
                          </span>
                        </button>
                        <p className="mt-1 text-[11px] text-muted-foreground flex items-start gap-1">
                          <CheckCircle2 className="h-3.5 w-3.5 mt-px shrink-0 text-primary" />
                          Confirm your MTN/Airtel screen shows this exact name before sending.
                        </p>
                      </>
                    ) : (
                      <p className="mt-0.5 font-semibold text-sm text-warning flex items-start gap-1">
                        <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                        Not provided — verify the name on your screen with the recipient by phone.
                      </p>
                    )}
                  </div>
                </>
              )}

              {isBank && (
                <>
                  <div className="flex justify-between gap-2"><span className="text-muted-foreground shrink-0">Bank</span><span className="font-medium truncate">{withdrawal.bank_name || '—'}</span></div>
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Account Number</p>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(withdrawal.bank_account_number, 'Account number')}
                      className="mt-0.5 flex items-center gap-2 group"
                      title="Tap to copy"
                    >
                      <span className="font-mono font-extrabold text-2xl leading-none tracking-wide tabular-nums">{withdrawal.bank_account_number || '—'}</span>
                      <Copy className="h-4 w-4 text-muted-foreground group-hover:text-primary shrink-0" />
                    </button>
                  </div>
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Account name</p>
                    <p className="mt-0.5 font-extrabold text-lg leading-tight break-words">{withdrawal.bank_account_name || '—'}</p>
                  </div>
                </>
              )}

              {isCash && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Recipient contact</p>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(recipientPhone, 'Contact')}
                    className="mt-0.5 flex items-center gap-2 group"
                    title="Tap to copy"
                  >
                    <span className="font-mono font-extrabold text-2xl leading-none tracking-wide tabular-nums">{recipientPhone}</span>
                    <Copy className="h-4 w-4 text-muted-foreground group-hover:text-primary shrink-0" />
                  </button>
                </div>
              )}

              {/* Account holder (who is withdrawing) — always shown for cross-check */}
              <div className="pt-2 border-t border-primary/15 flex justify-between gap-2">
                <span className="text-muted-foreground shrink-0">Account holder</span>
                <span className="font-semibold truncate text-right">{recipientName}</span>
              </div>
            </div>
            )}

            {/* Status pill */}
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="secondary" className="text-xs">{withdrawal.status?.replace(/_/g, ' ')}</Badge>
              {readOnly && !isClaimed && !isClaimedByOther && (
                <Badge variant="outline" className="text-xs">Unclaimed</Badge>
              )}
            </div>

            {withdrawal.reason && (
              <p className="text-sm text-muted-foreground italic break-words">"{withdrawal.reason}"</p>
            )}

            {/* Actions */}
            {readOnly ? null : isClaimedByOther ? null : !isClaimed ? (
              <div className="space-y-2">
                {claimingId === withdrawal.id && (
                  <div className="rounded-lg bg-blue-500/10 border border-blue-500/30 px-3 py-2 text-sm font-semibold text-blue-700 dark:text-blue-400 flex items-center gap-1.5">
                    <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                    <span>Submitting claim… please wait</span>
                  </div>
                )}
                {agentEarning > 0 && (
                  <div className="rounded-xl bg-success/10 border-2 border-success/40 px-4 py-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="h-9 w-9 rounded-full bg-success/20 flex items-center justify-center shrink-0">
                        <Banknote className="h-5 w-5 text-success" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-success/80 leading-none">You earn for this payout</p>
                        <p className="text-xs text-muted-foreground mt-0.5">0.5% commission · paid to your wallet on completion</p>
                      </div>
                    </div>
                    <p className="text-2xl font-extrabold text-success tabular-nums shrink-0">{formatUGX(agentEarning)}</p>
                  </div>
                )}
                <Button
                  className="w-full h-12 gap-2 font-semibold text-base"
                  variant={payoutsUiEnabled ? 'default' : 'outline'}
                  onClick={() => { if (payoutsUiEnabled) onClaim?.(); }}
                  disabled={!payoutsUiEnabled}
                  title={payoutsUiEnabled ? undefined : 'Claiming is temporarily disabled'}
                >
                  <UserCheck className="h-5 w-5" /> Claim This Withdrawal
                </Button>
              </div>
            ) : (
              <div className="space-y-2 pt-2 border-t border-border/50">
                {completingId === withdrawal.id && (
                  <div className="rounded-lg bg-blue-500/10 border border-blue-500/30 px-3 py-2 text-sm font-semibold text-blue-700 dark:text-blue-400 flex items-center gap-1.5">
                    <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                    <span>Confirming payment &amp; verifying proof photo… please wait</span>
                  </div>
                )}
                <p className="text-sm font-semibold text-primary flex items-start gap-1.5">
                  <ArrowRight className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>{isBank ? 'Send bank transfer to the account above, then enter the bank reference / TID' : isMoMo ? 'Send MoMo to the number above, then enter the TID from your confirmation SMS' : 'Coordinate with the user by phone, hand over cash, then enter the payout code they share'}</span>
                </p>
                {/* Paste-from-SMS: auto-extracts the TID and the sent amount, and
                    proves the amount sent equals the amount requested. Only shown
                    for MoMo/bank payouts (cash uses a payout code, no SMS). */}
                {(isMoMo || isBank) && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-start">
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
                        <ClipboardPaste className="h-3.5 w-3.5" />
                        Paste your confirmation SMS (recommended)
                      </label>
                      <Textarea
                        value={pastedSms}
                        onChange={(e) => {
                          const text = e.target.value;
                          setPastedSms(text);
                          setCompleteError(null);
                          const p = text.trim() ? parsePayoutConfirmationSms(text) : null;
                          // Auto-fill the reference from the extracted TID.
                          if (p?.transactionId) setReference(p.transactionId);
                        }}
                        placeholder="Paste any SMS that contains the amount sent and the TID / reference — we only extract those two values."
                        rows={3}
                        className="text-sm resize-none"
                      />
                      <p className="text-[10px] text-muted-foreground">
                        We only read the amount, TID, phone and date from this message.
                      </p>
                    </div>
                    <div className="rounded-xl border bg-muted/40 p-3 space-y-2 text-xs self-start">
                      <p className="font-semibold text-foreground flex items-center gap-1.5">
                        <ClipboardPaste className="h-3.5 w-3.5 text-muted-foreground" />
                        Extracted from SMS
                      </p>
                      <div className="space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-muted-foreground">TID</span>
                          <span className="font-mono font-semibold">
                            {parsedTid || <span className="text-warning">Not found</span>}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-muted-foreground">Amount sent</span>
                          <span className="font-semibold tabular-nums">
                            {parsedAmount != null ? formatUGX(parsedAmount) : <span className="text-warning">Not found</span>}
                          </span>
                        </div>
                        {parsedPhone && (
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-muted-foreground">Recipient Phone</span>
                            <span className="font-mono font-semibold">{parsedPhone}</span>
                          </div>
                        )}
                        {(parsedDate || parsedTime) && (
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-muted-foreground">Date / Time</span>
                            <span className="font-medium text-foreground/80">
                              {[parsedDate, parsedTime].filter(Boolean).join(' ')}
                            </span>
                          </div>
                        )}
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-muted-foreground">Amount requested</span>
                          <span className="font-semibold tabular-nums">{formatUGX(payoutAmount)}</span>
                        </div>
                      </div>
                      <div className="pt-1 border-t border-border/50">
                        {amountMatches && parsedTid ? (
                          <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/15 gap-1.5 border-0">
                            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                            Matched
                          </Badge>
                        ) : amountMismatch ? (
                          <div className="space-y-1">
                            <Badge variant="destructive" className="gap-1.5 border-0">
                              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                              Mismatched
                            </Badge>
                            <p className="text-destructive font-medium">
                              Sent {formatUGX(parsedAmount!)} ≠ requested {formatUGX(payoutAmount)}.
                            </p>
                            <p className="text-muted-foreground">
                              Paste the SMS for the correct transaction, or clear and try again.
                            </p>
                          </div>
                        ) : (
                          <Badge variant="secondary" className="gap-1.5">
                            <Clock className="h-3.5 w-3.5 shrink-0" />
                            Waiting for valid SMS
                          </Badge>
                        )}
                      </div>
                      {hasPastedSms && (
                        <button
                          type="button"
                          onClick={clearPaste}
                          className="text-[11px] font-semibold text-primary hover:underline"
                        >
                          Clear &amp; paste again
                        </button>
                      )}
                    </div>
                  </div>
                )}
                {/* Server-side validation rejection — specific reason + retry prompt */}
                {completeError && (
                  <div className="rounded-xl border-2 border-destructive/50 bg-destructive/10 p-3 space-y-2">
                    <p className="text-sm font-bold text-destructive flex items-start gap-1.5">
                      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                      Confirmation rejected
                    </p>
                    <p className="text-xs text-destructive/90 leading-snug whitespace-pre-line">{completeError}</p>
                    {/[Tt]ID|amount|SMS|mismatch|match|read/.test(completeError) && (
                      <p className="text-xs text-destructive/80 leading-snug font-medium">
                        This payout is still yours — fix the transaction ID / amount, paste the correct SMS, and confirm again.
                      </p>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5"
                      onClick={clearPaste}
                    >
                      <ClipboardPaste className="h-3.5 w-3.5" />
                      Clear &amp; paste again
                    </Button>
                  </div>
                )}
                <div className="flex flex-col sm:flex-row gap-2">
                  <Input
                    placeholder={isBank ? 'Bank reference / TID...' : isMoMo ? 'MoMo Transaction ID (TID)...' : 'Payout code from user...'}
                    value={reference}
                    onChange={e => { setReference(e.target.value); setCompleteError(null); }}
                    className="text-base h-12 font-mono flex-1 min-w-0"
                  />
                  <Button
                    className="h-12 gap-1.5 px-5 sm:w-auto w-full text-base font-semibold"
                    disabled={
                      !reference.trim() ||
                      reference.trim().length < 3 ||
                      completingId === withdrawal.id ||
                      amountMismatch ||
                      proofUploading ||
                      (!proofFile && !proofUrl)
                    }
                    onClick={handleConfirmPaid}
                    title={completingId === withdrawal.id ? 'Request is being processed…' : 'Confirm this payout'}
                  >
                    {completingId === withdrawal.id || proofUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                    {proofUploading ? 'Uploading proof…' : completingId === withdrawal.id ? 'Verifying proof photo…' : 'Confirm Paid'}
                  </Button>
                </div>
                {/* Proof of payment upload — mandatory for bank & offline cash
                    payouts, optional for MoMo (which is already SMS-verified).
                    Uploads to Cloud storage under the agent's own folder. */}
                <div className="rounded-xl border bg-muted/30 p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                      <Upload className="h-3.5 w-3.5 text-primary" />
                      Proof of payment <span className="text-destructive">*</span>
                    </label>
                    {(proofFile || proofUrl) && (
                      <button
                        type="button"
                        onClick={clearProof}
                        className="text-[11px] font-semibold text-destructive hover:underline inline-flex items-center gap-1"
                      >
                        <XIcon className="h-3 w-3" /> Remove
                      </button>
                    )}
                  </div>
                  {proofFile || proofUrl ? (
                    <div className="flex items-center gap-3">
                      {proofFile ? (
                        proofFile.type.startsWith('image/') ? (
                        <img
                          src={URL.createObjectURL(proofFile)}
                          alt="Payment proof preview"
                          className="h-20 w-20 object-cover rounded-lg border"
                        />
                        ) : (
                          <div className="h-20 w-20 flex items-center justify-center rounded-lg border bg-background">
                            <FileText className="h-8 w-8 text-muted-foreground" />
                          </div>
                        )
                      ) : (
                        <img
                          src={proofUrl!}
                          alt="Payment proof"
                          className="h-20 w-20 object-cover rounded-lg border bg-background"
                        />
                      )}
                      <div className="min-w-0 text-xs">
                        <p className="font-semibold truncate">{proofFile?.name || recoveredProofName || 'Payment proof'}</p>
                        {proofFile
                          ? <p className="text-muted-foreground">{(proofFile.size / 1024).toFixed(0)} KB</p>
                          : <p className="text-muted-foreground">Recovered from your earlier upload</p>}
                        {proofUploading
                          ? <p className="text-muted-foreground font-medium mt-0.5">Uploading…</p>
                          : proofUrl
                            ? <p className="text-emerald-600 font-medium mt-0.5">Uploaded</p>
                            : <p className="text-destructive font-medium mt-0.5">Not uploaded — tap below to retry</p>}
                        <label
                          htmlFor={`proof-upload-${withdrawal.id}`}
                          className="mt-1 inline-block text-primary underline cursor-pointer"
                        >
                          Change photo
                        </label>
                      </div>
                    </div>
                  ) : (
                    <label
                      htmlFor={`proof-upload-${withdrawal.id}`}
                      className="flex items-center justify-center gap-2 h-11 rounded-lg border-2 border-dashed border-border cursor-pointer hover:border-primary hover:bg-primary/5 transition-colors text-sm text-muted-foreground"
                    >
                      <Upload className="h-4 w-4" />
                      Tap to add a photo of the receipt / bank slip
                    </label>
                  )}
                  <input
                    id={`proof-upload-${withdrawal.id}`}
                    type="file"
                    accept="image/*,application/pdf"
                    className="hidden"
                    onClick={() => {
                      // The camera / gallery is about to take over the screen.
                      // Arm sign-out suppression NOW: the page can be resumed
                      // with an expired token before onChange ever runs, and
                      // that must never end the merchant's session.
                      armAuthCriticalSection(180_000);
                    }}
                    onChange={async (e) => {
                      const f = e.target.files?.[0] || null;
                      e.target.value = '';
                      if (!f) { disarmAuthCriticalSection(); return; }
                      if (f && f.size > 8 * 1024 * 1024) {
                        disarmAuthCriticalSection();
                        toast.error('File must be under 8 MB');
                        return;
                      }
                      setProofFile(f);
                      setProofUrl(null);
                      setCompleteError(null);
                      // Upload IMMEDIATELY. On mobile the browser often discards
                      // the page while the camera/gallery is open, so a file kept
                      // only in memory until "Confirm paid" is silently lost.
                      if (f) {
                        setProofUploading(true);
                        try {
                          const uploaded = await uploadProofFile(f);
                          setProofUrl(uploaded.url);
                          setProofPath(uploaded.path);
                          persistProof(uploaded.path, uploaded.url, f.name);
                          toast.success('Proof uploaded');
                        } catch (err: any) {
                          setProofUrl(null);
                          setProofPath(null);
                          persistProof(null, null);
                          setCompleteError(err?.message || 'Failed to upload proof. Try again.');
                          toast.error(err?.message || 'Failed to upload proof');
                        } finally {
                          setProofUploading(false);
                          disarmAuthCriticalSection();
                        }
                      }
                    }}
                  />
                  <p className="text-[10px] text-muted-foreground leading-snug">
                    {isBank
                      ? 'Attach a photo of the bank deposit slip or the bank app confirmation screen.'
                      : isCash
                        ? 'Attach a photo of the signed cash receipt or the recipient counting the cash.'
                        : 'Optional — the SMS already proves this MoMo payout. Attach a screenshot if you want a visual receipt too.'}
                  </p>
                </div>
                <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
                  <CheckCircle2 className="h-3.5 w-3.5 mt-px shrink-0 text-emerald-500" />
                  Once confirmed, the recipient gets an SMS with a link to a proof-of-payment receipt showing this TID, the amount, the destination details, the date/time, and your name.
                </p>
                <Button
                  variant="ghost"
                  className="w-full h-11 text-sm text-destructive hover:text-destructive hover:bg-destructive/10 gap-1.5"
                  onClick={() => setRejectOpen(true)}
                  disabled={completingId === withdrawal.id || rejecting}
                  title={completingId === withdrawal.id ? 'Request is being processed…' : 'Release this withdrawal back to the queue'}
                >
                  <XCircle className="h-4 w-4" />
                  Release back to queue
                </Button>
              </div>
            )}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>

      <Dialog open={rejectOpen} onOpenChange={(v) => !rejecting && setRejectOpen(v)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Release payout · {formatUGX(withdrawal.amount)}</DialogTitle>
            <DialogDescription>
              This withdrawal will be returned to the queue so another Merchant Agent (or Financial Ops) can pick it up. The recipient's funds stay on hold — only Financial Ops can fully reject. This action is logged.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium">Reason</label>
              <Select value={rejectReason} onValueChange={setRejectReason}>
                <SelectTrigger className="h-10">
                  <SelectValue placeholder="Select a reason..." />
                </SelectTrigger>
                <SelectContent>
                  {REJECT_REASONS.map(r => (
                    <SelectItem key={r} value={r}>{r}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium">
                Notes {rejectReason === 'Other' ? <span className="text-destructive">*</span> : <span className="text-muted-foreground">(optional)</span>}
              </label>
              <Textarea
                value={rejectNotes}
                onChange={(e) => setRejectNotes(e.target.value)}
                placeholder="Add context for the audit log..."
                rows={3}
                maxLength={500}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectOpen(false)} disabled={rejecting}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={handleReject}
              disabled={
                rejecting ||
                !rejectReason ||
                (rejectReason === 'Other' && rejectNotes.trim().length < 5)
              }
            >
              {rejecting ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <XCircle className="h-4 w-4 mr-1.5" />}
              Release to queue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pre-claim confirmation — agent must confirm the payout target matches
          what they'll send on their MTN/Airtel screen BEFORE claiming. */}
      <Dialog open={confirmClaimOpen} onOpenChange={(v) => claimingId !== withdrawal.id && setConfirmClaimOpen(v)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Confirm payout details · {formatUGX(withdrawal.amount)}</DialogTitle>
            <DialogDescription>
              Check these against your MTN/Airtel screen before you claim. You are responsible for paying the correct number and name.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {agentEarning > 0 && (
              <div className="rounded-xl bg-success/10 border-2 border-success/40 p-4 space-y-2.5">
                <div className="flex items-center gap-2">
                  <Banknote className="h-5 w-5 text-success shrink-0" />
                  <p className="text-sm font-bold text-success">Your earnings breakdown</p>
                </div>
                <div className="space-y-1.5 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">Payout amount</span>
                    <span className="font-semibold tabular-nums">{formatUGX(payoutAmount)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">Commission rate</span>
                    <span className="font-semibold tabular-nums">{(COMMISSION_RATE * 100).toFixed(1)}%</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">Gross commission</span>
                    <span className="font-semibold tabular-nums">{formatUGX(grossCommission)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">Platform service fee</span>
                    <span className="font-semibold tabular-nums">
                      {platformServiceFee > 0 ? `– ${formatUGX(platformServiceFee)}` : formatUGX(0)}
                    </span>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-success/30 pt-2.5">
                  <span className="text-sm font-bold text-success">Net earning</span>
                  <span className="text-xl font-extrabold text-success tabular-nums">{formatUGX(agentEarning)}</span>
                </div>
                <p className="text-[11px] text-muted-foreground leading-snug">
                  Credited to your withdrawable wallet once you confirm this payout as paid.
                </p>
              </div>
            )}
            {isMoMo ? (
              <div className="rounded-xl border-2 border-primary/30 bg-primary/5 p-3.5 space-y-3">
                <div className="rounded-lg border border-primary/30 bg-background/60 p-3 flex items-start gap-2">
                  <Lock className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                  <div className="text-xs leading-snug">
                    <p className="font-bold text-foreground">Mobile Money number and registered name are hidden until you claim.</p>
                    <p className="text-muted-foreground mt-1">
                      Once you claim, the number and registered name unlock in the card. Send the money in-app only — off-book payouts cannot be settled by the system.
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Method</p>
                    <p className="mt-0.5 font-semibold">{withdrawal.mobile_money_provider || methodLabel}</p>
                  </div>
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Amount</p>
                    <p className="mt-0.5 font-extrabold tabular-nums">{formatUGX(withdrawal.amount)}</p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border-2 border-primary/30 bg-primary/5 p-3.5 space-y-2 text-sm">
                <div className="flex justify-between gap-2"><span className="text-muted-foreground shrink-0">Method</span><span className="font-semibold truncate text-right">{methodLabel}</span></div>
                <div className="flex justify-between gap-2"><span className="text-muted-foreground shrink-0">Amount</span><span className="font-extrabold tabular-nums text-right">{formatUGX(withdrawal.amount)}</span></div>
                <div className="rounded-lg border border-primary/30 bg-background/60 p-3 flex items-start gap-2">
                  <Lock className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                  <div className="text-xs leading-snug">
                    <p className="font-bold text-foreground">{isBank ? 'Bank account details' : 'Recipient contact'} hidden until claim.</p>
                    <p className="text-muted-foreground mt-1">
                      Claim to unlock the {isBank ? 'account number and account name' : 'recipient phone'} in the card, then send the payment.
                    </p>
                  </div>
                </div>
              </div>
            )}

            <label className="flex items-start gap-2.5 cursor-pointer rounded-lg border border-border/60 p-3">
              <Checkbox
                checked={claimDetailsConfirmed}
                onCheckedChange={(v) => setClaimDetailsConfirmed(v === true)}
                className="mt-0.5"
              />
              <span className="text-sm font-medium leading-snug">
                I understand payout details are hidden until I claim, and I will send this payment in-app immediately after claiming.
              </span>
            </label>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmClaimOpen(false)} disabled={claimingId === withdrawal.id}>Cancel</Button>
            <Button
              disabled={
                !claimDetailsConfirmed ||
                claimingId === withdrawal.id
              }
              onClick={() => {
                setConfirmClaimOpen(false);
                // Persist the exact confirmed payout target for later review.
                void recordClaimConfirmation();
                // The stored MoMo number and registered name are passed
                // programmatically so the server-side exact-match guard
                // (claim_withdrawal_verified) still runs — the merchant just
                // does not SEE them on-screen until the claim is granted.
                onClaim?.({
                  momoNumber: isMoMo ? momoNumber : null,
                  momoName: isMoMo ? momoRegisteredName : null,
                });
              }}
            >
              {claimingId === withdrawal.id ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <UserCheck className="h-4 w-4 mr-1.5" />}
              Confirm & Claim
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
