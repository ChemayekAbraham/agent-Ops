import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { forbidden, getCaller, hasAnyRole, isServiceRoleRequest, STAFF_ROLES } from "../_shared/callerAuth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Staff-only. verify_jwt is off, so check the caller here; otherwise anyone
  // holding the public anon key could run the monthly referral payout on demand.
  if (!isServiceRoleRequest(req)) {
    const authClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const caller = await getCaller(authClient, req);
    if (!caller) return forbidden(corsHeaders, 401);
    if (!hasAnyRole(caller, STAFF_ROLES)) return forbidden(corsHeaders, 403);
  }

  try {
    // Processing started

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Call the database function to process rewards (already uses RPC internally)
    const { error } = await supabase.rpc("process_monthly_referral_rewards");

    if (error) {
      console.error("Error processing monthly rewards:", error);
      return new Response(
        JSON.stringify({ success: false, error: error.message }),
        { 
          status: 500, 
          headers: { ...corsHeaders, "Content-Type": "application/json" } 
        }
      );
    }

    // Processing complete

    return new Response(
      JSON.stringify({ 
        success: true, 
        message: "Monthly referral rewards processed successfully",
        processed_at: new Date().toISOString()
      }),
      { 
        status: 200, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      }
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("Unexpected error:", errorMessage);
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { 
        status: 500, 
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
});
