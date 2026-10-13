// Public click logger for CRM Customer Leads short links ({domain}/n/{code}).
// Records device (parsed from user agent), IP, country/city, then returns the
// onboarding destination so the browser can redirect.
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

function versions(ua: string) {
  const m = (re: RegExp) => ua.match(re)?.[1]?.replace(/_/g, ".") ?? null;
  const os_version = m(/Android ([\d.]+)/i) ?? m(/OS ([\d_]+) like Mac/i) ?? m(/Windows NT ([\d.]+)/i) ?? m(/Mac OS X ([\d_]+)/i);
  const browser_version = m(/Edg\/([\d.]+)/) ?? m(/OPR\/([\d.]+)/) ?? m(/SamsungBrowser\/([\d.]+)/) ??
    m(/Firefox\/([\d.]+)/) ?? m(/Chrome\/([\d.]+)/) ?? m(/Version\/([\d.]+).*Safari/);
  let device_model = ua.match(/Android [\d.]+;\s*(?:[a-z]{2}-[a-z]{2};\s*)?([^;)]+?)(?:\s+Build\/[^;)]*)?[;)]/i)?.[1]?.trim() ?? null;
  if (device_model === "K") device_model = null; // Chrome reduced UA
  if (!device_model && /iPhone/i.test(ua)) device_model = "iPhone";
  if (!device_model && /iPad/i.test(ua)) device_model = "iPad";
  return { os_version, browser_version, device_model };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const code = String(body?.code ?? "").trim();
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(code)) return json({ error: "Invalid code" }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: link } = await admin.from("lead_links").select("id, destination_path").eq("short_code", code).maybeSingle();
  if (!link) return json({ error: "Not found" }, 404);

  const ua = getClientUserAgent(req) ?? "";
  const ip = resolveTrustedClientIp(req);
  const device = classifyDevice(ua);
  let country = req.headers.get("cf-ipcountry");
  let city = req.headers.get("cf-ipcity");
  let region = req.headers.get("cf-region");
  if ((!country || country === "XX") && ip && !/^(10\.|127\.|192\.168\.|::1)/.test(ip)) {
    try {
      const r = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country_code,city,region`, { signal: AbortSignal.timeout(2500) });
      const g = await r.json();
      if (g?.success) { country = g.country_code ?? null; city = g.city ?? city; region = g.region ?? region; }
    } catch { /* lookup is best-effort */ }
  }
  const { data: row } = await admin.from("lead_link_clicks").insert({
    link_id: link.id,
    ip_address: ip,
    user_agent: ua.slice(0, 500) || null,
    device_class: device.deviceClass,
    os: device.os,
    browser: device.browser,
    ...versions(ua),
    is_bot: device.deviceClass === "bot",
    visitor_hash: await sha256Hex(`${ip ?? ""}|${ua}`),
    referrer: typeof body?.referrer === "string" ? body.referrer.slice(0, 300) : null,
    country, city, region,
  }).select("id").single();

  return json({ destination: link.destination_path, click_id: row?.id ?? null });
});
