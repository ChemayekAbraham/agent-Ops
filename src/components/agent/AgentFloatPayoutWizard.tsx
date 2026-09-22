import { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useCaptureLocation } from '@/hooks/useCaptureLocation';
import { useLandlordOtp } from '@/hooks/useLandlordOtp';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import {
  Landmark, Loader2, CheckCircle2, Phone, ArrowRight,
  Clock, User2, Home, ShieldCheck, RefreshCw, AlertTriangle, Timer, RotateCcw
} from 'lucide-react';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import { LandlordPayoutProgress } from './LandlordPayoutProgress';
import { setCriticalFlowActive } from '@/lib/criticalFlowGuard';
import { extractFromErrorObject } from '@/lib/extractEdgeFunctionError';
import type { LandlordFloatAllocation } from '@/hooks/useLandlordFloatAllocations';
import { useAgentLandlordFloat } from '@/hooks/useAgentLandlordFloat';

interface AgentFloatPayoutWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * When the agent drilled in from the per-tenant allocations list, this is the
   * exact ring-fenced allocation they tapped. The wizard MUST scope the payout
   * to this landlord/tenant instead of showing its own internal list (which was
   * pulling an unrelated assigned request — e.g. "boniface" — and ignoring the
   * agent's actual selection).
   */
  allocation?: LandlordFloatAllocation | null;
  /**
   * Fired when the agent taps "Done" after a payout that was opened from the
   * Landlord Payout Float allocations list (i.e. `allocation` was supplied).
   * The parent uses this to reopen that list so the agent lands back on it to
   * withdraw for the next landlord, instead of dropping to the bare dashboard.
   */
  onDone?: () => void;
}

type Step = 'select' | 'otp' | 'disburse' | 'done';

/**
 * One landlord payout that is currently ring-fencing part of this agent's
 * Landlord Payout Float, from the `agent_lp_float_holds` view.
 * `hold_state` says whether the hold is real or stranded:
 *  - holding_live / holding_unlinked   → genuinely in flight, leave alone
 *  - holding_settled_needs_review      → already paid, Financial Ops must look
 *  - released_* → the backing merchant withdrawal is dead or missing; the
 *    float was never debited and can be freed.
 */
interface FloatHold {
  payout_id: string;
  landlord_name: string | null;
  amount: number;
  payout_status: string;
  withdrawal_status: string | null;
  hold_state:
    | 'holding_live'
    | 'holding_unlinked'
    | 'holding_settled_needs_review'
    | 'released_orphaned'
    | 'released_dead_withdrawal';
  payout_created_at: string;
}

// `agent_lp_float_holds` is newer than the checked-in generated types, so reach
// it through a loosened client rather than sprinkling `as any` at each call site.
type SupabaseLoose = {
  from: (table: string) => ReturnType<typeof supabase.from>;
};

