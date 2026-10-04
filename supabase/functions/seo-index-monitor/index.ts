// SEO indexing monitor for welileapp.com.
//
// Reads Google Search Console through the Lovable connector gateway, records a
// snapshot in `seo_index_monitor_snapshots`, and — on a real state change —
// emails an alert via the Gmail connector.
//
// Indexing truth comes from TWO live sources only:
//   (a) Search Analytics API — distinct pages receiving impressions over 28d.
//   (b) URL Inspection — rotating sample of real sitemap URLs (10 per run).
//
// The Sitemaps endpoint is used ONLY for submitted count, errors, warnings and
// lastDownloaded. `contents[].indexed` is DEPRECATED by Google (always 0) and
// is never a source of truth here.
//
// Structural rule (do not regress): an ABSENT field stays null. Never
// `Number(x ?? 0)` on an API field. Alerts fire only on values that were
// actually present; a missing dependency raises "monitor degraded" instead.

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

const SERVING_WINDOW_DAYS = 28;
const SAMPLE_SIZE = 10; // URL Inspection quota is ~2000/day, 600/min.

// ---------------------------------------------------------------------------
// Null-safe coercion. "Absent" and "measured zero" are different facts.
// ---------------------------------------------------------------------------
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function strOrNull(v: unknown): string | null {
  return v === null || v === undefined || v === "" ? null : String(v);
}
// Google returns *_UNSPECIFIED when it has NOT measured a state (e.g. URL unknown
// to Google). That is "absent", not "bad" — it must never reach alert logic.
function stateOrNull(v: unknown): string | null {
  const s = strOrNull(v);
  if (s === null) return null;
  return /_UNSPECIFIED$/.test(s) || s === "UNSPECIFIED" ? null : s;
}

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

type Res = { ok: true; data: any } | { ok: false; status: number; body: string };

async function gscGet(path: string): Promise<Res> {
  const res = await fetch(`${GATEWAY}${path}`, { headers: gscHeaders() });
  if (!res.ok) return { ok: false, status: res.status, body: await res.text() };
  return { ok: true, data: await res.json() };
}
async function gscPost(path: string, body: unknown): Promise<Res> {
  const res = await fetch(`${GATEWAY}${path}`, {
    method: "POST",
    headers: gscHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) return { ok: false, status: res.status, body: await res.text() };
  return { ok: true, data: await res.json() };
}

async function getSitemapStatus(): Promise<Res> {
  return gscGet(
    `/webmasters/v3/sites/${encodeURIComponent(SITE_URL)}/sitemaps/${encodeURIComponent(SITEMAP_URL)}`,
  );
}

function ymd(d: Date) {
  return d.toISOString().slice(0, 10);
}

// (a) Search Analytics — impressions prove a page is indexed AND serving.
async function getServingPages(): Promise<Res> {
  const end = new Date(Date.now() - 2 * 86400000); // GSC data lags ~2 days.
  const start = new Date(end.getTime() - SERVING_WINDOW_DAYS * 86400000);
  return gscPost(
    `/webmasters/v3/sites/${encodeURIComponent(SITE_URL)}/searchAnalytics/query`,
    {
      startDate: ymd(start),
      endDate: ymd(end),
      dimensions: ["page"],
      rowLimit: 25000,
      dataState: "all",
    },
  );
}

async function inspectUrl(url: string): Promise<Res> {
  return gscPost(`/v1/urlInspection/index:inspect`, { inspectionUrl: url, siteUrl: SITE_URL });
}

// (b) Rotating sample of real sitemap URLs.
async function fetchSitemapUrls(): Promise<string[]> {
  try {
    const res = await fetch(SITEMAP_URL, { headers: { "User-Agent": "welile-seo-monitor" } });
    if (!res.ok) return [];
    const xml = await res.text();
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
    return [...new Set(locs)];
  } catch {
    return [];
  }
}

const INDEXED_COVERAGE = /submitted and indexed|indexed, not submitted|indexed/i;
function sampleIsIndexed(verdict: string | null, coverage: string | null): boolean {
  if (verdict !== "PASS") return false;
  if (!coverage) return false;
  if (/not indexed|excluded|crawled - currently not indexed|discovered/i.test(coverage)) return false;
  return INDEXED_COVERAGE.test(coverage);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function sendEmail(to: string, subject: string, html: string) {
  const lovableKey = Deno.env.get("LOVABLE_API_KEY");
  const gmailKey = Deno.env.get("GOOGLE_MAIL_API_KEY");
  if (!lovableKey || !gmailKey) return { ok: false, status: 0, raw: "Gmail connector creds missing" };
  const encodedSubject = /[^\x00-\x7F]/.test(subject)
    ? `=?UTF-8?B?${bytesToBase64(new TextEncoder().encode(subject))}?=`
    : subject;
  const raw = [
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    html,
  ].join("\r\n");
  const encoded = bytesToBase64(new TextEncoder().encode(raw))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const res = await fetch(
    "https://connector-gateway.lovable.dev/google_mail/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${lovableKey}`,
        "X-Connection-Api-Key": gmailKey,
      },
      body: JSON.stringify({ raw: encoded }),
    },
  );
  return { ok: res.ok, status: res.status, raw: await res.text() };
}

