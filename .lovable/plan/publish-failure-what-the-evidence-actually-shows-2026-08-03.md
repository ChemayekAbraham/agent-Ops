# Publish failure: what the evidence actually shows

## What I ran (read-only reproduction)

I reproduced the exact publish pipeline locally, twice, end to end:

- `prebuild` (sitemap generation) — passed, 1056 entries / 1000 houses
- 4 guard scripts (ledger writes, deposit purpose, legacy domain, canonical tags) — all passed
- `vite build` — succeeded, 6351 modules, ~1m10s
- `postbuild` (`prerender-houses.mjs`) — succeeded, 1000 listing shells rendered

Output footprint: **53 MB, 1888 files** — far below the publish limits (3 GiB / 50,000 files). Repo excluding `node_modules` and `dist`: 44 MB.

Security scan is also **not** the blocker right now: the current scan has zero critical findings (only `warn`-level items: `register_proxy_funder_spoof`, broad-read policies on house Q&A/reviews, role-gated landlord PIN exposure). The critical vendor-PIN block reported earlier today does not appear in the current results.

## Honest conclusion on root cause

**The build error is not reproducible in this environment, so I cannot yet name the root cause with confidence.** Anything beyond that would be a guess. The compile step is clean, deterministic and well under all output limits, which means the failure is specific to the publish builder environment, not a code defect visible locally.

The only warnings the build emits are benign and cannot fail a build:

- `Circular chunk: vendor-leaflet -> vendor-react-leaflet-core -> vendor-leaflet` (from the `manualChunks` splitter in `vite.config.ts`)
- five `Generated an empty chunk` notices (`vendor-cookie`, `vendor-set-cookie-parser`, `vendor-detect-node-es`, `vendor-micromark-util-encode`, `vendor-dom-helpers`)
- four "dynamically imported but also statically imported" notices (`oauthErrorLog.ts`, `oauthFunnel.ts`, `campaignAttribution.ts`, `rentAccessShareAudit.ts`)

## Candidate causes, ranked — each needs confirmation

1. **Memory ceiling in the publish container.** `scripts/run-with-heap.mjs` sizes the V8 heap as `min(8192 MB, 75% of detected container memory)`. This sandbox reports 128 GB, so it uses the full 8 GB and never nears a limit. A smaller publish builder gets a smaller heap and a much tighter margin; a kernel OOM kill surfaces exactly as an opaque "Publishing failed because of an error in your app" with no build error — which is what the screenshot shows.
2. **`postbuild` prerender.** `scripts/prerender-houses.mjs` fetches up to 5000 listings over the network and writes 1000 directories. It degrades gracefully on a failed fetch (warn + skip), but it runs a second Node process under the same heap wrapper right after the peak-memory Vite build.
3. **Toolchain availability.** `prebuild` runs `node --import tsx`, and `tsx` is a devDependency — fine if the publish builder installs dev dependencies, fatal at step one if it ever installs production-only.

## Next step I need from you

The screenshot truncates the message at "Publishing failed because of an error in your app. Tr…". Please open the publish dialog and paste the full error text (or the build log behind "Try to fix"). That message distinguishes candidate 1 from 2 and 3 immediately.

## Then, depending on the message

- If it is an OOM / signal kill: lower `BUILD_HEAP_MB`, reduce the number of vendor chunks in `manualChunks` (dozens of tiny chunks cost rollup bookkeeping memory), and move the prerender out of `postbuild` or cap it.
- If it fails in `prebuild`/`postbuild`: make those steps non-fatal (skip on missing env/network) so a metadata step can never fail a deploy.
- If it is something else entirely: fix what the log actually names — no speculative changes.

No files changed. Nothing published.