/** "3 hours", "2 days" — how long a submitted payment has been waiting. */
function waitingFor(since: string): string {
  const ms = Date.now() - new Date(since).getTime();
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${Math.round(hours / 24)} days`;
}

function maskLandlordPhone(phone?: string | null): string {
  if (!phone) return '';
  const clean = phone.trim();
  if (clean.startsWith('+256')) {
    const rest = clean.slice(4).replace(/\s+/g, '');
    if (rest.length >= 7) {
      return `+256 ${rest.slice(0, 3)} ${rest.charAt(3)}•• •••`;
    }
  }
  const digits = clean.replace(/\D/g, '');
  if (digits.startsWith('256') && digits.length === 12) {
    const nat = digits.slice(3);
    return `+256 ${nat.slice(0, 3)} ${nat.charAt(3)}•• •••`;
  }
  if (digits.startsWith('0') && digits.length === 10) {
    return `${digits.slice(0, 4)} ${digits.charAt(4)}•• •••`;
  }
  if (digits.length === 9) {
    return `0${digits.slice(0, 3)} ${digits.charAt(3)}•• •••`;
  }
  return phone;
}

export function AgentFloatPayoutWizard({ open, onOpenChange, allocation, onDone }: AgentFloatPayoutWizardProps) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const geo = useCaptureLocation();
  const landlordOtp = useLandlordOtp();
  const [step, setStep] = useState<Step>('select');
  const [selectedRequest, setSelectedRequest] = useState<any>(null);
  const [allocationPrepping, setAllocationPrepping] = useState(false);
  const [provider, setProvider] = useState('');
  const [tid, setTid] = useState('');
  const [notes, setNotes] = useState('');
  const [receiptFiles, setReceiptFiles] = useState<File[]>([]);
  const [otpCode, setOtpCode] = useState('');
  const [resendCooldown, setResendCooldown] = useState(0);
  const [amountInput, setAmountInput] = useState<string>('');
  // Inline, always-visible reason the "Send OTP to Landlord" step failed.
  const [sendOtpError, setSendOtpError] = useState<string | null>(null);
  // GPS capture happens before the OTP request. Track that preparation phase
  // explicitly so the button never falsely says an OTP was already sent while
  // the browser is still waiting for (or has stalled on) location permission.
  const [preparingOtp, setPreparingOtp] = useState(false);
  // Landlord-Ops-verified landlords lock the phone number; agents request a
  // change via Landlord Ops instead of editing it inline.
  const [showPhoneChangeReq, setShowPhoneChangeReq] = useState(false);
  const [newPhoneReq, setNewPhoneReq] = useState('');
  const [phoneReqNote, setPhoneReqNote] = useState('');
  const [submittingPhoneReq, setSubmittingPhoneReq] = useState(false);
  // "Resubmit to CFO" — return the allocated (not-yet-paid) landlord float back
  // to the CFO for re-routing. Requires a reason and CFO approval.
  const [showReturnPanel, setShowReturnPanel] = useState(false);
  const [returnReason, setReturnReason] = useState('');
  const [submittingReturn, setSubmittingReturn] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const cooldownRef = useRef<ReturnType<typeof setTimeout>>();
  // Incrementing resend cooldown: first send = 30s, each subsequent send +30s.
  const cooldownStepRef = useRef(0);
  const autoSendRef = useRef<string | null>(null);
  const allocationPrepRef = useRef<string | null>(null);
  // Landlords this agent has already sent an OTP to in this session. Once an
  // OTP is sent for a landlord we lock the button so a repeat tap can never
  // fire a second SMS to the same person.
  const sentLandlordsRef = useRef<Set<string>>(new Set());
  const [, forceLockRender] = useState(0);

  useEffect(() => {
    if (resendCooldown > 0) {
      cooldownRef.current = setTimeout(() => setResendCooldown(resendCooldown - 1), 1000);
    }
    return () => clearTimeout(cooldownRef.current);
  }, [resendCooldown]);

  // Bump the resend cooldown by another 30s step (30 → 60 → 90 …).
  const bumpCooldown = () => {
    cooldownStepRef.current += 1;
    setResendCooldown(30 * cooldownStepRef.current);
  };

  // While the payout wizard is open, suppress iOS PWA full-cache
  // invalidation and service-worker skipWaiting so dipping out to MoMo
  // USSD / Messages for an OTP does not reload the page mid-flow.
  useEffect(() => {
    if (!open) return;
    setCriticalFlowActive('agent-float-payout', true);
    return () => setCriticalFlowActive('agent-float-payout', false);
  }, [open]);

  // AUTHORITATIVE landlord-payout float — this is a separate CFO-funded pool
  // used only by Pay Landlord. Tenant rent collections use wallet float instead.
  const {
    floatBalance: authoritativeFloat,
    availableBalance: authoritativeAvailable,
    reservedBalance: reservedFloat,
    isLoading: landlordPayoutFloatLoading,
    refetch: refetchLandlordPayoutFloat,
  } = useAgentLandlordFloat(user?.id);
  // Spend against the reservation-aware figure the backend enforces, not the
  // gross pool — otherwise the wizard promises money the payout will refuse.
  const grossFloatBalance = Number(authoritativeFloat ?? 0);
  const rawFloatBalance = Number(authoritativeAvailable ?? 0);
  const floatBalance = Number.isFinite(rawFloatBalance) ? rawFloatBalance : 0;

  // What is actually holding this agent's float. Only fetched when the wizard
  // is open AND something is being withheld, so the agent sees the specific
  // payouts instead of a bare "UGX 0 available" dead end.
  const { data: floatHolds = [] } = useQuery<FloatHold[]>({
    queryKey: ['agent-lp-float-holds', user?.id],
    queryFn: async () => {
      if (!user) return [];
      // `agent_lp_float_holds` is a view outside the generated types — resolve it
      // through a deliberately loose client so the query does not blow the
      // type-instantiation budget.
      const looseFrom = (supabase as unknown as {
        from: (table: string) => {
          select: (cols: string) => {
            eq: (col: string, val: string) => {
              order: (col: string, opts: { ascending: boolean }) => Promise<{ data: unknown; error: unknown }>;
            };
          };
        };
      }).from;
      const { data, error } = await looseFrom('agent_lp_float_holds')
        .select('payout_id, landlord_name, amount, payout_status, withdrawal_status, hold_state, payout_created_at')
        .eq('agent_id', user.id)
        .order('payout_created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as FloatHold[];
    },
    enabled: !!user && open && reservedFloat > 0,
    staleTime: 0,
  });

  const { data: assignedRequests = [], isLoading } = useQuery({
    queryKey: ['agent-float-payout-requests', user?.id],
    queryFn: async () => {
      if (!user) return [];
      const { data: assignments } = await supabase
        .from('agent_landlord_assignments')
        .select('landlord_id, rent_request_id')
        .eq('agent_id', user.id)
        .eq('status', 'active');
      if (!assignments?.length) return [];
      const landlordIds = [...new Set(assignments.map(a => a.landlord_id))];

      const { data } = await supabase
        .from('rent_requests')
        .select('id, rent_amount, tenant_id, landlord_id, status, created_at')
        .in('landlord_id', landlordIds)
        .in('status', ['funded'])
        .order('created_at', { ascending: false });

      const enriched = await Promise.all((data || []).map(async (r: any) => {
        const [{ data: landlord }, { data: tenant }, { data: existing }, { data: livePayout }] = await Promise.all([
          supabase.from('landlords').select('id, name, phone, mobile_money_number, verified_mobile_money_number, latitude, longitude, verification_status, verified').eq('id', r.landlord_id).single(),
          supabase.from('profiles').select('id, full_name, phone').eq('id', r.tenant_id).single(),
          supabase.from('agent_float_withdrawals').select('id').eq('rent_request_id', r.id).eq('agent_id', user.id).maybeSingle(),
          // A landlord payout already in flight (or completed) for this rent
          // cycle means the landlord has been paid — never list it again, or the
          // same landlord shows twice and can be double-paid.
          supabase
            .from('landlord_payouts')
            .select('id')
            .eq('rent_request_id', r.id)
            .in('status', ['otp_verified', 'pending_merchant_payout', 'pending_finops_disbursement', 'disbursing', 'awaiting_agent_receipt', 'completed'])
            .limit(1)
            .maybeSingle(),
        ]);
        return { ...r, landlord, tenant, hasPaid: !!existing?.id || !!livePayout?.id };
      }));

      // Collapse duplicate cycles: one payable line per landlord + tenant pair,
      // keeping the newest rent request (list is already newest-first).
      const seen = new Set<string>();
      return enriched
        .filter((r: any) => !r.hasPaid)
        .filter((r: any) => {
          const key = `${r.landlord_id}:${r.tenant_id}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    },
    enabled: !!user && open,
  });

  const resetForm = () => {
    setStep('select');
    setSelectedRequest(null);
    setAllocationPrepping(false);
    setResumedExistingPayout(false);
    setResumedPayoutAmount(null);
    setProvider('');
    setTid('');
    setNotes('');
    setReceiptFiles([]);
    setOtpCode('');
    setResendCooldown(0);
    setAmountInput('');
    setSendOtpError(null);
    setPreparingOtp(false);
    setShowPhoneChangeReq(false);
    setNewPhoneReq('');
    setPhoneReqNote('');
    setShowReturnPanel(false);
    setReturnReason('');
    cooldownStepRef.current = 0;
    autoSendRef.current = null;
    allocationPrepRef.current = null;
    landlordOtp.resetOtp();
  };

  const handleClose = () => { resetForm(); onOpenChange(false); };

  const handleFiles = (files: FileList | null) => {
    if (!files) return;
    setReceiptFiles(prev => [...prev, ...Array.from(files)].slice(0, 3));
  };

  const landlordVerified =
    selectedRequest?.landlord?.verification_status === 'verified' ||
    selectedRequest?.landlord?.verified === true;
  // The landlord's MoMo number is never agent-editable here — a wrong or
  // agent-retargeted number misdirects real money. It is also never the raw,
  // freely-editable landlords.mobile_money_number/phone — those can be
  // changed by anyone with landlords-UPDATE access with zero re-approval.
  // The only number ever used is verified_mobile_money_number: the exact
  // number Landlord Ops actually approved, frozen at verification time by
  // set_landlord_verification(). A missing/wrong number goes through
  // Landlord Ops re-verification, never by typing over it in this form.
  const defaultLandlordPhone =
    (landlordVerified && selectedRequest?.landlord?.verified_mobile_money_number) || '';
  const landlordPhone = defaultLandlordPhone.trim();

  const parsedAmount = Number((amountInput || '').toString().replace(/[^\d.]/g, ''));
  const effectiveAmount =
    Number.isFinite(parsedAmount) && parsedAmount > 0
      ? parsedAmount
      : Number(selectedRequest?.rent_amount ?? 0);
  const rentDue = Number(selectedRequest?.rent_amount ?? 0);
  const allocationRemaining = selectedRequest?.__allocationId ? rentDue : 0;
  // Spendable = backend-authoritative available float. An open allocation can
  // only lift the cap while the balance query is still loading; once we know
  // the real available figure we never inflate past it, because the backend
  // will reject anything above it anyway.
  const availablePayoutFloat = landlordPayoutFloatLoading
    ? Math.max(floatBalance, allocationRemaining)
    : floatBalance;
  const withinRent = effectiveAmount > 0 && effectiveAmount <= rentDue;
  const withinFloat = effectiveAmount > 0 && effectiveAmount <= availablePayoutFloat;
  const amountValid = withinRent && withinFloat;
  const phoneValid = /^(?:\+?256|0)?\d{9}$/.test(landlordPhone.replace(/\s+/g, ''));

  const handleSendOtp = async (source: 'auto' | 'manual' = 'manual') => {
    setSendOtpError(null);
    if (!phoneValid) {
      const msg = defaultLandlordPhone
        ? 'The Landlord-Ops-approved number looks invalid. Ask them to re-verify with a valid number.'
        : 'Landlord Ops has not approved a payout number for this landlord yet. Ask them to (re-)verify the landlord first.';
      toast.error(msg);
      setSendOtpError(msg);
      return;
    }
    if (!amountValid) {
      const msg =
        effectiveAmount <= 0
          ? 'Enter an amount greater than 0'
          : !withinRent
            ? `Amount cannot exceed rent due (${formatUGX(rentDue)})`
            : `Amount exceeds your Landlord Payout Float (${formatUGX(availablePayoutFloat)}). Reduce the amount or request Landlord Payout Float first.`;
      toast.error(msg);
      setSendOtpError(msg);
      return;
    }
    if (!user || !selectedRequest) {
      const msg = 'This payout is still loading. Close and reopen it, then try again.';
      toast.error(msg);
      setSendOtpError(msg);
      return;
    }

    // Hard per-landlord lock — reserve synchronously BEFORE any await so two
    // rapid taps (or auto-send racing a manual tap) cannot both reach the SMS.
    const landlordKey = String(selectedRequest.landlord_id);
    if (sentLandlordsRef.current.has(landlordKey)) {
      if (source === 'manual') {
        toast.info('OTP already sent to this landlord — ask them for the code or use Resend.');
      }
      return;
    }
    sentLandlordsRef.current.add(landlordKey);
    forceLockRender((n) => n + 1);
    setPreparingOtp(true);

    try {
      // Location must never hold the OTP button hostage. Some mobile WebViews
      // leave getCurrentPosition pending indefinitely when the permission sheet
      // is dismissed. Continue after 8 seconds; payout verification still keeps
      // the landlord/property coordinates already stored on the request.
      const loc = await Promise.race([
        geo.captureLocation().catch(() => null),
        new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 8000)),
      ]);
      const r = selectedRequest;
      const propLat = r.landlord?.latitude ?? null;
      const propLng = r.landlord?.longitude ?? null;

      const provider = (r.landlord?.mobile_money_number || '').toString().startsWith('07')
        ? 'MTN' : 'MTN';

      const challengeId = await landlordOtp.sendPayoutOtp({
        landlord_id: r.landlord_id,
        landlord_name: r.landlord?.name || 'Unknown',
        landlord_phone: landlordPhone,
        tenant_id: r.tenant_id,
        tenant_name: r.tenant?.full_name || undefined,
        tenant_phone: r.tenant?.phone || undefined,
        rent_request_id: r.id,
        amount: effectiveAmount,
        mobile_money_provider: provider,
        agent_latitude: loc?.latitude ?? null,
        agent_longitude: loc?.longitude ?? null,
        property_latitude: propLat,
        property_longitude: propLng,
        trigger_source: source,
      });

      if (challengeId) {
        bumpCooldown();
        toast.success(source === 'auto' ? 'OTP auto-sent to landlord\'s phone' : 'OTP sent to landlord\'s phone');
      } else {
        const reason =
          landlordOtp.getLastError() ||
          'Could not send the OTP. Check your connection and tap Send OTP again.';
        setSendOtpError(reason);
        toast.error(reason);
      }
    } catch (error) {
      const reason = error instanceof Error
        ? error.message
        : 'Could not prepare the OTP request. Tap Send OTP to try again.';
      setSendOtpError(reason);
      toast.error(reason);
    } finally {
      setPreparingOtp(false);
      // A successful send is represented by otpSent/challengeId. The ref is
      // only an in-flight mutex, so always release it after the attempt.
      sentLandlordsRef.current.delete(landlordKey);
      forceLockRender((n) => n + 1);
    }
  };

  const sendBlockedReason = !defaultLandlordPhone
    ? 'Landlord Ops has not approved a payout number for this landlord yet. Ask them to (re-)verify the landlord.'
    : !phoneValid
    ? 'The Landlord-Ops-approved number looks invalid. Ask them to re-verify with a valid number.'
    : effectiveAmount <= 0
      ? 'Enter an amount greater than 0.'
      : !withinRent
        ? `Amount cannot exceed rent due (${formatUGX(rentDue)}).`
        : !withinFloat
          ? `Amount exceeds your available Landlord Payout Float (${formatUGX(availablePayoutFloat)}).`
          : null;

  // Auto-send the landlord OTP the moment the agent taps a request to
  // withdraw float — the landlord receives the code immediately, without the
  // agent needing to tap "Send OTP" first. Fires once per selected request;
  // the manual button remains as a fallback if validation initially fails.
  useEffect(() => {
    if (step !== 'otp' || !selectedRequest) return;
    if (autoSendRef.current === selectedRequest.id) return;
    if (landlordOtp.otpSent || landlordOtp.otpLoading) return;
    if (landlordOtp.cooldownSeconds > 0) return;
    if (!phoneValid || !amountValid) return;
    if (sentLandlordsRef.current.has(String(selectedRequest.landlord_id))) return;
    autoSendRef.current = selectedRequest.id;
    void handleSendOtp('auto');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, selectedRequest, phoneValid, amountValid, landlordOtp.otpSent, landlordOtp.otpLoading, landlordOtp.cooldownSeconds]);

  const [activePayoutId, setActivePayoutId] = useState<string | null>(null);
  const [disburseError, setDisburseError] = useState<string | null>(null);
  const [isDisbursing, setIsDisbursing] = useState(false);
  const [isRetryingDisburse, setIsRetryingDisburse] = useState(false);
  // True when the wizard was opened on a payout that was ALREADY submitted in
  // an earlier session (its float is held against it). Nothing new is sent and
  // no OTP is asked for — so the success screen must say so instead of showing
  // a fresh "Payment Sent!" that looks like a brand-new, OTP-free payment.
  const [resumedExistingPayout, setResumedExistingPayout] = useState(false);
  // Amount of the earlier payout we are only tracking (never re-sent), so the
  // summary shows what was actually paid instead of the remaining allocation.
  const [resumedPayoutAmount, setResumedPayoutAmount] = useState<number | null>(null);

  // ─── Challenge row is the SINGLE SOURCE OF TRUTH ───────────────────────
  // Every decision the wizard makes (show OTP inputs / hide them / advance
  // to disburse / offer a retry / restart) is derived from this row rather
  // than from local booleans. Poll every 2–3s while the challenge is live so
  // remounts, refreshes, and slow networks all converge on the same state.
  const { data: challenge } = useQuery({
    queryKey: ['landlord-otp-challenge', landlordOtp.challengeId],
    queryFn: async () => {
      if (!landlordOtp.challengeId) return null;
      const { data } = await supabase
        .from('landlord_payout_otp_challenges')
        .select('id,status,verified_at,resulting_payout_id,otp_expires_at,attempts,max_attempts')
        .eq('id', landlordOtp.challengeId)
        .maybeSingle();
      return data as {
        id: string;
        status: 'pending' | 'verified' | 'expired' | 'failed';
        verified_at: string | null;
        resulting_payout_id: string | null;
        otp_expires_at: string;
        attempts: number;
        max_attempts: number;
      } | null;
    },
    enabled: !!landlordOtp.challengeId && open,
    refetchInterval: (q) => {
      const s = (q.state.data as any)?.status;
      if (!s || s === 'pending') return 3000;
      if (s === 'verified' && !(q.state.data as any)?.resulting_payout_id) return 2000;
      return false;
    },
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  const challengeVerified = challenge?.status === 'verified';
  const challengeTerminalFailed = challenge?.status === 'expired' || challenge?.status === 'failed';

  // Drive step transitions from the challenge row instead of the verify
  // response. If verification succeeded but the disburse leg failed or the
  // response never reached the client, the poller still finds status=verified
  // + resulting_payout_id and we advance forward automatically — the user
  // never sees the OTP UI again.
  useEffect(() => {
    if (!challenge) return;
    if (
      challenge.status === 'verified' &&
      challenge.resulting_payout_id &&
      step === 'otp'
    ) {
      setActivePayoutId(challenge.resulting_payout_id);
      setStep('disburse');
    }
  }, [challenge, step]);

  // Recover from partial success: OTP verified, disburse didn't produce a
  // payout. Re-trigger landlord-payout-disburse without re-verifying.
  const retryDisburse = async () => {
    if (!selectedRequest || !challenge || !challengeVerified) return;
    setIsRetryingDisburse(true);
    setDisburseError(null);
    try {
      const r = selectedRequest;
      const { data, error } = await supabase.functions.invoke('landlord-payout-disburse', {
        body: {
          rent_request_id: r.id,
          landlord_id: r.landlord_id,
          tenant_id: r.tenant_id,
          amount: effectiveAmount,
          landlord_phone: landlordPhone,
          landlord_name: r.landlord?.name,
          mobile_money_provider: 'MTN',
          otp_verified_at: challenge.verified_at ?? new Date().toISOString(),
          agent_latitude: null,
          agent_longitude: null,
          property_latitude: r.landlord?.latitude ?? null,
          property_longitude: r.landlord?.longitude ?? null,
        },
      });
      if (error) {
        // supabase-js hides our JSON body behind a generic
        // "Edge Function returned a non-2xx status code". Read the real reason.
        const ctx: any = (error as any)?.context;
        let body: any = null;
        try {
          body = ctx && typeof ctx.json === 'function'
            ? await (ctx.clone?.() ?? ctx).json()
            : null;
        } catch { /* non-JSON body */ }

        // Already paid / already queued: adopt the existing payout instead of
        // showing a failure — the money movement really did happen.
        const existingId = body?.existing_payout_id || body?.payout_id;
        if (existingId) {
          await supabase
            .from('landlord_payout_otp_challenges')
            .update({ resulting_payout_id: existingId })
            .eq('id', challenge.id);
          setActivePayoutId(existingId);
          qc.invalidateQueries({ queryKey: ['landlord-otp-challenge', challenge.id] });
          setStep('disburse');
          toast.success('This payout was already queued — opening it.');
          return;
        }

        throw new Error(body?.error || (await extractFromErrorObject(error, 'Retry failed')));
      }
      if ((data as any)?.error) throw new Error((data as any).error);
      if ((data as any)?.payout_id) {
        await supabase
          .from('landlord_payout_otp_challenges')
          .update({ resulting_payout_id: (data as any).payout_id })
          .eq('id', challenge.id);
      }
      qc.invalidateQueries({ queryKey: ['landlord-otp-challenge', challenge.id] });
      toast.success('Disbursement retried');
    } catch (e: any) {
      setDisburseError(e?.message || 'Retry failed');
      toast.error(e?.message || 'Retry failed');
    } finally {
      setIsRetryingDisburse(false);
    }
  };

  const handleVerifyOtp = async (code: string) => {
    // Never re-verify a challenge that is already verified — the DB row is
    // the source of truth and the endpoint is now idempotent, but stopping
    // here keeps us honest and prevents extra round-trips from InputOTP
    // re-firing during React remounts.
    if (challengeVerified) return;
    setOtpCode(code);
    if (code.length === 6) {
      setIsDisbursing(true);
      setDisburseError(null);
      try {
        const result = await landlordOtp.verifyPayoutOtp(code);
        if (result?.success) {
          if (!result.already_verified) toast.success('OTP verified — auto-disbursing now');
          if (result.payout_id) {
            setActivePayoutId(result.payout_id);
            setStep('disburse');
          }
          // If no payout_id, the challenge poller + retryDisburse take over.
          qc.invalidateQueries({ queryKey: ['landlord-otp-challenge', landlordOtp.challengeId] });
        }
      } catch (e: any) {
        const msg = await extractFromErrorObject(e, 'Verification failed');
        setDisburseError(msg);
        toast.error(msg);
      } finally {
        setIsDisbursing(false);
      }
    }
  };

  const handleResendOtp = async () => {
    setOtpCode('');
    const ok = await landlordOtp.resendPayoutOtp();
    if (ok) {
      bumpCooldown();
      toast.success('OTP resent to landlord\'s phone');
    }
  };

  const handleSelectRequest = (r: any) => {
    void refetchLandlordPayoutFloat();
    setSelectedRequest(r);
    setAmountInput(String(r?.rent_amount ?? ''));
    setStep('otp');
  };

  // Resubmit to CFO — return the ring-fenced (not-yet-paid) landlord float for
  // this allocation back to the CFO. The agent gives a reason; a CFO must
  // approve. On approval the money goes back to the CFO and the landlord
  // returns to Landlord Ops.
  const submitAllocationReturn = async () => {
    const allocId = allocation?.id || (selectedRequest as any)?.__allocationId;
    if (!allocId) {
      toast.error('This payout was not opened from a landlord allocation, so it cannot be resubmitted.');
      return;
    }
    if (returnReason.trim().length < 10) {
      toast.error('Add a reason (10+ characters)');
      return;
    }
    setSubmittingReturn(true);
    try {
      const { data, error } = await supabase.rpc('request_allocation_return' as any, {
        p_allocation_id: allocId,
        p_reason: returnReason.trim(),
      });
      if (error || (data as any)?.success === false) {
        throw new Error(error?.message || (data as any)?.error || 'Could not submit the request');
      }
      toast.success('Sent to CFO for approval', {
        description: 'Once approved, the money returns to the CFO and the landlord goes back to Landlord Ops.',
      });
      qc.invalidateQueries({ queryKey: ['landlord-float-allocations'] });
      qc.invalidateQueries({ queryKey: ['agent-landlord-payout-float-balance'] });
      qc.invalidateQueries({ queryKey: ['agent-landlord-float-row'] });
      qc.invalidateQueries({ queryKey: ['agent-float-payout-requests'] });
      handleClose();
    } catch (e: any) {
      toast.error(e?.message || 'Could not submit the request');
    } finally {
      setSubmittingReturn(false);
    }
  };

  // Verified landlords have a locked number — send the requested change back to
  // Landlord Ops via a verification request instead of editing it here.
  const submitPhoneChangeRequest = async () => {
    if (!user || !selectedRequest) return;
    const cleaned = newPhoneReq.replace(/\s+/g, '');
    if (!/^(?:\+?256|0)?\d{9}$/.test(cleaned)) {
      toast.error('Enter a valid Ugandan phone number');
      return;
    }
    if (phoneReqNote.trim().length < 5) {
      toast.error('Add a short reason for the change');
      return;
    }
    setSubmittingPhoneReq(true);
    try {
      const { error } = await supabase.from('landlord_verification_requests').insert({
        landlord_id: selectedRequest.landlord_id,
        landlord_name: selectedRequest.landlord?.name ?? null,
        landlord_phone: newPhoneReq.trim(),
        requested_by: user.id,
        note: `Phone change request from agent. New: ${newPhoneReq.trim()} · On file: ${defaultLandlordPhone || 'none'} · Reason: ${phoneReqNote.trim()}`,
        status: 'pending',
      } as any);
      if (error) throw error;
      toast.success('Sent to Landlord Ops', {
        description: 'They will review and update the verified number.',
      });
      setShowPhoneChangeReq(false);
      setNewPhoneReq('');
      setPhoneReqNote('');
    } catch (e: any) {
      toast.error(e?.message || 'Could not send the request');
    } finally {
      setSubmittingPhoneReq(false);
    }
  };

  // When the agent drilled in from the per-tenant allocations list, scope the
  // payout to THAT exact ring-fenced allocation. We build a synthetic request
  // from the allocation (capped at its remaining amount) and jump straight to
  // the OTP step — never showing the internal list, which previously surfaced
  // an unrelated assigned landlord/tenant (e.g. "boniface").
  useEffect(() => {
    if (!open || !allocation) return;
    void refetchLandlordPayoutFloat();
    // Guard against re-entry without using state in the dependency array —
    // previously `allocationPrepping`/`selectedRequest` were deps, so calling
    // setAllocationPrepping(true) re-ran the effect, fired the cleanup
    // (cancelled = true) for the in-flight run, and the async resolved into a
    // cancelled closure → setStep('otp') never ran → infinite spinner.
    if (allocationPrepRef.current === allocation.id) return;
    allocationPrepRef.current = allocation.id;
    (async () => {
      setAllocationPrepping(true);
      try {
        const [landlordRes, tenantRes] = await Promise.all([
          allocation.landlord_id
            ? supabase
                .from('landlords')
                .select('id, name, phone, mobile_money_number, verified_mobile_money_number, latitude, longitude, verification_status, verified')
                .eq('id', allocation.landlord_id)
                .maybeSingle()
            : Promise.resolve({ data: null } as any),
          allocation.tenant_id
            ? supabase
                .from('profiles')
                .select('id, full_name, phone')
                .eq('id', allocation.tenant_id)
                .maybeSingle()
            : Promise.resolve({ data: null } as any),
        ]);

        // No fallback to allocation.landlord_phone here — it is descriptive
        // display data from the allocations view, not an Ops-approved number.
        // If the landlord row itself can't be found, leave the approved
        // number null so the payout blocks instead of paying an unapproved
        // number.
        const landlord = landlordRes?.data || {
          id: allocation.landlord_id,
          name: allocation.landlord_name,
          phone: allocation.landlord_phone,
          mobile_money_number: allocation.landlord_phone,
          verified_mobile_money_number: null,
          latitude: null,
          longitude: null,
        };
        const tenant = tenantRes?.data || null;

        const synthetic = {
          id: allocation.rent_request_id,
          rent_amount: allocation.remaining_amount,
          tenant_id: allocation.tenant_id,
          landlord_id: allocation.landlord_id,
          landlord,
          tenant,
          created_at: allocation.created_at,
          __allocationId: allocation.id,
        };
        setSelectedRequest(synthetic);
        setAmountInput(String(allocation.remaining_amount ?? ''));
        // The agent already submitted a payout for this allocation and it is
        // still moving through the merchant queue. Show them where it is
        // instead of an OTP form they cannot complete — their float is held
        // against this payout, so "Available to pay" is legitimately 0 and the
        // form would just look broken.
        if (allocation.inflight_payout) {
          setActivePayoutId(allocation.inflight_payout.id);
          setResumedExistingPayout(true);
          setResumedPayoutAmount(Number(allocation.inflight_payout.amount) || null);
          setStep('disburse');
        } else {
          setStep('otp');
        }
      } finally {
        setAllocationPrepping(false);
      }
    })();
  }, [open, allocation]);

  const submitPayout = useMutation({
    mutationFn: async () => {
      if (!user || !selectedRequest) throw new Error('Missing data');
      if (!provider) throw new Error('Select a payment mode');
      if (!tid.trim()) throw new Error('Enter the Transaction ID (TID) from your MoMo payment');
      if (!landlordOtp.otpVerified) throw new Error('Landlord OTP verification is required');

      const req = selectedRequest;
      if (effectiveAmount <= 0) throw new Error('Enter an amount greater than 0');
      if (effectiveAmount > Number(req.rent_amount)) throw new Error('Amount exceeds rent due');
      if (effectiveAmount > floatBalance) throw new Error('Insufficient Landlord Payout Float');
      if (!phoneValid) throw new Error('Enter a valid landlord phone number');

      // Capture GPS — MANDATORY
      const loc = await geo.captureLocation();
      if (!loc) throw new Error('GPS location is required. Please enable location services and try again.');

      // Calculate distance to property if property coords exist
      let gpsDistanceMeters: number | null = null;
      let gpsMatch = false;
      const propLat = req.landlord?.latitude;
      const propLng = req.landlord?.longitude;

      if (propLat && propLng) {
        const R = 6371000;
        const dLat = (propLat - loc.latitude) * Math.PI / 180;
        const dLon = (propLng - loc.longitude) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
          Math.cos(loc.latitude * Math.PI / 180) * Math.cos(propLat * Math.PI / 180) *
          Math.sin(dLon / 2) ** 2;
        gpsDistanceMeters = Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
        gpsMatch = gpsDistanceMeters <= 500;
      }

      // Deduct from Landlord Payout Float only. Wallet/rent-collection float is untouched.
      const { data: floatData } = await supabase
        .from('agent_landlord_float')
        .select('balance, total_paid_out')
        .eq('agent_id', user.id)
        .single();

      if (!floatData || floatData.balance < effectiveAmount) {
        throw new Error('Insufficient Landlord Payout Float');
      }

      const { error: floatErr } = await supabase
        .from('agent_landlord_float')
        .update({
          balance: floatData.balance - effectiveAmount,
          total_paid_out: (floatData.total_paid_out || 0) + effectiveAmount,
          updated_at: new Date().toISOString(),
        } as any)
        .eq('agent_id', user.id);

      if (floatErr) throw new Error('Failed to deduct from Landlord Payout Float');

      // Upload receipt photos
      const photoUrls: string[] = [];
      for (const file of receiptFiles) {
        const ext = file.name.split('.').pop() || 'jpg';
        const path = `landlord-float-payouts/${req.id}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
        const { error: upErr } = await supabase.storage.from('receipts').upload(path, file);
        if (!upErr) {
          const { data: urlData } = supabase.storage.from('receipts').getPublicUrl(path);
          photoUrls.push(urlData.publicUrl);
        }
      }

      // Create withdrawal record with OTP verification flag
      const { error } = await supabase.from('agent_float_withdrawals').insert({
        agent_id: user.id,
        rent_request_id: req.id,
        landlord_id: req.landlord_id,
        tenant_id: req.tenant_id,
        amount: effectiveAmount,
        landlord_name: req.landlord?.name || 'Unknown',
        landlord_phone: landlordPhone,
        mobile_money_provider: provider,
        transaction_id: tid.trim(),
        notes: notes || null,
        receipt_photo_urls: photoUrls.length > 0 ? photoUrls : null,
        agent_latitude: loc.latitude,
        agent_longitude: loc.longitude,
        agent_location_accuracy: loc.accuracy,
        property_latitude: propLat ?? null,
        property_longitude: propLng ?? null,
        gps_distance_meters: gpsDistanceMeters,
        gps_match: gpsMatch,
        landlord_otp_verified: true,
        landlord_otp_verified_at: new Date().toISOString(),
        status: 'pending_agent_ops',
      } as any);

      if (error) {
        // Rollback float
        await supabase
          .from('agent_landlord_float')
          .update({
            balance: floatData.balance,
            total_paid_out: floatData.total_paid_out,
            updated_at: new Date().toISOString(),
          } as any)
          .eq('agent_id', user.id);
        throw error;
      }

      // Send confirmation SMS to landlord
      try {
        const tenantName = req.tenant?.full_name || 'your tenant';
        await supabase.functions.invoke('sms-otp', {
          body: {
            action: 'send_custom',
            phone: landlordPhone,
              message: `Welile has paid UGX ${effectiveAmount.toLocaleString()} rent for ${tenantName} to your number. If you did not receive this, call 0800-000-000.`,
          },
        });
      } catch {
        // Non-critical — don't fail the payout
      }
    },
    onSuccess: () => {
      setStep('done');
      qc.invalidateQueries({ queryKey: ['agent-landlord-payout-float-balance'] });
      qc.invalidateQueries({ queryKey: ['agent-landlord-float-row'] });
      qc.invalidateQueries({ queryKey: ['agent-float-payout-requests'] });
      qc.invalidateQueries({ queryKey: ['agent-float-pending-count'] });
      qc.invalidateQueries({ queryKey: ['landlord-float-allocations'] });
      toast.success('Landlord payment submitted for verification!');
    },
    onError: (e: any) => toast.error(e.message || 'Failed to submit'),
  });

  const req = selectedRequest;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Landmark className="h-5 w-5 text-chart-4" />
            Pay Landlord
          </DialogTitle>
          <div className="space-y-1 mt-1">
            <Badge variant="outline" className="text-xs font-mono w-fit">
              Available to pay: {landlordPayoutFloatLoading ? 'Loading…' : formatUGX(availablePayoutFloat)}
            </Badge>
            {/*
              When float is held, name the payments holding it. "UGX 0 available"
              on its own reads as the app losing the agent's money; the whole
              point is that they already sent these and are waiting on a merchant.
            */}
            {!landlordPayoutFloatLoading && reservedFloat > 0 && (
              <div className="space-y-1">
                <p className="text-[11px] text-muted-foreground">
                  Total float {formatUGX(grossFloatBalance)} · {formatUGX(reservedFloat)} is held for
                  payments you have already sent, so it cannot be spent twice.
                </p>
                {floatHolds.length > 0 && (
                  <ul className="text-[11px] text-muted-foreground space-y-0.5">
                    {floatHolds.map((h) => (
                      <li key={h.payout_id} className="flex items-center justify-between gap-2">
                        <span className="truncate">
                          {h.landlord_name ?? 'Landlord'} · {formatUGX(Number(h.amount))}
                        </span>
                        <span className="shrink-0">
                          {h.hold_state === 'holding_settled_needs_review'
                            ? 'paid — under review'
                            : `sent ${waitingFor(h.payout_created_at)} ago`}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </DialogHeader>

        <AnimatePresence mode="wait">
          {step === 'select' && allocation && (
            <motion.div key="prep" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center justify-center py-10 gap-2">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              <p className="text-xs text-muted-foreground">Loading landlord payout…</p>
            </motion.div>
          )}
          {step === 'select' && !allocation && (
            <motion.div key="select" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-3">
              <p className="text-sm text-muted-foreground">Select a rent request to pay the landlord:</p>
              {isLoading ? (
                <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
              ) : assignedRequests.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  <Home className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  No pending landlord payouts assigned to you.
                </div>
              ) : (
                assignedRequests.map((r: any) => {
                  const canAfford = !landlordPayoutFloatLoading && r.rent_amount <= floatBalance;
                  return (
                    <Card
                      key={r.id}
                      className={`cursor-pointer transition-colors ${canAfford ? 'hover:border-chart-4/50' : 'opacity-60 cursor-not-allowed'}`}
                      onClick={() => { if (canAfford) handleSelectRequest(r); }}
                    >
                      <CardContent className="p-3 space-y-1">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <User2 className="h-4 w-4 text-muted-foreground" />
                            <span className="font-medium text-sm">{r.landlord?.name || 'Unknown'}</span>
                          </div>
                          <Badge variant={canAfford ? 'secondary' : 'destructive'} className="text-xs">
                            {formatUGX(r.rent_amount)}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-4 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1"><Phone className="h-3 w-3" />{r.landlord?.verified_mobile_money_number || 'Not Ops-approved'}</span>
                          <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{format(new Date(r.created_at), 'dd MMM')}</span>
                        </div>
                        <div className="text-xs text-muted-foreground">Tenant: {r.tenant?.full_name || 'Unknown'}</div>
                        {!canAfford && <p className="text-[10px] text-destructive">Insufficient Landlord Payout Float</p>}
                        {canAfford && <div className="flex items-center justify-end"><ArrowRight className="h-4 w-4 text-chart-4" /></div>}
                      </CardContent>
                    </Card>
                  );
                })
              )}
            </motion.div>
          )}

          {/* OTP Step — Verify landlord phone before payment */}
          {step === 'otp' && req && (
            <motion.div key="otp" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
              {/* Payment Summary Header */}
              <div className="p-4 rounded-xl bg-card border shadow-sm space-y-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="font-bold text-base text-foreground">
                      Pay {req.landlord?.name || 'Landlord'}
                    </h3>
                    <p className="text-xs text-muted-foreground font-mono mt-0.5">
                      {maskLandlordPhone(landlordPhone)} · MTN Mobile Money
                    </p>
                  </div>
                  <Badge variant="outline" className="text-[10px] font-mono shrink-0">
                    UGX
                  </Badge>
                </div>
                <div className="flex items-center justify-between pt-2 border-t text-xs">
                  <span className="text-muted-foreground font-medium">Amount to pay</span>
                  <span className="font-bold text-base text-[#9234EA]">{formatUGX(effectiveAmount)}</span>
                </div>
              </div>

              {/* Edit Amount / Phone accordion if needed */}
              <div className="space-y-3 p-3 rounded-xl border bg-card/60 text-xs">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="payout-amount" className="text-xs">
                      Amount to pay (UGX)
                    </Label>
                    <span className="text-[11px] text-muted-foreground">
                      Rent due: {formatUGX(Number(req?.rent_amount ?? 0))}
                    </span>
                  </div>
                  <Input
                    id="payout-amount"
                    inputMode="numeric"
                    value={amountInput}
                    onChange={(e) => setAmountInput(e.target.value.replace(/[^\d]/g, ''))}
                    placeholder={String(req?.rent_amount ?? '')}
                    className="h-9 font-mono"
                  />
                  {effectiveAmount > 0 && !withinRent && (
                    <p className="text-[11px] text-destructive">
                      Amount cannot exceed the rent due.
                    </p>
                  )}
                  {effectiveAmount > 0 && withinRent && !withinFloat && (
                    <p className="text-[11px] text-destructive">
                      Amount exceeds your Landlord Payout Float ({formatUGX(availablePayoutFloat)}). Reduce the amount or request Landlord Payout Float first.
                    </p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="payout-phone" className="text-xs">
                    Landlord MoMo number
                  </Label>
                  {/*
                    Never agent-editable — a boss once hit a blank prefill here
                    and typed a number in, which would have misdirected a real
                    payout. This is never the raw, freely-editable
                    landlords.mobile_money_number/phone either — only the
                    number Landlord Ops actually approved at verification time
                    (verified_mobile_money_number) is ever shown or paid to.
                  */}
                  <Input
                    id="payout-phone"
                    inputMode="tel"
                    readOnly
                    value={defaultLandlordPhone}
                    placeholder="Not yet approved by Landlord Ops"
                    className="h-9 font-mono bg-muted/60 cursor-not-allowed text-muted-foreground"
                  />
                  <div className="space-y-1.5">
                    {defaultLandlordPhone ? (
                      <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                        <ShieldCheck className="h-3 w-3 text-success shrink-0" />
                        Approved by Landlord Ops — number locked.
                      </p>
                    ) : (
                      <p className="text-[11px] text-destructive flex items-center gap-1">
                        <AlertTriangle className="h-3 w-3 shrink-0" />
                        Landlord Ops has not approved a payout number for this landlord yet — you cannot pay until they (re-)verify.
                      </p>
                    )}
                    {!showPhoneChangeReq ? (
                      <button
                        type="button"
                        onClick={() => setShowPhoneChangeReq(true)}
                        className="text-[11px] text-chart-4 font-medium inline-flex items-center gap-1 hover:underline"
                      >
                        <RefreshCw className="h-3 w-3" />
                        {defaultLandlordPhone ? 'Request change from Landlord Ops' : 'Ask Landlord Ops to add a number'}
                      </button>
                    ) : (
                      <div className="space-y-2 rounded-lg border p-2 bg-muted/30">
                        <Input
                          value={newPhoneReq}
                          onChange={(e) => setNewPhoneReq(e.target.value)}
                          placeholder="New number e.g. 07XXXXXXXX"
                          inputMode="tel"
                          className="h-8 font-mono text-xs"
                        />
                        <Textarea
                          value={phoneReqNote}
                          onChange={(e) => setPhoneReqNote(e.target.value)}
                          placeholder="Reason for the change (required)"
                          rows={2}
                          className="text-xs"
                        />
                        <div className="flex gap-2">
                          <Button
                            type="button"
                            size="sm"
                            className="flex-1 h-7 text-xs"
                            disabled={
                              submittingPhoneReq ||
                              !/^(?:\+?256|0)?\d{9}$/.test(newPhoneReq.replace(/\s+/g, '')) ||
                              phoneReqNote.trim().length < 5
                            }
                            onClick={submitPhoneChangeRequest}
                          >
                            {submittingPhoneReq ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Send to Landlord Ops'}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs"
                            onClick={() => setShowPhoneChangeReq(false)}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {challengeVerified ? (
                <div className="space-y-3 p-4 rounded-xl border-2 border-success/30 bg-success/5 text-center">
                  <CheckCircle2 className="h-8 w-8 mx-auto text-success" />
                  <p className="text-sm font-semibold text-success">Verification Complete</p>
                  <p className="text-xs text-muted-foreground">
                    {challenge?.resulting_payout_id
                      ? 'Opening disbursement…'
                      : 'Final payout is being processed…'}
                  </p>
                  {!challenge?.resulting_payout_id && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="gap-2"
                      disabled={isRetryingDisburse}
                      onClick={retryDisburse}
                    >
                      {isRetryingDisburse ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                      )}
                      Retry Payout
                    </Button>
                  )}
                  {disburseError && (
                    <p className="text-[11px] text-destructive">{disburseError}</p>
                  )}
                </div>
              ) : challengeTerminalFailed ? (
                <div className="space-y-3 p-4 rounded-xl border-2 border-destructive/30 bg-destructive/5 text-center">
                  <AlertTriangle className="h-6 w-6 mx-auto text-destructive" />
                  <p className="text-sm font-semibold text-destructive">
                    {challenge?.status === 'expired' ? 'OTP Expired' : 'Verification Failed'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Start over and request a new code.
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      landlordOtp.resetOtp();
                      setOtpCode('');
                      sentLandlordsRef.current.delete(String(selectedRequest?.landlord_id));
                      autoSendRef.current = null;
                    }}
                    className="gap-2"
                  >
                    <RotateCcw className="h-3.5 w-3.5" /> Restart
                  </Button>
                </div>
              ) : !landlordOtp.otpSent && (preparingOtp || landlordOtp.otpLoading) ? (
                /* Screen 2: OTP Auto-Sending State */
                <div className="space-y-3 p-6 rounded-2xl border-2 border-[#9234EA]/20 bg-[#9234EA]/5 text-center">
                  <div className="relative w-12 h-12 mx-auto">
                    <div className="absolute inset-0 rounded-full border-4 border-[#9234EA]/20" />
                    <div className="absolute inset-0 rounded-full border-4 border-[#9234EA] border-t-transparent animate-spin" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-bold text-foreground">
                      OTP sending to {maskLandlordPhone(landlordPhone)}
                    </p>
                    <p className="text-xs text-muted-foreground max-w-xs mx-auto">
                      Ask the landlord to read the 6-digit code from their SMS.
                    </p>
                  </div>
                  {resendCooldown > 0 && (
                    <p className="text-xs font-mono text-muted-foreground">
                      resend in {Math.floor(resendCooldown / 60)}:{(resendCooldown % 60).toString().padStart(2, '0')}
                    </p>
                  )}
                </div>
              ) : !landlordOtp.otpSent ? (
                <div className="space-y-2">
                  <Button
                    type="button"
                    onClick={() => handleSendOtp('manual')}
                    disabled={
                      preparingOtp ||
                      landlordOtp.otpLoading ||
                      (!!selectedRequest && sentLandlordsRef.current.has(String(selectedRequest.landlord_id)))
                    }
                    className="w-full gap-2 h-12 rounded-xl"
                  >
                    {preparingOtp || landlordOtp.otpLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Phone className="h-4 w-4" />
                    )}
                    {preparingOtp
                      ? 'Preparing OTP…'
                      : landlordOtp.otpLoading
                        ? 'Sending OTP…'
                      : `Send OTP to Landlord (${maskLandlordPhone(landlordPhone) || '—'})`}
                  </Button>
                  {(sendOtpError || sendBlockedReason) && (
                    <p className="text-[11px] text-destructive text-center">
                      {sendOtpError || sendBlockedReason}
                    </p>
                  )}
                  {landlordOtp.cooldownSeconds > 0 && (
                    <p className="text-[11px] text-muted-foreground text-center">
                      Next code can be requested in {landlordOtp.cooldownSeconds}s.
                    </p>
                  )}
                </div>
              ) : (
                /* Screen 3: Landlord reads the OTP */
                <div className="space-y-4 p-4 rounded-2xl border-2 border-[#9234EA]/30 bg-[#9234EA]/5">
                  <div className="text-center space-y-1">
                    <h4 className="text-sm font-bold text-foreground">
                      Verify Landlord OTP
                    </h4>
                    <p className="text-xs text-muted-foreground">
                      Ask the landlord for the 6-digit code we SMS-ed them ({maskLandlordPhone(landlordPhone)})
                    </p>
                  </div>
                  <div className="flex justify-center py-1">
                    <InputOTP
                      maxLength={6}
                      value={otpCode}
                      onChange={handleVerifyOtp}
                      disabled={landlordOtp.otpLoading || isDisbursing || challengeVerified}
                    >
                      <InputOTPGroup className="gap-1.5">
                        <InputOTPSlot index={0} className="w-10 h-11 text-base font-bold rounded-lg border-2 border-border bg-background" />
                        <InputOTPSlot index={1} className="w-10 h-11 text-base font-bold rounded-lg border-2 border-border bg-background" />
                        <InputOTPSlot index={2} className="w-10 h-11 text-base font-bold rounded-lg border-2 border-border bg-background" />
                        <InputOTPSlot index={3} className="w-10 h-11 text-base font-bold rounded-lg border-2 border-border bg-background" />
                        <InputOTPSlot index={4} className="w-10 h-11 text-base font-bold rounded-lg border-2 border-border bg-background" />
                        <InputOTPSlot index={5} className="w-10 h-11 text-base font-bold rounded-lg border-2 border-border bg-background" />
                      </InputOTPGroup>
                    </InputOTP>
                  </div>
                  {(landlordOtp.otpLoading || isDisbursing) && (
                    <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {isDisbursing ? 'Starting disbursement…' : 'Verifying…'}
                    </div>
                  )}
                  {landlordOtp.otpError && (
                    <p className="text-[11px] text-destructive text-center">{landlordOtp.otpError}</p>
                  )}
                  <div className="flex items-center justify-center">
                    {resendCooldown > 0 ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-muted/80 px-3 py-1 text-[11px] font-medium text-muted-foreground">
                        <Timer className="h-3 w-3" />
                        Didn't get the code? You can request a new one in {Math.floor(resendCooldown / 60)}:{(resendCooldown % 60).toString().padStart(2, '0')}
                      </span>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">
                        Didn't get the code? You can request a new one now.
                      </span>
                    )}
                  </div>
                  <div className="flex items-center justify-between text-[11px] pt-1">
                    <button
                      type="button"
                      onClick={handleResendOtp}
                      disabled={resendCooldown > 0 || landlordOtp.otpLoading}
                      className="text-[#9234EA] font-semibold disabled:text-muted-foreground inline-flex items-center gap-1 hover:underline"
                    >
                      <RefreshCw className="h-3 w-3" />
                      {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend OTP'}
                    </button>
                    <button
                      type="button"
                      onClick={() => { landlordOtp.resetOtp(); setOtpCode(''); }}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      Wrong number? Edit
                    </button>
                  </div>
                </div>
              )}
              {disburseError && (
                <p className="text-xs text-destructive text-center">{disburseError}</p>
              )}

              {(allocation || (selectedRequest as any)?.__allocationId) && showReturnPanel && (
                <div className="space-y-2 rounded-xl border-2 border-destructive/30 bg-destructive/5 p-3">
                  <p className="text-xs font-semibold text-destructive">
                    Send this landlord's allocated money back to the CFO
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    The CFO must approve. Once approved, the money returns to the CFO and the
                    landlord goes back to Landlord Ops.
                  </p>
                  <Textarea
                    value={returnReason}
                    onChange={(e) => setReturnReason(e.target.value)}
                    placeholder="Reason for sending it back (required, 10+ characters)"
                    rows={3}
                    maxLength={500}
                    className="text-xs"
                  />
                  <p className="text-[10px] text-muted-foreground text-right">
                    {returnReason.trim().length}/10
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="flex-1"
                      disabled={submittingReturn}
                      onClick={() => { setShowReturnPanel(false); setReturnReason(''); }}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      className="flex-1 gap-1.5"
                      disabled={submittingReturn || returnReason.trim().length < 10}
                      onClick={submitAllocationReturn}
                    >
                      {submittingReturn ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                      Send to CFO
                    </Button>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="flex-1"
                  onClick={() => { if (allocation) { handleClose(); } else { resetForm(); } }}
                >
                  {allocation ? '← Close' : '← Back to list'}
                </Button>
                {(allocation || (selectedRequest as any)?.__allocationId) && !showReturnPanel && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10"
                    onClick={() => setShowReturnPanel(true)}
                  >
                    <RotateCcw className="h-3.5 w-3.5" /> Resubmit to CFO
                  </Button>
                )}
              </div>
            </motion.div>
          )}

          {step === 'disburse' && req && activePayoutId && (
            <motion.div key="disburse" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              {resumedExistingPayout && (
                <div className="mb-3 rounded-xl border border-chart-4/30 bg-chart-4/5 p-3 text-center space-y-1">
                  <p className="text-xs font-semibold text-chart-4">
                    This payment was already sent earlier
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    The landlord's OTP was already verified when you submitted it, so no new code is
                    needed. Nothing new is being sent now — this screen only tracks that payment.
                  </p>
                </div>
              )}
              <LandlordPayoutProgress
                payoutId={activePayoutId}
                landlordName={req.landlord?.name || 'Landlord'}
                onDone={(status) => {
                  if (['completed', 'pending_finops_disbursement', 'awaiting_agent_receipt'].includes(status)) {
                    qc.invalidateQueries({ queryKey: ['agent-landlord-payout-float-balance'] });
                    qc.invalidateQueries({ queryKey: ['agent-landlord-float-row'] });
                    qc.invalidateQueries({ queryKey: ['agent-float-payout-requests'] });
                    // Landlord is now paid out → drop it from the ready-to-pay allocations list.
                    qc.invalidateQueries({ queryKey: ['landlord-float-allocations'] });
                    setTimeout(() => setStep('done'), 1500);
                  }
                }}
              />
              {disburseError && (
                <div className="mt-3 flex items-center gap-2 text-xs text-destructive">
                  <AlertTriangle className="h-3.5 w-3.5" /> {disburseError}
                </div>
              )}
            </motion.div>
          )}

          {isDisbursing && step === 'otp' && (
            <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Starting auto-disbursement…
            </div>
          )}

          {step === 'done' && (
            <motion.div key="done" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="py-8 text-center space-y-3">
              <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 300, damping: 20 }}
                className="w-16 h-16 mx-auto rounded-full bg-success/20 flex items-center justify-center">
                <CheckCircle2 className="h-8 w-8 text-success" />
              </motion.div>
              <h3 className="text-lg font-semibold">
                {resumedExistingPayout ? 'Already Paid' : 'Payment Sent!'}
              </h3>
              <p className="text-muted-foreground text-sm">
                {resumedExistingPayout
                  ? `${formatUGX(resumedPayoutAmount ?? effectiveAmount)} was already sent to ${req?.landlord?.name || 'the landlord'} via Mobile Money in an earlier session — the landlord's OTP was verified then. No new payment was made now.`
                  : `${req ? formatUGX(effectiveAmount) : ''} delivered to ${req?.landlord?.name || 'the landlord'} via Mobile Money.`}
              </p>
              <Button
                onClick={() => {
                  // Capture before handleClose() resets selectedRequest/allocation-derived state.
                  const cameFromList = !!allocation;
                  handleClose();
                  if (cameFromList) onDone?.();
                }}
              >
                {allocation ? 'Pay Another Landlord' : 'Done'}
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}
