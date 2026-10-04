import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { resolvePayoutDebitTarget, logProxyFallbackAudit } from '../_shared/partnership-emails.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ─────────────────────────────────────────────────────────────────────────────
// One-time / on-demand backlog sweep.
//
// Finds previously parsed, OUTGOING payout emails (gmail_transactions) that have
// NO routing record at all in email_routing_history — i.e. emails that should
// have been auto-debited but were skipped (e.g. the old batch crashed before
// reaching them, or they predate the event-driven trigger) — and safely
// auto-debits each one against the recipient's wallet.
//
// "Safely" means:
//   • Idempotent: skips any gmail row that already has ANY routing record.
//   • Single-recipient: only debits when EXACTLY one profile matches (phone or
//     full name), never guesses.
//   • Strict balance gate: clamps the debit to the wallet's strict available
//     balance (drains to zero as a partial debit) so the ledger never blocks.
//   • Posts through cfo-direct-credit's system_auto_debit path.
//
// Returns a structured report listing every row and its outcome so Financial
// Ops can see exactly what happened.
// ─────────────────────────────────────────────────────────────────────────────

type Outcome =
  | 'debited'
  | 'partial'
  | 'skipped_no_recipient'
  | 'skipped_ambiguous'
  | 'skipped_no_balance'
  | 'skipped_already_routed'
  | 'skipped_withdrawal_settled'
  | 'error';

