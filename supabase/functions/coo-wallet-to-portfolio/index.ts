import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildPartnershipTopupRequest, dispatchTransactionalEmail, resolveManagedProxy } from "../_shared/partnership-emails.ts";
import { checkTreasuryGuard } from "../_shared/treasuryGuard.ts";
import { withRetry } from "../_shared/rpcRetry.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const VALID_METHODS = ["wallet", "proxy_agent"] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonRes(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // Treasury guard: block when money movement paused
    const guardBlock = await checkTreasuryGuard(supabase, "any", req.headers.get("Authorization"));
    if (guardBlock) return guardBlock;

    // Authenticate caller
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonRes({ error: "Unauthorized" }, 401);

    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) return jsonRes({ error: "Unauthorized" }, 401);

    // Verify caller role (COO, manager, super_admin)
    const { data: roles } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id);

    const allowedRoles = ["coo", "manager", "super_admin"];
    if (!(roles || []).some((r: any) => allowedRoles.includes(r.role))) {
      return jsonRes({ error: "Insufficient permissions" }, 403);
    }

    const body = await req.json();
    let { portfolio_id, amount, reason, payment_method, source_wallet_user_id } = body;

    // Validate inputs
    if (!portfolio_id || !UUID_RE.test(portfolio_id)) {
      return jsonRes({ error: "Invalid portfolio_id" }, 400);
    }

    const topupAmount = Number(amount);
    if (!topupAmount || topupAmount < 1000) {
      return jsonRes({ error: "Minimum transfer is UGX 1,000" }, 400);
    }
    if (topupAmount > 200_000_000_000) {
      return jsonRes({ error: "Amount exceeds maximum" }, 400);
    }

    const safeReason = typeof reason === "string" ? reason.trim().slice(0, 500) : "";
    if (safeReason.length < 10) {
      return jsonRes({ error: "Reason must be at least 10 characters" }, 400);
    }

    // Validate payment method (default to wallet for backward compat)
    let method = payment_method && VALID_METHODS.includes(payment_method) ? payment_method : "wallet";

    // Which wallet bucket to deploy from: "withdrawable" (personal deposit, default)
    // or "float" (operational / company float). Routed on the wallet leg via
    // recipient_type so the correct bucket is decremented.
    const fundSource: "withdrawable" | "float" =
      body.fund_source === "float" ? "float" : "withdrawable";

    // Fetch portfolio
    const { data: portfolio, error: pErr } = await supabase
      .from("investor_portfolios")
      .select("id, investor_id, agent_id, investment_amount, status, portfolio_code, account_name, roi_percentage")
      .eq("id", portfolio_id)
      .single();

    if (pErr || !portfolio) return jsonRes({ error: "Portfolio not found" }, 404);

    if (portfolio.status === "cancelled") {
      return jsonRes({ error: "Cannot fund a cancelled portfolio" }, 400);
    }

    const partnerId = portfolio.investor_id || portfolio.agent_id;
    const accountLabel = portfolio.account_name || portfolio.portfolio_code;

    // ── MANAGED-PROXY HARD GUARDRAIL ──
    // If partner is managed by a proxy agent, force funds to come from the
    // proxy agent's wallet — regardless of what the UI submitted.
    const managedProxy = await resolveManagedProxy(supabase, partnerId);
    if (managedProxy) {
      if (method !== "proxy_agent" || source_wallet_user_id !== managedProxy.agentId) {
        console.warn(
          `[coo-wallet-to-portfolio] Managed-proxy override: partner=${partnerId} ` +
          `forced source=${managedProxy.agentId} (was method=${method} source=${source_wallet_user_id})`,
        );
      }
      method = "proxy_agent";
      source_wallet_user_id = managedProxy.agentId;
    }

    // ── Resolve source wallet ──
    // For "wallet" method, use explicit source_wallet_user_id if provided (COO may be viewing
    // a partner whose portfolios have a different investor_id)
    let walletOwnerId = (method === "wallet" && source_wallet_user_id && UUID_RE.test(source_wallet_user_id))
      ? source_wallet_user_id
      : partnerId;
    let walletOwnerLabel = "Partner Wallet";
    let agentName: string | null = null;

    if (method === "proxy_agent") {
      let agentId = source_wallet_user_id;
      if (!agentId) {
        const { data: proxyAssignment } = await supabase
          .from("proxy_agent_assignments")
          .select("agent_id")
          .eq("beneficiary_id", partnerId)
          .eq("is_active", true)
          .eq("approval_status", "approved")
          .limit(1)
          .maybeSingle();

        if (!proxyAssignment?.agent_id) {
          return jsonRes({ error: "No active proxy agent assigned to this partner" }, 400);
        }
        agentId = proxyAssignment.agent_id;
      }
      walletOwnerId = agentId;

      const { data: agentProfile } = await supabase
        .from("profiles")
        .select("full_name")
        .eq("id", agentId)
        .single();
      agentName = agentProfile?.full_name || "Agent";
      walletOwnerLabel = `Proxy Agent (${agentName})`;
    }

    // ── Check wallet balance (bucket-aware, WITHDRAWABLE-only) ──
    // The wallet leg routes to the WITHDRAWABLE bucket. Checking aggregate
    // `balance` is misleading because funds may be parked in `float_balance`
    // (e.g. agents) and would trip the wallets_buckets_nonneg constraint when
    // withdrawable goes negative — i.e. bucket drift.
    const { data: wallet, error: wErr } = await supabase
      .from("wallets")
      .select("balance, withdrawable_balance, float_balance, advance_balance")
      .eq("user_id", walletOwnerId)
      .single();

    if (wErr || !wallet) return jsonRes({ error: `${walletOwnerLabel} wallet not found` }, 404);

    const currentBalance = Number(wallet.balance);
    const withdrawable = Number(wallet.withdrawable_balance ?? 0);
    const floatBal = Number(wallet.float_balance ?? 0);
    const advanceBal = Number(wallet.advance_balance ?? 0);

    // STRICT withdrawable per WITHDRAWABLE STRICT RULE — same gate as
    // approve-withdrawal and manager-portfolio-topup. Cached buckets can be
    // inflated relative to the ledger; trusting them would let us write a
    // wallet_transactions row and then hit a 500 from
    // `enforce_no_negative_wallet_ledger` after money has "left".
    const { data: strictAvailRaw, error: availErr } = await supabase.rpc(
      "get_user_available_balance",
      { p_user_id: walletOwnerId },
    );
    if (availErr) {
      console.error("[coo-wallet-to-portfolio] strict balance lookup failed:", availErr);
      return jsonRes({ error: "Could not verify wallet balance. Please retry." }, 500);
    }
    const strictAvail = Number(strictAvailRaw ?? 0);
    if (fundSource === "float") {
      // ── OPERATIONAL FLOAT source ── deploy company float as capital.
      if (floatBal < topupAmount) {
        return jsonRes({
          error:
            `Insufficient operational float in ${walletOwnerLabel.toLowerCase()}. ` +
            `Need UGX ${topupAmount.toLocaleString()}, but only UGX ${floatBal.toLocaleString()} is available in Float.`,
        }, 400);
      }
    } else {
      // ── PERSONAL DEPOSIT (WITHDRAWABLE) source ──
      const spendable = strictAvail + advanceBal;
      if (spendable < topupAmount) {
        const parts: string[] = [];
        if (strictAvail > 0) parts.push(`Withdrawable: UGX ${strictAvail.toLocaleString()}`);
        if (floatBal > 0) parts.push(`Float (locked): UGX ${floatBal.toLocaleString()}`);
        const breakdown = parts.length ? ` (${parts.join(" · ")})` : "";
        return jsonRes({
          error:
            `Insufficient withdrawable balance in ${walletOwnerLabel.toLowerCase()}. ` +
            `Need UGX ${topupAmount.toLocaleString()}, but only UGX ${spendable.toLocaleString()} is spendable${breakdown}. ` +
            (floatBal > 0 && withdrawable > strictAvail
              ? `Cached wallet shows more, but the ledger of record only allows UGX ${strictAvail.toLocaleString()}. Please reconcile before retrying.`
              : floatBal > 0
              ? `Funds in Float must be released to Withdrawable before topping up, or deploy from Operational Float instead.`
              : ``),
        }, 400);
      }
    }

    const txGroupId = crypto.randomUUID();
    const opStartedAt = Date.now();
    const isLargeAmount = topupAmount >= 5_000_000;
    if (isLargeAmount) {
      console.log(
        `[coo-wallet-to-portfolio] LARGE top-up start portfolio=${portfolio_id} ` +
        `amount=${topupAmount} method=${method} wallet_owner=${walletOwnerId} tx=${txGroupId}`,
      );
    }

    // ── 1. Create wallet transaction (visible in tx history) ──
    // Idempotency: a partial unique index on (sender, recipient, amount,
    // description, 5-min bucket) blocks accidental duplicates (code 23505).
    const { error: txErr } = await supabase.from("wallet_transactions").insert({
      sender_id: walletOwnerId,
      recipient_id: walletOwnerId,
      amount: topupAmount,
      description: `COO Portfolio transfer: ${accountLabel} (${portfolio.portfolio_code})`,
    });

    if (txErr) {
      if ((txErr as any).code === "23505") {
        console.warn(
          `[coo-wallet-to-portfolio] DUPLICATE BLOCKED — wallet=${walletOwnerId} portfolio=${portfolio_id} amount=${topupAmount}`,
        );
        return jsonRes({
          error:
            `This transfer was already recorded moments ago. ` +
            `Refresh the portfolio to see the updated balance. ` +
            `(Duplicate submission blocked.)`,
          duplicate: true,
        }, 409);
      }
      console.error("[coo-wallet-to-portfolio] wallet_transactions insert error:", txErr);
      return jsonRes({ error: "Failed to record wallet transaction" }, 500);
    }

    // ── 2. Deduct from wallet immediately via ledger (retried on transient failures) ──
    // Large top-ups (10M+) occasionally hit transient pooler/connection
    // errors and surface as "Edge Function returned non-2xx". The retry
    // helper only retries genuinely transient errors — validation /
    // constraint failures fail immediately so we don't burn time.
    const ledgerRes = await withRetry<unknown>(
      "wallet_to_portfolio_ledger",
      `${portfolio_id}/${txGroupId}`,
      () => supabase.rpc("create_ledger_transaction", {
      entries: [
        {
          user_id: walletOwnerId,
          amount: topupAmount,
          direction: "cash_out",
          category: "partner_funding",
          recipient_type: fundSource === "float" ? "operational_wallet" : "user",
          description: `Wallet deduction for ${accountLabel} top-up`,
          source_table: "investor_portfolios",
          source_id: portfolio_id,
          linked_party: "platform",
        },
        {
          user_id: partnerId,
          amount: topupAmount,
          direction: "cash_in",
          category: "pending_portfolio_topup",
          description: `Pending capital for ${accountLabel} — applied at maturity`,
          source_table: "investor_portfolios",
          source_id: portfolio_id,
          linked_party: walletOwnerId,
        },
      ],
      }),
    );
    const ledgerErr = ledgerRes.error as { message?: string } | null;

    if (ledgerErr) {
      console.error(
        `[coo-wallet-to-portfolio] LEDGER FAILURE — aborting (portfolio=${portfolio_id}, ` +
        `attempts=${ledgerRes.attempts}, total_ms=${ledgerRes.ms}):`,
        ledgerErr,
      );
      return jsonRes({ error: `Wallet deduction failed: ${ledgerErr.message}. Top-up cancelled.` }, 500);
    }

    // ── 3. Record pre-approved pending top-up (applied at maturity) ──
    const { error: pendingErr } = await supabase.from("pending_wallet_operations").insert({
      user_id: partnerId,
      amount: topupAmount,
      direction: "cash_in",
      category: "pending_portfolio_topup",
      source_table: "investor_portfolios",
      source_id: portfolio_id,
      transaction_group_id: txGroupId,
      description: `${walletOwnerLabel}: ${accountLabel} — pre-approved`,
      linked_party: "platform",
      status: "approved",
      operation_type: "portfolio_topup",
      metadata: {
        initiated_by: user.id,
        initiated_by_role: "coo",
        payment_method: method,
        fund_source: fundSource,
        source_wallet_user_id: walletOwnerId,
        source_wallet_owner: walletOwnerLabel,
        agent_name: agentName,
        source: method,
        portfolio_code: portfolio.portfolio_code,
        reason: safeReason,
        pre_approved: true,
        wallet_balance_before: currentBalance,
      },
    });

    if (pendingErr) {
      console.error("[coo-wallet-to-portfolio] pending insert error:", pendingErr);
      return jsonRes({ error: "Failed to record pending top-up." }, 500);
    }

    // ── 4. Audit trail ──
    await supabase.from("audit_logs").insert({
      user_id: user.id,
      action_type: "coo_wallet_to_portfolio_instant",
      table_name: "investor_portfolios",
      record_id: portfolio_id,
      metadata: {
        partner_id: partnerId,
        wallet_owner_id: walletOwnerId,
        wallet_owner_label: walletOwnerLabel,
        amount: topupAmount,
        current_capital: Number(portfolio.investment_amount),
        payment_method: method,
        fund_source: fundSource,
        wallet_balance_before: currentBalance,
        wallet_balance_after: currentBalance - topupAmount,
        reason: safeReason,
      },
    });

    // ── 5. Notify partner ──
    await supabase.from("notifications").insert({
      user_id: partnerId,
      title: "💰 Portfolio Top-Up Processed",
      message: `UGX ${topupAmount.toLocaleString()} deducted from ${walletOwnerLabel.toLowerCase()} for "${accountLabel}". Capital will be applied at maturity.`,
      type: "info",
      metadata: { portfolio_id, amount: topupAmount, status: "approved", source: walletOwnerLabel },
    });

    // ── 6. Notify CFO + COO executives ──
    try {
      const { data: execs } = await supabase
        .from("user_roles")
        .select("user_id")
        .in("role", ["cfo", "coo"])
        .eq("enabled", true);
      if (execs && execs.length > 0) {
        const uniqueIds = [...new Set(execs.map((e: any) => e.user_id).filter((id: string) => id !== user.id))];
        if (uniqueIds.length > 0) {
          await supabase.from("notifications").insert(
            uniqueIds.map((uid: string) => ({
              user_id: uid,
              title: "📊 COO Portfolio Transfer (Pre-Approved)",
              message: `UGX ${topupAmount.toLocaleString()} from ${walletOwnerLabel} → "${accountLabel}" (${portfolio.portfolio_code}). Instant deduction — applied at maturity.`,
              type: "info",
              metadata: { portfolio_id, amount: topupAmount, portfolio_code: portfolio.portfolio_code, initiated_by: user.id, source: walletOwnerLabel },
            }))
          );
        }
      }
    } catch (notifErr) {
      console.error("[coo-wallet-to-portfolio] Executive notification error (non-blocking):", notifErr);
    }

    console.log(`[coo-wallet-to-portfolio] COO ${user.id} instant ${method} top-up ${topupAmount} for portfolio ${portfolio_id} (wallet owner: ${walletOwnerId})`);
    if (isLargeAmount) {
      console.log(
        `[coo-wallet-to-portfolio] LARGE top-up done portfolio=${portfolio_id} amount=${topupAmount} ` +
        `total_ms=${Date.now() - opStartedAt}`,
      );
    }

    // Partnership Top-Up email — target = partner (not the COO actor)
    try {
      const [{ data: partnerEmailRow }, { data: reviewerProfile }] = await Promise.all([
        supabase.from("profiles").select("email, full_name").eq("id", partnerId).maybeSingle(),
        supabase.from("profiles").select("full_name").eq("id", user.id).maybeSingle(),
      ]);
      if (partnerEmailRow?.email) {
        // Actual portfolio capital before the top-up (includes compounded
        // returns) so the emailed new total matches the portfolio figure.
        const previousValue = Number(portfolio.investment_amount) || 0;
        dispatchTransactionalEmail(
          supabaseUrl,
          serviceKey,
          buildPartnershipTopupRequest({
            recipientEmail: partnerEmailRow.email,
            partnerName: partnerEmailRow.full_name,
            partnerId,
            txGroupId,
            topupAmount,
            previousPortfolioValue: previousValue,
            newTotalPartnershipValue: previousValue + topupAmount,
            roiPercentage: Number((portfolio as any).roi_percentage) || undefined,
            portfolioId: portfolio.id,
            portfolioName: accountLabel,
            reviewedBy: reviewerProfile?.full_name || user.id,
            portfoliosToppedUpCount: 1,
            effectiveAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
          }),
          "coo-wallet-to-portfolio",
        );
      }
    } catch (emailErr) {
      console.warn("[coo-wallet-to-portfolio] Email lookup failed (non-blocking):", emailErr);
    }

    // Fire-and-forget notifications
    fetch(`${supabaseUrl}/functions/v1/notify-managers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceKey}` },
      body: JSON.stringify({ title: "📊 COO Portfolio Transfer", body: `UGX ${topupAmount.toLocaleString()} ${walletOwnerLabel} → ${accountLabel} (${portfolio.portfolio_code})`, url: "/dashboard/manager" }),
    }).catch(() => {});

    fetch(`${supabaseUrl}/functions/v1/send-push-notification`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceKey}` },
      body: JSON.stringify({
        userIds: [partnerId],
        payload: { title: "💰 Portfolio Credited", body: `UGX ${topupAmount.toLocaleString()} top-up processed for ${accountLabel}`, url: "/dashboard/funder", type: "success" },
      }),
    }).catch(() => {});

    return jsonRes({
      success: true,
      amount: topupAmount,
      status: "approved",
      payment_method: method,
      source_wallet: walletOwnerLabel,
      current_capital: Number(portfolio.investment_amount),
      wallet_balance: currentBalance,
      portfolio_code: portfolio.portfolio_code,
    }, 200);

  } catch (error) {
    console.error("[coo-wallet-to-portfolio] Error:", error);
    return jsonRes({ error: "Internal server error" }, 500);
  }
});
