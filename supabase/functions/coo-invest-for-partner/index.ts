import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildPartnershipAgreementRequest, dispatchTransactionalEmail } from "../_shared/partnership-emails.ts";
import { isValidInvestmentAmount, MIN_INVESTMENT_ERROR } from "../_shared/investmentAmount.ts";

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
      return new Response(JSON.stringify({ error: "Missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Authenticate calling user
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user: caller }, error: callerError } = await userClient.auth.getUser();
    if (callerError || !caller) {
      return new Response(JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    // Verify caller is a manager (COO access)
    const { data: managerRole } = await adminClient
      .from("user_roles").select("id")
      .eq("user_id", caller.id).eq("role", "manager").maybeSingle();

    if (!managerRole) {
      return new Response(JSON.stringify({ error: "Only managers/COO can perform this action" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { partner_id, amount } = await req.json() as {
      partner_id: string;
      amount: number;
    };

    // Payout is auto-calculated (30-day cycle from investment date)
    const payout_day = new Date().getDate();

    // Validate inputs
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!partner_id || !uuidRegex.test(partner_id)) {
      return new Response(JSON.stringify({ error: "Invalid partner ID" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (!isValidInvestmentAmount(amount)) {
      return new Response(JSON.stringify({ error: MIN_INVESTMENT_ERROR }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Verify partner is a supporter
    const { data: partnerRole } = await adminClient
      .from("user_roles").select("id")
      .eq("user_id", partner_id).eq("role", "supporter").maybeSingle();

    if (!partnerRole) {
      return new Response(JSON.stringify({ error: "Selected user is not a registered partner/supporter" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Check PARTNER's wallet balance (read-only, trigger handles updates)
    const { data: partnerWallet, error: walletErr } = await adminClient
      .from("wallets").select("id, balance")
      .eq("user_id", partner_id).single();

    if (walletErr || !partnerWallet) {
      return new Response(JSON.stringify({ error: "Partner wallet not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (partnerWallet.balance < amount) {
      return new Response(JSON.stringify({ error: `Insufficient partner balance. Available: UGX ${partnerWallet.balance.toLocaleString()}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── Funder verification gate (BEFORE any money moves) ──
    // Self-registered funders must be approved before a portfolio is created,
    // otherwise the enforce_funder_verified_for_portfolio trigger rejects the
    // insert AFTER the wallet is debited (stranded funds + cryptic error).
    {
      const { data: funderProfile } = await adminClient
        .from("profiles")
        .select("full_name, signup_source, funder_verified_at")
        .eq("id", partner_id)
        .maybeSingle();
      if (funderProfile?.signup_source === "funder-onboarding" && !funderProfile?.funder_verified_at) {
        const nm = funderProfile?.full_name || "This partner";
        return new Response(JSON.stringify({
          error: `${nm} self-registered and is not yet verified. Approve them in Partner Ops (Verify Funder) before investing.`,
        }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    // Generate reference
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const seq = String(Math.floor(1000 + Math.random() * 9000));
    const referenceId = `WCI${yy}${mm}${dd}${seq}`;

    // Calculate first payout date: strict 30-day cycle from investment date
    const firstPayoutMs = now.getTime() + 30 * 24 * 60 * 60 * 1000;
    const candidate = new Date(firstPayoutMs);
    const firstPayoutDate = `${candidate.getFullYear()}-${String(candidate.getMonth() + 1).padStart(2, "0")}-${String(candidate.getDate()).padStart(2, "0")}`;

    // Calculate maturity date: 12 months from investment date
    const maturityDate = new Date(now);
    maturityDate.setMonth(maturityDate.getMonth() + 12);
    const maturityDateStr = `${maturityDate.getFullYear()}-${String(maturityDate.getMonth() + 1).padStart(2, "0")}-${String(maturityDate.getDate()).padStart(2, "0")}`;

    // Get names
    const partnerProfileRes = await adminClient.from("profiles").select("full_name").eq("id", partner_id).single();
    const partnerName = partnerProfileRes.data?.full_name || "Partner";

    // Record balanced ledger entries via RPC — partner funding is BOTH cash_in
    // Platform receives capital, partner wallet gets credited (external money model)
    const { data: txGroupId, error: ledgerErr } = await adminClient.rpc('create_ledger_transaction', {
      entries: [
        {
          user_id: partner_id,
          amount,
          direction: 'cash_out',
          category: 'partner_funding',
          ledger_scope: 'wallet',
          recipient_type: 'user',
          source_table: 'wallets',
          description: `Welile Operations invested UGX ${amount.toLocaleString()} from ${partnerName}'s wallet into Rent Management Pool. Payout day: ${payout_day}${getOrdinalSuffix(payout_day)}. First payout: ${firstPayoutDate}`,
          currency: 'UGX',
          reference_id: referenceId,
          linked_party: 'Rent Management Pool',
          transaction_date: new Date().toISOString(),
        },
        {
          direction: 'cash_in',
          amount,
          category: 'partner_funding',
          ledger_scope: 'platform',
          source_table: 'wallets',
          description: `Rent Management Pool received UGX ${amount.toLocaleString()} from ${partnerName} (facilitated by Welile Operations)`,
          currency: 'UGX',
          reference_id: referenceId,
          linked_party: partnerName,
          transaction_date: new Date().toISOString(),
        },
      ],
    });

    if (ledgerErr) {
      console.error("[coo-invest-for-partner] Ledger RPC failed:", ledgerErr.message);
      return new Response(JSON.stringify({ error: "Failed to record transaction. Please retry." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Generate a 4-digit portfolio PIN for the supporter
    const portfolioPin = String(Math.floor(1000 + Math.random() * 9000));

    // Create the investor portfolio record so it appears in "My Support Accounts"
    const { error: portfolioErr } = await adminClient.from("investor_portfolios").insert({
      investor_id: partner_id,
      agent_id: caller.id,
      portfolio_code: referenceId,
      investment_amount: amount,
      roi_percentage: 15,
      roi_mode: "simple",
      total_roi_earned: 0,
      status: "active",
      duration_months: 12,
      payout_day,
      next_roi_date: firstPayoutDate,
      maturity_date: maturityDateStr,
      auto_reinvest: false,
      portfolio_pin: portfolioPin,
    });

    if (portfolioErr) {
      console.error("[coo-invest-for-partner] Portfolio creation failed:", portfolioErr.message);
      // Non-fatal: ledger is source of truth, but log for ops to fix
    }

    const monthlyReward = Math.round(amount * 0.15);

    // Notify the partner
    await adminClient.from("notifications").insert({
      user_id: partner_id,
      title: "🎉 Thank You — An Investment Was Made for You!",
      message: `Great news! UGX ${amount.toLocaleString()} has been invested from your wallet by our operations team to help tenants access housing.\n\n💰 You'll earn 15% (UGX ${monthlyReward.toLocaleString()}) monthly on the ${payout_day}${getOrdinalSuffix(payout_day)} of every month for 12 months, starting ${firstPayoutDate}.\n\nThank you for being part of the Welile family! 🙏\n\nRef: ${referenceId}`,
      type: "success",
      metadata: { amount, reference_id: referenceId, payout_day, monthly_reward: monthlyReward, first_payout_date: firstPayoutDate, initiated_by: caller.id },
    });

    console.log(`[coo-invest-for-partner] COO ${caller.id} invested ${amount} from partner ${partner_id}'s wallet. Ref: ${referenceId}, TxGroup: ${txGroupId}`);

    // Partnership Agreement email — target = partner (not the COO actor)
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
            portfolioId: referenceId,
            amount,
            monthlyReward,
            contributionDateIso: new Date().toISOString(),
            firstPayoutDateIso: firstPayoutDate,
            payoutDay: payout_day,
          }),
          "coo-invest-for-partner",
        );
      }
    } catch (emailErr) {
      console.warn("[coo-invest-for-partner] Email lookup failed (non-blocking):", emailErr);
    }


    // Notify managers (fire-and-forget)
    fetch(`${supabaseUrl}/functions/v1/notify-managers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${supabaseServiceKey}` },
      body: JSON.stringify({ title: "📊 COO Investment", body: "Activity: investment for partner", url: "/dashboard/manager" }),
    }).catch(() => {});


    return new Response(
      JSON.stringify({
        success: true,
        reference_id: referenceId,
        payout_day,
        first_payout_date: firstPayoutDate,
        monthly_reward: monthlyReward,
        partner_name: partnerName,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[coo-invest-for-partner] Error:", msg);
    return new Response(JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

function getOrdinalSuffix(day: number): string {
  if (day >= 11 && day <= 13) return "th";
  switch (day % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}
