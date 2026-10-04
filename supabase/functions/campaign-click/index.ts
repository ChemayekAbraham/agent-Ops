// Public edge function that records a campaign short-link click.
// Returns { link_id, campaign_id, agent_id, location_slug, ... } for the SPA to
// stash locally and later hand to attach_campaign_registration after signup.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function parseUA(ua: string) {
  const u = ua || "";
  const browser = /Chrome/i.test(u)
    ? "Chrome"
    : /Firefox/i.test(u)
    ? "Firefox"
    : /Safari/i.test(u)
    ? "Safari"
    : /Edg/i.test(u)
    ? "Edge"
    : "Other";
  const os = /Android/i.test(u)
    ? "Android"
    : /iPhone|iPad|iOS/i.test(u)
    ? "iOS"
    : /Windows/i.test(u)
    ? "Windows"
    : /Mac/i.test(u)
    ? "macOS"
    : /Linux/i.test(u)
    ? "Linux"
    : "Other";
  const device = /Mobi|Android|iPhone/i.test(u)
    ? "mobile"
    : /iPad|Tablet/i.test(u)
    ? "tablet"
    : "desktop";
  return { browser, os, device };
}

async function sha256(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const shortCode: string | undefined = body.short_code;
    const visitorId: string | undefined = body.visitor_id;
    const referrer: string | undefined = body.referrer;
    if (!shortCode || typeof shortCode !== "string") {
      return new Response(
        JSON.stringify({ error: "short_code required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const { browser, os, device } = parseUA(req.headers.get("user-agent") ?? "");
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
      req.headers.get("cf-connecting-ip") ??
      "";
    const ipHash = ip ? (await sha256(ip)).slice(0, 32) : null;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data, error } = await supabase.rpc("record_campaign_click", {
      p_short_code: shortCode,
      p_visitor_id: visitorId ?? null,
      p_referrer: referrer ?? null,
      p_browser: browser,
      p_os: os,
      p_device: device,
      p_ip_hash: ipHash,
      p_approx_location: null,
    });
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(data ?? { status: "unknown" }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});