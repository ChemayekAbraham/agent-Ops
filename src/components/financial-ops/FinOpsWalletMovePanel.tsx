import { useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  ArrowRightLeft, Search, Loader2, Wallet, Building2, Undo2, Users, AlertTriangle, CheckCircle2,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { useIsFetching } from '@tanstack/react-query';

type Bucket = 'withdrawable' | 'float';
type Mode = 'user_to_user' | 'error_correction' | 'same_user';
type MoveStep = 'idle' | 'posting' | 'refreshing' | 'done';
type SameUserDir = 'float_to_withdrawable' | 'withdrawable_to_float';

/** Structured reason codes — free text alone produced unusable audit trails. */
const REASON_CODES: { value: string; label: string }[] = [
  { value: 'duplicate_credit', label: 'Duplicate credit reversed' },
  { value: 'wrong_bucket', label: 'Credited to the wrong wallet bucket' },
  { value: 'incorrect_float_allocation', label: 'Incorrect float allocation' },
  { value: 'failed_funding_reversal', label: 'Reversal of failed funding' },
  { value: 'wrong_recipient', label: 'Wrong recipient' },
  { value: 'wrong_user', label: 'Credited to the wrong user' },
  { value: 'fraud_hold', label: 'Funds held pending fraud review' },
  { value: 'fraud_investigation', label: 'Fraud investigation' },
  { value: 'test_transaction', label: 'Test transaction' },
  { value: 'treasury_adjustment', label: 'Treasury adjustment' },
  { value: 'manual_reconciliation', label: 'Manual reconciliation' },
  { value: 'reconciliation', label: 'Reconciliation adjustment' },
  { value: 'other', label: 'Other (requires detailed explanation)' },
];

/** Wallet ledger categories that represent income the user has already EARNED. */
const COMMISSION_CATEGORIES = [
  'agent_commission',
  'agent_commission_earned',
  'proxy_investment_commission',
  'agent_investment_commission',
  'partner_commission',
];

/** Matches every wallet/balance/ledger-backed panel query. */
const isWalletQuery = (key: readonly unknown[]) =>
  /wallet|balance|ledger|finops|withdraw|float|recon|drift|overview/.test(
    key.join(' ').toLowerCase(),
  );

interface MoveResult {
  message: string;
  amount: number;
  mode: Mode;
  reference_id: string;
  source: { name: string; withdrawable_after: number; float_after: number };
  dest: { name: string; withdrawable_after?: number; float_after?: number };
}

interface UserHit {
  id: string;
  full_name: string | null;
  phone: string | null;
  withdrawable_balance: number;
  float_balance: number;
  balance: number;
}

const fmt = (n: number) => `UGX ${Math.round(n).toLocaleString()}`;

/**
 * FinOpsWalletMovePanel — Financial-Ops power tool to move money from ANY user's
 * wallet to ANY other user's wallet, or back to the platform ("money we have")
 * as an error correction. All movement happens server-side via the
 * `finops-wallet-move` edge function (balanced double-entry ledger). Never
 * overdraws — the operator can only move up to the chosen bucket's balance.
 */
export function FinOpsWalletMovePanel() {
  const [mode, setMode] = useState<Mode>('user_to_user');
  const queryClient = useQueryClient();

  const [term, setTerm] = useState('');
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<UserHit[]>([]);

  const [source, setSource] = useState<UserHit | null>(null);
  const [sourceBucket, setSourceBucket] = useState<Bucket>('withdrawable');
  const [dest, setDest] = useState<UserHit | null>(null);
  const [destBucket, setDestBucket] = useState<Bucket>('withdrawable');
  const [picking, setPicking] = useState<'source' | 'dest'>('source');
  const [sameUserDir, setSameUserDir] = useState<SameUserDir>('float_to_withdrawable');

  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [reasonCode, setReasonCode] = useState('');
  // ── Error-correction governance ─────────────────────────────────────────
  const [justification, setJustification] = useState('');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [relatedTxnId, setRelatedTxnId] = useState('');
  const [ackEarnedIncome, setAckEarnedIncome] = useState(false);
  const [commissionComponent, setCommissionComponent] = useState<number | null>(null);
  const [confirmStage, setConfirmStage] = useState<'preview' | 'final'>('preview');
  const [config, setConfig] = useState<{
    high_value_threshold: number;
    cfo_approval_threshold: number;
    dual_approval_threshold: number;
    require_commission_ack: boolean;
  } | null>(null);
  const [pendingApproval, setPendingApproval] = useState<{
    approval_id: string | null; required_approvals: number; message: string;
  } | null>(null);
  // Full-history sweep: the operator must confirm twice when the amount wipes
  // out everything the user has ever deposited.
  const [confirmFullHistory, setConfirmFullHistory] = useState(false);
  const [lifetimeDeposits, setLifetimeDeposits] = useState<number | null>(null);
  // Same-user Withdrawable → Float only: operator opt-in to fill an existing
  // Float overdraft. Without this, the edge function refuses moves where the
  // amount only fills (or partly fills) a negative Float shortfall.
  const [acknowledgeOverdraft, setAcknowledgeOverdraft] = useState(false);
  // TRUE float position from the raw wallet-scope ledger legs (can be negative).
  // `wallets.float_balance` is a projection that never goes below 0, so it can
  // never reveal an existing overdraft — this is the figure the backend
  // overdraft guard actually uses.
  const [floatNet, setFloatNet] = useState<number | null>(null);
  const [floatNetLoading, setFloatNetLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<MoveResult | null>(null);
  const [before, setBefore] = useState<{
    source: { withdrawable: number; float: number };
    dest?: { withdrawable: number; float: number };
  } | null>(null);
  const [step, setStep] = useState<MoveStep>('idle');

  // Live count of in-flight wallet/balance refetches kicked off by the move.
  const refetching = useIsFetching({ predicate: (q) => isWalletQuery(q.queryKey) });
  const refreshStartedRef = useRef(false);

  // Governance thresholds (configurable by CFO/CTO).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('error_correction_config')
        .select('high_value_threshold, cfo_approval_threshold, dual_approval_threshold, require_commission_ack')
        .maybeSingle();
      if (cancelled || !data) return;
      setConfig({
        high_value_threshold: Number(data.high_value_threshold ?? 100000),
        cfo_approval_threshold: Number(data.cfo_approval_threshold ?? 500000),
        dual_approval_threshold: Number(data.dual_approval_threshold ?? 2000000),
        require_commission_ack: data.require_commission_ack !== false,
      });
    })();
    return () => { cancelled = true; };
  }, []);

  // Earned commission sitting in the selected user's Withdrawable bucket —
  // drives the earned-income protection warning.
  useEffect(() => {
    if (mode !== 'error_correction' || !source || sourceBucket !== 'withdrawable') {
      setCommissionComponent(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('general_ledger')
        .select('amount, direction')
        .eq('user_id', source.id)
        .eq('ledger_scope', 'wallet')
        .eq('wallet_bucket', 'withdrawable')
        .in('category', COMMISSION_CATEGORIES)
        .limit(5000);
      if (cancelled) return;
      let net = 0;
      for (const l of (data ?? []) as Array<{ amount: number; direction: string }>) {
        const sign = l.direction === 'cash_in' || l.direction === 'credit' ? 1 : -1;
        net += sign * Number(l.amount ?? 0);
      }
      setCommissionComponent(Math.max(0, Math.min(net, source.withdrawable_balance)));
    })();
    return () => { cancelled = true; };
  }, [mode, source, sourceBucket]);

  // Lifetime approved deposits for the selected source user — drives the
  // full-history sweep guard and gives the operator context before recovering.
  useEffect(() => {
    if (!source) {
      setLifetimeDeposits(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('deposit_requests')
        .select('amount')
        .eq('user_id', source.id)
        .eq('status', 'approved');
      if (cancelled) return;
      setLifetimeDeposits(
        (data ?? []).reduce((s, d) => s + Number((d as { amount: number | null }).amount ?? 0), 0),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [source]);

  // Once the refetch wave drains, mark the refresh complete. A fallback timer
  // guarantees completion even if no wallet panels are currently mounted
  // (invalidate only refetches active queries).
  useEffect(() => {
    if (step !== 'refreshing') return;
    if (refetching > 0) {
      refreshStartedRef.current = true;
      return;
    }
    if (refreshStartedRef.current) {
      setStep('done');
      return;
    }
    const fallback = setTimeout(() => setStep('done'), 1500);
    return () => clearTimeout(fallback);
  }, [step, refetching]);

  const search = async () => {
    const q = term.trim();
    if (q.length < 2) {
      toast.error('Enter at least 2 characters to search.');
      return;
    }
    setSearching(true);
    try {
      // Indexed server-side search — plain ilike on profiles times out at
      // our user volume.
      const { data: rpcRows, error } = await supabase.rpc('search_users_fast', {
        p_query: q,
        p_limit: 15,
      });
      if (error) throw error;
      const profiles = ((rpcRows as any[]) || []).map((r) => ({
        id: r.id as string,
        full_name: r.full_name as string | null,
        phone: r.phone as string | null,
      }));
      const ids = profiles.map((p) => p.id);
      const bal: Record<string, { w: number; f: number; t: number }> = {};
      if (ids.length) {
        const { data: wallets } = await supabase
          .from('wallets')
          .select('user_id, withdrawable_balance, float_balance, balance')
          .in('user_id', ids);
        for (const w of wallets || []) {
          bal[w.user_id] = {
            w: Number(w.withdrawable_balance ?? 0),
            f: Number(w.float_balance ?? 0),
            t: Number(w.balance ?? 0),
          };
        }
      }
      setHits(
        profiles.map((p) => ({
          id: p.id,
          full_name: p.full_name,
          phone: p.phone,
          withdrawable_balance: bal[p.id]?.w ?? 0,
          float_balance: bal[p.id]?.f ?? 0,
          balance: bal[p.id]?.t ?? 0,
        })),
      );
    } catch (e) {
      toast.error('Search failed', { description: (e as Error).message });
    } finally {
      setSearching(false);
    }
  };

  const pickUser = (u: UserHit) => {
    if (picking === 'source') setSource(u);
    else setDest(u);
    setHits([]);
    setTerm('');
  };

  /**
   * Compute the user's real float net exactly the way `admin-withdrawable-to-float`
   * does: sum wallet-scope legs with `wallet_bucket='float'`, counting
   * production/legacy legs plus admin-correction debits only.
   */
  useEffect(() => {
    const needed = mode === 'same_user' && sameUserDir === 'withdrawable_to_float' && !!source;
    if (!needed) {
      setFloatNet(null);
      setFloatNetLoading(false);
      return;
    }
    let cancelled = false;
    setFloatNetLoading(true);
    (async () => {
      const { data, error } = await supabase
        .from('general_ledger')
        .select('amount, direction, category, classification')
        .eq('user_id', source!.id)
        .eq('ledger_scope', 'wallet')
        .eq('wallet_bucket', 'float')
        .limit(5000);
      if (cancelled) return;
      if (error || !Array.isArray(data)) {
        setFloatNet(null);
        setFloatNetLoading(false);
        return;
      }
      let net = 0;
      for (const r of data as Array<{
        amount: number; direction: string; category: string; classification: string | null;
      }>) {
        const cls = r.classification;
        const okCls =
          cls === null || cls === 'production' ||
          (cls === 'admin_correction' && r.category === 'system_balance_correction' &&
            (r.direction === 'debit' || r.direction === 'cash_out'));
        if (!okCls) continue;
        const sign = r.direction === 'cash_in' || r.direction === 'credit' ? 1 : -1;
        net += sign * Number(r.amount);
      }
      setFloatNet(net);
      setFloatNetLoading(false);
    })();
    return () => { cancelled = true; };
  }, [mode, sameUserDir, source]);

  const amountNum = Number(amount.replace(/[, _]/g, ''));
  const sourceAvail = source
    ? sourceBucket === 'withdrawable'
      ? source.withdrawable_balance
      : source.float_balance
    : 0;
  const validAmount = Number.isInteger(amountNum) && amountNum > 0 && amountNum <= 500_000_000;
  const exceedsBalance = !!source && amountNum > sourceAvail;
  const wouldGoNegative = exceedsBalance; // sourceAvail - amountNum < 0
  const destOk =
    mode !== 'user_to_user' || (!!dest && dest.id !== source?.id);
  // Overdraft state for same-user Withdrawable → Float.
  const floatOverdrawn =
    mode === 'same_user' && sameUserDir === 'withdrawable_to_float' &&
    floatNet !== null && floatNet < 0;
  const floatShortfall = floatOverdrawn ? Math.abs(floatNet as number) : 0;
  // Amount wipes out (or exceeds) every deposit this user has ever made.
  const fullHistorySweep =
    mode === 'error_correction' &&
    lifetimeDeposits !== null &&
    lifetimeDeposits > 0 &&
    amountNum > 0 &&
    amountNum >= lifetimeDeposits;
  // ── Error-correction governance gates ─────────────────────────────────
  const isCorrection = mode === 'error_correction';
  const highValueThreshold = config?.high_value_threshold ?? 100000;
  const cfoThreshold = config?.cfo_approval_threshold ?? 500000;
  const dualThreshold = config?.dual_approval_threshold ?? 2000000;
  const removesEarnedIncome =
    isCorrection && (commissionComponent ?? 0) > 0 && (config?.require_commission_ack ?? true);
  const isHighValue = isCorrection && amountNum >= highValueThreshold;
  // Wallet → platform recoveries post immediately: no CFO / dual approval step.
  const requiredApprovals = 0;
  // Wallet → platform recoveries only need the reason note; the classification
  // code is fixed so reconciliation stays consistent.
  const effectiveReasonCode = isCorrection ? 'manual_reconciliation' : reasonCode;
  const governanceComplete =
    !isCorrection ||
    (!removesEarnedIncome || ackEarnedIncome);
  // Visible float after the move: without acknowledgement the incoming amount is
  // swallowed by the hidden hole, so visible float stays floored at 0.
  const predictedVisibleFloat = floatOverdrawn
    ? acknowledgeOverdraft
      ? (source?.float_balance ?? 0) + (amountNum || 0)
      : Math.max(0, (floatNet as number) + (amountNum || 0))
    : (source?.float_balance ?? 0) + (amountNum || 0);
  const canSubmit =
    !!source && destOk && validAmount && !exceedsBalance && reason.trim().length >= 10 &&
    !!effectiveReasonCode && !submitting && (!floatOverdrawn || acknowledgeOverdraft) &&
    (!fullHistorySweep || confirmFullHistory) && governanceComplete;
  // Never let the operator submit a Withdrawable → Float move while the real
  // float position is still being read.
  const submitBlockedByFloatCheck =
    mode === 'same_user' && sameUserDir === 'withdrawable_to_float' && floatNetLoading;

  const reset = () => {
    setSource(null);
    setDest(null);
    setAmount('');
    setReason('');
    setReasonCode('');
    setJustification('');
    setReferenceNumber('');
    setRelatedTxnId('');
    setAckEarnedIncome(false);
    setCommissionComponent(null);
    setConfirmStage('preview');
    setConfirmFullHistory(false);
    setLifetimeDeposits(null);
    setHits([]);
    setTerm('');
    setPicking('source');
    setAcknowledgeOverdraft(false);
    setFloatNet(null);
  };

  const submit = async () => {
    if (!source) return;
    // Hard client-side contract guard. The `finops-wallet-move` edge function
    // rejects any request without a structured reason_code (400) and without a
    // 10-character note, so refuse to spend a round trip on an invalid payload.
    if (!effectiveReasonCode || !REASON_CODES.some((r) => r.value === effectiveReasonCode)) {
      toast.error('Reason code required', {
        description: 'Pick a structured reason code before recovering money to the platform.',
      });
      setConfirmOpen(false);
      return;
    }
    if (reason.trim().length < 10) {
      toast.error('Reason note too short', {
        description: 'Explain what happened in at least 10 characters.',
      });
      setConfirmOpen(false);
      return;
    }
    setSubmitting(true);
    setStep('posting');

    // Real-time guard: re-fetch the source user's LATEST wallet balances right
    // before posting so we never act on a stale Operations Float / Withdrawable
    // figure. Aborts the move (and refreshes the on-screen card) if the chosen
    // bucket no longer covers the amount.
    try {
      const { data: fresh, error: freshErr } = await supabase
        .from('wallets')
        .select('withdrawable_balance, float_balance, balance')
        .eq('user_id', source.id)
        .maybeSingle();
      if (freshErr) throw freshErr;
      const freshW = Number(fresh?.withdrawable_balance ?? 0);
      const freshF = Number(fresh?.float_balance ?? 0);
      const freshT = Number(fresh?.balance ?? 0);
      const freshAvail = sourceBucket === 'withdrawable' ? freshW : freshF;
      // Keep the source card in sync with reality.
      setSource((prev) =>
        prev && prev.id === source.id
          ? { ...prev, withdrawable_balance: freshW, float_balance: freshF, balance: freshT }
          : prev,
      );
      // Snapshot the BEFORE balances so the result card can show before → after.
      setBefore({
        source: { withdrawable: freshW, float: freshF },
        dest:
          mode === 'user_to_user' && dest
            ? { withdrawable: dest.withdrawable_balance, float: dest.float_balance }
            : undefined,
      });
      if (amountNum > freshAvail) {
        setSubmitting(false);
        setConfirmOpen(false);
        setStep('idle');
        toast.error('Balance changed', {
          description: `${source.full_name || 'This user'}'s ${sourceBucket} is now ${fmt(freshAvail)}. Adjust the amount and try again.`,
        });
        return;
      }
    } catch (e) {
      setSubmitting(false);
      setConfirmOpen(false);
      setStep('idle');
      toast.error('Could not verify latest balance', { description: (e as Error).message });
      return;
    }

    // Same-user reclassification between the user's own buckets uses the
    // dedicated, balanced edge functions (never overdraws, leaves total balance
    // unchanged). Direction selects which way the money moves.
    if (mode === 'same_user') {
      const fnName =
        sameUserDir === 'float_to_withdrawable'
          ? 'admin-float-to-withdrawable'
          : 'admin-withdrawable-to-float';
      const { data, error } = await invokeEdgeFunction<{
        message: string;
        float_after: number;
        withdrawable_after: number;
      }>(fnName, {
        body: {
          target_user_id: source.id,
          amount: amountNum,
          // Keep the structured code inside the note so the same-user
          // reclassification audit trail matches the correction trail.
          reason: `[${effectiveReasonCode}] ${reason.trim()}`,
          acknowledge_float_overdraft:
            sameUserDir === 'withdrawable_to_float' && acknowledgeOverdraft
              ? true
              : undefined,
        },
        errorTitle: 'Move failed',
      });
      setSubmitting(false);
      setConfirmOpen(false);
      if (error || !data) {
        // Backend overdraft guard (FLOAT_OVERDRAWN): surface the real shortfall
        // and reveal the acknowledgement so the operator can retry in one step.
        const m = /overdrawn by UGX\s*([\d,]+)/i.exec(error?.message || '');
        if (m) {
          const shortfall = Number(m[1].replace(/,/g, ''));
          if (Number.isFinite(shortfall) && shortfall > 0) setFloatNet(-shortfall);
        }
        setStep('idle');
        return;
      }
      toast.success(data.message);
      setResult({
        message: data.message,
        amount: amountNum,
        mode: 'same_user',
        reference_id: '—',
        source: {
          name: source.full_name || 'User',
          withdrawable_after: data.withdrawable_after,
          float_after: data.float_after,
        },
        dest: { name: source.full_name || 'User' },
      });
      refreshStartedRef.current = false;
      setStep('refreshing');
      queryClient.invalidateQueries({ predicate: (q) => isWalletQuery(q.queryKey) });
      reset();
      return;
    }

    const { data, error } = await invokeEdgeFunction<
      MoveResult & { requires_approval?: boolean; approval_id?: string | null; required_approvals?: number }
    >('finops-wallet-move', {
      body: {
        mode,
        source_user_id: source.id,
        source_bucket: sourceBucket,
        dest_user_id: mode === 'user_to_user' ? dest?.id : undefined,
        dest_bucket: mode === 'user_to_user' ? destBucket : undefined,
        amount: amountNum,
        reason: reason.trim(),
        reason_code: effectiveReasonCode,
        confirm_full_history: fullHistorySweep ? true : undefined,
        business_justification: isCorrection && justification.trim() ? justification.trim() : undefined,
        reference_number: isCorrection && referenceNumber.trim() ? referenceNumber.trim() : undefined,
        related_transaction_id: isCorrection && relatedTxnId.trim() ? relatedTxnId.trim() : undefined,
        acknowledge_earned_income: isCorrection && ackEarnedIncome ? true : undefined,
        confirm_high_value: isCorrection && isHighValue ? true : undefined,
        session_id: typeof window !== 'undefined'
          ? (window.sessionStorage.getItem('welile-session-id') ?? undefined)
          : undefined,
      },
      errorTitle: 'Move failed',
    });
    setSubmitting(false);
    setConfirmOpen(false);
    if (error || !data) {
      setStep('idle');
      return;
    }
    // Above threshold: nothing is posted — the correction is parked for
    // CFO / dual approval.
    if ((data as { requires_approval?: boolean }).requires_approval) {
      setStep('idle');
      setConfirmStage('preview');
      setPendingApproval({
        approval_id: data.approval_id ?? null,
        required_approvals: data.required_approvals ?? 1,
        message: (data as unknown as { message: string }).message,
      });
      toast.info('Approval required', { description: (data as unknown as { message: string }).message });
      reset();
      return;
    }
    toast.success(data.message);
    setResult(data);
    // Kick off the refresh wave: invalidate every wallet/balance/ledger-backed
    // panel so the new balances appear immediately everywhere.
    refreshStartedRef.current = false;
    setStep('refreshing');
    queryClient.invalidateQueries({ predicate: (q) => isWalletQuery(q.queryKey) });
    reset();
  };

  const BucketToggle = ({
    value, onChange,
  }: { value: Bucket; onChange: (b: Bucket) => void }) => (
    <div className="inline-flex rounded-lg border border-border overflow-hidden">
      {(['withdrawable', 'float'] as Bucket[]).map((b) => (
        <button
          key={b}
          type="button"
          onClick={() => onChange(b)}
          className={`px-3 py-1.5 text-xs font-medium transition-colors ${
            value === b ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-muted'
          }`}
        >
          {b === 'withdrawable' ? 'Withdrawable' : 'Float'}
        </button>
      ))}
    </div>
  );

  const UserCard = ({
    user, role,
  }: { user: UserHit; role: 'source' | 'dest' }) => (
    <div className="rounded-lg border border-primary bg-primary/5 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium truncate">{user.full_name || 'Unknown'}</p>
          <p className="text-xs text-muted-foreground">{user.phone || '—'}</p>
        </div>
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground underline"
          onClick={() => (role === 'source' ? setSource(null) : setDest(null))}
        >
          Change
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5 mt-2">
        <Badge variant="outline" className="gap-1 text-[10px]">
          <Wallet className="h-3 w-3" /> Withdrawable {fmt(user.withdrawable_balance)}
        </Badge>
        <Badge variant="secondary" className="gap-1 text-[10px]">
          <Building2 className="h-3 w-3" /> Float {fmt(user.float_balance)}
        </Badge>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg sm:text-xl font-bold flex items-center gap-2.5">
          <ArrowRightLeft className="h-5 w-5 text-primary" />
          Move Money Between Wallets
        </h3>
        <p className="text-sm text-muted-foreground mt-1">
          Move money from any user to any other user, reclassify a single user's
          Operations Float into their own Withdrawable, or pull money back to the
          platform as an error correction. You can never move more than the chosen balance.
        </p>
      </div>

      {/* Post-move confirmation — proves the wallets actually changed */}
      {result && (
        <Card className="border-primary/50 bg-primary/5">
          <CardContent className="pt-5 space-y-3">
            <div className="flex items-start gap-2">
              <CheckCircle2 className="h-5 w-5 text-primary mt-0.5 shrink-0" />
              <div>
                <p className="font-semibold text-sm">{result.message}</p>
                <p className="text-xs text-muted-foreground">Ref {result.reference_id}</p>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-lg border border-border bg-background p-3">
                <p className="text-xs font-medium">{result.source.name} <span className="text-muted-foreground">(from)</span></p>
                <div className="mt-2 space-y-1.5">
                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="flex items-center gap-1 text-muted-foreground"><Wallet className="h-3 w-3" /> Withdrawable</span>
                    <span className="font-mono">
                      {before && <span className="text-muted-foreground">{fmt(before.source.withdrawable)} → </span>}
                      <span className="font-semibold">{fmt(result.source.withdrawable_after)}</span>
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="flex items-center gap-1 text-muted-foreground"><Building2 className="h-3 w-3" /> Float</span>
                    <span className="font-mono">
                      {before && <span className="text-muted-foreground">{fmt(before.source.float)} → </span>}
                      <span className="font-semibold">{fmt(result.source.float_after)}</span>
                    </span>
                  </div>
                </div>
              </div>
              {result.mode === 'user_to_user' && (
                <div className="rounded-lg border border-border bg-background p-3">
                  <p className="text-xs font-medium">{result.dest.name} <span className="text-muted-foreground">(to)</span></p>
                  <div className="mt-2 space-y-1.5">
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="flex items-center gap-1 text-muted-foreground"><Wallet className="h-3 w-3" /> Withdrawable</span>
                      <span className="font-mono">
                        {before?.dest && <span className="text-muted-foreground">{fmt(before.dest.withdrawable)} → </span>}
                        <span className="font-semibold">{fmt(result.dest.withdrawable_after ?? 0)}</span>
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="flex items-center gap-1 text-muted-foreground"><Building2 className="h-3 w-3" /> Float</span>
                      <span className="font-mono">
                        {before?.dest && <span className="text-muted-foreground">{fmt(before.dest.float)} → </span>}
                        <span className="font-semibold">{fmt(result.dest.float_after ?? 0)}</span>
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Step-by-step refresh progress */}
            <div className="rounded-lg border border-border bg-background p-3 space-y-2">
              <div className="flex items-center gap-2 text-xs">
                <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
                <span className="font-medium">Move posted to the ledger</span>
              </div>
              <div className="flex items-center gap-2 text-xs">
                {step === 'refreshing' ? (
                  <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
                ) : (
                  <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
                )}
                <span className={step === 'refreshing' ? 'font-medium' : 'text-muted-foreground'}>
                  {step === 'refreshing'
                    ? `Refreshing wallet panels${refetching > 0 ? ` (${refetching} updating…)` : '…'}`
                    : 'All wallet panels refreshed'}
                </span>
              </div>
            </div>

            <Button
              variant="outline"
              size="sm"
              disabled={step === 'refreshing'}
              onClick={() => { setResult(null); setBefore(null); setStep('idle'); }}
              className="gap-2"
            >
              {step === 'refreshing' && <Loader2 className="h-4 w-4 animate-spin" />}
              {step === 'refreshing' ? 'Refreshing…' : 'Make another move'}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Mode switch */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <button
          type="button"
          onClick={() => { setMode('user_to_user'); reset(); setResult(null); setBefore(null); }}
          className={`rounded-lg border p-3 text-left transition-colors ${
            mode === 'user_to_user' ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
          }`}
        >
          <span className="flex items-center gap-2 font-medium text-sm"><Users className="h-4 w-4" /> User → User</span>
          <span className="block text-xs text-muted-foreground mt-1">Move money to another person's wallet.</span>
        </button>
        <button
          type="button"
          onClick={() => { setMode('same_user'); reset(); setResult(null); setBefore(null); setSameUserDir('float_to_withdrawable'); setSourceBucket('float'); }}
          className={`rounded-lg border p-3 text-left transition-colors ${
            mode === 'same_user' ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
          }`}
        >
          <span className="flex items-center gap-2 font-medium text-sm"><ArrowRightLeft className="h-4 w-4" /> Float ⇄ Withdrawable</span>
          <span className="block text-xs text-muted-foreground mt-1">Same user: move money between their Operations Float and Withdrawable.</span>
        </button>
        <button
          type="button"
          onClick={() => { setMode('error_correction'); reset(); setResult(null); setBefore(null); }}
          className={`rounded-lg border p-3 text-left transition-colors ${
            mode === 'error_correction' ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
          }`}
        >
          <span className="flex items-center gap-2 font-medium text-sm"><Undo2 className="h-4 w-4" /> Back to Platform</span>
          <span className="block text-xs text-muted-foreground mt-1">Recover money as an error correction.</span>
        </button>
      </div>

      {/* Search */}
      {((picking === 'source' && !source) || (mode === 'user_to_user' && picking === 'dest' && !dest)) && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              Find the {picking === 'source' ? 'user to take money FROM' : 'user to send money TO'}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <Input
                placeholder="Search by name or phone…"
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && search()}
              />
              <Button onClick={search} disabled={searching} className="gap-2 shrink-0">
                {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                Search
              </Button>
            </div>
            {hits.length > 0 && (
              <div className="space-y-2">
                {hits.map((h) => (
                  <button
                    key={h.id}
                    onClick={() => pickUser(h)}
                    className="w-full text-left rounded-lg border border-border p-3 hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium truncate">{h.full_name || 'Unknown'}</p>
                        <p className="text-xs text-muted-foreground">{h.phone || '—'}</p>
                      </div>
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <Badge variant="outline" className="gap-1 text-[10px]">
                          <Wallet className="h-3 w-3" /> {fmt(h.withdrawable_balance)}
                        </Badge>
                        <Badge variant="secondary" className="gap-1 text-[10px]">
                          <Building2 className="h-3 w-3" /> {fmt(h.float_balance)}
                        </Badge>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Source */}
      {source && (
        <div className="space-y-2">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">From</Label>
          <UserCard user={source} role="source" />
          {mode === 'same_user' ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <span className="text-xs text-muted-foreground">Direction</span>
                <div className="inline-flex rounded-lg border border-border overflow-hidden">
                  {([
                    ['float_to_withdrawable', 'Float → Withdrawable'],
                    ['withdrawable_to_float', 'Withdrawable → Float'],
                  ] as [SameUserDir, string][]).map(([dir, label]) => (
                    <button
                      key={dir}
                      type="button"
                      onClick={() => {
                        setSameUserDir(dir);
                        setSourceBucket(dir === 'float_to_withdrawable' ? 'float' : 'withdrawable');
                      }}
                      className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                        sameUserDir === dir ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-muted'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {sameUserDir === 'float_to_withdrawable' ? (
                  <>Moving from their <span className="font-semibold text-foreground">Operations Float</span> into their{' '}
                  <span className="font-semibold text-foreground">Withdrawable</span>. Total balance is unchanged.</>
                ) : (
                  <>Moving from their <span className="font-semibold text-foreground">Withdrawable</span> into their{' '}
                  <span className="font-semibold text-foreground">Operations Float</span>. Total balance is unchanged.</>
                )}
              </p>
            </div>
          ) : (
            <div className="flex items-center justify-between flex-wrap gap-2">
              <span className="text-xs text-muted-foreground">Take from bucket</span>
              <BucketToggle value={sourceBucket} onChange={setSourceBucket} />
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Available in {sourceBucket === 'withdrawable' ? 'Withdrawable' : 'Float'}: <span className="font-semibold text-foreground">{fmt(sourceAvail)}</span>
          </p>
          {mode === 'user_to_user' && !dest && picking !== 'dest' && (
            <Button variant="outline" size="sm" onClick={() => setPicking('dest')} className="gap-2">
              <Search className="h-4 w-4" /> Choose recipient
            </Button>
          )}
        </div>
      )}

      {/* Destination */}
      {mode === 'user_to_user' && dest && (
        <div className="space-y-2">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">To</Label>
          <UserCard user={dest} role="dest" />
          <div className="flex items-center justify-between flex-wrap gap-2">
            <span className="text-xs text-muted-foreground">Add to bucket</span>
            <BucketToggle value={destBucket} onChange={setDestBucket} />
          </div>
        </div>
      )}

      {/* Amount + reason */}
      {source && (mode === 'error_correction' || mode === 'same_user' || dest) && (
        <Card>
          <CardContent className="space-y-4 pt-5">
            <div>
              <Label htmlFor="fwm-amount" className="text-xs">Amount (UGX)</Label>
              <Input
                id="fwm-amount"
                inputMode="numeric"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0"
                className="mt-1"
              />
              {amount && exceedsBalance && (
                <p className="text-xs text-destructive mt-1 flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" /> Exceeds available {sourceBucket} balance. Maximum: {fmt(sourceAvail)}.
                </p>
              )}
              {amount && !exceedsBalance && validAmount && sourceAvail > 0 && (
                <p className="text-xs text-muted-foreground mt-1">
                  Balance after move: <span className="font-semibold text-foreground">{fmt(Math.max(0, sourceAvail - amountNum))}</span> {sourceBucket}
                  {mode === 'same_user' && (
                    sameUserDir === 'float_to_withdrawable' ? (
                      <> · Withdrawable becomes: <span className="font-semibold text-foreground">{fmt(source.withdrawable_balance + amountNum)}</span></>
                    ) : (
                      <> · Visible Float becomes: <span className="font-semibold text-foreground">{fmt(predictedVisibleFloat)}</span>
                        {floatOverdrawn && !acknowledgeOverdraft && (
                          <> (the move is absorbed by the {fmt(floatShortfall)} overdraft)</>
                        )}
                      </>
                    )
                  )}
                </p>
              )}
            </div>
            {!isCorrection && (
            <div>
              <Label htmlFor="fwm-reason-code" className="text-xs">Reason code (required)</Label>
              <select
                id="fwm-reason-code"
                value={reasonCode}
                onChange={(e) => setReasonCode(e.target.value)}
                className="mt-1 w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">Select a reason code…</option>
                {REASON_CODES.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
              {!reasonCode && (
                <p className="text-xs text-destructive mt-1 flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" /> A reason code is required — it classifies
                  why this correction exists.
                </p>
              )}
            </div>
            )}
            <div>
              <Label htmlFor="fwm-reason" className="text-xs">Reason note (min 10 characters)</Label>
              <Textarea
                id="fwm-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Explain why this money is being moved…"
                rows={2}
                className="mt-1"
              />
              {reason.trim().length > 0 && reason.trim().length < 10 && (
                <p className="text-xs text-destructive mt-1">
                  Explain what happened in at least 10 characters ({reason.trim().length}/10).
                </p>
              )}
            </div>
            {null}
            {removesEarnedIncome && (
              <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 space-y-2">
                <div className="flex items-start gap-2 text-xs">
                  <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold text-foreground">
                      You are about to remove earned commission from this user's Withdrawable wallet
                    </p>
                    <p className="text-muted-foreground mt-0.5">
                      {fmt(commissionComponent ?? 0)} of this balance is commission they have
                      already earned. This represents income already earned by the user, not
                      company float.
                    </p>
                  </div>
                </div>
                <label className="flex items-start gap-2 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={ackEarnedIncome}
                    onChange={(e) => setAckEarnedIncome(e.target.checked)}
                  />
                  <span>
                    I explicitly confirm that earned income is being removed and that this is
                    justified.
                  </span>
                </label>
              </div>
            )}
            {null}
            {mode === 'error_correction' && lifetimeDeposits !== null && (
              <p className="text-xs text-muted-foreground">
                Lifetime approved deposits by this user:{' '}
                <span className="font-semibold text-foreground">{fmt(lifetimeDeposits)}</span>
              </p>
            )}
            {fullHistorySweep && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 space-y-2">
                <div className="flex items-start gap-2 text-xs">
                  <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold text-foreground">
                      This removes everything this user ever deposited
                    </p>
                    <p className="text-muted-foreground mt-0.5">
                      {fmt(amountNum)} equals or exceeds their full lifetime approved deposits of{' '}
                      {fmt(lifetimeDeposits ?? 0)}. They will be left with nothing in this bucket
                      and will receive an SMS telling them the money was reversed. Confirm only if
                      that is genuinely correct.
                    </p>
                  </div>
                </div>
                <label className="flex items-start gap-2 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={confirmFullHistory}
                    onChange={(e) => setConfirmFullHistory(e.target.checked)}
                  />
                  <span>
                    I confirm this full-history recovery is correct and I have verified the
                    underlying deposits.
                  </span>
                </label>
              </div>
            )}
            {floatOverdrawn && (
                <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 space-y-2">
                  <div className="flex items-start gap-2 text-xs text-warning-foreground">
                    <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
                    <div>
                      <p className="font-semibold text-foreground">
                        Float is overdrawn by {fmt(floatShortfall)}
                      </p>
                      <p className="text-muted-foreground mt-0.5">
                        Past float usage exceeded recorded float deposits, so the wallet card shows
                        Float {fmt(source.float_balance)} while the ledger position is negative.
                        On submit, the platform will first auto-fill the overdraft with a balanced
                        admin_correction entry (double-entry, hidden from the user's wallet history),
                        then move {fmt(amountNum || 0)} on top. Visible Float after move:{' '}
                        <span className="font-semibold text-foreground">
                          {fmt(source.float_balance + (amountNum || 0))}
                        </span>
                        . Without this acknowledgement the move is rejected.
                      </p>
                    </div>
                  </div>
                  <label className="flex items-start gap-2 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={acknowledgeOverdraft}
                      onChange={(e) => setAcknowledgeOverdraft(e.target.checked)}
                    />
                    <span>
                      I acknowledge Float is overdrawn. Auto-fill the overdraft as a balanced
                      admin_correction, then post this move on top so visible Float rises by the
                      full amount.
                    </span>
                  </label>
                </div>
              )}
            {pendingApproval && (
              <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs">
                <p className="font-semibold text-foreground">Awaiting approval</p>
                <p className="text-muted-foreground mt-0.5">{pendingApproval.message}</p>
              </div>
            )}
            <Button
              onClick={() => { setPendingApproval(null); setConfirmStage('preview'); setConfirmOpen(true); }}
              disabled={!canSubmit || submitBlockedByFloatCheck}
              className="w-full gap-2"
            >
              <ArrowRightLeft className="h-4 w-4" />
              {mode === 'user_to_user'
                ? 'Move money'
                : mode === 'same_user'
                  ? (sameUserDir === 'float_to_withdrawable' ? 'Move to Withdrawable' : 'Move to Float')
                  : 'Recover to platform'}
            </Button>
          </CardContent>
        </Card>
      )}

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(o) => { setConfirmOpen(o); if (!o) setConfirmStage('preview'); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isCorrection && confirmStage === 'preview'
                ? 'Review this correction'
                : 'Confirm money movement'}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  Move <span className="font-semibold">{fmt(amountNum || 0)}</span> from{' '}
                  <span className="font-semibold">{source?.full_name || 'user'}</span>'s{' '}
                  {sourceBucket} balance{' '}
                  {mode === 'user_to_user'
                    ? <>to <span className="font-semibold">{dest?.full_name || 'recipient'}</span>'s {destBucket} balance.</>
                    : mode === 'same_user'
                      ? (sameUserDir === 'float_to_withdrawable'
                          ? <>into their own <span className="font-semibold">Withdrawable</span> balance. Total balance is unchanged.</>
                          : <>into their own <span className="font-semibold">Operations Float</span> balance. Total balance is unchanged.</>)
                      : 'back to the platform as an error correction.'}
                </p>
                <p className="text-muted-foreground">{reason}</p>
                {isCorrection && (
                  <div className="rounded-lg border border-border bg-muted/40 p-3 space-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Current {sourceBucket} balance</span>
                      <span className="font-semibold text-foreground">
                        {fmt(sourceBucket === 'withdrawable'
                          ? (source?.withdrawable_balance ?? 0)
                          : (source?.float_balance ?? 0))}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Balance after correction</span>
                      <span className="font-semibold text-foreground">
                        {fmt(Math.max(0,
                          (sourceBucket === 'withdrawable'
                            ? (source?.withdrawable_balance ?? 0)
                            : (source?.float_balance ?? 0)) - (amountNum || 0)))}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Earned commission affected</span>
                      <span className="font-semibold text-foreground">
                        {fmt(Math.min(commissionComponent ?? 0, amountNum || 0))}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Destination</span>
                      <span className="font-semibold text-foreground">Welile Platform</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Posts</span>
                      <span className="font-semibold text-foreground">Immediately</span>
                    </div>
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
            {isCorrection && confirmStage === 'preview' ? (
              <AlertDialogAction
                onClick={(e) => { e.preventDefault(); setConfirmStage('final'); }}
              >
                Continue
              </AlertDialogAction>
            ) : (
              <AlertDialogAction onClick={(e) => { e.preventDefault(); submit(); }} disabled={submitting}>
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Confirm'}
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}