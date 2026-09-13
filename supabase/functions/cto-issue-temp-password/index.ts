import "../_shared/noSignupPrompt.ts";
import "../_shared/smsFooterInterceptor.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const LOGIN_URL = "https://welileapp.com";

// Roles allowed to issue a temporary password for another user.
const ISSUER_ROLES = ["cto", "manager", "super_admin"];

const KNOWN_COUNTRY_CODES = ["256"];

function formatPhoneInternational(rawPhone: string): string {
  let digits = (rawPhone || "").replace(/\D/g, "");
  for (const code of KNOWN_COUNTRY_CODES) {
    if (digits.startsWith(code) && digits.length > code.length + 5) {
      return "+" + digits;
    }
  }
  if (digits.startsWith("0")) {
    digits = "256" + digits.slice(1);
  } else if (digits.length === 9) {
    digits = "256" + digits;
  }
  return "+" + digits;
}

// ---- SMS provider chain (mirrors password-reset-sms) ----
async function sendViaYoola(phone: string, message: string): Promise<{ ok: boolean; reason?: string }> {
  const apiKey = Deno.env.get("YOOLA_SMS_API_KEY")?.trim();
  if (!apiKey) return { ok: false, reason: "yoola_not_configured" };
  try {
    const phoneYoola = formatPhoneInternational(phone).replace(/^\+/, "");
    const response = await fetch("https://yoolasms.com/api/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ phone: phoneYoola, message, api_key: apiKey, sender: "WELILE" }),
    });
    const text = await response.text();
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(text); } catch { /* non-JSON */ }
    const status = String(data?.status ?? "").toLowerCase();
    if (response.ok && (status === "success" || status === "ok" || status === "sent" || status === "queued" || (!data?.error && status === ""))) {
      return { ok: true };
    }
    return { ok: false, reason: `Yoola rejected (${response.status})` };
  } catch (error) {
    console.error("[cto-issue-temp-password] Yoola error:", error);
    return { ok: false, reason: "Network error contacting SMS provider" };
  }
}

async function sendViaAfricasTalking(phone: string, message: string): Promise<{ ok: boolean; reason?: string }> {
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username) return { ok: false, reason: "SMS service not configured" };
  const isSandbox = username.toLowerCase() === "sandbox";
  const baseUrl = isSandbox
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";
  const formattedPhone = formatPhoneInternational(phone);
  try {
    const params = new URLSearchParams({ username, from: "WELILE", to: formattedPhone, message });
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: { "apiKey": apiKey, "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
      body: params.toString(),
    });
    const data = await response.json();
    const recipients = data?.SMSMessageData?.Recipients;
    if (recipients?.length > 0) {
      const status = recipients[0].statusCode;
      if (status === 101 || status === 100) return { ok: true };
      return { ok: false, reason: recipients[0].status || "SMS provider rejected the request" };
    }
    return { ok: false, reason: "No recipient response from SMS provider" };
  } catch (error) {
    console.error("[cto-issue-temp-password] AT error:", error);
    return { ok: false, reason: "Network error contacting SMS provider" };
  }
}

async function sendViaLana(phone: string, message: string): Promise<{ ok: boolean; reason?: string }> {
  const apiKey = Deno.env.get("LANA_SMS_API_KEY")?.trim();
  if (!apiKey) return { ok: false, reason: "lana_not_configured" };
  try {
    const phoneLana = formatPhoneInternational(phone).replace(/^\+/, "");
    const response = await fetch("https://api.lanasms.com/v1/send", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ phone: phoneLana, sender_id: "WELILE", message}),
    });
    const text = await response.text();
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(text); } catch { /* non-JSON */ }
    const statusStr = String(data?.status ?? "").toLowerCase();
    const accepted = data?.status === true || statusStr === "success" || statusStr === "true" || statusStr === "ok" || statusStr === "sent" || statusStr === "queued";
    if (response.ok && accepted) return { ok: true };
    return { ok: false, reason: `LANA rejected (${response.status})` };
  } catch (error) {
    console.error("[cto-issue-temp-password] LANA error:", error);
    return { ok: false, reason: "Network error contacting SMS provider" };
  }
}

