// Landlord Payout Disbursement Engine — OTP-triggered, manual via Financial Ops.
// Phase 2: deduct float and route to Financial Ops queue. No MoMo gateway calls.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logSystemEvent } from "../_shared/eventLogger.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const OTP_FRESHNESS_SECONDS = 120;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE);

  try {
    // Auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userErr } = await adminClient.auth.getUser(token);
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const agentId = userData.user.id;

    const body = await req.json().catch(() => ({}));
    const {
      rent_request_id,
      landlord_id,
      tenant_id,
      amount,
      // landlord_phone/landlord_name deliberately NOT trusted from the client —
      // see verifiedChallenge.landlord_phone below. Taking the client's value
      // here would let a payout be sent to a DIFFERENT number than the one the
      // landlord actually OTP-verified.
      mobile_money_provider,
      otp_verified_at,
      agent_latitude,
      agent_longitude,
      property_latitude,
      property_longitude,
      gps_distance_meters,
      gps_match,
    } = body ?? {};

    if (!rent_request_id || !landlord_id || !amount || !mobile_money_provider) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Landlord OTP is MANDATORY ────────────────────────────────────────
    // A payout may only be created off a challenge row this agent actually
    // had verified by the landlord. Previously `otp_verified_at` was trusted
    // from the request body and silently defaulted to `now()`, so a caller
    // could disburse landlord float with no OTP at all.
    //
    // `landlord_phone`/`landlord_name` are pulled from THIS row, not the
    // request body — it's the number the OTP was actually sent to and
    // verified against, and money must go to that exact number.
    const { data: verifiedChallenge, error: chErr } = await adminClient
      .from("landlord_payout_otp_challenges")
      .select("id, verified_at, amount, landlord_id, rent_request_id, landlord_phone, landlord_name")
      .eq("agent_id", agentId)
      .eq("landlord_id", landlord_id)
      .eq("status", "verified")
      .not("verified_at", "is", null)
      .order("verified_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (chErr) {
      console.error("[landlord-payout-disburse] challenge lookup failed:", chErr);
      return new Response(
        JSON.stringify({ error: "Could not confirm landlord OTP verification. Try again." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (!verifiedChallenge?.verified_at) {
      return new Response(
        JSON.stringify({
          error:
            "Landlord OTP verification is required before any money can be sent. Send the OTP to the landlord and enter the code they receive.",
        }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Freshness is measured against the SERVER-side verification timestamp.
    const otpTime = new Date(verifiedChallenge.verified_at).getTime();
    const ageSeconds = (Date.now() - otpTime) / 1000;
    if (ageSeconds > OTP_FRESHNESS_SECONDS) {
      return new Response(
        JSON.stringify({ error: "OTP verification expired (older than 2 minutes). Re-verify." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const verifiedPhone = (verifiedChallenge.landlord_phone || "").trim();
    if (!verifiedPhone) {
      return new Response(
        JSON.stringify({ error: "The verified OTP challenge has no landlord phone on record. Re-verify." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const verifiedName = verifiedChallenge.landlord_name || "Landlord";

    // Duplicate guard (app-level): block a second payout for the same rent request
    // when one already exists in any non-failed state. This prevents paying the
    // same tenant's landlord twice. Failed payouts are allowed to be retried.
    const { data: existingPayouts, error: dupErr } = await adminClient
      .from("landlord_payouts")
      .select("id, status")
      .eq("rent_request_id", rent_request_id)
      .not("status", "in", "(failed)");
    if (dupErr) {
      console.error("[landlord-payout-disburse] duplicate check failed:", dupErr);
    } else if (existingPayouts && existingPayouts.length > 0) {
      return new Response(
        JSON.stringify({
          error: "A landlord payout for this tenant has already been processed.",
          existing_payout_id: existingPayouts[0].id,
          existing_status: existingPayouts[0].status,
        }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Pre-flight: ensure the agent has enough UN-RESERVED LP payout float to
    // cover this request. We do NOT debit here — the actual debit happens
    // when Financial Ops approves the merchant payout and sends the money.
    // Reserved = balance − sum(amount) of already in-flight landlord_payouts.
    const { data: availableRaw, error: availErr } = await adminClient.rpc(
      "get_agent_lp_float_available",
      { p_agent_id: agentId },
    );
    if (availErr) {
      console.error("[landlord-payout-disburse] availability check failed:", availErr);
      return new Response(
        JSON.stringify({ error: `Float availability check failed: ${availErr.message}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const availableFloat = Number(availableRaw ?? 0);
    if (availableFloat < Number(amount)) {
      return new Response(
        JSON.stringify({
          error: `Insufficient Agent Landlord Payout Float. Available UGX ${availableFloat.toLocaleString()}, requested UGX ${Number(amount).toLocaleString()}. Includes UGX already reserved by pending landlord payouts.`,
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Insert payout row (eligibility trigger validates cutoff/float/landlord)
    const { data: payout, error: insertErr } = await adminClient
      .from("landlord_payouts")
      .insert({
        agent_id: agentId,
        landlord_id,
        tenant_id: tenant_id ?? null,
        rent_request_id,
        amount,
        landlord_phone: verifiedPhone,
        landlord_name: verifiedName,
        mobile_money_provider,
        otp_verified_at: new Date(otpTime).toISOString(),
        status: "otp_verified",
        agent_latitude: agent_latitude ?? null,
        agent_longitude: agent_longitude ?? null,
        property_latitude: property_latitude ?? null,
        property_longitude: property_longitude ?? null,
        gps_match: gps_match ?? null,
        gps_distance_meters: gps_distance_meters ?? null,
      })
      .select()
      .single();

    if (insertErr || !payout) {
      console.error("[landlord-payout-disburse] insert failed:", insertErr);
      return new Response(
        JSON.stringify({ error: insertErr?.message ?? "Eligibility check failed" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    await logSystemEvent(
      adminClient,
      "landlord_payout_initiated",
      agentId,
      "landlord_payout",
      payout.id,
      { amount, landlord_id },
    );

    // Route the landlord payout into the merchant Cash / Mobile Money / Bank
    // payout queue for Financial Ops. The Agent Landlord Payout Float is NOT
    // debited here — only reserved (see availability check above). It is
    // debited by `approve-withdrawal` at the moment FinOps records the MoMo
    // reference and actually sends the money to the landlord's phone. If
    // FinOps rejects, nothing needs to be refunded because nothing left the
    // ring-fenced bucket.
    const payoutReason =
      `Landlord float payout — ${verifiedName} (${verifiedPhone})`;
    const { data: wrRow, error: wrErr } = await adminClient
      .from("withdrawal_requests")
      .insert({
        user_id: agentId,
        amount,
        status: "pending",
        payout_method: "mobile_money",
        mobile_money_provider,
        mobile_money_number: verifiedPhone,
        mobile_money_name: verifiedName,
        reason: payoutReason,
        landlord_payout_id: payout.id,
      } as any)
      .select("id")
      .single();

    if (wrErr || !wrRow) {
      // Could not surface to FinOps queue — fail the payout row. No refund
      // needed because the float was never debited.
      console.error("[landlord-payout-disburse] withdrawal_requests insert failed:", wrErr);
      await adminClient.from("landlord_payouts").update({
        status: "failed",
        last_error: `Merchant queue insert failed: ${wrErr?.message ?? "unknown"}`,
      }).eq("id", payout.id);
      return new Response(
        JSON.stringify({ error: `Failed to queue payout for merchant: ${wrErr?.message ?? "unknown"}`, payout_id: payout.id }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    await adminClient
      .from("landlord_payouts")
      .update({ status: "pending_merchant_payout" })
      .eq("id", payout.id);

    await logSystemEvent(
      adminClient,
      "landlord_payout_pending_merchant",
      agentId,
      "landlord_payout",
      payout.id,
      { amount, landlord_id, landlord_phone: verifiedPhone, mobile_money_provider, withdrawal_request_id: wrRow.id },
    );

    // Notify agent that the request is now in the merchant payout queue (best-effort)
    try {
      await adminClient.from("notifications").insert({
        user_id: agentId,
        type: "landlord_payout_pending_merchant",
        title: "Sent to merchant payout queue",
        message: `Your landlord payout of UGX ${Number(amount).toLocaleString()} for ${verifiedName} is now in the Cash, Mobile Money & Bank payout queue for a merchant agent to fulfil.`,
        metadata: { payout_id: payout.id, amount, withdrawal_request_id: wrRow.id },
      });
    } catch { /* non-blocking */ }

    return new Response(JSON.stringify({
      ok: true,
      payout_id: payout.id,
      withdrawal_request_id: wrRow.id,
      status: "pending_merchant_payout",
      message: "Sent to the merchant payout queue. You'll be notified when the landlord is paid.",
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[landlord-payout-disburse] fatal:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
