# Merchandise share preview: crawler-intercepting OG route

## What already exists
`supabase/functions/og-merchandise/index.ts` already does the core job:
- Looks up the item in `merchandise_catalog` by `?id=<uuid>` (or a trailing UUID path segment).
- Fetches `image_urls[0]` / `image_url`, streams the real photo from the private bucket via `?img=1` (1200x630 cover crop, brand logo as last resort).
- Emits full Open Graph / Twitter tags, logs the open into `merchandise_share_opens` (bot vs human), then redirects to `/merchandise?item=<id>`.
- Share links are built in `src/pages/MerchandiseStore.tsx` (line 140).

So this is not a green-field build. Two real gaps remain, and the plan fixes those.

## Gap 1 — the shared URL exposes the backend host
Shared links read `https://<project>.supabase.co/functions/v1/og-merchandise?id=...`, which looks untrustworthy in WhatsApp and is what the user complained about.

Fix: serve the preview from the brand domain by making the store share a
`https://welileapp.com/m/<id>` style link and having that path reach the function.
Because this app is a static SPA, the brand path cannot proxy server-side, so the
plan is: keep the function as the crawler target but reachable at a clean,
brand-looking function URL, and put the readable item slug in the path
(`/functions/v1/og-merchandise/jumper-white-<id>`) so the visible link text reads
as a product, not a query string. If the user wants a true `welileapp.com/...`
preview URL, that needs a domain-level route and I will flag it as the one item
this stack cannot do alone.

## Gap 2 — verification that a crawler actually gets the photo
Add a check step, not more guessing:
- Request the function with a WhatsApp user-agent and confirm the returned
  `og:image` URL responds with `content-type: image/*` and non-trivial bytes.
- Request `?img=1` directly for a known item and confirm the same.
- Report the actual observed values back rather than assuming success.

## Behaviour changes to make
1. Split responses by user-agent: crawlers get the meta-only HTML (no redirect
   script, so no chance of a crawler following through); humans get an immediate
   302 to `/merchandise?item=<id>`. This makes the "intercept crawlers, redirect
   humans" contract explicit instead of relying on a JS redirect.
2. Accept a slugged path form `.../og-merchandise/<slug>-<uuid>` so shared links
   are human-readable; keep `?id=` working for existing links.
3. Keep analytics: still record one `merchandise_share_opens` row per open with
   `is_bot` set from the same detection used for the response split.
4. Update `MerchandiseStore.tsx` to build the slugged URL and bump the preview
   version parameter so WhatsApp re-scrapes instead of serving its cached card.

## Technical notes
- Files touched: `supabase/functions/og-merchandise/index.ts`,
  `src/pages/MerchandiseStore.tsx`.
- No database migration; `merchandise_catalog` and `merchandise_share_opens`
  already have every field needed.
- Image streaming keeps using the service role key against the private bucket —
  unchanged, since that path already works.
- WhatsApp caches previews per URL, so previously shared links keep their old
  card; only newly shared links show the change.
