/**
 * Which revision of the app is running. Set at build time by vite.config.ts
 * (git commit + build timestamp) and served identically at /build-info.json, so
 * "is welileapp.com running the code we tested in the preview?" is answered by
 * comparing two identifiers instead of assuming.
 *
 * Inspect on any device: open the console and read `window.__WELILE_BUILD__`,
 * or `document.documentElement.dataset.build`, or fetch /build-info.json.
 * (/version.json is a different, pre-existing file: the cache / force-upgrade
 * gate. This plugin must never overwrite it.)
 */
export const BUILD_INFO = Object.freeze({
  commit: typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : 'unknown',
  /**
   * Hash of the source tree this bundle was built from. The hosted build
   * container has no .git, so `commit` can be "unknown" there — `source` is
   * identical for identical code and is the reliable preview-vs-production
   * comparison.
   */
  source: typeof __BUILD_SOURCE__ !== 'undefined' ? __BUILD_SOURCE__ : 'unknown',
  builtAt: typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : 'unknown',
  mode: import.meta.env.MODE,
});

export const BUILD_ID = `${BUILD_INFO.commit}/${BUILD_INFO.source}@${BUILD_INFO.builtAt}`;

export function exposeBuildInfo(): void {
  try {
    (window as unknown as { __WELILE_BUILD__?: typeof BUILD_INFO }).__WELILE_BUILD__ = BUILD_INFO;
    document.documentElement.dataset.build = BUILD_ID;
    console.info(`[welile] build ${BUILD_ID} (${BUILD_INFO.mode})`);
  } catch {
    // Diagnostics only — never affect boot.
  }
}
