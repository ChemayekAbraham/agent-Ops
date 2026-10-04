# Short branded link for merchandise shares (keeping the WhatsApp image preview)

## Short answer

A URL rewrite/proxy on the frontend host would work in principle — but this app's host cannot do it. Lovable hosting for this project serves a static SPA with a single rule in `public/_redirects` (`/* /index.html 200`). That is an SPA fallback, not a reverse proxy: it can only serve local files, it cannot fetch and re-emit the response from the `og-merchandise` function. And the tags must exist in the HTML the crawler receives — WhatsApp does not run JavaScript, so a client-side rewrite or React-side meta injection cannot produce the preview.

So the link stays long unless the request is answered by something that can proxy. The realistic way to get both a short branded URL and the image preview is to put one small proxy in front of a Welile host.

## Recommended shape

Keep `og-merchandise` as it is (it already streams the item image and clamps the OG tags). Add a thin proxy that fetches it and returns the bytes unchanged under a Welile URL:

```text
WhatsApp  ->  https://s.welileapp.com/m/jw27      (short, branded)
                     |  Cloudflare Worker (proxy, no redirect)
                     v
              og-merchandise?code=jw27            (OG tags + image)
```

Why a subdomain such as `s.welileapp.com` (or `l.welileapp.com`): `welileapp.com` itself resolves to Lovable hosting, so `welileapp.com/m/*` cannot be intercepted without moving the apex DNS behind Cloudflare. A dedicated share host is a one-time DNS record and touches nothing about the live app. The apex path is possible too, but it means proxying the whole site through Cloudflare — bigger change, more risk.

Crucially the Worker must **proxy** (return the upstream body), not `301` — a redirect makes WhatsApp display the final Supabase URL again, which is exactly the current symptom.

## Work involved

1. **Short codes.** A `merchandise_share_codes` table (short code, merchandise id, sharing agent, created_at) plus generation on share, so the URL carries `jw27` rather than a UUID. Share analytics keep recording against the code.
2. **`og-merchandise` accepts a code.** Add code lookup alongside the existing id/slug paths; existing links keep working.
3. **Cloudflare Worker.** ~20 lines: map `/m/:code` to the function URL, forward the response with its `content-type` and OG HTML intact, set a cache header. Deployed outside this repo (dashboard or wrangler), plus one CNAME for the share host.
4. **Share UI.** The merchandise share button copies `https://s.welileapp.com/m/<code>`.

## What you get / trade-offs

- WhatsApp shows `s.welileapp.com` as the source line and the item photo as the preview.
- No Supabase string anywhere in the shared text.
- The Worker is infrastructure outside Lovable — I can write it and the DNS/deploy steps, but the record must be added and the Worker published on your Cloudflare account. Until then links keep working in their current long form.
- Previews already scraped by WhatsApp stay cached for a while; new links preview immediately.

## If you would rather not add a Worker

The only other way to shorten the visible domain is a third-party shortener that preserves upstream OG tags on a custom domain (e.g. Short.io with `s.welileapp.com`). Same DNS work, a subscription instead of a Worker, and the preview depends on that vendor honouring the target's tags.