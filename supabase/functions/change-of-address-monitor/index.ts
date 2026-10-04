// Automated Search Console "Change of Address" readiness monitor.
//
// Google's Change of Address wizard has NO public API — the final submit is a
// manual click in Search Console. What CAN be automated is everything that
// gates it: detecting when the 301 redirect from the old domain to the new
// domain is actually live and healthy, then re-running the API-supported
// consolidation signals (sitemap re-submission + URL inspection) and flipping
// the monitor to "ready_to_submit" so an operator gets a clear go/no-go.
//
// Designed to be invoked on a schedule (pg_cron) and also manually from the
// executive dashboard. Idempotent: it only escalates status, never regresses a
// verified consolidation, and only fires the GSC actions once the redirect has
// been healthy across two consecutive checks (stability guard).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const OLD_DOMAIN = "welilereceipts.com";
const NEW_DOMAIN = "welileapp.com";
const NEW_SITE_URL = `https://${NEW_DOMAIN}/`;
const PATHS = ["/", "/opportunities", "/join"];

const GSC_GATEWAY = "https://connector-gateway.lovable.dev/google_search_console";
const SITE_ENC = encodeURIComponent(NEW_SITE_URL);
const SITEMAP_ENC = encodeURIComponent(`https://${NEW_DOMAIN}/sitemap.xml`);

function normPath(p: string): string {
  if (!p) return "/";
  // strip query/hash, collapse trailing slash (except root)
  const clean = p.split("?")[0].split("#")[0];
  return clean.length > 1 && clean.endsWith("/") ? clean.slice(0, -1) : clean;
}

interface HopResult {
  path: string;
  ok: boolean;
  firstStatus: number | null;
  isPermanent: boolean;
  finalUrl: string | null;
  finalStatus: number | null;
  location: string | null;
  error?: string;
}

