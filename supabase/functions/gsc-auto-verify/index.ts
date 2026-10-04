// gsc-auto-verify
//
// Watches the live production domain for the Google Search Console
// verification meta tag. As soon as the tag is detected on the live HTML
// (i.e. after the user publishes the updated site), this function:
//   1) calls the Site Verification API to verify the domain,
//   2) adds the site to Search Console,
//   3) submits the sitemap.
//
// It is idempotent and safe to run on a schedule: once the site is verified
// and the sitemap is submitted it simply reports "already done" on subsequent
// runs. Intended to be invoked by a pg_cron job every ~30 minutes so the whole
// flow completes automatically with no manual step after publishing.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const SITE_URL = "https://welileapp.com/";
const SITEMAP_URL = "https://welileapp.com/sitemap.xml";
const VERIFICATION_TOKEN =
  "google-site-verification=kR0joJPuylC4guaD6Mpj3Bk_mBchayHvHlSEBlcGUpY";
const GATEWAY = "https://connector-gateway.lovable.dev/google_search_console";

const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY") ?? "";
const GSC_KEY = Deno.env.get("GOOGLE_SEARCH_CONSOLE_API_KEY") ?? "";

function gscHeaders(extra: Record<string, string> = {}) {
  return {
    Authorization: `Bearer ${LOVABLE_API_KEY}`,
    "X-Connection-Api-Key": GSC_KEY,
    ...extra,
  };
}

async function isTagLive(): Promise<boolean> {
  try {
    const res = await fetch(SITE_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; WelileGSCBot/1.0)" },
      cache: "no-store",
    });
    if (!res.ok) return false;
    const html = await res.text();
    return html.includes(VERIFICATION_TOKEN);
  } catch (_e) {
    return false;
  }
}

async function isVerified(): Promise<boolean> {
  const encoded = encodeURIComponent(SITE_URL);
  const res = await fetch(`${GATEWAY}/webmasters/v3/sites/${encoded}`, {
    headers: gscHeaders(),
  });
  return res.ok;
}

async function verifySite(): Promise<{ ok: boolean; status: number; body: string }> {
  const res = await fetch(
    `${GATEWAY}/siteVerification/v1/webResource?verificationMethod=META`,
    {
      method: "POST",
      headers: gscHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ site: { identifier: SITE_URL, type: "SITE" } }),
    },
  );
  return { ok: res.ok, status: res.status, body: await res.text() };
}

async function addSite(): Promise<{ ok: boolean; status: number }> {
  const encoded = encodeURIComponent(SITE_URL);
  const res = await fetch(`${GATEWAY}/webmasters/v3/sites/${encoded}`, {
    method: "PUT",
    headers: gscHeaders(),
  });
  return { ok: res.ok, status: res.status };
}

async function submitSitemap(): Promise<{ ok: boolean; status: number; body: string }> {
  const encodedSite = encodeURIComponent(SITE_URL);
  const encodedMap = encodeURIComponent(SITEMAP_URL);
  const res = await fetch(
    `${GATEWAY}/webmasters/v3/sites/${encodedSite}/sitemaps/${encodedMap}`,
    { method: "PUT", headers: gscHeaders() },
  );
  return { ok: res.ok, status: res.status, body: await res.text() };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const steps: Record<string, unknown> = {};

  try {
    if (!LOVABLE_API_KEY || !GSC_KEY) {
      return new Response(
        JSON.stringify({ error: "missing_credentials" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 1) Is the tag live on the published domain yet?
    const tagLive = await isTagLive();
    steps.tagLive = tagLive;
    if (!tagLive) {
      return new Response(
        JSON.stringify({
          done: false,
          reason: "verification_tag_not_live_yet",
          message: "Publish the updated site so the meta tag appears on the live domain. This job will retry automatically.",
          steps,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
      );
    }

    // 2) Verify (skip if already verified).
    let verified = await isVerified();
    steps.alreadyVerified = verified;
    if (!verified) {
      const v = await verifySite();
      steps.verify = { status: v.status, body: v.body.slice(0, 500) };
      if (v.ok) {
        const add = await addSite();
        steps.addSite = { status: add.status };
        verified = true;
      }
    }

    if (!verified) {
      return new Response(
        JSON.stringify({ done: false, reason: "verification_failed", steps }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
      );
    }

    // 3) Submit the sitemap.
    const sm = await submitSitemap();
    steps.submitSitemap = { status: sm.status, body: sm.body.slice(0, 500) };

    return new Response(
      JSON.stringify({ done: sm.ok, verified: true, sitemapSubmitted: sm.ok, steps }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: String(e), steps }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});