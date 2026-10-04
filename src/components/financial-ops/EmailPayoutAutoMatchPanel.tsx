import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Popover, PopoverContent, PopoverTrigger,
} from '@/components/ui/popover';
import {
  Loader2, ShieldCheck, RefreshCw, Sparkles, Send, CheckCircle2, AlertCircle, Settings2,
  History,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useFinOpsAutoRefresh } from '@/hooks/useFinOpsAutoRefresh';
import { format } from 'date-fns';
import { normalizeUgPhone, extractToPhones } from './emailExtraction';
import { EmailPayoutMatchAuditPanel } from './EmailPayoutMatchAuditPanel';

/**
 * Auto-detects PAYOUT confirmations in the connected inbox (money-out
 * emails from MTN MoMo / Airtel Money / banks) and pairs each one with
 * a pending withdrawal_request whose recipient phone + amount line up.
 * Exact matches are auto-approved via the `approve-withdrawal` edge
 * function using the email's Transaction ID as the FinOps reference.
 *
 * Safe-by-default: we only auto-approve when (1) the email is outgoing,
 * (2) the recipient phone in the email matches the withdrawal's
 * `mobile_money_number`, (3) the email amount equals the withdrawal
 * amount (no tolerance), and (4) the email's TID has not already been
 * used on any completed/processing/paid withdrawal.
 */

const fmtUgx = (n: number) => `UGX ${Math.round(n).toLocaleString()}`;

// ---- Configurable matching tolerances --------------------------------------
// Persisted in localStorage so FinOps can tune them without a redeploy when
// upstream email parsers produce small differences (e.g. fee included in the
// printed amount, recipient phone printed without the country code, etc.).
const TOLERANCE_KEY = 'finops.payout-automatch.tolerance.v1';

interface MatchTolerance {
  /** Absolute UGX tolerance applied to |email.amount - withdrawal.amount|. */
  amountUgx: number;
  /** Compare only the trailing N digits of normalised phones (9 = local part). */
  phoneTailDigits: number;
}

const DEFAULT_TOLERANCE: MatchTolerance = { amountUgx: 0, phoneTailDigits: 9 };

function loadTolerance(): MatchTolerance {
  try {
    const raw = localStorage.getItem(TOLERANCE_KEY);
    if (!raw) return DEFAULT_TOLERANCE;
    const parsed = JSON.parse(raw);
    const amountUgx = Math.max(0, Math.min(50_000, Number(parsed?.amountUgx ?? 0)));
    const phoneTailDigits = Math.max(6, Math.min(12, Number(parsed?.phoneTailDigits ?? 9)));
    return {
      amountUgx: Number.isFinite(amountUgx) ? amountUgx : 0,
      phoneTailDigits: Number.isFinite(phoneTailDigits) ? phoneTailDigits : 9,
    };
  } catch {
    return DEFAULT_TOLERANCE;
  }
}

function saveTolerance(t: MatchTolerance) {
  try { localStorage.setItem(TOLERANCE_KEY, JSON.stringify(t)); } catch { /* ignore */ }
}

/** Strip to digits and keep the last N — survives "+256", "0", "256" prefixes. */
function tail(phone: string, n: number): string {
  const d = phone.replace(/\D/g, '');
  return d.length <= n ? d : d.slice(-n);
}

function phonesMatch(target: string, candidates: string[], tailDigits: number): boolean {
  const t = tail(target, tailDigits);
  if (!t) return false;
  return candidates.some((c) => tail(c, tailDigits) === t);
}

// ---- Audit trail logging ---------------------------------------------------
type AuditOutcome =
  | 'matched_auto_approved'
  | 'matched_approve_failed'
  | 'matched_manual_retry_ok'
  | 'matched_manual_retry_failed'
  | 'tid_burned_skip';

