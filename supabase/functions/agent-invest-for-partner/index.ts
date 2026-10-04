import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildPartnershipAgreementRequest, dispatchTransactionalEmail } from "../_shared/partnership-emails.ts";
import { isValidInvestmentAmount, MIN_INVESTMENT_ERROR } from "../_shared/investmentAmount.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const JSON_HEADERS = { ...corsHeaders, "Content-Type": "application/json" };

function errorResponse(msg: string, status: number) {
  return new Response(JSON.stringify({ error: msg }), { status, headers: JSON_HEADERS });
}

function getOrdinalSuffix(day: number): string {
  if (day >= 11 && day <= 13) return "th";
  switch (day % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // --- Auth ---
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return errorResponse("Missing authorization header", 401);

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user: agent }, error: agentError } = await userClient.auth.getUser();
    if (agentError || !agent) return errorResponse("Unauthorized", 401);

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    // --- Verify agent role ---
    const { data: agentRole } = await adminClient
      .from("user_roles").select("id")
      .eq("user_id", agent.id).eq("role", "agent").maybeSingle();
    if (!agentRole) return errorResponse("Only agents can invest on behalf of partners", 403);

    // --- Parse & validate inputs ---
    const { partner_id, amount, summary_id, investment_reference, receipt_file_url } = await req.json() as {
      partner_id: string;
      amount: number;
      summary_id: string;
      investment_reference?: string;
      receipt_file_url?: string;
    };

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!partner_id || !uuidRegex.test(partner_id)) return errorResponse("Invalid partner ID", 400);
    if (!isValidInvestmentAmount(amount)) return errorResponse(MIN_INVESTMENT_ERROR, 400);

    // --- Verify partner is a supporter ---
    const { data: partnerRole } = await adminClient
      .from("user_roles").select("id")
      .eq("user_id", partner_id).eq("role", "supporter").maybeSingle();
    if (!partnerRole) return errorResponse("Selected user is not a registered partner/supporter", 400);

    // --- Check agent wallet balance (read-only, trigger handles updates) ---
    const { data: agentWallet, error: walletErr } = await adminClient
      .from("wallets").select("id, balance")
      .eq("user_id", agent.id).single();
    if (walletErr || !agentWallet) return errorResponse("Agent wallet not found", 404);
    if (agentWallet.balance < amount) return errorResponse("Insufficient agent balance", 400);

    // --- Generate IDs ---
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const seq = () => String(Math.floor(1000 + Math.random() * 9000));
    const referenceId = `WPR${yy}${mm}${dd}${seq()}`;
    const txGroupId = crypto.randomUUID();

    // Payout: strict 30-day cycle from investment date (default; COO can override later)
    const payout_day = now.getDate();
    const firstPayoutMs = now.getTime() + 30 * 24 * 60 * 60 * 1000;
    const candidate = new Date(firstPayoutMs);
    const firstPayoutDate = `${candidate.getFullYear()}-${String(candidate.getMonth() + 1).padStart(2, "0")}-${String(candidate.getDate()).padStart(2, "0")}`;

    // --- Get profile names ---
    const [partnerProfileRes, agentProfileRes] = await Promise.all([
      adminClient.from("profiles").select("full_name").eq("id", partner_id).single(),
      adminClient.from("profiles").select("full_name").eq("id", agent.id).single(),
    ]);
    const partnerName = partnerProfileRes.data?.full_name || "Partner";
    const agentName = agentProfileRes.data?.full_name || "Agent";

    const txDate = new Date().toISOString();

    // --- Record agent cash_out via RPC ---
    const { error: ledgerErr } = await adminClient.rpc('create_ledger_transaction', {
      entries: [
        {
          user_id: agent.id,
          amount,
          direction: "cash_out",
          category: "partner_funding",
          source_table: "investor_portfolios",
          source_id: summary_id || null,
          description: `Agent proxy investment: UGX ${amount.toLocaleString()} to Rent Management Pool on behalf of ${partnerName}`,
          currency: 'UGX',
          reference_id: referenceId,
          linked_party: "Rent Management Pool",
          ledger_scope: "wallet",
          transaction_date: txDate,
        },
        {
          user_id: agent.id,
          amount,
          direction: "cash_in",
          category: "partner_funding",
          source_table: "investor_portfolios",
          source_id: summary_id || null,
          description: `Agent proxy capital received for ${partnerName}`,
          currency: 'UGX',
          reference_id: referenceId,
          linked_party: agent.id,
          ledger_scope: "platform",
          transaction_date: txDate,
        },
      ],
    });

    if (ledgerErr) {
      return errorResponse("Failed to record transaction. Please retry.", 500);
    }

    // --- Decrement opportunity summary ---
    if (summary_id) {
      const { error: summaryErr } = await adminClient.rpc('decrement_rent_requested', {
        p_summary_id: summary_id,
        p_amount: amount,
      });
      if (summaryErr) {
        console.error("[agent-invest-for-partner] Failed to decrement opportunity summary:", summaryErr.message);
      }
    }

    // --- Look up supporter invite ---
    let inviteId: string | null = null;
    let activationToken: string | null = null;
    const { data: invite } = await adminClient
      .from("supporter_invites")
      .select("id, activation_token, status")
      .eq("activated_user_id", partner_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (invite) {
      inviteId = invite.id;
      if (invite.status !== "activated") {
        activationToken = invite.activation_token;
      }
    }

    // --- Create investor_portfolio (ACTIVE immediately) ---
    let portfolioCode = `WIP${yy}${mm}${dd}${seq()}`;
    try {
      const { data: codeData } = await adminClient.rpc('generate_portfolio_code');
      if (codeData) portfolioCode = codeData;
    } catch {
      // fallback code already set
    }

    const portfolioPin = String(Math.floor(1000 + Math.random() * 9000));
    const maturityDate = new Date(now);
    maturityDate.setMonth(maturityDate.getMonth() + 12);

    const { data: portfolio, error: portfolioErr } = await adminClient
      .from("investor_portfolios")
      .insert({
        investor_id: partner_id,
        invite_id: inviteId,
        agent_id: agent.id,
        portfolio_code: portfolioCode,
        investment_amount: amount,
        duration_months: 12,
        roi_percentage: 15,
        roi_mode: "monthly_payout",
        portfolio_pin: portfolioPin,
        payout_day: null,
        maturity_date: maturityDate.toISOString().split("T")[0],
        next_roi_date: firstPayoutDate,
        status: "active",
        investment_reference: investment_reference || null,
        receipt_file_url: receipt_file_url || null,
      })
      .select("id")
      .single();

    if (portfolioErr) {
      console.error("[agent-invest-for-partner] Portfolio creation failed:", portfolioErr.message);
      // RPC is atomic — no need for manual ledger delete rollback
      return errorResponse("Failed to create portfolio. Please retry.", 500);
    }

    // --- Direct ledger entries for instant activation via RPC (net-zero: credit then debit partner) ---
    const monthlyReward = Math.round(amount * 0.15);

    // Step 1: Credit partner wallet
    await adminClient.rpc('create_ledger_transaction', {
      entries: [
        {
          user_id: agent.id,
          amount,
          direction: "cash_out",
          category: "partner_funding",
          source_table: "investor_portfolios",
          source_id: portfolio.id,
          description: `Agent ${agentName} invested UGX ${amount.toLocaleString()} on behalf of ${partnerName}`,
          currency: 'UGX',
          reference_id: referenceId,
          linked_party: agentName,
          ledger_scope: "platform",
          transaction_date: txDate,
        },
        {
          user_id: partner_id,
          amount,
          direction: "cash_in",
          category: "partner_funding",
          source_table: "investor_portfolios",
          source_id: portfolio.id,
          description: `Agent ${agentName} invested UGX ${amount.toLocaleString()} on behalf of ${partnerName}`,
          currency: 'UGX',
          reference_id: referenceId,
          linked_party: agentName,
          ledger_scope: "wallet",
          transaction_date: txDate,
        },
      ],
    });

    // Step 2: Debit partner wallet into portfolio
    await adminClient.rpc('create_ledger_transaction', {
      entries: [
        {
          user_id: partner_id,
          amount,
          direction: "cash_out",
          category: "partner_funding",
          source_table: "investor_portfolios",
          source_id: portfolio.id,
          description: `Investment of UGX ${amount.toLocaleString()} moved to portfolio ${portfolioCode}`,
          currency: 'UGX',
          reference_id: referenceId,
          linked_party: "Rent Management Pool",
          ledger_scope: "wallet",
          transaction_date: txDate,
        },
        {
          user_id: partner_id,
          amount,
          direction: "cash_in",
          category: "partner_funding",
          source_table: "investor_portfolios",
          source_id: portfolio.id,
          description: `Partner capital received for portfolio ${portfolioCode}`,
          currency: 'UGX',
          reference_id: referenceId,
          linked_party: partner_id,
          ledger_scope: "platform",
          transaction_date: txDate,
        },
      ],
    });

    // --- Agent 2% commission — queue for approval ---
    const commission = Math.round(amount * 0.02);
    const commRefId = `WAC${yy}${mm}${dd}${seq()}`;
    const commTxGroupId = crypto.randomUUID();

    // Record agent earning
    await adminClient.from("agent_earnings").insert({
      agent_id: agent.id,
      amount: commission,
      earning_type: "proxy_investment_commission",
      description: `2% commission (UGX ${commission.toLocaleString()}) for facilitating ${partnerName}'s UGX ${amount.toLocaleString()} investment`,
      source_user_id: partner_id,
    });

    // Queue commission credit for approval
    await adminClient.from("pending_wallet_operations").insert({
      user_id: agent.id,
      amount: commission,
      direction: "cash_in",
      category: "proxy_investment_commission",
      source_table: "agent_earnings",
      transaction_group_id: commTxGroupId,
      description: `2% proxy investment commission from pool for ${partnerName}'s UGX ${amount.toLocaleString()} investment`,
      reference_id: commRefId,
      linked_party: "Rent Management Pool",
    });

    // --- Notifications ---
    await Promise.all([
      // Notify partner
      adminClient.from("notifications").insert({
        user_id: partner_id,
        title: "🎉 Your Investment is Active!",
        message: `Your agent ${agentName} facilitated UGX ${amount.toLocaleString()} on your behalf into the Rent Management Pool.\n\n✅ Your portfolio is now active!\n\n💰 You'll earn 15% (UGX ${monthlyReward.toLocaleString()}) monthly for 12 months.\n📅 First Payout: ${firstPayoutDate}\n\nPortfolio: ${portfolioCode}\nRef: ${referenceId}`,
        type: "success",
        metadata: {
          amount,
          reference_id: referenceId,
          payout_day,
          monthly_reward: monthlyReward,
          first_payout_date: firstPayoutDate,
          total_reward_12_months: monthlyReward * 12,
          proxy_agent_id: agent.id,
          proxy_agent_name: agentName,
          portfolio_code: portfolioCode,
        },
      }),
      // Notify agent
      adminClient.from("notifications").insert({
        user_id: agent.id,
        title: "✅ Partner Portfolio Activated",
        message: `You invested UGX ${amount.toLocaleString()} from your wallet on behalf of ${partnerName}. The portfolio is now active!\n\nYour 2% commission (UGX ${commission.toLocaleString()}) is pending approval.\n\nPortfolio: ${portfolioCode}\nRef: ${referenceId}`,
        type: "info",
        metadata: {
          amount,
          reference_id: referenceId,
          partner_id,
          partner_name: partnerName,
          commission,
          commission_ref: commRefId,
          balance_before: agentWallet.balance,
          portfolio_code: portfolioCode,
        },
      }),
    ]);

    console.log(`[agent-invest-for-partner] Agent ${agent.id} invested ${amount} for partner ${partner_id}. Portfolio: ${portfolioCode} (ACTIVE). Ref: ${referenceId}. TxGroup: ${txGroupId}`);

    // Partnership Agreement email — target = partner (not the agent actor)
    try {
      const { data: partnerEmailRow } = await adminClient
        .from("profiles").select("email").eq("id", partner_id).maybeSingle();
      if (partnerEmailRow?.email) {
        dispatchTransactionalEmail(
          supabaseUrl,
          supabaseServiceKey,
          buildPartnershipAgreementRequest({
            recipientEmail: partnerEmailRow.email,
            partnerName,
            partnerId: partner_id,
            portfolioId: portfolioCode,
            amount,
            monthlyReward,
            contributionDateIso: new Date().toISOString(),
            firstPayoutDateIso: firstPayoutDate,
            payoutDay: payout_day,
          }),
          "agent-invest-for-partner",
        );
      }
    } catch (emailErr) {
      console.warn("[agent-invest-for-partner] Email lookup failed (non-blocking):", emailErr);
    }

    // Notify managers (fire-and-forget)
    fetch(`${supabaseUrl}/functions/v1/notify-managers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${supabaseServiceKey}` },
      body: JSON.stringify({ title: "📊 Agent Investment Activated", body: `${agentName} activated portfolio for ${partnerName}`, url: "/dashboard/manager" }),
    }).catch(() => {});

    // Notify COO / Partner Ops users (fire-and-forget)
    adminClient.from("user_roles").select("user_id").eq("role", "coo").then(({ data: coos }) => {
      if (coos && coos.length > 0) {
        const notifications = coos.map((c: { user_id: string }) => ({
          user_id: c.user_id,
          title: "📊 New Partner Investment",
          message: `${agentName} activated a UGX ${amount.toLocaleString()} portfolio for ${partnerName}. Code: ${portfolioCode}`,
          type: "info",
        }));
        adminClient.from("notifications").insert(notifications).then(() => {});
      }
    });

    return new Response(
      JSON.stringify({
        success: true,
        reference_id: referenceId,
        amount_invested: amount,
        payout_day,
        first_payout_date: firstPayoutDate,
        monthly_reward: monthlyReward,
        partner_name: partnerName,
        activation_token: activationToken,
        agent_name: agentName,
        portfolio_code: portfolioCode,
      }),
      { status: 200, headers: JSON_HEADERS }
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[agent-invest-for-partner] Error:", msg);
    return errorResponse(msg, 500);
  }
});
