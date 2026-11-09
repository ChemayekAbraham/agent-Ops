// Runtime polyfill GATE for old mobile browsers (String.replaceAll, Array.at,
// Object.hasOwn, Promise.allSettled, …). Vite target es2015 down-levels syntax,
// not runtime methods. This import only registers the gate — the polyfill chunk
// is fetched + applied conditionally (awaited in loadApp, before any app code)
// ONLY when the device is actually missing a feature. Modern phones fetch nothing.
import { ensureRuntimePolyfills } from './lib/runtimePolyfills';
// Then: drops the stored session on a cold start when the user opted
// out of "remember this device", before Supabase/session-cache read any token.
import './lib/ephemeralGuard';
// Then: a hung auth token request can no longer hold the Supabase auth lock
// forever (which blocked both session restore and the Sign in button).
import './lib/authFetchTimeout';
// Clipboard writes fall back to execCommand when the async API is refused
// ("Write permission denied." on old Android WebViews) — doc 160.
import { installClipboardFallback } from './lib/clipboardFallback';
installClipboardFallback();
// Initialize login telemetry as early as possible so we capture the very first
// paint / bootstrap phases (before AuthProvider mounts).
import { loginTelemetry } from './lib/loginTelemetry';
loginTelemetry.init();
loginTelemetry.mark('app.boot');
// Initialize user behaviour telemetry (batched, auto-capture clicks/taps/sections)
import { userBehaviourTracker } from './lib/userBehaviourTracker';
userBehaviourTracker.init();
// Stamp the running revision (window.__WELILE_BUILD__, <html data-build>).
import { exposeBuildInfo } from './lib/buildInfo';
exposeBuildInfo();
import {
  BOOT_RECOVERY_KEY,
  bootRecoveryAllowed,
  isProductionStartupHost,
  isRecoverableBootFailure,
} from './lib/startupBoot';
import { createRoot } from 'react-dom/client';

const root = document.getElementById('root')!;
const host = window.location.hostname;
const isPreviewHost =
  host.includes('id-preview--') ||
  host.includes('preview--') ||
  host.endsWith('.lovableproject.com');

// Show branded loader immediately — inline SVG spinner, no network requests at all
root.innerHTML = `<div style="min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#f8fafc;gap:12px">
  <div style="display:flex;align-items:center;gap:6px">
    <span style="width:9px;height:9px;border-radius:50%;background:#7c3aed;animation:wd 1s ease-in-out infinite"></span>
    <span style="width:9px;height:9px;border-radius:50%;background:#7c3aed;animation:wd 1s ease-in-out .16s infinite"></span>
    <span style="width:9px;height:9px;border-radius:50%;background:#7c3aed;animation:wd 1s ease-in-out .32s infinite"></span>
  </div>
  <style>@keyframes wd{0%,80%,100%{transform:scale(.6);opacity:.45}40%{transform:scale(1);opacity:1}}@media(prefers-color-scheme:dark){div[style*=f8fafc]{background:#0f172a!important}}</style>
</div>`;

// Detect devices prone to backdrop-filter GPU corruption (horizontal tearing on
// blurred surfaces). Affects many mid/low-end Android phones (Tecno, Infinix,
// older Samsung Mali GPUs). Flag the document so CSS can swap blur → opaque.
try {
  const ua = navigator.userAgent || '';
  const isAndroid = /Android/i.test(ua);
  // Installed-to-home-screen iOS web app: flag the document so global CSS can
  // inset the app shell below the status bar / above the home indicator on
  // iOS versions that do not report display-mode reliably.
  const isIOS = /iPad|iPhone|iPod/i.test(ua) || (/Macintosh/i.test(ua) && (navigator as any).maxTouchPoints > 1);
  const isStandalone =
    (navigator as any).standalone === true ||
    window.matchMedia?.('(display-mode: standalone)').matches === true;
  if (isIOS && isStandalone) {
    document.documentElement.classList.add('ios-standalone');
  }
  const noBlurPref = localStorage.getItem('welile-no-blur');
  const userForced = noBlurPref === '1';
  // Explicit opt-out ('0') wins over every automatic heuristic below.
  const userOptedOut = noBlurPref === '0';
  if (userForced || (isAndroid && !userOptedOut)) {
    document.documentElement.classList.add('no-backdrop-blur');
    document.documentElement.classList.add('android-compositor-safe');
  }

  // Low-end / Android Go-class detection. Any of these signals => "lite-mode":
  // little RAM, few cores, explicit reduced-motion, or Data Saver. Lite-mode
  // shares the android-compositor-safe rules (no blur, no big shadows, static
  // motion) so entry-level devices (e.g. itel A08) render without GPU tearing.
  const deviceMemory = (navigator as any).deviceMemory;
  const cores = navigator.hardwareConcurrency;
  const conn = (navigator as any).connection;
  const prefersReducedMotion =
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  const saveData = conn?.saveData === true;
  const isLowEnd =
    (typeof deviceMemory === 'number' && deviceMemory <= 3) ||
    (typeof cores === 'number' && cores <= 4);
  if (!userOptedOut && (isLowEnd || prefersReducedMotion || saveData)) {
    document.documentElement.classList.add('lite-mode');
    // Lite devices also get the compositor-safe path even on non-Android.
    document.documentElement.classList.add('android-compositor-safe');
    document.documentElement.classList.add('no-backdrop-blur');
  }
} catch {}

