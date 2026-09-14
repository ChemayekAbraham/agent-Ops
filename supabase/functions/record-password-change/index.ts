import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { resolveTrustedClientIp, getClientUserAgent } from "../_shared/resolveClientIp.ts";

// A real password change never reaches this edge function's own database
// write through PostgREST -- it goes through supabase-js's GoTrue client
// directly (supabase.auth.updateUser({ password })), which talks to
// Postgres over GoTrue's own connection, not through PostgREST. That means
// log_password_change_on_auth_users() (the BEFORE UPDATE trigger on
// auth.users) can never see request.headers for a genuine password change --
// current_setting('request.headers', true) is only ever populated by
// PostgREST at the start of a request it is serving, and GoTrue-driven
// writes to auth.users are never such a request. Confirmed empirically
// 2026-09-14: 11/11 real password_change_audit rows had ip_address = NULL.
//
// The trigger-based capture pattern used everywhere else in this codebase
// structurally cannot work for this one action. This edge function is the
// fix: the frontend calls it (fire-and-forget, right after a successful
// supabase.auth.updateUser call) using the SAME browser request that just
// changed the password, so this function's own inbound req.headers carries
// the real IP -- the actual trust boundary for this action.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const authHeader = req.headers.get("Authorization");
    const token = authHeader?.replace("Bearer ", "") ?? "";
    if (!token) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);
    const user = authData?.user;
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // The caller can only ever record a change for themselves -- this is
    // called immediately after the caller's own password update succeeds,
    // never on behalf of anyone else.
    const { error: insertError } = await supabaseAdmin.from("password_change_audit").insert({
      user_id: user.id,
      ip_address: resolveTrustedClientIp(req),
      user_agent: getClientUserAgent(req),
    });

    if (insertError) {
      console.error("[record-password-change] insert failed:", insertError.message);
      return new Response(JSON.stringify({ error: insertError.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[record-password-change] error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
