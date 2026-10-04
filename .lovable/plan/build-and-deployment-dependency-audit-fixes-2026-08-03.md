# Build and deployment dependency audit fixes

## Confirmed findings

1. **Generated MCP function contains invalid deploy-time imports.** The generated `supabase/functions/mcp/index.ts` contains `npm:@/lib/customerWalletHistory`, which is a Vite path alias incorrectly emitted as an npm package. The edge runtime cannot resolve that specifier, making MCP function code generation/deployment a credible source of `SUPABASE_CODEGEN_ERROR` even though the frontend bundle succeeds.
2. **Authenticated MCP tools use Node-only environment access in the edge runtime.** `src/lib/mcp/tools/get-my-profile.ts`, `get-my-wallet.ts`, `list-my-transactions.ts`, and `src/lib/mcp/statement.ts` read `process.env.SUPABASE_*`. They should use one lazy Deno/Node-compatible runtime environment factory and support the managed publishable-key dictionary/fallbacks.
3. **The MCP SDK is old and generates duplicated client/env code.** `@lovable.dev/mcp-js` is pinned by the lockfile at the declared `^0.20.0` range, while the current authoring path expects a newer compatible SDK. The MCP package should be upgraded deliberately and the lockfile regenerated together.
4. **Function dependencies are exposed to remote-import drift.** 235 edge-function imports use `esm.sh`; 160 float on `@supabase/supabase-js@2`. This does not break the frontend Vite build, but it can break backend function deployment/code generation independently. The immediate MCP fix will use generated `npm:` imports; converting all 200+ unrelated functions is outside this repair scope.
5. **Runtime configuration is not validated centrally.** Required function configuration such as `USSD_CALLBACK_SECRET` is referenced but absent from the configured secret-name inventory. Several other absent names are optional or have fallbacks, so they must not all be treated as blockers.
6. **Dependency installation is currently healthy.** `npm ls --all` reports no invalid, missing, or peer-dependency problems; lockfile v3 matches the package dependency inventory. The frontend client receives its required public `VITE_SUPABASE_*` values, so those are not the current failure.
7. **Heap and artifact limits are already guarded.** The build wrapper requests 4096 MB and clamps to 75% of detected container memory; the final artifact verifier checks `dist/index.html`, file/byte limits, house shells, and both sitemaps. These should be preserved.

## Implementation

### 1. Make the authenticated MCP entry deploy-safe
- Add `src/lib/mcp/supabase.ts` as the single import-safe client factory with lazy `Deno.env` / `process.env` resolution, publishable-key dictionary support, and bearer-token forwarding.
- Add an MCP-local wallet-history filtering module or move the shared pure filters under `src/lib/mcp/` so the MCP bundle never crosses through the `@/` Vite alias.
- Update the four authenticated MCP tools and `statement.ts` to use these local helpers; remove duplicated `createClient(process.env...)` implementations.
- Keep all environment reads inside callable functions, not module initialization.

### 2. Upgrade and regenerate MCP output
- Upgrade `@lovable.dev/mcp-js` to the current compatible release and regenerate `package-lock.json`.
- Regenerate both `mcp` and `mcp-public` edge-function bundles through the existing Vite plugin.
- Extract the MCP manifest and verify generated output has no `npm:@/`, unresolved Vite aliases, or Node-only `process.env` dependency.

### 3. Add focused preflight checks
- Add a deploy-import guard that scans generated MCP output for unresolved aliases and unsupported specifiers, with a precise failure message.
- Add a runtime-environment inventory check that distinguishes platform-provided variables, configured secrets, optional variables, and required user-managed secrets.
- Wire only deterministic checks into `scripts/run-guards.mjs`; do not make network availability, optional notification integrations, schema fingerprint drift, sitemap house fetching, or prerender fetching block the frontend build.

### 4. Resolve the one confirmed required configuration gap
- Add `USSD_CALLBACK_SECRET` through secure secret management because the callback rejects every request when it is absent.
- Do not create placeholders for optional variables or third-party credentials.

### 5. Validate the complete publish path
- Run dependency installation validation, typecheck, all guards, and the production build.
- Verify `dist/index.html`, assets, both sitemaps, file count, byte size, and house-shell count.
- Extract the MCP manifest, deploy/test `mcp` and `mcp-public`, and confirm the generated functions load without module-resolution errors.
- Run Publish, then compare the non-fallback `/_deploy/artifact-hash.txt` with the local artifact hash to prove the hosting layer serves this exact build rather than an older SPA fallback.

## Files expected to change

- `package.json`, `package-lock.json`
- `src/lib/mcp/supabase.ts`
- MCP-local wallet filter helper under `src/lib/mcp/`
- `src/lib/mcp/tools/get-my-profile.ts`
- `src/lib/mcp/tools/get-my-wallet.ts`
- `src/lib/mcp/tools/list-my-transactions.ts`
- `src/lib/mcp/statement.ts`
- generated `supabase/functions/mcp/index.ts` and, if regenerated by the plugin, `supabase/functions/mcp-public/index.ts`
- one focused guard under `scripts/`, plus `scripts/run-guards.mjs`
