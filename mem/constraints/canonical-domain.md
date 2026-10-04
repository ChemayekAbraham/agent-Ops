---
name: Canonical domain is welileapp.com
description: welileapp.com is the single canonical public domain; welile.tech and welilereceipts.com are legacy and must never appear in shipping code
type: constraint
---
The one canonical public origin is `https://welileapp.com`.

- Never hardcode an origin in components/functions — always use `getPublicOrigin()` (`src/lib/getPublicOrigin.ts`) on the client, or the canonical constant on the server.
- Legacy hostnames forbidden in shipping code (enforced by `scripts/guard-legacy-domain.mjs`): `welilereceipts.com`, `welilereciept.com`, `welilereceipts-com.lovable.app`, `welile.tech`.
- `welile.tech` is FULLY RETIRED (2026-08-10): purged from all code, the push legacy-host list, and the 301 sitemap. It survives only as a blocklist entry in `scripts/site-domains.mjs` and must never be index 0 of `LEGACY_DOMAINS` (index 0 becomes `LEGACY_ORIGIN`, the base of the emitted 301 sitemap).
- Overridable per deployment via `VITE_CANONICAL_ORIGIN` / `SITE_CANONICAL_DOMAIN`.

**Why:** shared links, SEO canonicals, sitemaps and email/SMS links must all resolve on the live domain.
