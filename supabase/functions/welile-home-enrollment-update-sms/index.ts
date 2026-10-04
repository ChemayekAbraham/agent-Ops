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

const ordinal = (d: number) => {
  const n = Math.round(Number(d) || 0);
  if (n <= 0) return String(n);
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Caller must be authenticated (the editing agent/staff).
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: jsonHeaders });
    const { data: { user }, error: authErr } = await admin.auth.getUser(authHeader.replace("Bearer ", ""));
    if (authErr || !user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: jsonHeaders });

    let body: any = {};
    try { body = await req.json(); } catch { /* empty */ }
    const subscriptionId = String(body?.subscription_id || "");
    if (!UUID.test(subscriptionId)) {
      return new Response(JSON.stringify({ error: "Invalid subscription_id" }), { status: 400, headers: jsonHeaders });
    }

    const { data: sub } = await admin
      .from("welile_homes_subscriptions")
      .select("tenant_id, monthly_rent, payout_day, has_smartphone, outstanding_balance, landlord_name")
      .eq("id", subscriptionId)
      .maybeSingle();
    if (!sub?.tenant_id) {
      return new Response(JSON.stringify({ success: false, reason: "not_found" }), { status: 200, headers: jsonHeaders });
    }

    const { data: tenant } = await admin
      .from("profiles")
      .select("full_name, phone")
      .eq("id", sub.tenant_id)
      .maybeSingle();
    if (!tenant?.phone) {
      return new Response(JSON.stringify({ success: false, reason: "no_phone" }), { status: 200, headers: jsonHeaders });
    }

    const firstName = (tenant.full_name || "").trim().split(/\s+/)[0] || "there";
    const rent = Number(sub.monthly_rent) || 0;
    const outstanding = Number(sub.outstanding_balance) || 0;
    const modePart = sub.has_smartphone === false ? " Your agent will allocate your rent." : "";
    const outstandingPart = outstanding > 0 ? ` Balance: ${ugx(outstanding)}.` : "";
    const msg =
      `Hi ${firstName}, your Welile Homes enrollment was updated. ` +
      `Monthly rent is now ${ugx(rent)}, due by the ${ordinal(Number(sub.payout_day) || 5)} of each month.` +
      `${outstandingPart}${modePart} ` +
      `View details at welileapp.com. Thank you.`;

    // Idempotent per edit: caller passes a unique audit_id when available so the
    // same edit never fires twice, otherwise dedupe within the same minute.
    const editKey = body?.audit_id && UUID.test(String(body.audit_id))
      ? String(body.audit_id)
      : `${subscriptionId}:${new Date().toISOString().slice(0, 16)}`;

    const ok = await sendSMS(tenant.phone, msg, {
      admin,
      source: "welile_homes_enrollment_update",
      reference_id: subscriptionId,
      recipient_user_id: sub.tenant_id,
      recipient_name: tenant.full_name,
      idempotencyKey: `welile_enrollment_update_sms:${editKey}`,
    });

    return new Response(JSON.stringify({ success: true, sent: ok }), { status: 200, headers: jsonHeaders });
  } catch (err) {
    console.error("[welile-home-enrollment-update-sms] error:", err);
    return new Response(JSON.stringify({ success: false, error: (err as Error)?.message || String(err) }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
});