// Manually follow the redirect chain from the OLD domain so we can inspect the
// FIRST-hop status code (must be a permanent 301/308) and confirm the chain
// lands on the matching path of the NEW domain with a 200.
async function traceRedirect(path: string): Promise<HopResult> {
  const start = `https://${OLD_DOMAIN}${path}`;
  const res: HopResult = {
    path,
    ok: false,
    firstStatus: null,
    isPermanent: false,
    finalUrl: null,
    finalStatus: null,
    location: null,
  };
  try {
    let current = start;
    let firstStatus: number | null = null;
    let firstLocation: string | null = null;
    for (let hop = 0; hop < 6; hop++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      let resp: Response;
      try {
        resp = await fetch(current, { method: "GET", redirect: "manual", signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (hop === 0) {
        firstStatus = resp.status;
        firstLocation = resp.headers.get("location");
      }
      // Redirect statuses
      if ([301, 302, 303, 307, 308].includes(resp.status)) {
        const loc = resp.headers.get("location");
        if (!loc) break;
        current = new URL(loc, current).toString();
        continue;
      }
      // Non-redirect: this is the final hop
      res.finalUrl = resp.url || current;
      res.finalStatus = resp.status;
      break;
    }
    res.firstStatus = firstStatus;
    res.location = firstLocation;
    res.isPermanent = firstStatus === 301 || firstStatus === 308;

    let finalHost: string | null = null;
    let finalPath: string | null = null;
    if (res.finalUrl) {
      const u = new URL(res.finalUrl);
      finalHost = u.hostname.replace(/^www\./, "");
      finalPath = normPath(u.pathname);
    }
    res.ok =
      res.isPermanent &&
      finalHost === NEW_DOMAIN &&
      res.finalStatus === 200 &&
      finalPath === normPath(path);
  } catch (e) {
    res.error = e instanceof Error ? e.message : String(e);
  }
  return res;
}

function gscHeaders() {
  const lovableKey = Deno.env.get("LOVABLE_API_KEY");
  const gscKey = Deno.env.get("GOOGLE_SEARCH_CONSOLE_API_KEY");
  if (!lovableKey || !gscKey) return null;
  return {
    Authorization: `Bearer ${lovableKey}`,
    "X-Connection-Api-Key": gscKey,
    "Content-Type": "application/json",
  };
}

// API-supported consolidation signals: re-submit the sitemap and inspect the
// new homepage to read Google's current canonical + coverage verdict.
async function runGscActions() {
  const headers = gscHeaders();
  if (!headers) return { attempted: false, reason: "connector credentials missing" };

  const out: Record<string, unknown> = { attempted: true };

  // 1. Re-submit sitemap (PUT, 204 on success)
  try {
    const sm = await fetch(`${GSC_GATEWAY}/webmasters/v3/sites/${SITE_ENC}/sitemaps/${SITEMAP_ENC}`, {
      method: "PUT",
      headers,
    });
    out.sitemap_resubmit_status = sm.status;
  } catch (e) {
    out.sitemap_resubmit_error = e instanceof Error ? e.message : String(e);
  }

  // 2. Inspect the new homepage to confirm canonical is consolidating our way
  try {
    const insp = await fetch(`${GSC_GATEWAY}/v1/urlInspection/index:inspect`, {
      method: "POST",
      headers,
      body: JSON.stringify({ inspectionUrl: NEW_SITE_URL, siteUrl: NEW_SITE_URL }),
    });
    const j = await insp.json().catch(() => null);
    const r = j?.inspectionResult?.indexStatusResult ?? {};
    out.inspection = {
      status: insp.status,
      verdict: r.verdict ?? null,
      coverageState: r.coverageState ?? null,
      googleCanonical: r.googleCanonical ?? null,
      lastCrawlTime: r.lastCrawlTime ?? null,
    };
  } catch (e) {
    out.inspection_error = e instanceof Error ? e.message : String(e);
  }

  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  try {
    // Load current monitor row
    const { data: row } = await admin
      .from("change_of_address_monitor")
      .select("*")
      .eq("old_domain", OLD_DOMAIN)
      .eq("new_domain", NEW_DOMAIN)
      .maybeSingle();

    // 1. Check the redirect chain for every tracked path
    const checks = await Promise.all(PATHS.map(traceRedirect));
    const healthy = checks.every((c) => c.ok);
    const now = new Date().toISOString();

    const prevConsecutive = row?.consecutive_healthy ?? 0;
    const consecutive = healthy ? prevConsecutive + 1 : 0;
    const prevStatus: string = row?.status ?? "awaiting_redirect";

    let status = prevStatus;
    let lastAction: string | null = row?.last_action ?? null;
    let lastActionAt: string | null = row?.last_action_at ?? null;
    let gscSnapshot = row?.gsc_snapshot ?? null;
    let readyAt: string | null = row?.ready_at ?? null;
    let verifiedAt: string | null = row?.verified_at ?? null;
    const redirectFirstSeen = row?.redirect_first_seen_at ?? (healthy ? now : null);

    if (!healthy) {
      // Never regress a completed consolidation; otherwise report awaiting.
      if (prevStatus !== "verified") status = "awaiting_redirect";
    } else {
      if (prevStatus === "awaiting_redirect") status = "redirect_live";

      // Stability guard: only reattempt the GSC consolidation once the redirect
      // has been healthy on two consecutive checks, and only if we haven't
      // already reached ready/verified.
      const alreadyDone = prevStatus === "ready_to_submit" || prevStatus === "verified";
      if (consecutive >= 2 && !alreadyDone) {
        const actions = await runGscActions();
        gscSnapshot = actions;
        lastAction = "reattempt: sitemap re-submitted + homepage inspected";
        lastActionAt = now;
        status = "ready_to_submit";
        readyAt = now;
      }

      // If a prior run already inspected, promote to verified when Google's
      // canonical has flipped to the new domain and coverage is no longer a
      // redirect artifact.
      const insp: any = (gscSnapshot as any)?.inspection;
      if (insp && typeof insp.googleCanonical === "string") {
        const canon = insp.googleCanonical.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
        const coverage: string = (insp.coverageState ?? "").toLowerCase();
        if (canon === NEW_DOMAIN && !coverage.includes("redirect")) {
          status = "verified";
          verifiedAt = verifiedAt ?? now;
        }
      }
    }

    const payload = {
      old_domain: OLD_DOMAIN,
      new_domain: NEW_DOMAIN,
      status,
      redirect_healthy: healthy,
      consecutive_healthy: consecutive,
      checks,
      gsc_snapshot: gscSnapshot,
      last_action: lastAction,
      last_action_at: lastActionAt,
      redirect_first_seen_at: redirectFirstSeen,
      ready_at: readyAt,
      verified_at: verifiedAt,
      last_checked_at: now,
      last_error: healthy ? null : checks.map((c) => c.error).filter(Boolean).join("; ") || null,
    };

    const { error: upErr } = await admin
      .from("change_of_address_monitor")
      .upsert(payload, { onConflict: "old_domain,new_domain" });
    if (upErr) throw upErr;

    const nextStep =
      status === "ready_to_submit"
        ? `Redirect is live. Open Search Console → welilereceipts.com property → Settings → Change of Address → select ${NEW_DOMAIN} → Validate & Submit.`
        : status === "verified"
          ? "Consolidation verified: Google's canonical now points to the new domain."
          : status === "redirect_live"
            ? "Redirect just went live; confirming stability before re-running consolidation."
            : "Redirect not live yet. Repoint welilereceipts.com DNS to Lovable and connect it as a domain.";

    return new Response(JSON.stringify({ ...payload, next_step: nextStep }, null, 2), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (e) {
    console.error("change-of-address-monitor failed:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 },
    );
  }
});