// Unregister any service workers and clear leftover caches. The app no longer
// ships a service worker; this only cleans up workers from older installs so
// devices stop serving a stale shell. The Lovable proxy already serves HTML
// with no-cache, so the browser revalidates on every navigation.
//
// IMPORTANT: this runs ONCE per cleanup version, gated by a localStorage flag.
// Previously it deleted every Cache Storage entry on every launch, which forced
// slow cold re-fetches on low-end phones. Bump CACHE_CLEANUP_VERSION only when a
// new legacy artifact must be purged.
const CACHE_CLEANUP_VERSION = '2026-07-06';
const cleanupServiceWorkersAndCaches = () => {
  try {
    if (localStorage.getItem('welile-cache-cleanup') === CACHE_CLEANUP_VERSION) {
      return; // already cleaned for this version — skip the expensive work
    }
  } catch {}
  try {
    navigator.serviceWorker?.getRegistrations().then((regs) => {
      regs.forEach((r) => r.unregister());
    }).catch(() => {});
  } catch {}
  try {
    if ('caches' in window) {
      caches.keys().then((keys) =>
        Promise.all(keys.map((k) => caches.delete(k)))
      ).catch(() => {});
    }
  } catch {}
  try {
    localStorage.setItem('welile-cache-cleanup', CACHE_CLEANUP_VERSION);
  } catch {}
};

// Preview-only watchdog: if app mounts into an invisible/empty state, show recovery UI
const hasVisibleAppContent = () => {
  try {
    const elements = Array.from(root.querySelectorAll('*')) as HTMLElement[];
    return elements.some((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    });
  } catch {
    return false;
  }
};

const schedulePreviewBlankPageGuard = () => {
  if (!isPreviewHost) return;
  const check = () => {
    requestAnimationFrame(() => {
      if (!hasVisibleAppContent()) {
        console.error('[Main] Preview blank-page guard triggered');
        void import('./lib/startupCrashReporter')
          .then((m) => m?.reportStartupCrash?.({ reason: 'blank-page-guard' }))
          .catch(() => {});
        showErrorUI();
      }
    });
  };
  setTimeout(check, 7000);
  setTimeout(check, 14000);
};

