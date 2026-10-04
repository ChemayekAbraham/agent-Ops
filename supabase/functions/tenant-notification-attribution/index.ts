// Stage 5A: correlational attribution sweep.
//
// Backfills tenant_notification_log.acted_at for the two events with no
// deterministic tracked-link path:
//
//   MERCHANT_CODE_REMINDER -> a qualifying payment within a bounded window
//   FIVE_DAY_AGENT_OPPORTUNITY -> a user_roles row for agent/sub_agent
//     created after the send, with no upper bound (becoming an agent is not
//     instant)
//
// Idempotent: only rows with acted_at is null are matched, and a match claims
// the row on write, so re-running this on a schedule (or by hand) never
// double-attributes. All the actual matching logic lives in
// attribute_tenant_notification_actions — this function is a thin, auditable
// wrapper so the sweep can be invoked, logged and eventually scheduled like
// every other sender in this engine.
//
// Dashboard-link attribution (SMARTPHONE_DISCOVERY, DASHBOARD_INVITE) is NOT
// handled here — it is deterministic and happens inline, the instant the
// tenant opens the link, inside record_tenant_dashboard_access.
import "../_shared/smsFooterInterceptor.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { errorMessage } from "../_shared/errorMessage.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { body = {}; }

    const lookbackDays = Number(body.lookback_days ?? 14);
    const merchantWindowHours = Number(body.merchant_window_hours ?? 24);

    const { data, error } = await admin.rpc("attribute_tenant_notification_actions", {
      p_lookback_days: lookbackDays,
      p_merchant_window_hours: merchantWindowHours,
    });
    if (error) throw error;

    console.log(
      `[tenant-notification-attribution] merchant=${data?.merchant_code_conversions ?? 0} ` +
        `agent=${data?.agent_opportunity_conversions ?? 0} lookback_days=${lookbackDays}`,
    );

    return new Response(JSON.stringify({ success: true, ...data }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    const msg = errorMessage(error);
    console.error("[tenant-notification-attribution] Fatal:", msg);
    return new Response(JSON.stringify({ success: false, error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
