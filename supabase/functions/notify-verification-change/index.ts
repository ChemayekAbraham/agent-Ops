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
  if (await attemptYoolaPrimary(phone, message, { source: "notify-verification-change" })) return true;
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username) {
    console.error("[notify-verification-change] Missing AT credentials");
    return false;
  }
  const isSandbox = username.toLowerCase() === "sandbox";
  const baseUrl = isSandbox
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";
  const to = formatPhoneInternational(phone);
  const body = new URLSearchParams({ username, from: "WELILE", to, message });
  try {
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", apiKey, Accept: "application/json" },
      body: body.toString(),
    });
    const raw = await res.text();
    console.log(`[notify-verification-change] AT response (${res.status}) for ${to}:`, raw);
    const data = JSON.parse(raw);
    const recipients = data?.SMSMessageData?.Recipients || [];
    return recipients.some((r: any) => r.statusCode === 101 || r.statusCode === 100);
  } catch (err) {
    console.error("[notify-verification-change] AT error", err);
    return false;
  }
}

type Entity = "landlord" | "lc1";
type Status = "verified" | "pending" | "rejected";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const token = req.headers.get("Authorization")?.replace("Bearer ", "");
    if (!token) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Verify caller identity + ops authority
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: isOps } = await admin.rpc("is_ops_role", { _user_id: userData.user.id });
    if (!isOps) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const payload = await req.json().catch(() => ({}));
    const entity = payload.entity as Entity;
    const id = payload.id as string;
    const status = payload.status as Status;
    const reason = String(payload.reason || "").trim();

    if (!["landlord", "lc1"].includes(entity) || !id || !["verified", "pending", "rejected"].includes(status)) {
      return new Response(JSON.stringify({ error: "Invalid payload" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Resolve the entity name + linked borrowers
    const entityTable = entity === "landlord" ? "landlords" : "lc1_chairpersons";
    const { data: entityRow } = await admin.from(entityTable).select("name").eq("id", id).maybeSingle();
    const entityName = (entityRow as any)?.name as string | undefined;
    const entityNoun = entity === "landlord" ? "landlord" : "LC1 chairperson";
    const entityLabel = `your ${entityNoun}${entityName ? ` (${entityName})` : ""}`;

    const linkColumn = entity === "landlord" ? "borrower_landlord_id" : "borrower_lc1_id";
    const { data: borrowers } = await admin
      .from("profiles")
      .select("id, full_name, email, phone, verification_notify_email, verification_notify_sms")
      .eq(linkColumn, id);

    const statusWord = status === "verified" ? "verified" : status === "rejected" ? "rejected" : "under review";

    let emailsSent = 0;
    let smsSent = 0;

    for (const b of (borrowers ?? []) as any[]) {
      const firstName = (b.full_name || "there").split(" ")[0];

      // EMAIL (optional)
      if (b.verification_notify_email && b.email) {
        try {
          await admin.functions.invoke("send-transactional-email", {
            body: {
              templateName: "residence-verification-status",
              recipientEmail: b.email,
              idempotencyKey: `residence-verif-${entity}-${id}-${status}-${b.id}`,
              templateData: {
                recipient_name: firstName,
                entity_label: entityLabel,
                status,
                reason,
              },
            },
          });
          emailsSent++;
        } catch (err) {
          console.error(`[notify-verification-change] email failed for ${b.id}`, err);
        }
      }

      // SMS (optional)
      if (b.verification_notify_sms && b.phone) {
        // honour global SMS opt-out list
        const intl = formatPhoneInternational(b.phone);
        const { data: optOut } = await admin
          .from("sms_opt_outs")
          .select("id")
          .eq("phone", intl)
          .maybeSingle();
        if (optOut) continue;

        let msg = `Hi ${firstName}, ${entityLabel} verification is ${statusWord}.`;
        if (status === "rejected" && reason) msg += ` Reason: ${reason}.`;
        else if (status === "verified") msg += ` You can now request a loan in the app.`;
        msg += ` — Welile`;
        const ok = await sendSMS(b.phone, msg);
        if (ok) smsSent++;
      }
    }

    return new Response(
      JSON.stringify({ success: true, borrowers: (borrowers ?? []).length, emails_sent: emailsSent, sms_sent: smsSent }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[notify-verification-change] Error:", err);
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
