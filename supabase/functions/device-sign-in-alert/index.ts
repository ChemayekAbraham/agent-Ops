// The owner's side of new-device sign-in alerts.
//
//   action: "list"    -> devices that signed in to this account and await an
//                        answer. Only shown to a device the owner already trusts:
//                        the new device itself never sees (or answers) its own alert.
//   action: "respond" -> { target_device_fp, trust }. trust=true keeps the device;
//                        trust=false ends its session and sends a change-password tip.
//
// The list comes from login_devices, which the account cannot edit — an intruder
// signed in as the user can delete notifications, but cannot hide this.
// See migration 20261020100000_new_device_sign_in_alerts.sql.

import { createClient } from "npm:@supabase/supabase-js@2";
import { classifyDevice } from "../_shared/deviceClass.ts";
import { DEVICE_ICON_LABEL, deviceIconKey, placeLabel, sendPasswordTip } from "../_shared/newDeviceAlert.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FP_RE = /^([a-f0-9]{64}|fb_[a-f0-9]{1,64})$/;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const ERRORS: Record<string, string> = {
  same_device: "This device can't answer for itself. Use a phone or computer you normally sign in on.",
  not_trusted_device: "Answer from a phone or computer you normally sign in on.",
  not_pending: "This sign-in has already been answered.",
};

function describe(row: { os: string | null; browser: string | null; user_agent: string | null }) {
  const fromUa = classifyDevice(row.user_agent);
  const os = row.os ?? fromUa.os;
  const browser = row.browser ?? fromUa.browser;
  const icon = deviceIconKey(os);
  const label = `${DEVICE_ICON_LABEL[icon]}${browser && browser !== "Other" ? ` · ${browser}` : ""}`;
  return { icon, os, browser, label };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    if (!token) return json({ error: "Not signed in" }, 401);
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    const user = userData?.user;
    if (userErr || !user) return json({ error: "Not signed in" }, 401);

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? "list");
    const myFp = String(body?.device_fp ?? "").trim();
    if (!FP_RE.test(myFp)) return json({ devices: [] });

    if (action === "list") {
      const { data: me } = await admin
        .from("login_devices")
        .select("status")
        .eq("user_id", user.id)
        .eq("device_fp", myFp)
        .maybeSingle();
      if (me?.status !== "trusted") return json({ devices: [] });

      const { data: rows } = await admin
        .from("login_devices")
        .select("device_fp, os, browser, user_agent, device_class, ip_city, ip_country, last_ip, first_seen_at, alerted_at, last_seen_at")
        .eq("user_id", user.id)
        .eq("status", "pending")
        .neq("device_fp", myFp)
        .order("first_seen_at", { ascending: false })
        .limit(10);

      return json({
        devices: (rows ?? []).map((r: any) => {
          const d = describe(r);
          return {
            device_fp: r.device_fp,
            icon: d.icon,
            label: d.label,
            os: d.os,
            browser: d.browser,
            location: placeLabel(r.ip_city, r.ip_country),
            ip: r.last_ip,
            signed_in_at: r.alerted_at ?? r.first_seen_at,
            last_seen_at: r.last_seen_at,
          };
        }),
      });
    }

    if (action === "respond") {
      const target = String(body?.target_device_fp ?? "").trim();
      if (!FP_RE.test(target) || typeof body?.trust !== "boolean") {
        return json({ error: "Missing device or answer." }, 400);
      }
      const trust = body.trust as boolean;

      const { data: before } = await admin
        .from("login_devices")
        .select("os, browser, user_agent, ip_city, ip_country")
        .eq("user_id", user.id)
        .eq("device_fp", target)
        .maybeSingle();

      const { data: result, error } = await admin.rpc("decide_login_device", {
        p_user_id: user.id,
        p_from_device_fp: myFp,
        p_device_fp: target,
        p_trust: trust,
      });
      if (error) return json({ error: "Could not save your answer. Please try again." }, 500);
      const r = result as { ok: boolean; error?: string; sessions_ended?: number };
      if (!r?.ok) return json({ error: ERRORS[r?.error ?? ""] ?? "Could not save your answer." }, 400);

      // The alert is answered: clear it from the notification list too.
      const nowIso = new Date().toISOString();
      await admin
        .from("notifications")
        .update({ is_read: true, read_at: nowIso, dismissed_at: nowIso })
        .eq("user_id", user.id)
        .like("event_key", `new_device_sign_in:${target}:%`);

      if (!trust && before) {
        const d = describe(before as any);
        await sendPasswordTip(admin, user, {
          icon: d.icon,
          label: d.label,
          place: placeLabel((before as any).ip_city, (before as any).ip_country),
        }).catch((e) => console.error("[device-sign-in-alert] tip failed:", e));
      }

      return json({ success: true, status: trust ? "trusted" : "rejected", sessions_ended: r.sessions_ended ?? 0 });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("[device-sign-in-alert] unexpected:", e);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
