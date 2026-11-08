// Retired (Partner Returns Phase 4, owner decision D6).
//
// This function credited a fixed monthly percentage to `investment_accounts` and wrote to tables that do not
// exist in production; it had no cron, no caller and no authentication. Partner Returns are paid by the
// database at each portfolio's stored rate, never at a fixed rate here.
//
// It stays in the repo as an immediate 410 on purpose: Lovable redeploys every function on `lovable`
// together, so an "undeploy" would be undone by the next deploy. No client is created and nothing is
// read or written.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve((req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  return new Response(JSON.stringify({ error: "This function is retired." }), {
    status: 410,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
