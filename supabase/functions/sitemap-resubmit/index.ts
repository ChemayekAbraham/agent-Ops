// Automatic sitemap resubmission for welileapp.com.
//
// The sitemap itself is regenerated at build time (scripts/generate-sitemap.ts
// runs on prebuild and includes live house listings), so the served
// welileapp.com/sitemap.xml already reflects current pages after each publish.
//
// This function detects when that served sitemap has actually CHANGED and, only
// then, resubmits it to Google Search Console via the Lovable connector gateway.
// It fingerprints the fetched sitemap (SHA-256) and compares against the last
// recorded hash in `seo_sitemap_resubmit_log`. Idempotent: a poll where nothing
// changed does not re-ping Google (Google recrawls on its own schedule and
// hammering the API is an anti-pattern).
//
// Invoked on a schedule by pg_cron and on-demand from the CTO dashboard.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SITE_URL = "https://welileapp.com/";
const SITEMAP_URL = "https://welileapp.com/sitemap.xml";
const GATEWAY = "https://connector-gateway.lovable.dev/google_search_console";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function gscHeaders() {
  const lovableKey = Deno.env.get("LOVABLE_API_KEY");
  const gscKey = Deno.env.get("GOOGLE_SEARCH_CONSOLE_API_KEY");
  if (!lovableKey || !gscKey) throw new Error("Search Console connector creds missing");
  return {
    Authorization: `Bearer ${lovableKey}`,
    "X-Connection-Api-Key": gscKey,
    "Content-Type": "application/json",
  };
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function resubmitSitemap() {
  const enc = encodeURIComponent(SITE_URL);
  const encSm = encodeURIComponent(SITEMAP_URL);
  const res = await fetch(`${GATEWAY}/webmasters/v3/sites/${enc}/sitemaps/${encSm}`, {
    method: "PUT",
    headers: gscHeaders(),
  });
  const body = res.ok ? "" : await res.text();
  return { ok: res.ok, status: res.status, body };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

  try {
    let force = false;
    if (req.method === "POST") {
      const parsed = await req.json().catch(() => ({}));
      force = parsed?.force === true;
    }

    // 1. Fetch the currently served sitemap and fingerprint it.
    const smRes = await fetch(SITEMAP_URL, { headers: { "cache-control": "no-cache" } });
    if (!smRes.ok) {
      throw new Error(`Could not fetch ${SITEMAP_URL}: HTTP ${smRes.status}`);
    }
    const xml = await smRes.text();
    const hash = await sha256(xml);
    const urlCount = (xml.match(/<loc>/g) || []).length;

    // 2. Compare against the last recorded fingerprint.
    const { data: last } = await supabase
      .from("seo_sitemap_resubmit_log")
      .select("sitemap_hash")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const changed = !last || last.sitemap_hash !== hash;

    // 3. Resubmit to Google only when the sitemap changed (or force=true).
    let gscStatus: string | null = null;
    let resubmitted = false;
    let detail: Record<string, unknown> = { url_count: urlCount, changed, force };

    if (changed || force) {
      const result = await resubmitSitemap();
      resubmitted = result.ok;
      gscStatus = String(result.status);
      detail = { ...detail, gsc_ok: result.ok, gsc_body: result.body || undefined };
    }

    // 4. Record the outcome.
    await supabase.from("seo_sitemap_resubmit_log").insert({
      sitemap_hash: hash,
      url_count: urlCount,
      changed,
      resubmitted,
      gsc_status: gscStatus,
      detail,
    });

    return new Response(
      JSON.stringify({
        ok: true,
        changed,
        resubmitted,
        url_count: urlCount,
        gsc_status: gscStatus,
        message: resubmitted
          ? `Sitemap changed — resubmitted ${urlCount} URLs to Search Console.`
          : changed
            ? "Sitemap changed but resubmission failed — see gsc_status."
            : "Sitemap unchanged since last check — no resubmission needed.",
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
    );
  } catch (err) {
    console.error("sitemap-resubmit error:", err);
    return new Response(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 },
    );
  }
});