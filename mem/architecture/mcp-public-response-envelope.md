---
name: mcp-public response envelope
description: Every mcp-public tool must return the shared publicToolResult envelope (schema 1.0) with fixed top-level JSON fields
type: feature
---
All tools in `src/lib/mcp-public/tools/` MUST return via `publicToolResult` from
`src/lib/mcp-public/response.ts` — never a hand-rolled `{ content: [...] }`.

Fixed top-level fields on success AND failure (schema_version "1.0"):
`schema_version, tool, ok, kind, summary, assumptions, estimates, data, disclaimers, next_steps, links, currency, error`.

- `kind`: info | estimate | listings | error
- `estimates`: `{ basis, confidence: indicative|illustrative|actual, currency: "UGX", ranges[] }` or null
- each range: `{ label, metric, unit (UGX|UGX_per_day|UGX_per_month|count), low, high, period, breakdown }` — `low`/`high` always both present (equal for a single figure); build with `pointRange` / `spanRange`
- `currency` is always `UGX`
- `error`: `{ code, message, retry_after_seconds, details }` — rate-limit rejections in `rateLimit.ts` use this too

Public docs page `/public-tools` (`src/pages/PublicToolsDocs.tsx`) documents this via
`RESPONSE_FIELDS` — keep it in sync when the envelope changes.
