// Stage 4C/4D/4E: secure tenant dashboard link open.
//
// Public endpoint behind welileapp.com/t/{token}. Validates the token, records
// the access with device evidence, advances the dashboard lifecycle, and fires
// DASHBOARD_ACTIVATED on a genuine first open.
//
// WHAT THIS DOES NOT DO: it does not sign the tenant in. The platform
// authenticates by OTP (otp_verifications), and turning a URL in an SMS into a
// session would be a new security posture for ~62k tenants — SMS forwarding,
// shared handsets and browser history all leak URLs. So the token proves
// DEVICE CAPABILITY and records engagement, which is exactly what the
// smartphone lifecycle needs; viewing balances still requires the existing
// OTP step. This response therefore returns no financial data — only enough
// for the page to start the OTP flow for the right person.
//
// Invalid, expired and revoked tokens all return the same shape, so the
// endpoint cannot be used to probe for live tokens.
import "../_shared/smsFooterInterceptor.ts";
import "../_shared/noSignupPrompt.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { classifyDevice, sha256Hex } from "../_shared/deviceClass.ts";
import { notifyTenant } from "../_shared/tenantNotify.ts";
import { loadEvent, renderTemplate } from "../_shared/tenantTemplates.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const ACTIVATION_EVENT = "DASHBOARD_ACTIVATED";

/** Last three digits, so the page can say which number the OTP will reach. */
function phoneHint(phone: string | null): string | null {
  const digits = String(phone ?? "").replace(/[^0-9]/g, "");
  return digits.length >= 3 ? `***${digits.slice(-3)}` : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const json = (bodyObj: unknown, status = 200) =>
    new Response(JSON.stringify(bodyObj), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let token = "";
    if (req.method === "GET") {
      token = new URL(req.url).searchParams.get("token") ?? "";
    } else {
      try {
        const body = await req.json();
        token = String(body?.token ?? "");
      } catch {
        token = "";
      }
    }
    token = token.trim();

    if (!token) return json({ valid: false }, 200);

    const userAgent = req.headers.get("user-agent");
    const device = classifyDevice(userAgent);
    const referrer = req.headers.get("referer") ?? req.headers.get("referrer");

    // IP is hashed, never stored raw: it is only needed to spot abuse.
    const rawIp =
      (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() ||
      req.headers.get("cf-connecting-ip") ||
      "";
    const ipHash = rawIp ? await sha256Hex(rawIp) : null;

    const tokenHash = await sha256Hex(token);

    const { data: result, error } = await admin.rpc("record_tenant_dashboard_access", {
      p_token_hash: tokenHash,
      p_is_smartphone_evidence: device.isSmartphoneEvidence,
      p_user_agent: userAgent,
      p_device_class: device.deviceClass,
      p_browser: device.browser,
      p_os: device.os,
      p_referrer: referrer,
      p_ip_hash: ipHash,
    });

    if (error) {
      console.error("[tenant-dashboard-open] record failed:", error.message);
      return json({ valid: false }, 200);
    }

    if (!result?.valid) return json({ valid: false }, 200);

    const tenantId = String(result.tenant_id);

    const { data: profile } = await admin
      .from("profiles")
      .select("full_name, phone, dashboard_access_count")
      .eq("id", tenantId)
      .maybeSingle();

    // Welcome SMS on the first genuine open. A preview bot's fetch counts as
    // an access for auditing but must not trigger a welcome for a tenant who
    // has not actually opened anything yet.
    if (result.first_access === true && device.isSmartphoneEvidence) {
      try {
        const event = await loadEvent(admin, ACTIVATION_EVENT);
        if (event?.active && event.body_template && profile?.phone) {
          // The activation message needs a link; reuse the one just opened.
          const origin = Deno.env.get("PUBLIC_SITE_ORIGIN") || "https://welileapp.com";
          const message = renderTemplate(event.body_template, {
            dashboard_link: `${origin}/t/${token}`,
          });
          await notifyTenant({
            admin,
            tenantId,
            eventKey: ACTIVATION_EVENT,
            // Once, ever — not once per day.
            episodeKey: "activated",
            phone: String(profile.phone),
            tenantName: profile.full_name ?? null,
            message,
            payload: { device_class: device.deviceClass, os: device.os },
          });
        }
      } catch (err) {
        // A welcome SMS must never fail the dashboard open.
        console.error("[tenant-dashboard-open] activation SMS failed:", err);
      }
    }

    console.log(
      `[tenant-dashboard-open] tenant=${tenantId} device=${device.deviceClass} ` +
        `evidence=${device.isSmartphoneEvidence} first=${result.first_access}`,
    );

    return json({
      valid: true,
      tenant_id: tenantId,
      first_access: result.first_access === true,
      smartphone_confirmed: result.smartphone_confirmed === true,
      device_class: device.deviceClass,
      access_count: profile?.dashboard_access_count ?? null,
      // Enough to start the OTP flow, and nothing financial.
      phone_hint: phoneHint(profile?.phone ?? null),
      requires_verification: true,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[tenant-dashboard-open] Fatal:", msg);
    return new Response(JSON.stringify({ valid: false }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
