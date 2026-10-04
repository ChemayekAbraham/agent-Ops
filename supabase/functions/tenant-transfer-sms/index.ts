import "../_shared/smsFooterInterceptor.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isPhoneBlocked } from "../_shared/smsExceptions.ts";
import { attemptYoolaPrimary } from "../_shared/yoolaPrimary.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const { tenant_id, from_agent_id, to_agent_id, reason, source } = body ?? {};
    if (!tenant_id || !to_agent_id) {
      return new Response(JSON.stringify({ error: "tenant_id and to_agent_id are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const ids = [tenant_id, to_agent_id, from_agent_id].filter(Boolean);
    const { data: people } = await admin
      .from("profiles")
      .select("id, full_name, phone")
      .in("id", ids);

    const byId = new Map((people || []).map((p: any) => [p.id, p]));
    const tenant = byId.get(tenant_id);
    const toAgent = byId.get(to_agent_id);
    const fromAgent = from_agent_id ? byId.get(from_agent_id) : null;

    if (!toAgent?.phone) {
      return new Response(JSON.stringify({ ok: false, skipped: "receiving agent has no phone" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (await isPhoneBlocked(admin, toAgent.phone, "tenant_transfer")) {
      return new Response(JSON.stringify({ ok: false, skipped: "phone blocked" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const message =
      `WELILE: Tenant ${tenant?.full_name || "a tenant"}` +
      (tenant?.phone ? ` (${tenant.phone})` : "") +
      ` has been transferred to you` +
      (fromAgent?.full_name ? ` from ${fromAgent.full_name}` : "") +
      `. Reason: ${(reason || "").toString().trim() || "not stated"}.` +
      ` Please open your dashboard to start collections.`;

    const sent = await attemptYoolaPrimary(toAgent.phone, message, { source: "tenant-transfer-sms" });
    console.log(`[tenant-transfer-sms] tenant=${tenant_id} to=${to_agent_id} source=${source} sent=${sent}`);

    return new Response(JSON.stringify({ ok: true, sent }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[tenant-transfer-sms] error", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
