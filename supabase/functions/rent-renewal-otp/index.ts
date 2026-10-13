import "../_shared/noSignupPrompt.ts";
// Tenant consent code for renewing a completed Rent Plan.
// action "send": texts a 6-digit code to the tenant (one SMS part, max 160 GSM-7 chars).
// action "verify": checks the code; the rent_requests trigger then allows one renewal.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendSMS, toGsm7, isUgandanPhone } from "../_shared/sendSmsMultiProvider.ts";
import { appendSupportFooter } from "../_shared/smsFooter.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};
const URL_ = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const TTL_MIN = 10;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_S = 45;

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function genCode() {
  const a = new Uint32Array(1); crypto.getRandomValues(a);
  return String(a[0] % 1_000_000).padStart(6, "0");
}

/** Build the SMS so the final transmitted body (incl. support footer) is one part. */
export function buildRenewalSms(agentName: string, code: string): string {
  const name = toGsm7((agentName || "Your agent").trim()).replace(/\s+/g, " ");
  for (let n = Math.min(name.length, 30); n >= 0; n--) {
    const who = n === 0 ? "Your agent" : `Agent ${name.slice(0, n).trim()}`;
    const body = `Welile: ${who} is renewing your Rent Plan. Code ${code}. Share only if you agree. Help: contact Welile Support on `;
    const msg = toGsm7(appendSupportFooter(body + (Deno.env.get("SUPPORT_PHONE")?.trim() || "0748747134")));
    if (msg.length <= 160) return body + (Deno.env.get("SUPPORT_PHONE")?.trim() || "0748747134");
  }
  throw new Error("SMS_TOO_LONG");
}
const mask = (p: string) => p.replace(/\D/g, "").replace(/^(\d{3})\d+(\d{3})$/, "$1******$2");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const admin = createClient(URL_, SERVICE);
    const { data: u } = await admin.auth.getUser(token);
    if (!u?.user) return json({ error: "Not signed in" }, 401);
    const body = await req.json().catch(() => ({}));
    const action = body?.action;
    const prevId = String(body?.prev_request_id || "");
    if (!/^[0-9a-f-]{36}$/i.test(prevId) || !["send", "verify"].includes(action)) {
      return json({ error: "Invalid request" }, 400);
    }
    const userClient = createClient(URL_, ANON, { global: { headers: { Authorization: `Bearer ${token}` } } });
    const { data: ctx, error: ctxErr } = await userClient.rpc("rent_renewal_otp_context", { p_prev_request_id: prevId });
    if (ctxErr) return json({ error: ctxErr.message }, 403);
    const c = ctx as any;

    if (action === "send") {
      const phone = String(c.tenant_phone || "");
      if (!isUgandanPhone(phone)) return json({ error: "The tenant has no valid phone number on file, so the renewal code cannot be sent." }, 400);
      const { data: last } = await admin.from("rent_renewal_otps").select("created_at")
        .eq("tenant_id", c.tenant_id).eq("agent_id", c.agent_id).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (last && Date.now() - new Date(last.created_at).getTime() < RESEND_COOLDOWN_S * 1000) {
        return json({ error: `Please wait ${RESEND_COOLDOWN_S} seconds before sending another code.` }, 429);
      }
      const code = genCode();
      const message = buildRenewalSms(c.agent_name, code);
      const { data: row, error: insErr } = await admin.from("rent_renewal_otps").insert({
        prev_request_id: prevId, tenant_id: c.tenant_id, agent_id: c.agent_id,
        code_hash: await sha256(`${prevId}:${code}`),
        expires_at: new Date(Date.now() + TTL_MIN * 60_000).toISOString(),
      }).select("id").single();
      if (insErr) throw insErr;
      const ok = await sendSMS(phone, message, {
        admin, source: "rent_renewal_otp", reference_id: prevId,
        recipient_user_id: c.tenant_id, recipient_name: c.tenant_name, idempotencyKey: `rent_renewal_otp:${row.id}`,
      });
      if (!ok) return json({ error: "The code could not be sent to the tenant. Try again." }, 502);
      return json({ sent: true, phone_masked: mask(phone), expires_in_min: TTL_MIN });
    }

    const code = String(body?.code || "").trim();
    if (!/^\d{6}$/.test(code)) return json({ error: "Enter the 6-digit code." }, 400);
    const { data: otp } = await admin.from("rent_renewal_otps").select("*")
      .eq("prev_request_id", prevId).eq("agent_id", c.agent_id).is("verified_at", null)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!otp) return json({ error: "No code found. Send a new code." }, 400);
    if (new Date(otp.expires_at) < new Date()) return json({ error: "The code expired. Send a new code." }, 400);
    if (otp.attempts >= MAX_ATTEMPTS) return json({ error: "Too many wrong tries. Send a new code." }, 429);
    if ((await sha256(`${prevId}:${code}`)) !== otp.code_hash) {
      await admin.from("rent_renewal_otps").update({ attempts: otp.attempts + 1 }).eq("id", otp.id);
      return json({ error: "Wrong code. Check with the tenant and try again." }, 400);
    }
    await admin.from("rent_renewal_otps").update({ verified_at: new Date().toISOString() }).eq("id", otp.id);
    return json({ verified: true });
  } catch (e) {
    return json({ error: (e as Error).message || "Something went wrong" }, 500);
  }
});
