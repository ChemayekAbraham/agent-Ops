/**
 * RETIRED 2026-08-22.
 *
 * Director requisitions are replaced by the staff requisition flow that starts
 * in My Space:
 *   staff-requisition-submit -> department head -> COO -> CFO -> wallet credit.
 *
 * `director_requisitions` remains readable for history; no new rows are ever
 * created here.
 */
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve((req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  return new Response(
    JSON.stringify({
      error: "retired",
      message:
        "Director requisitions are retired. Raise the requisition from My Space > Make a requisition; it routes to your department head, then COO, then CFO.",
      replacement: "staff-requisition-submit",
    }),
    { status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
