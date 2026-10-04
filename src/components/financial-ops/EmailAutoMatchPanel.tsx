import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Mail, Loader2, ShieldCheck, CheckCircle2, AlertCircle, RefreshCw, Sparkles, ChevronDown, ChevronRight } from 'lucide-react';
import { Bot } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useFinOpsAutoRefresh } from '@/hooks/useFinOpsAutoRefresh';
import { format } from 'date-fns';

interface Match {
  deposit_request_id: string;
  gmail_transaction_id: string;
  method: 'tid' | 'amount' | 'amount_strong';
  amount: number;
  matched_transaction_id: string | null;
  user_id: string;
  provider: string | null;
  counterparty: string | null;
  internal_date: string | null;
  signals?: string[] | null;
  match_score?: number | null;
  from_email?: string | null;
  from_name?: string | null;
  subject?: string | null;
  snippet?: string | null;
  depositor_email?: string | null;
  depositor_full_name?: string | null;
  // hydrated:
  depositor_name?: string;
  depositor_phone?: string;
  deposit_tid?: string | null;
  /**
   * True when this pending deposit_request was created by the Gmail
   * auto-creation trigger (i.e. the email landed before the depositor
   * submitted anything in-app). Surfaced as a badge so the operator
   * knows the row will be auto-approved on the next matcher scan.
   */
  auto_created_from_email?: boolean;
}

const fmtUgx = (n: number) => `UGX ${Math.round(n).toLocaleString()}`;

async function writeAudit(entry: {
  gmail_transaction_id?: string | null;
  deposit_request_id?: string | null;
  action: 'approve' | 'bulk_approve' | 'skip';
  matcher_type?: string | null;
  match_score?: number | null;
  signals?: string[] | null;
  amount?: number | null;
  notes?: string | null;
}) {
  try {
    const { data: sess } = await supabase.auth.getSession();
    const u = sess?.session?.user;
    await (supabase.from('email_match_audit_log') as any).insert({
      gmail_transaction_id: entry.gmail_transaction_id ?? null,
      deposit_request_id: entry.deposit_request_id ?? null,
      action: entry.action,
      matcher_type: entry.matcher_type ?? null,
      match_score: entry.match_score ?? null,
      signals: entry.signals ?? null,
      amount: entry.amount ?? null,
      actor_id: u?.id ?? null,
      actor_email: u?.email ?? null,
      notes: entry.notes ?? null,
    });
  } catch (e) {
    console.warn('[audit] write failed', e);
  }
}

/**
 * Reads parsed transaction-confirmation emails from the connected inbox and
 * auto-pairs each one with a pending deposit_request whose Transaction ID or
 * amount matches. Exact TID matches can be bulk-approved with one click;
 * amount-only matches are surfaced as suggestions for the operator to confirm.
 */
