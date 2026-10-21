// Answers a new-device alert from the email's links (the /device-check page).
//
//   action: "peek"    -> what the link will do and which device it is about.
//                        Changes nothing: mail scanners open links on their own.
//   action: "confirm" -> do it. "trust" keeps the device; "reject" ends its
//                        session and sends the change-password tip.
//
// No sign-in needed: the single-use token in the link is the proof (it reached
// the account's inbox). Only the token's SHA-256 is stored. See migration
// 20261020120000_device_alert_email_actions.sql.

import { createClient } from "npm:@supabase/supabase-js@2";
import { classifyDevice } from "../_shared/deviceClass.ts";
import { DEVICE_ICON_LABEL, deviceIconKey, hashActionToken, placeLabel, sendPasswordTip } from "../_shared/newDeviceAlert.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const TOKEN_RE = /^[A-Za-z0-9_-]{40,64}$/;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const ERRORS: Record<string, string> = {
  invalid: "This link isn't valid. Open the latest alert email, or answer in the Welile app.",
  used: "This link has already been used.",
  expired: "This link has expired. Answer in the Welile app on a device you normally use.",
  answered: "This sign-in has already been answered.",
};

function describe(r: { os?: string | null; browser?: string | null; user_agent?: string | null; city?: string | null; country?: string | null }) {
  const fromUa = classifyDevice(r.user_agent ?? "");
  const os = r.os ?? fromUa.os;
  const browser = r.browser ?? fromUa.browser;
  const icon = deviceIconKey(os);
  return {
    icon,
    label: `${DEVICE_ICON_LABEL[icon]}${browser && browser !== "Other" ? ` · ${browser}` : ""}`,
    location: placeLabel(r.city ?? null, r.country ?? null),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? "peek");
    const token = String(body?.token ?? "").trim();
    if (!TOKEN_RE.test(token)) return json({ ok: false, error: ERRORS.invalid }, 400);
    if (action !== "peek" && action !== "confirm") return json({ ok: false, error: "Unknown action" }, 400);

    const { data, error } = await admin.rpc("use_device_alert_token", {
      p_token_hash: await hashActionToken(token),
      p_peek: action === "peek",
    });
    if (error) {
      console.error("[device-alert-email-action] rpc failed:", error.message);
      return json({ ok: false, error: "Something went wrong. Please try again." }, 500);
    }
    const r = (data ?? {}) as Record<string, any>;
    if (!r.ok) {
      return json({ ok: false, code: r.error, status: r.status ?? null, error: ERRORS[r.error] ?? ERRORS.invalid });
    }

    const device = describe(r);
    if (action === "peek") {
      return json({ ok: true, action: r.action, device: { ...device, signed_in_at: r.signed_in_at } });
    }

    if (r.action === "reject" && r.user_id) {
      const { data: u } = await admin.auth.admin.getUserById(r.user_id);
      if (u?.user) {
        await sendPasswordTip(admin, { id: u.user.id, email: u.user.email }, {
          icon: device.icon,
          label: device.label,
          place: device.location,
        }).catch((e) => console.error("[device-alert-email-action] tip failed:", e));
      }
    }
    // The alert is answered: clear it from the notification list too.
    if (r.user_id && r.device_fp) {
      const nowIso = new Date().toISOString();
      await admin
        .from("notifications")
        .update({ is_read: true, read_at: nowIso, dismissed_at: nowIso })
        .eq("user_id", r.user_id)
        .like("event_key", `new_device_sign_in:${r.device_fp}:%`);
    }

    return json({ ok: true, action: r.action, device, sessions_ended: r.sessions_ended ?? 0 });
  } catch (e) {
    console.error("[device-alert-email-action] unexpected:", e);
    return json({ ok: false, error: "Something went wrong. Please try again." }, 500);
  }
});
