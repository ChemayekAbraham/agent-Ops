// Public click logger for tenant SMS campaign short links (welileapp.com/n/{code}).
// Records time, device (user agent), IP, rough area and optional GPS, then
// returns the campaign destination so the browser can redirect.
import { createClient } from "npm:@supabase/supabase-js@2";
import { resolveTrustedClientIp, getClientUserAgent } from "../_shared/resolveClientIp.ts";
import { classifyDevice, sha256Hex } from "../_shared/deviceClass.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const num = (v: unknown, min: number, max: number) => {
  const n = typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const code = String(body?.code ?? "").trim();
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(code)) return json({ error: "Invalid code" }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: c } = await admin.from("tenant_campaigns").select("id, destination_url").eq("short_code", code).maybeSingle();
  if (!c) return json({ error: "Not found" }, 404);

  // Only the GPS step (`phase: "gps"`) updates an earlier click; otherwise log a new click.
  const ua = getClientUserAgent(req);
  const ip = resolveTrustedClientIp(req);
  const device = classifyDevice(ua);
  const lat = num(body?.gps?.lat, -90, 90);
  const lng = num(body?.gps?.lng, -180, 180);
  const acc = num(body?.gps?.accuracy, 0, 100000);
  const gpsStatus = ["granted", "denied", "unavailable", "timeout", "unsupported"].includes(body?.gps_status)
    ? body.gps_status : null;

  if (body?.phase === "gps" && typeof body?.click_id === "string" && /^[0-9a-f-]{36}$/.test(body.click_id)) {
    await admin.from("tenant_campaign_clicks")
      .update({ gps_status: gpsStatus, gps_lat: lat, gps_lng: lng, gps_accuracy: acc })
      .eq("id", body.click_id).eq("campaign_id", c.id).is("gps_status", null);
    return json({ ok: true });
  }

  const visitor = await sha256Hex(`${ip ?? ""}|${ua ?? ""}`);
  const { data: row } = await admin.from("tenant_campaign_clicks").insert({
    campaign_id: c.id,
    ip_address: ip,
    user_agent: ua?.slice(0, 500) ?? null,
    device_class: device.deviceClass,
    os: device.os,
    browser: device.browser,
    is_bot: device.deviceClass === "bot",
    visitor_hash: visitor,
    referrer: typeof body?.referrer === "string" ? body.referrer.slice(0, 300) : null,
    country: req.headers.get("cf-ipcountry"),
    city: req.headers.get("cf-ipcity"),
  }).select("id").single();

  return json({ destination: c.destination_url, click_id: row?.id ?? null });
});
