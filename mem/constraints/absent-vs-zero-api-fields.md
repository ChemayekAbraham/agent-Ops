---
name: Absent API field is never zero
description: GSC/analytics readers must keep missing API fields null and never alert off null; deprecated sitemap contents[].indexed is banned as a signal
type: constraint
---
Never coerce a missing external-API field into a real-looking measurement.

- FORBIDDEN: `Number(x ?? 0)` on any API response field.
- REQUIRED: `x == null ? null : Number(x)` — absent stays unknown.
- Alerts may only fire on values actually present in the response. A missing dependency raises "monitor degraded", never a site problem.
- Google `*_UNSPECIFIED` state strings (e.g. `ROBOTS_TXT_STATE_UNSPECIFIED`) mean "not measured" — normalise to null, never treat as blocked/error.
- `sitemaps.contents[].indexed` is DEPRECATED in Google's Search Console API and always returns 0. It is banned as an indexing signal. Real indexing proof = Search Analytics distinct pages (28d) + rotating URL Inspection sample (10/run).
- Every monitor run must persist a `data_quality` record of present vs absent expected fields so a future API deprecation surfaces as degraded-monitor, not fake site failures.

**Why:** the seo-index-monitor alarmed "1056 indexing errors" purely because a deprecated field was coerced to 0 (the 1056 was the submitted count). Google's raw `errors` was 0 the whole time.
