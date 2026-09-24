import "../_shared/smsFooterInterceptor.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logSystemEvent } from "../_shared/eventLogger.ts";
import { checkTreasuryGuard } from "../_shared/treasuryGuard.ts";
import { logDepositDecision } from "../_shared/depositDecisionAudit.ts";
import { attemptYoolaPrimary } from "../_shared/yoolaPrimary.ts";
import { resolveOwnedRecipientEmail } from "../_shared/ownedRecipientEmail.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Server-side retry helper for transient RPC failures ──
// Large deposits (10M / 15M) trigger the most complex paths in this
// function (deposit ledger → rent repayment → debt clearance → prepay
// → commission credits). These paths each issue several Postgres RPCs
// and any one of them can flake on a transient connection drop or a
// brief 5xx from the database pooler, causing the whole approval to
// 500 even though the wallet was already credited.
//
// We wrap each RPC in a small bounded retry with structured logging
// so we (a) surface exactly which sub-step failed and (b) recover
// from transient flakes automatically. We deliberately do NOT retry
// the wallet_deposit credit itself here — that one is protected by
// the idempotency guard at the top of the loop and re-attempted by
// the client retry layer in TidVerification.tsx.
async function withRetry<T>(
  label: string,
  depositId: string,
  fn: () => PromiseLike<{ data?: T; error: any } | { error: any }>,
  maxAttempts = 3,
): Promise<{ data?: T; error: any; attempts: number; ms: number }> {
  let lastErr: any = null;
  const t0 = Date.now();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const stepStart = Date.now();
    try {
      const res: any = await fn();
      const stepMs = Date.now() - stepStart;
      if (!res?.error) {
        if (attempt > 1) {
          console.log(
            `[approve-deposit] ${label} succeeded on attempt ${attempt}/${maxAttempts} ` +
            `(deposit=${depositId}, step_ms=${stepMs}, total_ms=${Date.now() - t0})`,
          );
        }
        return { data: res.data, error: null, attempts: attempt, ms: Date.now() - t0 };
      }
      lastErr = res.error;
      const msg = String(res.error?.message ?? res.error ?? "");
      const code = String(res.error?.code ?? "");
      const isTransient =
        /timeout|fetch failed|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN|connection|temporarily|deadlock|serializ/i.test(msg) ||
        ["08006", "08001", "08004", "40001", "40P01", "57014", "57P01", "57P03"].includes(code);
      console.warn(
        `[approve-deposit] ${label} attempt ${attempt}/${maxAttempts} failed ` +
        `(deposit=${depositId}, step_ms=${stepMs}, transient=${isTransient}, code=${code}): ${msg}`,
      );
      if (!isTransient || attempt === maxAttempts) break;
      await new Promise((r) => setTimeout(r, 250 * attempt));
    } catch (thrown: any) {
      lastErr = thrown;
      const msg = String(thrown?.message ?? thrown);
      console.warn(
        `[approve-deposit] ${label} attempt ${attempt}/${maxAttempts} threw ` +
        `(deposit=${depositId}): ${msg}`,
      );
      if (attempt === maxAttempts) break;
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
  }
  return { data: undefined, error: lastErr, attempts: maxAttempts, ms: Date.now() - t0 };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Admin client is created up-front so the deposit-decision audit trail can
    // record EVERY rejection/block — including the early validation returns
    // below — not just the ones that happen after the main flow starts.
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json().catch(() => ({}));
    const { deposit_request_id, action, rejection_reason, bulk_ids, access_token, auto_approved, auto_match_method, system_auto_credit } = body as {
      deposit_request_id?: string;
      action?: string;
      rejection_reason?: string;
      bulk_ids?: string[];
      access_token?: string;
      auto_approved?: boolean;
      auto_match_method?: string;
      system_auto_credit?: boolean;
    };

    const authHeader = req.headers.get("Authorization")
      || (typeof access_token === 'string' && access_token.length > 0 ? `Bearer ${access_token}` : null);
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── System auto-credit branch ──────────────────────────────────
    // The Gmail poller can auto-credit an operational-float deposit on
    // behalf of a known user the moment a MoMo receipt is parsed. It calls
    // us with `Authorization: Bearer <service_role_key>` and
    // `system_auto_credit:true`. We impersonate the deposit OWNER so the
    // existing eligibleAutoApprove + gmail re-verification path runs
    // unchanged. No human user is involved in this call.
    const isSystemAutoCredit =
      !!system_auto_credit && authHeader === `Bearer ${supabaseServiceKey}`;

    let user: { id: string } | null = null;
    let actorEmail: string | null = null;
    if (!isSystemAutoCredit) {
      const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user: authUser }, error: userError } = await supabaseUser.auth.getUser();
      if (userError || !authUser) {
        return new Response(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      user = { id: authUser.id };
      actorEmail = authUser.email ?? null;
    } else {
      actorEmail = "system_auto_credit";
    }

    if (!action || !["approve", "reject", "reopen"].includes(action)) {
      return new Response(
        JSON.stringify({ error: "Invalid action. Must be 'approve', 'reject', or 'reopen'" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    let idsToProcess: string[] = [];
    if (bulk_ids && Array.isArray(bulk_ids)) {
      if (bulk_ids.length > 100) {
        return new Response(
          JSON.stringify({ error: "Cannot process more than 100 deposits at once" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      idsToProcess = bulk_ids.filter(id => typeof id === 'string' && UUID_REGEX.test(id));
    } else if (deposit_request_id && typeof deposit_request_id === 'string' && UUID_REGEX.test(deposit_request_id)) {
      idsToProcess = [deposit_request_id];
    }

    if (idsToProcess.length === 0) {
      return new Response(
        JSON.stringify({ error: "No valid deposit IDs provided" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const safeRejectionReason = typeof rejection_reason === 'string' ? rejection_reason.trim().slice(0, 1000) : undefined;

    // Audit requirement: rejecting a deposit MUST be accompanied by a clear
    // operator-written reason (≥10 chars) so reconciliation, the user
    // notification SMS, and the audit_logs entry all carry traceable context.
    // This was previously only enforced in the UI; an API caller could
    // bypass it. The reason is also stamped onto deposit_requests.rejection_reason
    // and broadcast in the user notification — never accept a blank.
    if (action === 'reject' && (!safeRejectionReason || safeRejectionReason.length < 10)) {
      await logDepositDecision(supabaseAdmin, {
        source: "approval",
        decision: "blocked",
        reason: "rejection_reason_required",
        actor_id: user?.id ?? null,
        actor_email: actorEmail,
        metadata: { ids: idsToProcess, action },
      });
      return new Response(
        JSON.stringify({
          error: 'rejection_reason_required',
          message: 'A rejection reason of at least 10 characters is required for auditing.',
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── Reopen flow ──────────────────────────────────────────────────
    // Financial Ops can put a previously-rejected user deposit back into
    // the `pending` queue so the TID search / User Deposits tab surfaces
    // it again for re-review and possible approval. Manager-only — the
    // same role that can approve/reject in the first place.
    if (action === 'reopen') {
      if (!user) {
        return new Response(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
      const { data: isMgr } = await supabaseAdmin
        .from('user_roles')
        .select('role')
        .eq('user_id', user.id)
        .eq('role', 'manager')
        .maybeSingle();
      if (!isMgr) {
        return new Response(
          JSON.stringify({ error: 'Only managers can reopen rejected deposits' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
      const { data: rejected, error: rejErr } = await supabaseAdmin
        .from('deposit_requests')
        .select('id, status, user_id, amount, deposit_purpose, transaction_id')
        .in('id', idsToProcess)
        .eq('status', 'rejected');
      if (rejErr || !rejected || rejected.length === 0) {
        return new Response(
          JSON.stringify({ error: 'No rejected deposit requests found to reopen' }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
      const reopenNote = (typeof rejection_reason === 'string' ? rejection_reason : '').trim().slice(0, 1000);
      const reopened: Array<{ id: string; user_id: string; amount: number }> = [];
      for (const r of rejected) {
        const { error: updErr } = await supabaseAdmin
          .from('deposit_requests')
          .update({
            status: 'pending',
            rejection_reason: null,
            rejected_at: null,
            processed_by: null,
          })
          .eq('id', r.id)
          .eq('status', 'rejected');
        if (updErr) {
          console.error('[approve-deposit] reopen update failed', r.id, updErr);
          continue;
        }
        await supabaseAdmin.from('audit_logs').insert({
          user_id: user.id,
          action_type: 'deposit_request_reopened',
          table_name: 'deposit_requests',
          record_id: r.id,
          metadata: {
            previous_status: 'rejected',
            new_status: 'pending',
            reason: reopenNote || 'Reopened for re-review',
            deposit_purpose: (r as any).deposit_purpose ?? null,
            amount: Number(r.amount),
            tid: (r as any).transaction_id ?? null,
            target_user_id: r.user_id,
          },
        });
        reopened.push({ id: r.id, user_id: r.user_id, amount: Number(r.amount) });
      }
      return new Response(
        JSON.stringify({ success: true, action: 'reopened', count: reopened.length, results: reopened }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Treasury guard: block credits when paused (deposits credit user wallets)
    const guardBlock = await checkTreasuryGuard(supabaseAdmin, "credit", req.headers.get("Authorization"));
    if (guardBlock) return guardBlock;

    const { data: depositRequests, error: fetchError } = await supabaseAdmin
      .from("deposit_requests")
      .select("*")
      .in("id", idsToProcess)
      .eq("status", "pending");

    if (fetchError || !depositRequests || depositRequests.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          already_processed: true,
          message:
            "These deposit requests were already processed (likely by a concurrent click or another operator). Refresh to see the latest status.",
          processed: 0,
          total: idsToProcess.length,
          results: [],
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── FORTRESS: cash-code deposits can ONLY be approved after the depositor
    // entered the receipt code. Regardless of caller (manager, Financial-Ops
    // matcher auto-approve, auto_approved flag, or system auto-credit), every
    // provider='cash_deposit' row in this batch MUST have a matching
    // `cash_deposit_verifications` row with status='verified'. The legit
    // cash-deposit-verify-code flow stamps status='verified' BEFORE invoking us,
    // so it passes; any other path (e.g. an email auto-match) is blocked here.
    if (action === "approve") {
      const cashDeposits = depositRequests.filter(
        (d) => String(d.provider || "").toLowerCase() === "cash_deposit",
      );
      if (cashDeposits.length > 0) {
        const cashIds = cashDeposits.map((d) => d.id);
        const { data: vers, error: verErr } = await supabaseAdmin
          .from("cash_deposit_verifications")
          .select("deposit_request_id, status")
          .in("deposit_request_id", cashIds);
        if (verErr) {
          return new Response(
            JSON.stringify({ error: "verification_lookup_failed", message: verErr.message }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        const verifiedSet = new Set(
          (vers ?? [])
            .filter((v) => String((v as any).status) === "verified")
            .map((v) => (v as any).deposit_request_id),
        );
        const unverified = cashDeposits.filter((d) => !verifiedSet.has(d.id));
        if (unverified.length > 0) {
          for (const d of unverified) {
            await logDepositDecision(supabaseAdmin, {
              source: "approval",
              decision: "blocked",
              reason: "cash_code_required",
              deposit_request_id: d.id,
              amount: Number(d.amount),
              actor_id: user?.id ?? null,
              actor_email: actorEmail,
              metadata: {
                provider: d.provider ?? null,
                auto_approved: !!auto_approved,
                system_auto_credit: isSystemAutoCredit,
                auto_match_method: auto_match_method ?? null,
              },
            });
          }
          return new Response(
            JSON.stringify({
              error: "cash_code_required",
              message:
                "Cash deposits can only be credited after the depositor enters the receipt code. This deposit has not been code-verified.",
              unverified_ids: unverified.map((d) => d.id),
            }),
            { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }
    }

    // For system auto-credit, impersonate the deposit owner now that we
    // know who it is. All rows in a single call must belong to the same
    // owner — refuse otherwise.
    if (isSystemAutoCredit) {
      const ownerId = depositRequests[0].user_id;
      if (!depositRequests.every((d) => d.user_id === ownerId)) {
        return new Response(
          JSON.stringify({ error: 'system_auto_credit: mixed owners not allowed' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
      user = { id: ownerId };
    }
    if (!user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const { data: isManagerRole } = isSystemAutoCredit
      ? { data: null }
      : await supabaseAdmin
          .from("user_roles")
          .select("role")
          .eq("user_id", user.id)
          .eq("role", "manager")
          .maybeSingle();

    const { data: processorProfile } = await supabaseAdmin
      .from("profiles")
      .select("full_name")
      .eq("id", user.id)
      .maybeSingle();
    const processorName = isSystemAutoCredit
      ? 'System Auto-Credit'
      : (processorProfile?.full_name || "Manager");

    // ── Cash-deposit system credit bypass ───────────────────────────────
    // The cash-deposit-verify-code function calls us with the service-role
    // key + system_auto_credit:true AFTER it has hashed + matched the
    // depositor's receipt code, enforced expiry/attempt limits, and atomically
    // claimed the verification row. The code check IS the authorization, so we
    // skip the MoMo gmail re-verification / agent-ownership gate below — but
    // ONLY for genuine cash deposits (every row provider='cash_deposit',
    // pending) approved via the trusted service-role path. Any other provider
    // still falls through to the existing checks.
    const eligibleCashSystemCredit =
      isSystemAutoCredit &&
      action === 'approve' &&
      depositRequests.every(
        (d) =>
          String(d.provider || '').toLowerCase() === 'cash_deposit' &&
          String(d.status) === 'pending',
      );

    if (!isManagerRole && !eligibleCashSystemCredit) {
      // ── Auto-approve path (MoMo gmail match) ──────────────────────────
      // A regular user (typically an agent) can self-approve their OWN
      // pending deposit IF and ONLY IF:
      //   • the request body carries `auto_approved:true` + action `approve`
      //   • they are the deposit's `user_id` (owner)
      //   • provider is MTN ('mtn') or Airtel ('airtel') — bank refs still
      //     require a human reviewer
      //   • server-side we can re-prove a parsed `gmail_transactions` row
      //     exists, was linked to THIS deposit by `try_link_gmail_for_deposit`,
      //     direction='in'/'credit', amount matches, normalized TID matches,
      //     and the receipt is at most 7 days old.
      // This bypass leans on `gmail_transactions` being service-role-write
      // only — the client cannot fabricate a match.
      const ownerOnly = depositRequests.every(
        (d) => d.user_id === user.id || d.agent_id === user.id,
      );
      const eligibleAutoApprove =
        action === 'approve' &&
        !!auto_approved &&
        ownerOnly &&
        depositRequests.every(
          (d) =>
            d.user_id === user.id &&
            ['mtn', 'airtel'].includes(String(d.provider || '').toLowerCase()) &&
            String(d.status) === 'pending',
        );

      if (eligibleAutoApprove) {
        // Re-verify each row has a real linked Gmail receipt that proves
        // provider+TID+amount match. We never trust the client flag alone.
        let allVerified = true;
        for (const dep of depositRequests) {
          const normDigits = String(dep.transaction_id || '').replace(/[^0-9]/g, '');
          if (!normDigits) { allVerified = false; break; }
          const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
          // Company→merchant FLOAT DELIVERY is proven by an OUTBOUND
          // ("sent to") company SMS, so the linked gmail row has
          // direction='out'/'debit'. Only the trusted service-role
          // system_auto_credit caller may present those; interactive
          // self-approvals still require an inbound receipt.
          const allowedDirections = isSystemAutoCredit
            ? ['in', 'credit', 'out', 'debit']
            : ['in', 'credit'];
          const { data: gmailMatch } = await supabaseAdmin
            .from('gmail_transactions')
            .select('id, amount, transaction_id, direction, internal_date')
            .eq('linked_deposit_request_id', dep.id)
            .eq('parsed', true)
            .in('direction', allowedDirections)
            .gte('internal_date', sevenDaysAgo)
            .limit(1)
            .maybeSingle();
          if (!gmailMatch) { allVerified = false; break; }
          const gDigits = String(gmailMatch.transaction_id || '').replace(/[^0-9]/g, '');
          if (gDigits !== normDigits) { allVerified = false; break; }
          if (Number(gmailMatch.amount) !== Number(dep.amount)) { allVerified = false; break; }
        }
        if (!allVerified) {
          for (const d of depositRequests) {
            await logDepositDecision(supabaseAdmin, {
              source: "approval",
              decision: "blocked",
              reason: "auto_approve_unverified",
              deposit_request_id: d.id,
              amount: Number(d.amount),
              actor_id: user?.id ?? null,
              actor_email: actorEmail,
              metadata: { provider: d.provider ?? null, transaction_id: d.transaction_id ?? null },
            });
          }
          return new Response(
            JSON.stringify({
              error: 'auto_approve_unverified',
              message:
                'No matching mobile-money receipt could be re-verified server-side. Submission still goes to Financial Ops review.',
            }),
            { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
          );
        }
        // ✅ Owner + verified gmail match. Allow the approval to proceed.
      } else {
      const unauthorized = depositRequests.filter(d => d.agent_id !== user.id);
      if (unauthorized.length > 0) {
        for (const d of unauthorized) {
          await logDepositDecision(supabaseAdmin, {
            source: "approval",
            decision: "blocked",
            reason: "not_authorized",
            deposit_request_id: d.id,
            amount: Number(d.amount),
            actor_id: user?.id ?? null,
            actor_email: actorEmail,
            metadata: { action },
          });
        }
        return new Response(
          JSON.stringify({ error: "Not authorized to process some requests" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      }
    }

    const results: Array<{ id: string; status: string; amount: number; user_id: string; repayment_applied?: number; debt_cleared?: number; days_prepaid?: number }> = [];

    for (const depositRequest of depositRequests) {
      const depositStartedAt = Date.now();
      const isLargeDeposit = Number(depositRequest.amount) >= 10_000_000;
      // ── Purpose → ledger-category mapping (single source of truth) ──
      // The ledger category drives wallet routing via wallet_route_for_category:
      //   - 'agent_float_deposit' → wallets.float_balance
      //   - 'wallet_deposit'      → wallets.withdrawable_balance
      // The UI collects deposit_purpose; the edge function (here) chooses
      // the category. Wallet buckets are NEVER computed in the UI or written
      // directly — the routing trigger + apply_wallet_movement own that.
      const rawPurpose = (depositRequest.deposit_purpose || '').toString().trim().toLowerCase();

      // ── Cash-deposit-code channel detection ──────────────────────────
      // A deposit went through the SMS receipt-code flow (finops-cash-
      // deposit-initiate / cash-deposit-request-code → cash-deposit-verify-
      // code) iff it has a matching cash_deposit_verifications row. Hoisted
      // here (moved up from the physical-cash-channel block below) so the
      // routing decision immediately below can be scoped to this channel.
      const providerKey = (depositRequest.provider || '').toString().trim().toLowerCase();
      let hasCashReceipt = false;
      try {
        const { count: receiptCount } = await supabaseAdmin
          .from('cash_deposit_verifications')
          .select('id', { count: 'exact', head: true })
          .eq('deposit_request_id', depositRequest.id);
        hasCashReceipt = (receiptCount ?? 0) > 0;
      } catch (_receiptErr) {
        hasCashReceipt = false;
      }

      // ── FLOAT-BY-DEFAULT ROUTING (2026-07-28) ───────────────────────
      // Product decision: every incoming deposit routes to the FLOAT
      // bucket by default. Only an explicit `personal_deposit` purpose
      // routes to withdrawable. Missing/unknown purposes → float.
      const KNOWN_PURPOSES = new Set([
        'operational_float',
        'personal_deposit',
        'partnership_deposit',
        'personal_rent_repayment',
        'other',
      ]);
      if (rawPurpose && !KNOWN_PURPOSES.has(rawPurpose)) {
        console.warn(
          `[approve-deposit] Unknown deposit_purpose='${rawPurpose}' for ${depositRequest.id}; defaulting to float.`,
        );
      }
      // RESTORED 2026-09-07, SCOPED TO CASH-DEPOSIT-CODE FUNDS ONLY: a
      // 2026-07-29 change ("FLOAT-ALWAYS") briefly forced every deposit to
      // float regardless of purpose, which silently misrouted cash-deposit-
      // code "Personal Deposit" credits away from withdrawable for ~5.5
      // weeks (surfaced by the Constance Racheal Kateme case). Only deposits
      // that actually went through the receipt-code flow (hasCashReceipt)
      // AND are tagged personal_deposit now route to withdrawable — a
      // `personal_deposit`-tagged deposit arriving through any other path
      // (e.g. the public API, with no code verification) still defaults to
      // float, same as before this fix.
      const isFloatDeposit = !(hasCashReceipt && rawPurpose === 'personal_deposit');
      const depositCategory: 'agent_float_deposit' | 'wallet_deposit' =
        isFloatDeposit ? 'agent_float_deposit' : 'wallet_deposit';
      const depositBucket: 'float' | 'withdrawable' =
        isFloatDeposit ? 'float' : 'withdrawable';
      if (isLargeDeposit) {
        console.log(
          `[approve-deposit] LARGE deposit start id=${depositRequest.id} ` +
          `amount=${depositRequest.amount} user=${depositRequest.user_id} action=${action} ` +
          `purpose=${rawPurpose || 'none'} category=${depositCategory}`,
        );
      }
      try {
        if (action === "approve") {
          // ── Idempotency guard ────────────────────────────────────────
          // The wallet-credit ledger RPC and the `status='approved'` UPDATE
          // are TWO separate writes. If the UPDATE silently fails (RLS,
          // trigger reject without raising, race), the row stays 'pending'
          // and the operator re-clicks Approve → ledger credits AGAIN.
          //
          // We've seen this in production (LUKODDA JOSEPH, 2026-04-27 —
          // single deposit credited 3×). Refuse to re-credit if a
          // wallet_deposit ledger entry for this deposit already exists.
          {
            const { count: existingCredits, error: existingErr } =
              await supabaseAdmin
                .from('general_ledger')
                .select('id', { count: 'exact', head: true })
                .eq('source_table', 'deposit_requests')
                .eq('source_id', depositRequest.id)
                .in('category', ['wallet_deposit', 'agent_float_deposit'])
                .eq('direction', 'cash_in')
                .eq('ledger_scope', 'wallet');

            if (!existingErr && (existingCredits ?? 0) > 0) {
              // Wallet was already credited on a prior call — just reconcile
              // the request status (which clearly didn't stick last time)
              // and return success without touching the ledger.
              console.warn(
                `[approve-deposit] Idempotent re-approve for ${depositRequest.id} — ` +
                `${existingCredits} existing wallet_deposit credit(s); skipping ledger RPC.`,
              );

              const { data: reconRows, error: reconErr } = await supabaseAdmin
                .from('deposit_requests')
                .update({
                  status: 'approved',
                  approved_at:
                    depositRequest.approved_at || new Date().toISOString(),
                  processed_by: depositRequest.processed_by || user.id,
                })
                .eq('id', depositRequest.id)
                .eq('status', 'pending')
                .select('id');

              await supabaseAdmin.from('audit_logs').insert({
                user_id: user.id,
                action_type: 'approve_idempotent_skip',
                table_name: 'deposit_requests',
                record_id: depositRequest.id,
                metadata: {
                  amount: depositRequest.amount,
                  target_user_id: depositRequest.user_id,
                  existing_wallet_credits: existingCredits,
                  reconcile_update_rows: reconRows?.length ?? 0,
                  reconcile_update_error: reconErr?.message ?? null,
                  transaction_id: depositRequest.transaction_id ?? null,
                },
              });

              results.push({
                id: depositRequest.id,
                status: 'approved',
                amount: depositRequest.amount,
                user_id: depositRequest.user_id,
              });
              continue;
            }
          }

          // Ensure wallet row exists. The wallet bucket is NOT credited by any
          // trigger (sync_wallet_from_ledger has been a permanent no-op since
          // 2026-04-23 — see Wallet sole-writer rule). The actual bucket credit
          // happens via the explicit apply_wallet_movement RPC call below, AFTER
          // the ledger post + status flip succeed.
          //
          // We intentionally do NOT mark the request 'approved' yet — only after
          // the wallet-deposit ledger RPC succeeds. This prevents a "phantom-
          // approved" request with no corresponding wallet credit if the RPC fails.
          await supabaseAdmin
            .from("wallets")
            .upsert({ user_id: depositRequest.user_id, balance: 0, updated_at: new Date().toISOString() }, { onConflict: "user_id", ignoreDuplicates: true });

          // ── Ledger-first deposit credit (balanced double-entry) ──
          // CRITICAL: `recipient_type` is the SOLE bucket router (Wallet Routing v2).
          // Without it on the wallet leg, `wallet_bucket` stays NULL and the
          // downstream `wallet_balances_projection` treats the money as
          // withdrawable — silently redirecting agents' float deposits into
          // their withdrawable bucket. Set it on the wallet leg to match the
          // deposit purpose.
          const depositRecipientType: 'user' | 'operational_wallet' =
            isFloatDeposit ? 'operational_wallet' : 'user';
          // ── Physical cash channel (Financial Ops cash deposits) ──────────
          // A cash deposit is NOT a bank movement: the money is physically in
          // the office until it is banked. For those deposits we add a second
          // balanced pair that (a) debits A5 Cash in Transit against the
          // custody payable (L1) and (b) reverses the A2 "float with agents"
          // debit produced by the wallet leg — the cash is with the company,
          // not with the agent. `fin_ops_set_cash_location('bank')` later moves
          // A5 → A1/Treasury. Mobile money / bank / agent-cash deposits keep
          // their existing accounting untouched.
          // `providerKey` / `hasCashReceipt` are computed once, up at the top
          // of this loop iteration (they now also gate the withdrawable
          // routing decision above).
          // A deposit is a PHYSICAL CASH RECEIPT when either the provider says so
          // or the receipt-code (cash_deposit_verifications) path produced it.
          // Relying on the provider string alone let genuine receipt-path cash
          // deposits fall through to the mobile-money accounting, which posts a
          // platform `agent_float_deposit` cash_out leg (an A1 CREDIT) — making
          // "Money We Have" DECREASE on a cash intake instead of increase.
          const isPhysicalCashChannel =
            providerKey === 'cash_deposit' ||
            providerKey === 'cash' ||
            providerKey === 'office_cash' ||
            hasCashReceipt;
          // Exactly-one-A5-entry guard: never post a second cash_receipt_in_transit
          // leg for the same deposit (idempotency on re-approval / retries).
          let hasTransitLeg = false;
          if (isPhysicalCashChannel) {
            const { count: transitCount } = await supabaseAdmin
              .from('general_ledger')
              .select('id', { count: 'exact', head: true })
              .eq('source_table', 'deposit_requests')
              .eq('source_id', depositRequest.id)
              .eq('category', 'cash_receipt_in_transit')
              .eq('direction', 'cash_in');
            hasTransitLeg = (transitCount ?? 0) > 0;
          }
          // Physical cash routed to WITHDRAWABLE needs NO platform offset leg.
          // `agent_float_cash_offset` exists only to cancel the DR A2 that a
          // FLOAT deposit's wallet leg posts. When the wallet leg is instead
          // `wallet_deposit` (CR L1), that A2 credit has no matching debit, and
          // `cash_custody_payable` becomes a second credit for the obligation the
          // wallet leg already recorded. Result: DR A5 / CR A2 / CR L1 / CR L1,
          // out by 2x on every such deposit (37 groups, UGX 333,255,000 before
          // this fix). The wallet leg became purpose-aware on 2026-09-07; the
          // platform legs were not updated with it.
          // Correct entry for physical cash + personal_deposit is DR A5 / CR L1.
          const needsPlatformOffset = !isPhysicalCashChannel || isFloatDeposit;

          const depositEntries: Record<string, unknown>[] = [
              {
                user_id: depositRequest.user_id,
                amount: depositRequest.amount,
                direction: 'cash_in',
                category: depositCategory,
                ledger_scope: 'wallet',
                recipient_type: depositRecipientType,
                wallet_bucket: isFloatDeposit ? 'float' : 'withdrawable',
                source_table: 'deposit_requests',
                source_id: depositRequest.id,
                reference_id: depositRequest.transaction_id || depositRequest.id,
                description: isFloatDeposit
                  ? `Operational float deposit via ${depositRequest.provider || 'mobile money'}`
                  : `Wallet deposit via ${depositRequest.provider || 'mobile money'}`,
                currency: 'UGX',
                transaction_date: new Date().toISOString(),
              },
              ...(needsPlatformOffset
                ? [{
                    direction: 'cash_out',
                    amount: depositRequest.amount,
                    category: isPhysicalCashChannel ? 'agent_float_cash_offset' : depositCategory,
                    ledger_scope: 'platform',
                    source_table: 'deposit_requests',
                    source_id: depositRequest.id,
                    description: isPhysicalCashChannel
                      ? 'Offset: physical cash is held by the company, not with the agent'
                      : isFloatDeposit
                      ? 'Platform: float deposit credited to agent float bucket'
                      : 'Platform liability: deposit credited to user wallet',
                    currency: 'UGX',
                    transaction_date: new Date().toISOString(),
                  }]
                : []),
          ];

          if (isPhysicalCashChannel && !hasTransitLeg) {
            depositEntries.push(
              {
                direction: 'cash_in',
                amount: depositRequest.amount,
                category: 'cash_receipt_in_transit',
                ledger_scope: 'platform',
                source_table: 'deposit_requests',
                source_id: depositRequest.id,
                reference_id: depositRequest.transaction_id || depositRequest.id,
                description: 'Cash received by Financial Ops — held as cash in transit',
                currency: 'UGX',
                transaction_date: new Date().toISOString(),
              },
            );
            // Custody obligation belongs to the FLOAT variant only. For a
            // withdrawable (personal) deposit the wallet leg above is already
            // the L1 credit for this obligation; posting this leg too records
            // the same custody twice. See needsPlatformOffset above.
            if (isFloatDeposit) {
              depositEntries.push(
                {
                  direction: 'cash_out',
                  amount: depositRequest.amount,
                  category: 'cash_custody_payable',
                  ledger_scope: 'platform',
                  source_table: 'deposit_requests',
                  source_id: depositRequest.id,
                  reference_id: depositRequest.transaction_id || depositRequest.id,
                  description: 'Custody obligation for physical cash received, not yet banked',
                  currency: 'UGX',
                  transaction_date: new Date().toISOString(),
                },
              );
            }
          }

          const { error: depositLedgerErr } = await supabaseAdmin.rpc('create_ledger_transaction', {
            entries: depositEntries,
          });

          if (depositLedgerErr) {
            console.error(`[approve-deposit] Deposit ledger entry failed for ${depositRequest.id}:`, depositLedgerErr.message);
            // Phantom-approved guard: keep the request out of 'approved' state and
            // mark it 'failed' with a reason so ops can retry rather than the user
            // seeing an "approved" deposit they never received.
            await supabaseAdmin
              .from("deposit_requests")
              .update({
                status: "failed",
                rejection_reason: `Ledger credit failed: ${depositLedgerErr.message?.slice(0, 500) || 'unknown error'}`,
                processed_by: user.id,
              })
              .eq("id", depositRequest.id);

            // Audit trail — schema-correct insert (audit_logs has: user_id,
            // action_type, table_name, record_id, metadata). All contextual
            // detail (old/new state, reason) lives in metadata.
            await supabaseAdmin.from("audit_logs").insert({
              user_id: user.id,
              action_type: "approve_failed",
              table_name: "deposit_requests",
              record_id: depositRequest.id,
              metadata: {
                amount: depositRequest.amount,
                target_user_id: depositRequest.user_id,
                old_status: "pending",
                new_status: "failed",
                reason: `Wallet credit RPC failed: ${depositLedgerErr.message?.slice(0, 500) || 'unknown'}`,
                deposit_purpose: depositRequest.deposit_purpose ?? null,
                provider: depositRequest.provider ?? null,
                transaction_id: depositRequest.transaction_id ?? null,
              },
            });

            // Monitoring signal — emit deposit_failed so ops dashboards see
            // stuck deposits without scraping audit_logs.
            await logSystemEvent(
              supabaseAdmin,
              "deposit_failed",
              depositRequest.user_id,
              "deposit_requests",
              depositRequest.id,
              {
                amount: depositRequest.amount,
                processed_by: user.id,
                rpc: "create_ledger_transaction",
                error: depositLedgerErr.message?.slice(0, 500) || "unknown",
                provider: depositRequest.provider ?? null,
                transaction_id: depositRequest.transaction_id ?? null,
                deposit_purpose: depositRequest.deposit_purpose ?? null,
              },
            );

            throw new Error(`Deposit ledger entry failed: ${depositLedgerErr.message}`);
          }

          // ✅ Ledger credit confirmed — NOW mark the request approved.
          // CRITICAL: capture the result and verify a row was actually
          // updated. A silent failure here (RLS, trigger, race) is what
          // caused the LUKODDA JOSEPH 3× double-credit incident — the
          // ledger fired but the row stayed 'pending', so the operator
          // re-clicked and re-credited.
          const { data: updatedRows, error: updateErr } = await supabaseAdmin
            .from('deposit_requests')
            .update({
              status: 'approved',
              approved_at: new Date().toISOString(),
              processed_by: user.id,
            })
            .eq('id', depositRequest.id)
            .eq('status', 'pending')
            .select('id');

          if (updateErr || !updatedRows || updatedRows.length === 0) {
            // The wallet was credited but the request couldn't be marked
            // approved. Surface this loudly so ops can intervene before
            // anyone re-clicks Approve. The idempotency guard above will
            // prevent a double-credit on retry, but we still need a hard
            // signal.
            const errMsg =
              updateErr?.message
              || 'deposit_requests UPDATE returned 0 rows (RLS or status race)';
            console.error(
              `[approve-deposit] CRITICAL: wallet credited but status update failed for ${depositRequest.id}: ${errMsg}`,
            );
            await supabaseAdmin.from('audit_logs').insert({
              user_id: user.id,
              action_type: 'approve_status_update_failed',
              table_name: 'deposit_requests',
              record_id: depositRequest.id,
              metadata: {
                amount: depositRequest.amount,
                target_user_id: depositRequest.user_id,
                error: errMsg,
                wallet_already_credited: true,
                transaction_id: depositRequest.transaction_id ?? null,
              },
            });
            throw new Error(
              `Wallet credited but failed to mark deposit approved: ${errMsg}`,
            );
          }

          // ── PERMANENT WALLET BUCKET CREDIT ───────────────────────────
          // The ledger has the truth; the wallet cache must now be moved.
          // `apply_wallet_movement` is the SOLE writer of wallet buckets
          // (Wallet sole-writer rule, 2026-04-23). `recipient_type` is the
          // SOLE bucket router (Wallet Routing v2):
          //   'operational_wallet' → wallets.float_balance
          //   'user'               → wallets.withdrawable_balance
          // Without this call, ledger and wallet drift forever — that is
          // the bug that left agent float deposits ledger-only / wallet-zero
          // since the sync trigger was retired.
          const recipientType: 'user' | 'operational_wallet' =
            isFloatDeposit ? 'operational_wallet' : 'user';
          const { error: walletWriterErr } = await withRetry(
            'apply_wallet_movement',
            depositRequest.id,
            () => supabaseAdmin.rpc('apply_wallet_movement', {
              p_user_id: depositRequest.user_id,
              p_category: depositCategory,
              p_amount: depositRequest.amount,
              p_direction: 'cash_in',
              p_recipient_type: recipientType,
            }),
          );
          if (walletWriterErr) {
            // Ledger is already posted and the request is already approved.
            // Do NOT roll those back — double-entry stays the source of truth.
            // Surface loudly: audit + system_event so CFO drift monitors
            // (phantom_wallet_drift cron, wallet_withdrawable_drift_alerts)
            // pick this up and the operator gets a hard signal.
            console.error(
              `[approve-deposit] CRITICAL: apply_wallet_movement failed for ${depositRequest.id} ` +
              `(ledger already posted, request already approved): ${walletWriterErr.message}`,
            );
            await supabaseAdmin.from('audit_logs').insert({
              user_id: user.id,
              action_type: 'approve_wallet_writer_failed',
              table_name: 'deposit_requests',
              record_id: depositRequest.id,
              metadata: {
                amount: depositRequest.amount,
                target_user_id: depositRequest.user_id,
                category: depositCategory,
                recipient_type: recipientType,
                error: String(walletWriterErr.message ?? walletWriterErr).slice(0, 500),
                ledger_already_posted: true,
                request_already_approved: true,
              },
            });
            await logSystemEvent(
              supabaseAdmin,
              'wallet.writer_failed',
              depositRequest.user_id,
              'deposit_requests',
              depositRequest.id,
              {
                amount: depositRequest.amount,
                category: depositCategory,
                recipient_type: recipientType,
                error: String(walletWriterErr.message ?? walletWriterErr).slice(0, 500),
              },
            );
            throw new Error(
              `Deposit approved + ledger posted but wallet bucket credit failed: ${walletWriterErr.message}. ` +
              `Run reconciliation against v_user_wallet_strict.`,
            );
          }

          // NOTE: an earlier comment here claimed every deposit lands in
          // `withdrawable_balance` unconditionally and that `deposit_purpose`
          // was no longer read — that stopped being true once float-by-default
          // routing was introduced (2026-07-28) and stayed stale through the
          // 2026-07-29 FLOAT-ALWAYS change and its 2026-09-07 revert above.
          // `recipientType` below is purpose-derived via `isFloatDeposit`.

          // ── RETIRED: Auto-deduct rent / clear debt / pre-pay days ──
          // The auto-apply pipeline (rent repayment + subscription debt
          // clearance + day pre-payment) was retired 2026-07-28. It was
          // silently pulling large amounts (e.g. UGX 100,000) out of the
          // depositor's withdrawable wallet whenever a small deposit
          // (e.g. UGX 12,000) arrived, because `repaymentApplied` was
          // computed as `min(walletBalance, outstanding)` — decoupled
          // from the deposit amount. Rent repayment is now an explicit,
          // user-initiated action; the deposit lands in the wallet and
          // the user (or agent-collections flow) chooses when to apply it.
          const repaymentApplied = 0;
          const newOutstanding = 0;
          const debtCleared = 0;
          const daysPrepaid = 0;
          const prepaidAmount = 0;
          const newNextChargeDate: string | null = null;

          // ── Notification ──
          // Auto-apply retired: notes below are always empty; kept as
          // consts so the template strings compile unchanged.
          const repaymentNote = "";
          const debtNote = "";
          const prepaidNote = "";
          void newOutstanding; void newNextChargeDate;

          const notifTitle = isFloatDeposit
            ? "Float Deposit Approved! 🏘️"
            : "Deposit Approved! 💰";

          await supabaseAdmin.from("notifications").insert({
            user_id: depositRequest.user_id,
            title: auto_approved ? "Deposit Auto-Verified ⚡" : notifTitle,
            message: auto_approved
              ? `Your deposit of UGX ${depositRequest.amount.toLocaleString()} was automatically verified against the bank email${depositRequest.transaction_id ? ` (TID ${depositRequest.transaction_id})` : ''} and credited to your wallet.${repaymentNote}${debtNote}${prepaidNote}`
              : isFloatDeposit
              ? `Your operational float deposit of UGX ${depositRequest.amount.toLocaleString()} was approved by ${processorName} and credited to your Float bucket.`
              : `Your deposit of UGX ${depositRequest.amount.toLocaleString()} approved by ${processorName}.${repaymentNote}${debtNote}${prepaidNote}`,
            type: "success",
            metadata: {
              deposit_request_id: depositRequest.id,
              amount: depositRequest.amount,
              deposit_purpose: rawPurpose || null,
              ledger_category: depositCategory,
              wallet_bucket: depositBucket,
              repayment_applied: repaymentApplied,
              debt_cleared: debtCleared,
              days_prepaid: daysPrepaid,
              prepaid_amount: prepaidAmount,
              auto_approved: !!auto_approved,
              auto_match_method: auto_match_method ?? null,
            },
          });

          // ── Auto-approved: stamp flag + send branded receipt email ──
          // Triggered when the email auto-matcher (EmailAutoMatchPanel)
          // approves the deposit without operator review. The depositor
          // gets an instant in-app notification (above) AND a transactional
          // email with the credited amount and transaction reference.
          if (auto_approved) {
            try {
              await supabaseAdmin
                .from('deposit_requests')
                .update({ auto_approved: true })
                .eq('id', depositRequest.id);
            } catch (flagErr) {
              console.warn('[approve-deposit] auto_approved flag update failed:', flagErr);
            }

            try {
              const { data: depProfile } = await supabaseAdmin
                .from('profiles')
                .select('email, full_name, phone')
                .eq('id', depositRequest.user_id)
                .maybeSingle();
              // Ownership guard: `profiles.email` is not unique (agents often
              // register other people with their own gmail), so a deposit
              // receipt must only go to an address that provably belongs to
              // this user. Placeholder logins and shared addresses resolve to
              // null and the email is skipped (SMS still notifies).
              const rawEmail = (depProfile?.email ?? '').trim();
              const recipientEmail = await resolveOwnedRecipientEmail(
                supabaseAdmin,
                depositRequest.user_id,
                'approve-deposit',
              );

              // Pull the freshly-credited bucket balance so the user sees
              // it in both the SMS and email receipt.
              const { data: walletRow } = await supabaseAdmin
                .from('wallets')
                .select('withdrawable_balance, float_balance')
                .eq('user_id', depositRequest.user_id)
                .maybeSingle();
              const isFloat = depositBucket === 'float';
              const newBucketBalance = Number(
                isFloat
                  ? walletRow?.float_balance ?? 0
                  : walletRow?.withdrawable_balance ?? 0,
              );
              const firstName =
                (depProfile?.full_name ?? '').split(' ')[0] || 'there';
              const fmtUGX = (n: number) =>
                `UGX ${Math.round(Number(n) || 0).toLocaleString('en-UG')}`;
              const providerLabelShort = (depositRequest.provider || 'MOBILE MONEY')
                .toString()
                .toUpperCase();
              const txRef =
                depositRequest.transaction_id ||
                `DEP-${String(depositRequest.id).slice(0, 8).toUpperCase()}`;

              // ── SMS receipt (Africa's Talking) ─────────────────────
              if (depProfile?.phone) {
                const bucketLabel = isFloat
                  ? 'Operational Float'
                  : 'Wallet';
                // Last 4 digits of the credited phone so the user can verify
                // the deposit landed on the right MoMo number (important
                // when an account has multiple SIMs / proxy phones).
                const phoneDigits = String(depProfile.phone).replace(/\D/g, '');
                const phoneTail = phoneDigits.slice(-4) || '----';
                const smsMsg =
                  `Welile: Hi ${firstName}, ${fmtUGX(depositRequest.amount)} from ` +
                  `${providerLabelShort} (TID ${txRef}) was auto-credited to your ` +
                  `${bucketLabel} on phone •••${phoneTail}. New ${isFloat ? 'float' : 'wallet'} balance: ` +
                  `${fmtUGX(newBucketBalance)}.` +
                  `\n\nAccess your dashboard to view your wallet, transactions, and account details:\n` +
                  `https://welileapp.com/ZQhyGb`;
               await sendSmsViaAfricasTalking(depProfile.phone, smsMsg, {
                 admin: supabaseAdmin,
                 recipientUserId: depositRequest.user_id,
                 recipientName: depProfile?.full_name ?? null,
                 referenceId: String(depositRequest.id),
               });
              } else {
                console.warn(
                  `[approve-deposit] no phone for user ${depositRequest.user_id}; skipping auto-approval SMS`,
                );
              }

              if (recipientEmail) {
                const txRef =
                  depositRequest.transaction_id ||
                  `DEP-${String(depositRequest.id).slice(0, 8).toUpperCase()}`;
                const sourceLabel = (depositRequest.provider || 'email_match')
                  .toString()
                  .toUpperCase();
                // Use the float-specific receipt template when the deposit
                // was credited to the Operational Float bucket; otherwise
                // fall back to the generic wallet-deposit template.
                const templateName = isFloat
                  ? 'operational-float-credit'
                  : 'partner-wallet-deposit';
                const baseTemplateData: Record<string, unknown> = {
                  partner_name: depProfile?.full_name || 'Customer',
                  transaction_id: txRef,
                  amount: Number(depositRequest.amount) || 0,
                  currency: 'UGX',
                  date: new Date().toLocaleDateString('en-GB', {
                    day: '2-digit',
                    month: 'long',
                    year: 'numeric',
                  }),
                  source: isFloat
                    ? providerLabelShort === 'MTN'
                      ? 'MTN MoMo'
                      : providerLabelShort === 'AIRTEL'
                        ? 'Airtel Money'
                        : `Auto-verified · ${sourceLabel}`
                    : `Auto-verified · ${sourceLabel}`,
                };
                if (isFloat) {
                  baseTemplateData.new_float_balance = newBucketBalance;
                }
                const { error: emailErr } = await supabaseAdmin.functions.invoke(
                  'send-transactional-email',
                  {
                    body: {
                      templateName,
                      recipientEmail,
                      idempotencyKey: `auto-deposit-${depositRequest.id}`,
                      templateData: baseTemplateData,
                    },
                  },
                );
                if (emailErr) {
                  console.warn(
                    '[approve-deposit] auto-approval email send failed:',
                    emailErr,
                  );
                }
              } else {
                console.warn(
                  `[approve-deposit] no deliverable email for user ${depositRequest.user_id} (raw="${rawEmail}"); skipping auto-approval email`,
                );
              }
            } catch (mailErr) {
              console.warn('[approve-deposit] auto-approval email block threw:', mailErr);
            }
          }

          // Audit
          await supabaseAdmin.from("audit_logs").insert({
            action_type: "approve",
            table_name: "deposit_requests",
            record_id: depositRequest.id,
            performed_by: user.id,
            old_values: { status: "pending" },
            new_values: { status: "approved" },
            metadata: { amount: depositRequest.amount, repayment_applied: repaymentApplied, debt_cleared: debtCleared, days_prepaid: daysPrepaid, prepaid_amount: prepaidAmount },
          });

          results.push({ id: depositRequest.id, status: "approved", amount: depositRequest.amount, user_id: depositRequest.user_id, repayment_applied: repaymentApplied, debt_cleared: debtCleared, days_prepaid: daysPrepaid });
        } else {
          // Reject — safeRejectionReason is guaranteed non-empty (validated above).
          await supabaseAdmin
            .from("deposit_requests")
            .update({
              status: "rejected",
              rejected_at: new Date().toISOString(),
              rejection_reason: safeRejectionReason,
              processed_by: user.id,
            })
            .eq("id", depositRequest.id);

          await supabaseAdmin.from("notifications").insert({
            user_id: depositRequest.user_id,
            title: "Deposit Rejected ❌",
            message: `Your deposit of UGX ${depositRequest.amount.toLocaleString()} rejected by ${processorName}. Reason: ${safeRejectionReason}`,
            type: "warning",
            metadata: { deposit_request_id: depositRequest.id, amount: depositRequest.amount, reason: safeRejectionReason },
          });

          await supabaseAdmin.from("audit_logs").insert({
            action_type: "reject",
            table_name: "deposit_requests",
            record_id: depositRequest.id,
            performed_by: user.id,
            old_values: { status: "pending" },
            new_values: { status: "rejected" },
            reason: safeRejectionReason || "Rejected by manager",
            metadata: { amount: depositRequest.amount },
          });

          results.push({ id: depositRequest.id, status: "rejected", amount: depositRequest.amount, user_id: depositRequest.user_id });
        }
        if (isLargeDeposit) {
          console.log(
            `[approve-deposit] LARGE deposit done id=${depositRequest.id} ` +
            `amount=${depositRequest.amount} action=${action} total_ms=${Date.now() - depositStartedAt}`,
          );
        }
      } catch (innerErr) {
        console.error(
          `[approve-deposit] Error processing ${depositRequest.id} ` +
          `(amount=${depositRequest.amount}, total_ms=${Date.now() - depositStartedAt}):`,
          innerErr,
        );
        const alreadyCredited = action === 'approve'
          ? await supabaseAdmin
              .from('general_ledger')
              .select('id', { count: 'exact', head: true })
              .eq('source_table', 'deposit_requests')
              .eq('source_id', depositRequest.id)
              .in('category', ['wallet_deposit', 'agent_float_deposit'])
              .eq('direction', 'cash_in')
              .eq('ledger_scope', 'wallet')
          : { count: 0 };

        if (action === 'approve' && (alreadyCredited.count ?? 0) > 0) {
          await supabaseAdmin
            .from('deposit_requests')
            .update({
              status: 'approved',
              approved_at: depositRequest.approved_at || new Date().toISOString(),
              processed_by: depositRequest.processed_by || user.id,
            })
            .eq('id', depositRequest.id);
          results.push({ id: depositRequest.id, status: "approved", amount: depositRequest.amount, user_id: depositRequest.user_id });
        } else {
          results.push({ id: depositRequest.id, status: "error", amount: depositRequest.amount, user_id: depositRequest.user_id });
        }
      }
    }

    console.log(`[approve-deposit] ${processorName} ${action}d ${results.filter(r => r.status !== 'error').length}/${depositRequests.length} deposits`);

    // Log system events for each processed deposit
    for (const r of results) {
      if (r.status !== 'error') {
        logSystemEvent(supabaseAdmin, action === 'approve' ? 'deposit_approved' : 'deposit_rejected', user.id, 'deposit_requests', r.id, { amount: r.amount, user_id: r.user_id });
      }
    }

    // Deposit-decision audit trail — record the final outcome of every
    // processed deposit attempt (approved / rejected / failed) alongside
    // the block/reject reasons already logged above.
    for (const r of results) {
      await logDepositDecision(supabaseAdmin, {
        source: "approval",
        decision: r.status === "error" ? "failed" : r.status,
        reason:
          r.status === "rejected"
            ? (safeRejectionReason ?? "rejected")
            : r.status === "error"
              ? "processing_error"
              : null,
        deposit_request_id: r.id,
        amount: Number(r.amount),
        actor_id: user.id,
        actor_email: actorEmail,
        metadata: {
          action,
          target_user_id: r.user_id,
          auto_approved: !!auto_approved,
          system_auto_credit: isSystemAutoCredit,
          auto_match_method: auto_match_method ?? null,
          repayment_applied: (r as any).repayment_applied ?? null,
          debt_cleared: (r as any).debt_cleared ?? null,
          days_prepaid: (r as any).days_prepaid ?? null,
        },
      });
    }


    // Notify managers (fire-and-forget)
    fetch(`${supabaseUrl}/functions/v1/notify-managers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${supabaseServiceKey}` },
      body: JSON.stringify({ title: "💰 Deposit Processed", body: "Activity: deposit", url: "/dashboard/manager" }),
    }).catch(() => {});

    // Push notification to each approved user (fire-and-forget)
    for (const r of results) {
      if (r.status === "approved") {
        fetch(`${supabaseUrl}/functions/v1/send-push-notification`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${supabaseServiceKey}` },
          body: JSON.stringify({
            userIds: [r.user_id],
            payload: { title: "✅ Deposit Approved", body: `Your deposit of UGX ${r.amount.toLocaleString()} has been approved`, url: "/dashboard/agent", type: "success" },
          }),
        }).catch(() => {});
      }
    }


    const failedCount = results.filter(r => r.status === 'error').length;

    return new Response(
      JSON.stringify({
        success: failedCount === 0,
        message: `${results.filter(r => r.status !== 'error').length} deposit(s) ${action}d`,
        results,
      }),
      { status: failedCount === 0 ? 200 : 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("Unexpected error:", errorMessage);
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

// ── SMS helper (Africa's Talking) ─────────────────────────────────────
// Mirrors the helper in gmail-poll-transactions so auto-approved deposits
// notify the user via SMS the moment funds land in their wallet bucket.
function formatPhoneIntl(phone: string): string {
  const d = String(phone || '').replace(/[^0-9]/g, '');
  if (d.startsWith('256')) return `+${d}`;
  if (d.startsWith('0')) return `+256${d.slice(1)}`;
  if (d.length === 9) return `+256${d}`;
  return `+${d}`;
}

async function sendSmsViaAfricasTalking(
  phone: string,
  message: string,
  logCtx?: {
    admin: any;
    recipientUserId?: string | null;
    recipientName?: string | null;
    referenceId?: string | null;
  },
): Promise<boolean> {
  if (await attemptYoolaPrimary(phone, message, { source: "approve-deposit" })) return true;
  const apiKey = Deno.env.get('AFRICASTALKING_API_KEY');
  const username = Deno.env.get('AFRICASTALKING_USERNAME');
  if (!apiKey || !username) {
    console.warn('[approve-deposit] AT credentials missing — skipping SMS');
    if (logCtx?.admin) {
      try {
        await logCtx.admin.from('sms_delivery_log').insert({
          recipient_phone: formatPhoneIntl(phone),
          recipient_user_id: logCtx.recipientUserId ?? null,
          recipient_name: logCtx.recipientName ?? null,
          message,
          status: 'failed',
          source: 'approve-deposit',
          reference_id: logCtx.referenceId ?? null,
          error: 'AT credentials missing',
        });
      } catch (_) { /* non-fatal */ }
    }
    return false;
  }
  const isSandbox = username.toLowerCase() === 'sandbox';
  const url = isSandbox
    ? 'https://api.sandbox.africastalking.com/version1/messaging'
    : 'https://api.africastalking.com/version1/messaging';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        apiKey,
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        username, from: "WELILE",
        to: formatPhoneIntl(phone),        message,
      }).toString(),
    });
    const txt = await res.text();
    let data: any = null;
    try { data = JSON.parse(txt); } catch { /* ignore */ }
    const recipients = data?.SMSMessageData?.Recipients ?? [];
    const ok = recipients.some(
      (r: any) => r.statusCode === 101 || r.statusCode === 100,
    );
    console.log(
      `[approve-deposit] SMS ${ok ? 'sent' : 'failed'} to ${formatPhoneIntl(phone)} (status ${res.status})`,
    );
    if (logCtx?.admin) {
      const recip = recipients[0] ?? {};
      try {
        await logCtx.admin.from('sms_delivery_log').insert({
          recipient_phone: formatPhoneIntl(phone),
          recipient_user_id: logCtx.recipientUserId ?? null,
          recipient_name: logCtx.recipientName ?? null,
          message,
          status: ok ? 'sent' : 'failed',
          source: 'approve-deposit',
          reference_id: logCtx.referenceId ?? null,
          provider_message_id: recip?.messageId ?? null,
          provider_response: data ?? { raw: txt.slice(0, 500) },
          cost: recip?.cost ?? null,
          error: ok ? null : (recip?.status ?? `HTTP ${res.status}`),
        });
      } catch (_) { /* non-fatal */ }
    }
    return ok;
  } catch (e) {
    console.warn('[approve-deposit] SMS send error:', e);
    if (logCtx?.admin) {
      try {
        await logCtx.admin.from('sms_delivery_log').insert({
          recipient_phone: formatPhoneIntl(phone),
          recipient_user_id: logCtx.recipientUserId ?? null,
          recipient_name: logCtx.recipientName ?? null,
          message,
          status: 'failed',
          source: 'approve-deposit',
          reference_id: logCtx.referenceId ?? null,
          error: String(e).slice(0, 500),
        });
      } catch (_) { /* non-fatal */ }
    }
    return false;
  }
}
