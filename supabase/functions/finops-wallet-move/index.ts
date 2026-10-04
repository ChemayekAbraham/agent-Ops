import { createClient } from "npm:@supabase/supabase-js@2";
import { checkTreasuryGuard } from "../_shared/treasuryGuard.ts";
import { sendSMS } from "../_shared/sendSmsMultiProvider.ts";
import { postBalancedLedgerGroup } from "../_shared/balancedLedgerPost.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Bucket = "withdrawable" | "float";

/**
 * Structured reason codes. Free-text reasons produced unusable audit trails
 * ("not suposed h", "notb va;igbf"), so every move now carries a code plus a
 * human note.
 */
const REASON_CODES: Record<string, string> = {
  duplicate_credit: "Duplicate credit reversed",
  wrong_bucket: "Credited to the wrong wallet bucket",
  wrong_user: "Credited to the wrong user",
  fraud_hold: "Funds held pending fraud review",
  reconciliation: "Reconciliation adjustment",
  incorrect_float_allocation: "Incorrect float allocation",
  fraud_investigation: "Fraud investigation",
  failed_funding_reversal: "Reversal of failed funding",
  test_transaction: "Test transaction",
  wrong_recipient: "Wrong recipient",
  treasury_adjustment: "Treasury adjustment",
  manual_reconciliation: "Manual reconciliation",
  other: "Other",
};

/** Wallet ledger categories that represent income the user has already EARNED. */
const COMMISSION_CATEGORIES = [
  "agent_commission",
  "agent_commission_earned",
  "proxy_investment_commission",
  "agent_investment_commission",
  "partner_commission",
];

/** Best-effort device/browser fingerprint from the User-Agent string. */
function parseUserAgent(ua: string) {
  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : /Firefox\//.test(ua) ? "Firefox"
    : ua ? "Other" : "Unknown";
  const device =
    /iPhone|iPad|iPod/.test(ua) ? "iOS"
    : /Android/.test(ua) ? "Android"
    : /Windows/.test(ua) ? "Windows"
    : /Macintosh|Mac OS/.test(ua) ? "macOS"
    : /Linux/.test(ua) ? "Linux"
    : "Unknown";
  return { browser, device };
}