// Mount the app.
const loadApp = async () => {
  cleanupServiceWorkersAndCaches();
  try {
    // Conditionally fetch + apply runtime polyfills BEFORE importing app code.
    // No-op (no network) on modern devices; fetches the polyfill chunk only when
    // a required method is missing, so app modules never touch an unpatched API.
    await ensureRuntimePolyfills();

    // Production only. Preview builds and the Lovable editor routinely take
    // longer than 30s to compile; a hard reject there is a false "Import timeout".
    const importTimeout = isProductionStartupHost(host)
      ? new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Import timeout')), 30000)
        )
      : null;
    const importApp = Promise.all([
      import('./critical.css'),
      import('./App.tsx'),
    ]);
    // Preload full CSS in background (non-blocking)
    import('./index.css');

    const raced = importTimeout ? Promise.race([importApp, importTimeout]) : importApp;
    const [, { default: App }] = (await raced) as [
      unknown,
      { default: () => JSX.Element },
    ];

    // Drop the cache-bust query before React reads the URL, so a recovery
    // reload doesn't leave `__wb` in the address bar or the first route.
    try {
      const clean = new URL(window.location.href);
      if (clean.searchParams.has('__wb')) {
        clean.searchParams.delete('__wb');
        window.history.replaceState(null, '', clean.pathname + clean.search + clean.hash);
      }
    } catch {}

    createRoot(root).render(<App />);

    // Signal the inline out-of-date-browser watchdog (index.html) that React
    // successfully mounted, so it never shows the banner on healthy sessions.
    try { (window as any).__WELILE_APP_READY__ = true; } catch {}

    // App booted successfully — the next real failure may recover again.
    try { sessionStorage.removeItem(BOOT_RECOVERY_KEY); } catch {}
    try { sessionStorage.removeItem('welile-startup-retry'); } catch {}

    // Drain any out-of-date-banner interactions the inline banner queued in
    // localStorage (it runs before this bundle and can't reach the backend).
    // Fire-and-forget so it never delays first paint.
    void import('./lib/compatTelemetry')
      .then(({ flushBannerChoices }) => flushBannerChoices())
      .catch(() => {});

    // Preload Dashboard chunk only when the user is actually heading there.
    try {
      const cached = localStorage.getItem('welile_session_cache');
      const path = window.location.pathname;
      const dashboardRoutes = ['/', '/dashboard'];
      if (cached && dashboardRoutes.includes(path)) {
        const preload = () => {
          import('./lib/lazyWithRetry')
            .then(({ queuedImport }) => queuedImport(() => import('./pages/Dashboard')))
            .catch(() => {});
        };
        if ('requestIdleCallback' in window) {
          (window as any).requestIdleCallback(preload, { timeout: 3000 });
        } else {
          setTimeout(preload, 1500);
        }
      }
    } catch {}
    schedulePreviewBlankPageGuard();
  } catch (err) {
    console.error('[Main] App load failed:', err);
    // A rotated App-*.js (post-deploy) or WebKit's "Importing a module script
    // failed" in an installed PWA is fixed by one cache-busting reload.
    // Reloading on a timer while the download is still in flight was aborting
    // that download and turning a slow start into this error.
    if (await recoverBootFailureOnce(err)) return;
    void import('./lib/startupCrashReporter')
      .then((m) => m?.reportStartupCrash?.({ reason: 'app-load-failed', error: err }))
      .catch(() => {});
    showErrorUI();
  }
};

/**
 * One reload per minute. Clears a controlling service worker and Cache
 * Storage first — iOS standalone PWAs keep serving the previous index.html
 * (and its dead hashed App chunk) until both are gone. Returns true when a
 * navigation has been started; the caller must not also paint the error UI.
 */
async function recoverBootFailureOnce(err: unknown): Promise<boolean> {
  if (import.meta.env.DEV) return false;
  if (!isRecoverableBootFailure(err)) return false;
  try {
    const last = Number(sessionStorage.getItem(BOOT_RECOVERY_KEY) || 0);
    if (!bootRecoveryAllowed(last, Date.now())) return false;
    sessionStorage.setItem(BOOT_RECOVERY_KEY, String(Date.now()));
  } catch {
    return false;
  }
  // A hung getRegistrations() must not sit on the error screen forever.
  await Promise.race([
    (async () => {
      try {
        const regs = (await navigator.serviceWorker?.getRegistrations()) ?? [];
        await Promise.all(regs.map((r) => r.unregister()));
      } catch { /* still reload */ }
      try {
        if ('caches' in window) {
          const keys = await caches.keys();
          await Promise.all(keys.map((k) => caches.delete(k)));
        }
      } catch { /* still reload */ }
    })(),
    new Promise<void>((resolve) => setTimeout(resolve, 2000)),
  ]);
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('__wb', String(Date.now()));
    window.location.replace(url.toString());
    return true;
  } catch {
    return false;
  }
}