type AlertKind = "first_indexation" | "errors" | "monitor_degraded";

function buildEmailHtml(kind: AlertKind, snap: Record<string, any>): string {
  const good = kind === "first_indexation";
  const degraded = kind === "monitor_degraded";
  const accent = good ? "#16a34a" : degraded ? "#d97706" : "#dc2626";
  const title = good
    ? "welileapp.com is now appearing in Google"
    : degraded
      ? "SEO monitor degraded — Search Console data incomplete"
      : "Indexing issue detected on welileapp.com";
  const lead = good
    ? "Search Console now reports pages indexed and serving for welileapp.com, with no indexing errors."
    : degraded
      ? `The monitor could not read fields it depends on, so indexing status is UNKNOWN for this run (not bad — unknown). Missing: ${(snap.data_quality?.absent ?? []).join(", ") || "unspecified"}.`
      : "Search Console reported a new indexing or sitemap error for welileapp.com.";
  const row = (k: string, v: unknown) =>
    `<tr><td style="padding:6px 12px;color:#64748b;font-size:13px">${k}</td><td style="padding:6px 12px;font-size:13px;font-weight:600">${v === null || v === undefined ? "unknown" : v}</td></tr>`;
  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;background:#f5f3fa;margin:0;padding:24px;color:#1e1b2e">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2deec;border-radius:14px;overflow:hidden">
    <div style="background:${accent};color:#fff;padding:20px 24px">
      <div style="font-size:12px;letter-spacing:.4px;opacity:.9;text-transform:uppercase">Welile · SEO Monitor</div>
      <h1 style="margin:6px 0 0;font-size:20px">${title}</h1>
    </div>
    <div style="padding:22px 24px">
      <p style="margin:0 0 16px;font-size:14px;line-height:1.5">${lead}</p>
      <table style="width:100%;border-collapse:collapse;background:#faf9fc;border:1px solid #eee;border-radius:8px">
        ${row("Site", snap.site_url)}
        ${row("Sitemap URLs submitted", snap.sitemap_submitted_count)}
        ${row("Sitemap errors (Google)", snap.sitemap_errors)}
        ${row("Sitemap warnings", snap.sitemap_warnings)}
        ${row("Sitemap last downloaded", snap.sitemap_last_downloaded)}
        ${row(`Pages serving in search (${SERVING_WINDOW_DAYS}d)`, snap.serving_pages_count)}
        ${row("Sampled URLs indexed", snap.sampled_total_count == null ? null : `${snap.sampled_indexed_count} of ${snap.sampled_total_count}`)}
        ${row("Homepage verdict", snap.url_verdict)}
        ${row("Homepage coverage state", snap.coverage_state)}
        ${row("Indexing state", snap.indexing_state)}
        ${row("Robots.txt state", snap.robots_state)}
        ${row("Google-chosen canonical", snap.google_canonical)}
      </table>
      <p style="margin:16px 0 0;font-size:12px;color:#94a3b8">Checked at ${new Date().toISOString()}. Indexing status is derived from Search Analytics + URL Inspection only — never from the deprecated sitemap <code>indexed</code> field.</p>
    </div>
  </div></body></html>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);
  const debug: Record<string, unknown> = {};

  try {
    let force = false;
    try {
      const body = await req.json();
      force = body?.force === true;
    } catch { /* no body */ }

    const { data: settings } = await supabase
      .from("seo_index_monitor_settings")
      .select("alert_email, alerts_enabled, sample_cursor")
      .eq("id", true)
      .maybeSingle();
    const alertEmail = settings?.alert_email || "benjamin@welile.com";
    const alertsEnabled = settings?.alerts_enabled ?? true;
    const cursor = Number(settings?.sample_cursor ?? 0) || 0;

    // ---- Pull GSC data (sitemap status, serving pages, homepage inspection).
    const [sitemap, analytics, homeInspection, sitemapUrls] = await Promise.all([
      getSitemapStatus(),
      getServingPages(),
      inspectUrl(SITE_URL),
      fetchSitemapUrls(),
    ]);
    debug.sitemap_ok = sitemap.ok;
    debug.analytics_ok = analytics.ok;
    debug.inspection_ok = homeInspection.ok;
    debug.sitemap_url_count = sitemapUrls.length;

    // ---- LAYER 1: sitemap endpoint = submitted / errors / warnings / lastDownloaded ONLY.
    const smData = sitemap.ok ? sitemap.data ?? {} : null;
    const smContents = (smData?.contents?.[0] ?? null) as Record<string, unknown> | null;
    const sitemap_submitted_count = smContents ? numOrNull(smContents.submitted) : null;
    const sitemap_errors = smData ? numOrNull(smData.errors) : null;
    const sitemap_warnings = smData ? numOrNull(smData.warnings) : null;
    const sitemap_last_downloaded = smData ? strOrNull(smData.lastDownloaded) : null;
    // Deprecated by Google (always 0). Recorded null-safe, NEVER used for logic.
    const sitemap_indexed_count = smContents && smContents.indexed != null
      ? Number(smContents.indexed)
      : null;

    // ---- LAYER 2a: distinct pages serving in search = real indexing proof.
    const analyticsRows = analytics.ok ? (analytics.data?.rows ?? null) : null;
    const serving_pages_count = Array.isArray(analyticsRows)
      ? new Set(analyticsRows.map((r: any) => String(r?.keys?.[0] ?? "")).filter(Boolean)).size
      : null;

    // ---- LAYER 2b: rotating URL Inspection sample of real sitemap URLs.
    const pool = sitemapUrls.length ? sitemapUrls : [];
    const sample: string[] = [];
    if (pool.length) {
      for (let i = 0; i < Math.min(SAMPLE_SIZE, pool.length); i++) {
        sample.push(pool[(cursor + i) % pool.length]);
      }
    }
    const sampleResults: Array<{
      url: string;
      verdict: string | null;
      coverage_state: string | null;
      indexing_state: string | null;
      robots_state: string | null;
      google_canonical: string | null;
      indexed: boolean | null;
      error?: string;
    }> = [];
    for (const url of sample) {
      const r = await inspectUrl(url);
      if (!r.ok) {
        sampleResults.push({
          url, verdict: null, coverage_state: null, indexing_state: null,
          robots_state: null, google_canonical: null, indexed: null,
          error: `HTTP ${r.status}: ${r.body.slice(0, 200)}`,
        });
        continue;
      }
      const s = r.data?.inspectionResult?.indexStatusResult ?? {};
      const verdict = strOrNull(s.verdict);
      const coverage = strOrNull(s.coverageState);
      sampleResults.push({
        url,
        verdict,
        coverage_state: coverage,
        indexing_state: stateOrNull(s.indexingState),
        robots_state: stateOrNull(s.robotsTxtState),
        google_canonical: strOrNull(s.googleCanonical),
        indexed: verdict == null && coverage == null ? null : sampleIsIndexed(verdict, coverage),
      });
    }
    const measuredSamples = sampleResults.filter((s) => s.indexed !== null);
    const sampled_total_count = measuredSamples.length ? measuredSamples.length : null;
    const sampled_indexed_count = measuredSamples.length
      ? measuredSamples.filter((s) => s.indexed === true).length
      : null;

    if (pool.length) {
      await supabase
        .from("seo_index_monitor_settings")
        .update({ sample_cursor: (cursor + sample.length) % pool.length })
        .eq("id", true);
    }

    // ---- Homepage inspection.
    const idx = homeInspection.ok
      ? (homeInspection.data?.inspectionResult?.indexStatusResult ?? {})
      : {};
    const url_verdict = strOrNull(idx.verdict);
    const coverage_state = strOrNull(idx.coverageState);
    const indexing_state = stateOrNull(idx.indexingState);
    const robots_state = stateOrNull(idx.robotsTxtState);
    const google_canonical = strOrNull(idx.googleCanonical);

    // ---- LAYER 3: data quality — which expected fields were present vs absent.
    const expected: Record<string, unknown> = {
      "sitemap.submitted": sitemap_submitted_count,
      "sitemap.errors": sitemap_errors,
      "sitemap.warnings": sitemap_warnings,
      "sitemap.lastDownloaded": sitemap_last_downloaded,
      "searchAnalytics.pages": serving_pages_count,
      "urlInspection.home.verdict": url_verdict,
      "urlInspection.home.coverageState": coverage_state,
      "urlInspection.sample": sampled_total_count,
    };
    const present = Object.keys(expected).filter((k) => expected[k] !== null);
    const absent = Object.keys(expected).filter((k) => expected[k] === null);
    // Fields the indexing verdict itself depends on.
    const criticalAbsent = absent.filter((k) =>
      k === "searchAnalytics.pages" || k === "urlInspection.home.verdict" || k === "urlInspection.sample"
    );
    const data_quality = {
      present,
      absent,
      critical_absent: criticalAbsent,
      deprecated_ignored: ["sitemap.contents[].indexed"],
      transport: {
        sitemap_ok: sitemap.ok,
        search_analytics_ok: analytics.ok,
        home_inspection_ok: homeInspection.ok,
        sitemap_fetch_urls: sitemapUrls.length,
      },
      window_days: SERVING_WINDOW_DAYS,
    };
    // Degraded when BOTH indexing signals are unavailable — status is unknown, not bad.
    const monitor_degraded =
      serving_pages_count === null && sampled_total_count === null;

    // ---- Indexing verdict: from (a) and (b) ONLY. Null-safe tri-state.
    const pages_indexed_signal: boolean | null = monitor_degraded
      ? null
      : (serving_pages_count ?? 0) > 0 || (sampled_indexed_count ?? 0) > 0;
    const pages_indexed = pages_indexed_signal === true;

    // ---- Errors: only from values actually present. Nulls never alarm.
    const errorReasons: string[] = [];
    if (sitemap_errors !== null && sitemap_errors > 0) {
      errorReasons.push(`Google reports ${sitemap_errors} sitemap error(s)`);
    }
    if (robots_state !== null && robots_state !== "ALLOWED") {
      errorReasons.push(`robots.txt state is ${robots_state}`);
    }
    if (indexing_state !== null && indexing_state !== "INDEXING_ALLOWED" && indexing_state !== "PASS") {
      errorReasons.push(`homepage indexing state is ${indexing_state}`);
    }
    const blockedSamples = sampleResults.filter(
      (s) => s.robots_state !== null && s.robots_state !== "ALLOWED",
    );
    if (blockedSamples.length) {
      errorReasons.push(`${blockedSamples.length} sampled URL(s) blocked by robots.txt`);
    }
    const has_errors = errorReasons.length > 0;

    // ---- Transition detection.
    const { data: prev } = await supabase
      .from("seo_index_monitor_snapshots")
      .select("pages_indexed, has_errors, monitor_degraded")
      .order("checked_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const prevIndexed = prev?.pages_indexed ?? false;
    const prevErrors = prev?.has_errors ?? false;
    const prevDegraded = prev?.monitor_degraded ?? false;

    let alert_type: AlertKind | null = null;
    if (!prevErrors && has_errors) alert_type = "errors";
    else if (!prevIndexed && pages_indexed_signal === true && !has_errors) alert_type = "first_indexation";
    else if (!prevDegraded && monitor_degraded) alert_type = "monitor_degraded";

    const snap = {
      site_url: SITE_URL,
      sitemap_submitted_count,
      sitemap_indexed_count, // deprecated field, stored for history only
      sitemap_errors,
      sitemap_warnings,
      sitemap_last_downloaded,
      serving_pages_count,
      serving_window_days: SERVING_WINDOW_DAYS,
      sampled_indexed_count,
      sampled_total_count,
      url_samples: sampleResults,
      url_verdict,
      coverage_state,
      indexing_state,
      robots_state,
      google_canonical,
      pages_indexed,
      has_errors,
      monitor_degraded,
      data_quality,
      alert_type,
      alert_sent: false,
      raw: {
        sitemap: sitemap.ok ? sitemap.data : { error: sitemap.status, body: sitemap.body },
        search_analytics: analytics.ok
          ? { rowCount: Array.isArray(analyticsRows) ? analyticsRows.length : null }
          : { error: analytics.status, body: analytics.body },
        inspection: homeInspection.ok
          ? homeInspection.data
          : { error: homeInspection.status, body: homeInspection.body },
        error_reasons: errorReasons,
      },
    };

    let alertSent = false;
    let emailResult: unknown = null;
    if (alert_type && alertsEnabled) {
      const subject = alert_type === "first_indexation"
        ? "welileapp.com is now indexed in Google (no errors)"
        : alert_type === "errors"
          ? `Indexing issue on welileapp.com: ${errorReasons[0]}`
          : "SEO monitor degraded — Search Console fields missing";
      const r = await sendEmail(alertEmail, subject, buildEmailHtml(alert_type, snap));
      alertSent = r.ok;
      emailResult = { ok: r.ok, status: r.status };
    }

    const { data: inserted, error: insErr } = await supabase
      .from("seo_index_monitor_snapshots")
      .insert({ ...snap, alert_sent: alertSent })
      .select()
      .single();
    if (insErr) throw new Error(`insert failed: ${insErr.message}`);

    return new Response(
      JSON.stringify({
        ok: true,
        snapshot: inserted,
        alert_type,
        alert_sent: alertSent,
        email: emailResult,
        error_reasons: errorReasons,
        forced: force,
        debug,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("seo-index-monitor error:", e);
    return new Response(
      JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e), debug }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