async function logMatchAttempt(args: {
  outcome: AuditOutcome;
  match: PayoutMatch;
  tolerance: MatchTolerance;
  error?: string;
  extra?: Record<string, unknown>;
}) {
  try {
    const { match: m, tolerance, outcome, error, extra } = args;
    const emailAmt = m.email.amount == null ? null : Math.round(Number(m.email.amount));
    const wAmt = Math.round(Number(m.withdrawal.amount));
    const { data: u } = await supabase.auth.getUser();
    await supabase.from('email_payout_match_attempts').insert({
      operator_id: u?.user?.id ?? null,
      withdrawal_id: m.withdrawal.id,
      email_id: m.email.id,
      email_transaction_id: (m.email.transaction_id || '').trim().toUpperCase() || null,
      withdrawal_amount: wAmt,
      email_amount: emailAmt,
      amount_delta: emailAmt == null ? null : emailAmt - wAmt,
      recipient_phone_target: m.withdrawal.mobile_money_number ?? m.recipientPhone,
      recipient_phone_email: m.recipientPhone,
      payment_method: m.payment_method,
      outcome,
      error_message: error ?? null,
      tolerance_amount_ugx: tolerance.amountUgx,
      tolerance_phone_tail: tolerance.phoneTailDigits,
      metadata: {
        email_from: m.email.from_email,
        email_from_name: m.email.from_name,
        email_subject: m.email.subject,
        email_channel: m.email.channel,
        ...(m.split
          ? {
              split: true,
              split_share: m.split.share,
              split_subset_size: m.split.subsetSize,
              split_group_key: m.split.groupKey,
              email_remaining_at_match: m.split.emailRemaining,
            }
          : { split: false }),
        ...(extra ?? {}),
      },
    });
  } catch (e) {
    // Audit logging must never break the matcher.
    console.warn('[email-payout-match] audit log failed', e);
  }
}

interface PendingWithdrawal {
  id: string;
  user_id: string;
  amount: number;
  status: string;
  mobile_money_number: string | null;
  mobile_money_provider: string | null;
  payout_method: string | null;
  created_at: string;
}

interface OutEmail {
  id: string;
  amount: number | null;
  transaction_id: string | null;
  channel: string | null;
  from_email: string | null;
  from_name: string | null;
  subject: string | null;
  snippet: string | null;
  counterparty: string | null;
  internal_date: string | null;
  toPhones: string[];
}

interface PayoutMatch {
  withdrawal: PendingWithdrawal;
  email: OutEmail;
  recipientPhone: string;
  payment_method: string;
  /**
   * Set when the email is settling more than one pending withdrawal.
   * `share` is the per-withdrawal amount, `emailRemaining` is the email's
   * unsettled capacity at scan time, `subsetSize` is the number of pending
   * withdrawals in this split, and `groupKey` lets the audit trail tie
   * sibling rows together.
   */
  split?: {
    share: number;
    emailRemaining: number;
    subsetSize: number;
    groupKey: string;
  };
}

function inferPaymentMethod(w: PendingWithdrawal, e: OutEmail): string {
  const explicit = (w.payout_method || w.mobile_money_provider || '').toLowerCase();
  if (explicit === 'mtn_momo' || explicit === 'airtel_money' || explicit === 'bank_transfer' || explicit === 'cash') {
    return explicit;
  }
  const hay = `${e.channel ?? ''} ${e.from_email ?? ''} ${e.from_name ?? ''}`.toLowerCase();
  if (hay.includes('mtn')) return 'mtn_momo';
  if (hay.includes('airtel')) return 'airtel_money';
  if (/bank|equity|stanbic|dfcu|centenary|absa/.test(hay)) return 'bank_transfer';
  return 'mtn_momo';
}

