// New-device sign-in alerts: what the owner is told, and how.
//
// Used by device-step-up (detection on every app load) and device-sign-in-alert
// (the owner's answer). See migration 20261020100000_new_device_sign_in_alerts.sql.
//
// IP and user agent are read from the request on the server — never from what
// the device says about itself. Location: Cloudflare's own geo headers first
// (no third party), then ipwho.is over HTTPS (free, keyless; the same source
// lead-link-click uses, which resolved 563/563 clicks in Oct 2026).

import { resolveTrustedClientIp, getClientUserAgent } from "./resolveClientIp.ts";
import { classifyDevice } from "./deviceClass.ts";
import { isUnusableEmail } from "./twoFactorEmail.ts";

export type DeviceIconKey = "iphone" | "android" | "windows" | "mac" | "linux" | "unknown";

/** Maps classifyDevice().os onto the six device icons shown to the owner. */
export function deviceIconKey(os: string | null | undefined): DeviceIconKey {
  switch (os) {
    case "iOS":
    case "iPadOS":
      return "iphone";
    case "Android":
      return "android";
    case "Windows":
      return "windows";
    case "macOS":
      return "mac";
    case "Linux":
      return "linux";
    default:
      return "unknown";
  }
}

/** Email icons are emoji: many mail apps block SVG and remote images. */
export const DEVICE_ICON_EMOJI: Record<DeviceIconKey, string> = {
  iphone: "📱",
  android: "🤖",
  windows: "🪟",
  mac: "💻",
  linux: "🐧",
  unknown: "❔",
};

export const DEVICE_ICON_LABEL: Record<DeviceIconKey, string> = {
  iphone: "iPhone / iPad",
  android: "Android",
  windows: "Windows",
  mac: "Mac",
  linux: "Linux",
  unknown: "Unknown device",
};

