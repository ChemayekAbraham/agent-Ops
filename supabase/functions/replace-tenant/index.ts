import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface ReplaceTenantBody {
  old_rent_request_id: string;
  new_tenant_id: string;
  reason: string;
  effective_at?: string;
}

const isUuid = (s: unknown): s is string =>
  typeof s === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) {
      return new Response(JSON.stringify({ error: "Missing auth token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: userData, error: userErr } = await adminClient.auth.getUser(token);
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "Invalid auth token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = (await req.json()) as ReplaceTenantBody;

    if (!isUuid(body.old_rent_request_id) || !isUuid(body.new_tenant_id)) {
      return new Response(JSON.stringify({ error: "Invalid id(s)" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!body.reason || body.reason.trim().length < 10) {
      return new Response(
        JSON.stringify({ error: "Reason must be at least 10 characters" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Run RPC as caller so role checks work against auth.uid()
    const userClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const { data, error } = await userClient.rpc("replace_tenant_at_property", {
      p_old_rent_request_id: body.old_rent_request_id,
      p_new_tenant_id: body.new_tenant_id,
      p_reason: body.reason.trim(),
      p_effective_at: body.effective_at ?? new Date().toISOString(),
    });

    if (error) {
      console.error("replace_tenant_at_property RPC error", error);
      return new Response(
        JSON.stringify({ error: error.message ?? "Replacement failed" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Best-effort notifications (don't fail the request)
    try {
      const result = data as { old_tenant_id: string; new_tenant_id: string; landlord_id: string };
      const notes = [
        {
          user_id: result.old_tenant_id,
          title: "Tenancy ended",
          message: `Your tenancy has been ended. Any outstanding balance remains payable. Reason: ${body.reason.trim()}`,
          type: "tenancy_ended",
        },
        {
          user_id: result.new_tenant_id,
          title: "Welcome — new tenancy started",
          message: "You have been registered as the new tenant for this property. Your rent plan starts at zero.",
          type: "tenancy_started",
        },
      ];
      await adminClient.from("notifications").insert(notes);
    } catch (notifyErr) {
      console.warn("notification insert failed", notifyErr);
    }

    return new Response(JSON.stringify({ success: true, ...(data as object) }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("replace-tenant fatal", err);
    return new Response(
      JSON.stringify({ error: (err as Error).message ?? "Internal error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
