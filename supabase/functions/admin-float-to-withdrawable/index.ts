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

/**
 * admin-float-to-withdrawable
 *
 * Secure finance-leadership action that reclassifies money already sitting in a
 * user's `float_balance` (operational / company money — never withdrawable) into
 * their `withdrawable_balance` (their own, spendable money) WITHOUT changing the
 * user's total wallet balance.
 *
 * It does this the only sanctioned way — by posting a balanced, double-entry
 * WALLET-scope transaction through `create_ledger_transaction`:
 *   • leg 1 (CREDIT source): cash_out amount wallet_bucket='float'
 *     category='bucket_reclass_out'  recipient_type='operational_wallet'
 *   • leg 2 (DEBIT destination): cash_in amount wallet_bucket='withdrawable'
 *     category='bucket_reclass_in'   recipient_type='user'
 *
 * Phase 2 (WELILE-LEDGER-TRACE-2): the legs used to reuse `agent_float_assignment`
 * and `wallet_transfer`, which both price to the SAME side of the account map — so
 * every reclass wrote two credits (or two debits in reverse) and grew the trial
 * balance gap. Dedicated reclass categories carry their own mapping rows, and the
 * group is asserted to net to zero before it is written.
 *
 * Because `wallets` is a view that derives every bucket live from
 * `v_user_wallet_strict` (which routes by the explicit `wallet_bucket` column),
 * float drops by `amount` and withdrawable rises by `amount` the instant the
 * legs land. No direct wallet-column writes — ledger stays the single source of
 * truth.
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
      .in("role", ["cfo", "financial_ops", "super_admin"]);
    const callerRoles = (roles || []).map((r: { role: string }) => r.role);

    // Designated Financial Ops operators who also run a merchant desk are
    // authorized too, but only for their OWN wallet (float -> withdrawable never
    // changes a total balance). Everyone else needs a finance role.
    let isDesignatedOperator = false;
    if (!callerRoles.length) {
      const { data: authorized } = await adminClient.rpc("merchant_float_fix_authorized", {
        _user_id: authedUser.id,
      });
      isDesignatedOperator = authorized === true;
      if (!isDesignatedOperator) return json({ error: "Insufficient permissions" }, 403);
    }

    // ── Input validation ──────────────────────────────────────────────────
    const body = await req.json().catch(() => ({}));
    const targetUserId: string = String(body?.target_user_id ?? "").trim();
    const reason: string = String(body?.reason ?? "").trim();
    const amount =
      typeof body?.amount === "number"
        ? body.amount
        : Number(String(body?.amount ?? "").replace(/[, _]/g, ""));

    if (!UUID_RE.test(targetUserId)) return json({ error: "Invalid target user." }, 400);
    if (isDesignatedOperator && targetUserId !== authedUser.id) {
      return json(
        { error: "You can only move float to withdrawable on your own wallet." },
        403,
      );
    }
    if (!Number.isFinite(amount) || amount <= 0 || amount > 500_000_000) {
      return json({ error: "Amount must be a positive number up to UGX 500,000,000." }, 400);
    }
    // Whole shillings only — wallets never hold fractional UGX.
    if (!Number.isInteger(amount)) {
      return json({ error: "Amount must be a whole number of UGX." }, 400);
    }
    if (reason.length < 20) {
      return json({ error: "A reason of at least 20 characters is required." }, 400);
    }

    // ── Confirm the user actually has enough float to move ─────────────────
    const { data: walletRow, error: walletErr } = await adminClient
      .from("wallets")
      .select("float_balance, withdrawable_balance")
      .eq("user_id", targetUserId)
      .maybeSingle();
    if (walletErr) return json({ error: `Wallet lookup failed: ${walletErr.message}` }, 500);

    const floatBefore = Number(walletRow?.float_balance ?? 0);
    const withdrawableBefore = Number(walletRow?.withdrawable_balance ?? 0);
    if (floatBefore < amount) {
      return json(
        {
          error: `Insufficient float balance. Available float: UGX ${floatBefore.toLocaleString()}, requested: UGX ${amount.toLocaleString()}.`,
        },
        422,
      );
    }

    const { data: targetProfile } = await adminClient
      .from("profiles")
      .select("full_name, phone")
      .eq("id", targetUserId)
      .maybeSingle();
    const targetName = targetProfile?.full_name || targetUserId;

    // ── Post the balanced reclass transaction ──────────────────────────────
    // reference_id ties both legs + the audit row together for traceability.
    const refId = `FLT2WDR-${crypto.randomUUID()}`;
    const nowIso = new Date().toISOString();

    // Phase 6: evidenced, authorized, immutable correction record. The ledger
    // trigger `enforce_wallet_correction_evidence` refuses these legs without it.
    const { error: corrErr } = await adminClient
      .from("platform_wallet_corrections")
      .insert({
        tool: "admin_float_to_withdrawable",
        operation: "reclass",
        target_user_id: targetUserId,
        amount,
        evidence: `Float → Withdrawable reclass for ${targetName}: ${reason}`,
        reference_id: refId,
        created_by: authedUser.id,
        metadata: {
          float_before: floatBefore,
          withdrawable_before: withdrawableBefore,
          caller_roles: callerRoles,
          designated_operator: isDesignatedOperator,
          self_authored: targetUserId === authedUser.id,
        },
      });
    if (corrErr) return json({ error: corrErr.message }, 403);

    const posted = await postBalancedLedgerGroup(adminClient, {
      source: "admin-float-to-withdrawable",
      referenceId: refId,
      entries: [
          {
            // CREDIT the source bucket: remove from operational float (company money).
            user_id: targetUserId,
            amount,
            direction: "cash_out",
            category: "bucket_reclass_out",
            ledger_scope: "wallet",
            recipient_type: "operational_wallet",
            wallet_bucket: "float",
            routing_source: "admin_float_to_withdrawable",
            source_table: "admin_float_to_withdrawable",
            reference_id: refId,
            classification: "production",
            currency: "UGX",
            transaction_date: nowIso,
            description: `Reclass: move UGX ${amount.toLocaleString()} out of Operational Float for ${targetName}: ${reason}`,
          },
          {
            // DEBIT the destination bucket: add to the user's own withdrawable money.
            user_id: targetUserId,
            amount,
            direction: "cash_in",
            category: "bucket_reclass_in",
            ledger_scope: "wallet",
            recipient_type: "user",
            wallet_bucket: "withdrawable",
            routing_source: "admin_float_to_withdrawable",
            source_table: "admin_float_to_withdrawable",
            reference_id: refId,
            classification: "production",
            currency: "UGX",
            transaction_date: nowIso,
            description: `Reclass: credit UGX ${amount.toLocaleString()} to Withdrawable for ${targetName}: ${reason}`,
          },
      ],
      // The engine's withdrawable pre-check would mis-handle the float leg; the
      // double-entry assertion in postBalancedLedgerGroup is what guards this write.
      skipBalanceCheck: true,
    });
    if (!posted.ok) return json({ error: posted.error }, 500);
    const groupId = posted.groupId;

    // Refresh the cached wallet total (buckets are derived by the view).
    try {
      await adminClient.rpc("reconcile_wallet_from_ledger", { p_user_id: targetUserId });
    } catch (_) {
      // Non-fatal: the view already reflects the move; the cached total catches
      // up on the next reconcile/sweep.
    }

    // ── Mandatory audit trail (audit governance) ──────────────────────────
    await adminClient.from("audit_logs").insert({
      user_id: authedUser.id,
      action_type: "admin_float_to_withdrawable",
      table_name: "general_ledger",
      record_id: groupId,
      metadata: {
        target_user_id: targetUserId,
        target_name: targetName,
        amount,
        reason,
        reference_id: refId,
        float_before: floatBefore,
        withdrawable_before: withdrawableBefore,
        caller_roles: callerRoles,
      },
    });

    // ── Event-based architecture: emit a system event ─────────────────────
    try {
      await adminClient.from("system_events").insert({
        event_type: "wallet.float_to_withdrawable",
        description: `Reclassified UGX ${amount.toLocaleString()} from Float to Withdrawable for ${targetName}`,
        metadata: {
          target_user_id: targetUserId,
          amount,
          reason,
          reference_id: refId,
          actor_id: authedUser.id,
        },
      });
    } catch (_) {
      // Lean-database policy: never let a non-critical event write fail the move.
    }

    // Read back the fresh buckets straight from the strict-derived view.
    const { data: after } = await adminClient
      .from("wallets")
      .select("float_balance, withdrawable_balance")
      .eq("user_id", targetUserId)
      .maybeSingle();

    const floatAfter = Number(after?.float_balance ?? floatBefore - amount);
    const withdrawableAfter = Number(after?.withdrawable_balance ?? withdrawableBefore + amount);

    // Belt-and-suspenders: if a race condition caused a negative bucket, flag it.
    if (floatAfter < 0 || withdrawableAfter < 0) {
      try {
        await adminClient.from("wallet_overdraw_events").insert({
          user_id: targetUserId,
          attempted_balance: amount,
          clamped_to: 0,
          float_before: floatBefore,
          float_after: floatAfter,
          withdrawable_before: withdrawableBefore,
          withdrawable_after: withdrawableAfter,
          trigger_op: "admin_float_to_withdrawable_negative_post",
        });
      } catch (_) {
        // Best-effort anomaly log.
      }
      return json(
        {
          error: `Move resulted in a negative balance (float: UGX ${floatAfter.toLocaleString()}, withdrawable: UGX ${withdrawableAfter.toLocaleString()}). The transaction was posted but needs review.`,
          float_after: floatAfter,
          withdrawable_after: withdrawableAfter,
        },
        500,
      );
    }

    // ── Push notification (fire-and-forget) ──────────────────────────────
    fetch(`${supabaseUrl}/functions/v1/send-push-notification`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
      body: JSON.stringify({
        userIds: [targetUserId],
        payload: {
          title: "💸 Funds Now Withdrawable",
          body: `UGX ${amount.toLocaleString()} moved to your withdrawable balance.`,
          url: "/dashboard/agent",
          type: "success",
        },
      }),
    }).catch(() => {});

    // ── Gated SMS notification ───────────────────────────────────────────
    // Only field-active agents get a text for a float → withdrawable reclass.
    // Gate (both must be true):
    //   1. the user carries at least one tenant (a rent request they own), and
    //   2. at least one repayment has been recorded for their tenant(s).
    // Partners/funders hold float without tenants, so they are excluded — no
    // financial logic is touched here, only who receives the message.
    let smsGate = { has_tenant: false, has_repayment: false, sent: false as boolean | null };
    try {
      const { count: tenantCount } = await adminClient
        .from("rent_requests")
        .select("id", { count: "exact", head: true })
        .eq("agent_id", targetUserId)
        .not("tenant_id", "is", null);
      smsGate.has_tenant = (tenantCount ?? 0) > 0;

      if (smsGate.has_tenant) {
        const { count: repaymentCount } = await adminClient
          .from("agent_collections")
          .select("id", { count: "exact", head: true })
          .eq("agent_id", targetUserId);
        smsGate.has_repayment = (repaymentCount ?? 0) > 0;
      }

      if (smsGate.has_tenant && smsGate.has_repayment && targetProfile?.phone) {
        const smsMsg =
          `WELILE: UGX ${amount.toLocaleString()} of your float is now withdrawable. ` +
          `Withdrawable balance: UGX ${withdrawableAfter.toLocaleString()}. Ref: ${refId}.`;
        // Awaited on purpose: a fire-and-forget promise dies with the isolate.
        smsGate.sent = await sendSMS(targetProfile.phone, smsMsg, {
          admin: adminClient,
          recipient_user_id: targetUserId,
          recipient_name: targetProfile.full_name ?? null,
          reference_id: refId,
          idempotencyKey: `flt2wdr:${refId}`,
          source: "admin-float-to-withdrawable",
        });
      } else {
        smsGate.sent = false;
      }
    } catch (e) {
      console.error("[admin-float-to-withdrawable] SMS gate failed:", (e as Error).message);
      smsGate.sent = false;
    }

    return json({
      success: true,
      reference_id: refId,
      transaction_group_id: groupId,
      amount,
      float_before: floatBefore,
      withdrawable_before: withdrawableBefore,
      float_after: floatAfter,
      withdrawable_after: withdrawableAfter,
      sms: smsGate,
      message: `Moved UGX ${amount.toLocaleString()} from Float to Withdrawable for ${targetName}.`,
    });
  } catch (err) {
    console.error("[admin-float-to-withdrawable] error:", (err as Error).message);
    return json({ error: (err as Error).message || "Unexpected error" }, 500);
  }
});