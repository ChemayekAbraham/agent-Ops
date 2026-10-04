const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// RETIRED (2026-07-20): the instant UGX 1,000 LC1 registration reward has
// been removed. The full UGX 5,000 commission is now paid in a single payment
// by `credit-lc1-verification-bonus` once Landlord Ops verifies the LC1
// chairperson. This endpoint is kept as a no-op for backward compatibility
// with older clients still invoking it — no wallet movement happens here.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // No-op: return success without paying. The full UGX 5,000 is credited on
  // verification via `credit-lc1-verification-bonus`.
  return new Response(
    JSON.stringify({
      success: true,
      bonus: 0,
      retired: true,
      message:
        "Instant LC1-registration reward retired. Full UGX 5,000 is now paid after verification.",
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