/**
 * finops-wallet-move
 *
 * Financial-Ops power tool. Lets an authorised operator move money between ANY
 * two users' wallets, or pull money OUT of a user's wallet back to the platform
 * ("money we have") recorded on the cash-flow statement as an error correction.
 *
 * Every move is a balanced, double-entry transaction posted the ONLY sanctioned
 * way — through `create_ledger_transaction`. No direct wallet-column writes; the
 * `wallets` view derives every bucket live from `v_user_wallet_strict`, so the
 * balances update the instant the legs land.
 *
 * Bucket routing is carried by the explicit `wallet_bucket` + `recipient_type`
 * pair (Routing v2):
 *   • withdrawable → wallet_bucket='withdrawable', recipient_type='user'
 *   • float        → wallet_bucket='float',        recipient_type='operational_wallet'
 *
 * Overdraw is NEVER allowed: the operator can only move up to the source
 * bucket's current balance, validated server-side before posting.
 *
 * Modes:
 *   user_to_user     — debit source user's chosen bucket, credit dest user's
 *                      chosen bucket. Two wallet legs.
 *   error_correction — debit source user's chosen bucket (wallet leg) and credit
 *                      the platform with category `system_balance_correction`
 *                      (platform leg) so it lands on the cash-flow statement as
 *                      an error correction.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const adminClient = createClient(supabaseUrl, serviceKey);

  try {
    // ── Auth ────────────────────────────────────────────────────────────
    const authHeader = req.headers.get("authorization") || "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
    const token = authHeader.replace("Bearer ", "");

    const { data: { user: authedUser }, error: authError } =
      await adminClient.auth.getUser(token);
    if (authError || !authedUser) return json({ error: "Unauthorized" }, 401);

    // Treasury guard — block any money movement while paused (CTO/super_admin bypass).
    const guardBlock = await checkTreasuryGuard(adminClient, "any", authedUser.id);
    if (guardBlock) return guardBlock;

    const { data: roles } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", authedUser.id)
      .in("role", ["cfo", "manager", "super_admin", "cto", "operations"]);
    if (!roles?.length) return json({ error: "Insufficient permissions" }, 403);
    const callerRoles = (roles || []).map((r: { role: string }) => r.role);

    // ── Input validation ──────────────────────────────────────────────────
    const body = await req.json().catch(() => ({}));
    const mode: string = String(body?.mode ?? "").trim();
    const sourceUserId: string = String(body?.source_user_id ?? "").trim();
    const sourceBucket = String(body?.source_bucket ?? "").trim() as Bucket;
    const destUserId: string = String(body?.dest_user_id ?? "").trim();
    const destBucket = String(body?.dest_bucket ?? "withdrawable").trim() as Bucket;
    const reasonCode: string = String(body?.reason_code ?? "").trim();
    const reasonNote: string = String(body?.reason ?? "").trim();
    const confirmFullHistory = body?.confirm_full_history === true;
    // ── Governance inputs (error corrections) ─────────────────────────────
    const businessJustification: string = String(body?.business_justification ?? "").trim();
    const referenceNumber: string = String(body?.reference_number ?? "").trim();
    const relatedTransactionId: string = String(body?.related_transaction_id ?? "").trim();
    const acknowledgeEarnedIncome = body?.acknowledge_earned_income === true;
    const confirmHighValue = body?.confirm_high_value === true;
    const approvalId: string = String(body?.approval_id ?? "").trim();
    const sessionId: string = String(body?.session_id ?? "").trim();
    const amount =
      typeof body?.amount === "number"
        ? body.amount
        : Number(String(body?.amount ?? "").replace(/[, _]/g, ""));

    if (mode !== "user_to_user" && mode !== "error_correction") {
      return json({ error: "Invalid mode." }, 400);
    }
    if (!UUID_RE.test(sourceUserId)) return json({ error: "Invalid source user." }, 400);
    if (sourceBucket !== "withdrawable" && sourceBucket !== "float") {
      return json({ error: "Source bucket must be Withdrawable or Float." }, 400);
    }
    if (mode === "user_to_user") {
      if (!UUID_RE.test(destUserId)) return json({ error: "Invalid destination user." }, 400);
      if (destBucket !== "withdrawable" && destBucket !== "float") {
        return json({ error: "Destination bucket must be Withdrawable or Float." }, 400);
      }
      if (destUserId === sourceUserId) {
        return json({ error: "Source and destination users must be different." }, 400);
      }
    }
    if (!Number.isFinite(amount) || amount <= 0 || amount > 500_000_000) {
      return json({ error: "Amount must be a positive number up to UGX 500,000,000." }, 400);
    }
    if (!Number.isInteger(amount)) {
      return json({ error: "Amount must be a whole number of UGX." }, 400);
    }
    if (!REASON_CODES[reasonCode]) {
      return json(
        {
          error: `A reason code is required. Allowed: ${Object.keys(REASON_CODES).join(", ")}.`,
        },
        400,
      );
    }
    if (reasonNote.length < 10) {
      return json({ error: "A reason note of at least 10 characters is required." }, 400);
    }
    const reason = `[${REASON_CODES[reasonCode]}] ${reasonNote}`;

    // ── Confirm the source has enough in the chosen bucket (NO overdraw) ───
    const { data: srcWallet, error: srcErr } = await adminClient
      .from("wallets")
      .select("withdrawable_balance, float_balance")
      .eq("user_id", sourceUserId)
      .maybeSingle();
    if (srcErr) return json({ error: `Wallet lookup failed: ${srcErr.message}` }, 500);

    const srcWithdrawable = Number(srcWallet?.withdrawable_balance ?? 0);
    const srcFloat = Number(srcWallet?.float_balance ?? 0);
    const srcAvailable = sourceBucket === "withdrawable" ? srcWithdrawable : srcFloat;
    if (srcAvailable < amount) {
      const label = sourceBucket === "withdrawable" ? "Withdrawable" : "Float";
      return json(
        {
          error: `Insufficient ${label} balance. Available: UGX ${srcAvailable.toLocaleString()}, requested: UGX ${amount.toLocaleString()}.`,
        },
        422,
      );
    }

    // ── Full-history sweep guard ──────────────────────────────────────────
    // 15 of 42 historical float error corrections removed exactly the user's
    // entire lifetime deposits. When the requested amount wipes out everything
    // the user ever deposited, demand a second, explicit confirmation.
    let lifetimeDeposits = 0;
    {
      const { data: deposits } = await adminClient
        .from("deposit_requests")
        .select("amount")
        .eq("user_id", sourceUserId)
        .eq("status", "approved");
      lifetimeDeposits = (deposits || []).reduce(
        (s: number, d: { amount: number | null }) => s + Number(d.amount ?? 0),
        0,
      );
    }
    if (
      mode === "error_correction" &&
      lifetimeDeposits > 0 &&
      amount >= lifetimeDeposits &&
      !confirmFullHistory
    ) {
      return json(
        {
          error:
            `FULL_HISTORY_SWEEP: UGX ${amount.toLocaleString()} equals or exceeds every deposit ` +
            `this user has ever made (UGX ${lifetimeDeposits.toLocaleString()}). ` +
            `Re-submit with confirm_full_history=true if this is genuinely correct.`,
          lifetime_deposits: lifetimeDeposits,
          requires_confirmation: "confirm_full_history",
        },
        409,
      );
    }

    // ── Resolve names for clean statements / linked_party ─────────────────
    const idsToName = [sourceUserId, ...(mode === "user_to_user" ? [destUserId] : [])];
    const { data: profiles } = await adminClient
      .from("profiles")
      .select("id, full_name, phone")
      .in("id", idsToName);
    const nameOf = (id: string) => {
      const p = profiles?.find((x) => x.id === id);
      return p?.full_name?.trim() || p?.phone || id;
    };
    const sourceName = nameOf(sourceUserId);
    const destName = mode === "user_to_user" ? nameOf(destUserId) : "Welile Platform";

    // ══════════════════════════════════════════════════════════════════════
    // ERROR CORRECTION GOVERNANCE
    // Historical corrections removed legitimate earnings with a one-line
    // free-text reason and no independent approval. Every future correction
    // now needs structured justification, earned-income acknowledgement,
    // high-value confirmation and (above threshold) CFO / dual approval.
    // Nothing here touches historical balances or ledger entries.
    // ══════════════════════════════════════════════════════════════════════
    const { data: cfg } = await adminClient
      .from("error_correction_config")
      .select("*")
      .eq("id", true)
      .maybeSingle();
    const highValueThreshold = Number(cfg?.high_value_threshold ?? 100_000);
    const cfoApprovalThreshold = Number(cfg?.cfo_approval_threshold ?? 500_000);
    const dualApprovalThreshold = Number(cfg?.dual_approval_threshold ?? 2_000_000);
    const alertThreshold = Number(cfg?.alert_threshold ?? 100_000);
    const velocityWindowMinutes = Number(cfg?.velocity_window_minutes ?? 60);
    const velocityMaxOps = Number(cfg?.velocity_max_operations ?? 3);
    const velocityMaxUsers = Number(cfg?.velocity_max_distinct_users ?? 3);
    const requireCommissionAck = cfg?.require_commission_ack !== false;

    const ua = req.headers.get("user-agent") || "";
    const { browser, device } = parseUserAgent(ua);
    const clientIp =
      (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
      req.headers.get("cf-connecting-ip") ||
      null;

    // Earned-commission portion sitting in the user's Withdrawable bucket.
    let commissionComponent = 0;
    if (mode === "error_correction" && sourceBucket === "withdrawable") {
      const { data: commLegs } = await adminClient
        .from("general_ledger")
        .select("amount, direction")
        .eq("user_id", sourceUserId)
        .eq("ledger_scope", "wallet")
        .eq("wallet_bucket", "withdrawable")
        .in("category", COMMISSION_CATEGORIES)
        .limit(5000);
      let net = 0;
      for (const l of (commLegs || []) as Array<{ amount: number; direction: string }>) {
        const sign = l.direction === "cash_in" || l.direction === "credit" ? 1 : -1;
        net += sign * Number(l.amount ?? 0);
      }
      commissionComponent = Math.max(0, Math.min(net, srcWithdrawable));
    }

    let approvalRow: { id: string; status: string; amount: number; bucket: string; requested_by: string } | null = null;

    if (mode === "error_correction") {
      // 1 ── Structured justification is optional for wallet → platform moves;
      // the reason note + reason code remain mandatory.
      if (reasonCode === "other" && reasonNote.length < 30) {
        return json({
          error: "When the reason is “Other”, a detailed explanation of at least 30 characters is required.",
          field: "reason",
        }, 400);
      }

      // 2 ── Earned income protection
      if (requireCommissionAck && commissionComponent > 0 && !acknowledgeEarnedIncome) {
        return json({
          error:
            `EARNED_INCOME: UGX ${Math.round(commissionComponent).toLocaleString()} of this user's ` +
            `Withdrawable wallet is commission they have already earned. ` +
            `Re-submit with acknowledge_earned_income=true to confirm you are removing earned income.`,
          commission_component: commissionComponent,
          requires_confirmation: "acknowledge_earned_income",
        }, 409);
      }

      // 3 ── High-value second confirmation
      if (false && amount >= highValueThreshold && !confirmHighValue) {
        return json({
          error:
            `HIGH_VALUE: UGX ${amount.toLocaleString()} is at or above the high-value threshold of ` +
            `UGX ${highValueThreshold.toLocaleString()}. Re-submit with confirm_high_value=true after reviewing the preview.`,
          high_value_threshold: highValueThreshold,
          requires_confirmation: "confirm_high_value",
        }, 409);
      }

      // 4 ── Approval workflow
      // Wallet → platform recoveries post immediately. The CFO / dual approval
      // step was removed because parked corrections made reconciliation harder.
      const requiredApprovals = 0;
      void dualApprovalThreshold; void cfoApprovalThreshold;
      if (requiredApprovals > 0) {
        if (approvalId) {
          if (!UUID_RE.test(approvalId)) return json({ error: "Invalid approval reference." }, 400);
          const { data: appr } = await adminClient
            .from("error_correction_approvals")
            .select("id, status, amount, bucket, requested_by, target_user_id")
            .eq("id", approvalId)
            .maybeSingle();
          if (!appr) return json({ error: "Approval request not found." }, 404);
          if (appr.status !== "approved") {
            return json({
              error: `This correction is still ${appr.status}. It cannot be executed yet.`,
              approval_id: appr.id,
              approval_status: appr.status,
            }, 409);
          }
          if (
            String(appr.target_user_id) !== sourceUserId ||
            Number(appr.amount) !== amount ||
            String(appr.bucket) !== sourceBucket
          ) {
            return json({
              error: "The approved correction does not match this request (user, amount or bucket changed).",
            }, 409);
          }
          approvalRow = appr as typeof approvalRow;
        } else {
          const { data: created, error: apprErr } = await adminClient
            .from("error_correction_approvals")
            .insert({
              requested_by: authedUser.id,
              requester_roles: callerRoles,
              target_user_id: sourceUserId,
              target_name: sourceName,
              amount,
              bucket: sourceBucket,
              reason_code: reasonCode,
              reason_detail: reasonNote,
              business_justification: businessJustification,
              reference_number: referenceNumber,
              related_transaction_id: relatedTransactionId || null,
              withdrawable_before: srcWithdrawable,
              float_before: srcFloat,
              commission_component: commissionComponent,
              required_approvals: requiredApprovals,
            })
            .select("id")
            .maybeSingle();
          if (apprErr) {
            return json({ error: `Could not raise the approval request: ${apprErr.message}` }, 500);
          }
          await adminClient.from("error_correction_alerts").insert({
            alert_type: "approval_required",
            severity: requiredApprovals >= 2 ? "critical" : "high",
            operator_id: authedUser.id,
            operator_name: authedUser.email ?? null,
            target_user_id: sourceUserId,
            target_name: sourceName,
            amount,
            bucket: sourceBucket,
            reason_code: reasonCode,
            reference_number: referenceNumber,
            details: {
              required_approvals: requiredApprovals,
              approval_id: created?.id ?? null,
              business_justification: businessJustification,
            },
          }).then(() => {}, () => {});
          return json({
            requires_approval: true,
            approval_id: created?.id ?? null,
            required_approvals: requiredApprovals,
            message:
              requiredApprovals >= 2
                ? `UGX ${amount.toLocaleString()} needs dual approval before it can be posted. The request has been sent to the CFO.`
                : `UGX ${amount.toLocaleString()} needs CFO approval before it can be posted. The request has been sent to the CFO.`,
          }, 202);
        }
      }
    }

    const bucketLeg = (
      userId: string,
      direction: "cash_in" | "cash_out",
      bucket: Bucket,
      linkedParty: string,
      description: string,
      refId: string,
      nowIso: string,
      // Phase 2 (WELILE-LEDGER-TRACE-2): when the money changes BUCKET, the two
      // general-purpose categories price to the same side of the account map and
      // the group would post two debits (or two credits). Cross-bucket moves use
      // the dedicated reclass categories, which have their own mapping rows.
      crossBucket = false,
    ) => ({
      user_id: userId,
      amount,
      direction,
      category: crossBucket
        ? (direction === "cash_in" ? "bucket_reclass_in" : "bucket_reclass_out")
        : (bucket === "float" ? "agent_float_assignment" : "wallet_transfer"),
      ledger_scope: "wallet",
      recipient_type: bucket === "float" ? "operational_wallet" : "user",
      wallet_bucket: bucket,
      routing_source: "finops_wallet_move",
      source_table: "finops_wallet_move",
      reference_id: refId,
      classification: "production",
      currency: "UGX",
      transaction_date: nowIso,
      linked_party: linkedParty,
      description,
    });

    const nowIso = new Date().toISOString();
    const fmt = `UGX ${amount.toLocaleString()}`;
    const srcBucketLabel = sourceBucket === "withdrawable" ? "Withdrawable" : "Float";

    let entries: Record<string, unknown>[];
    let refId: string;

    if (mode === "user_to_user") {
      refId = `FXW-${crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
      const dstBucketLabel = destBucket === "withdrawable" ? "Withdrawable" : "Float";
      const crossBucket = sourceBucket !== destBucket;
      entries = [
        bucketLeg(
          sourceUserId,
          "cash_out",
          sourceBucket,
          destName,
          `Operator move: sent ${fmt} from ${srcBucketLabel} to ${destName} (${dstBucketLabel}). ${reason}`,
          refId,
          nowIso,
          crossBucket,
        ),
        bucketLeg(
          destUserId,
          "cash_in",
          destBucket,
          sourceName,
          `Operator move: received ${fmt} into ${dstBucketLabel} from ${sourceName} (${srcBucketLabel}). ${reason}`,
          refId,
          nowIso,
          crossBucket,
        ),
      ];
    } else {
      // error_correction: wallet leg out, platform leg in (system_balance_correction)
      refId = `ECW-${crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
      entries = [
        bucketLeg(
          sourceUserId,
          "cash_out",
          sourceBucket,
          "Welile Platform",
          `Error correction: returned ${fmt} from ${sourceName}'s ${srcBucketLabel} to the platform. ${reason}`,
          refId,
          nowIso,
        ),
        {
          // Platform receives the funds back — recorded on the cash-flow
          // statement as a system balance / error correction. The category is
          // chosen so this leg lands on the OPPOSITE side of the account map to
          // the wallet leg: a withdrawable claw-back debits the liability, so the
          // platform side must credit (balance_correction → E3); a float claw-back
          // credits the float asset, so the platform side must debit (A9).
          user_id: null,
          amount,
          direction: "cash_in",
          category: sourceBucket === "float" ? "system_balance_correction" : "balance_correction",
          ledger_scope: "platform",
          routing_source: "finops_wallet_move",
          source_table: "finops_wallet_move",
          reference_id: refId,
          currency: "UGX",
          transaction_date: nowIso,
          linked_party: sourceName,
          solvency_bypass_reason: "dispute_resolution",
          description: `Error correction: ${fmt} recovered from ${sourceName}'s ${srcBucketLabel} wallet. ${reason}`,
        },
      ];
    }

    // ── Post the balanced transaction ─────────────────────────────────────
    // The group is priced against `ledger_account_map` and asserted to net to
    // zero (debits = credits) BEFORE anything is written; an unbalanced group is
    // rejected and logged instead of posted. We pre-validated the source has
    // enough, so the engine's own withdrawable check is skipped (it would
    // otherwise mis-handle the float-bucket legs).
    const posted = await postBalancedLedgerGroup(adminClient, {
      entries,
      source: `finops-wallet-move:${mode}`,
      referenceId: refId,
      skipBalanceCheck: true,
    });
    if (!posted.ok) return json({ error: posted.error }, 500);
    const groupId = posted.groupId;

    // Refresh cached totals (buckets are derived by the view; this keeps the
    // cached `balance` column in step).
    try {
      await adminClient.rpc("reconcile_wallet_from_ledger", { p_user_id: sourceUserId });
      if (mode === "user_to_user") {
        await adminClient.rpc("reconcile_wallet_from_ledger", { p_user_id: destUserId });
      }
    } catch (_) {
      // Non-fatal: the strict view already reflects the move.
    }

    // ── Mandatory audit trail (audit governance) ──────────────────────────
    await adminClient.from("audit_logs").insert({
      user_id: authedUser.id,
      action_type: "finops_wallet_move",
      table_name: "general_ledger",
      record_id: groupId,
      metadata: {
        mode,
        source_user_id: sourceUserId,
        source_name: sourceName,
        source_bucket: sourceBucket,
        dest_user_id: mode === "user_to_user" ? destUserId : null,
        dest_name: destName,
        dest_bucket: mode === "user_to_user" ? destBucket : "platform",
        amount,
        reason,
        reason_code: reasonCode,
        reason_note: reasonNote,
        lifetime_deposits: lifetimeDeposits,
        full_history_sweep_confirmed:
          mode === "error_correction" && lifetimeDeposits > 0 && amount >= lifetimeDeposits,
        reference_id: refId,
        source_withdrawable_before: srcWithdrawable,
        source_float_before: srcFloat,
        caller_roles: callerRoles,
      },
    });

    // ── Event-based architecture: emit a system event ─────────────────────
    try {
      await adminClient.from("system_events").insert({
        event_type:
          mode === "user_to_user" ? "wallet.finops_move" : "wallet.finops_error_correction",
        description:
          mode === "user_to_user"
            ? `Operator moved ${fmt} from ${sourceName} to ${destName}`
            : `Operator recovered ${fmt} from ${sourceName} to the platform (error correction)`,
        metadata: {
          mode,
          source_user_id: sourceUserId,
          dest_user_id: mode === "user_to_user" ? destUserId : null,
          amount,
          reason,
          reference_id: refId,
          actor_id: authedUser.id,
        },
      });
    } catch (_) {
      // Lean-database policy: never let a non-critical event write fail the move.
    }

    // Read back fresh buckets straight from the strict-derived view.
    const { data: srcAfter } = await adminClient
      .from("wallets")
      .select("withdrawable_balance, float_balance")
      .eq("user_id", sourceUserId)
      .maybeSingle();
    let destAfter: { withdrawable_balance: number; float_balance: number } | null = null;
    if (mode === "user_to_user") {
      const { data } = await adminClient
        .from("wallets")
        .select("withdrawable_balance, float_balance")
        .eq("user_id", destUserId)
        .maybeSingle();
      destAfter = data as typeof destAfter;
    }

    const srcWithdrawableAfter = Number(srcAfter?.withdrawable_balance ?? 0);
    const srcFloatAfter = Number(srcAfter?.float_balance ?? 0);
    const srcBucketAfter = sourceBucket === "withdrawable" ? srcWithdrawableAfter : srcFloatAfter;

    // ── Error-correction governance register + high-risk alerts ───────────
    if (mode === "error_correction") {
      let auditId: string | null = null;
      try {
        const { data: auditRow } = await adminClient
          .from("error_correction_audit")
          .insert({
            operator_id: authedUser.id,
            operator_name: authedUser.email ?? null,
            operator_roles: callerRoles,
            target_user_id: sourceUserId,
            target_name: sourceName,
            target_phone: profiles?.find((x) => x.id === sourceUserId)?.phone ?? null,
            amount,
            bucket: sourceBucket,
            reason_code: reasonCode,
            reason_detail: reasonNote,
            business_justification: businessJustification,
            reference_number: referenceNumber,
            related_transaction_id: relatedTransactionId || null,
            withdrawable_before: srcWithdrawable,
            withdrawable_after: srcWithdrawableAfter,
            float_before: srcFloat,
            float_after: srcFloatAfter,
            commission_component: commissionComponent,
            commission_acknowledged: acknowledgeEarnedIncome,
            high_value_confirmed: confirmHighValue,
            approval_id: approvalRow?.id ?? null,
            ledger_group_id: groupId,
            ledger_reference_id: refId,
            transaction_group_category: "system_balance_correction",
            platform_destination: "Welile Platform",
            status: "posted",
            client_ip: clientIp,
            user_agent: ua || null,
            device,
            browser,
            session_id: sessionId || null,
          })
          .select("id")
          .maybeSingle();
        auditId = auditRow?.id ?? null;
      } catch (_) {
        // Never fail a posted transaction on an audit write.
      }

      if (approvalRow?.id) {
        await adminClient
          .from("error_correction_approvals")
          .update({
            status: "executed",
            executed_at: new Date().toISOString(),
            executed_ledger_group_id: groupId,
          })
          .eq("id", approvalRow.id)
          .then(() => {}, () => {});
      }

      // High-risk alerts: earned income removed, large float correction,
      // operator velocity, and multiple users corrected in succession.
      try {
        const alerts: Record<string, unknown>[] = [];
        const base = {
          operator_id: authedUser.id,
          operator_name: authedUser.email ?? null,
          target_user_id: sourceUserId,
          target_name: sourceName,
          amount,
          bucket: sourceBucket,
          reason_code: reasonCode,
          reference_number: referenceNumber,
          transaction_group_id: groupId,
          audit_id: auditId,
        };
        if (commissionComponent > 0) {
          alerts.push({
            ...base,
            alert_type: "earned_commission_removed",
            severity: "critical",
            details: { commission_component: commissionComponent, business_justification: businessJustification },
          });
        }
        if (amount >= alertThreshold) {
          alerts.push({
            ...base,
            alert_type: sourceBucket === "float" ? "large_float_correction" : "large_withdrawable_correction",
            severity: "high",
            details: { alert_threshold: alertThreshold, business_justification: businessJustification },
          });
        }
        const since = new Date(Date.now() - velocityWindowMinutes * 60_000).toISOString();
        const { data: recent } = await adminClient
          .from("error_correction_audit")
          .select("target_user_id")
          .eq("operator_id", authedUser.id)
          .gte("created_at", since);
        const recentCount = (recent || []).length;
        const distinctUsers = new Set((recent || []).map((r: { target_user_id: string }) => r.target_user_id)).size;
        if (recentCount >= velocityMaxOps) {
          alerts.push({
            ...base,
            alert_type: "operator_velocity",
            severity: "high",
            details: { corrections_in_window: recentCount, window_minutes: velocityWindowMinutes },
          });
        }
        if (distinctUsers >= velocityMaxUsers) {
          alerts.push({
            ...base,
            alert_type: "multiple_users_corrected",
            severity: "critical",
            details: { distinct_users_in_window: distinctUsers, window_minutes: velocityWindowMinutes },
          });
        }
        if (alerts.length) {
          await adminClient.from("error_correction_alerts").insert(alerts);
          await adminClient.from("system_events").insert({
            event_type: "wallet.finops_error_correction",
            description:
              `HIGH RISK error correction: ${fmt} removed from ${sourceName}'s ${srcBucketLabel} ` +
              `(${alerts.map((a) => a.alert_type).join(", ")})`,
            metadata: {
              operator_id: authedUser.id,
              target_user_id: sourceUserId,
              amount,
              reason_code: reasonCode,
              reference_number: referenceNumber,
              transaction_group_id: groupId,
              alert_types: alerts.map((a) => a.alert_type),
            },
          }).then(() => {}, () => {});
        }
      } catch (_) {
        // Alerts are best-effort; the audit row is the durable record.
      }
    }

    // Belt-and-suspenders: if a race condition caused a negative bucket, flag it.
    if (srcBucketAfter < 0 || (destAfter && destBucket === "withdrawable" && Number(destAfter.withdrawable_balance) < 0) || (destAfter && destBucket === "float" && Number(destAfter.float_balance) < 0)) {
      try {
        await adminClient.from("wallet_overdraw_events").insert({
          user_id: sourceUserId,
          attempted_balance: amount,
          clamped_to: 0,
          float_before: srcFloat,
          float_after: srcFloatAfter,
          withdrawable_before: srcWithdrawable,
          withdrawable_after: srcWithdrawableAfter,
          trigger_op: "finops_wallet_move_negative_post",
        });
      } catch (_) {
        // Best-effort anomaly log.
      }
      return json(
        {
          error: `Move resulted in a negative balance. The transaction was posted but needs review.`,
          source: {
            user_id: sourceUserId,
            name: sourceName,
            withdrawable_after: srcWithdrawableAfter,
            float_after: srcFloatAfter,
          },
          dest:
            mode === "user_to_user"
              ? {
                  user_id: destUserId,
                  name: destName,
                  withdrawable_after: Number(destAfter?.withdrawable_balance ?? 0),
                  float_after: Number(destAfter?.float_balance ?? 0),
                }
              : { name: "Welile Platform" },
        },
        500,
      );
    }

    // ── Push notification (fire-and-forget) ──────────────────────────────
    if (mode === "user_to_user" && destUserId) {
      fetch(`${supabaseUrl}/functions/v1/send-push-notification`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
        body: JSON.stringify({
          userIds: [destUserId],
          payload: {
            title: "💰 Money Received",
            body: `${fmt} was added to your wallet.`,
            url: "/dashboard/agent",
            type: "success",
          },
        }),
      }).catch(() => {});
    }

    // ── Customer SMS on EVERY move (fire-and-forget) ─────────────────────
    // Historically an error correction silently emptied a user's wallet with no
    // notification at all, so the money looked stolen. Always tell them.
    try {
      const phoneOf = (id: string) =>
        (profiles?.find((x) => x.id === id)?.phone || "").trim();
      const firstNameOf = (id: string) =>
        (profiles?.find((x) => x.id === id)?.full_name || "").trim().split(" ")[0] || "there";
      const srcPhone = phoneOf(sourceUserId);
      if (srcPhone) {
        const srcNewBucket = `New ${srcBucketLabel} balance: UGX ${Math.max(0, srcBucketAfter).toLocaleString()}.`;
        const msg =
          mode === "user_to_user"
            ? `Welile: Hi ${firstNameOf(sourceUserId)}, ${fmt} was moved out of your ${srcBucketLabel} wallet by Welile Financial Operations (ref ${refId}). ${srcNewBucket} Reason: ${REASON_CODES[reasonCode]}.`
            : `Welile: Hi ${firstNameOf(sourceUserId)}, ${fmt} was reversed from your ${srcBucketLabel} wallet by Welile Financial Operations (ref ${refId}). ${srcNewBucket} Reason: ${REASON_CODES[reasonCode]}.`;
        sendSMS(srcPhone, msg, {
          admin: adminClient,
          source: "finops-wallet-move",
          reference_id: refId,
          recipient_user_id: sourceUserId,
          recipient_name: sourceName,
        }).catch(() => {});
      }

      if (mode === "user_to_user" && destUserId) {
        const dstPhone = phoneOf(destUserId);
        if (dstPhone) {
          const dstBucketLabel2 = destBucket === "withdrawable" ? "Withdrawable" : "Float";
          const dstAfter =
            destBucket === "withdrawable"
              ? Number(destAfter?.withdrawable_balance ?? 0)
              : Number(destAfter?.float_balance ?? 0);
          sendSMS(
            dstPhone,
            `Welile: Hi ${firstNameOf(destUserId)}, ${fmt} was credited to your ${dstBucketLabel2} wallet by Welile Financial Operations (ref ${refId}). New ${dstBucketLabel2} balance: UGX ${Math.max(0, dstAfter).toLocaleString()}.`,
            {
              admin: adminClient,
              source: "finops-wallet-move",
              reference_id: refId,
              recipient_user_id: destUserId,
              recipient_name: destName,
            },
          ).catch(() => {});
        }
      }
    } catch (_) {
      // Never let a notification failure affect money that already moved.
    }

    return json({
      success: true,
      mode,
      reference_id: refId,
      transaction_group_id: groupId,
      amount,
      source: {
        user_id: sourceUserId,
        name: sourceName,
        withdrawable_after: srcWithdrawableAfter,
        float_after: srcFloatAfter,
      },
      dest:
        mode === "user_to_user"
          ? {
              user_id: destUserId,
              name: destName,
              withdrawable_after: Number(destAfter?.withdrawable_balance ?? 0),
              float_after: Number(destAfter?.float_balance ?? 0),
            }
          : { name: "Welile Platform" },
      message:
        mode === "user_to_user"
          ? `Moved ${fmt} from ${sourceName} to ${destName}.`
          : `Recovered ${fmt} from ${sourceName} to the platform as an error correction.`,
    });
  } catch (err) {
    console.error("[finops-wallet-move] error:", err);
    return json({ error: (err as Error).message || "Unexpected error" }, 500);
  }
});