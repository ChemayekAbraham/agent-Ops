// Sends the requester a confirmation SMS the moment they submit a withdrawal
// request. Routes through the shared multi-provider chain (Yoola → Africa's
// Talking → LANA) with built-in idempotency + delivery logging.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  sendSMS,
  formatPhoneInternational,
  isUgandanPhone,
} from "../_shared/sendSmsMultiProvider.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Caller must be the signed-in user who owns the request.
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const withdrawalId = typeof body?.withdrawal_id === "string" ? body.withdrawal_id : null;
    if (!withdrawalId) {
      return new Response(JSON.stringify({ error: "withdrawal_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(supabaseUrl, serviceKey);

    const { data: w, error: wErr } = await admin
      .from("withdrawal_requests")
      .select("id, user_id, amount, payout_method, mobile_money_number, linked_party")
      .eq("id", withdrawalId)
      .maybeSingle();
    if (wErr || !w) {
      return new Response(JSON.stringify({ error: "Withdrawal not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    // Only the owner can trigger their own confirmation SMS.
    if (w.user_id !== user.id) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: profile } = await admin
      .from("profiles")
      .select("full_name, phone")
      .eq("id", w.user_id)
      .maybeSingle();

    const amount = Number(w.amount) || 0;

    // Prefer the MoMo destination for mobile-money payouts; otherwise the
    // account phone. Validate before use, falling back to the other.
    const isMobileMoney = ["mobile_money", "mtn_mobile_money", "airtel_money"].includes(
      (w as any).payout_method || "",
    );
    const rawMomo = ((w as any).mobile_money_number || "").trim();
    const momoValid = isUgandanPhone(rawMomo);
    const profilePhone = ((profile as any)?.phone || "").trim();
    const profileValid = isUgandanPhone(profilePhone);

    const recipient = isMobileMoney && momoValid
      ? formatPhoneInternational(rawMomo)
      : profileValid
        ? formatPhoneInternational(profilePhone)
        : momoValid
          ? formatPhoneInternational(rawMomo)
          : "";

    if (!recipient) {
      return new Response(
        JSON.stringify({ ok: false, sent: false, error: "No valid Ugandan phone on file" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const reference = `REQ-${String(w.id).replace(/-/g, "").slice(0, 12).toUpperCase()}`;
    const message =
      `WELILE: Withdrawal Processing. Your withdrawal request of UGX ${amount.toLocaleString()} ` +
      `(${reference}) has been received and is being processed. ` +
      `You'll be notified once the payment provider confirms delivery.`;

    const sent = await sendSMS(recipient, message, {
      admin,
      source: "withdrawal_submitted",
      reference_id: w.id,
      recipient_user_id: w.user_id,
      recipient_name: (profile as any)?.full_name ?? null,
      idempotencyKey: `withdrawal_submitted:${w.id}`,
    });

    // Proxy-partner processing SMS: for proxy withdrawals the requester is the
    // agent, so the partner (linked_party) never got a submit notice. Send
    // them their own "Processing" text so they know money is on the way but
    // not yet confirmed by the payment provider.
    let partnerSent: any = null;
    const linkedParty = (w as any).linked_party as string | null;
    if (linkedParty && linkedParty !== w.user_id) {
      try {
        const { data: partnerProfile } = await admin
          .from("profiles")
          .select("full_name, phone")
          .eq("id", linkedParty)
          .maybeSingle();
        const partnerPhoneRaw = ((partnerProfile as any)?.phone || "").trim();
        if (isUgandanPhone(partnerPhoneRaw)) {
          const partnerMsg =
            `WELILE: Withdrawal Processing. A payout of UGX ${amount.toLocaleString()} ` +
            `(${reference}) has been initiated on your behalf by your authorized Welile agent. ` +
            `You'll get a final confirmation once the payment provider confirms delivery.`;
          partnerSent = await sendSMS(formatPhoneInternational(partnerPhoneRaw), partnerMsg, {
            admin,
            source: "withdrawal_submitted_partner",
            reference_id: w.id,
            recipient_user_id: linkedParty,
            recipient_name: (partnerProfile as any)?.full_name ?? null,
            idempotencyKey: `withdrawal_submitted_partner:${w.id}`,
          });
        }
      } catch (e) {
        console.warn("[notify-withdrawal-submitted] partner SMS failed:", e);
      }
    }

    return new Response(JSON.stringify({ ok: true, sent, partnerSent }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("[notify-withdrawal-submitted] error:", err);
    return new Response(JSON.stringify({ error: err?.message || "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});