interface ReportRow {
  gmail_transaction_id: string;
  transaction_id: string | null;
  from_name: string | null;
  from_email: string | null;
  subject: string | null;
  counterparty: string | null;
  internal_date: string | null;
  amount: number;
  outcome: Outcome;
  match_method?: 'phone' | 'name' | null;
  target_user_id?: string | null;
  target_user_name?: string | null;
  debited_amount?: number | null;
  available_balance?: number | null;
  ledger_reference_id?: string | null;
  detail?: string | null;
  via_proxy?: boolean;
  proxy_for_name?: string | null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    // ── AuthZ: must be an authenticated finance/admin caller ──────────────
    const authHeader = req.headers.get('Authorization') ?? '';
    const token = authHeader.replace('Bearer ', '').trim();
    if (!token) {
      return json({ error: 'Missing authorization token' }, 401);
    }
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user?.id) {
      return json({ error: 'Invalid token' }, 401);
    }
    const callerId = userData.user.id;
    const { data: roleRows } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', callerId);
    const roles = (roleRows ?? []).map((r: any) => r.role);
    const allowed = ['cfo', 'financial_ops', 'admin', 'super_admin', 'manager'];
    if (!roles.some((r: string) => allowed.includes(r))) {
      return json({ error: 'Forbidden: finance role required' }, 403);
    }

    // ── Parameters ────────────────────────────────────────────────────────
    const body = await req.json().catch(() => ({}));
    const dryRun = body?.dry_run === true;
    const daysBack = Math.max(1, Math.min(90, Number(body?.days_back) || 30));
    const maxRows = Math.max(1, Math.min(500, Number(body?.max_rows) || 200));
    const cutoffIso = new Date(Date.now() - daysBack * 24 * 3600 * 1000).toISOString();

    // ── Candidate payout emails: parsed, outgoing, with a positive amount ─
    const { data: candidates, error: candErr } = await supabase
      .from('gmail_transactions')
      .select('id, gmail_message_id, from_name, from_email, subject, amount, transaction_id, direction, counterparty, internal_date')
      .eq('parsed', true)
      .eq('direction', 'out')
      .gt('amount', 0)
      .gte('internal_date', cutoffIso)
      .order('internal_date', { ascending: true })
      .limit(maxRows);
    if (candErr) throw candErr;

    const report: ReportRow[] = [];
    let debitedCount = 0;
    let partialCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    let totalDebited = 0;

    for (const row of candidates ?? []) {
      const base: ReportRow = {
        gmail_transaction_id: row.id as string,
        transaction_id: (row.transaction_id as string) ?? null,
        from_name: (row.from_name as string) ?? null,
        from_email: (row.from_email as string) ?? null,
        subject: (row.subject as string) ?? null,
        counterparty: (row.counterparty as string) ?? null,
        internal_date: (row.internal_date as string) ?? null,
        amount: Number(row.amount) || 0,
        outcome: 'error',
      };

      try {
        // Idempotency: skip rows that already have ANY routing record.
        const { data: existing } = await supabase
          .from('email_routing_history')
          .select('id')
          .eq('gmail_transaction_id', row.id)
          .limit(1)
          .maybeSingle();
        if (existing?.id) {
          report.push({ ...base, outcome: 'skipped_already_routed' });
          skippedCount++;
          continue;
        }

        // Double-debit guard: skip when a withdrawal request already consumed
        // this payout. The auto-approve flow (gmail-poll / EmailPayoutAutoMatch)
        // stamps the email's transaction id onto withdrawal_requests.fin_ops_reference
        // and ALREADY debits the recipient's wallet via approve-withdrawal.
        // Charging it again here would double-debit the same payout.
        const settledRefs = new Set<string>();
        if (row.transaction_id) settledRefs.add(String(row.transaction_id).trim().toUpperCase());
        if (row.gmail_message_id) settledRefs.add(`MOMO-${String(row.gmail_message_id).slice(0, 12)}`.toUpperCase());
        if (settledRefs.size > 0) {
          const { data: settledRows } = await supabase
            .from('withdrawal_requests')
            .select('id, status, fin_ops_reference')
            .in('fin_ops_reference', Array.from(settledRefs));
          const consumed = (settledRows ?? []).some(
            (r: any) => !['rejected', 'cancelled', 'failed', 'expired'].includes(String(r.status)),
          );
          if (consumed) {
            report.push({
              ...base,
              outcome: 'skipped_withdrawal_settled',
              detail: 'Payout already settled a withdrawal request — wallet already debited by approve-withdrawal.',
            });
            skippedCount++;
            continue;
          }
        }

        // Resolve the recipient from `counterparty` (phone for MoMo, name for bank).
        const cp = (row.counterparty ?? '').toString().trim();
        if (!cp) {
          report.push({ ...base, outcome: 'skipped_no_recipient', detail: 'No counterparty on email' });
          skippedCount++;
          continue;
        }

        let profile: { id: string; full_name: string | null; phone: string | null } | null = null;
        let matchMethod: 'phone' | 'name' = 'phone';
        let ambiguous = false;

        const phoneDigits = cp.replace(/[^0-9]/g, '');
        const looksLikePhone = /\d/.test(cp) && phoneDigits.length >= 9;

        if (looksLikePhone) {
          const last9 = phoneDigits.slice(-9);
          const { data } = await supabase
            .from('profiles')
            .select('id, full_name, phone')
            .or(`phone.ilike.%${last9},mobile_money_number.ilike.%${last9}`)
            .limit(2);
          if (data && data.length === 1 && data[0]?.id) {
            profile = data[0] as any;
            matchMethod = 'phone';
          } else if (data && data.length > 1) {
            ambiguous = true;
          }
        } else {
          const rawName = cp.replace(/\s+/g, ' ').trim();
          const tokens = rawName.split(' ').filter((t) => t.length > 1);
          if (/[A-Za-z]/.test(rawName) && tokens.length >= 2) {
            const { data: nameMatches } = await supabase
              .from('profiles')
              .select('id, full_name, phone')
              .ilike('full_name', rawName)
              .limit(2);
            if (nameMatches && nameMatches.length === 1 && nameMatches[0]?.id) {
              profile = nameMatches[0] as any;
              matchMethod = 'name';
            } else if (nameMatches && nameMatches.length > 1) {
              ambiguous = true;
            }
          }
        }

        if (ambiguous) {
          report.push({ ...base, outcome: 'skipped_ambiguous', detail: `Multiple profiles match "${cp}"` });
          skippedCount++;
          continue;
        }
        if (!profile?.id) {
          report.push({ ...base, outcome: 'skipped_no_recipient', detail: `No unique recipient for "${cp}"` });
          skippedCount++;
          continue;
        }

        // Resolve WHOSE wallet to debit (user, or managed-proxy fallback when
        // the matched user has insufficient balance). Strict balance gate.
        const target = await resolvePayoutDebitTarget(supabase, profile, base.amount);
        if (!target) {
          report.push({
            ...base,
            outcome: 'skipped_no_balance',
            match_method: matchMethod,
            target_user_id: profile.id,
            target_user_name: profile.full_name,
            available_balance: 0,
            detail: 'Neither the user nor any managed proxy has available balance',
          });
          skippedCount++;
          continue;
        }

        const debitTargetId = target.targetUserId;
        const debitName = target.targetName;
        const debitPhone = target.targetPhone;
        const debitAmt = target.debitAmount;
        const isPartial = target.isPartial;
        const viaProxy = target.viaProxy;
        const avail = target.available;

        if (dryRun) {
          report.push({
            ...base,
            outcome: isPartial ? 'partial' : 'debited',
            match_method: matchMethod,
            target_user_id: debitTargetId,
            target_user_name: debitName,
            available_balance: avail,
            debited_amount: debitAmt,
            via_proxy: viaProxy,
            proxy_for_name: target.proxyForName,
            detail: viaProxy
              ? `DRY RUN — would debit managed proxy for ${target.proxyForName ?? 'partner'}`
              : 'DRY RUN — not posted',
          });
          if (isPartial) partialCount++; else debitedCount++;
          continue;
        }

        const reason =
          `Backlog sweep auto-debit (${matchMethod} match) — outgoing payment email from ` +
          `${row.from_name || row.from_email || 'provider'}` +
          `${row.transaction_id ? ` TID ${row.transaction_id}` : ''} charged against ` +
          `${debitName}'s wallet` +
          `${viaProxy ? ` (managed proxy for ${target.proxyForName ?? 'partner'}, who had insufficient balance)` : ''}.` +
          `${isPartial ? ` Partial: ${debitAmt.toLocaleString()}/${base.amount.toLocaleString()} (wallet drained to zero).` : ''}`;

        // Post the debit via cfo-direct-credit system path.
        let referenceId: string | null = null;
        const res = await fetch(`${supabaseUrl}/functions/v1/cfo-direct-credit`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${serviceKey}`,
            'apikey': serviceKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            system_auto_debit: true,
            target_user_id: debitTargetId,
            amount: debitAmt,
            reason,
            operation: 'debit',
            wallet_category: 'wallet_transfer',
            platform_category: 'wallet_transfer',
            financial_impact: 'neutral',
            category_label: 'Email charge → Withdrawable (sweep)',
            recipient_type: 'user',
            sub_category: row.transaction_id ?? null,
            // Idempotency keys: guarantee at-most-once debit even if the
            // realtime poller races this sweep on the same email.
            // gmail_message_id is always present so no-TID emails are covered.
            gmail_transaction_id: row.id,
            gmail_message_id: row.gmail_message_id ?? null,
            email_tid: row.transaction_id ?? null,
          }),
        });
        const out = await res.json().catch(() => ({}));
        // A 409 means the realtime poller already debited this exact email for
        // this user — treat it as an idempotent skip, not an error.
        if (res.status === 409 || (out as any)?.reason === 'DUPLICATE_EMAIL_CREDIT') {
          report.push({
            ...base,
            outcome: 'skipped_already_routed',
            match_method: matchMethod,
            target_user_id: debitTargetId,
            target_user_name: debitName,
            available_balance: avail,
            via_proxy: viaProxy,
            proxy_for_name: target.proxyForName,
            detail: 'Already debited by realtime poller (idempotency guard).',
          });
          skippedCount++;
          continue;
        }
        if (!res.ok || (out as any)?.error) {
          report.push({
            ...base,
            outcome: 'error',
            match_method: matchMethod,
            target_user_id: debitTargetId,
            target_user_name: debitName,
            available_balance: avail,
            detail: `cfo-direct-credit failed (${res.status}): ${JSON.stringify(out).slice(0, 200)}`,
          });
          errorCount++;
          continue;
        }
        referenceId = (out as any)?.reference_id ?? null;

        // Record the routing so the panel reflects it and re-runs stay idempotent.
        await supabase.from('email_routing_history').insert({
          gmail_transaction_id: row.id,
          gmail_message_id: null,
          transaction_id: row.transaction_id ?? null,
          from_email: row.from_email,
          from_name: row.from_name,
          subject: row.subject,
          amount: debitAmt,
          route: 'withdrawable_debit',
          target_user_id: debitTargetId,
          target_user_name: debitName,
          target_user_phone: debitPhone,
          reason: `DEBIT (sweep, ${matchMethod}${viaProxy ? `, via managed proxy for ${target.proxyForName ?? 'partner'}` : ''}${isPartial ? `, partial ${debitAmt.toLocaleString()}/${base.amount.toLocaleString()}` : ''}): ${reason}`,
          ledger_reference_id: referenceId,
          routed_by: callerId,
          routed_by_name: 'Backlog Sweep',
          sms_sent: false,
          sms_error: null,
        });

        // Audit: user skipped (insufficient balance) → managed proxy debited.
        if (viaProxy && target.proxyForUserId) {
          await logProxyFallbackAudit(supabase, {
            actorId: callerId,
            source: 'backlog_sweep',
            gmailTransactionId: row.id ?? null,
            gmailMessageId: row.gmail_message_id ?? null,
            emailTid: row.transaction_id ?? null,
            skippedUserId: target.proxyForUserId,
            skippedUserName: target.proxyForName,
            proxyUserId: debitTargetId,
            proxyUserName: debitName,
            requestedAmount: base.amount,
            debitedAmount: debitAmt,
            isPartial,
            ledgerReferenceId: referenceId,
          });
        }

        report.push({
          ...base,
          outcome: isPartial ? 'partial' : 'debited',
          match_method: matchMethod,
          target_user_id: debitTargetId,
          target_user_name: debitName,
          available_balance: avail,
          debited_amount: debitAmt,
          ledger_reference_id: referenceId,
          via_proxy: viaProxy,
          proxy_for_name: target.proxyForName,
        });
        if (isPartial) partialCount++; else debitedCount++;
        totalDebited += debitAmt;
      } catch (e) {
        report.push({ ...base, outcome: 'error', detail: e instanceof Error ? e.message : String(e) });
        errorCount++;
      }
    }

    return json({
      ok: true,
      dry_run: dryRun,
      params: { days_back: daysBack, max_rows: maxRows, cutoff: cutoffIso },
      summary: {
        candidates: candidates?.length ?? 0,
        debited: debitedCount,
        partial: partialCount,
        skipped: skippedCount,
        errors: errorCount,
        total_debited: totalDebited,
      },
      report,
    }, 200);
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

function json(payload: unknown, status: number) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
