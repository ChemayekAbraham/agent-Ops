import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { sendSMS } from "../_shared/sendSmsMultiProvider.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

const ugx = (n: number) => `UGX ${Math.round(Number(n) || 0).toLocaleString("en-US")}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Caller must be authenticated (the enrolling agent/staff).
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: jsonHeaders });
    const { data: { user }, error: authErr } = await admin.auth.getUser(authHeader.replace("Bearer ", ""));
    if (authErr || !user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: jsonHeaders });

    let body: any = {};
    try { body = await req.json(); } catch { /* empty */ }
    const tenantId = String(body?.tenant_id || "");
    const subscriptionId = body?.subscription_id ? String(body.subscription_id) : null;
    let monthlyRent = Number(body?.monthly_rent) || 0;

    if (!UUID.test(tenantId)) {
      return new Response(JSON.stringify({ error: "Invalid tenant_id" }), { status: 400, headers: jsonHeaders });
    }

    const { data: tenant } = await admin
      .from("profiles")
      .select("full_name, phone")
      .eq("id", tenantId)
      .maybeSingle();
    if (!tenant?.phone) {
      return new Response(JSON.stringify({ success: false, reason: "no_phone" }), { status: 200, headers: jsonHeaders });
    }

    // Backfill rent/landlord context from the subscription when available.
    let landlordName: string | null = null;
    if (subscriptionId && UUID.test(subscriptionId)) {
      const { data: sub } = await admin
        .from("welile_homes_subscriptions")
        .select("monthly_rent, landlord_name")
        .eq("id", subscriptionId)
        .maybeSingle();
      if (sub) {
        if (!monthlyRent) monthlyRent = Number(sub.monthly_rent) || 0;
        landlordName = sub.landlord_name || null;
      }
    }

    const firstName = (tenant.full_name || "").trim().split(/\s+/)[0] || "there";
    const rentPart = monthlyRent > 0 ? ` for rent of ${ugx(monthlyRent)}/month` : "";
    const landlordPart = landlordName ? ` to ${landlordName}` : "";
    const msg =
      `Hi ${firstName}, welcome to Welile Homes. Your agent has enrolled you${rentPart}${landlordPart}. ` +
      `You'll get an SMS receipt every time your rent is paid. ` +
      `Confirm your details at welileapp.com. Thank you.`;

    // One onboarding SMS per tenant, ever (idempotent).
    const ok = await sendSMS(tenant.phone, msg, {
      admin,
      source: "welile_homes_onboarding",
      reference_id: tenantId,
      recipient_user_id: tenantId,
      recipient_name: tenant.full_name,
      idempotencyKey: `welile_onboarding_sms:${tenantId}`,
    });

    return new Response(JSON.stringify({ success: true, sent: ok }), { status: 200, headers: jsonHeaders });
  } catch (err) {
    console.error("[welile-home-tenant-onboarding-sms] error:", err);
    return new Response(JSON.stringify({ success: false, error: (err as Error)?.message || String(err) }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
});
