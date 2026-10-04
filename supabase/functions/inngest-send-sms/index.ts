import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const GATEWAY_URL = "https://connector-gateway.lovable.dev/inngest";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Validate caller auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    const INNGEST_API_KEY = Deno.env.get("INNGEST_API_KEY");
    if (!INNGEST_API_KEY) {
      throw new Error("INNGEST_API_KEY is not configured");
    }

    const payload = await req.json();

    // Validate required fields
    if (!payload.tenant_phone || !payload.agent_phone || !payload.amount || !payload.tracking_id) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fire Inngest event — fire-and-forget
    const response = await fetch(`${GATEWAY_URL}/e/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "X-Connection-Api-Key": INNGEST_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "app/payment.sms.requested",
        data: payload,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`[inngest-send-sms] Inngest event failed [${response.status}]: ${body}`);
      // Still return success to client — SMS failure should not block UX
      return new Response(
        JSON.stringify({ success: true, inngest_queued: false, reason: "event_dispatch_failed" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const result = await response.json();
    console.log("[inngest-send-sms] Event dispatched:", JSON.stringify(result));

    return new Response(
      JSON.stringify({ success: true, inngest_queued: true }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[inngest-send-sms] Error:", err);
    return new Response(
      JSON.stringify({ success: true, inngest_queued: false, reason: "internal_error" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
