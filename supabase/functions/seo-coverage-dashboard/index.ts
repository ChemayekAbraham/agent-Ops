// Live Search Console coverage comparison: welileapp.com (primary) vs
// welilereceipts.com (legacy). For each verified property it pulls the sitemap  legacy-domain-guard-allow
// summary and runs URL Inspection on a shared set of key paths, returning a
// structured side-by-side view: coverage state, last crawl, robots/indexing
// eligibility, and Google's chosen canonical (so we can tell which way Google
// is consolidating the two domains).
//
// Read-only and on-demand — invoked from the CTO dashboard. URL Inspection is
// rate-limited by Google, so we inspect a small fixed set of paths per domain.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const GATEWAY = "https://connector-gateway.lovable.dev/google_search_console";

const PRIMARY = "https://welileapp.com/";
const LEGACY = "https://welilereceipts.com/"; // legacy-domain-guard-allow

// Shared key paths inspected on both domains.
const KEY_PATHS = ["", "welcome", "find-a-house", "rent-money", "opportunities"];

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

async function listVerifiedSites(): Promise<string[]> {
  const res = await fetch(`${GATEWAY}/webmasters/v3/sites`, { headers: gscHeaders() });
  if (!res.ok) return [];
  const data = await res.json();
  return (data?.siteEntry ?? []).map((e: any) => e.siteUrl as string);
}

async function getSitemap(siteUrl: string) {
  const enc = encodeURIComponent(siteUrl);
  const encSm = encodeURIComponent(`${siteUrl}sitemap.xml`);
  const res = await fetch(`${GATEWAY}/webmasters/v3/sites/${enc}/sitemaps/${encSm}`, {
    headers: gscHeaders(),
  });
  if (!res.ok) return { ok: false, status: res.status };
  const data = await res.json();
  const c = data?.contents?.[0] ?? {};
  return {
    ok: true,
    submitted: Number(c.submitted ?? 0),
    indexed: Number(c.indexed ?? 0),
    errors: Number(data?.errors ?? 0),
    warnings: Number(data?.warnings ?? 0),
    last_downloaded: data?.lastDownloaded ?? null,
    is_pending: data?.isPending ?? false,
  };
}

async function inspect(siteUrl: string, path: string) {
  const inspectionUrl = `${siteUrl}${path}`;
  const res = await fetch(`${GATEWAY}/v1/urlInspection/index:inspect`, {
    method: "POST",
    headers: gscHeaders(),
    body: JSON.stringify({ inspectionUrl, siteUrl }),
  });
  if (!res.ok) {
    return { path: path || "/", url: inspectionUrl, error: `HTTP ${res.status}` };
  }
  const data = await res.json();
  const r = data?.inspectionResult?.indexStatusResult ?? {};
  const googleCanonical: string | null = r.googleCanonical ?? null;
  const canonicalOnPrimary = googleCanonical
    ? googleCanonical.includes("welileapp.com")
    : null;
  return {
    path: path || "/",
    url: inspectionUrl,
    verdict: r.verdict ?? null,
    coverage_state: r.coverageState ?? null,
    robots_state: r.robotsTxtState ?? null,
    indexing_state: r.indexingState ?? null,
    page_fetch_state: r.pageFetchState ?? null,
    google_canonical: googleCanonical,
    user_canonical: r.userCanonical ?? null,
    last_crawl_time: r.lastCrawlTime ?? null,
    canonical_on_primary: canonicalOnPrimary,
  };
}

async function analyzeProperty(siteUrl: string, verified: boolean) {
  if (!verified) {
    return { site_url: siteUrl, verified: false, sitemap: null, urls: [] };
  }
  const sitemap = await getSitemap(siteUrl);
  const urls = [];
  for (const p of KEY_PATHS) {
    urls.push(await inspect(siteUrl, p));
  }
  return { site_url: siteUrl, verified: true, sitemap, urls };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const verified = await listVerifiedSites();
    const primaryVerified = verified.some((s) => s.includes("welileapp.com"));
    const legacyVerified = verified.some((s) => s.includes("welilereceipts.com")); // legacy-domain-guard-allow

    const [primary, legacy] = await Promise.all([
      analyzeProperty(PRIMARY, primaryVerified),
      analyzeProperty(LEGACY, legacyVerified),
    ]);

    // Consolidation verdict from the primary homepage's Google-chosen canonical.
    const primaryHome = primary.urls.find((u: any) => u.path === "/");
    let consolidation: "correct" | "reversed" | "unknown" = "unknown";
    if (primaryHome && (primaryHome as any).google_canonical) {
      consolidation = (primaryHome as any).canonical_on_primary ? "correct" : "reversed";
    }

    return new Response(
      JSON.stringify({
        ok: true,
        checked_at: new Date().toISOString(),
        consolidation,
        properties: { primary, legacy },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
    );
  } catch (err) {
    console.error("seo-coverage-dashboard error:", err);
    return new Response(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 },
    );
  }
});