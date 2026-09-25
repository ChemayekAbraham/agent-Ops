// Drains queued tenant self-repayment SMS notices (tenant + agent halves).
// The settlement RPC writes the queue rows; this worker only sends the SMS
// and marks each row. Same shape as tenant-rent-intake-notices.
//
// Consolidated 2026-09-25: the tenant-facing half (recipient_role='tenant')
// now also gets the same real-money topup/next-level wording every other
// tenant payment-confirmation SMS already carries (tenant-payment-notices'
// PAYMENT_FULL/PAYMENT_PARTIAL, and tenant-pay-rent's
// WALLET_RENT_PAYMENT_CONFIRMED) — appended here at send time via
// accessSentence/nextLevelSentence, reusing tenant_topup_eligibility_rules()'s
// existing 70%/90% thresholds unchanged. settle_tenant_rent_from_deposit()
// itself (the SQL that queues these rows) is deliberately left untouched:
// it is a large, recently-corrected settlement function, and its own
// balance/coverage wording is already real-money and already correct — this
// only adds the one thing it does not say. The agent-facing half is a
// different audience (commission notice, not a payment confirmation) and is
// sent exactly as queued, unchanged.
import { createClient } from "npm:@supabase/supabase-js@2";
import { sendSMS, isUgandanPhone } from "../_shared/sendSmsMultiProvider.ts";
import {
  accessSentence,
  loadTenantPaymentMessageVars,
  nextLevelSentence,
} from "../_shared/tenantTemplates.ts";

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

    // One batched lookup for every tenant-role recipient in this run, rather
    // than a query per row.
    const tenantRecipientIds = (pending || [])
      .filter((n) => n.recipient_role === "tenant")
      .map((n) => n.recipient_user_id);
    const planVars = await loadTenantPaymentMessageVars(admin, tenantRecipientIds);

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

      const messageText = n.recipient_role === "tenant"
        ? n.sms_text
          + accessSentence(planVars.get(n.recipient_user_id))
          + nextLevelSentence(planVars.get(n.recipient_user_id))
        : n.sms_text;

      const ref = `tsr-${n.deposit_request_id}-${n.recipient_role}`;
      let ok = false;
      let errMsg: string | null = null;
      try {
        ok = await sendSMS(phone, messageText, {
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
