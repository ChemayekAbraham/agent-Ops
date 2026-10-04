// Runtime redirect audit: confirms the legacy domain (welilereceipts.com) and  legacy-domain-guard-allow
// the www / staging variants always 301 to the matching welileapp.com URL.
//
// For each check it issues a manual-redirect request (to read the 3xx +
// Location header) and a follow request (to read the final resolved URL), then
// classifies each as pass / redirect-wrong-target / no-redirect / unreachable.
// Read-only and on-demand — surfaced in the CTO dashboard redirect panel.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const TARGET = "welileapp.com";

// Origins that must redirect to https://welileapp.com<path>.
const SOURCES = [
  { origin: "https://welilereceipts.com", label: "Legacy apex" }, // legacy-domain-guard-allow
  { origin: "https://www.welilereceipts.com", label: "Legacy www" }, // legacy-domain-guard-allow
  { origin: "https://www.welileapp.com", label: "welileapp www" },
];

const PATHS = ["/", "/welcome", "/find-a-house", "/rent-money"];

function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

async function checkOne(origin: string, path: string) {
  const url = `${origin}${path}`;
  const expected = `https://${TARGET}${path}`;
  const result: Record<string, unknown> = { url, path, expected };

  // 1. Manual redirect to capture status + Location.
  try {
    const res = await fetch(url, { redirect: "manual", headers: { "user-agent": "WelileSEOAudit/1.0" } });
    result.status = res.status;
    const location = res.headers.get("location");
    result.location = location ?? null;
    result.is_redirect = res.status >= 300 && res.status < 400;
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    result.verdict = "unreachable";
    return result;
  }

  // 2. Follow redirects to capture the final resolved URL + host.
  try {
    const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "WelileSEOAudit/1.0" } });
    result.final_url = res.url;
    result.final_host = hostOf(res.url);
    result.final_status = res.status;
  } catch (e) {
    result.final_error = e instanceof Error ? e.message : String(e);
  }

  // Classify.
  const finalHost = result.final_host as string | undefined;
  const finalUrl = (result.final_url as string | undefined) ?? "";
  if (finalHost === TARGET) {
    result.verdict = finalUrl.replace(/\/$/, "") === expected.replace(/\/$/, "") ? "pass" : "redirect_wrong_path";
  } else if (result.is_redirect) {
    result.verdict = "redirect_wrong_target";
  } else if (result.final_error) {
    result.verdict = "unreachable";
  } else {
    result.verdict = "no_redirect";
  }
  return result;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const checks: any[] = [];
    for (const s of SOURCES) {
      for (const p of PATHS) {
        const r = await checkOne(s.origin, p);
        checks.push({ ...r, source_label: s.label });
      }
    }

    const total = checks.length;
    const passing = checks.filter((c) => c.verdict === "pass").length;
    const failing = total - passing;
    // Legacy domain is the critical one for SEO consolidation.
    const legacyChecks = checks.filter((c) => (c.url as string).includes("welilereceipts.com")); // legacy-domain-guard-allow
    const legacyOk = legacyChecks.length > 0 && legacyChecks.every((c) => c.verdict === "pass");

    return new Response(
      JSON.stringify({
        ok: true,
        checked_at: new Date().toISOString(),
        summary: { total, passing, failing, legacy_ok: legacyOk },
        checks,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
    );
  } catch (err) {
    console.error("seo-redirect-audit error:", err);
    return new Response(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 },
    );
  }
});