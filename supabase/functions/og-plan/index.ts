import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SITE_URL = "https://welileapp.com";
const ROI_RATE = 15;

const ugx = (n: number) => `UGX ${Math.round(n).toLocaleString("en-UG")}`;

// Escape every DB/URL-derived string before embedding it in the HTML head.
const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const pretty = (s: unknown) =>
  String(s ?? "")
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();

/**
 * Open Graph wrapper for shared rent-plan links.
 *
 * WhatsApp/Facebook/X only read tags from the HTML the crawler receives, and
 * the app is a static SPA, so `/s/<code>` alone can never carry the house
 * photo. This function resolves the same trackable short code, emits the plan's
 * first house image as og:image, and forwards humans to the funder page.
 *
 * Accepts /og-plan/<code>, ?code=<code>, or ?c=<code>.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const url = new URL(req.url);
  const tail = url.pathname.split("/").filter(Boolean).pop() ?? "";
  const code = (url.searchParams.get("code") || url.searchParams.get("c") || (tail === "og-plan" ? "" : tail))
    .trim();

  if (!code || !/^[A-Za-z0-9_-]{4,32}$/.test(code)) {
    // Controlled 404 — never hand back the generic SPA page for a bad code.
    return new Response("Short link not found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: link } = await supabase
    .from("short_links")
    .select("code, target_path, target_params, og_title, og_description, og_image_url, destination_path")
    .eq("code", code)
    .maybeSingle();

  const params = (link?.target_params ?? {}) as Record<string, string>;
  if (!link) {
    return new Response("Short link not found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders },
    });
  }
  const planId = params.plan ?? "";
  const ref = params.ref ?? "";

  // Public, branded identity of this share (never the function URL).
  const publicShareUrl = `${SITE_URL}/s/${code}`;
  // Humans land back in the existing SPA, which resolves ?share=<code>,
  // scrolls to the matching card and opens its details sheet.
  const target = `${SITE_URL}/?share=${encodeURIComponent(code)}`;
  const fallbackPath = link?.target_path ?? "/funder-onboarding";

  let plan: {
    funding_amount: number | null;
    house_category: string | null;
    request_city: string | null;
    tenant_location: string | null;
    house_image_urls: string[] | null;
  } | null = null;

  if (/^[0-9a-f-]{36}$/i.test(planId)) {
    // The fundable-plans view carries the same fields the funder card shows
    // (full tenant location + photos); fall back to the raw request row.
    const { data } = await supabase
      .from("v_partner_self_fundable_plans")
      .select("funding_amount, house_category, request_city, tenant_location, house_image_urls")
      .eq("rent_request_id", planId)
      .maybeSingle();
    plan = data as typeof plan;
    if (!plan) {
      const { data: raw } = await supabase
        .from("rent_requests")
        .select("rent_amount, house_category, request_city, house_image_urls")
        .eq("id", planId)
        .maybeSingle();
      if (raw) {
        plan = {
          funding_amount: (raw as any).rent_amount,
          house_category: (raw as any).house_category,
          request_city: (raw as any).request_city,
          tenant_location: null,
          house_image_urls: (raw as any).house_image_urls,
        };
      }
    }
  }

  // Click tracking: social/preview crawlers must never count as human clicks.
  const ua = req.headers.get("user-agent") ?? "";
  const isCrawler =
    /bot|crawler|spider|facebookexternalhit|whatsapp|telegram|slack|discord|twitter|linkedin|embed|preview|pinterest|skype|vkshare|quora|google|bing|applebot|redditbot/i
      .test(ua);
  if (!isCrawler) {
    try {
      await supabase.rpc("record_short_link_click", {
        p_code: code,
        p_user_agent: ua,
        p_referrer: req.headers.get("referer") ?? "",
      });
    } catch { /* preview must never fail on analytics */ }
  }

  const houseTitle = pretty(plan?.house_category) || "Rental Home";
  const locParts = String(plan?.tenant_location || plan?.request_city || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const location = locParts.length ? `${locParts.join(", ")}, Uganda` : "Uganda";
  const rent = Number(plan?.funding_amount ?? 0);
  const monthly = Math.round((rent * ROI_RATE) / 100);

  // Stored preview metadata wins (it is written server-side on every share tap);
  // live plan data is the fallback for older links and for deleted plans.
  const title = link?.og_title || `Support a tenant in a ${houseTitle} in ${location}`;
  const description = link?.og_description || (rent
    ? `Support this tenant for ${ugx(rent)} by paying their landlord on the platform and earn ${ugx(monthly)} per month for the next 12 months Start here today.`
    : "Support a tenant's rent on Welile and earn monthly returns. Support today.");
  const image =
    plan?.house_image_urls?.find(Boolean) ||
    link?.og_image_url ||
    `${SITE_URL}/house-listing-og.jpg`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Welile" />
  <meta property="og:url" content="${esc(publicShareUrl)}" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:image" content="${esc(image)}" />
  <meta property="og:image:secure_url" content="${esc(image)}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="${esc(`${houseTitle} in ${location}`)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(description)}" />
  <meta name="twitter:image" content="${esc(image)}" />
  <meta http-equiv="refresh" content="0;url=${esc(target)}" />
  <link rel="canonical" href="${esc(publicShareUrl)}" />
</head>
<body>
  <p>Redirecting to <a href="${esc(target)}">${esc(title)}</a>…${ref || planId || fallbackPath ? "" : ""}</p>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      ...corsHeaders,
    },
  });
});
