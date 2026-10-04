// Cron entrypoint: rebuilds tenant_idle_states from agent_collections.
// Called every 15 minutes (see cron job). Also invocable manually by Agent Ops.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const started = Date.now();
  const { data, error } = await supabase.rpc("refresh_tenant_idle_states");
  const ms = Date.now() - started;

  if (error) {
    console.error("[refresh-tenant-idle-states] failed", error);
    return new Response(
      JSON.stringify({ success: false, error: error.message, ms }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  return new Response(
    JSON.stringify({ success: true, rows: data ?? 0, ms }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
