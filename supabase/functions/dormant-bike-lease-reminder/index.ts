import "../_shared/smsFooterInterceptor.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isPhoneBlocked } from "../_shared/smsExceptions.ts";
import { attemptYoolaPrimary } from "../_shared/yoolaPrimary.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

function intl(phone: string) {
  const d = phone.replace(/[^0-9]/g, "");
  if (d.startsWith("256")) return `+${d}`;
  if (d.startsWith("0")) return `+256${d.slice(1)}`;
  return `+256${d}`;
}

async function sendAT(phone: string, message: string): Promise<boolean> {
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY")?.trim();
  const username = Deno.env.get("AFRICASTALKING_USERNAME")?.trim();
  if (!apiKey || !username) return false;
  try {
    const res = await fetch("https://api.africastalking.com/version1/messaging", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", apiKey, Accept: "application/json" },
      body: new URLSearchParams({ username, to: intl(phone), message, from: "WELILE" }).toString(),
    });
    const data = await res.json().catch(() => null);
    return (data?.SMSMessageData?.Recipients || []).some((r: any) => r.statusCode === 101 || r.statusCode === 100);
  } catch { return false; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    if (!token) return json({ error: "Unauthorised" }, 401);
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: u } = await admin.auth.getUser(token);
    if (!u?.user) return json({ error: "Unauthorised" }, 401);
    const { data: ok } = await admin.rpc("_has_enabled_role", {
      p_user: u.user.id, p_roles: ["agent_ops", "manager", "coo", "ceo", "cfo", "super_admin"],
    });
    if (!ok) return json({ error: "Not authorised" }, 403);

    const { lease_id } = await req.json();
    if (!lease_id) return json({ error: "lease_id required" }, 400);
    const { data: lease } = await admin.from("agent_bike_leases")
      .select("id, agent_id, agent_name, agent_phone, amount_outstanding").eq("id", lease_id).maybeSingle();
    if (!lease) return json({ error: "Lease not found" }, 404);
    const { data: prof } = await admin.from("profiles").select("full_name, phone").eq("id", lease.agent_id).maybeSingle();
    const phone = lease.agent_phone || prof?.phone;
    if (!phone) return json({ error: "Agent has no phone number" }, 400);
    if (await isPhoneBlocked(admin as any, phone).catch(() => false)) return json({ error: "This number has opted out of SMS" }, 400);

    const name = (prof?.full_name || lease.agent_name || "Agent").split(" ")[0];
    const bal = `UGX ${Math.round(Number(lease.amount_outstanding || 0)).toLocaleString("en-US")}`;
    const message = `Hello ${name}, your Welile electric bike lease has had no repayment for 7+ days. Outstanding: ${bal}. Please top up your Welile wallet today so your daily repayment can be collected. Thank you.`;

    let sent = await attemptYoolaPrimary(phone, message, { source: "dormant-bike-lease-reminder" });
    if (!sent) sent = await sendAT(phone, message);
    if (!sent) return json({ error: "SMS could not be delivered by any provider" }, 502);

    await admin.from("audit_logs").insert({
      user_id: u.user.id, action_type: "dormant_bike_lease_reminder_sms", table_name: "agent_bike_leases",
      record_id: lease.id, reason: "Dormant bike lease reminder SMS sent to agent",
      metadata: { agent_id: lease.agent_id, outstanding: lease.amount_outstanding },
    }).then(() => {}, () => {});
    return json({ ok: true });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
