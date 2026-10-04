// Cron-only sweep (every 15 min, see migration 20260915170000): finds payout
// destinations sitting in payout_destination_verifications.status = 'waiting'
// where the user has submitted NO identity evidence at all (no National ID
// photo, no selfie) — as opposed to a genuine name-mismatch case, which stays
// in the normal Financial Ops review queue untouched. For each such user
// (batched, 100/run, never re-notified twice): rejects those destinations
// with a clear reason and SMSes them what to do next.
//
// This does not change whether these users can withdraw — 'waiting' and
// 'rejected' both already block payout via the existing gate
// (payout_destination_is_verified / withdrawal_destination_gate). It only
// replaces an indefinite silent queue with a clear status and a proactive
// nudge.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendSMS, formatPhoneInternational } from "../_shared/sendSmsMultiProvider.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BATCH_SIZE = 100;

const MESSAGE =
  "Welile: To withdraw your funds you need to verify your identity first. " +
  "Open the Welile app, go to Withdraw, and submit a clear photo of your National ID and a selfie. It only takes a minute.";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const { data: candidates, error } = await admin.rpc("candidates_missing_id_payout", { p_limit: BATCH_SIZE });
    if (error) {
      console.error("[reject-unverified-payout-destinations] candidate lookup failed", error.message);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let rejected = 0;
    let smsSent = 0;
    let smsFailed = 0;

    for (const row of (candidates ?? []) as { user_id: string; phone: string; destination_ids: string[] }[]) {
      const destinationIds = row.destination_ids ?? [];
      if (destinationIds.length === 0) continue;

      const { error: updErr } = await admin
        .from("payout_destination_verifications")
        .update({
          status: "rejected",
          decision_reason: "Auto-rejected: no National ID photo or selfie has been submitted for identity verification.",
          decided_by: null,
          decided_at: new Date().toISOString(),
        })
        .in("id", destinationIds)
        .eq("status", "waiting"); // don't clobber a decision made between the lookup and now
      if (updErr) {
        console.error("[reject-unverified-payout-destinations] update failed for", row.user_id, updErr.message);
        continue;
      }
      rejected += destinationIds.length;

      const sent = await sendSMS(formatPhoneInternational(row.phone), MESSAGE, {
        admin,
        source: "reject-unverified-payout-destinations",
        recipient_user_id: row.user_id,
      }).catch(() => false);
      if (sent) smsSent += 1; else smsFailed += 1;

      // Mark notified regardless of SMS outcome — this is a best-effort nudge,
      // not a retry queue; a permanently bad number should not be retried
      // forever on every cron run.
      await admin.from("profiles")
        .update({ national_id_missing_notified_at: new Date().toISOString() })
        .eq("id", row.user_id);
    }

    return new Response(JSON.stringify({
      candidates: candidates?.length ?? 0,
      destinations_rejected: rejected,
      sms_sent: smsSent,
      sms_failed: smsFailed,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e: any) {
    console.error("[reject-unverified-payout-destinations] unhandled", e?.message || e);
    return new Response(JSON.stringify({ error: `Service error: ${e?.message || "unknown"}` }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
