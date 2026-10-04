/**
 * Inngest serve endpoint — temporarily disabled.
 *
 * The `inngest` SDK's `/deno` subpath is not resolvable through the available
 * Edge Function module sources (npm: + esm.sh both fail in this runtime).
 * SMS dispatch is handled by `inngest-send-sms` and direct calls to
 * `send-collection-sms`, so this serve endpoint is currently unused.
 *
 * If/when an Inngest serve endpoint is needed, switch to the gateway pattern
 * documented in the project's Inngest connector instructions.
 */
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve((req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  return new Response(
    JSON.stringify({
      ok: false,
      message:
        "Inngest serve endpoint is disabled. Use inngest-send-sms or send-collection-sms.",
    }),
    {
      status: 410,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});
