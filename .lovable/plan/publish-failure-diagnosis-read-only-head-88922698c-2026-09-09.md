# Publish failure diagnosis (read-only, HEAD `88922698c`)

No code was changed. Everything reproducible in this container is **green**, so the publish
failure is not a defect in the current source. Evidence below, then the single most likely cause.

## What I reproduced

| Check | Command | Result |
| --- | --- | --- |
| Frozen dependency install (bun) | `bun install --frozen-lockfile --dry-run` | OK, no lockfile drift (`zod@4.4.3`, `@prisma/client@7.4.2`, `@lovable.dev/mcp-js@0.26.1` all resolved) |
| Frozen dependency install (npm) | `npm ci --dry-run` | OK, `package-lock.json` satisfies `package.json` |
| Guards | `node scripts/run-guards.mjs` (inside build) | all 7 passed; `check-runtime-env` is warn-only, so missing publish env vars cannot block |
| Production build | `npm run build` | success, 7312 modules, `✓ built in 1m 43s` |
| Same build under bun (publish may drive scripts with bun) | `bun scripts/run-with-heap.mjs vite build` | success, `✓ built in 2m 13s` |
| TypeScript | `npx tsgo --noEmit` | clean |
| Upload artifact | `scripts/verify-dist.mjs` | `1019 files, 27.4 MiB, valid sitemaps` — far under its 45,000 file / 2.5 GiB limits |
| MCP publish surface | manifest extraction | regenerated cleanly, 5 tools; `supabase/functions/mcp/index.ts` + `mcp-public/index.ts` regenerate byte-identical (`git status` clean after build) |
| Linux case sensitivity | build ran on case-sensitive Linux FS | ruled out — a case-mismatched import would have failed here |
| HTML5 head validity | `index.html` | `<noscript>` in `<head>` contains only `<link>`; the GTM `<iframe>` `<noscript>` is in `<body>` — valid |

## Elimination

- **Clean-install / lockfile mismatch** — ruled out (both frozen installs pass).
- **Linux case-sensitive import** — ruled out (build is on Linux).
- **Frontend Vite error / TypeScript** — ruled out (build + typecheck clean).
- **Missing environment / secrets** — ruled out as a *build blocker*: `vite.config.ts` hardcodes fallbacks for `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_PROJECT_ID`, and the env guard only warns.
- **SQL migration execution** — not part of publish on this stack; backend/migrations apply at edit time, and no migration is pending in the tree.
- **Supabase edge-function bundling** — the only build-time function surface is the two auto-generated MCP bundles; both regenerate identically and parse. Not implicated, with one caveat below.
- **Stage 6 notification changes** — the notification work is VAPID Web Push in app code only; the last three commits touch three `.tsx` files, two sitemaps and generated types. Nothing there is publish-only, and all of it compiles.

## Most likely cause: build-container memory / time (OOM → SIGKILL)

This is the only hypothesis consistent with "builds locally, fails only on publish":

- Peak resident memory of the build process tree measured here: **~4.8 GB** (sampled; includes the running dev server, so the build alone is roughly 3.5–4.5 GB).
- `scripts/run-with-heap.mjs` requests a 4096 MB V8 heap and clamps it to `max(1536, 75% of detected container memory)`. On a 2 GB publish container that clamp lands at **1536 MB**, which this build cannot fit; on a 4 GB container the 4096 MB request exceeds what the cgroup allows once Rollup's native addon and workers are counted. Either way V8/Rollup grows past the cgroup limit and the kernel SIGKILLs it — surfacing exactly as "Publishing failed because of an error in your app" with no build error text.
- Scale that makes this fragile: **7312 modules, 978 emitted JS chunks**, `maxParallelFileOps: 2`, and a 1.23 MB `Dashboard` chunk. Wall time is 1m43s–2m13s on 16 vCPU; on a 1–2 vCPU publish runner the same build is several times longer and may also hit a build timeout.

Secondary (lower-likelihood) publish-only candidate: `vite.config.ts` runs `mcpPlugin()` twice, and each instance **writes** `supabase/functions/mcp*/index.ts` during `vite build`. If the publish container mounts the repo read-only, that write throws inside the plugin. I cannot test a read-only mount from here, so this stays unconfirmed.

## What I could not obtain

The publish container's own build log. Nothing in `/tmp/observability/build-errors.log` records the publish
attempt (the last entry is a clean local build), and no publish-side log is exposed to this environment.
Without it the OOM conclusion is inference from resource measurements, not a captured `SIGKILL` line.

## Proposed next step (no code changes yet — needs your go-ahead)

1. Re-publish once and capture the publish build log if the UI exposes any detail beyond the generic line.
2. If you want a fix attempt rather than more diagnosis, the lowest-risk change is memory-shaping only:
   set `BUILD_HEAP_MB` lower (e.g. 2048–3072) so V8 collects instead of growing into the cgroup ceiling,
   and reduce chunk count by grouping the per-package `vendor-*` chunks. Both are build-config only —
   no application, ledger, payroll or database behaviour is touched.
