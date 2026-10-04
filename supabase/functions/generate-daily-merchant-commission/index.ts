import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function yesterdayUTC(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    let targetDate = yesterdayUTC();
    if (req.method === "POST") {
      try {
        const body = await req.json();
        if (body && typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
          targetDate = body.date;
        }
      } catch (_) {
        // no body — fine
      }
    }

    // Idempotency guard: skip if already processed for this date
    const { data: existingEvent } = await admin
      .from("system_events")
      .select("id, metadata")
      .eq("event_type", "daily_merchant_commission_report")
      .contains("metadata", { date: targetDate })
      .limit(1)
      .maybeSingle();

    if (existingEvent) {
      return new Response(
        JSON.stringify({
          success: true,
          skipped: true,
          reason: "Already processed",
          date: targetDate,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data, error } = await admin.rpc(
      "generate_daily_merchant_commission_report",
      { p_date: targetDate },
    );

    if (error) {
      console.error("[generate-daily-merchant-commission] RPC error:", error);
      return new Response(
        JSON.stringify({ success: false, error: error.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const row = Array.isArray(data) ? data[0] : data;
    return new Response(
      JSON.stringify({
        success: true,
        date: targetDate,
        agents_processed: row?.agents_processed ?? 0,
        total_commission: row?.total_commission ?? 0,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[generate-daily-merchant-commission] Fatal:", err);
    return new Response(
      JSON.stringify({ success: false, error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});