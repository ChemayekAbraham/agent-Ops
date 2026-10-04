import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendSMS } from "../_shared/sendSmsMultiProvider.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function formatUGX(n: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(n));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const auth = req.headers.get("Authorization");
    if (!auth) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { user_id, amount, tid, transaction_group_id } = await req.json();
    if (!user_id || !amount || Number(amount) <= 0) {
      return new Response(JSON.stringify({ error: "Missing user_id/amount" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: profile } = await admin
      .from("profiles")
      .select("id, full_name, phone")
      .eq("id", user_id)
      .maybeSingle();

    const phone = profile?.phone;
    const name = (profile?.full_name || "Agent").split(" ")[0];

    if (!phone) {
      return new Response(JSON.stringify({ success: true, sms_sent: false, reason: "no_phone" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const msg =
      `Hi ${name}, UGX ${formatUGX(Number(amount))} has been credited to your ` +
      `Welile float wallet (MoMo TID ${tid}). — Welile`;

    const sent = await sendSMS(phone, msg, {
      admin,
      source: "notify-manual-float-credit",
      reference_id: transaction_group_id ?? tid ?? null,
      recipient_user_id: profile?.id ?? user_id,
      recipient_name: profile?.full_name ?? null,
      idempotencyKey: tid ? `manual-float-credit-${tid}` : null,
    }).catch((e) => {
      console.error("[notify-manual-float-credit] SMS failed:", (e as Error).message);
      return false;
    });

    return new Response(JSON.stringify({ success: true, sms_sent: sent }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[notify-manual-float-credit] Error:", err);
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});