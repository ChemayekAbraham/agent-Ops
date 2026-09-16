import { createClient } from "npm:@supabase/supabase-js@2";
import { checkTreasuryGuard } from "../_shared/treasuryGuard.ts";
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
 *   • leg 1: cash_out  amount  wallet_bucket='float'        recipient_type='operational_wallet'
 *   • leg 2: cash_in   amount  wallet_bucket='withdrawable'  recipient_type='user'
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
    if (!roles?.length) return json({ error: "Insufficient permissions" }, 403);
    const callerRoles = (roles || []).map((r: { role: string }) => r.role);

    // ── Input validation ──────────────────────────────────────────────────
    const body = await req.json().catch(() => ({}));
    const targetUserId: string = String(body?.target_user_id ?? "").trim();
    const reason: string = String(body?.reason ?? "").trim();
    const amount =
      typeof body?.amount === "number"
        ? body.amount
        : Number(String(body?.amount ?? "").replace(/[, _]/g, ""));

    if (!UUID_RE.test(targetUserId)) return json({ error: "Invalid target user." }, 400);
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
    if (withdrawableBefore < amount) {
      return json(
        {
          error: `Insufficient withdrawable balance. Available withdrawable: UGX ${withdrawableBefore.toLocaleString()}, requested: UGX ${amount.toLocaleString()}.`,
        },
        422,
      );
    }

    // ── Overdraft pre-check ───────────────────────────────────────────────
    // The `wallets` view floors each bucket at 0. A user can be silently
    // OVERDRAWN on float (past rent collections exceeded recorded float
    // deposits) — in which case posting +amount to float only fills the
    // hidden hole and the visible float stays at 0. Detect that here from
    // the raw ledger and refuse (unless the caller explicitly acknowledges).
    const acknowledgeOverdraft = body?.acknowledge_float_overdraft === true;
    const { data: floatNetRow } = await adminClient
      .rpc("compute_wallet_float_net", { p_user_id: targetUserId })
      .maybeSingle();
    // Fallback: compute in-line via SQL if the helper doesn't exist yet.
    let floatNet: number | null = null;
    if (floatNetRow && typeof (floatNetRow as any).net === "number") {
      floatNet = Number((floatNetRow as any).net);
    } else {
      const { data: rows } = await adminClient
        .from("general_ledger")
        .select("amount, direction, wallet_bucket, category, classification")
        .eq("user_id", targetUserId)
        .eq("ledger_scope", "wallet");
      if (Array.isArray(rows)) {
        let net = 0;
        for (const r of rows as Array<{
          amount: number; direction: string; wallet_bucket: string | null;
          category: string; classification: string | null;
        }>) {
          const cls = r.classification;
          const okCls =
            cls === null || cls === "production" ||
            (cls === "admin_correction" && r.category === "system_balance_correction" &&
              (r.direction === "debit" || r.direction === "cash_out"));
          if (!okCls) continue;
          if (r.wallet_bucket !== "float") continue;
          const sign = r.direction === "cash_in" || r.direction === "credit" ? 1 : -1;
          net += sign * Number(r.amount);
        }
        floatNet = net;
      }
    }
    if (floatNet !== null && floatNet < 0 && !acknowledgeOverdraft) {
      const shortfall = Math.abs(floatNet);
      const afterMove = floatNet + amount;
      return json(
        {
          error:
            `Float is already overdrawn by UGX ${shortfall.toLocaleString()} ` +
            `(past rent collections exceeded recorded float deposits). ` +
            `Moving UGX ${amount.toLocaleString()} would ${
              afterMove <= 0
                ? `only fill the overdraft — visible Float would stay at UGX 0.`
                : `leave visible Float at UGX ${afterMove.toLocaleString()}.`
            } Resubmit with acknowledge_float_overdraft=true to proceed.`,
          code: "FLOAT_OVERDRAWN",
          float_net: floatNet,
          shortfall,
          visible_float_after: Math.max(0, afterMove),
        },
        409,
      );
    }

    // ── If acknowledged, first fill the overdraft with a balanced ──────────
    // admin_correction so the requested move lands as VISIBLE float.
    //   • wallet leg: cash_in  wallet_bucket='float'  (admin_correction / system_balance_correction)
    //   • platform leg: cash_out (admin_correction / system_balance_correction)
    // This is hidden from customer-facing wallet history per the
    // user-facing-ledger-filter rule, but zeros the float overdraft so the
    // subsequent reclass posts on top of a clean base.
    let overdraftFillRef: string | null = null;
    let overdraftFilled = 0;
    if (floatNet !== null && floatNet < 0 && acknowledgeOverdraft) {
      overdraftFilled = Math.abs(floatNet);
      overdraftFillRef = `FLTFILL-${crypto.randomUUID()}`;
      const fillNow = new Date().toISOString();
      const { error: fillCorrErr } = await adminClient
        .from("platform_wallet_corrections")
        .insert({
          tool: "admin_withdrawable_to_float",
          operation: "reclass",
          target_user_id: targetUserId,
          amount: overdraftFilled,
          evidence: `Float overdraft fill before Withdrawable → Float reclass: ${reason}`,
          reference_id: overdraftFillRef,
          created_by: authedUser.id,
          metadata: { overdraft_fill: true, float_net: floatNet, caller_roles: callerRoles },
        });
      if (fillCorrErr) return json({ error: fillCorrErr.message }, 403);
      const fill = await postBalancedLedgerGroup(adminClient, {
        source: "admin-withdrawable-to-float:overdraft_fill",
        referenceId: overdraftFillRef,
        entries: [
          {
            user_id: targetUserId,
            amount: overdraftFilled,
            direction: "cash_in",
            category: "system_balance_correction",
            ledger_scope: "wallet",
            recipient_type: "operational_wallet",
            wallet_bucket: "float",
            routing_source: "admin_withdrawable_to_float_overdraft_fill",
            source_table: "admin_withdrawable_to_float",
            reference_id: overdraftFillRef,
            classification: "admin_correction",
            currency: "UGX",
            transaction_date: fillNow,
            description: `Overdraft fill: zero float overdraft of UGX ${overdraftFilled.toLocaleString()} before reclass. ${reason}`,
          },
          {
            user_id: null,
            amount: overdraftFilled,
            direction: "cash_out",
            category: "system_balance_correction",
            ledger_scope: "platform",
            routing_source: "admin_withdrawable_to_float_overdraft_fill",
            source_table: "admin_withdrawable_to_float",
            reference_id: overdraftFillRef,
            classification: "admin_correction",
            currency: "UGX",
            transaction_date: fillNow,
            linked_party: targetUserId,
            solvency_bypass_reason: "admin_correction_seed",
            description: `Overdraft fill: platform absorbs UGX ${overdraftFilled.toLocaleString()} to clear float overdraft for user ${targetUserId}. ${reason}`,
          },
        ],
        skipBalanceCheck: true,
      });
      if (!fill.ok) return json({ error: `Overdraft fill failed: ${fill.error}` }, 500);
    }

    const { data: targetProfile } = await adminClient
      .from("profiles")
      .select("full_name")
      .eq("id", targetUserId)
      .maybeSingle();
    const targetName = targetProfile?.full_name || targetUserId;

    // ── Post the balanced reclass transaction ──────────────────────────────
    // reference_id ties both legs + the audit row together for traceability.
    const refId = `WDR2FLT-${crypto.randomUUID()}`;
    const nowIso = new Date().toISOString();

    // Phase 6: evidenced, authorized, immutable correction record. The ledger
    // trigger `enforce_wallet_correction_evidence` refuses these legs without it.
    const { error: corrErr } = await adminClient
      .from("platform_wallet_corrections")
      .insert({
        tool: "admin_withdrawable_to_float",
        operation: "reclass",
        target_user_id: targetUserId,
        amount,
        evidence: `Withdrawable → Float reclass for ${targetName}: ${reason}`,
        reference_id: refId,
        created_by: authedUser.id,
        metadata: { float_before: floatBefore, withdrawable_before: withdrawableBefore, caller_roles: callerRoles },
      });
    if (corrErr) return json({ error: corrErr.message }, 403);

    const posted = await postBalancedLedgerGroup(adminClient, {
      source: "admin-withdrawable-to-float",
      referenceId: refId,
      entries: [
          {
            // CREDIT the source bucket: remove from the user's own withdrawable money.
            user_id: targetUserId,
            amount,
            direction: "cash_out",
            category: "bucket_reclass_out",
            ledger_scope: "wallet",
            recipient_type: "user",
            wallet_bucket: "withdrawable",
            routing_source: "admin_withdrawable_to_float",
            source_table: "admin_withdrawable_to_float",
            reference_id: refId,
            classification: "production",
            currency: "UGX",
            transaction_date: nowIso,
            description: `Reclass: move UGX ${amount.toLocaleString()} out of Withdrawable for ${targetName}: ${reason}`,
          },
          {
            // DEBIT the destination bucket: add to operational float (company money).
            user_id: targetUserId,
            amount,
            direction: "cash_in",
            category: "bucket_reclass_in",
            ledger_scope: "wallet",
            recipient_type: "operational_wallet",
            wallet_bucket: "float",
            routing_source: "admin_withdrawable_to_float",
            source_table: "admin_withdrawable_to_float",
            reference_id: refId,
            classification: "production",
            currency: "UGX",
            transaction_date: nowIso,
            description: `Reclass: credit UGX ${amount.toLocaleString()} to Operational Float for ${targetName}: ${reason}`,
          },
      ],
      // The engine's own pre-check can't see across buckets; the double-entry
      // assertion in postBalancedLedgerGroup is what guards this write.
      skipBalanceCheck: true,
      // Closes the double-submit race: two concurrent reclass requests for
      // the same target (e.g. a double-click, or this racing an agent's own
      // agent-convert-withdrawable-to-float call) could otherwise both read
      // the same withdrawableBefore and both post. Re-checked under an
      // advisory lock immediately before writing.
      lockUserId: targetUserId,
      minAvailable: amount,
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
      action_type: "admin_withdrawable_to_float",
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
        overdraft_fill_reference_id: overdraftFillRef,
        overdraft_filled: overdraftFilled,
        float_net_before: floatNet,
      },
    });

    // ── Event-based architecture: emit a system event ─────────────────────
    try {
      await adminClient.from("system_events").insert({
        event_type: "wallet.withdrawable_to_float",
        description: `Reclassified UGX ${amount.toLocaleString()} from Withdrawable to Float for ${targetName}`,
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

    const floatAfter = Number(after?.float_balance ?? floatBefore + amount);
    const withdrawableAfter = Number(after?.withdrawable_balance ?? withdrawableBefore - amount);

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
          trigger_op: "admin_withdrawable_to_float_negative_post",
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
          title: "🔄 Balance Moved to Float",
          body: `UGX ${amount.toLocaleString()} moved to your float balance.`,
          url: "/dashboard/agent",
          type: "info",
        },
      }),
    }).catch(() => {});

    return json({
      success: true,
      reference_id: refId,
      transaction_group_id: groupId,
      amount,
      float_before: floatBefore,
      withdrawable_before: withdrawableBefore,
      float_after: floatAfter,
      withdrawable_after: withdrawableAfter,
      overdraft_filled: overdraftFilled,
      overdraft_fill_reference_id: overdraftFillRef,
      message: `Moved UGX ${amount.toLocaleString()} from Withdrawable to Float for ${targetName}.`,
    });
  } catch (err) {
    console.error("[admin-withdrawable-to-float] error:", (err as Error).message);
    return json({ error: (err as Error).message || "Unexpected error" }, 500);
  }
});