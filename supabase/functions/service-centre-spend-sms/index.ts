// Notifies the recipient of an approved service centre spend by SMS.
// Called by the CFO panel right after `cfo_decide_service_centre` approves a spend.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { attemptYoolaPrimary, formatPhoneInternational } from "../_shared/yoolaPrimary.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ALLOWED_ROLES = ["cfo", "manager", "super_admin"];

async function sendViaAfricasTalking(phone: string, message: string): Promise<boolean> {
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username) return false;
  const baseUrl = username.toLowerCase() === "sandbox"
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";
  try {
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        apiKey,
        Accept: "application/json",
      },
      body: new URLSearchParams({
        username,
        to: formatPhoneInternational(phone),
        message,
      }).toString(),
    });
    const data = await res.json().catch(() => null);
    const recipients = data?.SMSMessageData?.Recipients || [];
    return recipients.some((r: any) => r.statusCode === 101 || r.statusCode === 100);
  } catch (err) {
    console.error("[service-centre-spend-sms] AT error", err);
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Unauthorized" }, 401);

    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userErr } = await adminClient.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);

    const { data: roles } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", userData.user.id);
    const allowed = (roles || []).some((r: any) => ALLOWED_ROLES.includes(r.role));
    if (!allowed) return json({ error: "Forbidden" }, 403);

    const body = await req.json().catch(() => ({}));
    const setupId = typeof body?.setup_id === "string" ? body.setup_id : null;
    if (!setupId) return json({ error: "setup_id is required" }, 400);

    const { data: setup, error: setupErr } = await adminClient
      .from("service_centre_setups")
      .select(
        "id, agent_name, location_name, cfo_decision, cfo_approved_amount, payee_name, payee_phone, payee_user_id, payee_note",
      )
      .eq("id", setupId)
      .maybeSingle();
    if (setupErr) throw setupErr;
    if (!setup) return json({ error: "Service centre not found" }, 404);
    if (setup.cfo_decision !== "approved") {
      return json({ error: "Spend is not approved" }, 400);
    }

    const phone = (setup.payee_phone || "").trim();
    if (!phone) return json({ sent: false, reason: "no_recipient_phone" });

    const amount = Number(setup.cfo_approved_amount || 0);
    const amountText = `UGX ${amount.toLocaleString("en-UG")}`;
    const where = setup.location_name || setup.agent_name || "service centre";
    const message =
      `Welile: ${amountText} has been approved for the service centre setup at ${where}. ` +
      `Recipient: ${setup.payee_name || "you"}.` +
      (setup.payee_note ? ` Note: ${setup.payee_note}.` : "");

    const meta = {
      source: "service-centre-spend-sms",
      referenceId: setup.id,
      recipientUserId: setup.payee_user_id,
      recipientName: setup.payee_name,
    };

    let sent = await attemptYoolaPrimary(phone, message, meta);
    let provider = "yoola";
    if (!sent) {
      sent = await sendViaAfricasTalking(phone, message);
      provider = sent ? "africastalking" : "none";
    }

    return json({ sent, provider, phone: formatPhoneInternational(phone) });
  } catch (err) {
    console.error("[service-centre-spend-sms] error", err);
    return json({ error: (err as Error)?.message || "Unexpected error" }, 500);
  }
});