export function EmailPayoutAutoMatchPanel() {
  const { toast } = useToast();
  const autoRefresh = useFinOpsAutoRefresh();
  const [matches, setMatches] = useState<PayoutMatch[]>([]);
  const [running, setRunning] = useState(false);
  const [autoApproving, setAutoApproving] = useState(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [lastRunAt, setLastRunAt] = useState<Date | null>(null);
  const [autoApprovedCount, setAutoApprovedCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const autoApprovedRef = useRef<Set<string>>(new Set()); // withdrawal ids already attempted
  const runningRef = useRef(false);
  const [tolerance, setTolerance] = useState<MatchTolerance>(() => loadTolerance());
  const toleranceRef = useRef<MatchTolerance>(tolerance);
  useEffect(() => { toleranceRef.current = tolerance; saveTolerance(tolerance); }, [tolerance]);
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditRefreshTick, setAuditRefreshTick] = useState(0);

  /** Pull (a) pending withdrawals and (b) recent outgoing emails, then pair. */
  const scan = useCallback(async (): Promise<PayoutMatch[]> => {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const [wRes, eRes] = await Promise.all([
      supabase
        .from('withdrawal_requests')
        .select('id,user_id,amount,status,mobile_money_number,mobile_money_provider,payout_method,created_at')
        .in('status', ['pending', 'requested', 'manager_approved', 'cfo_approved', 'fin_ops_approved'])
        .not('mobile_money_number', 'is', null)
        .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
        .limit(200),
      supabase
        .from('gmail_transactions')
        .select('id,amount,transaction_id,channel,from_email,from_name,subject,snippet,counterparty,internal_date,direction')
        .eq('direction', 'out')
        .not('transaction_id', 'is', null)
        .gte('internal_date', sevenDaysAgo)
        .order('internal_date', { ascending: false })
        .limit(500),
    ]);
    if (wRes.error) throw wRes.error;
    if (eRes.error) throw eRes.error;

    const withdrawals = (wRes.data ?? []) as PendingWithdrawal[];
    const emails: OutEmail[] = (eRes.data ?? [])
      .map((r: any) => ({
        id: r.id,
        amount: r.amount == null ? null : Number(r.amount),
        transaction_id: r.transaction_id,
        channel: r.channel,
        from_email: r.from_email,
        from_name: r.from_name,
        subject: r.subject,
        snippet: r.snippet,
        counterparty: r.counterparty,
        internal_date: r.internal_date,
        toPhones: extractToPhones(r),
      }))
      .filter((e) => e.transaction_id && e.amount && e.toPhones.length > 0);

    // Compute already-settled UGX per TID. We treat ANY withdrawal that
    // already references this TID as having consumed that portion of the
    // email's capacity — so a partial email can keep clearing siblings on
    // subsequent scans without re-using the same UGX twice.
    const candidateTids = Array.from(new Set(emails.map((e) => e.transaction_id!.trim().toUpperCase())));
    const settledByTid = new Map<string, number>();
    if (candidateTids.length > 0) {
      const { data: usedRows } = await supabase
        .from('withdrawal_requests')
        .select('amount,fin_ops_reference,status')
        .in('fin_ops_reference', candidateTids);
      (usedRows ?? []).forEach((r: any) => {
        if (!r.fin_ops_reference) return;
        // Anything not explicitly rejected/cancelled counts as having
        // claimed its share of the TID.
        if (['rejected', 'cancelled', 'failed', 'expired'].includes(String(r.status))) return;
        const k = String(r.fin_ops_reference).trim().toUpperCase();
        settledByTid.set(k, (settledByTid.get(k) ?? 0) + Math.round(Number(r.amount) || 0));
      });
    }

    const tol = toleranceRef.current;
    const out: PayoutMatch[] = [];
    const usedWithdrawalIds = new Set<string>();

    // Walk emails newest-first; for each, find the best subset of pending
    // withdrawals whose summed amount fills the email's remaining capacity.
    for (const e of emails) {
      const tidKey = (e.transaction_id || '').trim().toUpperCase();
      const emailAmt = Math.round(Number(e.amount));
      const remaining = emailAmt - (settledByTid.get(tidKey) ?? 0);
      if (remaining <= tol.amountUgx) continue; // fully (or over-) settled

      // Candidate pending withdrawals: same recipient phone, not yet picked.
      const candidates = withdrawals.filter((w) => {
        if (usedWithdrawalIds.has(w.id)) return false;
        const target = normalizeUgPhone(w.mobile_money_number || '');
        if (!target) return false;
        return phonesMatch(target, e.toPhones, tol.phoneTailDigits);
      });
      if (candidates.length === 0) continue;

      // 1) Prefer an exact single-withdrawal match — preserves prior behavior
      //    and avoids speculative splits when one is enough.
      const single = candidates.find(
        (w) => Math.abs(Math.round(Number(w.amount)) - remaining) <= tol.amountUgx,
      );
      let chosen: PendingWithdrawal[] | null = single ? [single] : null;

      // 2) Else search for the smallest subset whose sum equals `remaining`
      //    within tolerance. Bound to 8 candidates (2^8 = 256 combos) to
      //    keep this O(n) overall and safe on the UI thread.
      if (!chosen && candidates.length >= 2) {
        const pool = candidates.slice(0, 8);
        const amounts = pool.map((w) => Math.round(Number(w.amount)));
        let best: number[] | null = null;
        const total = 1 << pool.length;
        for (let mask = 1; mask < total; mask++) {
          let sum = 0;
          const picks: number[] = [];
          for (let i = 0; i < pool.length; i++) {
            if (mask & (1 << i)) { sum += amounts[i]; picks.push(i); }
          }
          if (picks.length < 2) continue; // single-pick already tried
          if (Math.abs(sum - remaining) <= tol.amountUgx) {
            if (!best || picks.length < best.length) best = picks;
            if (best && best.length === 2) break; // can't do better than a pair
          }
        }
        if (best) chosen = best.map((i) => pool[i]);
      }

      if (!chosen || chosen.length === 0) continue;

      const isSplit = chosen.length > 1;
      const groupKey = `${e.id}:${tidKey}`;
      for (const w of chosen) {
        usedWithdrawalIds.add(w.id);
        const target = normalizeUgPhone(w.mobile_money_number || '')!;
        out.push({
          withdrawal: w,
          email: e,
          recipientPhone: target,
          payment_method: inferPaymentMethod(w, e),
          ...(isSplit
            ? {
                split: {
                  share: Math.round(Number(w.amount)),
                  emailRemaining: remaining,
                  subsetSize: chosen.length,
                  groupKey,
                },
              }
            : {}),
        });
      }
      // Reserve this email's remaining capacity so it isn't re-used in this
      // scan cycle. Persistence across scans is handled by `settledByTid`
      // once the chosen withdrawals are approved and stamp this TID.
      settledByTid.set(tidKey, (settledByTid.get(tidKey) ?? 0) + chosen.reduce((s, w) => s + Math.round(Number(w.amount)), 0));
    }

    return out;
  }, []);

  const approveOne = useCallback(
    async (m: PayoutMatch): Promise<{ ok: boolean; error?: string }> => {
      try {
        const { data, error: invErr } = await supabase.functions.invoke('approve-withdrawal', {
          body: {
            withdrawal_id: m.withdrawal.id,
            reference: (m.email.transaction_id || '').trim().toUpperCase(),
            payment_method: m.payment_method,
          },
        });
        if (invErr) {
          const msg = (data as any)?.error || (data as any)?.message || invErr.message || 'Approve failed';
          return { ok: false, error: msg };
        }
        return { ok: true };
      } catch (e: any) {
        return { ok: false, error: e?.message ?? 'Approve failed' };
      }
    },
    [],
  );

  const runScan = useCallback(
    async (silent = false) => {
      if (runningRef.current) return;
      runningRef.current = true;
      setRunning(true);
      setError(null);
      try {
        const found = await scan();

        // Auto-approve every fresh match in this scan that we haven't
        // already attempted in this session.
        const fresh = found.filter((m) => !autoApprovedRef.current.has(m.withdrawal.id));
        let approved = 0;
        const failures: PayoutMatch[] = [];
        if (fresh.length > 0) {
          setAutoApproving(true);
          for (const m of fresh) {
            autoApprovedRef.current.add(m.withdrawal.id);
            // eslint-disable-next-line no-await-in-loop
            const res = await approveOne(m);
            if (res.ok) {
              approved += 1;
              // eslint-disable-next-line no-await-in-loop
              await logMatchAttempt({
                outcome: 'matched_auto_approved',
                match: m,
                tolerance: toleranceRef.current,
              });
            } else {
              failures.push(m);
              // eslint-disable-next-line no-await-in-loop
              await logMatchAttempt({
                outcome: 'matched_approve_failed',
                match: m,
                tolerance: toleranceRef.current,
                error: res.error,
              });
            }
          }
          setAutoApproving(false);
          setAuditRefreshTick((t) => t + 1);
        }

        setAutoApprovedCount((prev) => prev + approved);
        setMatches(failures); // Only show what still needs attention.
        setLastRunAt(new Date());

        if (!silent && approved > 0) {
          toast({
            title: `Auto-paid ${approved} withdrawal${approved === 1 ? '' : 's'}`,
            description: 'Matched outgoing MoMo confirmation emails to pending payouts and approved them.',
          });
        }
        if (!silent && failures.length > 0) {
          toast({
            title: `${failures.length} match${failures.length === 1 ? '' : 'es'} need review`,
            description: 'A matched email could not be auto-approved — see below.',
            variant: 'destructive',
          });
        }
        if (!silent && approved === 0 && failures.length === 0) {
          toast({ title: 'No new payout matches' });
        }
      } catch (e: any) {
        console.warn('[email-payout-match] failed', e);
        setError(e?.message ?? 'Scan failed');
        if (!silent) {
          toast({ title: 'Payout auto-match failed', description: e?.message ?? 'Unknown error', variant: 'destructive' });
        }
      } finally {
        setRunning(false);
        runningRef.current = false;
      }
    },
    [approveOne, scan, toast],
  );

  // Initial run + auto-rescan every 30s while the panel is mounted.
  useEffect(() => {
    runScan(true);
    if (!autoRefresh) return;
    const id = setInterval(() => runScan(true), 30_000);
    return () => clearInterval(id);
  }, [autoRefresh, runScan]);

  const retryOne = useCallback(
    async (m: PayoutMatch) => {
      setApprovingId(m.withdrawal.id);
      const res = await approveOne(m);
      setApprovingId(null);
      if (res.ok) {
        setMatches((prev) => prev.filter((x) => x.withdrawal.id !== m.withdrawal.id));
        setAutoApprovedCount((c) => c + 1);
        toast({ title: 'Withdrawal approved', description: fmtUgx(m.withdrawal.amount) });
        await logMatchAttempt({
          outcome: 'matched_manual_retry_ok',
          match: m,
          tolerance: toleranceRef.current,
        });
      } else {
        toast({ title: 'Approve failed', description: res.error ?? 'Unknown error', variant: 'destructive' });
        await logMatchAttempt({
          outcome: 'matched_manual_retry_failed',
          match: m,
          tolerance: toleranceRef.current,
          error: res.error,
        });
      }
      setAuditRefreshTick((t) => t + 1);
    },
    [approveOne, toast],
  );

  const headerRight = useMemo(
    () => (
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          onClick={() => setAuditOpen((v) => !v)}
          title="Audit trail"
        >
          <History className="h-4 w-4" />
          <span className="hidden sm:inline">{auditOpen ? 'Hide audit' : 'Audit'}</span>
        </Button>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="gap-2" title="Matching tolerances">
              <Settings2 className="h-4 w-4" />
              <span className="hidden sm:inline">Tolerance</span>
              <Badge variant="secondary" className="text-[10px]">
                ±{tolerance.amountUgx.toLocaleString()} · {tolerance.phoneTailDigits}d
              </Badge>
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 space-y-3">
            <div className="space-y-1">
              <Label htmlFor="amt-tol" className="text-xs">Amount tolerance (UGX)</Label>
              <Input
                id="amt-tol"
                type="number"
                min={0}
                max={50000}
                step={100}
                value={tolerance.amountUgx}
                onChange={(e) => setTolerance((t) => ({
                  ...t,
                  amountUgx: Math.max(0, Math.min(50_000, Number(e.target.value) || 0)),
                }))}
              />
              <p className="text-[10px] text-muted-foreground">
                Allow this many UGX of difference between the email amount and the withdrawal amount.
                Useful when telco fees are bundled into the printed total. Default 0.
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="phone-tail" className="text-xs">Phone match — last N digits</Label>
              <Input
                id="phone-tail"
                type="number"
                min={6}
                max={12}
                step={1}
                value={tolerance.phoneTailDigits}
                onChange={(e) => setTolerance((t) => ({
                  ...t,
                  phoneTailDigits: Math.max(6, Math.min(12, Number(e.target.value) || 9)),
                }))}
              />
              <p className="text-[10px] text-muted-foreground">
                Compare only the trailing N digits, so "+256 772…", "0772…" and "772…" all match.
                Default 9 (the Uganda local part).
              </p>
            </div>
            <div className="flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setTolerance(DEFAULT_TOLERANCE)}
              >
                Reset to defaults
              </Button>
            </div>
          </PopoverContent>
        </Popover>
        <Button variant="outline" onClick={() => runScan(false)} disabled={running} className="gap-2">
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Rescan
        </Button>
      </div>
    ),
    [runScan, running, tolerance, auditOpen],
  );

  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <div className="p-4 border-b bg-gradient-to-r from-emerald-500/5 to-transparent flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold text-sm sm:text-base flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-emerald-600" />
            Auto-approve payouts from outgoing emails
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Pairs pending withdrawals with parsed MoMo/Airtel/bank payout confirmations using recipient phone + exact amount.
            Approves automatically using the email's Transaction ID as the FinOps reference.
          </p>
          {lastRunAt && (
            <p className="text-[10px] text-muted-foreground mt-1 flex items-center gap-2">
              <span>Last scan: {format(lastRunAt, 'HH:mm:ss')} · auto-rescans every 30s</span>
              {autoApprovedCount > 0 && (
                <Badge variant="secondary" className="gap-1">
                  <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                  {autoApprovedCount} auto-approved this session
                </Badge>
              )}
              {autoApproving && (
                <span className="inline-flex items-center gap-1 text-emerald-700">
                  <Loader2 className="h-3 w-3 animate-spin" /> approving…
                </span>
              )}
            </p>
          )}
        </div>
        {headerRight}
      </div>

      {error && (
        <div className="p-3 text-xs text-destructive bg-destructive/5 border-b border-destructive/20 flex items-center gap-2">
          <AlertCircle className="h-3.5 w-3.5" /> {error}
        </div>
      )}

      {matches.length === 0 ? (
        <div className="p-6 text-center text-xs text-muted-foreground">
          {running
            ? 'Scanning recent payout emails…'
            : 'No payout emails are currently waiting on manual approval. Auto-matched payouts are credited instantly.'}
        </div>
      ) : (
        <div className="divide-y">
          {matches.map((m) => (
            <div key={m.withdrawal.id} className="p-3 flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Send className="h-3.5 w-3.5 text-emerald-600" />
                  {fmtUgx(m.withdrawal.amount)}
                  <Badge variant="outline" className="text-[10px]">{m.payment_method}</Badge>
                  {m.split && (
                    <Badge className="text-[10px] bg-amber-100 text-amber-800 hover:bg-amber-100">
                      Split {m.split.subsetSize}× · share {fmtUgx(m.split.share)} of {fmtUgx(m.split.emailRemaining)}
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5 truncate">
                  To {m.recipientPhone} · TID <span className="font-mono">{m.email.transaction_id}</span>
                  {m.email.from_name ? ` · ${m.email.from_name}` : ''}
                </div>
                {m.email.snippet && (
                  <div className="text-[11px] text-muted-foreground mt-1 line-clamp-2">{m.email.snippet}</div>
                )}
              </div>
              <Button
                size="sm"
                onClick={() => retryOne(m)}
                disabled={approvingId === m.withdrawal.id}
                className="gap-2"
              >
                {approvingId === m.withdrawal.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ShieldCheck className="h-3.5 w-3.5" />
                )}
                Retry approve
              </Button>
            </div>
          ))}
        </div>
      )}

      {auditOpen && (
        <div className="border-t bg-muted/20">
          <EmailPayoutMatchAuditPanel refreshKey={auditRefreshTick} />
        </div>
      )}
    </div>
  );
}
