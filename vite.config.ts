import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { mcpPlugin } from "@lovable.dev/mcp-js/stacks/supabase/vite";
import { execSync } from "child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";

// Which revision is this bundle? Exposed as window.__WELILE_BUILD__, the
// <html data-build> attribute and /build-info.json so the preview and
// welileapp.com can be compared directly instead of assumed to match.
function resolveBuildCommit(env: Record<string, string>): string {
  const fromEnv = env.VITE_BUILD_COMMIT || process.env.COMMIT_REF || process.env.GITHUB_SHA || process.env.VERCEL_GIT_COMMIT_SHA
    || process.env.LOVABLE_COMMIT_SHA || process.env.SOURCE_VERSION || process.env.CF_PAGES_COMMIT_SHA;
  if (fromEnv) return fromEnv.slice(0, 12);
  try {
    return execSync("git rev-parse --short=12 HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Fingerprint of the shipped source itself. The hosted build container has no
 * .git and no commit env var, so `commit` can read "unknown" there — but the
 * same source always hashes the same, in the preview and on welileapp.com. It
 * is what actually answers "is production running the code we tested?".
 */
function resolveSourceFingerprint(): string {
  const roots = ["src", "index.html", "vite.config.ts", "package.json"];
  // Paths are hashed relative to the project root and text files are read with
  // newlines normalised: the Windows checkout (CRLF, C:\...) and the hosted
  // Linux build (LF, /app/...) must hash identical source identically, or the
  // fingerprint cannot be compared across them at all.
  const TEXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".html", ".css", ".svg", ".md", ".txt"]);
  const root = path.resolve(__dirname);
  const hash = createHash("sha256");
  const walk = (p: string) => {
    const stat = statSync(p, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isDirectory()) {
      for (const entry of readdirSync(p).sort()) walk(path.join(p, entry));
      return;
    }
    hash.update(path.relative(root, p).replace(/\\/g, "/"));
    const bytes = readFileSync(p);
    hash.update(TEXT.has(path.extname(p).toLowerCase()) ? bytes.toString("utf8").replace(/\r\n/g, "\n") : bytes);
  };
  try {
    for (const r of roots) walk(path.resolve(root, r));
    return hash.digest("hex").slice(0, 16);
  } catch {
    return "unknown";
  }
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const buildInfo = {
    commit: resolveBuildCommit(env),
    source: resolveSourceFingerprint(),
    builtAt: new Date().toISOString(),
    mode,
  };
  const supabaseUrl = env.VITE_SUPABASE_URL || "https://wirntoujqoyjobfhyelc.supabase.co";
  const supabasePublishableKey = env.VITE_SUPABASE_PUBLISHABLE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8";
  const supabaseProjectId = env.VITE_SUPABASE_PROJECT_ID || "wirntoujqoyjobfhyelc";

  return {
    define: {
      __APP_VERSION__: JSON.stringify('2026-05-31-safari-recovery-steps'),
      __CACHE_VERSION__: JSON.stringify('2026-05-31-safari-recovery-steps'),
      __BUILD_COMMIT__: JSON.stringify(buildInfo.commit),
      __BUILD_SOURCE__: JSON.stringify(buildInfo.source),
      __BUILD_TIME__: JSON.stringify(buildInfo.builtAt),
      "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(supabaseUrl),
      "import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY": JSON.stringify(supabasePublishableKey),
      "import.meta.env.VITE_SUPABASE_PROJECT_ID": JSON.stringify(supabaseProjectId),
    },
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [
    react(),
    {
      name: "welile-build-info",
      configureServer(server) {
        // NOT /version.json — that path is the app's existing cache /
        // force-upgrade file ({version, min, force}) and must not be replaced.
        server.middlewares.use("/build-info.json", (_req, res) => {
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify(buildInfo));
        });
      },
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "build-info.json", source: JSON.stringify(buildInfo, null, 2) });
      },
    } satisfies Plugin,

    mode === "development" && componentTagger(),
    mcpPlugin(),
    mcpPlugin({ mcpEntry: "src/lib/mcp-public/index.ts", functionName: "mcp-public" }),
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime"],
  },
  build: {
    // The gzip-size report loads every emitted chunk back into memory and
    // compresses it after the render phase — that step alone was pushing the
    // build over the container's 3 GB heap cap (SIGABRT: ineffective
    // mark-compact). It is a cosmetic log line, so it is off.
    reportCompressedSize: false,
    rollupOptions: {
      // Cap peak memory during the render phase: instead of one enormous
      // entry chunk (8 MB+) that rollup must hold + minify in memory at once,
      // split every node_modules dependency into its own vendor chunk.
      maxParallelFileOps: 2,
      output: {
        // Split every node_modules dependency into its own vendor chunk so
        // rollup never has to hold one enormous chunk in memory during the
        // render/minify phase (that was OOM-killing the production build).
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          const parts = id.split('node_modules/').pop()!.split('/');
          const pkg = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
          // Keep the React runtime in a single chunk to avoid duplicate copies.
          if (['react', 'react-dom', 'react-router', 'react-router-dom', 'scheduler'].includes(pkg)) {
            return 'vendor-react';
          }
          // Group tightly-coupled families into ONE chunk each. Dozens of
          // tiny sibling chunks cost more in rollup bookkeeping, deployed
          // file count and HTTP requests than they save in memory.
          if (pkg.startsWith('@radix-ui')) return 'vendor-radix';
          if (pkg.startsWith('@tiptap') || pkg.startsWith('prosemirror')) return 'vendor-tiptap';
          if (pkg.startsWith('@tanstack')) return 'vendor-tanstack';
          if (pkg === 'leaflet' || pkg.startsWith('leaflet.') || pkg === 'react-leaflet') {
            return 'vendor-leaflet';
          }
          if (pkg.startsWith('@babel') || pkg.startsWith('@swc')) return 'vendor-babel';
          // Heavy, lazily-used libraries keep their own chunk so they never
          // load with the shell. Everything else collapses into one shared
          // vendor chunk: hundreds of tiny sibling chunks cost more in rollup
          // bookkeeping (and publish-container memory) than they save.
          const HEAVY = [
            'xlsx', 'jspdf', 'jspdf-autotable', 'pptxgenjs', 'html5-qrcode',
            'recharts', 'html2canvas', 'jszip', 'framer-motion', 'motion',
            'motion-dom', 'lucide-react', 'canvg', 'africastalking-client',
            'react-markdown', 'country-state-city', 'qrcode',
          ];
          if (HEAVY.includes(pkg)) return `vendor-${pkg}`;
          if (pkg.startsWith('@supabase')) return 'vendor-supabase';
          return 'vendor-common';

        },
      },
    },
    // es2015 (ES6) is the widest safe syntax floor: it runs on very old
    // Android System WebViews / stock browsers (Android 5+, Chrome 51+,
    // Samsung Internet 5+, Safari 10+) while modern phones execute it natively
    // with no meaningful cost. Combined with the feature-guarded runtime
    // polyfills in src/lib/runtimePolyfills.ts (which only patch MISSING
    // methods), a SINGLE bundle serves every supported browser — no separate
    // legacy build or differential serving needed.
    target: 'es2015',
    cssCodeSplit: true,
    chunkSizeWarningLimit: 1500,
    sourcemap: false,
    // Smaller chunks for slow 2G/3G networks
    assetsInlineLimit: 4096,
    // Use esbuild minifier — dramatically lower memory footprint than terser
    // (terser with passes:2 on 6000+ modules was OOM-killing the build).
    minify: 'esbuild',
  },
  esbuild: {
    drop: ['console', 'debugger'],
  },
  };
});
