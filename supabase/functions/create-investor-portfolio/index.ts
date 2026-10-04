import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isValidInvestmentAmount, MIN_INVESTMENT_ERROR_PORTFOLIO } from "../_shared/investmentAmount.ts";
import {
  buildPartnershipAgreementRequest,
  buildPartnerCompoundCreationRequest,
  dispatchTransactionalEmail,
} from "../_shared/partnership-emails.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No authorization header" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Dual-client pattern for auth verification
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    // Verify role (agent, manager, coo, super_admin, operations)
    const { data: roleData } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .in("role", ["agent", "manager", "coo", "super_admin", "operations"]);

    if (!roleData || roleData.length === 0) {
      return new Response(JSON.stringify({ error: "Only authorized roles can create investor portfolios" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Only attribute `agent_id` to the creator when they are acting as a field agent
    // for the partner. COO / Partner Ops / manager / operations / super_admin are
    // back-office creators — they must NOT own the portfolio, otherwise it shows
    // up under their personal portfolio list as well as the partner's.
    const creatorRoles = (roleData || []).map(r => r.role);
    const backOfficeRoles = ['manager', 'coo', 'super_admin', 'operations'];
    const creatorIsBackOffice = creatorRoles.some(r => backOfficeRoles.includes(r));
    // Back-office staff may also carry the agent role. In that case the action
    // is still a back-office portfolio creation, so the staff member must not
    // become the portfolio owner and the wallet deduction must be instant.
    const creatorIsFieldAgent = creatorRoles.includes('agent') && !creatorIsBackOffice;

    let body: Record<string, unknown>;
    try { body = await req.json(); } catch {
      return new Response(JSON.stringify({ error: "Invalid request body" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Validate required fields
    const investmentAmount = typeof body.investment_amount === 'number' && Number.isFinite(body.investment_amount) ? body.investment_amount : null;
    const durationMonths = typeof body.duration_months === 'number' && [3, 6, 12].includes(body.duration_months) ? body.duration_months : null;
    const roiPercentage = typeof body.roi_percentage === 'number' && body.roi_percentage > 0 && body.roi_percentage <= 100 ? body.roi_percentage : 15;
    const roiMode = typeof body.roi_mode === 'string' && ['monthly_payout', 'monthly_compounding'].includes(body.roi_mode) ? body.roi_mode : 'monthly_payout';
    const portfolioPin = typeof body.portfolio_pin === 'string' && /^\d{4}$/.test(body.portfolio_pin) ? body.portfolio_pin : null;
    const inviteId = typeof body.invite_id === 'string' && body.invite_id.length > 0 ? body.invite_id : null;
    const investorId = typeof body.investor_id === 'string' && body.investor_id.length > 0 ? body.investor_id : null;
    const payoutDay = typeof body.payout_day === 'number' && body.payout_day >= 1 && body.payout_day <= 31 ? body.payout_day : 15;
    // Partner-selected contribution/start date (YYYY-MM-DD). Anchors the
    // compounding projection in the "New Account Compound" email so the
    // schedule reflects the real start date, not the server clock.
    const contributionDate = typeof body.contribution_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.contribution_date)
      ? body.contribution_date
      : null;
    const instantDeduct = creatorIsBackOffice && !!investorId;

    if (creatorIsBackOffice && investorId && !inviteId) {
      return new Response(JSON.stringify({
        error: "Direct back-office portfolio creation is retired. Send a portfolio invite so the partner reviews, completes details and signs before Ops approval.",
      }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Explicit "fund from any user" mode ──
    // Back-office creators may deploy capital from ANY user's wallet (e.g. a
    // partner pooling on behalf of someone), choosing the bucket to draw from.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const explicitFundingUserId =
      typeof body.funding_user_id === 'string' && UUID_RE.test(body.funding_user_id)
        ? body.funding_user_id
        : null;
    const fundSource: 'withdrawable' | 'float' = body.fund_source === 'float' ? 'float' : 'withdrawable';

    // Payment method fields
    const paymentMethod = typeof body.payment_method === 'string' && ['mobile_money', 'bank'].includes(body.payment_method) ? body.payment_method : null;
    const mobileNetwork = typeof body.mobile_network === 'string' && ['mtn', 'airtel'].includes(body.mobile_network) ? body.mobile_network : null;
    const mobileMoneyNumber = typeof body.mobile_money_number === 'string' ? body.mobile_money_number.trim().slice(0, 20) : null;
    const bankName = typeof body.bank_name === 'string' ? body.bank_name.trim().slice(0, 100) : null;
    const accountName = typeof body.account_name === 'string' ? body.account_name.trim().slice(0, 200) : null;
    const accountNumber = typeof body.account_number === 'string' ? body.account_number.trim().slice(0, 50) : null;

    if (!isValidInvestmentAmount(investmentAmount)) {
      return new Response(JSON.stringify({ error: MIN_INVESTMENT_ERROR_PORTFOLIO }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!durationMonths) {
      return new Response(JSON.stringify({ error: "Duration must be 3, 6, or 12 months" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!portfolioPin) {
      return new Response(JSON.stringify({ error: "A 4-digit portfolio PIN is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Generate portfolio code via DB function
    const { data: codeData, error: codeError } = await adminClient.rpc('generate_portfolio_code');
    if (codeError || !codeData) {
      console.error("Portfolio code generation error:", codeError);
      return new Response(JSON.stringify({ error: "Failed to generate portfolio code" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const now = new Date();
    const maturityDate = new Date(now);
    maturityDate.setMonth(maturityDate.getMonth() + durationMonths);

    const nextRoiDate = new Date(now);
    nextRoiDate.setDate(nextRoiDate.getDate() + 30);

    const { data: portfolio, error: insertError } = await adminClient
      .from("investor_portfolios")
      .insert({
        investor_id: investorId,
        invite_id: inviteId,
        // agent_id is the field-agent owner. For back-office creators
        // (COO / Partner Ops / manager / operations / super_admin) we
        // attribute it to the partner themselves so it does NOT show
        // under the staff member's portfolio list.
        agent_id: creatorIsFieldAgent ? user.id : (investorId || user.id),
        portfolio_code: codeData,
        investment_amount: investmentAmount,
        duration_months: durationMonths,
        roi_percentage: roiPercentage,
        roi_mode: roiMode,
        payment_method: paymentMethod,
        mobile_network: mobileNetwork,
        mobile_money_number: mobileMoneyNumber,
        bank_name: bankName,
        account_name: accountName,
        account_number: accountNumber,
        portfolio_pin: portfolioPin,
        payout_day: payoutDay,
        maturity_date: maturityDate.toISOString().split('T')[0],
        next_roi_date: nextRoiDate.toISOString().split('T')[0],
        status: instantDeduct ? 'active' : 'pending_approval',
      })
      .select()
      .single();

    if (insertError) {
      console.error("Portfolio insert error:", insertError);
      return new Response(JSON.stringify({ error: "Failed to create portfolio", details: insertError.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const txGroupId = crypto.randomUUID();
    const agentProfile = await adminClient.from("profiles").select("full_name").eq("id", user.id).single();
    const agentName = agentProfile.data?.full_name || "Agent";

    // ── Back-office instant-deduct path ──
    // When a back-office creator (manager / COO / super_admin / operations) creates
    // a portfolio for an explicit partner (investorId), the money already lives in
    // the partner's wallet. Skip the approval queue and deduct the wallet
    // immediately via ledger — same pattern as coo-wallet-to-portfolio.
    if (instantDeduct) {
      // ── MANAGED-PROXY HARD GUARDRAIL ──
      // If the partner is managed by a proxy agent (is_managed_account=true),
      // funds MUST be debited from the proxy agent's wallet — not the
      // partner's. Server-side override so no client path can bypass it.
      // EXCEPTION: when the operator explicitly funds from an arbitrary user's
      // wallet (`funding_user_id`), they have deliberately chosen the source,
      // so the managed-proxy override is skipped.
      let fundingUserId: string = explicitFundingUserId || investorId!;
      let fundingLabel = explicitFundingUserId && explicitFundingUserId !== investorId ? "user_wallet" : "partner";
      let managedAgentName: string | null = null;
      let fundingUserName: string | null = null;
      if (fundingLabel === "user_wallet") {
        const { data: fp } = await adminClient
          .from("profiles").select("full_name").eq("id", fundingUserId).maybeSingle();
        fundingUserName = fp?.full_name ?? null;
      } else {
        const { data: managed } = await adminClient
          .from("proxy_agent_assignments")
          .select("agent_id")
          .eq("beneficiary_id", investorId)
          .eq("is_active", true)
          .eq("is_managed_account", true)
          .eq("approval_status", "approved")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (managed?.agent_id) {
          fundingUserId = managed.agent_id;
          fundingLabel = "proxy_agent";
          const { data: ap } = await adminClient
            .from("profiles").select("full_name").eq("id", managed.agent_id).maybeSingle();
          managedAgentName = ap?.full_name ?? null;
          console.warn(
            `[create-investor-portfolio] Managed-proxy override: partner=${investorId} ` +
            `funding from proxy agent=${managed.agent_id}`,
          );
        }
      }

      // Verify funding wallet has the funds (bucket-aware).
      const { data: wallet, error: wErr } = await adminClient
        .from("wallets")
        .select("balance, withdrawable_balance, float_balance")
        .eq("user_id", fundingUserId)
        .single();

      const bucketBal = fundSource === "float"
        ? Number(wallet?.float_balance ?? 0)
        : Number(wallet?.withdrawable_balance ?? 0);

      if (wErr || !wallet || bucketBal < investmentAmount) {
        await adminClient.from("investor_portfolios").delete().eq("id", portfolio.id);
        const who = fundingLabel === "proxy_agent"
          ? `proxy agent (${managedAgentName || "linked agent"})`
          : fundingLabel === "user_wallet"
            ? `user (${fundingUserName || "selected user"})`
            : "partner";
        const bucketLabel = fundSource === "float" ? "operational float" : "personal deposit";
        return new Response(JSON.stringify({
          error: `Insufficient ${who} ${bucketLabel} balance. Available: UGX ${bucketBal.toLocaleString()}`,
        }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Double-entry ledger:
      //  • Wallet leg  → funding user cash_out (withdrawable bucket) — actually deducts the wallet
      //  • Platform leg → actor cash_in, ledger_scope='platform' — does NOT touch the partner wallet
      // (Mirrors the cfo-direct-credit debit pattern.)
      const refId = `WPF-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const nowIso = new Date().toISOString();
      const { error: ledgerErr } = await adminClient.rpc("create_ledger_transaction", {
        entries: [
          {
            user_id: fundingUserId,
            amount: investmentAmount,
            direction: "cash_out",
            category: "partner_funding",
            ledger_scope: "wallet",
            recipient_type: fundSource === "float" ? "operational_wallet" : "user",
            wallet_bucket: fundSource === "float" ? "float" : "withdrawable",
            routing_source: fundingLabel === "proxy_agent"
              ? "create_investor_portfolio_managed_proxy"
              : fundingLabel === "user_wallet"
                ? "create_investor_portfolio_user_wallet"
                : "create_investor_portfolio",
            description: fundingLabel === "proxy_agent"
              ? `Proxy agent wallet deduction for partner portfolio ${codeData}`
              : fundingLabel === "user_wallet"
                ? `${fundingUserName || "User"} wallet (${fundSource === "float" ? "float" : "personal deposit"}) deduction for portfolio ${codeData}`
                : `Wallet deduction for portfolio ${codeData}`,
            source_table: "investor_portfolios",
            source_id: portfolio.id,
            reference_id: refId,
            currency: "UGX",
            transaction_date: nowIso,
            linked_party: fundingLabel === "partner" ? "platform" : investorId,
          },
          {
            user_id: user.id, // actor (COO/manager/etc) — platform leg, not a wallet credit
            amount: investmentAmount,
            direction: "cash_in",
            category: "pending_portfolio_topup",
            ledger_scope: "platform",
            source_table: "investor_portfolios",
            source_id: portfolio.id,
            reference_id: refId,
            currency: "UGX",
            transaction_date: nowIso,
            description: `Capital received for portfolio ${codeData} — applied at activation`,
            linked_party: investorId,
          },
        ],
      });

      if (ledgerErr) {
        console.error("[create-investor-portfolio] LEDGER FAILURE — rolling back portfolio:", ledgerErr);
        await adminClient.from("investor_portfolios").delete().eq("id", portfolio.id);
        const ledgerMsg = (ledgerErr as any).message || 'unknown';
        const isInsufficient = /insufficient ledger balance/i.test(ledgerMsg);
        return new Response(JSON.stringify({
          error: isInsufficient
            ? `Insufficient wallet balance to fund this portfolio (UGX ${investmentAmount.toLocaleString()}). No charge was made.`
            : `Wallet deduction failed: ${ledgerMsg}. Portfolio rolled back.`,
        }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Pre-approved pending op for audit trail / topup processor
      await adminClient.from("pending_wallet_operations").insert({
        user_id: investorId,
        amount: investmentAmount,
        direction: "cash_in",
        category: "pending_portfolio_topup",
        source_table: "investor_portfolios",
        source_id: portfolio.id,
        transaction_group_id: txGroupId,
        description: fundingLabel === "proxy_agent"
          ? `Portfolio ${codeData} created by ${agentName} — funded from proxy agent (${managedAgentName || "linked"}) wallet`
          : `Portfolio ${codeData} created by ${agentName} — instant wallet deduction`,
        reference_id: codeData,
        linked_party: "platform",
        status: "approved",
        operation_type: "portfolio_creation",
        metadata: {
          initiated_by: user.id,
          initiated_by_role: creatorRoles[0],
          agent_name: agentName,
          portfolio_code: codeData,
          roi_percentage: roiPercentage,
          duration_months: durationMonths,
          pre_approved: true,
          source: fundingLabel === "proxy_agent" ? "proxy_agent_wallet" : fundingLabel === "user_wallet" ? "user_wallet" : "wallet",
          fund_source: fundSource,
          funding_user_id: fundingUserId,
          funding_user_name: fundingUserName,
          managed_proxy_agent_id: fundingLabel === "proxy_agent" ? fundingUserId : null,
          managed_proxy_agent_name: managedAgentName,
          wallet_balance_before: Number(wallet.balance),
        },
      });

      await adminClient.from("audit_logs").insert({
        user_id: user.id,
        action_type: fundingLabel === "proxy_agent"
          ? "create_portfolio_instant_proxy_agent_deduct"
          : fundingLabel === "user_wallet"
            ? "create_portfolio_instant_user_wallet_deduct"
            : "create_portfolio_instant_wallet_deduct",
        table_name: "investor_portfolios",
        record_id: portfolio.id,
        metadata: {
          partner_id: investorId,
          funding_user_id: fundingUserId,
          funding_source: fundingLabel,
          fund_source: fundSource,
          funding_user_name: fundingUserName,
          managed_proxy_agent_name: managedAgentName,
          amount: investmentAmount,
          portfolio_code: codeData,
          wallet_balance_before: Number(wallet.balance),
          wallet_balance_after: Number(wallet.balance) - investmentAmount,
        },
      });

      console.log(
        `Portfolio ${codeData} created with INSTANT wallet deduction: ${investmentAmount} UGX ` +
        `from ${fundingLabel}=${fundingUserId} (partner ${investorId}).`,
      );
    } else {
      // Original path: agent-created or no partner — queue for approval
      const { error: pendingErr } = await adminClient.from("pending_wallet_operations").insert({
        user_id: investorId || user.id,
        amount: investmentAmount,
        direction: "cash_in",
        category: "supporter_facilitation_capital",
        source_table: "investor_portfolios",
        source_id: portfolio.id,
        transaction_group_id: txGroupId,
        description: `Portfolio ${codeData} created by ${agentName}. UGX ${investmentAmount.toLocaleString()} investment pending approval.`,
        reference_id: codeData,
        linked_party: agentName,
        metadata: {
          agent_id: user.id,
          agent_name: agentName,
          portfolio_code: codeData,
          roi_percentage: roiPercentage,
          duration_months: durationMonths,
        },
      });

      if (pendingErr) {
        console.error("Pending wallet op insert failed:", pendingErr);
        await adminClient.from("investor_portfolios").delete().eq("id", portfolio.id);
        return new Response(JSON.stringify({ error: "Failed to queue for approval, portfolio rolled back." }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      console.log(`Portfolio ${codeData} created (pending_approval): ${investmentAmount} UGX, ${durationMonths}mo, ${roiMode}. Queued for manager approval.`);
    }

    // ── Partner email — fire-and-forget, target = the partner (investorId) ──
    // When the partner chose the COMPOUNDING ROI mode we send the rich compound
    // breakdown email (same flow as the compound email template). Monthly-payout
    // partners get the standard partnership-agreement email.
    if (investorId) {
      try {
        const { data: partnerProfile } = await adminClient
          .from("profiles")
          .select("email, full_name")
          .eq("id", investorId)
          .maybeSingle();
    const contributionIso = contributionDate ? new Date(`${contributionDate}T00:00:00Z`).toISOString() : now.toISOString();
        // Anchor the first monthly payout to the partner's contribution date +
        // payout day (one month after the contribution), not the server clock.
        // Keeps the "first payment date" in the email accurate to the real
        // schedule the partner agreed to.
        const firstPayout = new Date(contributionIso);
        firstPayout.setUTCMonth(firstPayout.getUTCMonth() + 1);
        firstPayout.setUTCDate(payoutDay);
        const firstPayoutIso = firstPayout.toISOString();
        if (partnerProfile?.email) {
          const emailRequest = roiMode === "monthly_compounding"
              ? buildPartnerCompoundCreationRequest({
                recipientEmail: partnerProfile.email,
                partnerName: partnerProfile.full_name,
                partnerId: investorId,
                portfolioId: portfolio.id,
                initialAmount: investmentAmount as number,
                roiPercentage,
                contributionDateIso: contributionIso,
              })
            : buildPartnershipAgreementRequest({
                recipientEmail: partnerProfile.email,
                partnerName: partnerProfile.full_name,
                partnerId: investorId,
                portfolioId: portfolio.id,
                amount: investmentAmount as number,
                monthlyReward: Math.round((investmentAmount as number) * (roiPercentage / 100)),
                contributionDateIso: contributionIso,
                firstPayoutDateIso: firstPayoutIso,
                payoutDay,
                roiPercentage,
              });
          dispatchTransactionalEmail(
            supabaseUrl,
            supabaseServiceKey,
            emailRequest,
            "create-investor-portfolio",
          );
        }
      } catch (emailErr) {
        console.warn("[create-investor-portfolio] Partner email lookup failed (non-blocking):", emailErr);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      portfolio: {
        id: portfolio.id,
        portfolio_code: portfolio.portfolio_code,
        activation_token: portfolio.activation_token,
        investment_amount: portfolio.investment_amount,
        duration_months: portfolio.duration_months,
        roi_percentage: portfolio.roi_percentage,
        roi_mode: portfolio.roi_mode,
        maturity_date: portfolio.maturity_date,
        next_roi_date: portfolio.next_roi_date,
      },
    }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error: any) {
    console.error("Error creating portfolio:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal server error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
