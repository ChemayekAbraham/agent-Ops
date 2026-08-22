import { createClient } from "npm:@supabase/supabase-js@2";
import { runShadowAudit } from "../_shared/shadowLogger.ts";
import { shadowValidatePoolFunding } from "../_shared/shadowValidation.ts";
import { fetchShadowConfig, shouldSample } from "../_shared/shadowConfig.ts";
import { buildPartnershipEmailRequest } from "./partnership-email.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const adminClient = createClient(supabaseUrl, supabaseServiceKey);

  // Fetch shadow config once (cached 60s)
  const shadowConfig = await fetchShadowConfig(adminClient);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Enforce supporter role
    const { data: userRoles } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .or("enabled.is.null,enabled.eq.true");

    const roles = (userRoles || []).map((r: any) => r.role);
    if (!roles.includes("supporter")) {
      if (shouldSample(shadowConfig)) {
        runShadowAudit('fund-rent-pool', { userId: user.id }, false,
          () => shadowValidatePoolFunding({ amount: 0, callerRoles: roles }), adminClient);
      }
      return new Response(
        JSON.stringify({ error: "Only supporter accounts can fund rent requests. Please use a dedicated supporter account." }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { amount, summary_id } = await req.json() as {
      amount: number;
      summary_id: string;
    };

    if (!amount || amount <= 0) {
      if (shouldSample(shadowConfig)) {
        runShadowAudit('fund-rent-pool', { amount, userId: user.id }, false,
          () => shadowValidatePoolFunding({ amount, callerRoles: roles }), adminClient);
      }
      return new Response(
        JSON.stringify({ error: "Invalid amount" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Phase 5: Shadow audit on success path — sampled
    if (shouldSample(shadowConfig)) {
      runShadowAudit('fund-rent-pool', { amount, userId: user.id },
        true, () => shadowValidatePoolFunding({ amount, callerRoles: roles }), adminClient);
    }

    const payout_day = new Date().getDate();

    // Check wallet balance with optimistic locking
    const { data: wallet, error: walletErr } = await adminClient
      .from("wallets")
      .select("id, balance")
      .eq("user_id", user.id)
      .single();

    if (walletErr || !wallet) {
      return new Response(
        JSON.stringify({ error: "Wallet not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (wallet.balance < amount) {
      return new Response(
        JSON.stringify({ error: "Insufficient balance" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Generate reference ID
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const seq = String(Math.floor(1000 + Math.random() * 9000));
    const referenceId = `WRF${yy}${mm}${dd}${seq}`;

    // Calculate first payout date: strict 30-day cycle from investment date
    const firstPayoutMs = now.getTime() + 30 * 24 * 60 * 60 * 1000;
    const candidate = new Date(firstPayoutMs);
    const firstPayoutDate = `${candidate.getFullYear()}-${String(candidate.getMonth() + 1).padStart(2, "0")}-${String(candidate.getDate()).padStart(2, "0")}`;

    // Partner capital is no longer activated instantly: create an INACTIVE
    // portfolio awaiting Partner Ops approval. No ledger legs, no wallet
    // movement until approval.
    const { data: pending, error: pendingErr } = await userClient.rpc(
      "funder_create_pending_portfolio",
      { p_amount: amount, p_summary_id: summary_id ?? null, p_term_months: 12 },
    );

    if (pendingErr) {
      const msg = pendingErr.message?.includes("AGREEMENT_REQUIRED")
        ? "Sign your partner agreement before creating a portfolio."
        : pendingErr.message || "Could not submit your portfolio for approval.";
      return new Response(
        JSON.stringify({ error: msg }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    await adminClient.from("notifications").insert({
      user_id: user.id,
      title: "Portfolio submitted for approval",
      message: `Your commitment of UGX ${amount.toLocaleString()} has been submitted to Partner Operations for review. Your money stays in your wallet until it is approved.`,
      type: "info",
      metadata: { amount, reference_id: referenceId, status: "pending_ops_approval", pending: pending },
    });

    // Email the partner a submission confirmation. Previously this path sent no
    // email at all, so partners saw "Pending Ops approval" with no notice.
    try {
      const { data: partnerProfile } = await adminClient
        .from("profiles")
        .select("full_name, email")
        .eq("id", user.id)
        .maybeSingle();
      const partnerEmail = partnerProfile?.email || user.email;
      if (partnerEmail) {
        await fetch(`${supabaseUrl}/functions/v1/send-transactional-email`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${supabaseServiceKey}`,
          },
          body: JSON.stringify({
            recipientEmail: partnerEmail,
            templateName: "portfolio-request-confirmation",
            userId: user.id,
            data: {
              partner_name: partnerProfile?.full_name || "Partner",
              portfolio_name: "Rent Pool Partnership Portfolio",
              portfolio_id: (pending as { portfolio_code?: string } | null)?.portfolio_code ?? "",
              portfolio_value: amount,
              request_type: "NEW_PORTFOLIO_REQUEST",
              request_reference: referenceId,
              submitted_at: new Date().toISOString().slice(0, 10),
              currency: "UGX",
            },
          }),
        });
      }
    } catch (mailErr) {
      console.error("[fund-rent-pool] confirmation email failed:", mailErr);
    }

    fetch(`${supabaseUrl}/functions/v1/notify-managers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${supabaseServiceKey}` },
      body: JSON.stringify({ title: "Portfolio awaiting approval", body: "A partner submitted a new portfolio for review", url: "/dashboard/partner-ops" }),
    }).catch(() => {});

    return new Response(
      JSON.stringify({
        success: true,
        pending: true,
        status: "pending_ops_approval",
        reference_id: referenceId,
        portfolio: pending,
        message: "Submitted to Partner Operations for approval. Your funds stay in your wallet until approved.",
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[fund-rent-pool] Error:", msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
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
