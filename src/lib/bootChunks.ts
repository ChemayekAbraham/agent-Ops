/**
 * Rollup `manualChunks` for the Welile client.
 *
 * The shell (entry + the dynamic `App` import) only touches a small set of
 * packages, but a single `vendor-common` chunk used to hold every other
 * dependency too. `@supabase/*` imports `tslib`, and `@radix-ui/*` imports
 * `aria-hidden` / `react-remove-scroll` / `@floating-ui/*`. Once those lived
 * in `vendor-common`, loading the shell downloaded the whole chunk — 1.4 MB
 * raw / ~440 KB gzip on welileapp.com — before React could mount. That is
 * what the 10s spinner watchdog and the 30s `Import timeout` were waiting on.
 *
 * Packages below are split out so the catch-all stays off the boot path.
 * `date-fns` is intentionally left in the catch-all: one shared date-fns
 * chunk would pull every call site's functions into the shell. The shell
 * must not import it (see BudgetSubmissionGate).
 */

const REACT_PKGS = new Set([
  'react',
  'react-dom',
  'react-router',
  'react-router-dom',
  'scheduler',
]);

const HEAVY = new Set([
  'xlsx',
  'jspdf',
  'jspdf-autotable',
  'pptxgenjs',
  'html5-qrcode',
  'recharts',
  'html2canvas',
  'jszip',
  'framer-motion',
  'motion',
  'motion-dom',
  'lucide-react',
  'canvg',
  'africastalking-client',
  'react-markdown',
  'country-state-city',
  'qrcode',
]);

/**
 * Direct shell imports, plus the transitive deps of `@supabase/*` and
 * `@radix-ui/*` that are not themselves in those scopes. If any of these
 * fall through to `vendor-common`, the shell loads the catch-all again.
 */
const BOOT_ISOLATED = new Set([
  'tslib',
  'iceberg-js',
  'aria-hidden',
  'detect-node-es',
  'get-nonce',
  'react-remove-scroll',
  'react-remove-scroll-bar',
  'react-style-singleton',
  'use-callback-ref',
  'use-sidecar',
  'use-sync-external-store',
  'class-variance-authority',
  'clsx',
  'tailwind-merge',
  'next-themes',
  'react-helmet-async',
  'sonner',
  'invariant',
  'react-fast-compare',
  'shallowequal',
  'loose-envify',
  'js-tokens',
]);

function packageName(id: string): string {
  const parts = id.split('node_modules/').pop()!.split('/');
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

function isolatedChunk(pkg: string): string {
  return `vendor-${pkg.replace(/^@/, '').replace('/', '-')}`;
}

/** Chunk name for a module id, or undefined to leave it with its importer. */
export function manualChunkForModule(id: string): string | undefined {
  // Vite's lazy-load helper is needed by the app shell. Left alone, rollup
  // parked it inside the PDF chunk, so every app open downloaded the whole
  // PDF library.
  if (id.includes('vite/preload-helper') || id.includes('commonjsHelpers')) {
    return 'vite-runtime';
  }
  if (!id.includes('node_modules')) return undefined;

  const pkg = packageName(id);
  if (REACT_PKGS.has(pkg)) return 'vendor-react';
  if (pkg.startsWith('@radix-ui')) return 'vendor-radix';
  if (pkg.startsWith('@tiptap') || pkg.startsWith('prosemirror')) return 'vendor-tiptap';
  if (pkg.startsWith('@tanstack')) return 'vendor-tanstack';
  if (
    pkg === 'leaflet' ||
    pkg.startsWith('leaflet.') ||
    pkg === 'react-leaflet' ||
    pkg.startsWith('@react-leaflet')
  ) {
    return 'vendor-leaflet';
  }
  if (pkg.startsWith('@babel') || pkg.startsWith('@swc')) return 'vendor-babel';
  if (HEAVY.has(pkg)) return `vendor-${pkg}`;
  if (pkg.startsWith('@supabase')) return 'vendor-supabase';
  if (pkg.startsWith('@floating-ui/')) return isolatedChunk(pkg);
  if (BOOT_ISOLATED.has(pkg)) return isolatedChunk(pkg);
  return 'vendor-common';
}
