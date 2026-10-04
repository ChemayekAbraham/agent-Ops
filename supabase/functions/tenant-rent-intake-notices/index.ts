// Drains queued tenant rent-request progress SMS messages.
// In-app notifications are written by the DB trigger; this function only sends
// the SMS half of each notice and marks the queue row.
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
    // Queue stall reminders first so long-waiting tenants also get an update.
    const { error: stallErr } = await admin.rpc("queue_tenant_rent_intake_stall_notices");
    if (stallErr) console.error("[tenant-rent-intake-notices] stall queue failed:", stallErr.message);

    const { data: pending, error } = await admin
      .from("tenant_rent_intake_notices")
      .select("id, request_id, tenant_id, stage, phone, sms_text, attempts")
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
        await admin.from("tenant_rent_intake_notices")
          .update({ sms_status: "skipped", last_error: "no_valid_phone" })
          .eq("id", n.id);
        continue;
      }

      let ok = false;
      let errMsg: string | null = null;
      try {
        ok = await sendSMS(phone, n.sms_text, {
          admin,
          source: "tenant_rent_intake_progress",
          recipient_user_id: n.tenant_id,
          reference_id: `tri-${n.request_id}-${n.stage}`,
          idempotencyKey: `tri-${n.request_id}-${n.stage}`,
        });

      } catch (e) {
        errMsg = (e as Error)?.message || "send_error";
      }

      const attempts = (n.attempts || 0) + 1;
      if (ok) {
        sent++;
        await admin.from("tenant_rent_intake_notices")
          .update({ sms_status: "sent", sent_at: new Date().toISOString(), attempts, last_error: null })
          .eq("id", n.id);
      } else {
        failed++;
        await admin.from("tenant_rent_intake_notices")
          .update({
            sms_status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
            attempts,
            last_error: errMsg || "provider_rejected",
          })
          .eq("id", n.id);
      }
    }

    return new Response(JSON.stringify({ success: true, considered: pending?.length || 0, sent, failed, skipped }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[tenant-rent-intake-notices] error:", err);
    return new Response(JSON.stringify({ error: (err as Error)?.message || "internal_error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
