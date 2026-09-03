// Drains queued tenant self-repayment SMS notices (tenant + agent halves).
// The settlement RPC writes the queue rows; this worker only sends the SMS
// and marks each row. Same shape as tenant-rent-intake-notices.
import { createClient } from "npm:@supabase/supabase-js@2";
import { sendSMS, isUgandanPhone } from "../_shared/sendSmsMultiProvider.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const MAX_ATTEMPTS = 3;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const { data: pending, error } = await admin
      .from("tenant_self_repayment_notices")
      .select("id, deposit_request_id, recipient_role, recipient_user_id, phone, sms_text, attempts")
      .eq("sms_status", "pending")
      .lt("attempts", MAX_ATTEMPTS)
      .order("created_at", { ascending: true })
      .limit(100);
    if (error) throw error;

    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const n of pending || []) {
      const phone = (n.phone || "").trim();
      if (!phone || !isUgandanPhone(phone)) {
        skipped++;
        await admin
          .from("tenant_self_repayment_notices")
          .update({ sms_status: "skipped", last_error: "no_valid_phone" })
          .eq("id", n.id);
        continue;
      }

      const ref = `tsr-${n.deposit_request_id}-${n.recipient_role}`;
      let ok = false;
      let errMsg: string | null = null;
      try {
        ok = await sendSMS(phone, n.sms_text, {
          admin,
          source: "tenant_self_repayment",
          recipient_user_id: n.recipient_user_id,
          reference_id: ref,
          idempotencyKey: ref,
        });
      } catch (e) {
        errMsg = (e as Error)?.message || "send_error";
      }

      const attempts = (n.attempts || 0) + 1;
      if (ok) {
        sent++;
        await admin
          .from("tenant_self_repayment_notices")
          .update({
            sms_status: "sent",
            sent_at: new Date().toISOString(),
            attempts,
            last_error: null,
          })
          .eq("id", n.id);
      } else {
        failed++;
        await admin
          .from("tenant_self_repayment_notices")
          .update({
            sms_status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
            attempts,
            last_error: errMsg || "provider_rejected",
          })
          .eq("id", n.id);
      }
    }

    return new Response(
      JSON.stringify({ success: true, considered: pending?.length || 0, sent, failed, skipped }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[tenant-self-repayment-notices] error:", err);
    return new Response(
      JSON.stringify({ error: (err as Error)?.message || "internal_error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