function showErrorUI() {
  root.textContent = '';
  const container = document.createElement('div');
  container.style.cssText =
    'min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#f8fafc;gap:16px;padding:24px;text-align:center';

  const logo = document.createElement('img');
  logo.src = '/welile-logo.png';
  logo.alt = 'Welile';
  logo.width = 48;
  logo.height = 48;
  logo.style.borderRadius = '12px';

  const heading = document.createElement('h2');
  heading.textContent = 'Something went wrong';
  heading.style.cssText = 'font-size:18px;font-weight:600;color:#1f2937;margin:0';

  const msg = document.createElement('p');
  msg.textContent = 'We could not load the app. Tap below to reload.';
  msg.style.cssText = 'font-size:14px;color:#6b7280;margin:0;max-width:280px';

  const btn = document.createElement('button');
  btn.textContent = 'Reload App';
  btn.onclick = () => window.location.reload();
  btn.style.cssText =
    'padding:12px 24px;background:#7c3aed;color:white;border:none;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;min-height:44px';

  container.append(logo, heading, msg, btn);
  root.appendChild(container);
}

loadApp();

// Install centralized client-side error reporting (window.onerror +
// unhandledrejection). Lazy-loaded to avoid pulling supabase into the
// critical startup path.
import('./lib/errorReporting')
  .then((m) => m.installGlobalErrorReporting())
  .catch(() => {});

// Slow-start hint. Fires only while the branded spinner is still up. It does
// NOT reload and it does NOT write public_error_logs: an automatic reload at
// 10s was aborting the App chunk download (3s, then 6s, 12s, 24s) and the
// in-flight import then died as `Import timeout` / `Failed to fetch`. A real
// load failure is reported from loadApp's catch, on the public hosts only.
// Preview and local dev stay on the spinner — those hosts were ~95% of
// startup-timeout-slow and are not production failures.
setTimeout(() => {
  if (import.meta.env.DEV) return;
  if (!isProductionStartupHost(host)) return;

  const appReady = (() => {
    try { return (window as any).__WELILE_APP_READY__ === true; } catch { return false; }
  })();
  if (appReady || !root.innerHTML.includes('animation:')) return;

  const online = (() => {
    try { return navigator.onLine !== false; } catch { return true; }
  })();

  const hint = document.createElement('div');
  hint.style.cssText =
    'display:flex;flex-direction:column;align-items:center;gap:8px;max-width:300px;text-align:center;margin-top:8px';

  const title = document.createElement('p');
  title.textContent = online ? 'This is taking longer than usual' : 'You appear to be offline';
  title.style.cssText = 'font:600 15px/1.4 system-ui,-apple-system,sans-serif;color:#1f2937;margin:0';

  const msg = document.createElement('p');
  msg.textContent = online
    ? 'Your connection may be slow. You can keep waiting, or tap below to try again.'
    : 'Please check your internet connection, then try again.';
  msg.style.cssText = 'font:14px/1.5 system-ui,-apple-system,sans-serif;color:#6b7280;margin:0';

  const retryBtn = document.createElement('button');
  retryBtn.textContent = 'Tap to Retry';
  retryBtn.onclick = () => window.location.reload();
  retryBtn.style.cssText =
    'padding:12px 24px;background:#7c3aed;color:white;border:none;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;min-height:44px;margin-top:4px';

  hint.append(title, msg, retryBtn);
  root.firstElementChild?.appendChild(hint);

  // Production only (the host check above). Preview was ~95% of these rows.
  // This does not reload — the in-flight import is left alone, and a real
  // load failure is reported separately as app-load-failed.
  void import('./lib/startupCrashReporter')
    .then((m) => m?.reportStartupCrash?.({ reason: online ? 'startup-timeout-slow' : 'startup-timeout-offline' }))
    .catch(() => {});
}, 10000);

// Only a failed CSS preload is safe to swallow: the JS chunk itself still
// loads. Swallowing a failed JS import makes Vite resolve the import with
// `undefined`, so `import(...).then(m => m.X)` threw "Cannot read properties of
// undefined (reading 'X')" and lazyWithRetry never saw the real stale-chunk
// error (doc 159). Let those reject so the retry/reload path handles them.
addEventListener('vite:preloadError', (e) => {
  const msg = String((e as any).payload?.message ?? '');
  if (msg.includes('Unable to preload CSS')) e.preventDefault();
});
addEventListener('unhandledrejection', (e) => {
  const r = String((e as any).reason ?? '').toLowerCase();
  if (
    r.includes('dynamically imported') ||
    r.includes('failed to fetch') ||
    r.includes('loading chunk') ||
    r.includes('import timeout') ||
    r.includes('module script failed')
  ) {
    e.preventDefault();
  }
});
