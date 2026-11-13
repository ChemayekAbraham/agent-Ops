import { createClient } from "npm:@supabase/supabase-js@2";
import { coSupportPreviewMeta } from "./meta.ts";

/**
 * Open Graph page for co-support invitation links: share.welileapp.com/c/<code>.
 *
 * WhatsApp and Facebook read only the HTML their crawler receives, and the app
 * is a single-page app, so the invitation needs this server page to show the
 * house photo and "Sarah wants to support a Rent Plan with you". People are
 * forwarded at once to the app page /co-support/<code>, which shows the
 * invitation dialog (or sends them to sign in / funder-onboarding first).
 *
 * The share host (infra/share-host/, /c/<code>) proxies this function so the
 * branded URL serves real HTML. Reads co_support_preview, the same public read
 * the app uses before sign-in: first names, city, photo, the invitee's half.
 * It never shows a rate or a Rent Profit Share figure (those are per person).
 */
const SITE_URL = "https://welileapp.com";
const SHARE_HOST = "https://share.welileapp.com";
const CODE = /^[A-Za-z0-9]{12}$/;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

function notFound() {
  return new Response("Invitation link not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const url = new URL(req.url);
  const tail = url.pathname.split("/").filter(Boolean).pop() ?? "";
  const raw = (url.searchParams.get("code") || (tail === "og-co-support" ? "" : tail)).trim();
  if (!CODE.test(raw)) return notFound();
  const code = raw.toUpperCase();

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data, error } = await supabase.rpc("co_support_preview", { p_code: code });
  if (error) {
    console.error("og-co-support preview failed", error.message);
    return new Response("Invitation preview temporarily unavailable. Please try again.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "30", ...corsHeaders },
    });
  }
  // deno-lint-ignore no-explicit-any
  const preview = data as any;
  if (!preview || preview.found !== true) return notFound();

  const meta = coSupportPreviewMeta(preview);
  const publicUrl = `${SHARE_HOST}/c/${code}`;
  const target = `${SITE_URL}/co-support/${code}`;
  const image = meta.image || `${SITE_URL}/house-listing-og.jpg`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${esc(meta.title)}</title>
  <meta name="description" content="${esc(meta.description)}" />
  <meta name="robots" content="noindex" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Welile" />
  <meta property="og:url" content="${esc(publicUrl)}" />
  <meta property="og:title" content="${esc(meta.title)}" />
  <meta property="og:description" content="${esc(meta.description)}" />
  <meta property="og:image" content="${esc(image)}" />
  <meta property="og:image:secure_url" content="${esc(image)}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="${esc(meta.imageAlt)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(meta.title)}" />
  <meta name="twitter:description" content="${esc(meta.description)}" />
  <meta name="twitter:image" content="${esc(image)}" />
  <meta http-equiv="refresh" content="0;url=${esc(target)}" />
  <link rel="canonical" href="${esc(publicUrl)}" />
</head>
<body>
  <p>Opening your invitation… <a href="${esc(target)}">${esc(meta.title)}</a></p>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // The status changes (accepted, expired), so keep this short.
      "Cache-Control": "public, max-age=60",
      ...corsHeaders,
    },
  });
});