const SITE_URL = "https://welileapp.com";

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 of an email action token: only the hash is ever stored. */
export function hashActionToken(token: string): Promise<string> {
  return sha256Hex(`device-alert:${token}`);
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Single-use "this was me" / "sign it out" links for the alert email. Each opens
 * a confirm page (/device-check); see use_device_alert_token. Null if they could
 * not be stored, in which case the email goes without buttons.
 */
// deno-lint-ignore no-explicit-any
async function mintActionLinks(admin: any, userId: string, deviceFp: string): Promise<{ trustUrl: string; rejectUrl: string } | null> {
  const trust = randomToken();
  const reject = randomToken();
  const { error } = await admin.from("device_alert_action_tokens").insert([
    { token_hash: await hashActionToken(trust), user_id: userId, device_fp: deviceFp, action: "trust" },
    { token_hash: await hashActionToken(reject), user_id: userId, device_fp: deviceFp, action: "reject" },
  ]);
  if (error) {
    console.error("[newDeviceAlert] could not store action links:", error.message);
    return null;
  }
  return {
    trustUrl: `${SITE_URL}/device-check?t=${encodeURIComponent(trust)}`,
    rejectUrl: `${SITE_URL}/device-check?t=${encodeURIComponent(reject)}`,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The auth session id inside an access token (already verified by getUser). */
export function sessionIdFromJwt(token: string): string | null {
  try {
    let part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    while (part.length % 4) part += "=";
    const sid = JSON.parse(atob(part))?.session_id;
    return typeof sid === "string" && UUID_RE.test(sid) ? sid : null;
  } catch {
    return null;
  }
}

const PRIVATE_IP = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|fc|fd|fe80)/i;

export async function resolveIpLocation(
  req: Request,
  ip: string | null,
): Promise<{ city: string | null; country: string | null }> {
  let country = req.headers.get("cf-ipcountry");
  let city = req.headers.get("cf-ipcity");
  if (country === "XX" || country === "T1") country = null;
  if ((!country || !city) && ip && !PRIVATE_IP.test(ip)) {
    try {
      const r = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country,country_code,city`, {
        signal: AbortSignal.timeout(2500),
      });
      const g = await r.json();
      if (g?.success) {
        country = country || g.country || g.country_code || null;
        city = city || g.city || null;
      }
    } catch {
      /* location is best-effort */
    }
  }
  return { city: city || null, country: country || null };
}

function placeLabel(city: string | null, country: string | null): string | null {
  return [city, country].filter(Boolean).join(", ") || null;
}

function eat(at: Date): string {
  return at.toLocaleString("en-UG", { timeZone: "Africa/Kampala", dateStyle: "medium", timeStyle: "short" });
}

// deno-lint-ignore no-explicit-any
async function ownerEmail(admin: any, user: { id: string; email?: string | null }): Promise<string | null> {
  if (!isUnusableEmail(user.email)) return String(user.email).toLowerCase();
  const { data } = await admin.from("profiles").select("email").eq("id", user.id).maybeSingle();
  const e = data?.email as string | null | undefined;
  return e && !isUnusableEmail(e) ? e.toLowerCase() : null;
}

/**
 * Tells the owner a new device signed in: a notification (the dialog on their
 * trusted devices reads login_devices, not this row) and an email when the
 * account has a real address. Sends at most once per pending device.
 */
export async function sendNewDeviceAlert(
  // deno-lint-ignore no-explicit-any
  admin: any,
  req: Request,
  user: { id: string; email?: string | null },
  deviceFp: string,
  bodyUserAgent?: string | null,
): Promise<void> {
  const ip = resolveTrustedClientIp(req);
  const ua = getClientUserAgent(req) || bodyUserAgent || "";
  const device = classifyDevice(ua);
  const icon = deviceIconKey(device.os);
  const { city, country } = await resolveIpLocation(req, ip);

  const { data: claimed, error } = await admin.rpc("claim_login_device_alert", {
    p_user_id: user.id,
    p_device_fp: deviceFp,
    p_ip: ip,
    p_city: city,
    p_country: country,
    p_os: device.os,
    p_browser: device.browser,
    p_device_class: device.deviceClass,
  });
  if (error || claimed !== true) return;

  const now = new Date();
  const deviceLabel = `${DEVICE_ICON_LABEL[icon]}${device.browser && device.browser !== "Other" ? ` · ${device.browser}` : ""}`;
  const place = placeLabel(city, country);

  await admin.from("notifications").insert({
    user_id: user.id,
    type: "security",
    title: "New sign-in to your account",
    message: `${deviceLabel}${place ? ` near ${place}` : ""} signed in to your account on ${eat(now)}. Was this you?`,
    event_key: `new_device_sign_in:${deviceFp}:${now.getTime()}`,
    metadata: {
      kind: "new_device_sign_in",
      device_fp: deviceFp,
      icon,
      os: device.os,
      browser: device.browser,
      device_class: device.deviceClass,
      city,
      country,
      ip,
      signed_in_at: now.toISOString(),
    },
  });

  const to = await ownerEmail(admin, user);
  if (!to) return;
  const { data: profile } = await admin.from("profiles").select("full_name").eq("id", user.id).maybeSingle();
  const links = await mintActionLinks(admin, user.id, deviceFp);
  const { error: mailErr } = await admin.functions.invoke("send-transactional-email", {
    body: {
      templateName: "new-device-sign-in",
      recipientEmail: to,
      templateData: {
        userName: (profile?.full_name as string | null)?.split(" ")[0] || "there",
        deviceIcon: DEVICE_ICON_EMOJI[icon],
        deviceLabel,
        location: place ?? "Unknown location",
        ipAddress: ip ?? "Unknown",
        signedInAt: now.toISOString(),
        trustUrl: links?.trustUrl ?? null,
        rejectUrl: links?.rejectUrl ?? null,
      },
    },
  });
  if (mailErr) console.error("[newDeviceAlert] email failed:", mailErr);
}

/** After the owner says they don't know the device: a change-password tip, never forced. */
export async function sendPasswordTip(
  // deno-lint-ignore no-explicit-any
  admin: any,
  user: { id: string; email?: string | null },
  device: { icon: DeviceIconKey; label: string; place: string | null },
): Promise<void> {
  const now = new Date();
  await admin.from("notifications").insert({
    user_id: user.id,
    type: "security",
    title: "Tip: change your password",
    message: `We signed out the ${device.label}${device.place ? ` near ${device.place}` : ""} you didn't recognise. If someone else knows your password, change it from Settings so they can't sign in again.`,
    event_key: `password_tip:${now.getTime()}`,
    link_path: "/settings",
    metadata: { kind: "password_change_tip", icon: device.icon },
  });

  const to = await ownerEmail(admin, user);
  if (!to) return;
  const { data: profile } = await admin.from("profiles").select("full_name").eq("id", user.id).maybeSingle();
  const { error } = await admin.functions.invoke("send-transactional-email", {
    body: {
      templateName: "password-change-tip",
      recipientEmail: to,
      templateData: {
        userName: (profile?.full_name as string | null)?.split(" ")[0] || "there",
        deviceIcon: DEVICE_ICON_EMOJI[device.icon],
        deviceLabel: device.label,
        location: device.place ?? "Unknown location",
        signedOutAt: now.toISOString(),
      },
    },
  });
  if (error) console.error("[newDeviceAlert] tip email failed:", error);
}

export { placeLabel };
