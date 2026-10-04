import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildPartnershipTopupRequest, dispatchTransactionalEmail, resolveManagedProxy } from "../_shared/partnership-emails.ts";
import { checkTreasuryGuard } from "../_shared/treasuryGuard.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const VALID_METHODS = ["wallet", "proxy_agent", "user_wallet"] as const;
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

    // Verify caller role
    const { data: roles } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id);

    const allowedRoles = ["coo", "manager", "cfo", "super_admin"];
    if (!(roles || []).some((r: any) => allowedRoles.includes(r.role))) {
      return jsonRes({ error: "Insufficient permissions" }, 403);
    }

    const body = await req.json();
    let { portfolio_id, amount, notes, payment_method, source_wallet_user_id } = body;

    // Validate portfolio_id
    if (!portfolio_id || !UUID_RE.test(portfolio_id)) {
      return jsonRes({ error: "Invalid portfolio_id" }, 400);
    }

    // Validate amount
    const topupAmount = Number(amount);
    if (!topupAmount || topupAmount < 1000) {
      return jsonRes({ error: "Minimum top-up is UGX 1,000" }, 400);
    }
    if (topupAmount > 200_000_000_000) {
      return jsonRes({ error: "Amount exceeds maximum" }, 400);
    }

    // Validate payment method
    if (!payment_method || !VALID_METHODS.includes(payment_method)) {
      return jsonRes({ error: "Invalid payment method. Use: wallet, proxy_agent or user_wallet" }, 400);
    }

    // For the explicit "fund from any user" mode the caller MUST supply a
    // valid source wallet user id. This is the wallet that will be debited.
    if (payment_method === "user_wallet" && (!source_wallet_user_id || !UUID_RE.test(source_wallet_user_id))) {
      return jsonRes({ error: "A valid user must be selected to fund from their wallet" }, 400);
    }

    const safeNotes = typeof notes === "string" ? notes.slice(0, 500) : "";

    // Which wallet bucket to deploy from: "withdrawable" (personal deposit, default)
    // or "float" (operational / company float). Routing is enforced on the wallet
    // leg via recipient_type so the correct bucket is decremented.
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
      return jsonRes({ error: "Cannot top up a cancelled portfolio" }, 400);
    }

    const partnerId = portfolio.investor_id || portfolio.agent_id;
    let txGroupId = crypto.randomUUID();
    const accountLabel = portfolio.account_name || portfolio.portfolio_code;

    // ── MANAGED-PROXY HARD GUARDRAIL ──
    // If the partner is managed by a proxy agent, force funds to come from
    // the proxy agent's wallet — server-side override, no client bypass.
    // EXCEPTIONS (operator explicitly chose the source, so the override is skipped):
    //   1. `user_wallet` — operator searched + picked an arbitrary user's wallet.
    //   2. Partner Wallet (any bucket: Personal Deposit or Operational Float) —
    //      the operator explicitly selected the PARTNER's own wallet, so it must
    //      deduct from that wallet, never the proxy agent wallet.
    const operatorChosePartnerWallet = payment_method === "wallet";
    const managedProxyTopup = (payment_method === "user_wallet" || operatorChosePartnerWallet)
      ? null
      : await resolveManagedProxy(supabase, partnerId);

    if (managedProxyTopup) {
      if (payment_method !== "proxy_agent" || source_wallet_user_id !== managedProxyTopup.agentId) {
        console.warn(
          `[manager-portfolio-topup] Managed-proxy override: partner=${partnerId} ` +
          `forced source=${managedProxyTopup.agentId} (was method=${payment_method} source=${source_wallet_user_id})`,
        );
      }
      payment_method = "proxy_agent";
      source_wallet_user_id = managedProxyTopup.agentId;
    }

    // ── Resolve source wallet ──
    let walletOwnerId = partnerId;
    let walletOwnerLabel = "Partner Wallet";
    let agentName: string | null = null;

    if (payment_method === "user_wallet") {
      // Fund from any user's wallet — operator explicitly searched + picked them.
      walletOwnerId = source_wallet_user_id;
      const { data: srcProfile } = await supabase
        .from("profiles")
        .select("full_name")
        .eq("id", source_wallet_user_id)
        .maybeSingle();
      const srcName = srcProfile?.full_name || "User";
      agentName = srcName;
      walletOwnerLabel = `User Wallet (${srcName})`;
    } else if (payment_method === "proxy_agent") {
      // Validate source_wallet_user_id or look up proxy assignment
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

      // Get agent name
      const { data: agentProfile } = await supabase
        .from("profiles")
        .select("full_name")
        .eq("id", agentId)
        .single();
      agentName = agentProfile?.full_name || "Agent";
      walletOwnerLabel = `Proxy Agent (${agentName})`;
    }

    // ── Check wallet balance (bucket-aware) ──
    // The 'wallet_deduction' category routes to the WITHDRAWABLE bucket.
    // Checking aggregate `balance` is misleading because funds may be parked
    // in `float_balance` (e.g. agents) and would trip the wallets_buckets_nonneg
    // constraint when withdrawable goes negative.
    const { data: wallet, error: wErr } = await supabase
      .from("wallets")
      .select("balance, withdrawable_balance, float_balance, advance_balance")
      .eq("user_id", walletOwnerId)
      .single();

    if (wErr || !wallet) return jsonRes({ error: `${walletOwnerLabel} wallet not found` }, 404);

    const walletBalance = Number(wallet.balance);
    const withdrawable = Number(wallet.withdrawable_balance ?? 0);
    const floatBal = Number(wallet.float_balance ?? 0);
    const advanceBal = Number(wallet.advance_balance ?? 0);

    if (fundSource === "float") {
      // ── OPERATIONAL FLOAT source ──
      // Deploy company / operational float directly as portfolio capital.
      // Gate strictly on the cached float bucket; the ledger trigger
      // `enforce_no_negative_wallet_ledger` is the final backstop.
      if (floatBal < topupAmount) {
        return jsonRes({
          error:
            `Insufficient operational float in ${walletOwnerLabel.toLowerCase()}. ` +
            `Need UGX ${topupAmount.toLocaleString()}, but only UGX ${floatBal.toLocaleString()} is available in Float.`,
        }, 400);
      }
    } else {
      // ── PERSONAL DEPOSIT (WITHDRAWABLE) source ──
      // STRICT withdrawable per WITHDRAWABLE STRICT RULE — same gate as
      // approve-withdrawal. Cached buckets can be inflated relative to the
      // ledger; if we trust them we end up calling the ledger RPC and getting
      // a 500 from `enforce_no_negative_wallet_ledger` after we've already
      // written a wallet_transactions row.
      const { data: strictAvailRaw, error: availErr } = await supabase.rpc(
        "get_user_available_balance",
        { p_user_id: walletOwnerId },
      );
      if (availErr) {
        console.error("[manager-portfolio-topup] strict balance lookup failed:", availErr);
        return jsonRes({ error: "Could not verify wallet balance. Please retry." }, 500);
      }
      const strictAvail = Number(strictAvailRaw ?? 0);
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

    const idempotencyBucket = Math.floor(Date.now() / (5 * 60 * 1000));
    const ledgerIdempotencyKey = `manager_portfolio_topup:${walletOwnerId}:${portfolio_id}:${topupAmount}:${fundSource}:${idempotencyBucket}`;
    const { data: existingLedger } = await supabase
      .from("general_ledger")
      .select("transaction_group_id")
      .eq("idempotency_key", ledgerIdempotencyKey)
      .limit(1)
      .maybeSingle();

    if (existingLedger?.transaction_group_id) {
      return jsonRes({
        success: true,
        duplicate: true,
        amount: topupAmount,
        status: "approved",
        payment_method,
        source_wallet: walletOwnerLabel,
        current_capital: Number(portfolio.investment_amount),
        portfolio_code: portfolio.portfolio_code,
      }, 200);
    }

    // ── 1. Deduct from wallet immediately (FATAL on failure — no silent leaks) ──
    // CRITICAL: The credit (cash_in) MUST be platform-scope. If it stays at the default
    // wallet scope and the partner == wallet owner, the two entries net-zero and the
    // wallet never reduces. Money has left the user's wallet → it now sits with the platform.
    // NOTE (2026-05): `wallet_deduction` was retired. We use `partner_funding` for the
    // wallet leg — same pattern as coo-create-portfolio / coo-invest-for-partner — which
    // is the allow-listed category for wallet→portfolio capital moves. This is NOT a CFO
    // debit (no debt obligation should be created); it's an internal capital reallocation.
    const { data: ledgerTxnGroupId, error: deductErr } = await supabase.rpc("create_ledger_transaction", {
      entries: [
        {
          user_id: walletOwnerId,
          amount: topupAmount,
          direction: "cash_out",
          category: "partner_funding",
          ledger_scope: "wallet",
          recipient_type: fundSource === "float" ? "operational_wallet" : "user",
          description: `Wallet deduction for ${accountLabel} top-up`,
          source_table: "investor_portfolios",
          source_id: portfolio_id,
          linked_party: "platform",
          currency: "UGX",
          transaction_date: new Date().toISOString(),
        },
        {
          user_id: partnerId,
          amount: topupAmount,
          direction: "cash_in",
          category: "pending_portfolio_topup",
          ledger_scope: "platform",
          description: `Pending capital for ${accountLabel} — applied at maturity`,
          source_table: "investor_portfolios",
          source_id: portfolio_id,
          linked_party: walletOwnerId,
          currency: "UGX",
          transaction_date: new Date().toISOString(),
        },
      ],
      idempotency_key: ledgerIdempotencyKey,
    });

    if (deductErr) {
      console.error("[manager-portfolio-topup] LEDGER FAILURE — aborting:", deductErr);
      return jsonRes({ error: `Wallet deduction failed: ${deductErr.message}. Top-up cancelled.` }, 400);
    }
    txGroupId = ledgerTxnGroupId || txGroupId;

    // ── 2. Create wallet transaction (visible in partner/agent tx history) ──
    // Only write this AFTER the ledger succeeds. Earlier versions wrote this
    // first, so failed ledger attempts left orphan rows that then triggered the
    // duplicate guard and blocked legitimate retries for funded wallets.
    const { error: txErr } = await supabase.from("wallet_transactions").insert({
      sender_id: walletOwnerId,
      recipient_id: walletOwnerId, // self — internal portfolio transfer
      amount: topupAmount,
      description: `Portfolio top-up: ${accountLabel} (${portfolio.portfolio_code})`,
    });

    if (txErr) {
      if ((txErr as any).code === "23505") {
        console.warn(
          `[manager-portfolio-topup] wallet_transactions duplicate after ledger success — wallet=${walletOwnerId} portfolio=${portfolio_id} amount=${topupAmount}`,
        );
      } else {
        console.error("[manager-portfolio-topup] wallet_transactions insert error:", txErr);
      }
    }

    // ── 2b. Verify wallet actually decreased (guard against silent net-zero bugs) ──
    const { data: postWallet } = await supabase
      .from("wallets")
      .select("balance")
      .eq("user_id", walletOwnerId)
      .single();
    const postBalance = Number(postWallet?.balance ?? walletBalance);
    if (postBalance >= walletBalance) {
      console.error(`[manager-portfolio-topup] WALLET DID NOT DECREASE — before=${walletBalance} after=${postBalance}`);
      return jsonRes({ error: "Wallet did not decrease. Top-up aborted." }, 500);
    }

    // ── 3. Record pre-approved pending operation (for maturity merge) ──
    const { error: pendingErr } = await supabase.from("pending_wallet_operations").insert({
      user_id: partnerId,
      amount: topupAmount,
      direction: "cash_in",
      category: "pending_portfolio_topup",
      source_table: "investor_portfolios",
      source_id: portfolio_id,
      transaction_group_id: txGroupId,
      description: `${walletOwnerLabel} top-up for ${accountLabel} — pre-approved`,
      linked_party: "platform",
      status: "approved",
      operation_type: "portfolio_topup",
      account: payment_method,
      metadata: {
        payment_method,
        fund_source: fundSource,
        source_wallet_user_id: walletOwnerId,
        source_wallet_owner: walletOwnerLabel,
        agent_name: agentName,
        initiated_by: user.id,
        portfolio_code: portfolio.portfolio_code,
        pre_approved: true,
        wallet_balance_before: walletBalance,
      },
    });

    if (pendingErr) {
      console.error("[manager-portfolio-topup] pending insert error:", pendingErr);
      return jsonRes({ error: "Failed to record pending top-up" }, 500);
    }

    // ── 4. Audit trail ──
    await supabase.from("audit_logs").insert({
      user_id: user.id,
      action_type: "manager_portfolio_topup_instant",
      table_name: "investor_portfolios",
      record_id: portfolio_id,
      metadata: {
        partner_id: partnerId,
        wallet_owner_id: walletOwnerId,
        wallet_owner_label: walletOwnerLabel,
        amount: topupAmount,
        current_capital: Number(portfolio.investment_amount),
        payment_method,
        fund_source: fundSource,
        notes: safeNotes,
        status: "approved",
        wallet_balance_before: walletBalance,
        wallet_balance_after: walletBalance - topupAmount,
      },
    });

    // ── 5. Notify partner ──
    await supabase.from("notifications").insert({
      user_id: partnerId,
      title: "💰 Portfolio Top-Up Processed",
      message: `UGX ${topupAmount.toLocaleString()} deducted from ${walletOwnerLabel.toLowerCase()} for "${accountLabel}". Capital will be applied at maturity.`,
      type: "info",
      metadata: { portfolio_id, amount: topupAmount, payment_method, status: "approved", source: walletOwnerLabel },
    });

    // ── 6. Notify executives (non-blocking) ──
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
              title: "📊 Portfolio Top-Up (Pre-Approved)",
              message: `UGX ${topupAmount.toLocaleString()} from ${walletOwnerLabel} → "${accountLabel}" (${portfolio.portfolio_code}). Instant deduction — applied at maturity.`,
              type: "info",
              metadata: { portfolio_id, amount: topupAmount, payment_method, portfolio_code: portfolio.portfolio_code, initiated_by: user.id },
            }))
          );
        }
      }
    } catch (notifErr) {
      console.error("[manager-portfolio-topup] Executive notification error (non-blocking):", notifErr);
    }

    console.log(`[manager-portfolio-topup] ${user.id} instant ${payment_method} top-up ${topupAmount} for portfolio ${portfolio_id} (wallet owner: ${walletOwnerId})`);

    // Partnership Top-Up email — target = partner (not the manager actor)
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
          "manager-portfolio-topup",
        );
      }
    } catch (emailErr) {
      console.warn("[manager-portfolio-topup] Email lookup failed (non-blocking):", emailErr);
    }

    // Fire-and-forget notifications
    fetch(`${supabaseUrl}/functions/v1/notify-managers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceKey}` },
      body: JSON.stringify({ title: "📊 Portfolio Top-Up", body: `UGX ${topupAmount.toLocaleString()} ${walletOwnerLabel} → ${accountLabel} (${portfolio.portfolio_code})`, url: "/dashboard/manager" }),
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
      payment_method,
      source_wallet: walletOwnerLabel,
      current_capital: Number(portfolio.investment_amount),
      portfolio_code: portfolio.portfolio_code,
    }, 200);

  } catch (error) {
    console.error("[manager-portfolio-topup] Error:", error);
    return jsonRes({ error: "Internal server error" }, 500);
  }
});
