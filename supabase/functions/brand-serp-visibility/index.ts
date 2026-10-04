// Branded SERP visibility aggregator for the executive dashboard.
//
// Combines three read-only signals for welileapp.com:
//   1. Google Search Console — branded impressions/clicks/CTR/position (last 28d)
//   2. Semrush — latest stored rank / organic keyword snapshot
//   3. Profile presence — live verification status across search surfaces
//
// Read-only. Requires an authenticated caller.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const GSC_GATEWAY = "https://connector-gateway.lovable.dev/google_search_console";
const SITE_URL = "https://welileapp.com/";
const SITE_ENC = encodeURIComponent(SITE_URL);
const BRAND_TERM = "welile";

function gscHeaders() {
  const lovableKey = Deno.env.get("LOVABLE_API_KEY");
  const gscKey = Deno.env.get("GOOGLE_SEARCH_CONSOLE_API_KEY");
  if (!lovableKey || !gscKey) throw new Error("Search Console connector credentials missing");
  return {
    Authorization: `Bearer ${lovableKey}`,
    "X-Connection-Api-Key": gscKey,
    "Content-Type": "application/json",
  };
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function gscQuery(body: unknown) {
  const res = await fetch(`${GSC_GATEWAY}/webmasters/v3/sites/${SITE_ENC}/searchAnalytics/query`, {
    method: "POST",
    headers: gscHeaders(),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: res.ok, status: res.status, json };
}

async function fetchSearchConsole() {
  const end = new Date();
  // GSC data lags ~2-3 days; end the window a couple days back for stable numbers.
  end.setUTCDate(end.getUTCDate() - 2);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 28);
  const period = { start: ymd(start), end: ymd(end) };

  const brandedFilter = {
    dimensionFilterGroups: [
      { filters: [{ dimension: "query", expression: BRAND_TERM, operator: "contains" }] },
    ],
  };

  // Branded top queries (also used to derive branded totals).
  const branded = await gscQuery({
    startDate: period.start,
    endDate: period.end,
    dimensions: ["query"],
    rowLimit: 25,
    ...brandedFilter,
  });

  if (!branded.ok) {
    return { available: false, error: branded.json?.error?.message ?? `HTTP ${branded.status}`, period };
  }

  const rows: any[] = branded.json?.rows ?? [];
  const topQueries = rows.map((r) => ({
    query: r.keys?.[0] ?? "",
    clicks: Number(r.clicks ?? 0),
    impressions: Number(r.impressions ?? 0),
    ctr: Number(r.ctr ?? 0),
    position: Number(r.position ?? 0),
  }));

  const totalClicks = topQueries.reduce((s, q) => s + q.clicks, 0);
  const totalImpr = topQueries.reduce((s, q) => s + q.impressions, 0);
  // Weighted avg position across branded impressions.
  const wPos = totalImpr > 0
    ? topQueries.reduce((s, q) => s + q.position * q.impressions, 0) / totalImpr
    : 0;

  return {
    available: true,
    period,
    branded: {
      clicks: totalClicks,
      impressions: totalImpr,
      ctr: totalImpr > 0 ? totalClicks / totalImpr : 0,
      avg_position: wPos,
      query_count: topQueries.length,
    },
    top_queries: topQueries,
  };
}

async function fetchGscVerified(): Promise<boolean> {
  try {
    const res = await fetch(`${GSC_GATEWAY}/webmasters/v3/sites`, { headers: gscHeaders() });
    if (!res.ok) return false;
    const json = await res.json();
    const entries: any[] = json?.siteEntry ?? [];
    return entries.some((e) => (e.siteUrl ?? "").replace(/\/$/, "") === SITE_URL.replace(/\/$/, ""));
  } catch {
    return false;
  }
}

// Live-fetch the published site and detect verification/presence meta tags.
async function fetchSiteMeta() {
  try {
    const res = await fetch("https://welileapp.com/", {
      headers: { "User-Agent": "WelileBrandMonitor/1.0" },
    });
    if (!res.ok) return { bing: false, yandex: false, google_meta: false };
    const html = await res.text();
    return {
      bing: /name=["']msvalidate\.01["']/i.test(html),
      yandex: /name=["']yandex-verification["']/i.test(html),
      google_meta: /name=["']google-site-verification["']/i.test(html),
    };
  } catch {
    return { bing: false, yandex: false, google_meta: false };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  // Require an authenticated caller (internal executive panel).
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const { data: userData, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !userData?.user) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const [searchConsole, gscVerified, siteMeta, snapRes] = await Promise.all([
      fetchSearchConsole().catch((e) => ({ available: false, error: String(e?.message ?? e) })),
      fetchGscVerified(),
      fetchSiteMeta(),
      admin
        .from("semrush_brand_snapshots")
        .select("captured_at, domain_summary, backlinks_summary")
        .order("captured_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    const snap: any = snapRes?.data ?? null;
    const domSummary: any = snap?.domain_summary ?? null;
    const semrush = {
      captured_at: snap?.captured_at ?? null,
      indexed: !!domSummary?.indexed,
      rank: domSummary?.rank ?? null,
      organic_keywords: domSummary?.organic_keywords ?? null,
      organic_traffic: domSummary?.organic_traffic ?? null,
      authority_score: snap?.backlinks_summary?.authority_score ?? null,
      note: domSummary?.note ?? domSummary?.error ?? null,
    };

    const linkedinConnected = !!Deno.env.get("LINKEDIN_API_KEY");

    const profiles = [
      {
        key: "google_search_console",
        name: "Google Search Console",
        status: gscVerified ? "verified" : "pending",
        detail: gscVerified ? "Property verified & reporting" : "Not verified for this property",
      },
      {
        key: "google_index",
        name: "Google Organic Index",
        status: semrush.indexed ? "indexed" : "indexing",
        detail: semrush.indexed
          ? `Ranked (Semrush rank ${semrush.rank ?? "—"})`
          : "Not yet in Semrush index (new domain)",
      },
      {
        key: "bing",
        name: "Bing Webmaster",
        status: siteMeta.bing ? "verified" : "pending",
        detail: siteMeta.bing ? "Verification tag live" : "Verification tag not yet published",
      },
      {
        key: "yandex",
        name: "Yandex Webmaster",
        status: siteMeta.yandex ? "verified" : "pending",
        detail: siteMeta.yandex ? "Verification tag live" : "Verification tag not yet published",
      },
      {
        key: "linkedin",
        name: "LinkedIn Company Page",
        status: linkedinConnected ? "connected" : "not_connected",
        detail: linkedinConnected ? "Connector linked" : "Not connected",
      },
    ];

    return new Response(
      JSON.stringify({
        ok: true,
        checked_at: new Date().toISOString(),
        domain: "welileapp.com",
        search_console: searchConsole,
        semrush,
        profiles,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
    );
  } catch (err) {
    console.error("brand-serp-visibility error:", err);
    return new Response(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 },
    );
  }
});
