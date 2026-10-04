const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Permanently disabled on 1 October 2026 by instruction of the HR Lead.
// This function credited platform money into any wallet on a manager role check alone,
// with no enabled-role filter and no treasury guard. It must never move money again.
// Do not restore it. Test funds, if ever needed, belong in a non-production project.
Deno.serve((req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  return new Response(
    JSON.stringify({ error: "seed-test-funds is permanently disabled." }),
    { status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
