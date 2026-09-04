#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "supabase/functions/mcp/index.ts",
  "supabase/functions/mcp-public/index.ts",
];
// A stub entry file is ~8 lines; the real inlined bundles are hundreds.
const MIN_BUNDLE_LINES = 50;
const violations = [];

for (const relative of files) {
  const source = readFileSync(path.join(root, relative), "utf8");
  if (/(["'])npm:@\//.test(source)) {
    violations.push(`${relative}: unresolved Vite alias was emitted as an npm package (npm:@/)`);
  }
  if (/from\s+["']@\//.test(source)) {
    violations.push(`${relative}: unresolved @/ source alias remains in generated edge code`);
  }
  // A local filesystem path can never resolve on Deno Deploy. The Vite plugin
  // emits one (a Windows `npm:C:\Users\...\src\lib\mcp\index.ts`, a `file://`
  // URL, or a POSIX `/home/...`) whenever it fails to inline the bundle, which
  // produces a file that imports nothing and serves nothing.
  if (/["'](?:npm:)?(?:[A-Za-z]:[\\/]|file:\/\/|\/(?:home|Users|root|mnt|tmp|var)\/)/.test(source)) {
    violations.push(
      `${relative}: a local filesystem path was emitted as an import specifier — the bundle was not inlined`,
    );
  }
  // The real bundles inline every tool. A handful of lines means the plugin
  // emitted only the Deno.serve entry, so no tool would be reachable.
  const lineCount = source.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  if (lineCount < MIN_BUNDLE_LINES) {
    violations.push(
      `${relative}: only ${lineCount} non-empty lines — expected an inlined bundle of at least ${MIN_BUNDLE_LINES}`,
    );
  }
}

if (violations.length) {
  console.error("[guard:mcp-deploy] BLOCKED: generated MCP edge code is not deploy-safe.");
  for (const violation of violations) console.error(`  - ${violation}`);
  console.error("Use relative imports inside src/lib/mcp, regenerate with Vite, then rerun this guard.");
  console.error("If the emitted file is a stub or points at a local path, the bundle was not inlined —");
  console.error("restore the committed bundle (git checkout -- <file>) rather than deploying it.");
  process.exit(1);
}

console.log(`[guard:mcp-deploy] ok: ${files.length} generated MCP functions have resolvable imports`);