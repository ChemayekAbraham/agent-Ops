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
  if (await attemptYoolaPrimary(phone, message, { source: "notify-identity-verified" })) return true;
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username) {
    console.error("[notify-identity-verified] Missing AT credentials");
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
    console.log(`[notify-identity-verified] AT response (${res.status}) for ${to}:`, raw);
    const data = JSON.parse(raw);
    const recipients = data?.SMSMessageData?.Recipients || [];
    return recipients.some((r: { statusCode?: number }) => r.statusCode === 101 || r.statusCode === 100);
  } catch (err) {
    console.error("[notify-identity-verified] AT error", err);
    return false;
  }
}

function maskTail(value: string | null | undefined): string {
  if (!value) return "";
  const digits = value.replace(/[^0-9A-Za-z]/g, "");
  if (digits.length <= 4) return digits;
  return `${"•".repeat(Math.min(4, digits.length - 4))}${digits.slice(-4)}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(supabaseUrl, serviceKey);

    // Only Financial Ops / CFO / super admin may trigger the confirmation.
    const token = authHeader.replace("Bearer ", "");
    const { data: authData } = await admin.auth.getUser(token);
    const actorId = authData?.user?.id;
    if (!actorId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: roles } = await admin
      .from("user_roles")
      .select("role, enabled")
      .eq("user_id", actorId);
    const allowed = (roles || []).some(
      (r: { role: string; enabled: boolean | null }) =>
        r.enabled !== false && ["financial_ops", "cfo", "super_admin"].includes(r.role),
    );
    if (!allowed) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { destinationId } = await req.json();
    if (!destinationId) {
      return new Response(JSON.stringify({ error: "Missing destinationId" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: dest, error: destErr } = await admin
      .from("payout_destination_verifications")
      .select(
        "id, user_id, status, destination_type, provider, momo_number, bank_name, bank_account_number, decided_at",
      )
      .eq("id", destinationId)
      .maybeSingle();
    if (destErr) throw destErr;
    if (!dest) {
      return new Response(JSON.stringify({ error: "Destination not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (dest.status !== "verified") {
      return new Response(
        JSON.stringify({ success: false, skipped: "not_verified" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: profile } = await admin
      .from("profiles")
      .select("full_name, phone, email")
      .eq("id", dest.user_id)
      .maybeSingle();

    const firstName = (profile?.full_name || "there").split(" ")[0];
    const destinationLabel = dest.destination_type === "bank"
      ? [dest.bank_name, maskTail(dest.bank_account_number)].filter(Boolean).join(" · ")
      : [dest.provider || "Mobile Money", maskTail(dest.momo_number)].filter(Boolean).join(" · ");
    const verifiedAt = dest.decided_at
      ? new Date(dest.decided_at).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "long",
        year: "numeric",
      })
      : "";

    // SMS
    let smsSent = false;
    if (profile?.phone) {
      const msg =
        `Hi ${firstName}, your Welile account is verified. ` +
        `Your payout destination${destinationLabel ? ` (${destinationLabel})` : ""} is approved ` +
        `and you can withdraw now from your wallet. — Welile`;
      smsSent = await sendSMS(profile.phone, msg);
    }

    // Branded email
    let emailQueued = false;
    if (profile?.email) {
      try {
        const res = await fetch(`${supabaseUrl}/functions/v1/send-transactional-email`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({
            templateName: "identity-verified-withdrawals-enabled",
            recipientEmail: profile.email,
            idempotencyKey: `identity-verified-${dest.id}`,
            templateData: {
              userName: firstName,
              destinationLabel,
              verifiedAt,
              appUrl: "https://welileapp.com",
            },
          }),
        });
        emailQueued = res.ok;
        if (!res.ok) {
          console.error("[notify-identity-verified] email failed", res.status, await res.text());
        }
      } catch (err) {
        console.error("[notify-identity-verified] email error", err);
      }
    }

    await admin.from("system_events").insert({
      event_type: "identity_verified_notice_sent",
      user_id: dest.user_id,
      payload: {
        destination_id: dest.id,
        sms_sent: smsSent,
        email_queued: emailQueued,
        notified_by: actorId,
      },
    });

    return new Response(
      JSON.stringify({ success: true, sms_sent: smsSent, email_queued: emailQueued }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[notify-identity-verified] Error:", err);
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
