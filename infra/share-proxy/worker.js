/**
 * Welile share proxy (Cloudflare Worker).
 *
 * Public, branded share URLs:
 *   https://welileapp.com/s/<code>   (rent plans)
 *   https://welileapp.com/m/<code>   (merchandise, legacy)
 *
 * The Worker PROXIES the internal Supabase edge functions server-to-server and
 * returns their HTML under the welileapp.com URL. It never redirects the public
 * request to supabase.co, so the internal endpoint stays invisible to users and
 * to social crawlers, while WhatsApp still reads the per-plan Open Graph head.
 *
 * Deploy:
 *   npx wrangler deploy            (config: wrangler.toml at the repo root)
 * Routes required in Cloudflare (zone welileapp.com):
 *   welileapp.com/s/*      www.welileapp.com/s/*
 *   welileapp.com/m/*      www.welileapp.com/m/*   (legacy merchandise links)
 */
const MERCH_UPSTREAM = "https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/og-merchandise";
const PLAN_UPSTREAM = "https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/og-plan";
const SITE = "https://welileapp.com";

/** Only /s/<code> and /m/<code> are proxied — never any other app route. */
const SHARE_LINK_PATTERN = /^\/(s|m)\/([A-Za-z0-9_-]{4,64})\/?$/;

function textResponse(body, status, extra = {}) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=UTF-8", "Cache-Control": "no-store", ...extra },
  });
}

async function proxyUpstream(request, upstreamUrl, fallbackPath) {
  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": request.headers.get("User-Agent") || "Welile-Share-Proxy/1.0",
        Referer: request.headers.get("Referer") || "",
      },
      redirect: "manual",
    });
  } catch {
    // Upstream unavailable: controlled temporary error, never a supabase redirect.
    return textResponse("Share preview temporarily unavailable. Please try again.", 503, {
      "Retry-After": "30",
    });
  }

  // Upstream may 3xx humans onward. Pass it through, but only ever to our own
  // site — a supabase.co Location must never reach the browser.
  if (upstream.status >= 300 && upstream.status < 400) {
    const loc = upstream.headers.get("location") || "";
    const safe = loc.startsWith(SITE) || loc.startsWith("/") ? loc : `${SITE}${fallbackPath}`;
    return new Response(null, {
      status: 302,
      headers: { Location: safe, "Cache-Control": "no-store" },
    });
  }

  // Read the body and rebuild the response as real HTML under our domain.
  const html = await upstream.text();
  const headers = new Headers();
  headers.set("Content-Type", "text/html; charset=UTF-8");
  headers.set("Cache-Control", "public, max-age=60, s-maxage=300");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.delete("Content-Length");
  headers.delete("Content-Encoding");

  return new Response(request.method === "HEAD" ? null : html, {
    status: upstream.status,
    headers,
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const match = url.pathname.match(SHARE_LINK_PATTERN);

    if (!match) return textResponse("Short link not found", 404);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return textResponse("Method not allowed", 405, { Allow: "GET, HEAD" });
    }

    const kind = match[1];
    const shortCode = match[2];
    const src = url.searchParams.get("src");

    if (kind === "m") {
      const upstream = new URL(MERCH_UPSTREAM);
      upstream.searchParams.set("code", shortCode.toLowerCase());
      if (src) upstream.searchParams.set("src", src.slice(0, 50));
      return proxyUpstream(request, upstream.toString(), "/merchandise");
    }

    const upstream = new URL(`${PLAN_UPSTREAM}/${encodeURIComponent(shortCode)}`);
    if (src) upstream.searchParams.set("src", src.slice(0, 50));
    return proxyUpstream(request, upstream.toString(), "/funder-onboarding");
  },
};
