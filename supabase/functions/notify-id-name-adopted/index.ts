import "../_shared/smsFooterInterceptor.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { attemptYoolaPrimary } from "../_shared/yoolaPrimary.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function formatPhoneInternational(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.startsWith("256")) return `+${digits}`;
  if (digits.startsWith("0")) return `+256${digits.slice(1)}`;
  if (digits.length === 9) return `+256${digits}`;
  return `+${digits}`;
}

async function sendSMS(phone: string, message: string): Promise<boolean> {
  if (await attemptYoolaPrimary(phone, message, { source: "notify-id-name-adopted" })) return true;
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username) {
    console.error("[notify-id-name-adopted] Missing AT credentials");
    return false;
  }
  const isSandbox = username.toLowerCase() === "sandbox";
  const baseUrl = isSandbox
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";
  const body = new URLSearchParams({
    username,
    from: "WELILE",
    to: formatPhoneInternational(phone),
    message,
  });
  try {
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", apiKey, Accept: "application/json" },
      body: body.toString(),
    });
    const raw = await res.text();
    console.log(`[notify-id-name-adopted] AT response (${res.status}):`, raw);
    const data = JSON.parse(raw);
    const recipients = data?.SMSMessageData?.Recipients || [];
    return recipients.some((r: { statusCode?: number }) => r.statusCode === 101 || r.statusCode === 100);
  } catch (err) {
    console.error("[notify-id-name-adopted] AT error", err);
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
    const token = req.headers.get("Authorization")?.replace("Bearer ", "");
    if (!token) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);

    const caller = userData.user.id;
    const roleChecks = await Promise.all(
      ["financial_ops", "cfo", "super_admin"].map((role) =>
        admin.rpc("has_role", { _user_id: caller, _role: role }),
      ),
    );
    if (!roleChecks.some((r) => r.data === true)) return json({ error: "Forbidden" }, 403);

    const payload = await req.json().catch(() => ({}));
    const userId = String(payload.userId || "").trim();
    const idName = String(payload.idName || "").trim();
    const previousName = String(payload.previousName || "").trim();
    if (!userId || idName.length < 3) return json({ error: "Invalid payload" }, 400);

    const { data: profile } = await admin
      .from("profiles")
      .select("id, full_name, email, phone")
      .eq("id", userId)
      .maybeSingle();
    if (!profile) return json({ error: "Person not found" }, 404);

    const firstName = (idName || profile.full_name || "there").split(" ")[0];
    let smsSent = false;
    let emailSent = false;

    if (profile.phone) {
      const intl = formatPhoneInternational(profile.phone);
      const { data: optOut } = await admin
        .from("sms_opt_outs")
        .select("id")
        .eq("phone", intl)
        .maybeSingle();
      if (!optOut) {
        const msg =
          `Hi ${firstName}, the name on your National ID (${idName}) is now the name on your Welile account` +
          `${previousName && previousName !== idName ? `, replacing ${previousName}` : ""}. ` +
          `This was done automatically - you do not need to change anything. - Welile`;
        smsSent = await sendSMS(profile.phone, msg);
      }
    }

    if (profile.email) {
      try {
        await admin.functions.invoke("send-transactional-email", {
          body: {
            templateName: "identity-name-adopted",
            recipientEmail: profile.email,
            idempotencyKey: `id-name-adopted-${userId}-${idName.toLowerCase().replace(/\s+/g, "-")}`,
            templateData: {
              recipient_name: firstName,
              id_name: idName,
              previous_name: previousName,
            },
          },
        });
        emailSent = true;
      } catch (err) {
        console.error("[notify-id-name-adopted] email failed", err);
      }
    }

    await admin.from("audit_logs").insert({
      user_id: caller,
      action_type: "id_name_adopted_notice_sent",
      table_name: "profiles",
      record_id: userId,
      reason: "Told the submitter their National ID name is now their account name; no manual change needed.",
      new_values: { id_name: idName, previous_name: previousName, sms_sent: smsSent, email_sent: emailSent },
    });

    return json({ success: true, sms_sent: smsSent, email_sent: emailSent });
  } catch (err) {
    console.error("[notify-id-name-adopted] error", err);
    return json({ error: err instanceof Error ? err.message : "Unexpected error" }, 500);
  }
});
