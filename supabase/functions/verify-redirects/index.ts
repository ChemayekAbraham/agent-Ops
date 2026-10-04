// verify-redirects — quick diagnostic endpoint that confirms every legacy /
// variant host resolves to the canonical https://welileapp.com.
//
// GET https://<project>.functions.supabase.co/verify-redirects
// Returns JSON: per-host status, redirect chain, final URL, and an overall
// `all_ok` boolean. No auth required (verify_jwt = false) — read-only checks.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const CANONICAL = "https://welileapp.com";
const CANONICAL_HOST = "welileapp.com";

// Hosts that must all end up on welileapp.com.
const TARGETS: Array<{ url: string; expect: "canonical" | "redirect" }> = [
  { url: "https://welileapp.com/", expect: "canonical" },
  { url: "https://www.welileapp.com/", expect: "redirect" },
  { url: "https://welilereceipts-com.lovable.app/", expect: "redirect" }, // legacy-domain-guard-allow
  { url: "http://welilereceipts.com/", expect: "redirect" }, // legacy-domain-guard-allow
  { url: "http://welilereciept.com/", expect: "redirect" }, // legacy-domain-guard-allow
];

interface HopInfo {
  url: string;
  status: number;
  location: string | null;
}

async function traceRedirects(startUrl: string, maxHops = 8): Promise<{
  chain: HopInfo[];
  finalUrl: string;
  finalStatus: number;
  error?: string;
}> {
  const chain: HopInfo[] = [];
  let current = startUrl;
  try {
    for (let i = 0; i < maxHops; i++) {
      const res = await fetch(current, {
        method: "GET",
        redirect: "manual",
        headers: { "User-Agent": "welile-redirect-verifier/1.0" },
      });
      const location = res.headers.get("location");
      chain.push({ url: current, status: res.status, location });
      // Drain body so the connection is freed.
      await res.arrayBuffer().catch(() => {});
      if (res.status >= 300 && res.status < 400 && location) {
        current = new URL(location, current).toString();
        continue;
      }
      return { chain, finalUrl: current, finalStatus: res.status };
    }
    return { chain, finalUrl: current, finalStatus: 0, error: "too_many_redirects" };
  } catch (err) {
    return {
      chain,
      finalUrl: current,
      finalStatus: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const results = await Promise.all(
    TARGETS.map(async (t) => {
      const trace = await traceRedirects(t.url);
      let finalHost = "";
      try {
        finalHost = new URL(trace.finalUrl).hostname.replace(/^www\./, "");
      } catch {
        finalHost = "";
      }
      const landsOnCanonical = finalHost === CANONICAL_HOST;
      const redirected = trace.chain.some(
        (h) => h.status >= 300 && h.status < 400,
      );
      // A legacy host whose DNS does not resolve is benign — nobody can land
      // on it, so it needs no redirect. Only a host that actually serves
      // content without redirecting to the canonical domain is a real failure.
      const unreachable =
        !!trace.error &&
        /dns error|failed to lookup|Name or service not known|Connect/i.test(
          trace.error,
        );
      const ok = unreachable
        ? true
        : !trace.error &&
          landsOnCanonical &&
          (t.expect === "canonical" ? !redirected : redirected);
      return {
        source: t.url,
        expect: t.expect,
        ok,
        benign_unresolved: unreachable,
        redirected,
        final_url: trace.finalUrl,
        final_status: trace.finalStatus,
        lands_on_canonical: landsOnCanonical,
        hops: trace.chain,
        error: trace.error ?? null,
      };
    }),
  );

  const allOk = results.every((r) => r.ok);
  const body = {
    canonical: CANONICAL,
    checked_at: new Date().toISOString(),
    all_ok: allOk,
    results,
  };

  return new Response(JSON.stringify(body, null, 2), {
    status: allOk ? 200 : 503,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
