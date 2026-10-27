import { describe, expect, it } from 'vitest';
import { manualChunkForModule } from './bootChunks';

const nm = (pkgPath: string) => `/app/node_modules/${pkgPath}`;

describe('manualChunkForModule', () => {
  it('keeps the shell link packages out of the catch-all', () => {
    const isolated = [
      'tslib/tslib.es6.js',
      'iceberg-js/dist/index.mjs',
      'aria-hidden/dist/es2019/index.js',
      'react-remove-scroll/dist/es2019/index.js',
      'use-sync-external-store/shim.js',
      'sonner/dist/index.mjs',
      'clsx/dist/clsx.mjs',
      'next-themes/dist/index.mjs',
      'react-helmet-async/lib/index.js',
      'invariant/browser.js',
      'js-tokens/index.js',
      '@floating-ui/dom/dist/floating-ui.dom.mjs',
      '@floating-ui/utils/dist/floating-ui.utils.mjs',
    ];
    for (const path of isolated) {
      const chunk = manualChunkForModule(nm(path));
      expect(chunk, path).toBeTruthy();
      expect(chunk, path).not.toBe('vendor-common');
    }
  });

  it('leaves date-fns and the rest of the tree in the catch-all', () => {
    expect(manualChunkForModule(nm('date-fns/format.js'))).toBe('vendor-common');
    expect(manualChunkForModule(nm('zod/index.js'))).toBe('vendor-common');
    expect(manualChunkForModule(nm('cmdk/dist/index.mjs'))).toBe('vendor-common');
  });

  it('keeps the existing grouped chunks', () => {
    expect(manualChunkForModule(nm('@supabase/supabase-js/dist/index.mjs'))).toBe('vendor-supabase');
    expect(manualChunkForModule(nm('@radix-ui/react-tooltip/dist/index.mjs'))).toBe('vendor-radix');
    expect(manualChunkForModule(nm('react-dom/client.js'))).toBe('vendor-react');
    expect(manualChunkForModule(nm('lucide-react/dist/esm/icons/x.js'))).toBe('vendor-lucide-react');
    expect(manualChunkForModule(nm('@tanstack/react-query/build/modern/index.js'))).toBe('vendor-tanstack');
  });

  it('does not chunk application source', () => {
    expect(manualChunkForModule('/app/src/App.tsx')).toBeUndefined();
    expect(manualChunkForModule('/app/node_modules/vite/preload-helper.js')).toBe('vite-runtime');
    expect(manualChunkForModule('/app/node_modules/vite/dist/node/index.js')).toBe('vendor-common');
  });
});