export function EmailAutoMatchPanel() {
  const { toast } = useToast();
  const autoRefresh = useFinOpsAutoRefresh();
  const [matches, setMatches] = useState<Match[]>([]);
  const [running, setRunning] = useState(false);
  const [approving, setApproving] = useState<Set<string>>(new Set());
  const [bulkApproving, setBulkApproving] = useState(false);
  const [lastRunAt, setLastRunAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying24h, setRetrying24h] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const runningRef = useRef(false);
  const autoApprovedRef = useRef<Set<string>>(new Set());

  const hydrate = useCallback(async (raw: Match[]): Promise<Match[]> => {
    if (raw.length === 0) return [];
    const userIds = Array.from(new Set(raw.map((m) => m.user_id)));
    const depositIds = raw.map((m) => m.deposit_request_id);
    const [{ data: profiles }, { data: deposits }] = await Promise.all([
      supabase.from('profiles').select('id, full_name, phone').in('id', userIds),
      supabase.from('deposit_requests').select('id, transaction_id, status, notes').in('id', depositIds),
    ]);
    const pmap = new Map<string, { name: string; phone: string }>();
    (profiles ?? []).forEach((p: any) => pmap.set(p.id, { name: p.full_name ?? 'Unknown', phone: p.phone ?? '' }));
    const dmap = new Map<string, { tid: string | null; status: string; notes: string | null }>();
    (deposits ?? []).forEach((d: any) => dmap.set(d.id, {
      tid: d.transaction_id ?? null,
      status: d.status,
      notes: (d.notes as string | null) ?? null,
    }));
    // Drop matches whose deposit is no longer pending (race with another operator).
    return raw
      .filter((m) => dmap.get(m.deposit_request_id)?.status === 'pending')
      .map((m) => ({
        ...m,
        depositor_name: m.depositor_full_name ?? pmap.get(m.user_id)?.name,
        depositor_phone: pmap.get(m.user_id)?.phone,
        deposit_tid: dmap.get(m.deposit_request_id)?.tid ?? null,
        auto_created_from_email: /Auto-created from mobile-money confirmation email/i.test(
          dmap.get(m.deposit_request_id)?.notes ?? '',
        ),
      }));
  }, []);

  const runMatch = useCallback(async (silent = false) => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setError(null);
    try {
      const { data, error: rpcErr } = await (supabase.rpc as any)('auto_match_email_deposits', {
        p_amount_tolerance: 0,
        p_window_hours: 168,
      });
      if (rpcErr) throw rpcErr;
      const hydrated = await hydrate((data as Match[]) ?? []);

      // ── Auto-approve high-confidence matches ───────────────────────────
      // A pending deposit whose Gmail transaction matched by exact TID or
      // by amount + ≥2 corroborating signals (amount_strong) is approved
      // immediately so the depositor sees their balance update without
      // waiting for an operator. Weak amount-only matches still require
      // manual confirmation below.
      const autoEligible = hydrated.filter(
        (m) =>
          (m.method === 'tid' || m.method === 'amount_strong') &&
          !autoApprovedRef.current.has(m.deposit_request_id),
      );
      let autoApprovedCount = 0;
      if (autoEligible.length > 0) {
        try {
          const { data: session } = await supabase.auth.getSession();
          const token = session?.session?.access_token;
          // Group by matcher method so each auto-approval batch carries
          // the correct method into approve-deposit (drives the depositor's
          // notification + transactional email metadata).
          const byMethod = new Map<string, string[]>();
          for (const m of autoEligible) {
            const k = m.method;
            if (!byMethod.has(k)) byMethod.set(k, []);
            byMethod.get(k)!.push(m.deposit_request_id);
          }
          for (const [method, ids] of byMethod) {
            const { error: invErr } = await supabase.functions.invoke('approve-deposit', {
              body: {
                bulk_ids: ids,
                action: 'approve',
                access_token: token,
                auto_approved: true,
                auto_match_method: method,
              },
            });
            if (invErr) throw invErr;
          }
          autoApprovedCount = autoEligible.length;
          autoEligible.forEach((m) => autoApprovedRef.current.add(m.deposit_request_id));
          await Promise.all(
            autoEligible.map((m) =>
              writeAudit({
                gmail_transaction_id: m.gmail_transaction_id,
                deposit_request_id: m.deposit_request_id,
                action: 'bulk_approve',
                matcher_type: `auto_${m.method}`,
                match_score: m.match_score ?? null,
                signals: m.signals ?? null,
                amount: m.amount,
                notes: `Auto-approved by email matcher (${m.method}) — ${fmtUgx(m.amount)}`,
              }),
            ),
          );
        } catch (autoErr: any) {
          console.warn('[auto-match] auto-approve batch failed', autoErr);
        }
      }

      const remaining = hydrated.filter(
        (m) => !autoApprovedRef.current.has(m.deposit_request_id),
      );
      setMatches(remaining);
      setLastRunAt(new Date());

      if (!silent && autoApprovedCount > 0) {
        toast({
          title: `Auto-approved ${autoApprovedCount} deposit${autoApprovedCount === 1 ? '' : 's'}`,
          description: 'High-confidence email matches were credited instantly.',
        });
      }
      if (!silent && remaining.length > 0) {
        toast({
          title: `Auto-matched ${remaining.length} deposit${remaining.length === 1 ? '' : 's'}`,
          description: 'Review and approve the matches below.',
        });
      } else if (!silent && autoApprovedCount === 0 && remaining.length === 0) {
        toast({ title: 'No new matches', description: 'No pending deposits could be paired with email transactions.' });
      }
    } catch (e: any) {
      console.warn('[auto-match] failed', e);
      setError(e?.message ?? 'Auto-match failed');
      if (!silent) toast({ title: 'Auto-match failed', description: e?.message ?? 'Unknown error', variant: 'destructive' });
    } finally {
      setRunning(false);
      runningRef.current = false;
    }
  }, [hydrate, toast]);

  // Initial run + periodic re-poll.
  useEffect(() => {
    runMatch(true);
    if (!autoRefresh) return;
    const id = setInterval(() => runMatch(true), 30_000);
    return () => clearInterval(id);
  }, [autoRefresh, runMatch]);

  const approveOne = useCallback(async (m: Match) => {
    setApproving((prev) => new Set(prev).add(m.deposit_request_id));
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;
      const { error: invErr } = await supabase.functions.invoke('approve-deposit', {
        body: {
          deposit_request_id: m.deposit_request_id,
          action: 'approve',
          access_token: token,
        },
      });
      if (invErr) throw invErr;
      toast({ title: 'Deposit approved', description: `${fmtUgx(m.amount)} credited to ${m.depositor_name ?? 'depositor'}.` });
      await writeAudit({
        gmail_transaction_id: m.gmail_transaction_id,
        deposit_request_id: m.deposit_request_id,
        action: 'approve',
        matcher_type: m.method,
        match_score: m.match_score ?? null,
        signals: m.signals ?? null,
        amount: m.amount,
        notes: `Operator approved ${m.method} match (${fmtUgx(m.amount)})`,
      });
      setMatches((prev) => prev.filter((x) => x.deposit_request_id !== m.deposit_request_id));
    } catch (e: any) {
      toast({ title: 'Approve failed', description: e?.message ?? 'Unknown error', variant: 'destructive' });
    } finally {
      setApproving((prev) => {
        const next = new Set(prev);
        next.delete(m.deposit_request_id);
        return next;
      });
    }
  }, [toast]);

  const tidMatches = useMemo(() => matches.filter((m) => m.method === 'tid'), [matches]);
  const strongMatches = useMemo(() => matches.filter((m) => m.method === 'amount_strong'), [matches]);
  const amountMatches = useMemo(() => matches.filter((m) => m.method === 'amount'), [matches]);

  const approveAllTid = useCallback(async () => {
    if (tidMatches.length === 0) return;
    setBulkApproving(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;
      const { error: invErr } = await supabase.functions.invoke('approve-deposit', {
        body: {
          bulk_ids: tidMatches.map((m) => m.deposit_request_id),
          action: 'approve',
          access_token: token,
        },
      });
      if (invErr) throw invErr;
      toast({
        title: `Approved ${tidMatches.length} deposit${tidMatches.length === 1 ? '' : 's'}`,
        description: 'All exact-TID email matches credited.',
      });
      await Promise.all(tidMatches.map((m) => writeAudit({
        gmail_transaction_id: m.gmail_transaction_id,
        deposit_request_id: m.deposit_request_id,
        action: 'bulk_approve',
        matcher_type: m.method,
        match_score: m.match_score ?? null,
        signals: m.signals ?? null,
        amount: m.amount,
        notes: `Bulk approved as part of ${tidMatches.length}-row TID batch`,
      })));
      const approvedIds = new Set(tidMatches.map((m) => m.deposit_request_id));
      setMatches((prev) => prev.filter((m) => !approvedIds.has(m.deposit_request_id)));
    } catch (e: any) {
      toast({ title: 'Bulk approve failed', description: e?.message ?? 'Unknown error', variant: 'destructive' });
    } finally {
      setBulkApproving(false);
    }
  }, [tidMatches, toast]);

  const skipMatch = useCallback(async (m: Match) => {
    // Unlink the gmail row so the operator can revisit. Does NOT affect the deposit_request.
    await (supabase.from('gmail_transactions') as any)
      .update({ linked_deposit_request_id: null, auto_matched_at: null, auto_match_method: null })
      .eq('id', m.gmail_transaction_id);
    await writeAudit({
      gmail_transaction_id: m.gmail_transaction_id,
      deposit_request_id: m.deposit_request_id,
      action: 'skip',
      matcher_type: m.method,
      match_score: m.match_score ?? null,
      signals: m.signals ?? null,
      amount: m.amount,
      notes: 'Operator skipped match — email returned to unmatched pool',
    });
    setMatches((prev) => prev.filter((x) => x.gmail_transaction_id !== m.gmail_transaction_id));
    toast({ title: 'Match skipped', description: 'The email is back in the unmatched pool.' });
  }, [toast]);

  // Manual "force retry last 24h" — re-runs the server-side rematch job over
  // the last 24h of unapproved Gmail rows and then immediately re-evaluates
  // matches so any high-confidence ones (TID / amount_strong) get auto-approved.
  const retryLast24h = useCallback(async () => {
    setRetrying24h(true);
    try {
      const { data: count, error: rpcErr } = await (supabase.rpc as any)(
        'run_email_auto_match_retry',
        { p_window_hours: 24 },
      );
      if (rpcErr) throw rpcErr;
      toast({
        title: 'Retry triggered',
        description: `Re-matched ${count ?? 0} email${count === 1 ? '' : 's'} from the last 24h. Auto-approving eligible matches…`,
      });
      await runMatch(false);
    } catch (e: any) {
      console.warn('[retry-24h] failed', e);
      toast({
        title: 'Retry failed',
        description: e?.message ?? 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setRetrying24h(false);
    }
  }, [runMatch, toast]);

  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <div className="p-4 border-b bg-gradient-to-r from-primary/5 to-transparent flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h3 className="font-semibold text-sm sm:text-base flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            Auto-detect from email transactions
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Pairs pending deposits with parsed Gmail confirmations using Transaction ID, amount, sender email, payer name, depositor phone, and reference text (7-day window).
          </p>
          {lastRunAt && (
            <p className="text-[10px] text-muted-foreground mt-1">
              Last scan: {format(lastRunAt, 'HH:mm:ss')} · auto-rescans every 30s
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {tidMatches.length > 0 && (
            <Button
              onClick={approveAllTid}
              disabled={bulkApproving || running}
              className="gap-2"
            >
              {bulkApproving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              Approve {tidMatches.length} TID match{tidMatches.length === 1 ? '' : 'es'}
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={retryLast24h}
            disabled={retrying24h || running}
            className="gap-2"
            title="Re-run the auto-matcher over the last 24h of unapproved emails and auto-approve high-confidence matches"
          >
            {retrying24h ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Retry last 24h
          </Button>
          <Button variant="outline" onClick={() => runMatch(false)} disabled={running} className="gap-2">
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Rescan
          </Button>
        </div>
      </div>

      {/* Plain-language guide rail — sits right under the bulk actions so a
          new operator can read it once and understand the whole panel. */}
      <div className="px-3 sm:px-4 py-2 border-b bg-muted/30 text-[11px] text-muted-foreground leading-snug">
        <span className="font-semibold text-foreground">Tip:</span>{' '}
        <span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-emerald-600" /> Exact TID</span> is safe to approve.{' '}
        <span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-sky-600" /> Verified match</span> is usually safe.{' '}
        <span className="inline-flex items-center gap-1"><AlertCircle className="h-3 w-3 text-amber-600" /> Amount only</span> — open the details and double-check before approving.
      </div>

      {error && (
        <div className="p-3 text-xs text-destructive bg-destructive/5 border-b border-destructive/20 flex items-center gap-2">
          <AlertCircle className="h-3.5 w-3.5" /> {error}
        </div>
      )}

      {matches.length === 0 ? (
        <div className="p-6 text-center text-sm text-muted-foreground">
          <Mail className="h-8 w-8 mx-auto mb-2 text-muted-foreground/40" />
          {running ? 'Scanning emails…' : 'No matches right now. New emails are rescanned automatically every 30 seconds.'}
        </div>
      ) : (
        <ul className="divide-y">
          {[...tidMatches, ...strongMatches, ...amountMatches].map((m) => {
            const isApproving = approving.has(m.deposit_request_id);
            const badgeClass =
              m.method === 'tid'
                ? 'bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/15 border-emerald-500/30'
                : m.method === 'amount_strong'
                  ? 'bg-sky-500/15 text-sky-700 hover:bg-sky-500/15 border-sky-500/30'
                  : 'bg-amber-500/15 text-amber-700 hover:bg-amber-500/15 border-amber-500/30';
            const signalLabels: Record<string, string> = {
              amount: 'Amount',
              name: 'Payer name',
              phone: 'Phone',
              sender: 'Sender email',
              reference: 'Reference',
            };
            const extraSignals = (m.signals ?? []).filter((s) => s !== 'amount');
            const isOpen = expanded.has(m.gmail_transaction_id);
            const reasonText =
              m.method === 'tid'
                ? 'Email Transaction ID exactly matches the deposit Transaction ID.'
                : m.method === 'amount_strong'
                  ? `Amount matches plus ${extraSignals.length} verified signal${extraSignals.length === 1 ? '' : 's'}: ${extraSignals.join(', ')}.`
                  : 'Amount matches uniquely in the time window. No other signals could be confirmed — review carefully.';
            return (
              <li key={m.gmail_transaction_id} className="p-3 sm:p-4 space-y-2">
                <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge className={badgeClass}>
                      {m.method === 'tid' && (<><CheckCircle2 className="h-3 w-3 mr-1" /> Exact TID</>)}
                      {m.method === 'amount_strong' && (<><CheckCircle2 className="h-3 w-3 mr-1" /> Verified match</>)}
                      {m.method === 'amount' && (<><AlertCircle className="h-3 w-3 mr-1" /> Amount only</>)}
                    </Badge>
                    <span className="font-semibold text-sm">{fmtUgx(m.amount)}</span>
                    {m.provider && (
                      <span className="text-[11px] text-muted-foreground uppercase">{m.provider}</span>
                    )}
                    {extraSignals.map((s) => (
                      <Badge key={s} variant="outline" className="text-[10px] py-0 px-1.5 font-normal">
                        ✓ {signalLabels[s] ?? s}
                      </Badge>
                    ))}
                    {m.auto_created_from_email && (
                      <Badge
                        className="bg-violet-500/15 text-violet-700 hover:bg-violet-500/15 border-violet-500/30 text-[10px] py-0 px-1.5 font-medium"
                        title="This pending deposit was created automatically from the Gmail confirmation because the depositor had not submitted a request in-app. It will be auto-approved on the next matcher scan (every 30s)."
                      >
                        <Bot className="h-3 w-3 mr-1" /> Auto-created from email
                      </Badge>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    <span className="font-medium text-foreground">{m.depositor_name ?? 'Unknown'}</span>
                    {m.depositor_phone && <> · {m.depositor_phone}</>}
                    {m.counterparty && <> ← {m.counterparty}</>}
                  </div>
                  <div className="text-[11px] text-muted-foreground font-mono truncate">
                    Deposit TID: {m.deposit_tid ?? '—'}
                    {m.matched_transaction_id && m.method === 'tid' && ' ✓ '}
                    {m.method !== 'tid' && m.matched_transaction_id && (
                      <> · Email TID: {m.matched_transaction_id}</>
                    )}
                    {m.internal_date && <> · {format(new Date(m.internal_date), 'dd MMM HH:mm')}</>}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => skipMatch(m)}
                    disabled={isApproving || bulkApproving}
                    title="Don't credit this deposit yet. The email returns to the unmatched pool for another scan."
                  >
                    Skip
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => approveOne(m)}
                    disabled={isApproving || bulkApproving}
                    className="gap-1.5"
                    title="Credit the matched wallet and mark this deposit as approved. This cannot be undone."
                  >
                    {isApproving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                    Approve
                  </Button>
                </div>
                </div>

                {/* One-line action prompt — visible on every row so operators
                    never have to guess what the buttons do. */}
                <p className="text-[11px] text-muted-foreground leading-snug">
                  {m.method === 'tid' ? (
                    <>Tap <span className="font-semibold text-foreground">Approve</span> to credit {fmtUgx(m.amount)} to {m.depositor_name ?? 'this user'}. The TIDs match exactly.</>
                  ) : m.method === 'amount_strong' ? (
                    <>Tap <span className="font-semibold text-foreground">Approve</span> if the depositor and amount look right. Tap <span className="font-semibold text-foreground">Skip</span> if you're not sure.</>
                  ) : (
                    <><span className="text-amber-700 font-semibold">Read carefully.</span> Only the amount matches — confirm the depositor before tapping <span className="font-semibold text-foreground">Approve</span>, otherwise tap <span className="font-semibold text-foreground">Skip</span>.</>
                  )}
                </p>

                <button
                  type="button"
                  onClick={() => setExpanded((prev) => {
                    const next = new Set(prev);
                    if (next.has(m.gmail_transaction_id)) next.delete(m.gmail_transaction_id);
                    else next.add(m.gmail_transaction_id);
                    return next;
                  })}
                  className="text-[11px] text-primary hover:underline inline-flex items-center gap-1"
                >
                  {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  Why this matched
                </button>

                {isOpen && (
                  <div className="rounded-md border bg-muted/30 p-3 text-xs space-y-2">
                    <div className="text-foreground">{reasonText}</div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Extracted from email</div>
                        <Field label="Sender" value={m.from_email} highlight={extraSignals.includes('sender')} />
                        <Field label="Sender name" value={m.from_name} />
                        <Field label="Counterparty" value={m.counterparty} highlight={extraSignals.includes('name') || extraSignals.includes('phone')} />
                        <Field label="Amount" value={fmtUgx(m.amount)} highlight />
                        <Field label="Email TID" value={m.matched_transaction_id} highlight={m.method === 'tid'} mono />
                        <Field label="Received" value={m.internal_date ? format(new Date(m.internal_date), 'dd MMM yyyy HH:mm') : null} />
                        <Field label="Subject" value={m.subject} />
                        {m.snippet && (
                          <div className="text-muted-foreground italic line-clamp-2">"{m.snippet}"</div>
                        )}
                      </div>
                      <div className="space-y-1">
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Depositor on file</div>
                        <Field label="Name" value={m.depositor_name} highlight={extraSignals.includes('name')} />
                        <Field label="Phone" value={m.depositor_phone} highlight={extraSignals.includes('phone')} />
                        <Field label="Email" value={m.depositor_email} highlight={extraSignals.includes('sender')} />
                        <Field label="Deposit TID" value={m.deposit_tid} highlight={m.method === 'tid' || extraSignals.includes('reference')} mono />
                        <Field label="Amount requested" value={fmtUgx(m.amount)} highlight />
                      </div>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Field({ label, value, highlight, mono }: { label: string; value?: string | null; highlight?: boolean; mono?: boolean }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-muted-foreground min-w-[90px] shrink-0">{label}</span>
      <span className={`${mono ? 'font-mono' : ''} ${highlight ? 'text-emerald-700 font-semibold' : 'text-foreground'} break-all`}>
        {value && value.length > 0 ? value : '—'}
      </span>
    </div>
  );
}
