import { createClient } from "npm:@supabase/supabase-js@2";
import { cachedPublicPolicy } from "../_shared/partnerReturnPolicy.ts";
import { previewDescription } from "./preview.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SITE_URL = "https://welileapp.com";
/**
 * Public host of the share links. welileapp.com is served by Lovable, which
 * only returns the app shell (logo preview), so links live on a subdomain that
 * proxies this function (infra/share-host/). og:url must name that host:
 * Facebook re-reads the page at og:url.
 */
const SHARE_HOST = "https://share.welileapp.com";

/**
 * The public Returns policy decides only whether a stored description is still current (preview.ts);
 * og-plan never computes a Returns figure. cachedPublicPolicy answers null on any failure, and a
 * missing function (Phase 1 not applied) must be told apart from other failures, so the error code of
 * the last policy read in this isolate is kept here (the shared cache keeps failures for 10 s).
 */
let lastPolicyErrorCode: string | null = null;
// deno-lint-ignore no-explicit-any
function policyErrorTap(client: any) {
  return {
    rpc: async (fn: string, args?: unknown) => {
      try {
        const res = await client.rpc(fn, args);
        const code = res?.error ? res.error.code : null;
        lastPolicyErrorCode = res?.error ? (typeof code === "string" && code ? code : "error") : null;
        return res;
      } catch (e) {
        lastPolicyErrorCode = "exception";
        throw e;
      }
    },
  };
}

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

  const [{ data: link }, policy] = await Promise.all([
    supabase
      .from("short_links")
      .select("code, target_path, target_params, og_title, og_description, og_image_url, destination_path, og_updated_at")
      .eq("code", code)
      .maybeSingle(),
    cachedPublicPolicy(policyErrorTap(supabase)),
  ]);
  const policyError = policy ? null : { code: lastPolicyErrorCode };

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
  const publicShareUrl = `${SHARE_HOST}/s/${code}`;
  // Humans land back in the SPA. House links open the public support page
  // (/support-house?s=<code>); plan links use ?share=<code>, which scrolls to
  // the matching card and opens its details sheet.
  const isHouseLink = link.destination_path === "/support-house" || link.target_path === "/support-house";
  const target = isHouseLink
    ? `${SITE_URL}/support-house?s=${encodeURIComponent(code)}`
    : `${SITE_URL}/?share=${encodeURIComponent(code)}`;
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

  // Stored preview metadata wins (it is written server-side on every share tap, with the Returns
  // sentence composed in SQL); live plan data is the fallback for older links and for deleted plans.
  // A description stored before the latest Returns policy change is replaced by a rate-free sentence.
  const title = link?.og_title || `Support a tenant in a ${houseTitle} in ${location}`;
  const description = previewDescription(link, plan, policy, policyError);
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
