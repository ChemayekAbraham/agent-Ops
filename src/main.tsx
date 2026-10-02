// Runtime polyfill GATE for old mobile browsers (String.replaceAll, Array.at,
// Object.hasOwn, Promise.allSettled, …). Vite target es2015 down-levels syntax,
// not runtime methods. This import only registers the gate — the polyfill chunk
// is fetched + applied conditionally (awaited in loadApp, before any app code)
// ONLY when the device is actually missing a feature. Modern phones fetch nothing.
import { ensureRuntimePolyfills } from './lib/runtimePolyfills';
// Then: drops the stored session on a cold start when the user opted
// out of "remember this device", before Supabase/session-cache read any token.
import './lib/ephemeralGuard';
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

    const importTimeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Import timeout')), 30000)
    );
    const importApp = Promise.all([
      import('./critical.css'),
      import('./App.tsx'),
    ]);
    // Preload full CSS in background (non-blocking)
    import('./index.css');

    const [, { default: App }] = (await Promise.race([importApp, importTimeout])) as [
      unknown,
      { default: () => JSX.Element },
    ];

    createRoot(root).render(<App />);

    // Signal the inline out-of-date-browser watchdog (index.html) that React
    // successfully mounted, so it never shows the banner on healthy sessions.
    try { (window as any).__WELILE_APP_READY__ = true; } catch {}

    // App booted successfully — clear the exponential-backoff retry counter so
    // the next cold start begins from a clean slate.
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
    void import('./lib/startupCrashReporter')
      .then((m) => m?.reportStartupCrash?.({ reason: 'app-load-failed', error: err }))
      .catch(() => {});
    showErrorUI();
  }
};

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

// Blank-screen watchdog: if the app still hasn't mounted after 10s, the branded
// spinner is likely stuck behind a slow/offline connection or a stalled bundle
// fetch. Instead of a lone "retry" button, show a clear
// "offline / connection too slow" hint with a retry option so the user isn't
// left staring at an endless spinner. Only fires while the spinner is still up
// (the `animation:` marker in the initial loader HTML) and the app is not ready.
setTimeout(() => {
  const appReady = (() => {
    try { return (window as any).__WELILE_APP_READY__ === true; } catch { return false; }
  })();
  if (appReady || !root.innerHTML.includes('animation:')) return;

  const online = (() => {
    try { return navigator.onLine !== false; } catch { return true; }
  })();

  // Exponential backoff across reloads. Each timed-out start bumps the attempt
  // counter (persisted for the tab via sessionStorage); the auto-retry delay
  // grows 3s → 6s → 12s → 24s (capped), so a flaky/slow network gets
  // progressively more breathing room instead of hammering reloads. The counter
  // resets to 0 once the app boots successfully (see loadApp).
  const BASE_DELAY_MS = 3000;
  const MAX_DELAY_MS = 24000;
  const MAX_AUTO_RETRIES = 4;
  let attempt = 0;
  try { attempt = parseInt(sessionStorage.getItem('welile-startup-retry') || '0', 10) || 0; } catch {}
  const backoffMs = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
  const canAutoRetry = online && attempt < MAX_AUTO_RETRIES;

  const hint = document.createElement('div');
  hint.style.cssText =
    'display:flex;flex-direction:column;align-items:center;gap:8px;max-width:300px;text-align:center;margin-top:8px';

  const title = document.createElement('p');
  title.textContent = online ? 'This is taking longer than usual' : 'You appear to be offline';
  title.style.cssText = 'font:600 15px/1.4 system-ui,-apple-system,sans-serif;color:#1f2937;margin:0';

  const msg = document.createElement('p');
  msg.textContent = online
    ? 'Your connection may be slow. Check your network and try again.'
    : 'Please check your internet connection, then try again.';
  msg.style.cssText = 'font:14px/1.5 system-ui,-apple-system,sans-serif;color:#6b7280;margin:0';

  const doRetry = () => {
    try { sessionStorage.setItem('welile-startup-retry', String(attempt + 1)); } catch {}
    window.location.reload();
  };

  const retryBtn = document.createElement('button');
  retryBtn.onclick = doRetry;
  retryBtn.style.cssText =
    'padding:12px 24px;background:#7c3aed;color:white;border:none;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;min-height:44px;margin-top:4px';

  hint.append(title, msg, retryBtn);
  root.firstElementChild?.appendChild(hint);

  // Auto-retry with exponential backoff (online only). Show a live countdown on
  // the button; the user can still tap to retry immediately at any point.
  if (canAutoRetry) {
    let remaining = Math.round(backoffMs / 1000);
    const label = () => {
      retryBtn.textContent = remaining > 0 ? `Retrying in ${remaining}s — Tap to retry now` : 'Retrying…';
    };
    label();
    const ticker = window.setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        window.clearInterval(ticker);
        doRetry();
      } else {
        label();
      }
    }, 1000);
    // Tapping retry should cancel the pending auto-retry to avoid a double reload.
    retryBtn.addEventListener('click', () => window.clearInterval(ticker));
  } else {
    retryBtn.textContent = 'Tap to Retry';
  }

  // Log the timeout so recurring slow-start issues are diagnosable.
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
