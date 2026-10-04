import { useState, useEffect, useCallback } from 'react';
import { detectStandalone } from '@/lib/pwaStandalone';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

declare global {
  interface Window {
    __welileInstallPrompt?: BeforeInstallPromptEvent | null;
  }
}

/**
 * Source of truth for the captured install event is the window stash written by
 * the inline script in index.html — it runs before this bundle exists, so the
 * event can no longer be missed. This module keeps a mirror for convenience and
 * also listens itself as a secondary path (e.g. late-firing engines).
 */
export let globalDeferredPrompt: BeforeInstallPromptEvent | null =
  typeof window !== 'undefined' ? window.__welileInstallPrompt ?? null : null;

export function clearGlobalPrompt() {
  globalDeferredPrompt = null;
  if (typeof window !== 'undefined') window.__welileInstallPrompt = null;
  notifyListeners(false);
}
const listeners = new Set<(v: boolean) => void>();

function notifyListeners(hasPrompt: boolean) {
  listeners.forEach(fn => fn(hasPrompt));
}

function adoptWindowPrompt() {
  if (typeof window === 'undefined') return;
  if (window.__welileInstallPrompt && !globalDeferredPrompt) {
    globalDeferredPrompt = window.__welileInstallPrompt;
    notifyListeners(true);
  }
}

// Secondary capture path — the inline script in index.html is the primary one.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e: Event) => {
    console.log('[PWA] beforeinstallprompt captured');
    e.preventDefault();
    globalDeferredPrompt = e as BeforeInstallPromptEvent;
    window.__welileInstallPrompt = e as BeforeInstallPromptEvent;
    notifyListeners(true);
  });
  window.addEventListener('welile:installpromptready', adoptWindowPrompt);
  adoptWindowPrompt();
}

export function usePWAInstall() {
  const [hasPrompt, setHasPrompt] = useState(
    () => !!globalDeferredPrompt || (typeof window !== 'undefined' && !!window.__welileInstallPrompt),
  );
  const [isInstalled, setIsInstalled] = useState(() =>
    typeof window === 'undefined' ? false : detectStandalone(),
  );
  const [isIOS, setIsIOS] = useState(false);
  const [isAndroid, setIsAndroid] = useState(false);

  useEffect(() => {
    // Live installed/standalone detection on every mount, so a user who removed
    // the app is offered it again instead of being locked out by a stale flag.
    setIsInstalled(detectStandalone());

    // Detect iOS
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream;
    setIsIOS(ios);
    setIsAndroid(/Android/i.test(navigator.userAgent));

    // Subscribe to global prompt changes
    const onPromptChange = (v: boolean) => setHasPrompt(v);
    listeners.add(onPromptChange);

    // Sync if already captured (inline script or secondary listener)
    adoptWindowPrompt();
    if (globalDeferredPrompt || window.__welileInstallPrompt) setHasPrompt(true);

    const onInstalled = () => {
      console.log('[PWA] appinstalled fired');
      setIsInstalled(true);
      setHasPrompt(false);
      globalDeferredPrompt = null;
      window.__welileInstallPrompt = null;
    };
    window.addEventListener('appinstalled', onInstalled);

    return () => {
      listeners.delete(onPromptChange);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const promptInstall = useCallback(async (): Promise<boolean> => {
    const prompt = globalDeferredPrompt ?? window.__welileInstallPrompt ?? null;

    if (!prompt) {
      return false;
    }

    try {
      await prompt.prompt();
      const { outcome } = await prompt.userChoice;

      globalDeferredPrompt = null;
      window.__welileInstallPrompt = null;
      setHasPrompt(false);
      notifyListeners(false);

      if (outcome === 'accepted') {
        setIsInstalled(true);
        localStorage.setItem('welile_pwa_installed', 'true');
        return true;
      }

      return false;
    } catch {
      globalDeferredPrompt = null;
      window.__welileInstallPrompt = null;
      setHasPrompt(false);
      notifyListeners(false);
      return false;
    }
  }, []);

  return {
    hasPrompt,
    isInstalled,
    isIOS,
    isAndroid,
    promptInstall,
    /**
     * No native one-tap prompt available (Firefox, in-app browsers, some
     * WebViews) — the card must fall back to written instructions rather than
     * rendering a disabled button that looks broken.
     */
    canInstructInstead: !hasPrompt && !isIOS,
    canShow: !isInstalled,
  };
}

const INSTALL_PLATFORM_PREF_KEY = 'welile_install_platform_preference';

/**
 * Persist the platform a user manually chose in the install prompt so that
 * future prompts (especially when OS detection fails) show the right steps.
 */
export function getInstallPlatformPreference(): 'ios' | 'android' | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(INSTALL_PLATFORM_PREF_KEY);
    if (raw === 'ios' || raw === 'android') return raw;
    return null;
  } catch {
    return null;
  }
}

export function setInstallPlatformPreference(platform: 'ios' | 'android') {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(INSTALL_PLATFORM_PREF_KEY, platform);
  } catch {
    /* storage unavailable — prompt simply returns to picker next load */
  }
}

export function clearInstallPlatformPreference() {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(INSTALL_PLATFORM_PREF_KEY);
  } catch {
    /* storage unavailable */
  }
}
