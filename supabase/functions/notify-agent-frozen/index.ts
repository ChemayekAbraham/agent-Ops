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
  if (await attemptYoolaPrimary(phone, message, { source: "notify-agent-frozen" })) return true;
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username) {
    console.error("[notify-agent-frozen] Missing AT credentials");
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
    console.log(`[notify-agent-frozen] AT response (${res.status}) for ${to}:`, raw);
    const data = JSON.parse(raw);
    const recipients = data?.SMSMessageData?.Recipients || [];
    return recipients.some((r: any) => r.statusCode === 101 || r.statusCode === 100);
  } catch (err) {
    console.error("[notify-agent-frozen] AT error", err);
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const auth = req.headers.get("Authorization");
    if (!auth) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Only landlord ops / managers / super_admin may trigger frozen SMS
    const token = auth.replace("Bearer ", "");
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: roles } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", userData.user.id);
    const allowed = (roles || []).some((r: any) =>
      ["manager", "super_admin", "coo", "cto", "ceo", "landlord_ops"].includes(r.role),
    );
    if (!allowed) {
      return new Response(JSON.stringify({ error: "Not authorized" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { agent_id } = await req.json();
    if (!agent_id) {
      return new Response(JSON.stringify({ error: "Missing agent_id" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Read the active full freeze for this agent
    const { data: block } = await admin
      .from("agent_listing_blocks")
      .select("blocked_until, reason, freeze_scope")
      .eq("agent_id", agent_id)
      .eq("active", true)
      .gt("blocked_until", new Date().toISOString())
      .order("blocked_until", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!block) {
      return new Response(JSON.stringify({ error: "No active freeze found for agent" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: profile } = await admin
      .from("profiles")
      .select("full_name, phone")
      .eq("id", agent_id)
      .maybeSingle();

    const phone = profile?.phone;
    const name = (profile?.full_name || "Agent").split(" ")[0];
    const until = new Date(block.blocked_until);
    const untilStr = until.toLocaleDateString("en-GB", {
      day: "2-digit", month: "short", year: "numeric", timeZone: "Africa/Kampala",
    });
    const daysLeft = Math.max(
      1,
      Math.ceil((until.getTime() - Date.now()) / (1000 * 60 * 60 * 24)),
    );
    const scopeAll = (block.freeze_scope || "listing") === "all";

    let sent = false;
    if (phone) {
      const activityLine = scopeAll
        ? `You cannot list houses or carry out any agent activities until ${untilStr} (about ${daysLeft} day${daysLeft === 1 ? "" : "s"}).`
        : `You cannot list houses until ${untilStr} (about ${daysLeft} day${daysLeft === 1 ? "" : "s"}).`;
      const msg =
        `WELILE: Hi ${name}, your account has been BLOCKED. ` +
        `${activityLine} ` +
        `Reason: ${block.reason}. ` +
        `Need help? Call or WhatsApp: +256777607640`;
      sent = await sendSMS(phone, msg);
    } else {
      console.warn(`[notify-agent-frozen] Agent ${agent_id} has no phone`);
    }

    return new Response(JSON.stringify({ success: true, sms_sent: sent, phone_present: !!phone }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[notify-agent-frozen] Error:", err);
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});