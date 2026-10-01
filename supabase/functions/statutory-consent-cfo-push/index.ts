import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";
import { sendPushToSubscription, type PushPayload } from "../_shared/webPushSend.ts";

// Sends the ONE-TIME web push to the CFO when a payroll run is paid and the
// statutory-ID list for that run is ready. Takes NO input. Each notice is
// pushed once (pushed_at set); retried on later ticks only if no device took it.
// Notification bookkeeping only -- no payroll, wallet or ledger logic.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: notices, error } = await supabase
      .from("cfo_statutory_consent_notices")
      .select("run_id, recipient_id, push_attempts")
      .is("pushed_at", null)
      .lt("push_attempts", 48);
    if (error) return json({ error: error.message }, 500);

    let sent = 0, noDevice = 0;
    for (const n of notices ?? []) {
      const { data: subs } = await supabase.from("push_subscriptions").select("*").eq("user_id", n.recipient_id);
      let ok = false;
      if (subs && subs.length) {
        const payload = {
          title: "Payroll paid: staff statutory ID list ready",
          body: "Staff who accepted gross pay with a TIN or NSSF number are listed on your CFO dashboard.",
          url: "/cfo-dashboard?section=statutory-consent-list",
          tag: `statutory-consent-${n.run_id}`,
          requireInteraction: true,
        } as unknown as PushPayload;
        const results = await Promise.allSettled(subs.map((s) => sendPushToSubscription(s, payload)));
        ok = results.some((r) => r.status === "fulfilled" && r.value.ok);
      } else noDevice += 1;
      await supabase.from("cfo_statutory_consent_notices")
        .update({ push_attempts: (n.push_attempts ?? 0) + 1, ...(ok ? { pushed_at: new Date().toISOString() } : {}) })
        .eq("run_id", n.run_id);
      if (ok) sent += 1;
    }
    return json({ success: true, considered: notices?.length ?? 0, sent, no_device: noDevice });
  } catch (e: unknown) {
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});