async function sendSMS(phone: string, message: string): Promise<{ ok: boolean; reason?: string; provider?: string }> {
  const yoola = await sendViaYoola(phone, message);
  if (yoola.ok) return { ok: true, provider: "yoola" };
  const at = await sendViaAfricasTalking(phone, message);
  if (at.ok) return { ok: true, provider: "africastalking" };
  const lana = await sendViaLana(phone, message);
  if (lana.ok) return { ok: true, provider: "lana" };
  return { ok: false, reason: at.reason || yoola.reason || lana.reason || "SMS not sent" };
}

function rand(set: string): string {
  const r = crypto.getRandomValues(new Uint32Array(1))[0] / 0x100000000;
  return set[Math.floor(r * set.length)];
}

// Human-readable temporary password with strong random entropy so it clears
// leaked-password (HIBP) protection while still being easy to relay.
function generateTempPassword(): string {
  const upper = "ABCDEFGHJKMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnpqrstuvwxyz";
  const digits = "23456789";
  const symbols = "@#$%&*";
  const all = upper + lower + digits + symbols;
  const chars = [rand(upper), rand(upper), rand(lower), rand(lower), rand(digits), rand(digits), rand(symbols)];
  for (let i = 0; i < 6; i++) chars.push(rand(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor((crypto.getRandomValues(new Uint32Array(1))[0] / 0x100000000) * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return "Welile-" + chars.join("");
}

function maskPhone(p: string): string {
  const d = (p || "").replace(/\D/g, "");
  if (d.length < 4) return "***";
  return `${d.slice(0, 3)}****${d.slice(-3)}`;
}
function maskEmail(e: string): string {
  const [name, domain] = (e || "").split("@");
  if (!domain) return "***";
  const shown = name.slice(0, 2);
  return `${shown}${"*".repeat(Math.max(1, name.length - 2))}@${domain}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

    // 1. Authenticate caller
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "").trim();
    if (!token) return json({ error: "Unauthorized" }, 401);

    const { data: authData, error: authError } = await admin.auth.getUser(token);
    const caller = authData?.user;
    if (authError || !caller) return json({ error: "Unauthorized" }, 401);

    // 2. Authorize caller role
    const { data: roleRows, error: roleError } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", caller.id)
      .eq("enabled", true)
      .in("role", ISSUER_ROLES);
    if (roleError) return json({ error: "Authorisation check failed" }, 500);
    if (!roleRows || roleRows.length === 0) {
      return json({ error: "You do not have permission to issue temporary passwords." }, 403);
    }

    // 3. Validate input
    const body = await req.json().catch(() => ({}));
    const identifier = String(body?.identifier ?? "").trim();
    if (!identifier) return json({ error: "Enter a phone number or email address." }, 400);

    const isEmail = identifier.includes("@");

    // 4. Resolve target user
    let targetId: string | null = null;
    let targetPhone: string | null = null;
    let targetEmail: string | null = null;
    let targetName: string | null = null;

    if (isEmail) {
      const email = identifier.toLowerCase();
      const { data: rows, error } = await admin
        .from("profiles")
        .select("id, phone, email, full_name")
        .ilike("email", email)
        .limit(2);
      if (error) return json({ error: "Lookup failed. Please try again." }, 500);
      if (!rows || rows.length === 0) return json({ error: `No user found with email ${identifier}.` }, 404);
      if (rows.length > 1) return json({ error: "Multiple users share that email. Search by phone instead." }, 409);
      targetId = rows[0].id;
      targetPhone = rows[0].phone;
      targetEmail = rows[0].email;
      targetName = rows[0].full_name;
    } else {
      const key = identifier.replace(/\D/g, "").slice(-9);
      if (key.length < 9) return json({ error: "Enter a valid Ugandan phone number (9 digits after the leading 0)." }, 400);
      const candidates = [`0${key}`, `256${key}`, `+256${key}`, key];
      const { data: rows, error } = await admin
        .from("profiles")
        .select("id, phone, email, full_name")
        .in("phone", candidates)
        .limit(5);
      if (error) return json({ error: "Lookup failed. Please try again." }, 500);
      let matches = rows || [];
      if (matches.length === 0) {
        const { data: fuzzy } = await admin
          .from("profiles")
          .select("id, phone, email, full_name")
          .ilike("phone", `%${key}`)
          .limit(5);
        matches = (fuzzy || []).filter((r) => (r.phone || "").replace(/\D/g, "").slice(-9) === key);
      }
      if (matches.length === 0) return json({ error: `No user found with phone ${identifier}.` }, 404);
      if (matches.length > 1) return json({ error: "Multiple users share that phone number. Search by email instead." }, 409);
      targetId = matches[0].id;
      targetPhone = matches[0].phone;
      targetEmail = matches[0].email;
      targetName = matches[0].full_name;
    }

    if (!targetId) return json({ error: "Could not resolve the user." }, 404);

    // 5. Generate + set temporary password
    const tempPassword = generateTempPassword();
    const { error: updErr } = await admin.auth.admin.updateUserById(targetId, { password: tempPassword });
    if (updErr) {
      const isWeak = (updErr as { code?: string })?.code === "weak_password" || /weak|pwned|known to be/i.test(updErr.message ?? "");
      return json({ error: isWeak ? "Generated password was rejected, please retry." : updErr.message }, 400);
    }

    // 6. Flag the account so the user is forced to reset on next login
    const { error: flagErr } = await admin
      .from("profiles")
      .update({ must_change_password: true })
      .eq("id", targetId);
    if (flagErr) console.warn("[cto-issue-temp-password] Failed to set must_change_password:", flagErr.message);

    // 7. Deliver via SMS (best effort)
    const message = `Welile: A temporary password has been set for your account. Temp password: ${tempPassword}\nSign in at ${LOGIN_URL} then set a new password. This is required.`;
    let deliveredVia = "none";
    let deliveryError: string | null = null;
    if (targetPhone) {
      const sms = await sendSMS(targetPhone, message);
      if (sms.ok) deliveredVia = `sms:${sms.provider}`;
      else deliveryError = sms.reason ?? "SMS not sent";
    }

    // 8. Audit (best effort)
    // This insert runs via the admin (service-role) client, so the
    // audit_logs IP-capture trigger only ever sees THIS function's own
    // outbound call context, not the real caller's browser -- the same gap
    // found in admin-reset-password. Captured here instead, from this
    // function's own incoming request, and passed explicitly.
    const clientIp =
      (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
      req.headers.get("cf-connecting-ip") ||
      null;
    const userAgent = req.headers.get("user-agent") || null;

    admin.from("audit_logs").insert({
      user_id: caller.id,
      action_type: "cto_temp_password_issued",
      table_name: "profiles",
      record_id: targetId,
      ip_address: clientIp,
      user_agent: userAgent,
      metadata: {
        reason: "CTO issued temporary password + forced reset",
        target_user_id: targetId,
        identifier_type: isEmail ? "email" : "phone",
        delivered_via: deliveredVia,
        delivery_error: deliveryError,
        issued_at: new Date().toISOString(),
      },
    }).then(() => {}, (e: unknown) => console.warn("[cto-issue-temp-password] audit insert failed:", e));

    return json({
      success: true,
      temp_password: tempPassword,
      login_url: LOGIN_URL,
      delivered_via: deliveredVia,
      delivery_error: deliveryError,
      user_name: targetName,
      masked_target: targetPhone ? maskPhone(targetPhone) : (targetEmail ? maskEmail(targetEmail) : null),
      has_phone: !!targetPhone,
    });
  } catch (error) {
    console.error("[cto-issue-temp-password] Error:", error);
    return json({ error: (error as Error).message || "Unexpected error" }, 400);
  }
});
