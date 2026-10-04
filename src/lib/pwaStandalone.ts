// Robust "is this a standalone / installed PWA context?" detection.
// Consolidates the many platform-specific signals so the install gate
// dismisses reliably across iOS Safari, Android Chrome, desktop Chrome/Edge,
// and embedded webviews (TWA / Android app wrappers).

const PWA_INSTALLED_KEY = 'welile_pwa_installed';
const PWA_INSTALLED_AT_KEY = 'welile_pwa_installed_at';

/** True when running inside an iframe (e.g. Lovable preview). */
export function isInIframe(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

/** True for Lovable preview / local dev hosts where the gate must never block. */
export function isPreviewHost(): boolean {
  const h = window.location.hostname;
  return (
    h.includes('id-preview--') ||
    h.includes('preview--') ||
    h.includes('lovableproject.com') ||
    h === 'localhost' ||
    h === '127.0.0.1'
  );
}

/** iOS Safari standalone (legacy navigator.standalone). */
function isIOSStandalone(): boolean {
  return (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** Android/desktop Chrome, Edge, Samsung Internet — via display-mode media queries. */
function isDisplayModeStandalone(): boolean {
  if (typeof window.matchMedia !== 'function') return false;
  return [
    '(display-mode: standalone)',
    '(display-mode: fullscreen)',
    '(display-mode: minimal-ui)',
    '(display-mode: window-controls-overlay)',
  ].some((q) => {
    try {
      return window.matchMedia(q).matches;
    } catch {
      return false;
    }
  });
}

/** Trusted Web Activity / Android app webview: launched via android-app referrer. */
function isAndroidTWA(): boolean {
  return document.referrer.startsWith('android-app://');
}

/** PWA launch marker: start_url carries ?source=pwa so launches are self-identifying. */
function hasPWALaunchParam(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('source') === 'pwa' || params.get('mode') === 'standalone';
  } catch {
    return false;
  }
}

/** Sticky flag written once we've ever confirmed an install on this device. */
function hasStickyInstallFlag(): boolean {
  try {
    return localStorage.getItem(PWA_INSTALLED_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Master check: is the app currently running as an installed/standalone PWA?
 * Any one signal is sufficient — they cover different platforms and quirks.
 */
export function detectStandalone(): boolean {
  const standalone =
    isDisplayModeStandalone() ||
    isIOSStandalone() ||
    isAndroidTWA() ||
    hasPWALaunchParam() ||
    hasStickyInstallFlag();

  // Persist a positive real detection so future loads (even ones that briefly
  // report the wrong display-mode) stay unlocked.
  if (standalone && !hasStickyInstallFlag() && !hasPWALaunchParam()) {
    try {
      localStorage.setItem(PWA_INSTALLED_KEY, 'true');
      localStorage.setItem(PWA_INSTALLED_AT_KEY, Date.now().toString());
    } catch {
      /* ignore storage errors */
    }
  }

  return standalone;
}

/** Persist a manual/confirmed install so the gate stays dismissed. */
export function markInstalled(): void {
  try {
    localStorage.setItem(PWA_INSTALLED_KEY, 'true');
    localStorage.setItem(PWA_INSTALLED_AT_KEY, Date.now().toString());
  } catch {
    /* ignore storage errors */
  }
}
